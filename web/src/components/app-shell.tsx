import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Bot, ChevronDown, FolderOpen, LogOut, MessagesSquare, Ellipsis, Files, GitBranch, Plus, X } from "lucide-react";
import { openProvidersEvent } from "@/features/agents/events";
import { AgentAvatar } from "@/features/agents/components/session/agent-avatar";
import { apiClient } from "@/features/agents/lib/api-client";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ForcePasswordDialog, NewTaskDialog, OpenProjectDialog } from "@/components/create-dialogs";
import type { SettingsSectionId } from "@/components/settings-page";
import { MachineSwitcher } from "@/components/machine-manager";
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
import { useMobileLayout } from "@/hooks/use-mobile-layout";
import { useAppStore } from "@/lib/store";
import { destinations, navigate, pageFromHash, type AppPage } from "@/lib/navigation";
import { formatUpdateProgress, useAppUpdateState } from "@/lib/updater";

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

export function AppShell() {
  const queryClient = useQueryClient();
  const { profileId } = useBoostedApiClient();
  useLiveEvents();
  useNotificationNavigation();
  const appUpdate = useAppUpdateState();
  const [page, setPage] = useState(pageFromHash);
  const isMobile = useMobileLayout();
  const [mobileChatOpen, setMobileChatOpen] = useState(() => window.location.hash === "#home");
  const [settingsSection, setSettingsSection] = useState<SettingsSectionId>(() => window.location.hash === "#usage" ? "usage" : "connections");
  const previousPage = useRef<AppPage>("home");
  const previousMobileChatOpen = useRef(false);
  const [view, setView] = useState<ContentView>(() => useAppStore.getState().selectedGroupId ? "group" : "chat");
  const [groupHeaderTarget, setGroupHeaderTarget] = useState<HTMLDivElement | null>(null);
  const [toolView, setToolView] = useState<ToolView>();
  const [selectedAgentId, setSelectedAgentId] = useState(() => localStorage.getItem(`boosted.selected-agent.${profileId}`) ?? "pock");
  const [projectDialogOpen, setProjectDialogOpen] = useState(false);
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
  const selectedAgent = agents.data?.find((agent) => agent.id === selectedAgentId) ?? agents.data?.[0];
  const project = projects.data?.find((entry) => entry.id === projectId);
  const current = destinations.find((entry) => entry.id === page)!;
  const toolsOpen = page === "home" && Boolean(toolView);
  const mobileChatsPage = isMobile && page === "home" && !mobileChatOpen;
  const mobileChatDetail = isMobile && page === "home" && mobileChatOpen;

  const goTo = useCallback((next: AppPage) => {
    if (page !== "settings") { previousPage.current = page; previousMobileChatOpen.current = mobileChatOpen; }
    setPage(next);
    setMobileChatOpen(next === "home");
    navigate(next);
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
  const openProviderSettings = useCallback(() => { setSettingsSection("providers"); goTo("settings"); }, [goTo]);
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
      if (section) setSettingsSection(section);
      goTo("settings");
    };
    window.addEventListener(openProvidersEvent, openProviderSettings);
    window.addEventListener("boosted:open-settings", openSettings);
    return () => {
      window.removeEventListener(openProvidersEvent, openProviderSettings);
      window.removeEventListener("boosted:open-settings", openSettings);
    };
  }, [goTo, openProviderSettings]);

  useEffect(() => {
    if (!projects.data) return;
    if (!projectId || !projects.data.some((entry) => entry.id === projectId)) useAppStore.getState().selectProject(projects.data[0]);
  }, [projectId, projects.data]);

  useEffect(() => {
    const hashChange = () => { if (window.location.hash === "#usage") setSettingsSection("usage"); setPage(pageFromHash()); setMobileChatOpen(window.location.hash === "#home"); setMobileChatsOpen(false); };
    window.addEventListener("hashchange", hashChange);
    return () => window.removeEventListener("hashchange", hashChange);
  }, [setMobileChatsOpen]);

  useEffect(() => {
    function showContent(id: string, toggle = false) {
      const tool = tools.find((entry) => entry.id === id);
      if (tool) { setToolView((active) => toggle && active === tool.id ? undefined : tool.id); goTo("home"); return; }
      if (id === "taskboard") { setView("chat"); goTo("tasks"); }
      else if (id === "task") { setView("task"); goTo("tasks"); }
      else if (id === "chat") newChat();
      else if (id === "agents") { setView("agents"); goTo("home"); }
    }
    const open = (event: Event) => showContent((event as CustomEvent<string>).detail);
    const toggle = (event: Event) => showContent((event as CustomEvent<string>).detail, true);
    const openChat = (event: Event) => {
      const detail = (event as CustomEvent<{ threadId: string }>).detail;
      if (!detail?.threadId) return;
      useAppStore.getState().selectCodexChat(detail.threadId);
      setView("chat"); goTo("home");
    };
    const openFile = () => { setView("editor"); goTo("home"); };
    const openTask = () => setNewTaskDialogOpen(true);
    const openProject = () => setProjectDialogOpen(true);
    const showDrawer = (event: Event) => {
      if ((event as CustomEvent<string>).detail === "tasks") { setView("task"); goTo("tasks"); }
      else openChats();
    };
    const keyboard = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "n") { event.preventDefault(); newChat(); }
      if (event.key === "Escape") { setMobileChatsOpen(false); setToolView(undefined); }
    };
    const listeners: [string, EventListener][] = [
      ["boosted:open-panel", open], ["boosted:toggle-panel", toggle], ["boosted:open-codex-chat", openChat],
      ["boosted:open-file", openFile], ["boosted:new-task", openTask], ["boosted:open-project", openProject], ["boosted:show-drawer", showDrawer],
      ["keydown", keyboard as EventListener],
    ];
    for (const [name, listener] of listeners) window.addEventListener(name, listener);
    return () => { for (const [name, listener] of listeners) window.removeEventListener(name, listener); };
  }, [goTo, newChat, openChats, setMobileChatsOpen]);

  async function logout() {
    try { await api.logout(); }
    catch { /* Allow local sign-out while disconnected. */ }
    finally { await setToken(); useAppStore.getState().setUser(undefined); queryClient.clear(); }
  }

  const navigation = destinations.map(({ id, label, icon: Icon }) => <Tooltip key={id}><TooltipTrigger asChild><button className="destination" aria-label={label} aria-current={page === id && !(id === "home" && view === "agents") ? "page" : undefined} onClick={() => { if (id === "home") setView(groupId ? "group" : "chat"); if (id === "tasks") setView("chat"); goTo(id); }}><Icon /><span>{label}</span></button></TooltipTrigger><TooltipContent side="left">{label}</TooltipContent></Tooltip>);

  return <main className="app-frame" data-page={page} data-mobile-chat-open={mobileChatDetail}>
    <header className="shell-titlebar" hidden={mobileChatDetail}><img src="/favicon.svg" alt="" /><span>Boosted</span><span className="shell-titlebar-section">{current.label}</span>{appUpdate.phase === "downloading" && <span className="shell-update">Updating{formatUpdateProgress(appUpdate) !== undefined ? ` ${formatUpdateProgress(appUpdate)}%` : "…"}</span>}<div className="shell-machine"><MachineSwitcher onManage={() => goTo("settings")} /></div></header>
    <section className="content-surface" aria-label="Content">
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
          {project && !(page === "home" && (view === "agents" || view === "group")) && <DropdownMenu><DropdownMenuTrigger asChild><button className="project-context"><FolderOpen /><span>{project.name}</span><ChevronDown /></button></DropdownMenuTrigger><DropdownMenuContent align="end"><DropdownMenuLabel>Project</DropdownMenuLabel>{projects.data?.map((entry) => <DropdownMenuItem key={entry.id} onClick={() => { useAppStore.getState().selectProject(entry); setView("chat"); }}><FolderOpen />{entry.name}</DropdownMenuItem>)}<DropdownMenuSeparator /><DropdownMenuItem onClick={() => setProjectDialogOpen(true)}><Plus />Open project</DropdownMenuItem></DropdownMenuContent></DropdownMenu>}
        </div>
      </header>
      <div className="workspace-body" data-tools-open={toolsOpen}>
      {toolView && <aside className="workspace-tools immersive-panel" aria-label="Project tools panel" hidden={!toolsOpen}>
        <header className="workspace-tools-header"><nav aria-label="Project tool panels">{tools.map(({ id, label, icon: Icon }) => <Tooltip key={id}><TooltipTrigger asChild><Button variant="ghost" size="icon-sm" aria-label={label} aria-pressed={toolView === id} onClick={() => { setToolView(id); }}><Icon /></Button></TooltipTrigger><TooltipContent>{label}</TooltipContent></Tooltip>)}</nav><Button variant="ghost" size="icon-sm" aria-label="Close project tools" onClick={() => setToolView(undefined)}><X /></Button></header>
        <div className="workspace-tools-content"><Suspense fallback={<div className="empty-state">Loading…</div>}>
          {toolView === "files" && <FilesPanel key={projectId ?? "empty"} />}
          {toolView === "git" && <GitPanel key={taskId ?? "empty"} />}
        </Suspense></div>
      </aside>}
      {toolsOpen && <button className="mobile-tools-scrim" aria-label="Dismiss project tools" onClick={() => setToolView(undefined)} />}
      <div className="main-surface-content"><Suspense fallback={<div className="empty-state">Loading…</div>}>
        {page === "home" && !mobileChatsPage && (view === "editor" ? <div className="page-detail">
          <div className="page-detail-back"><Button variant="ghost" size="sm" onClick={() => setView("chat")}><ArrowLeft />Back to chat</Button></div>
          <EditorPanel />
        </div> : view === "group" && groupId ? <GroupPanel key={profileId + ":" + groupId} groupId={groupId} headerTarget={mobileChatDetail ? groupHeaderTarget : null} /> : view === "agents" ? <AgentsPanel selectedId={selectedAgentId} selectAgent={selectAgent} createAgentOpen={createAgentOpen} onCreateAgentOpenChange={setCreateAgentOpen} /> : chatId ? <CodexChatPanel key={chatId} threadId={chatId} /> : <NewChatPanel key={projectId ?? "empty"} />)}
        {page === "scheduled" && <ScheduledPage />}
        {page === "projects" && <ProjectsPage onOpenProject={() => setProjectDialogOpen(true)} onSelect={newChat} />}
        {page === "tasks" && (view === "task" && taskId ? <div className="page-detail"><div className="page-detail-back"><Button variant="ghost" size="sm" onClick={() => setView("chat")}><ArrowLeft />All tasks</Button></div><TaskPanel key={taskId} /></div> : <TaskboardPanel />)}
        {page === "settings" && <SettingsPage section={settingsSection} onSectionChange={setSettingsSection} onClose={() => { if (isMobile && previousPage.current === "home" && !previousMobileChatOpen.current) openChats(); else goTo(previousPage.current); }} />}
      </Suspense></div>
      </div>
    </section>
    {page !== "settings" && <aside className="right-navigation" hidden={isMobile && !mobileChatsPage} aria-label="Navigation and chats">
      <h1 className="mobile-chats-heading">Chats</h1>
      <ChatList agents={agents.data ?? []} activeAgentId={page === "home" && view === "agents" ? selectedAgent?.id : undefined} activeGroupId={page === "home" && view === "group" ? groupId : undefined} activeChatId={page === "home" && view === "chat" ? chatId : undefined} onSelectAgent={openAgent} onCreateAgent={createAgent} onNewChat={newChat} onOpenProject={() => setProjectDialogOpen(true)} onClose={() => setMobileChatsOpen(false)} />

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
    <NewTaskDialog open={newTaskDialogOpen} onOpenChange={setNewTaskDialogOpen} />
    <ForcePasswordDialog />
  </main>;
}
