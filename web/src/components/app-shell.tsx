import { lazy, Suspense, useCallback, useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Bot, ChevronDown, LogOut, MessagesSquare, Ellipsis, Files, GitBranch, Plus, Settings2, X } from "lucide-react";
import { openProvidersEvent } from "@/features/agents/events";
import { AgentAvatar } from "@/features/agents/components/session/agent-avatar";
import { apiClient } from "@/features/agents/lib/api-client";
import { Button } from "@/components/ui/button";
import { ProjectAvatar } from "@/components/project-avatar";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ForcePasswordDialog, NewTaskDialog, OpenProjectDialog } from "@/components/create-dialogs";
import type { SettingsSectionId } from "@/components/settings-page";
import { MachineSwitcher } from "@/components/machine-manager";
import { AttachmentPreviewLayout } from "@/components/attachment-preview-layout";
import { ProjectSettingsDialog } from "@/components/project-settings-dialog";
import { ProjectNavigation, type ProjectView } from "@/components/project-navigation";
import { ChatList } from "@/components/chat-list";
import { ProjectsPage, ScheduledPage } from "@/components/app-pages";
import { FilesPanel } from "@/components/panels/files-panel";
import { GitPanel } from "@/components/panels/git-panel";
import { NewChatPanel, TaskPanel } from "@/components/panels/chat-panel";
import { TaskboardPanel } from "@/components/panels/taskboard-panel";
import { EditorPanel } from "@/components/panels/editor-panel";
import { api, setToken } from "@/lib/api";
import { useBoostedApiClient } from "@/lib/api-context";
import { useLiveEvents } from "@/hooks/use-live-events";
import { useNotificationNavigation } from "@/hooks/use-notification-navigation";
import { useConversationReadState } from "@/hooks/use-conversation-read-state";
import { useCompactLayout, useMobileLayout } from "@/hooks/use-mobile-layout";
import { machinePreferenceKey, useAppStore } from "@/lib/store";
import { chatProject } from "@/lib/chat-project";
import { conversationQueryOptions } from "@/lib/query-client";
import { destinations, navigate, navigateSettings, backToSettings, settingsSectionFromHash, pageFromHash, type AppPage } from "@/lib/navigation";
import { formatUpdateProgress, useAppUpdateState } from "@/lib/updater";
import { isTauriRuntime } from "@/lib/runtime";

const SettingsPage = lazy(() => import("@/components/settings-page").then((m) => ({ default: m.SettingsPage })));
const CodexChatPanel = lazy(() => import("@/components/panels/codex-chat-panel").then((module) => ({ default: module.CodexChatPanel })));
const GroupPanel = lazy(() => import("@/features/groups/group-panel").then((module) => ({ default: module.GroupPanel })));
const AgentsPanel = lazy(() => import("@/features/agents/agents-panel").then((module) => ({ default: module.AgentsPanel })));
const tools = [
  { id: "files", label: "Files", icon: Files },
  { id: "git", label: "Changes", icon: GitBranch },
] as const;
type ContentView = "chat" | "task" | "editor" | "agents" | "group";
type ToolView = typeof tools[number]["id"];

const taskListWidthKey = "boosted.tasks.listWidth";
function savedTaskListWidth() {
  const width = Number(localStorage.getItem(machinePreferenceKey(taskListWidthKey)));
  return Number.isFinite(width) && width >= 24 && width <= 60 ? width : 38;
}

function TaskWorkspace({ taskId, detailOpen, onClose }: { taskId?: string; detailOpen: boolean; onClose(): void }) {
  const [listWidth, setListWidth] = useState(savedTaskListWidth);
  const listWidthRef = useRef(listWidth);
  const layout = useRef<HTMLDivElement>(null);
  const stopResizeRef = useRef<() => void>(() => undefined);
  useEffect(() => () => stopResizeRef.current(), []);

  function saveWidth(width: number) {
    try { localStorage.setItem(machinePreferenceKey(taskListWidthKey), String(width)); } catch { /* Resizing still works without browser storage. */ }
  }
  function updateWidth(width: number) {
    const next = Math.max(24, Math.min(60, Math.round(width * 10) / 10));
    listWidthRef.current = next;
    setListWidth(next);
  }
  function setWidthFromPointer(clientX: number) {
    const bounds = layout.current?.getBoundingClientRect();
    if (!bounds?.width) return;
    const minimumList = Math.min(280, bounds.width * .4);
    const minimumDetail = Math.min(440, bounds.width * .5);
    const pixels = Math.max(minimumList, Math.min(bounds.width - minimumDetail, clientX - bounds.left));
    updateWidth(pixels / bounds.width * 100);
  }
  function startResize(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    event.preventDefault();
    stopResizeRef.current();
    const cursor = document.body.style.cursor;
    const selection = document.body.style.userSelect;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    const move = (next: PointerEvent) => setWidthFromPointer(next.clientX);
    const stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
      document.body.style.cursor = cursor;
      document.body.style.userSelect = selection;
      saveWidth(listWidthRef.current);
      stopResizeRef.current = () => undefined;
    };
    stopResizeRef.current = stop;
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop, { once: true });
    window.addEventListener("pointercancel", stop, { once: true });
  }
  function resizeWithKeyboard(width: number) {
    updateWidth(width);
    saveWidth(Math.max(24, Math.min(60, Math.round(width * 10) / 10)));
  }

  const style = { "--task-list-width": `${listWidth}%` } as CSSProperties;
  return <div ref={layout} className="task-work-items-layout" data-detail={detailOpen} style={style}>
    <section className="task-work-items-list" aria-label="Task list"><TaskboardPanel detailOpen={detailOpen} /></section>
    {detailOpen && <div className="task-work-item-resizer" role="separator" aria-label="Resize task list" aria-orientation="vertical" aria-valuemin={24} aria-valuemax={60} aria-valuenow={Math.round(listWidth)} tabIndex={0} onPointerDown={startResize} onKeyDown={(event) => {
      if (event.key === "ArrowLeft") { event.preventDefault(); resizeWithKeyboard(listWidthRef.current - 2); }
      if (event.key === "ArrowRight") { event.preventDefault(); resizeWithKeyboard(listWidthRef.current + 2); }
      if (event.key === "Home") { event.preventDefault(); resizeWithKeyboard(24); }
      if (event.key === "End") { event.preventDefault(); resizeWithKeyboard(60); }
    }}><span /></div>}
    {detailOpen && taskId && <aside className="task-work-item-detail" aria-label="Task details"><TaskPanel key={taskId} onClose={onClose} /></aside>}
  </div>;
}

export function AppShell() {
  const queryClient = useQueryClient();
  const { profileId } = useBoostedApiClient();
  useLiveEvents();
  useNotificationNavigation();
  const appUpdate = useAppUpdateState();
  const hasNativeBranding = isTauriRuntime() && /Windows/i.test(navigator.userAgent);
  const [page, setPage] = useState(pageFromHash);
  const isMobile = useMobileLayout();
  const isCompact = useCompactLayout();
  const [mobileChatOpen, setMobileChatOpen] = useState(() => window.location.hash === "#home");
  const [settingsSection, setSettingsSection] = useState<SettingsSectionId | undefined>(settingsSectionFromHash);
  const previousPage = useRef<AppPage>("home");
  const previousMobileChatOpen = useRef(false);
  const [view, setView] = useState<ContentView>(() => useAppStore.getState().selectedGroupId ? "group" : "chat");
  const [groupHeaderTarget, setGroupHeaderTarget] = useState<HTMLDivElement | null>(null);
  const [projectView, setProjectView] = useState<ProjectView>("all");
  const [toolView, setToolView] = useState<ToolView>();
  const [selectedAgentId, setSelectedAgentId] = useState(() => localStorage.getItem(`boosted.selected-agent.${profileId}`) ?? "pock");
  const [projectDialogOpen, setProjectDialogOpen] = useState(false);
  const [projectSettingsOpen, setProjectSettingsOpen] = useState(false);
  const [newTaskDialogOpen, setNewTaskDialogOpen] = useState(false);
  const [createAgentOpen, setCreateAgentOpen] = useState(false);
  const projectId = useAppStore((state) => state.selectedProjectId);
  const groupId = useAppStore((state) => state.selectedGroupId);
  const chatId = useAppStore((state) => state.selectedCodexChatId);
  const taskId = useAppStore((state) => state.selectedTaskId);
  const setMobileChatsOpen = useAppStore((state) => state.setTaskDrawerOpen);
  const user = useAppStore((state) => state.user);
  const projects = useQuery({ queryKey: ["projects"], queryFn: api.projects });
  const agents = useQuery({ queryKey: ["agents"], queryFn: apiClient.assistant.list, refetchInterval: 5000 });
  const chats = useQuery({ queryKey: ["codex-chats", "all"], queryFn: () => api.codexChats(""), enabled: isMobile && page === "home" && view === "chat" && Boolean(chatId) });
  const activeThread = useQuery({ ...conversationQueryOptions, queryKey: ["codex-chat", chatId], queryFn: ({ signal }) => api.codexChat(chatId!, signal), enabled: Boolean(chatId) && view === "chat" });
  const selectedAgent = agents.data?.find((agent) => agent.id === selectedAgentId) ?? agents.data?.[0];
  const project = chatId && view === "chat" && page === "home"
    ? (activeThread.data ? chatProject(projects.data ?? [], activeThread.data.chat.cwd, activeThread.data.chat.projectId) : undefined)
    : projects.data?.find((entry) => entry.id === projectId);
  const current = destinations.find((entry) => entry.id === page)!;
  const toolsOpen = page === "home" && Boolean(toolView);
  const mobileChatsPage = isMobile && page === "home" && !mobileChatOpen;
  const mobileChatDetail = isMobile && page === "home" && mobileChatOpen;
  const chatSidebarVisible = page !== "settings" && !(page === "tasks" && isCompact);
  const contentLayoutKey = (page === "tasks" || (page === "projects" && projectView === "tasks")) && !isMobile
    ? `${profileId}:tasks:${projectId ?? "empty"}`
    : `${profileId}:${page}:${view}:${chatId}:${taskId}:${groupId}:${selectedAgentId}`;
  useConversationReadState((page === "home" && !mobileChatsPage) || (page === "projects" && projectView === "chat")
    ? view === "agents" && selectedAgent ? { kind: "agent", id: selectedAgent.id }
      : view === "group" && groupId ? { kind: "group", id: groupId }
        : view === "chat" && chatId ? { kind: "codex", id: chatId } : undefined
    : undefined);

  const goTo = useCallback((next: AppPage, section?: SettingsSectionId) => {
    if (page !== "settings") { previousPage.current = page; previousMobileChatOpen.current = mobileChatOpen; }
    setPage(next);
    setMobileChatOpen(next === "home");
    if (next === "settings") { setSettingsSection(section); navigateSettings(section); }
    else navigate(next);
    setMobileChatsOpen(false);
  }, [page, mobileChatOpen, setMobileChatsOpen]);
  const openChats = useCallback(() => {
    setPage("home");
    setMobileChatOpen(false);
    setToolView(undefined);
    setMobileChatsOpen(false);
    window.location.hash = "chats";
  }, [setMobileChatsOpen]);
  const newChat = useCallback(() => {
    useAppStore.getState().selectGroup(undefined);
    useAppStore.getState().selectCodexChat(undefined);
    useAppStore.getState().selectTask(undefined);
    setView("chat");
    goTo("home");
  }, [goTo]);
  const openProviderSettings = useCallback(() => { goTo("settings", "providers"); }, [goTo]);
  const selectAgent = useCallback((id: string) => {
    setSelectedAgentId(id);
    localStorage.setItem(`boosted.selected-agent.${profileId}`, id);
  }, [profileId]);
  const openAgent = useCallback((id: string) => {
    useAppStore.getState().selectGroup(undefined);
    selectAgent(id);
    setView("agents");
    setToolView(undefined);
    goTo("home");
  }, [selectAgent, goTo]);
  const createAgent = () => {
    useAppStore.getState().selectGroup(undefined);
    setView("agents");
    setToolView(undefined);
    goTo("home");
    setCreateAgentOpen(true);
  };

  useEffect(() => {
    setView(useAppStore.getState().selectedGroupId ? "group" : "chat");
    setProjectView("all");
  }, [profileId]);
  useEffect(() => {
    const open = (event: Event) => {
      const id = (event as CustomEvent<string>).detail;
      if (!id) return;
      useAppStore.getState().selectGroup(id); setView("group"); setToolView(undefined); goTo("home");
    };
    const deleted = () => { setView("chat"); setToolView(undefined); if (isMobile) openChats(); };
    window.addEventListener("boosted:group-deleted", deleted);
    window.addEventListener("boosted:open-group", open);
    return () => { window.removeEventListener("boosted:group-deleted", deleted); window.removeEventListener("boosted:open-group", open); };
  }, [goTo, isMobile, openChats]);

  useEffect(() => {
    const select = (event: Event) => {
      const id = (event as CustomEvent<string>).detail;
      if (id) openAgent(id);
    };
    window.addEventListener("boosted:select-agent", select);
    return () => window.removeEventListener("boosted:select-agent", select);
  }, [openAgent]);

  useEffect(() => {
    const openSettings = (event: Event) => {
      const section = (event as CustomEvent<SettingsSectionId>).detail;
      if (section === "workspace" || section === "codex") { setProjectSettingsOpen(true); return; }
      goTo("settings", section);
    };
    window.addEventListener(openProvidersEvent, openProviderSettings);
    window.addEventListener("boosted:open-settings", openSettings);
    return () => {
      window.removeEventListener(openProvidersEvent, openProviderSettings);
      window.removeEventListener("boosted:open-settings", openSettings);
    };
  }, [goTo, openProviderSettings]);

  useEffect(() => {
    if (!projects.data || chatId) return;
    if (!projectId || !projects.data.some((entry) => entry.id === projectId)) useAppStore.getState().selectProject(projects.data[0]);
  }, [chatId, projectId, projects.data]);

  useEffect(() => {
    if (!chatId || !activeThread.data || !projects.data) return;
    useAppStore.getState().syncCodexChatProject(chatId, chatProject(projects.data, activeThread.data.chat.cwd, activeThread.data.chat.projectId));
  }, [chatId, activeThread.data, projects.data]);

  useEffect(() => {
    const hashChange = () => { setSettingsSection(settingsSectionFromHash()); setPage(pageFromHash()); setMobileChatOpen(window.location.hash === "#home"); setMobileChatsOpen(false); };
    window.addEventListener("hashchange", hashChange);
    return () => window.removeEventListener("hashchange", hashChange);
  }, [setMobileChatsOpen]);

  useEffect(() => {
    function showContent(id: string, toggle = false) {
      const tool = tools.find((entry) => entry.id === id);
      if (tool) {
        if (page === "projects") {
          useAppStore.getState().selectTask(undefined); setView("chat");
          setProjectView((active) => toggle && active === tool.id ? "tasks" : tool.id);
        } else { setToolView((active) => toggle && active === tool.id ? undefined : tool.id); goTo("home"); }
        return;
      }
      if (id === "taskboard") { setView("chat"); if (page === "projects") setProjectView("tasks"); else goTo("tasks"); }
      else if (id === "task") { setView("task"); if (page === "projects") setProjectView("tasks"); else goTo("tasks"); }
      else if (id === "chat") {
        if (page === "projects") { useAppStore.getState().selectCodexChat(undefined); useAppStore.getState().selectTask(undefined); setView("chat"); setProjectView("chat"); }
        else newChat();
      }
      else if (id === "agents") { setView("agents"); goTo("home"); }
    }
    const open = (event: Event) => showContent((event as CustomEvent<string>).detail);
    const toggle = (event: Event) => showContent((event as CustomEvent<string>).detail, true);
    const openChat = (event: Event) => {
      const detail = (event as CustomEvent<{ threadId: string }>).detail;
      if (!detail?.threadId) return;
      useAppStore.getState().selectCodexChat(detail.threadId);
      setView("chat"); if (page === "projects") setProjectView("chat"); else goTo("home");
    };
    const openFile = () => { if (page === "projects") setProjectView("editor"); else { setView("editor"); goTo("home"); } };
    const openTask = () => setNewTaskDialogOpen(true);
    const openProject = () => setProjectDialogOpen(true);
    const showDrawer = (event: Event) => {
      if ((event as CustomEvent<string>).detail === "tasks") { setView("task"); goTo("tasks"); }
      else openChats();
    };
    const keyboard = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "n") { event.preventDefault(); showContent("chat"); }
      if (event.key === "Escape") { setMobileChatsOpen(false); setToolView(undefined); }
    };
    const listeners: [string, EventListener][] = [
      ["boosted:open-panel", open], ["boosted:toggle-panel", toggle], ["boosted:open-codex-chat", openChat],
      ["boosted:open-file", openFile], ["boosted:new-task", openTask], ["boosted:open-project", openProject], ["boosted:show-drawer", showDrawer],
      ["keydown", keyboard as EventListener],
    ];
    for (const [name, listener] of listeners) window.addEventListener(name, listener);
    return () => { for (const [name, listener] of listeners) window.removeEventListener(name, listener); };
  }, [page, goTo, newChat, openChats, setMobileChatsOpen]);

  async function logout() {
    try { await api.logout(); }
    catch { /* Allow local sign-out while disconnected. */ }
    finally { await setToken(); useAppStore.getState().setUser(undefined); queryClient.clear(); }
  }

  function selectProjectView(next: ProjectView) {
    if (next !== "tasks") useAppStore.getState().selectTask(undefined);
    setProjectView(next);
    setView("chat");
  }
  function openProjectWorkspace(entry: NonNullable<typeof project>) {
    useAppStore.getState().selectProject(entry);
    selectProjectView("tasks");
  }
  function newProjectChat() {
    useAppStore.getState().selectCodexChat(undefined);
    useAppStore.getState().selectTask(undefined);
    setView("chat"); setProjectView("chat");
  }

  const returnToTask = useMutation({
    mutationFn: (id: string) => queryClient.fetchQuery({ queryKey: ["task", id], queryFn: () => api.task(id) }),
    onSuccess: (task) => { useAppStore.getState().selectTask(task); setProjectView("tasks"); setView("task"); goTo("projects"); },
  });

  const navigation = destinations.map(({ id, label, icon: Icon }) => <Tooltip key={id}><TooltipTrigger asChild><button className="destination" aria-label={label} aria-current={page === id && !(id === "home" && view === "agents") ? "page" : undefined} onClick={() => { if (id === "home") setView(groupId ? "group" : "chat"); if (id === "tasks") setView("chat"); goTo(id); }}><Icon /><span>{label}</span></button></TooltipTrigger><TooltipContent side="left">{label}</TooltipContent></Tooltip>);

  return <main className="app-frame" data-page={page} data-mobile-chat-open={mobileChatDetail}>
    <header className="shell-titlebar" hidden={mobileChatDetail}>
      {!hasNativeBranding && <><img src="/favicon.svg" alt="" /><span>Boosted</span></>}
      {appUpdate.phase === "downloading" && <span className="shell-update">Updating{formatUpdateProgress(appUpdate) !== undefined ? ` ${formatUpdateProgress(appUpdate)}%` : "…"}</span>}
      <div className="shell-machine"><MachineSwitcher onManage={() => goTo("settings")} /></div>
    </header>
    <section className="content-surface" data-chat-sidebar={chatSidebarVisible} aria-label="Content">
    <section className="main-surface" hidden={mobileChatsPage} aria-label={`${page === "home" && view === "agents" ? "Agents" : mobileChatDetail ? "Chat" : current.label} page`}>
      <header className="main-surface-header" hidden={page === "settings"}>
        {mobileChatDetail && <Button variant="ghost" size="icon-sm" aria-label="Back to chats" onClick={openChats}><ArrowLeft /></Button>}
        {mobileChatDetail && view === "group" && groupId ? <div className="group-mobile-header-slot" ref={setGroupHeaderTarget} /> : page === "home" && view === "agents" ? <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild><button className="agent-switcher" aria-label="Switch agent" onMouseDown={(event) => event.preventDefault()}>
            {selectedAgent ? <AgentAvatar name={selectedAgent.profile.name} avatar={selectedAgent.profile.avatar} className="size-6 text-[10px]" /> : <Bot />}
            <span>{selectedAgent?.profile.name ?? "Agents"}</span><ChevronDown />
          </button></DropdownMenuTrigger>
          {/* WebKit otherwise searches the unselectable transcript for a caret on mouse down. */}
          <DropdownMenuContent align="start" onMouseDown={(event) => event.preventDefault()}><DropdownMenuLabel>Agents</DropdownMenuLabel>{agents.data?.map((agent) => <DropdownMenuItem key={agent.id} onSelect={() => openAgent(agent.id)}>
            <AgentAvatar name={agent.profile.name} avatar={agent.profile.avatar} className="size-6 text-[10px]" /><span>{agent.profile.name}</span>
          </DropdownMenuItem>)}</DropdownMenuContent>
        </DropdownMenu> : <span className="main-page-label">{mobileChatDetail ? (chats.data?.find((chat) => chat.id === chatId)?.title ?? "New chat") : current.label}</span>}
        {page === "home" && view !== "group" && <DropdownMenu><DropdownMenuTrigger asChild><Button variant="ghost" size="icon-sm" aria-label="Project tools"><Ellipsis /></Button></DropdownMenuTrigger><DropdownMenuContent align="start"><DropdownMenuLabel>Project tools</DropdownMenuLabel>{tools.map(({ id, label, icon: Icon }) => <DropdownMenuItem key={id} onClick={() => { setToolView(id); }}><Icon />{label}</DropdownMenuItem>)}</DropdownMenuContent></DropdownMenu>}
        <div className="main-header-actions">
          {view === "chat" && activeThread.data?.chat.taskId && (page === "home" || (page === "projects" && projectView === "chat")) && <Button variant="ghost" size="sm" onClick={() => returnToTask.mutate(activeThread.data!.chat.taskId!)} disabled={returnToTask.isPending}><ArrowLeft />Back to task</Button>}
          {project && !(page === "home" && (view === "agents" || view === "group")) && <><DropdownMenu><DropdownMenuTrigger asChild><button className="project-context"><ProjectAvatar project={project} /><span>{project.name}</span><ChevronDown /></button></DropdownMenuTrigger><DropdownMenuContent align="end"><DropdownMenuLabel>Project</DropdownMenuLabel>{projects.data?.map((entry) => <DropdownMenuItem key={entry.id} onClick={() => { useAppStore.getState().selectProject(entry); setView("chat"); if (page === "projects") setProjectView("tasks"); }}><ProjectAvatar project={entry} />{entry.name}</DropdownMenuItem>)}<DropdownMenuSeparator /><DropdownMenuItem onClick={() => setProjectDialogOpen(true)}><Plus />Open project</DropdownMenuItem></DropdownMenuContent></DropdownMenu><Tooltip><TooltipTrigger asChild><Button variant="ghost" size="icon-sm" aria-label="Project settings" onClick={() => setProjectSettingsOpen(true)}><Settings2 /></Button></TooltipTrigger><TooltipContent>Project settings</TooltipContent></Tooltip></>}
        </div>
      </header>
      {returnToTask.error && <p role="alert" className="px-4 py-2 text-xs text-destructive">{returnToTask.error.message}</p>}
      <div className="workspace-body" data-tools-open={toolsOpen}>
      {toolView && <aside className="workspace-tools immersive-panel" aria-label="Project tools panel" hidden={!toolsOpen}>
        <header className="workspace-tools-header"><nav aria-label="Project tool panels">{tools.map(({ id, label, icon: Icon }) => <Tooltip key={id}><TooltipTrigger asChild><Button variant="ghost" size="icon-sm" aria-label={label} aria-pressed={toolView === id} onClick={() => { setToolView(id); }}><Icon /></Button></TooltipTrigger><TooltipContent>{label}</TooltipContent></Tooltip>)}</nav><Button variant="ghost" size="icon-sm" aria-label="Close project tools" onClick={() => setToolView(undefined)}><X /></Button></header>
        <div className="workspace-tools-content"><Suspense fallback={<div className="empty-state">Loading…</div>}>
          {toolView === "files" && <FilesPanel key={projectId ?? "empty"} />}
          {toolView === "git" && <GitPanel key={projectId ?? "empty"} />}
        </Suspense></div>
      </aside>}
      {toolsOpen && <button className="mobile-tools-scrim" aria-label="Dismiss project tools" onClick={() => setToolView(undefined)} />}
      <div className="main-surface-content"><AttachmentPreviewLayout key={contentLayoutKey} alreadySplit={toolsOpen}><Suspense fallback={<div className="empty-state">Loading…</div>}>
        {page === "home" && !mobileChatsPage && (view === "editor" ? <div className="page-detail">
          <div className="page-detail-back"><Button variant="ghost" size="sm" onClick={() => setView("chat")}><ArrowLeft />Back to chat</Button></div>
          <EditorPanel />
        </div> : view === "group" && groupId ? <GroupPanel key={profileId + ":" + groupId} groupId={groupId} headerTarget={mobileChatDetail ? groupHeaderTarget : null} /> : view === "agents" ? <AgentsPanel selectedId={selectedAgentId} selectAgent={selectAgent} createAgentOpen={createAgentOpen} onCreateAgentOpenChange={setCreateAgentOpen} /> : chatId ? <CodexChatPanel key={chatId} threadId={chatId} /> : <NewChatPanel key={projectId ?? "empty"} />)}
        {page === "scheduled" && <ScheduledPage />}
        {page === "projects" && (projectView === "all" || !project ? <ProjectsPage onOpenProject={() => setProjectDialogOpen(true)} onSelect={() => selectProjectView("tasks")} /> : <div className="project-workspace">
          <nav className="project-workspace-tabs" aria-label="Project workspace"><Button variant="ghost" size="sm" onClick={() => selectProjectView("all")}><ArrowLeft />All projects</Button>
            {(["tasks", "files", "git"] as const).map((section) => <Button key={section} variant="ghost" size="sm" aria-pressed={projectView === section} onClick={() => selectProjectView(section)}>{section === "git" ? "Changes" : section === "tasks" ? "Tasks" : "Files"}</Button>)}
            <Button variant="ghost" size="sm" aria-pressed={projectView === "chat"} onClick={newProjectChat}><Plus />Chat</Button>
          </nav>
          <div className="project-workspace-content">
            {projectView === "tasks" && (isMobile && view === "task" && taskId ? <TaskPanel key={taskId} onClose={() => setView("chat")} /> : <TaskWorkspace taskId={taskId} detailOpen={view === "task" && Boolean(taskId)} onClose={() => setView("chat")} />)}
            {projectView === "chat" && (chatId ? <CodexChatPanel key={chatId} threadId={chatId} /> : <NewChatPanel key={projectId} />)}
            {projectView === "files" && <FilesPanel key={projectId} />}
            {projectView === "git" && <GitPanel key={projectId} />}
            {projectView === "editor" && <div className="page-detail"><div className="page-detail-back"><Button variant="ghost" size="sm" onClick={() => setProjectView("files")}><ArrowLeft />Back to files</Button></div><EditorPanel /></div>}
          </div>
        </div>)}
        {page === "tasks" && (isMobile && view === "task" && taskId
          ? <div className="page-detail"><div className="page-detail-back"><Button variant="ghost" size="sm" onClick={() => setView("chat")}><ArrowLeft />All tasks</Button></div><TaskPanel key={taskId} /></div>
          : <TaskWorkspace taskId={taskId} detailOpen={view === "task" && Boolean(taskId)} onClose={() => setView("chat")} />)}
        {page === "settings" && <SettingsPage section={settingsSection} onSectionChange={(section) => { setSettingsSection(section); navigateSettings(section); }} onBack={() => { setSettingsSection(undefined); backToSettings(); }} onClose={() => { if (isMobile && previousPage.current === "home" && !previousMobileChatOpen.current) openChats(); else goTo(previousPage.current); }} />}
      </Suspense></AttachmentPreviewLayout></div>
      </div>
    </section>
    {page !== "settings" && <aside className="right-navigation" hidden={!chatSidebarVisible || (isMobile && !mobileChatsPage)} aria-label="Navigation and chats">
      <h1 className="mobile-chats-heading">Chats</h1>
      {page === "projects" ? <ProjectNavigation view={projectView} onView={selectProjectView} onSelect={openProjectWorkspace} onOpenProject={() => setProjectDialogOpen(true)} onNewChat={newProjectChat} /> : <ChatList agents={agents.data ?? []} activeAgentId={page === "home" && view === "agents" ? selectedAgent?.id : undefined} activeGroupId={page === "home" && view === "group" ? groupId : undefined} activeChatId={page === "home" && view === "chat" ? chatId : undefined} onSelectAgent={openAgent} onCreateAgent={createAgent} onNewChat={newChat} onOpenProject={() => setProjectDialogOpen(true)} onClose={() => setMobileChatsOpen(false)} />}

    </aside>}
    </section>
    <div className="navigation-rail" hidden={isMobile}>
      <nav aria-label="Primary navigation">{navigation}</nav>
      <DropdownMenu><DropdownMenuTrigger asChild><button className="account-avatar" aria-label="Account menu">{user?.username.slice(0, 2).toUpperCase() ?? "B"}</button></DropdownMenuTrigger><DropdownMenuContent side="left" align="end"><DropdownMenuLabel>{user?.username ?? "Boosted"}</DropdownMenuLabel><DropdownMenuItem onClick={() => goTo("settings")}>Settings</DropdownMenuItem><DropdownMenuSeparator /><DropdownMenuItem onClick={() => void logout()}><LogOut />Sign out</DropdownMenuItem></DropdownMenuContent></DropdownMenu>
    </div>
    <nav className="mobile-page-navigation" aria-label="Mobile navigation" hidden={mobileChatDetail}>
      {destinations.map(({ id, label, icon }) => {
        const Icon = id === "home" ? MessagesSquare : icon;
        const mobileLabel = id === "home" ? "Chats" : label;
        return <button key={id} className="destination" aria-label={mobileLabel} aria-current={page === id ? "page" : undefined} onClick={() => { if (id === "home") openChats(); else { if (id === "tasks") setView("chat"); goTo(id); } }}><Icon /><span>{mobileLabel}</span></button>;
      })}
    </nav>
    <OpenProjectDialog open={projectDialogOpen} onOpenChange={setProjectDialogOpen} />
    <ProjectSettingsDialog project={project} open={projectSettingsOpen} onOpenChange={setProjectSettingsOpen} />
    <NewTaskDialog open={newTaskDialogOpen} onOpenChange={setNewTaskDialogOpen} />
    <ForcePasswordDialog />
  </main>;
}
