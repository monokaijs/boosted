import { TaskMarkdown, toggleMarkdown, type SaveCheckbox } from "@/components/assistant-ui/task-markdown";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Download, FileText, LoaderCircle, Maximize, ZoomIn, ZoomOut } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

export type AttachmentFile = { blob: Blob; name?: string };
type AttachmentPreviewProps = {
  saveCheckbox?: SaveCheckbox;
  name: string;
  mimeType?: string | null;
  src?: string;
  sourceKey?: string;
  load?: () => Promise<AttachmentFile>;
  compact?: boolean;
  label?: ReactNode;
  className?: string;
};

function clampZoom(value: number) {
  return Math.min(5, Math.max(0.25, Math.round(value * 100) / 100));
}

function safeSource(src?: string) {
  return src && /^(?:https?:\/\/|blob:|data:)/i.test(src) ? src : undefined;
}

export function AttachmentPreview({ name, mimeType, src, sourceKey, load, compact, label, className, saveCheckbox }: AttachmentPreviewProps) {
  const [open, setOpen] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [file, setFile] = useState<AttachmentFile>();
  const [url, setUrl] = useState<string>();
  const [text, setText] = useState<string>();
  const [error, setError] = useState<string>();
  const [imageError, setImageError] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [loading, setLoading] = useState(false);
  const viewportRef = useRef<HTMLDivElement>(null);
  const loader = useRef(load);
  loader.current = load;
  const source = safeSource(src);
  const type = file?.blob.type || mimeType || "";
  const image = type.startsWith("image/") || (!type && /\.(?:png|jpe?g|webp|gif|svg|avif)$/i.test(name));
  const inlineImage = Boolean(mimeType?.startsWith("image/") || /\.(?:png|jpe?g|webp|gif|svg|avif)$/i.test(name));
  const shouldLoad = inlineImage || open;

  useEffect(() => {
    setFile(undefined);
    setUrl(undefined);
    setText(undefined);
    setError(undefined);
    setImageError(false);
    setLoading(shouldLoad);
    if (!shouldLoad) return;
    let active = true;
    let objectUrl: string | undefined;
    const getFile = loader.current ? loader.current() : source
      ? fetch(source).then(async (response) => {
        if (!response.ok) throw new Error("Unable to load attachment.");
        return { blob: await response.blob() };
      }) : Promise.reject(new Error("Attachment is unavailable."));
    void getFile.then(async (result) => {
      if (!active) return;
      objectUrl = URL.createObjectURL(result.blob);
      setFile(result);
      setUrl(objectUrl);
      const contentType = result.blob.type || mimeType || "";
      if ((/^(?:text\/|application\/(?:json|xml|javascript))/.test(contentType) || /\.(?:md|markdown)$/i.test(name)) && result.blob.size <= 1024 * 1024) {
        // Preserve a UTF-8 BOM as part of the backing source, including offsets.
        const value = /\.(?:md|markdown)$/i.test(name)
          ? new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(await result.blob.arrayBuffer())
          : await result.blob.text();
        if (active) setText(value);
      }
    }).catch((cause) => { if (active) setError(cause instanceof Error ? cause.message : "Unable to load attachment."); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [sourceKey, source, name, mimeType, shouldLoad]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!open || !image || !viewport) return;
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      setZoom((value) => clampZoom(value + (event.deltaY < 0 ? 0.1 : -0.1)));
    };
    viewport.addEventListener("wheel", onWheel, { passive: false });
    return () => viewport.removeEventListener("wheel", onWheel);
  }, [open, image]);

  const changeZoom = (value: number) => setZoom(clampZoom(value));
  const download = async () => {
    setDownloading(true);
    setError(undefined);
    try {
      const result = file ?? (loader.current ? await loader.current() : source ? await fetch(source).then(async (response) => {
        if (!response.ok) throw new Error("Unable to download attachment.");
        return { blob: await response.blob() };
      }) : undefined);
      if (!result) throw new Error("Attachment is unavailable.");
      const downloadUrl = URL.createObjectURL(result.blob);
      const link = document.createElement("a");
      link.href = downloadUrl;
      link.download = name;
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(downloadUrl), 1000);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Unable to download attachment."); }
    finally { setDownloading(false); }
  };

  return <>
    <button type="button" aria-label={`View ${name}`} title={name} onClick={() => { setZoom(1); setOpen(true); }} className={cn("inline-block max-w-full overflow-hidden rounded-lg border border-border bg-secondary text-left align-middle outline-none hover:border-primary/50 focus-visible:ring-2 focus-visible:ring-ring", className)}>
      {image && !imageError && (url || source) ? <img alt={name} src={url || source} onError={() => setImageError(true)} className={compact ? "h-16 w-20 object-cover" : "max-h-64 max-w-full object-contain"} />
        : <span className="flex max-w-64 items-center gap-2 px-3 py-2 text-xs">{image && !error && !imageError ? <LoaderCircle className="size-4 shrink-0 animate-spin" /> : <FileText className="size-4 shrink-0" />}<span className="truncate">{label ?? name}</span></span>}
    </button>
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="flex h-[min(85dvh,900px)] max-w-5xl flex-col gap-3 overflow-hidden p-4">
        <div className="min-w-0 pr-8"><DialogTitle className="truncate">{name}</DialogTitle><DialogDescription className="sr-only">Attachment preview and download</DialogDescription></div>
        <div className="flex flex-wrap items-center gap-2">
          {image && <>
            <Button variant="outline" size="icon-sm" aria-label="Zoom out" disabled={zoom <= 0.25} onClick={() => changeZoom(zoom - 0.25)}><ZoomOut /></Button>
            <output aria-label="Zoom level" className="w-12 text-center text-xs tabular-nums">{Math.round(zoom * 100)}%</output>
            <Button variant="outline" size="icon-sm" aria-label="Zoom in" disabled={zoom >= 5} onClick={() => changeZoom(zoom + 0.25)}><ZoomIn /></Button>
            <Button variant="outline" size="sm" onClick={() => setZoom(1)}><Maximize />Fit</Button>
          </>}
          <Button className="ml-auto" variant="outline" size="sm" disabled={downloading} onClick={() => void download()}>{downloading ? <LoaderCircle className="animate-spin" /> : <Download />}Download</Button>
        </div>
        {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
        <div ref={viewportRef} className="min-h-0 flex-1 overflow-auto rounded-lg border border-border bg-background/50">
          {image && (url || source) && !imageError ? <div className="grid min-h-full grid-cols-[minmax(0,1fr)] grid-rows-[minmax(0,1fr)] place-items-center" style={{ width: `${Math.max(1, zoom) * 100}%`, height: `${Math.max(1, zoom) * 100}%` }}><img alt={name} src={url || source} onError={() => setImageError(true)} className="block min-h-0 min-w-0 max-h-full max-w-full object-contain" style={{ width: `${Math.min(1, zoom) * 100}%`, height: `${Math.min(1, zoom) * 100}%` }} /></div>
            : imageError ? <p className="p-6 text-center text-sm text-muted-foreground">Image preview is unavailable. You can download the original file.</p>
            : loading ? <div role="status" className="grid h-full place-items-center text-sm text-muted-foreground">Loading preview…</div>
            : url && type.startsWith("audio/") ? <div className="grid h-full place-items-center p-4"><audio controls src={url} aria-label={name} className="max-w-full" /></div>
            : url && type.startsWith("video/") ? <video controls src={url} aria-label={name} className="h-full w-full" />
            : url && type === "application/pdf" ? <iframe title={`Preview ${name}`} src={url} className="h-full w-full border-0" />
            : text !== undefined && /\.(?:md|markdown)$/i.test(name) ? <TaskMarkdown key={sourceKey ?? name} className="aui-markdown p-4 text-sm" content={text} saveCheckbox={saveCheckbox ? async (edit) => {
              await saveCheckbox(edit);
              const next = toggleMarkdown(edit);
              setText(next);
              setFile({ blob: new Blob([next], { type: type || "text/markdown" }), name });
            } : undefined} />
            : text !== undefined ? <pre className="whitespace-pre-wrap break-words p-4 font-mono text-xs">{text}</pre>
            : url ? <div className="grid h-full content-center justify-items-center gap-3 p-6 text-center text-sm text-muted-foreground"><FileText className="size-10" /><p>Preview is unavailable for this file type.</p><p>Download the file to open it.</p></div> : <p className="p-6 text-center text-sm text-muted-foreground">Preview is unavailable. Try downloading the file.</p>}
        </div>
      </DialogContent>
    </Dialog>
  </>;
}
