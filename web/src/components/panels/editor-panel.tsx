import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { IDockviewPanelProps } from "dockview-react";
import { ChevronRight, FileCode2, LoaderCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { useAppStore } from "@/lib/store";

const Editor = lazy(() => import("@/lib/monaco"));

function pathParts(path: string) {
  return path.split(/[\\/]+/).filter(Boolean);
}

export function EditorPanel({ api: panelApi }: IDockviewPanelProps) {
  const taskId = useAppStore((state) => state.selectedTaskId);
  const projectId = useAppStore((state) => state.selectedProjectId);
  const path = useAppStore((state) => state.openFilePath);
  const [content, setContent] = useState("");
  const [revision, setRevision] = useState("");
  const [dirty, setDirty] = useState(false);
  const saveRef = useRef<() => void>(() => undefined);
  const queryClient = useQueryClient();
  const sourceId = taskId ?? projectId;
  const editable = Boolean(taskId);
  const breadcrumbs = pathParts(path ?? "");
  const fileName = breadcrumbs.at(-1) ?? "Editor";
  const file = useQuery({
    queryKey: ["file", taskId ? "task" : "project", sourceId, path],
    queryFn: () => taskId ? api.readFile(taskId, path!) : api.readProjectFile(projectId!, path!),
    enabled: Boolean(sourceId && path),
  });

  useEffect(() => {
    setContent("");
    setRevision("");
    setDirty(false);
  }, [sourceId, path]);

  useEffect(() => {
    panelApi.setTitle(`${fileName}${dirty ? " •" : ""}`);
  }, [dirty, fileName, panelApi]);

  useEffect(() => {
    if (file.data && !dirty) {
      setContent(file.data.content);
      setRevision(file.data.revision);
    }
  }, [dirty, file.data]);

  const save = useMutation({
    mutationFn: () => api.writeFile(taskId!, path!, content, revision),
    onSuccess: (saved) => {
      setContent(saved.content);
      setRevision(saved.revision);
      setDirty(false);
      queryClient.setQueryData(["file", "task", taskId, path], saved);
      void queryClient.invalidateQueries({ queryKey: ["git", taskId] });
    },
  });

  saveRef.current = () => {
    if (editable && dirty && !save.isPending) save.mutate();
  };

  if (!path) return <div className="empty-state"><FileCode2 className="size-8" /><p>Open a file from the Files panel.</p></div>;

  return (
    <div className="panel-root">
      <div className="editor-content">
        <nav className="editor-breadcrumb" aria-label="File breadcrumb" title={path}>
          <ol>
            {breadcrumbs.map((part, index) => {
              const current = index === breadcrumbs.length - 1;
              return (
                <li key={`${part}-${index}`} className={current ? "editor-breadcrumb-current" : undefined}>
                  {index > 0 && <ChevronRight aria-hidden="true" />}
                  {current && <FileCode2 aria-hidden="true" />}
                  <span>{part}</span>
                  {current && dirty && <span className="editor-breadcrumb-dirty" aria-label="Unsaved changes">●</span>}
                </li>
              );
            })}
          </ol>
        </nav>
        <div className="relative min-h-0 flex-1 bg-background">
          {file.isLoading && <div className="empty-state"><LoaderCircle className="size-6 animate-spin" /><p>Opening file…</p></div>}
          {file.data?.binary && <div className="empty-state"><FileCode2 className="size-8" /><p>Binary files cannot be displayed here.</p></div>}
          {file.data && !file.data.binary && (
            <Suspense fallback={<div className="empty-state"><LoaderCircle className="size-6 animate-spin" /><p>Loading editor…</p></div>}>
              <Editor
                height="100%"
                path={`${sourceId ?? "source"}/${path}`}
                language={file.data.language}
                value={content}
                onChange={(value) => { if (editable) { setContent(value ?? ""); setDirty(true); } }}
                onMount={(editor, monaco) => editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => saveRef.current())}
                theme="vs-dark"
                options={{
                  readOnly: !editable,
                  minimap: { enabled: false },
                  fontFamily: "JetBrains Mono, SFMono-Regular, Consolas, monospace",
                  fontSize: 12,
                  lineHeight: 19,
                  padding: { top: 8 },
                  renderLineHighlight: "gutter",
                  smoothScrolling: true,
                  automaticLayout: true,
                  scrollBeyondLastLine: false,
                  wordWrap: "off",
                  tabSize: 2,
                }}
              />
            </Suspense>
          )}
        </div>
      </div>
      {(save.error || file.error) && <div className="flex items-center justify-between gap-3 border-t border-border px-3 py-2 text-xs text-destructive"><span>{(save.error ?? file.error)?.message}</span>{save.error && <Button variant="outline" size="sm" onClick={() => { setDirty(false); save.reset(); void file.refetch(); }}>Load disk version</Button>}</div>}
    </div>
  );
}
