import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { App } from "@capacitor/app";
import { Browser } from "@capacitor/browser";
import { ArrowLeft, Bot, ChevronDown, ListChecks, ListTodo, LogOut, MessageSquarePlus, MessagesSquare, Plus, Search, Settings, UserRound } from "lucide-react";
import { ConnectionsManager, MachineSwitcher } from "@/components/machine-manager";
import { NewTaskDialog, ForcePasswordDialog } from "@/components/create-dialogs";
import { NewChatPanel, TaskPanel } from "@/components/panels/chat-panel";
import { CodexChatPanel } from "@/components/panels/codex-chat-panel";
import { PlanPanel } from "@/components/panels/plan-panel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useLiveEvents } from "@/hooks/use-live-events";
import { setToken } from "@/lib/api";
import { useBoostedApiClient } from "@/lib/api-context";
import { useAppStore } from "@/lib/store";
import { taskStatusMeta } from "@/lib/status";
import type { CodexChat, Project, Task } from "@/lib/types";
import { cn, relativeTime } from "@/lib/utils";

type MobileTab = "tasks" | "chats" | "more";
type TaskView = "conversation" | "plan";

function ProjectPicker({ projects }: { projects: Project[] }) {
  const selectedProjectId = useAppStore((state) => state.selectedProjectId);
  const selectProject = useAppStore((state) => state.selectProject);
  return (
    <label className="mobile-project-picker">
      <select value={selectedProjectId ?? ""} onChange={(event) => selectProject(projects.find((project) => project.id === event.target.value))} aria-label="Project">
        {projects.length === 0 && <option value="">No projects</option>}
        {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
      </select>
      <ChevronDown />
    </label>
  );
}

function MobileTaskRow({ task, open }: { task: Task; open: () => void }) {
  const meta = taskStatusMeta[task.status];
  const Icon = meta.icon;
  return (
    <button type="button" className="mobile-list-row" onClick={open}>
      <span className={cn("mobile-row-icon", meta.color)}><Icon className={cn(task.status === "running" && "animate-spin")} /></span>
      <span className="min-w-0 flex-1"><strong>{task.title}</strong><small><span>{meta.label}</span>{(task.additions > 0 || task.deletions > 0) && <><span className="text-success">+{task.additions}</span><span className="text-destructive">-{task.deletions}</span></>}<span>· {relativeTime(task.updatedAt)}</span></small></span>
    </button>
  );
}

function MobileTasks({ onCreate }: { onCreate: () => void }) {
  const api = useBoostedApiClient();
  const projectId = useAppStore((state) => state.selectedProjectId);
  const selectedTaskId = useAppStore((state) => state.selectedTaskId);
  const selectTask = useAppStore((state) => state.selectTask);
  const [search, setSearch] = useState("");
  const [taskView, setTaskView] = useState<TaskView>("conversation");
  const tasks = useQuery({ queryKey: ["tasks", projectId], queryFn: () => api.tasks(projectId), enabled: Boolean(projectId) });
  const selected = tasks.data?.find((task) => task.id === selectedTaskId);
  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return (tasks.data ?? []).filter((task) => !needle || task.title.toLowerCase().includes(needle) || task.description.toLowerCase().includes(needle));
  }, [search, tasks.data]);
  const active = filtered.filter((task) => task.status !== "done");
  const completed = filtered.filter((task) => task.status === "done");

  if (selected) {
    return (
      <section className="mobile-detail">
        <header className="mobile-detail-header"><Button variant="ghost" size="icon" aria-label="Back to tasks" onClick={() => selectTask(undefined)}><ArrowLeft /></Button><span className="min-w-0 flex-1"><strong className="block truncate text-sm">{selected.title}</strong><small className="capitalize text-muted-foreground">{taskStatusMeta[selected.status].label}</small></span></header>
        <nav className="mobile-segment"><button className={taskView === "conversation" ? "active" : ""} onClick={() => setTaskView("conversation")}><MessagesSquare />Conversation</button><button className={taskView === "plan" ? "active" : ""} onClick={() => setTaskView("plan")}><ListChecks />Plan</button></nav>
        <div className="mobile-panel-host">{taskView === "conversation" ? <TaskPanel /> : <PlanPanel />}</div>
      </section>
    );
  }

  return (
    <section className="mobile-list-page">
      <div className="mobile-page-actions"><div className="relative min-w-0 flex-1"><Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" /><Input className="h-10 pl-9" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search tasks" /></div><Button className="size-10" size="icon" disabled={!projectId} onClick={onCreate}><Plus /></Button></div>
      <div className="mobile-scroll-list">
        {!projectId && <div className="mobile-empty">Select an existing project to manage its tasks.</div>}
        {tasks.isLoading && <div className="mobile-empty">Loading tasks…</div>}
        {active.length > 0 && <p className="mobile-list-heading">Active</p>}
        {active.map((task) => <MobileTaskRow key={task.id} task={task} open={() => selectTask(task)} />)}
        {completed.length > 0 && <p className="mobile-list-heading">Completed</p>}
        {completed.map((task) => <MobileTaskRow key={task.id} task={task} open={() => selectTask(task)} />)}
        {projectId && !tasks.isLoading && filtered.length === 0 && <div className="mobile-empty">{search ? "No matching tasks." : "No tasks yet."}</div>}
      </div>
    </section>
  );
}

function MobileChatRow({ chat, open }: { chat: CodexChat; open: () => void }) {
  return <button type="button" className="mobile-list-row" onClick={open}><span className="mobile-row-icon text-primary"><Bot /></span><span className="min-w-0 flex-1"><strong>{chat.title}</strong><small><span className="truncate">{chat.preview || "Codex chat"}</span><span>· {relativeTime(chat.updatedAt)}</span></small></span></button>;
}

function MobileChats() {
  const api = useBoostedApiClient();
  const projectId = useAppStore((state) => state.selectedProjectId);
  const selectedChatId = useAppStore((state) => state.selectedCodexChatId);
  const selectCodexChat = useAppStore((state) => state.selectCodexChat);
  const projects = useQuery({ queryKey: ["projects"], queryFn: api.projects });
  const project = projects.data?.find((entry) => entry.id === projectId);
  const chats = useQuery({ queryKey: ["codex-chats", project?.repoPath], queryFn: () => api.codexChats(project!.repoPath), enabled: Boolean(project), refetchInterval: 15_000 });
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    const opened = (event: Event) => {
      const detail = (event as CustomEvent<{ threadId: string }>).detail;
      if (detail?.threadId) { selectCodexChat(detail.threadId); setCreating(false); }
    };
    window.addEventListener("boosted:open-codex-chat", opened);
    return () => window.removeEventListener("boosted:open-codex-chat", opened);
  }, [selectCodexChat]);

  if (selectedChatId) return <section className="mobile-detail"><header className="mobile-detail-header"><Button variant="ghost" size="icon" aria-label="Back to chats" onClick={() => selectCodexChat(undefined)}><ArrowLeft /></Button><strong className="min-w-0 flex-1 truncate text-sm">{chats.data?.find((chat) => chat.id === selectedChatId)?.title ?? "Codex chat"}</strong></header><div className="mobile-panel-host"><CodexChatPanel threadId={selectedChatId} /></div></section>;
  if (creating) return <section className="mobile-detail"><header className="mobile-detail-header"><Button variant="ghost" size="icon" aria-label="Back to chats" onClick={() => setCreating(false)}><ArrowLeft /></Button><strong className="text-sm">New Codex chat</strong></header><div className="mobile-panel-host"><NewChatPanel /></div></section>;

  return <section className="mobile-list-page"><div className="mobile-page-actions"><div><h1>Codex chats</h1><p>{project?.name ?? "Select a project"}</p></div><Button className="size-10" size="icon" disabled={!project} onClick={() => setCreating(true)}><MessageSquarePlus /></Button></div><div className="mobile-scroll-list">{chats.data?.map((chat) => <MobileChatRow key={chat.id} chat={chat} open={() => selectCodexChat(chat.id)} />)}{project && !chats.isLoading && chats.data?.length === 0 && <div className="mobile-empty">No chats yet.</div>}</div></section>;
}

function MobileMore() {
  const user = useAppStore((state) => state.user);
  return <section className="mobile-list-page"><div className="mobile-page-actions"><div><h1>Connections</h1><p>Manage this device’s Boosted machines.</p></div></div><div className="mobile-more-content"><div className="settings-card flex items-center gap-3"><span className="grid size-9 place-items-center rounded-full bg-secondary"><UserRound className="size-4" /></span><span className="min-w-0 flex-1"><strong className="block text-xs">{user?.username}</strong><small className="capitalize text-muted-foreground">{user?.role}</small></span><Button variant="ghost" size="sm" onClick={async () => { await setToken(); useAppStore.getState().setUser(undefined); }}><LogOut />Sign out</Button></div><ConnectionsManager embedded /></div></section>;
}

export function MobileShell() {
  const api = useBoostedApiClient();
  useLiveEvents();
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<MobileTab>("tasks");
  const [newTaskOpen, setNewTaskOpen] = useState(false);
  const projects = useQuery({ queryKey: ["projects"], queryFn: api.projects });
  const selectedProjectId = useAppStore((state) => state.selectedProjectId);
  const selectProject = useAppStore((state) => state.selectProject);

  useEffect(() => {
    if (!selectedProjectId && projects.data?.[0]) selectProject(projects.data[0]);
    else if (selectedProjectId && projects.data && !projects.data.some((project) => project.id === selectedProjectId)) selectProject(projects.data[0]);
  }, [projects.data, selectProject, selectedProjectId]);

  useEffect(() => {
    let backHandle: Awaited<ReturnType<typeof App.addListener>> | undefined;
    let stateHandle: Awaited<ReturnType<typeof App.addListener>> | undefined;
    void App.addListener("backButton", () => {
      const state = useAppStore.getState();
      if (newTaskOpen) setNewTaskOpen(false);
      else if (state.selectedTaskId) state.selectTask(undefined);
      else if (state.selectedCodexChatId) state.selectCodexChat(undefined);
      else if (tab !== "tasks") setTab("tasks");
      else void App.exitApp();
    }).then((handle) => { backHandle = handle; });
    void App.addListener("appStateChange", ({ isActive }) => {
      if (isActive) {
        void queryClient.invalidateQueries();
        window.dispatchEvent(new Event("boosted:resume"));
      }
    }).then((handle) => { stateHandle = handle; });
    const externalLink = (event: MouseEvent) => {
      const anchor = (event.target as Element | null)?.closest<HTMLAnchorElement>("a[href]");
      if (!anchor || !/^https?:/i.test(anchor.href)) return;
      event.preventDefault();
      void Browser.open({ url: anchor.href });
    };
    document.addEventListener("click", externalLink);
    return () => { void backHandle?.remove(); void stateHandle?.remove(); document.removeEventListener("click", externalLink); };
  }, [newTaskOpen, queryClient, tab]);

  return (
    <main className="mobile-shell">
      <header className="mobile-topbar"><MachineSwitcher /><ProjectPicker projects={projects.data ?? []} /></header>
      <div className="mobile-content">{tab === "tasks" && <MobileTasks onCreate={() => setNewTaskOpen(true)} />}{tab === "chats" && <MobileChats />}{tab === "more" && <MobileMore />}</div>
      <nav className="mobile-bottom-nav"><button className={tab === "tasks" ? "active" : ""} onClick={() => setTab("tasks")}><ListTodo />Tasks</button><button className={tab === "chats" ? "active" : ""} onClick={() => setTab("chats")}><MessagesSquare />Chats</button><button className={tab === "more" ? "active" : ""} onClick={() => setTab("more")}><Settings />More</button></nav>
      <NewTaskDialog open={newTaskOpen} onOpenChange={setNewTaskOpen} />
      <ForcePasswordDialog />
    </main>
  );
}
