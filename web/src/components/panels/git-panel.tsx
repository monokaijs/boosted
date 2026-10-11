import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, ChevronDown, ChevronRight, FileDiff, GitBranch, GitCommitHorizontal, LoaderCircle, Minus, Plus, RotateCcw, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { api } from "@/lib/api";
import { useAppStore } from "@/lib/store";
import type { GitChange, GitCommit } from "@/lib/types";
import { cn, relativeTime } from "@/lib/utils";

function CommitRow({ commit }: { commit: GitCommit }) {
  return (
    <div className="git-history-row" title={`${commit.hash}\n${commit.authorName} <${commit.authorEmail}>\n${new Date(commit.authoredAt).toLocaleString()}`}>
      <span className="git-history-graph" aria-hidden="true" />
      <div className="min-w-0 py-2 pr-3">
        <div className="flex min-w-0 items-baseline gap-2">
          <span className="min-w-0 flex-1 truncate text-[11px] text-foreground">{commit.subject}</span>
          <code className="flex-none text-[9px] text-muted-foreground">{commit.shortHash}</code>
        </div>
        <div className="mt-0.5 flex min-w-0 items-center gap-2 text-[9px] text-muted-foreground">
          <span className="min-w-0 flex-1 truncate">{commit.authorName}</span>
          <time dateTime={commit.authoredAt}>{relativeTime(commit.authoredAt)}</time>
        </div>
      </div>
    </div>
  );
}

type GitDiffTarget = { path: string; staged: boolean; diff?: string };

function ChangeSection({ title, changes, staged, projectId, selected, onSelect, onDiscard }: { title: string; changes: GitChange[]; staged: boolean; projectId: string; selected?: GitDiffTarget; onSelect: (target: GitDiffTarget) => void; onDiscard?: (path: string) => void }) {
  const [open, setOpen] = useState(true);
  const queryClient = useQueryClient();
  const action = useMutation({ mutationFn: (paths: string[]) => staged ? api.gitUnstage(projectId, paths) : api.gitStage(projectId, paths), onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["project-git", projectId] }) });
  return <div className="git-change-section">
    <div className="flex h-7 items-center px-2"><button className="flex flex-1 items-center gap-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground" onClick={() => setOpen(!open)}>{open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}{title}<span className="ml-1 font-normal">{changes.length}</span></button>{changes.length > 0 && <Button variant="ghost" size="icon-sm" onClick={() => action.mutate(changes.map((change) => change.path))} title={staged ? "Unstage all" : "Stage all"}>{staged ? <Minus /> : <Plus />}</Button>}</div>
    {open && changes.map((change) => <div key={change.path} className="group flex h-7 w-full items-center rounded-md px-1 text-[11px] hover:bg-accent" data-selected={selected?.path === change.path && selected.staged === staged ? "true" : undefined}>
      <button type="button" className="flex min-w-0 flex-1 items-center gap-2 px-2 text-left" onClick={() => onSelect({ path: change.path, staged })}>
        <span className={cn("w-3 font-mono font-bold", change.worktreeStatus === "D" || change.indexStatus === "D" ? "text-destructive" : change.worktreeStatus === "?" ? "text-warning" : "text-primary")}>{staged ? change.indexStatus : change.worktreeStatus}</span>
        <span className="min-w-0 flex-1 truncate">{change.path}</span>
        <span className="text-[9px]"><span className="text-success">+{change.additions}</span> <span className="text-destructive">-{change.deletions}</span></span>
      </button>
      {!staged && onDiscard && <Button className="hidden text-destructive group-hover:inline-flex" variant="ghost" size="icon-sm" title={`Discard ${change.path}`} onClick={() => onDiscard(change.path)}><RotateCcw /></Button>}
      <Button className="hidden group-hover:inline-flex" variant="ghost" size="icon-sm" title={`${staged ? "Unstage" : "Stage"} ${change.path}`} onClick={() => action.mutate([change.path])}>{staged ? <Minus /> : <Plus />}</Button>
    </div>)}
  </div>;
}

function diffLineClass(line: string) {
  if (line.startsWith("+") && !line.startsWith("+++")) return "is-addition";
  if (line.startsWith("-") && !line.startsWith("---")) return "is-deletion";
  if (line.startsWith("@@")) return "is-hunk";
  return undefined;
}

function DiffPane({ projectId, target, onClose }: { projectId: string; target: GitDiffTarget; onClose: () => void }) {
  const diff = useQuery({ queryKey: ["project-git", projectId, "diff", target.path, target.staged], queryFn: () => api.gitDiff(projectId, target.path, target.staged), enabled: !target.diff });
  const content = target.diff ?? diff.data?.diff;
  return <section className="git-diff-pane flex min-h-0 min-w-0 flex-col" aria-label={`Diff for ${target.path}`}>
    <header><FileDiff /><span title={target.path}>{target.path}</span>{target.staged && <small>staged</small>}<Button variant="ghost" size="icon-sm" aria-label="Close diff" onClick={onClose}><X /></Button></header>
    {diff.isLoading ? <div className="empty-state"><LoaderCircle className="animate-spin" /><p>Loading diff…</p></div>
      : diff.error ? <div className="empty-state text-destructive"><p>{diff.error.message}</p></div>
      : content ? <ScrollArea className="min-h-0 flex-1"><pre>{content.split("\n").map((line, index) => <span key={index} className={diffLineClass(line)}>{line || " "}{"\n"}</span>)}</pre></ScrollArea>
      : <div className="empty-state"><FileDiff className="size-7" /><p>No diff is available for this file.</p></div>}
  </section>;
}

export function GitPanel() {
  const projectId = useAppStore((state) => state.selectedProjectId);
  if (!projectId) return <div className="panel-root tool-panel"><div className="panel-header"><div className="panel-title"><GitBranch className="size-3.5" />Changes</div></div><div className="empty-state min-h-0 flex-1"><GitBranch className="size-8" /><p>Select a project to review its Git changes.</p></div></div>;
  return <ProjectGitPanel key={projectId} projectId={projectId} />;
}

function ProjectGitPanel({ projectId }: { projectId: string }) {
  const [message, setMessage] = useState("");
  const selectedDiff = useAppStore((state) => state.gitDiffTarget);
  const openGitDiff = useAppStore((state) => state.openGitDiff);
  const queryClient = useQueryClient();
  const status = useQuery({ queryKey: ["project-git", projectId, "status"], queryFn: () => api.gitStatus(projectId), enabled: Boolean(projectId), refetchInterval: 3_000 });
  const history = useQuery({ queryKey: ["project-git", projectId, "history"], queryFn: () => api.gitHistory(projectId), enabled: Boolean(projectId), refetchInterval: 10_000 });
  const commit = useMutation({ mutationFn: () => api.gitCommit(projectId, message), onSuccess: () => { setMessage(""); void queryClient.invalidateQueries({ queryKey: ["project-git", projectId] }); } });
  const discard = useMutation({ mutationFn: (path: string) => api.gitDiscard(projectId, [path]), onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["project-git", projectId] }) });
  const staged = useMemo(() => (status.data?.changes ?? []).filter((change) => change.indexStatus !== "." && change.indexStatus !== " "), [status.data]);
  const unstaged = useMemo(() => (status.data?.changes ?? []).filter((change) => change.worktreeStatus !== "." && change.worktreeStatus !== " "), [status.data]);
  const discardPath = (path: string) => {
    if (window.confirm(`Discard changes to ${path}? This cannot be undone.`)) discard.mutate(path);
  };
  return (
    <div className="panel-root tool-panel">
      <div className="panel-header"><div className="panel-title"><GitBranch className="size-3.5" />Changes</div>{status.data && <Badge variant="outline">{status.data.branch}</Badge>}</div>
      <div className="git-layout grid min-h-0 flex-1 grid-cols-[230px_1fr]">
        <div className="git-changes-list flex min-h-0 flex-col">
          <ScrollArea className="min-h-0 flex-1"><ChangeSection title="Staged" changes={staged} staged projectId={projectId} selected={selectedDiff} onSelect={openGitDiff} /><ChangeSection title="Changes" changes={unstaged} staged={false} projectId={projectId} selected={selectedDiff} onSelect={openGitDiff} onDiscard={discardPath} />{status.data?.changes.length === 0 && <div className="px-3 py-10 text-center text-xs text-muted-foreground"><Check className="mx-auto mb-2 size-5 text-success" />Working tree is clean</div>}</ScrollArea>
          <form className="grid gap-2 p-2" onSubmit={(event) => { event.preventDefault(); commit.mutate(); }}><Input placeholder="Commit message" value={message} onChange={(event) => setMessage(event.target.value)} /><Button size="sm" disabled={!message.trim() || staged.length === 0 || commit.isPending}>{commit.isPending && <LoaderCircle className="animate-spin" />}Commit {staged.length ? staged.length : ""}</Button></form>
        </div>
        {selectedDiff ? <DiffPane projectId={projectId} target={selectedDiff} onClose={() => openGitDiff()} /> : <section className="git-history-pane flex min-h-0 min-w-0 flex-col">
          <div className="flex h-8 flex-none items-center gap-2 px-3"><GitCommitHorizontal className="size-3.5 text-muted-foreground" /><span className="text-[11px] font-medium">History</span>{status.data?.branch && <span className="ml-auto font-mono text-[9px] text-muted-foreground">{status.data.branch}</span>}</div>
          <ScrollArea className="min-h-0 flex-1">{history.isLoading ? <div className="empty-state"><LoaderCircle className="animate-spin" /></div> : history.data?.length ? history.data.map((item) => <CommitRow key={item.hash} commit={item} />) : <div className="empty-state"><GitCommitHorizontal className="size-8" /><p>No commits yet.</p></div>}</ScrollArea>
        </section>}
      </div>
      {(status.error || history.error || commit.error || discard.error) && <div className="px-3 py-2 text-xs text-destructive">{(status.error ?? history.error ?? commit.error ?? discard.error)?.message}</div>}
    </div>
  );
}
