import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { DndContext, PointerSensor, useDraggable, useDroppable, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { CSS } from "@dnd-kit/utilities";
import { GitBranch, KanbanSquare, LayoutGrid, List, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { api } from "@/lib/api";
import { boardStatuses, taskStatusMeta } from "@/lib/status";
import { useAppStore } from "@/lib/store";
import type { Task, TaskStatus } from "@/lib/types";
import { cn, relativeTime } from "@/lib/utils";

function BoardCard({ task }: { task: Task }) {
  const selectTask = useAppStore((state) => state.selectTask);
  const drag = useDraggable({ id: task.id, data: { task } });
  const style = { transform: CSS.Translate.toString(drag.transform) };
  function openTask() {
    selectTask(task);
    window.dispatchEvent(new CustomEvent("boosted:open-panel", { detail: "task" }));
  }
  return (
    <button ref={drag.setNodeRef} style={style} {...drag.listeners} {...drag.attributes} onClick={openTask} className={cn("relative grid w-full gap-2 rounded-lg border border-border bg-card p-3 text-left shadow-sm transition hover:border-primary/30 hover:bg-accent/35", drag.isDragging && "z-30 opacity-60 shadow-xl")}>
      <p className="text-xs font-medium leading-5">{task.title}</p>
      <div className="flex items-center gap-1.5 truncate font-mono text-[9px] text-muted-foreground"><GitBranch className="size-3" />{task.branchName}</div>
      <div className="flex items-center justify-between text-[10px] text-muted-foreground"><span>+<span className="text-success">{task.additions}</span> −<span className="text-destructive">{task.deletions}</span></span><span>{relativeTime(task.updatedAt)}</span></div>
    </button>
  );
}

function BoardColumn({ status, tasks }: { status: TaskStatus; tasks: Task[] }) {
  const drop = useDroppable({ id: status });
  const meta = taskStatusMeta[status];
  const Icon = meta.icon;
  return (
    <section ref={drop.setNodeRef} className={cn("flex min-h-44 min-w-0 flex-col rounded-lg border border-border bg-background/20", drop.isOver && "border-primary/45 bg-primary/5")}>
      <header className="flex h-10 items-center gap-2 px-3"><Icon className={cn("size-3.5", meta.color, status === "running" && "animate-spin")} /><span className="text-xs font-medium">{meta.boardLabel}</span><span className="ml-auto text-[10px] text-muted-foreground">{tasks.length}</span></header>
      <div className="grid content-start gap-2 p-2">{tasks.map((task) => <BoardCard key={task.id} task={task} />)}{tasks.length === 0 && <div className="rounded-md border border-dashed border-border px-3 py-8 text-center text-[10px] text-muted-foreground">Drop task here</div>}</div>
    </section>
  );
}

function TaskListRow({ task }: { task: Task }) {
  const selectTask = useAppStore((state) => state.selectTask);
  const selectedTaskId = useAppStore((state) => state.selectedTaskId);
  const meta = taskStatusMeta[task.status];
  const Icon = meta.icon;
  function openTask() {
    selectTask(task);
    window.dispatchEvent(new CustomEvent("boosted:open-panel", { detail: "task" }));
  }
  return (
    <button
      className={cn("grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-4 border-b border-border/70 px-3 py-2.5 text-left hover:bg-accent/45", selectedTaskId === task.id && "bg-accent/70")}
      onClick={openTask}
    >
      <span className="min-w-0">
        <span className="block truncate text-xs font-medium text-foreground">{task.title}</span>
        <span className="mt-1 flex min-w-0 items-center gap-3 text-[10px] text-muted-foreground">
          <span className="inline-flex shrink-0 items-center gap-1"><Icon className={cn("size-3", meta.color, task.status === "running" && "animate-spin")} />{meta.label}</span>
          <span className="inline-flex min-w-0 items-center gap-1 truncate font-mono"><GitBranch className="size-3 shrink-0" />{task.branchName}</span>
        </span>
      </span>
      <span className="grid shrink-0 justify-items-end gap-1 text-[10px] text-muted-foreground">
        <span><span className="text-success">+{task.additions}</span> <span className="text-destructive">−{task.deletions}</span></span>
        <span>{relativeTime(task.updatedAt)}</span>
      </span>
    </button>
  );
}

export function TaskboardPanel() {
  const [view, setView] = useState<"board" | "list">(() => localStorage.getItem("boosted.taskboard.view") === "list" ? "list" : "board");
  const projectId = useAppStore((state) => state.selectedProjectId);
  const queryClient = useQueryClient();
  const tasks = useQuery({ queryKey: ["tasks", projectId], queryFn: () => api.tasks(projectId), enabled: Boolean(projectId) });
  const move = useMutation({ mutationFn: ({ id, status }: { id: string; status: TaskStatus }) => api.setTaskStatus(id, status), onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["tasks"] }) });
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 7 } }));
  function dragEnd(event: DragEndEvent) {
    const task = event.active.data.current?.task as Task | undefined;
    const status = event.over?.id as TaskStatus | undefined;
    if (task && status && task.status !== status) move.mutate({ id: task.id, status });
  }
  function selectView(next: "board" | "list") {
    setView(next);
    localStorage.setItem("boosted.taskboard.view", next);
  }
  if (!projectId) return <div className="panel-root tool-panel"><div className="panel-header"><div className="panel-title"><KanbanSquare className="size-3.5" />Taskboard</div></div><div className="empty-state min-h-0 flex-1"><KanbanSquare className="size-8" /><p>Open a project folder to use its taskboard.</p></div></div>;
  return (
    <div className="panel-root tool-panel">
      <div className="panel-header">
        <div className="panel-title"><KanbanSquare className="size-3.5" />Taskboard</div>
        <div className="ml-auto flex items-center gap-1.5">
          <div className="flex items-center rounded-md bg-background/60 p-0.5" aria-label="Taskboard view">
            <Button size="icon-sm" variant="ghost" className={cn("size-6", view === "board" && "bg-accent text-foreground")} aria-label="Board view" aria-pressed={view === "board"} title="Board view" onClick={() => selectView("board")}><LayoutGrid /></Button>
            <Button size="icon-sm" variant="ghost" className={cn("size-6", view === "list" && "bg-accent text-foreground")} aria-label="List view" aria-pressed={view === "list"} title="List view" onClick={() => selectView("list")}><List /></Button>
          </div>
          <Button size="sm" variant="ghost" onClick={() => window.dispatchEvent(new CustomEvent("boosted:new-task"))}><Plus />Task</Button>
        </div>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        {tasks.isLoading && <div className="px-3 py-10 text-center text-xs text-muted-foreground">Loading tasks…</div>}
        {!tasks.isLoading && view === "board" && <DndContext sensors={sensors} onDragEnd={dragEnd}><div className="taskboard-grid grid min-h-full grid-cols-[repeat(auto-fit,minmax(min(240px,100%),1fr))] content-start gap-2 p-3">{boardStatuses.map((status) => <BoardColumn key={status} status={status} tasks={(tasks.data ?? []).filter((task) => task.status === status)} />)}</div></DndContext>}
        {!tasks.isLoading && view === "list" && <div className="taskboard-list min-h-full p-3"><div className="overflow-hidden rounded-lg border border-border bg-background/20">{(tasks.data ?? []).map((task) => <TaskListRow key={task.id} task={task} />)}{tasks.data?.length === 0 && <div className="px-3 py-12 text-center text-xs text-muted-foreground">No tasks yet</div>}</div></div>}
      </ScrollArea>
      {move.error && <div className="border-t border-border px-3 py-2 text-xs text-destructive">{move.error.message}</div>}
    </div>
  );
}
