import { createContext, useContext, useEffect, useMemo, useState, type ComponentPropsWithoutRef, type ReactNode } from "react";
import { defaultUrlTransform, type Components } from "react-markdown";
import { api, type WorkspaceFileScope } from "@/lib/api";

const WorkspaceFileContext = createContext<WorkspaceFileScope | undefined>(undefined);

export function WorkspaceFileProvider({ scope, children }: { scope: WorkspaceFileScope; children: ReactNode }) {
  const value = useMemo<WorkspaceFileScope>(() => ({ kind: scope.kind, id: scope.id }), [scope.id, scope.kind]);
  return <WorkspaceFileContext.Provider value={value}>{children}</WorkspaceFileContext.Provider>;
}

function decodePath(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function localWorkspacePath(value?: string) {
  if (!value) return undefined;
  const decoded = decodePath(value);
  if (decoded.startsWith("#")) return undefined;
  if (/^[a-z]:[\\/]/i.test(decoded)) return decoded;
  if (decoded.startsWith("file://")) {
    try {
      const url = new URL(decoded);
      const host = url.hostname && url.hostname !== "localhost" ? `//${url.hostname}` : "";
      let path = `${host}${decodePath(url.pathname)}`;
      if (/^\/[a-z]:\//i.test(path)) path = path.slice(1);
      return path;
    } catch {
      return decoded.slice("file://".length);
    }
  }
  if (/^[a-z][a-z\d+.-]*:/i.test(decoded) || decoded.startsWith("//")) return undefined;
  return decoded;
}

export function workspaceMarkdownUrlTransform(value: string) {
  return localWorkspacePath(value) ?? defaultUrlTransform(value);
}

export function workspaceFileName(path: string) {
  const withoutFragment = path.replace(/#L?\d+(?:-L\d+)?$/, "");
  const withoutLine = withoutFragment.replace(/:\d+$/, "");
  return withoutLine.split(/[\\/]/).filter(Boolean).pop() ?? "artifact";
}

type MarkdownAnchorProps = ComponentPropsWithoutRef<"a"> & { node?: unknown };

function WorkspaceFileLink({ node: _node, href, children, onClick: _onClick, ...props }: MarkdownAnchorProps) {
  const scope = useContext(WorkspaceFileContext);
  const path = localWorkspacePath(href);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  if (!scope || !path) {
    const external = Boolean(href && /^[a-z][a-z\d+.-]*:/i.test(href));
    return <a {...props} href={href} target={external ? "_blank" : props.target} rel={external ? "noreferrer" : props.rel}>{children}</a>;
  }

  return (
    <a
      {...props}
      href="#"
      aria-busy={busy}
      title={error ?? `Download ${workspaceFileName(path)} from the Boosted server`}
      onClick={(event) => {
        event.preventDefault();
        if (busy) return;
        setBusy(true);
        setError(undefined);
        void api.downloadWorkspaceFile(scope, path, workspaceFileName(path))
          .catch((cause) => setError(cause instanceof Error ? cause.message : "Unable to download file."))
          .finally(() => setBusy(false));
      }}
    >
      {children}{busy ? " …" : ""}
    </a>
  );
}

type MarkdownImageProps = ComponentPropsWithoutRef<"img"> & { node?: unknown };

function WorkspaceFileImage({ node: _node, src, alt, ...props }: MarkdownImageProps) {
  const scope = useContext(WorkspaceFileContext);
  const path = localWorkspacePath(src);
  const [blobUrl, setBlobUrl] = useState<string>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!scope || !path) return;
    let active = true;
    let objectUrl: string | undefined;
    setBlobUrl(undefined);
    setError(undefined);
    void api.workspaceFile(scope, path)
      .then(({ blob }) => {
        if (!blob.type.startsWith("image/")) throw new Error("Linked file is not an image.");
        objectUrl = URL.createObjectURL(blob);
        if (active) setBlobUrl(objectUrl);
        else URL.revokeObjectURL(objectUrl);
      })
      .catch((cause) => {
        if (active) setError(cause instanceof Error ? cause.message : "Unable to load image.");
      });
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [path, scope]);

  if (!scope || !path) return <img {...props} src={src} alt={alt} />;
  if (blobUrl) return <img {...props} src={blobUrl} alt={alt} />;
  if (error) {
    return (
      <button
        type="button"
        className="workspace-file-image-status text-destructive"
        title={error}
        onClick={() => void api.downloadWorkspaceFile(scope, path, workspaceFileName(path))
          .catch((cause) => setError(cause instanceof Error ? cause.message : "Unable to download file."))}
      >
        {alt || workspaceFileName(path)} (download)
      </button>
    );
  }
  return <span className="workspace-file-image-status text-muted-foreground">Loading {alt || workspaceFileName(path)}…</span>;
}

export const workspaceFileMarkdownComponents: Components = {
  a: WorkspaceFileLink,
  img: WorkspaceFileImage,
};
