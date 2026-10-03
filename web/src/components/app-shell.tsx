import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, Bot, ChevronDown, FolderOpen, LogOut, MessagesSquare, Ellipsis, Files, GitBranch, Plus, X } from "lucide-react";
import { openProvidersEvent } from "@/features/agents/agents-panel";
import { AgentAvatar } from "@/features/agents/components/session/agent-avatar";
import { apiClient } from "@/features/agents/lib/api-client";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ForcePasswordDialog, NewTaskDialog, OpenProjectDialog } from "@/components/create-dialogs";
import { SettingsPage, type SettingsSectionId } from "@/components/settings-page";
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
import { useAppStore } from "@/lib/store";
import { destinations, navigate, pageFromHash, type AppPage } from "@/lib/navigation";
import { formatUpdateProgress, useAppUpdateState } from "@/lib/updater";

const CodexChatPanel = lazy(() => import("@/components/panels/codex-chat-panel").then((module) => ({ default: module.CodexChatPanel })));
const AgentsPanel = lazy(() => import("@/features/agents/agents-panel").then((module) => ({ default: module.AgentsPanel })));
const tools = [
  { id: "files", label: "Files", icon: Files },
  { id: "git", label: "Changes", icon: GitBranch },
] as const;
type ContentView = "chat" | "task" | "editor" | "agents";
type ToolView = typeof tools[number]["id"];

export function AppShell() {
  const { profileId } = useBoostedApiClient();
  useLiveEvents();
  useNotificationNavigation();
  const appUpdate = useAppUpdateState();
  const [page, setPage] = useState(pageFromHash);
  const [settingsSection, setSettingsSection] = useState<SettingsSectionId>("connections");
  const previousPage = useRef<AppPage>("home");
  const [view, setView] = useState<ContentView>("chat");
  const [toolView, setToolView] = useState<ToolView>();
  const [selectedAgentId, setSelectedAgentId] = useState(() => localStorage.getItem(`boosted.selected-agent.${profileId}`) ?? "pock");
  const [projectDialogOpen, setProjectDialogOpen] = useState(false);
  const [newTaskDialogOpen, setNewTaskDialogOpen] = useState(false);
  const projectId = useAppStore((state) => state.selectedProjectId);
  const chatId = useAppStore((state) => state.selectedCodexChatId);
  const taskId = useAppStore((state) => state.selectedTaskId);
  const mobileChatsOpen = useAppStore((state) => state.taskDrawerOpen);
  const setMobileChatsOpen = useAppStore((state) => state.setTaskDrawerOpen);
  const user = useAppStore((state) => state.user);
  const projects = useQuery({ queryKey: ["projects"], queryFn: api.projects });
  const agents = useQuery({ queryKey: ["agents"], queryFn: apiClient.assistant.list, refetchInterval: 5000 });
  const selectedAgent = agents.data?.find((agent) => agent.id === selectedAgentId) ?? agents.data?.[0];
  const project = projects.data?.find((entry) => entry.id === projectId);
  const current = destinations.find((entry) => entry.id === page)!;
  const toolsOpen = page === "home" && Boolean(toolView);

  const goTo = useCallback((next: AppPage) => { if (page !== "settings") previousPage.current = page; setPage(next); navigate(next); setMobileChatsOpen(false); }, [page, setMobileChatsOpen]);
  const newChat = useCallback(() => {
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
    selectAgent(id);
    setView("agents");
    setToolView(undefined);
    goTo("home");
  }, [selectAgent, goTo]);

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
    const hashChange = () => { setPage(pageFromHash()); setMobileChatsOpen(false); };
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
      else setMobileChatsOpen(true);
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
  }, [goTo, newChat, setMobileChatsOpen]);

  async function logout() {
    try { await api.logout(); }
    catch { /* Allow local sign-out while disconnected. */ }
    finally { await setToken(); useAppStore.getState().setUser(undefined); }
  }

  const navigation = destinations.map(({ id, label, icon: Icon }) => <Tooltip key={id}><TooltipTrigger asChild><button className="destination" aria-label={label} aria-current={page === id && !(id === "home" && view === "agents") ? "page" : undefined} onClick={() => { if (id === "home") setView("chat"); if (id === "tasks") setView("chat"); goTo(id); }}><Icon /><span>{label}</span></button></TooltipTrigger><TooltipContent side="left">{label}</TooltipContent></Tooltip>);

  return <main className="app-frame" data-page={page} data-chats-open={mobileChatsOpen}>
    <header className="shell-titlebar"><img src="/favicon.svg" alt="" /><span>Boosted</span><span className="shell-titlebar-section">{current.label}</span>{appUpdate.phase === "downloading" && <span className="shell-update">Updating{formatUpdateProgress(appUpdate) !== undefined ? ` ${formatUpdateProgress(appUpdate)}%` : "…"}</span>}<div className="shell-machine"><MachineSwitcher onManage={() => goTo("settings")} /></div></header>
    <section className="content-surface" aria-label="Content">
    <section className="main-surface" aria-label={`${page === "home" && view === "agents" ? "Agents" : current.label} page`}>
      <header className="main-surface-header" hidden={page === "settings"}>
        {page === "home" && <DropdownMenu><DropdownMenuTrigger asChild><Button variant="ghost" size="icon-sm" aria-label="Project tools"><Ellipsis /></Button></DropdownMenuTrigger><DropdownMenuContent align="start"><DropdownMenuLabel>Project tools</DropdownMenuLabel>{tools.map(({ id, label, icon: Icon }) => <DropdownMenuItem key={id} onClick={() => { setToolView(id); }}><Icon />{label}</DropdownMenuItem>)}</DropdownMenuContent></DropdownMenu>}
        {page === "home" && view === "agents" ? <DropdownMenu>
          <DropdownMenuTrigger asChild><button className="agent-switcher" aria-label="Switch agent">
            {selectedAgent ? <AgentAvatar name={selectedAgent.profile.name} avatar={selectedAgent.profile.avatar} className="size-6 text-[10px]" /> : <Bot />}
            <span>{selectedAgent?.profile.name ?? "Agents"}</span><ChevronDown />
          </button></DropdownMenuTrigger>
          <DropdownMenuContent align="start"><DropdownMenuLabel>Agents</DropdownMenuLabel>{agents.data?.map((agent) => <DropdownMenuItem key={agent.id} onClick={() => openAgent(agent.id)}>
            <AgentAvatar name={agent.profile.name} avatar={agent.profile.avatar} className="size-6 text-[10px]" /><span>{agent.profile.name}</span>
          </DropdownMenuItem>)}</DropdownMenuContent>
        </DropdownMenu> : <span className="main-page-label">{current.label}</span>}
        <div className="main-header-actions">
          {project && !(page === "home" && view === "agents") && <DropdownMenu><DropdownMenuTrigger asChild><button className="project-context"><FolderOpen /><span>{project.name}</span><ChevronDown /></button></DropdownMenuTrigger><DropdownMenuContent align="end"><DropdownMenuLabel>Project</DropdownMenuLabel>{projects.data?.map((entry) => <DropdownMenuItem key={entry.id} onClick={() => { useAppStore.getState().selectProject(entry); setView("chat"); }}><FolderOpen />{entry.name}</DropdownMenuItem>)}<DropdownMenuSeparator /><DropdownMenuItem onClick={() => setProjectDialogOpen(true)}><Plus />Open project</DropdownMenuItem></DropdownMenuContent></DropdownMenu>}
          {page === "home" && <Button variant="ghost" size="icon-sm" aria-label="Agents" title="Agents" onClick={() => setView(view === "agents" ? "chat" : "agents")}><Bot /></Button>}
          <Button className="mobile-chats-toggle" variant="ghost" size="icon-sm" aria-label="Show chats" aria-expanded={mobileChatsOpen} onClick={() => setMobileChatsOpen(!mobileChatsOpen)}><MessagesSquare /></Button>
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
        {page === "home" && (view === "editor" ? <div className="page-detail">
          <div className="page-detail-back"><Button variant="ghost" size="sm" onClick={() => setView("chat")}><ArrowLeft />Back to chat</Button></div>
          <EditorPanel />
        </div> : view === "agents" ? <AgentsPanel selectedId={selectedAgentId} selectAgent={selectAgent} /> : chatId ? <CodexChatPanel key={chatId} threadId={chatId} /> : <NewChatPanel key={projectId ?? "empty"} />)}
        {page === "scheduled" && <ScheduledPage />}
        {page === "projects" && <ProjectsPage onOpenProject={() => setProjectDialogOpen(true)} onSelect={newChat} />}
        {page === "tasks" && (view === "task" && taskId ? <div className="page-detail"><div className="page-detail-back"><Button variant="ghost" size="sm" onClick={() => setView("chat")}><ArrowLeft />All tasks</Button></div><TaskPanel key={taskId} /></div> : <TaskboardPanel />)}
        {page === "settings" && <SettingsPage section={settingsSection} onSectionChange={setSettingsSection} onClose={() => goTo(previousPage.current)} />}
      </Suspense></div>
      </div>
    </section>
    {page !== "settings" && <aside className="right-navigation" aria-label="Navigation and chats">
      <ChatList activeChatId={page === "home" && view === "chat" ? chatId : undefined} onNewChat={newChat} onOpenProject={() => setProjectDialogOpen(true)} onClose={() => setMobileChatsOpen(false)} />

    </aside>}
    </section>
    <div className="navigation-rail">
      <nav aria-label="Primary navigation">{navigation}</nav>
      {!!agents.data?.length && <>
        <Separator className="rail-divider" decorative={false} />
        <nav className="agent-navigation" aria-label="Agents">
          {agents.data.map((agent) => <Tooltip key={agent.id}><TooltipTrigger asChild><button type="button" className="destination agent-destination" aria-label={agent.profile.name} aria-current={page === "home" && view === "agents" && selectedAgent?.id === agent.id ? "page" : undefined} onClick={() => openAgent(agent.id)}><AgentAvatar name={agent.profile.name} avatar={agent.profile.avatar} className="size-7 text-[10px]" /></button></TooltipTrigger><TooltipContent side="left">{agent.profile.name}</TooltipContent></Tooltip>)}
        </nav>
      </>}
      <DropdownMenu><DropdownMenuTrigger asChild><button className="account-avatar" aria-label="Account menu">{user?.username.slice(0, 2).toUpperCase() ?? "B"}</button></DropdownMenuTrigger><DropdownMenuContent side="left" align="end"><DropdownMenuLabel>{user?.username ?? "Boosted"}</DropdownMenuLabel><DropdownMenuItem onClick={() => goTo("settings")}>Settings</DropdownMenuItem><DropdownMenuSeparator /><DropdownMenuItem onClick={() => void logout()}><LogOut />Sign out</DropdownMenuItem></DropdownMenuContent></DropdownMenu>
    </div>
    <nav className="mobile-page-navigation" aria-label="Mobile navigation">
      <button type="button" className="destination" aria-label="Agents" aria-current={page === "home" && view === "agents" ? "page" : undefined} onClick={() => { setView("agents"); setToolView(undefined); goTo("home"); }}><Bot /><span>Agents</span></button>
      {navigation}
    </nav>
    {mobileChatsOpen && <button className="mobile-chat-scrim" aria-label="Dismiss chats" onClick={() => setMobileChatsOpen(false)} />}
    <OpenProjectDialog open={projectDialogOpen} onOpenChange={setProjectDialogOpen} />
    <NewTaskDialog open={newTaskDialogOpen} onOpenChange={setNewTaskDialogOpen} />
    <ForcePasswordDialog />
  </main>;
}
