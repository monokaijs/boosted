import { useMemo, useState } from "react";
import { Filter, GitBranch, Plus, Search } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { api } from "@/lib/api";
import { useAppStore } from "@/lib/store";
import { taskStatusMeta } from "@/lib/status";
import type { Task } from "@/lib/types";
import { cn, relativeTime } from "@/lib/utils";

type Props = { onNewTask: () => void };

function TaskRow({ task }: { task: Task }) {
  const selectedTaskId = useAppStore((state) => state.selectedTaskId);
  const selectTask = useAppStore((state) => state.selectTask);
  const setDrawerOpen = useAppStore((state) => state.setTaskDrawerOpen);
  const meta = taskStatusMeta[task.status];
  const Icon = meta.icon;
  function openTask() {
    selectTask(task);
    if (window.matchMedia("(max-width: 900px)").matches) setDrawerOpen(false);
    window.dispatchEvent(new CustomEvent("boosted:open-panel", { detail: "task" }));
  }
  return (
    <button
      className={cn("group grid w-full grid-cols-[20px_1fr_auto] items-start gap-2 rounded-md px-2 py-2 text-left hover:bg-accent/65", selectedTaskId === task.id && "bg-accent text-accent-foreground")}
      onClick={openTask}
    >
      <Icon className={cn("mt-0.5 size-4", meta.color, task.status === "running" && "animate-spin")} />
      <span className="min-w-0">
        <span className="block truncate text-[13px] font-medium">{task.title}</span>
        <span className="mt-0.5 flex items-center gap-1.5 truncate text-[11px] text-muted-foreground">
          <span>{meta.label}</span>
          {(task.additions > 0 || task.deletions > 0) && <><span className="text-success">+{task.additions}</span><span className="text-destructive">-{task.deletions}</span></>}
        </span>
      </span>
      <span className="pt-0.5 text-[10px] text-muted-foreground">{relativeTime(task.updatedAt)}</span>
    </button>
  );
}

export function TaskDrawer({ onNewTask }: Props) {
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<"all" | "active" | "done">("all");
  const projectId = useAppStore((state) => state.selectedProjectId);
  const projects = useQuery({ queryKey: ["projects"], queryFn: api.projects });
  const tasks = useQuery({ queryKey: ["tasks", projectId], queryFn: () => api.tasks(projectId), enabled: Boolean(projectId) });
  const project = projects.data?.find((entry) => entry.id === projectId);
  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return (tasks.data ?? []).filter((task) => {
      const matchesSearch = !needle || task.title.toLowerCase().includes(needle) || task.description.toLowerCase().includes(needle);
      const matchesStatus = filter === "all" || (filter === "done" ? task.status === "done" : task.status !== "done");
      return matchesSearch && matchesStatus;
    });
  }, [filter, search, tasks.data]);
  const active = filtered.filter((task) => task.status !== "done");
  const done = filtered.filter((task) => task.status === "done");

  return (
    <aside className="task-drawer">
      <div className="flex h-full min-w-0 flex-col">
        <div className="flex items-center gap-1.5 p-2">
          <div className="relative flex-1"><Search className="absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" /><Input className="bg-background/35 pl-7" placeholder="Search tasks" value={search} onChange={(event) => setSearch(event.target.value)} /></div>
          <Button variant={filter === "all" ? "ghost" : "secondary"} size="icon" title={`Showing ${filter} tasks`} onClick={() => setFilter(filter === "all" ? "active" : filter === "active" ? "done" : "all")}><Filter /></Button>
        </div>
        <div className="flex items-center justify-between px-3 py-2">
          <div className="min-w-0"><p className="truncate text-xs font-medium">{project?.name ?? "No project"}</p>{project && <p className="mt-0.5 flex items-center gap-1 truncate text-[10px] text-muted-foreground"><GitBranch className="size-3" />{project.defaultBranch}</p>}</div>
          <Button size="sm" variant="ghost" onClick={onNewTask} disabled={!project}><Plus /> Task</Button>
        </div>
        <ScrollArea className="min-h-0 flex-1 px-2 pb-3">
          {!project && <div className="px-3 py-12 text-center text-xs text-muted-foreground">Open a Git repository folder to create tasks.</div>}
          {project && tasks.isLoading && <div className="px-3 py-8 text-xs text-muted-foreground">Loading tasks…</div>}
          {active.length > 0 && <div className="mb-1 px-2 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">Active</div>}
          {active.map((task) => <TaskRow key={task.id} task={task} />)}
          {done.length > 0 && <div className="mb-1 mt-4 px-2 pb-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">Completed</div>}
          {done.map((task) => <TaskRow key={task.id} task={task} />)}
          {project && !tasks.isLoading && filtered.length === 0 && <div className="px-3 py-10 text-center text-xs text-muted-foreground">{search ? "No matching tasks" : "No tasks yet"}</div>}
        </ScrollArea>
      </div>
    </aside>
  );
}
