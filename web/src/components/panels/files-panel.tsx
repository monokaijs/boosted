import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, File, FileCode2, Folder, FolderOpen } from "lucide-react";
import { api } from "@/lib/api";
import { useAppStore } from "@/lib/store";
import type { FileEntry } from "@/lib/types";
import { cn } from "@/lib/utils";

type FileSource = { kind: "task" | "project"; id: string };

function listSource(source: FileSource, path: string) {
  return source.kind === "task" ? api.files(source.id, path) : api.projectFiles(source.id, path);
}

function Directory({ source, path, depth, onSelect, selected }: { source: FileSource; path: string; depth: number; onSelect: (path: string) => void; selected?: string }) {
  const queryId = source.kind === "task" ? source.id : `project:${source.id}`;
  const entries = useQuery({ queryKey: ["files", queryId, path], queryFn: () => listSource(source, path) });
  return <>{entries.data?.map((entry) => <TreeEntry key={entry.path} source={source} entry={entry} depth={depth} onSelect={onSelect} selected={selected} />)}</>;
}

function TreeEntry({ source, entry, depth, onSelect, selected }: { source: FileSource; entry: FileEntry; depth: number; onSelect: (path: string) => void; selected?: string }) {
  const [open, setOpen] = useState(false);
  if (entry.kind === "directory") return (
    <>
      <button className="flex h-7 w-full items-center gap-1 truncate pr-2 text-left text-[12px] text-muted-foreground hover:bg-accent hover:text-foreground" style={{ paddingLeft: 8 + depth * 14 }} onClick={() => setOpen(!open)}>
        {open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}{open ? <FolderOpen className="size-3.5" /> : <Folder className="size-3.5" />}<span className="truncate">{entry.name}</span>
      </button>
      {open && <Directory source={source} path={entry.path} depth={depth + 1} onSelect={onSelect} selected={selected} />}
    </>
  );
  return <button className={cn("flex h-7 w-full items-center gap-1.5 truncate pr-2 text-left text-[12px] text-muted-foreground hover:bg-accent hover:text-foreground", selected === entry.path && "bg-accent text-foreground")} style={{ paddingLeft: 24 + depth * 14 }} onClick={() => onSelect(entry.path)}><File className="size-3.5" /><span className="truncate">{entry.name}</span></button>;
}

export function FilesPanel() {
  const taskId = useAppStore((state) => state.selectedTaskId);
  const projectId = useAppStore((state) => state.selectedProjectId);
  const selected = useAppStore((state) => state.openFilePath);
  const openFile = useAppStore((state) => state.openFile);
  const source: FileSource | undefined = taskId ? { kind: "task", id: taskId } : projectId ? { kind: "project", id: projectId } : undefined;
  const projects = useQuery({ queryKey: ["projects"], queryFn: api.projects });
  const project = projects.data?.find((entry) => entry.id === projectId);

  function selectFile(path: string) {
    openFile(path);
    window.dispatchEvent(new CustomEvent("boosted:open-file"));
  }

  if (!source) return <div className="panel-root tool-panel"><div className="panel-header"><div className="panel-title"><FileCode2 className="size-3.5" />Files</div></div><div className="empty-state min-h-0 flex-1"><Folder className="size-8" /><p>Open a Git repository folder to browse its files.</p></div></div>;
  return (
    <div className="panel-root tool-panel">
      <div className="panel-header"><div className="panel-title"><FileCode2 className="size-3.5" />Files</div><span className="font-mono text-[9px] text-muted-foreground">{taskId ? "worktree" : "project"}</span></div>
      <div className="file-tree min-h-0 flex-1 overflow-auto px-1 pb-3 pt-1">
        <div className="mb-1 flex h-8 items-center gap-2 rounded bg-accent px-2 text-xs font-semibold text-foreground"><FolderOpen className="size-4" /><span className="truncate">{project?.name ?? "Repository"}</span></div>
        <Directory source={source} path="" depth={0} onSelect={selectFile} selected={selected} />
      </div>
    </div>
  );
}
