import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, ChevronDown, ChevronRight, FileDiff, GitBranch, LoaderCircle, Minus, Plus, RotateCcw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { api } from "@/lib/api";
import { useAppStore } from "@/lib/store";
import type { GitChange } from "@/lib/types";
import { cn } from "@/lib/utils";

function Diff({ value }: { value: string }) {
  return <pre className="h-full overflow-auto p-3 font-mono text-[10px] leading-[17px] text-muted-foreground">{value.split("\n").map((line, index) => <div key={index} className={cn("min-h-[17px] whitespace-pre", line.startsWith("+") && !line.startsWith("+++") && "diff-add", line.startsWith("-") && !line.startsWith("---") && "diff-del")}>{line || " "}</div>)}</pre>;
}

function ChangeSection({ title, changes, staged, taskId, onSelect, selected }: { title: string; changes: GitChange[]; staged: boolean; taskId: string; onSelect: (change: GitChange, staged: boolean) => void; selected?: string }) {
  const [open, setOpen] = useState(true);
  const queryClient = useQueryClient();
  const action = useMutation({ mutationFn: (paths: string[]) => staged ? api.gitUnstage(taskId, paths) : api.gitStage(taskId, paths), onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["git", taskId] }) });
  return <div><div className="flex h-7 items-center border-b border-border/70 px-2"><button className="flex flex-1 items-center gap-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground" onClick={() => setOpen(!open)}>{open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}{title}<span className="ml-1 font-normal">{changes.length}</span></button>{changes.length > 0 && <Button variant="ghost" size="icon-sm" onClick={() => action.mutate(changes.map((change) => change.path))} title={staged ? "Unstage all" : "Stage all"}>{staged ? <Minus /> : <Plus />}</Button>}</div>{open && changes.map((change) => <button key={change.path} className={cn("group flex h-7 w-full items-center gap-2 px-3 text-left text-[11px] hover:bg-accent", selected === `${staged}:${change.path}` && "bg-accent")} onClick={() => onSelect(change, staged)}><span className={cn("w-3 font-mono font-bold", change.worktreeStatus === "D" || change.indexStatus === "D" ? "text-destructive" : change.worktreeStatus === "?" ? "text-warning" : "text-primary")}>{staged ? change.indexStatus : change.worktreeStatus}</span><span className="min-w-0 flex-1 truncate">{change.path}</span><span className="text-[9px]"><span className="text-success">+{change.additions}</span> <span className="text-destructive">-{change.deletions}</span></span><Button className="hidden group-hover:inline-flex" variant="ghost" size="icon-sm" onClick={(event) => { event.stopPropagation(); action.mutate([change.path]); }}>{staged ? <Minus /> : <Plus />}</Button></button>)}</div>;
}

export function GitPanel() {
  const taskId = useAppStore((state) => state.selectedTaskId);
  const [selection, setSelection] = useState<{ change: GitChange; staged: boolean }>();
  const [message, setMessage] = useState("");
  const queryClient = useQueryClient();
  const status = useQuery({ queryKey: ["git", taskId, "status"], queryFn: () => api.gitStatus(taskId!), enabled: Boolean(taskId), refetchInterval: 3_000 });
  const diff = useQuery({ queryKey: ["git", taskId, "diff", selection?.change.path, selection?.staged], queryFn: () => api.gitDiff(taskId!, selection!.change.path, selection!.staged), enabled: Boolean(taskId && selection) });
  const commit = useMutation({ mutationFn: () => api.gitCommit(taskId!, message), onSuccess: () => { setMessage(""); setSelection(undefined); void queryClient.invalidateQueries({ queryKey: ["git", taskId] }); void queryClient.invalidateQueries({ queryKey: ["task", taskId] }); } });
  const discard = useMutation({ mutationFn: (path: string) => api.gitDiscard(taskId!, [path]), onSuccess: () => { setSelection(undefined); void queryClient.invalidateQueries({ queryKey: ["git", taskId] }); } });
  const staged = useMemo(() => (status.data?.changes ?? []).filter((change) => change.indexStatus !== "." && change.indexStatus !== " "), [status.data]);
  const unstaged = useMemo(() => (status.data?.changes ?? []).filter((change) => change.worktreeStatus !== "." && change.worktreeStatus !== " "), [status.data]);
  if (!taskId) return <div className="panel-root tool-panel"><div className="panel-header"><div className="panel-title"><GitBranch className="size-3.5" />Changes</div></div><div className="empty-state min-h-0 flex-1"><GitBranch className="size-8" /><p>Select a task to review its Git changes.</p></div></div>;
  return (
    <div className="panel-root tool-panel">
      <div className="panel-header"><div className="panel-title"><GitBranch className="size-3.5" />Changes</div>{status.data && <Badge variant="outline">{status.data.branch}</Badge>}</div>
      <div className="git-layout grid min-h-0 flex-1 grid-cols-[230px_1fr]">
        <div className="git-changes-list flex min-h-0 flex-col border-r border-border">
          <ScrollArea className="min-h-0 flex-1"><ChangeSection title="Staged" changes={staged} staged taskId={taskId} onSelect={(change, nextStaged) => setSelection({ change, staged: nextStaged })} selected={selection ? `${selection.staged}:${selection.change.path}` : undefined} /><ChangeSection title="Changes" changes={unstaged} staged={false} taskId={taskId} onSelect={(change, nextStaged) => setSelection({ change, staged: nextStaged })} selected={selection ? `${selection.staged}:${selection.change.path}` : undefined} />{status.data?.changes.length === 0 && <div className="px-3 py-10 text-center text-xs text-muted-foreground"><Check className="mx-auto mb-2 size-5 text-success" />Working tree is clean</div>}</ScrollArea>
          <form className="grid gap-2 border-t border-border p-2" onSubmit={(event) => { event.preventDefault(); commit.mutate(); }}><Input placeholder="Commit message" value={message} onChange={(event) => setMessage(event.target.value)} /><Button size="sm" disabled={!message.trim() || staged.length === 0 || commit.isPending}>{commit.isPending && <LoaderCircle className="animate-spin" />}Commit {staged.length ? staged.length : ""}</Button></form>
        </div>
        <div className="git-diff-pane relative min-w-0 bg-background">{selection ? <><div className="flex h-8 items-center border-b border-border px-3"><span className="min-w-0 flex-1 truncate font-mono text-[10px] text-muted-foreground">{selection.change.path}</span>{!selection.staged && <Button variant="ghost" size="sm" className="text-destructive" onClick={() => { if (window.confirm(`Discard changes to ${selection.change.path}? This cannot be undone.`)) discard.mutate(selection.change.path); }}><RotateCcw />Discard</Button>}</div><div className="h-[calc(100%-2rem)]">{diff.isLoading ? <div className="empty-state"><LoaderCircle className="animate-spin" /></div> : <Diff value={diff.data?.diff ?? "No diff"} />}</div></> : <div className="empty-state"><FileDiff className="size-8" /><p>Select a changed file to inspect its diff.</p></div>}</div>
      </div>
      {(status.error || commit.error || discard.error) && <div className="border-t border-border px-3 py-2 text-xs text-destructive">{(status.error ?? commit.error ?? discard.error)?.message}</div>}
    </div>
  );
}
