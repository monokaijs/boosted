import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { DndContext, PointerSensor, useDraggable, useDroppable, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { CSS } from "@dnd-kit/utilities";
import { ArrowRight, Columns3, FileDiff, GitBranch, ListTodo, Paperclip, Plus, Search, SquareCheckBig, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ProjectAvatar } from "@/components/project-avatar";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { api } from "@/lib/api";
import { boardColumns, taskStatusMeta } from "@/lib/status";
import { useAppStore } from "@/lib/store";
import type { Project, Task, TaskStatus } from "@/lib/types";
import { cn, relativeTime } from "@/lib/utils";
import "./taskboard-panel.css";

function columnHasStatus(column: typeof boardColumns[number], status: TaskStatus) {
  return (column.statuses as TaskStatus[]).includes(status);
}

function taskKey(task: Task) {
  if (task.source) {
    const externalId = task.source.externalId.replace(/^(issue|work[_ -]?item):/i, "#");
    return `${task.source.provider} ${externalId}`;
  }
  return task.id.length > 10 ? task.id.slice(0, 8) : task.id;
}

function BoardCard({ task }: { task: Task }) {
  const selectTask = useAppStore((state) => state.selectTask);
  const drag = useDraggable({ id: task.id, data: { task } });
  const style = { transform: CSS.Translate.toString(drag.transform) };
  const status = taskStatusMeta[task.status];
  const hasChanges = task.additions > 0 || task.deletions > 0;
  function openTask() {
    selectTask(task);
    window.dispatchEvent(new CustomEvent("boosted:open-panel", { detail: "task" }));
  }
  return (
    <button
      ref={drag.setNodeRef}
      style={style}
      {...drag.listeners}
      {...drag.attributes}
      onClick={openTask}
      className={cn("task-board-card", drag.isDragging && "is-dragging")}
      data-status={task.status}
      data-source={task.source?.provider ?? "local"}
    >
      <p className="task-card-title">{task.title}</p>
      <div className="task-card-field" title={task.branchName}><GitBranch /><span>{task.branchName}</span></div>
      <footer className="task-card-footer">
        <span className="task-card-identity" title={task.source ? `${task.source.provider} ${task.source.externalId}` : task.id}>
          <SquareCheckBig /><span>{taskKey(task)}</span>
        </span>
        <span className={cn("task-card-status", status.color)}>{status.label}</span>
        <span className="task-card-signals">
          {task.attachments.length > 0 && <span title={`${task.attachments.length} attachment${task.attachments.length === 1 ? "" : "s"}`}><Paperclip />{task.attachments.length}</span>}
          {hasChanges && <span title={`${task.additions} addition${task.additions === 1 ? "" : "s"}, ${task.deletions} deletion${task.deletions === 1 ? "" : "s"}`}><FileDiff /><b>+{task.additions}</b><i>−{task.deletions}</i></span>}
          <time dateTime={task.updatedAt} title={`Updated ${task.updatedAt}`}>{relativeTime(task.updatedAt)}</time>
        </span>
      </footer>
    </button>
  );
}

function BoardColumn({ column, tasks }: { column: typeof boardColumns[number]; tasks: Task[] }) {
  const drop = useDroppable({ id: `board-column:${column.id}` });
  const Icon = column.icon;
  return (
    <section ref={drop.setNodeRef} className={cn("flex min-h-44 min-w-0 flex-col rounded-lg border border-border bg-background/20", drop.isOver && "border-primary/45 bg-primary/5")}>
      <header className="flex h-10 items-center gap-2 px-3"><Icon className={cn("size-3.5", column.color)} /><span className="text-xs font-medium">{column.label}</span><span className="ml-auto text-[10px] text-muted-foreground">{tasks.length}</span></header>
      <div className="grid content-start gap-2 p-2">{tasks.map((task) => <BoardCard key={task.id} task={task} />)}{tasks.length === 0 && <div className="rounded-md border border-dashed border-border px-3 py-8 text-center text-[10px] text-muted-foreground">Drop task here</div>}</div>
    </section>
  );
}

function TaskListRow({ task }: { task: Task }) {
  const selectTask = useAppStore((state) => state.selectTask);
  const selectedTaskId = useAppStore((state) => state.selectedTaskId);
  const column = boardColumns.find((entry) => columnHasStatus(entry, task.status)) ?? boardColumns[0];
  const Icon = column.icon;
  const hasChanges = task.additions > 0 || task.deletions > 0;
  function openTask() {
    selectTask(task);
    window.dispatchEvent(new CustomEvent("boosted:open-panel", { detail: "task" }));
  }
  return (
    <button
      className={cn("task-list-row", selectedTaskId === task.id && "is-selected")}
      onClick={openTask}
    >
      <span className="task-list-main">
        <span className="task-list-title">{task.title}</span>
        <span className="task-list-metadata">
          <span className={cn("task-list-status", column.color)}><Icon />{column.label}</span>
          <span className="task-list-branch" title={task.branchName}><GitBranch />{task.branchName}</span>
        </span>
      </span>
      <span className="task-list-signals">
        <time dateTime={task.updatedAt} title={`Updated ${task.updatedAt}`}>{relativeTime(task.updatedAt)}</time>
        {hasChanges && <span title={`${task.additions} additions, ${task.deletions} deletions`}><b>+{task.additions}</b><i>−{task.deletions}</i></span>}
      </span>
    </button>
  );
}

type TaskFilter = "all" | typeof boardColumns[number]["id"];

function taskMatchesSearch(task: Task, search: string) {
  const query = search.trim().toLocaleLowerCase();
  if (!query) return true;
  const source = task.source ? `${task.source.provider} ${task.source.externalId}` : "";
  return `${task.title} ${task.branchName} ${source}`.toLocaleLowerCase().includes(query);
}

function TaskToolbar({ search, onSearchChange, filter, onFilterChange }: {
  search: string;
  onSearchChange(value: string): void;
  filter: TaskFilter;
  onFilterChange(value: TaskFilter): void;
}) {
  return <div className="task-toolbar">
    <label className="task-search">
      <Search />
      <input aria-label="Search tasks" placeholder="Search tasks" value={search} onChange={(event) => onSearchChange(event.target.value)} />
      {search && <button type="button" aria-label="Clear task search" onClick={() => onSearchChange("")}><X /></button>}
    </label>
    <Select value={filter} onValueChange={(value) => onFilterChange(value as TaskFilter)}>
      <SelectTrigger aria-label="Filter tasks by status" className="task-filter"><SelectValue /></SelectTrigger>
      <SelectContent align="end">
        <SelectItem value="all">All statuses</SelectItem>
        {boardColumns.map((column) => <SelectItem key={column.id} value={column.id}>{column.label}</SelectItem>)}
      </SelectContent>
    </Select>
  </div>;
}

function TaskCollectionPanel({ detailOpen = false }: { detailOpen?: boolean }) {
  const projectId = useAppStore((state) => state.selectedProjectId);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<TaskFilter>("all");
  const queryClient = useQueryClient();
  const tasks = useQuery({ queryKey: ["tasks", projectId], queryFn: () => api.tasks(projectId!), enabled: Boolean(projectId) });
  const allTasks = tasks.data ?? [];
  const visibleTasks = useMemo(() => allTasks.filter((task) => {
    const matchesFilter = filter === "all" || boardColumns.some((column) => column.id === filter && columnHasStatus(column, task.status));
    return matchesFilter && taskMatchesSearch(task, search);
  }), [allTasks, filter, search]);
  const filtersActive = Boolean(search.trim()) || filter !== "all";
  const move = useMutation({ mutationFn: ({ id, status }: { id: string; status: TaskStatus }) => api.setTaskStatus(id, status), onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["tasks"] }) });
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 7 } }));
  function dragEnd(event: DragEndEvent) {
    const task = event.active.data.current?.task as Task | undefined;
    const column = boardColumns.find((entry) => `board-column:${entry.id}` === event.over?.id);
    if (task && column && !columnHasStatus(column, task.status)) move.mutate({ id: task.id, status: column.targetStatus });
  }
  if (!projectId) return <div className="panel-root tool-panel"><div className="empty-state min-h-0 flex-1"><ListTodo className="size-8" /><p>Select a board to view its tasks.</p><Button variant="secondary" onClick={() => { window.location.hash = "boards"; }}>View boards</Button></div></div>;
  return (
    <div className="panel-root tool-panel">
      <div className="panel-header">
        <div className="panel-title"><Columns3 className="size-3.5" /><span>{detailOpen ? "Tasks" : "Task board"}</span>{!tasks.isLoading && !tasks.error && <span className="task-count" aria-live="polite">{visibleTasks.length === allTasks.length ? allTasks.length : `${visibleTasks.length}/${allTasks.length}`}</span>}</div>
        <Button size="sm" variant="ghost" aria-label="Create task" onClick={() => window.dispatchEvent(new CustomEvent("boosted:new-task"))}><Plus />New task</Button>
      </div>
      {!tasks.isLoading && !tasks.error && <TaskToolbar search={search} onSearchChange={setSearch} filter={filter} onFilterChange={setFilter} />}
      <ScrollArea className="min-h-0 flex-1">
        {tasks.isLoading && <div className="px-3 py-10 text-center text-xs text-muted-foreground">Loading tasks…</div>}
        {tasks.error && <div role="alert" className="px-3 py-8 text-center text-xs text-destructive">{tasks.error.message}<Button variant="ghost" size="sm" onClick={() => void tasks.refetch()}>Try again</Button></div>}
        {!tasks.isLoading && !tasks.error && !detailOpen && <DndContext sensors={sensors} onDragEnd={dragEnd}><div className="boards-grid grid min-h-full grid-cols-4 content-start gap-3 p-3">{boardColumns.map((column) => <BoardColumn key={column.id} column={column} tasks={visibleTasks.filter((task) => columnHasStatus(column, task.status))} />)}</div></DndContext>}
        {!tasks.isLoading && !tasks.error && detailOpen && <div className="tasks-list min-h-full">{visibleTasks.map((task) => <TaskListRow key={task.id} task={task} />)}{visibleTasks.length === 0 && <div className="task-list-empty"><Search /><p>{filtersActive ? "No tasks match your filters" : "No tasks yet"}</p>{filtersActive && <Button variant="ghost" size="sm" onClick={() => { setSearch(""); setFilter("all"); }}>Clear filters</Button>}</div>}</div>}
      </ScrollArea>
      {move.error && <div className="border-t border-border px-3 py-2 text-xs text-destructive">{move.error.message}</div>}
    </div>
  );
}

export function TasksPanel({ detailOpen = false }: { detailOpen?: boolean }) {
  return <TaskCollectionPanel detailOpen={detailOpen} />;
}

function openBoard(project: Project) {
  useAppStore.getState().selectProject(project);
  window.dispatchEvent(new CustomEvent("boosted:open-panel", { detail: "tasks" }));
}

export function BoardsPanel() {
  const projects = useQuery({ queryKey: ["projects"], queryFn: api.projects });
  const selectedProjectId = useAppStore((state) => state.selectedProjectId);
  return <div className="full-page-scroll boards-directory"><div className="page-content">
    <header className="page-heading"><div><h1>Boards</h1><p>Choose a project task board.</p></div></header>
    {projects.isPending && <div className="px-3 py-10 text-center text-xs text-muted-foreground">Loading boards…</div>}
    {projects.error && <div role="alert" className="px-3 py-8 text-center text-xs text-destructive">{projects.error.message}<Button variant="ghost" size="sm" onClick={() => void projects.refetch()}>Try again</Button></div>}
    <ul className="boards-list">{projects.data?.map((project) => <li key={project.id}><button className={cn("boards-list-row", selectedProjectId === project.id && "is-current")} onClick={() => openBoard(project)}>
      <ProjectAvatar project={project} className="project-page-icon" />
      <span><strong>{project.name}</strong><small>{project.repoPath}</small></span>
      <em>{selectedProjectId === project.id ? "Current" : ""}</em>
      <ArrowRight />
    </button></li>)}</ul>
    {projects.data?.length === 0 && <div className="page-empty"><Columns3 /><h2>No boards yet</h2><p>Open a project to create its task board.</p></div>}
  </div></div>;
}
