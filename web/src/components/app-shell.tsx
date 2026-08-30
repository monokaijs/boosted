import { type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Files, Folder, FolderOpen, GitBranch, GitCommitHorizontal, KanbanSquare, ListTodo, LogOut, MessagesSquare, Settings, TerminalSquare } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ForcePasswordDialog, NewTaskDialog, OpenProjectDialog } from "@/components/create-dialogs";
import { SettingsDialog } from "@/components/settings-dialog";
import { TaskDrawer } from "@/components/task-drawer";
import { CodexChatsDrawer } from "@/components/codex-chats-drawer";
import { ConnectionsDialog, MachineSwitcher } from "@/components/machine-manager";
import { Workspace } from "@/components/workspace";
import { api, setToken } from "@/lib/api";
import { useLiveEvents } from "@/hooks/use-live-events";
import { useNotificationNavigation } from "@/hooks/use-notification-navigation";
import { useAppStore } from "@/lib/store";
import { formatUpdateProgress, useAppUpdateState } from "@/lib/updater";
import { cn } from "@/lib/utils";

const railPanels = [
  { id: "taskboard", label: "Taskboard", icon: KanbanSquare },
  { id: "files", label: "Files", icon: Files },
  { id: "git", label: "Git changes", icon: GitBranch },
  { id: "history", label: "Git history", icon: GitCommitHorizontal },
  { id: "terminal", label: "Terminal", icon: TerminalSquare },
] as const;

const defaultDrawerWidth = 292;
const minimumDrawerWidth = 220;
const maximumDrawerWidth = 520;
const drawerWidthKey = "boosted.drawer.width";

function clampDrawerWidth(width: number) {
  const viewportLimit = typeof window === "undefined" ? maximumDrawerWidth : Math.floor(window.innerWidth * 0.48);
  return Math.max(minimumDrawerWidth, Math.min(maximumDrawerWidth, viewportLimit, Math.round(width)));
}

function initialDrawerWidth() {
  if (typeof window === "undefined") return defaultDrawerWidth;
  const saved = Number.parseInt(localStorage.getItem(drawerWidthKey) ?? "", 10);
  return Number.isFinite(saved) ? clampDrawerWidth(saved) : defaultDrawerWidth;
}

function openPanel(id: string) {
  window.dispatchEvent(new CustomEvent("boosted:open-panel", { detail: id }));
}

export function AppShell() {
  useLiveEvents();
  useNotificationNavigation();
  const appUpdate = useAppUpdateState();
  const [drawerView, setDrawerView] = useState<"tasks" | "chats">("tasks");
  const [drawerWidth, setDrawerWidth] = useState(initialDrawerWidth);
  const [drawerResizing, setDrawerResizing] = useState(false);
  const drawerResizeRef = useRef<{ pointerId: number; startX: number; startWidth: number } | null>(null);
  const [projectDialogOpen, setProjectDialogOpen] = useState(false);
  const [newTaskDialogOpen, setNewTaskDialogOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [connectionsOpen, setConnectionsOpen] = useState(false);
  const selectedProjectId = useAppStore((state) => state.selectedProjectId);
  const selectedTaskId = useAppStore((state) => state.selectedTaskId);
  const drawerOpen = useAppStore((state) => state.taskDrawerOpen);
  const setDrawerOpen = useAppStore((state) => state.setTaskDrawerOpen);
  const selectProject = useAppStore((state) => state.selectProject);
  const selectTask = useAppStore((state) => state.selectTask);
  const projects = useQuery({ queryKey: ["projects"], queryFn: api.projects });
  const tasks = useQuery({ queryKey: ["tasks", selectedProjectId], queryFn: () => api.tasks(selectedProjectId), enabled: Boolean(selectedProjectId) });
  const selectedTask = tasks.data?.find((task) => task.id === selectedTaskId);

  useEffect(() => {
    if (!selectedProjectId && projects.data?.[0]) selectProject(projects.data[0]);
    else if (selectedProjectId && projects.data && !projects.data.some((project) => project.id === selectedProjectId)) selectProject(projects.data[0]);
  }, [projects.data, selectProject, selectedProjectId]);

  useEffect(() => {
    if (selectedTaskId && tasks.data && !tasks.data.some((task) => task.id === selectedTaskId)) selectTask(undefined);
  }, [selectTask, selectedTaskId, tasks.data]);

  useEffect(() => {
    const openNewTask = () => setNewTaskDialogOpen(true);
    const openProject = () => setProjectDialogOpen(true);
    const showDrawer = (event: Event) => {
      const view = (event as CustomEvent<"tasks" | "chats">).detail;
      if (view === "tasks" || view === "chats") {
        setDrawerView(view);
        setDrawerOpen(true);
      }
    };
    window.addEventListener("boosted:new-task", openNewTask);
    window.addEventListener("boosted:open-project", openProject);
    window.addEventListener("boosted:show-drawer", showDrawer);
    return () => {
      window.removeEventListener("boosted:new-task", openNewTask);
      window.removeEventListener("boosted:open-project", openProject);
      window.removeEventListener("boosted:show-drawer", showDrawer);
    };
  }, [setDrawerOpen]);

  useEffect(() => {
    localStorage.setItem(drawerWidthKey, String(drawerWidth));
  }, [drawerWidth]);

  function startNewTask() {
    setNewTaskDialogOpen(true);
  }

  function toggleDrawer(view: "tasks" | "chats") {
    if (drawerOpen && drawerView === view) {
      setDrawerOpen(false);
      return;
    }
    setDrawerView(view);
    setDrawerOpen(true);
  }

  async function logout() {
    await setToken();
    useAppStore.getState().setUser(undefined);
  }

  function startDrawerResize(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    event.preventDefault();
    drawerResizeRef.current = { pointerId: event.pointerId, startX: event.clientX, startWidth: drawerWidth };
    event.currentTarget.setPointerCapture(event.pointerId);
    setDrawerResizing(true);
  }

  function resizeDrawer(event: ReactPointerEvent<HTMLDivElement>) {
    const resize = drawerResizeRef.current;
    if (!resize || resize.pointerId !== event.pointerId) return;
    setDrawerWidth(clampDrawerWidth(resize.startWidth + event.clientX - resize.startX));
  }

  function finishDrawerResize(event: ReactPointerEvent<HTMLDivElement>) {
    if (drawerResizeRef.current?.pointerId !== event.pointerId) return;
    drawerResizeRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    setDrawerResizing(false);
  }

  function resizeDrawerWithKeyboard(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight" && event.key !== "Home") return;
    event.preventDefault();
    if (event.key === "Home") {
      setDrawerWidth(defaultDrawerWidth);
      return;
    }
    const direction = event.key === "ArrowLeft" ? -1 : 1;
    setDrawerWidth((width) => clampDrawerWidth(width + direction * (event.shiftKey ? 48 : 16)));
  }

  return (
    <main
      className="app-shell"
      data-drawer={drawerOpen ? "open" : "closed"}
      data-drawer-resizing={drawerResizing ? "true" : "false"}
      style={{ "--drawer-width": `${drawerWidth}px` } as CSSProperties}
    >
      <header className="app-topbar">
        <div className="app-brand flex h-full w-12 items-center justify-center"><img src="/favicon.svg" alt="Boosted" className="size-6" /></div>
        <MachineSwitcher onManage={() => setConnectionsOpen(true)} />
        <div className="app-machine-divider mx-1 h-4 w-px bg-border" />
        <div className="app-drawer-switchers ml-1 flex items-center gap-0.5">
          <Button className={cn(drawerOpen && drawerView === "tasks" && "bg-accent")} variant="ghost" size="icon-sm" title="Tasks" aria-label="Tasks" aria-pressed={drawerOpen && drawerView === "tasks"} onClick={() => toggleDrawer("tasks")}><ListTodo /></Button>
          <Button className={cn(drawerOpen && drawerView === "chats" && "bg-accent")} variant="ghost" size="icon-sm" title="Codex chats" aria-label="Codex chats" aria-pressed={drawerOpen && drawerView === "chats"} onClick={() => toggleDrawer("chats")}><MessagesSquare /></Button>
        </div>
        <div className="app-project-divider mx-2 h-4 w-px bg-border" />
        <div className="app-workspace-tabs" role="tablist" aria-label="Open workspaces">
          {!projects.data?.length && <span className="app-no-workspace">No workspace</span>}
          {projects.data?.map((project) => (
            <button
              type="button"
              key={project.id}
              className={cn("app-workspace-tab", selectedProjectId === project.id && "app-workspace-tab-active")}
              role="tab"
              aria-selected={selectedProjectId === project.id}
              title={project.repoPath}
              onClick={() => selectProject(project)}
            >
              <Folder />
              <span>{project.name}</span>
            </button>
          ))}
        </div>
        <Button className="app-open-project" variant="ghost" size="icon-sm" title="Open project folder" onClick={() => setProjectDialogOpen(true)}><FolderOpen /></Button>
        {selectedTask && <span className="app-selected-task min-w-0"><span className="mx-2 text-muted-foreground">/</span><span className="inline-block max-w-[38vw] truncate align-middle text-xs text-muted-foreground">{selectedTask.title}</span></span>}
        <div className="app-actions ml-auto flex items-center gap-1 pr-2">
          {["downloading", "installing", "restarting"].includes(appUpdate.phase) && <button type="button" className="flex items-center gap-1.5 rounded-md px-2 py-1 text-[10px] text-muted-foreground hover:bg-accent" onClick={() => setSettingsOpen(true)}><span className="size-3 animate-spin rounded-full border-2 border-current border-r-transparent" />{appUpdate.phase === "downloading" ? `Updating${formatUpdateProgress(appUpdate) !== undefined ? ` ${formatUpdateProgress(appUpdate)}%` : ""}` : appUpdate.phase === "installing" ? "Installing update" : "Restarting"}</button>}
          <Button variant="ghost" size="icon-sm" title="Settings" onClick={() => setSettingsOpen(true)}><Settings /></Button>
          <Button variant="ghost" size="icon-sm" onClick={() => void logout()} title="Sign out of this machine"><LogOut /></Button>
        </div>
      </header>

      <nav className="app-rail" aria-label="Workspace panels">
        {railPanels.map(({ id, label, icon: Icon }) => (
          <Tooltip key={id}><TooltipTrigger asChild><Button variant="ghost" size="icon" aria-label={label} onClick={() => openPanel(id)}><Icon /></Button></TooltipTrigger><TooltipContent side="left">{label}</TooltipContent></Tooltip>
        ))}
        <div className="mt-auto">
          <Tooltip><TooltipTrigger asChild><Button variant="ghost" size="icon" aria-label="Open project folder" onClick={() => setProjectDialogOpen(true)}><FolderOpen /></Button></TooltipTrigger><TooltipContent side="left">Open project folder</TooltipContent></Tooltip>
        </div>
      </nav>

      {drawerOpen && <button type="button" className="app-drawer-scrim" aria-label="Close tasks and chats panel" onClick={() => setDrawerOpen(false)} />}
      {drawerView === "tasks" ? <TaskDrawer onNewTask={startNewTask} /> : <CodexChatsDrawer />}
      {drawerOpen && (
        <div
          className="drawer-resize-handle"
          role="separator"
          aria-label="Resize tasks and chats panel"
          aria-orientation="vertical"
          aria-valuemin={minimumDrawerWidth}
          aria-valuemax={maximumDrawerWidth}
          aria-valuenow={drawerWidth}
          tabIndex={0}
          title="Drag to resize · Double-click to reset"
          onDoubleClick={() => setDrawerWidth(defaultDrawerWidth)}
          onKeyDown={resizeDrawerWithKeyboard}
          onPointerDown={startDrawerResize}
          onPointerMove={resizeDrawer}
          onPointerUp={finishDrawerResize}
          onPointerCancel={finishDrawerResize}
        />
      )}
      <section className="workspace"><Workspace key={selectedProjectId ?? "empty"} workspaceId={selectedProjectId ?? "empty"} /></section>

      <OpenProjectDialog open={projectDialogOpen} onOpenChange={setProjectDialogOpen} />
      <NewTaskDialog open={newTaskDialogOpen} onOpenChange={setNewTaskDialogOpen} />
      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
      <ConnectionsDialog open={connectionsOpen} onOpenChange={setConnectionsOpen} />
      <ForcePasswordDialog />
    </main>
  );
}
