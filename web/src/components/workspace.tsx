import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { Bot, FileCode2, Files, GitBranch, GitCommitHorizontal, KanbanSquare, ListChecks, ListTodo, MessageSquarePlus, MonitorPlay, Plus, TerminalSquare, X } from "lucide-react";
import { DockviewReact, type DockviewApi, type DockviewReadyEvent, type IDockviewHeaderActionsProps, type IDockviewPanel, type IDockviewPanelHeaderProps, type IDockviewPanelProps } from "dockview-react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { NewChatPanel, TaskPanel } from "@/components/panels/chat-panel";
import { EditorPanel } from "@/components/panels/editor-panel";
import { FilesPanel } from "@/components/panels/files-panel";
import { GitPanel } from "@/components/panels/git-panel";
import { HistoryPanel } from "@/components/panels/history-panel";
import { PlanPanel } from "@/components/panels/plan-panel";
import { TaskboardPanel } from "@/components/panels/taskboard-panel";
import { newTerminalEvent, TerminalPanel } from "@/components/panels/terminal-panel";
import { RemoteViewerPanel } from "@/components/panels/remote-viewer-panel";
import { Button } from "@/components/ui/button";
import { isTauriRuntime } from "@/lib/runtime";
import { machinePreferenceKey } from "@/lib/store";

const CodexChatPanel = lazy(() => import("@/components/panels/codex-chat-panel").then((module) => ({ default: module.CodexChatPanel })));

type CodexChatPanelParams = { threadId: string };
type OpenCodexChatDetail = CodexChatPanelParams & { title: string; split?: boolean; replaceThreadId?: string };
type WorkspaceLayoutMode = "desktop" | "compact";

const compactWorkspaceQuery = "(max-width: 900px)";
const desktopLayoutKey = "boosted.layout.v4";
const compactLayoutKey = "boosted.layout.compact.v1";
const newRemoteViewerEvent = "boosted:remote-viewer:new";
const activeRemoteViewerEvent = "boosted:active-viewer";

function workspaceLayoutMode(): WorkspaceLayoutMode {
  return window.matchMedia(compactWorkspaceQuery).matches ? "compact" : "desktop";
}

function workspaceLayoutKey(mode: WorkspaceLayoutMode, workspaceId: string) {
  return machinePreferenceKey(`boosted.layout.v5.${mode}.${workspaceId}`);
}

function legacyWorkspaceLayoutKey(mode: WorkspaceLayoutMode) {
  return machinePreferenceKey(mode === "compact" ? compactLayoutKey : desktopLayoutKey);
}

function workspaceActivePanelKey(mode: WorkspaceLayoutMode, workspaceId: string) {
  return machinePreferenceKey(`boosted.workspace.active-panel.${mode}.${workspaceId}`);
}

const components = {
  chat: (_props: IDockviewPanelProps) => <NewChatPanel />,
  task: (_props: IDockviewPanelProps) => <TaskPanel />,
  codexChat: (props: IDockviewPanelProps<CodexChatPanelParams>) => <Suspense fallback={<div className="grid h-full place-items-center text-xs text-muted-foreground">Loading chat renderer…</div>}><CodexChatPanel threadId={props.params.threadId} /></Suspense>,
  editor: (props: IDockviewPanelProps) => <EditorPanel {...props} />,
  plan: (_props: IDockviewPanelProps) => <PlanPanel />,
  taskboard: (_props: IDockviewPanelProps) => <TaskboardPanel />,
  files: (_props: IDockviewPanelProps) => <FilesPanel />,
  git: (_props: IDockviewPanelProps) => <GitPanel />,
  history: (_props: IDockviewPanelProps) => <HistoryPanel />,
  terminal: (_props: IDockviewPanelProps) => <TerminalPanel />,
  remoteViewer: (props: IDockviewPanelProps) => <RemoteViewerPanel {...props} />,
};

const titles: Record<keyof typeof components, string> = {
  chat: "New chat",
  task: "Task",
  codexChat: "Codex chat",
  editor: "Editor",
  plan: "Task plan",
  taskboard: "Taskboard",
  files: "Files",
  git: "Git changes",
  history: "Git history",
  terminal: "Terminal",
  remoteViewer: "Remote Viewer",
};

const tabIcons: Record<keyof typeof components, typeof MessageSquarePlus> = {
  chat: MessageSquarePlus,
  task: ListTodo,
  codexChat: Bot,
  editor: FileCode2,
  plan: ListChecks,
  taskboard: KanbanSquare,
  files: Files,
  git: GitBranch,
  history: GitCommitHorizontal,
  terminal: TerminalSquare,
  remoteViewer: MonitorPlay,
};

type ClosedPanel = {
  id: string;
  component: string;
  title?: string;
  params?: Record<string, unknown>;
  groupId: string;
  index: number;
};

const closedPanels: ClosedPanel[] = [];
const maximumClosedPanelHistory = 25;
const closedPanelHistoryChangeEvent = "boosted:closed-panel-history-change";

function notifyClosedPanelHistoryChange() {
  window.dispatchEvent(new Event(closedPanelHistoryChangeEvent));
}

function panelSnapshot(panel: IDockviewPanel): ClosedPanel {
  const state = panel.toJSON();
  return {
    id: panel.id,
    component: state.contentComponent ?? (isCodexChatPanelId(panel.id) ? "codexChat" : isRemoteViewerPanelId(panel.id) ? "remoteViewer" : panel.id),
    title: panel.title,
    params: panel.params ? { ...panel.params } : undefined,
    groupId: panel.group.id,
    index: panel.group.panels.findIndex((entry) => entry.id === panel.id),
  };
}

function rememberClosedPanels(panels: IDockviewPanel[], lastClosedId?: string) {
  const ordered = lastClosedId
    ? [...panels.filter((panel) => panel.id !== lastClosedId), ...panels.filter((panel) => panel.id === lastClosedId)]
    : panels;
  for (const panel of ordered) closedPanels.push(panelSnapshot(panel));
  if (closedPanels.length > maximumClosedPanelHistory) closedPanels.splice(0, closedPanels.length - maximumClosedPanelHistory);
  notifyClosedPanelHistoryChange();
}

function closePanels(panels: IDockviewPanel[], lastClosedId?: string) {
  const openPanels = panels.filter((panel, index, entries) => entries.findIndex((entry) => entry.id === panel.id) === index);
  if (!openPanels.length) return;
  rememberClosedPanels(openPanels, lastClosedId);
  for (const panel of openPanels) panel.api.close();
}

function isolateRemoteViewerPanels(api: DockviewApi) {
  const viewers = api.panels.filter((panel) => isRemoteViewerPanelId(panel.id));
  const first = viewers[0];
  if (!first) return;
  if (first.group.panels.some((panel) => !isRemoteViewerPanelId(panel.id))) {
    first.api.moveTo({ group: first.group, position: "right" });
  }
  for (const viewer of viewers.slice(1)) {
    if (viewer.group.id !== first.group.id) viewer.api.moveTo({ group: first.group, position: "center" });
  }
}

function reopenClosedPanel(containerApi: DockviewApi) {
  const snapshot = closedPanels.pop();
  if (!snapshot) return;
  notifyClosedPanelHistoryChange();
  const existing = containerApi.getPanel(snapshot.id);
  if (existing) {
    existing.api.setActive();
    return;
  }
  const originalGroup = containerApi.getGroup(snapshot.groupId);
  const reference = containerApi.activePanel ?? mainReference(containerApi);
  const reopened = containerApi.addPanel({
    id: snapshot.id,
    component: snapshot.component,
    title: snapshot.title,
    params: snapshot.params,
    position: originalGroup
      ? { referenceGroup: originalGroup.id, direction: "within", index: snapshot.index }
      : reference ? { referencePanel: reference.id, direction: "within" } : undefined,
  });
  if (isRemoteViewerPanelId(reopened.id)) {
    isolateRemoteViewerPanels(containerApi);
    reopened.api.maximize();
  }
  reopened.api.setActive();
}

function duplicateCodexChatPanel(containerApi: DockviewApi, panel: IDockviewPanel) {
  if (!isCodexChatPanelId(panel.id)) return;
  const threadId = typeof panel.params?.threadId === "string" ? panel.params.threadId : undefined;
  if (!threadId) return;
  containerApi.addPanel<CodexChatPanelParams>({
    id: `codex-chat:${threadId}:view:${crypto.randomUUID()}`,
    component: "codexChat",
    title: panel.title,
    params: { threadId },
    position: {
      referenceGroup: panel.group.id,
      direction: "within",
      index: panel.group.panels.findIndex((entry) => entry.id === panel.id) + 1,
    },
  }).api.setActive();
}

function splitPanel(panel: IDockviewPanel, position: "right" | "bottom") {
  panel.api.moveTo({ group: panel.group, position });
  panel.api.setActive();
}

function WorkspaceTab({ api, containerApi }: IDockviewPanelHeaderProps) {
  const panelId = (api.id.startsWith("codex-chat:") ? "codexChat" : api.id.startsWith("remote-viewer:") ? "remoteViewer" : api.id) as keyof typeof components;
  const [title, setTitle] = useState(api.title ?? titles[panelId] ?? api.id);
  const [, setClosedPanelHistoryVersion] = useState(0);
  const [compact, setCompact] = useState(() => workspaceLayoutMode() === "compact");
  const middlePointerDown = useRef(false);
  const Icon = tabIcons[panelId] ?? FileCode2;
  const panel = containerApi.getPanel(api.id);
  const groupPanels = panel?.group.panels ?? [];
  const panelIndex = groupPanels.findIndex((entry) => entry.id === api.id);
  const panelsToLeft = panelIndex > 0 ? groupPanels.slice(0, panelIndex) : [];
  const panelsToRight = panelIndex >= 0 ? groupPanels.slice(panelIndex + 1) : [];

  const closeCurrent = () => {
    const current = containerApi.getPanel(api.id);
    if (current) closePanels([current], current.id);
  };

  useEffect(() => {
    const disposable = api.onDidTitleChange((event) => setTitle(event.title));
    return () => disposable.dispose();
  }, [api]);

  useEffect(() => {
    const listener = () => setClosedPanelHistoryVersion((version) => version + 1);
    window.addEventListener(closedPanelHistoryChangeEvent, listener);
    return () => window.removeEventListener(closedPanelHistoryChangeEvent, listener);
  }, []);

  useEffect(() => {
    const media = window.matchMedia(compactWorkspaceQuery);
    const listener = (event: MediaQueryListEvent) => setCompact(event.matches);
    media.addEventListener("change", listener);
    return () => media.removeEventListener("change", listener);
  }, []);

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          className="workspace-tab"
          title={title}
          onPointerDown={(event) => {
            if (event.button !== 1) return;
            middlePointerDown.current = true;
            event.preventDefault();
            event.stopPropagation();
          }}
          onPointerUp={(event) => {
            if (event.button !== 1 || !middlePointerDown.current) return;
            middlePointerDown.current = false;
            event.preventDefault();
            event.stopPropagation();
            closeCurrent();
          }}
          onPointerLeave={() => { middlePointerDown.current = false; }}
          onAuxClick={(event) => {
            if (event.button !== 1) return;
            event.preventDefault();
            event.stopPropagation();
          }}
        >
          <Icon className="workspace-tab-icon" />
          <span className="workspace-tab-label">{title}</span>
          <button
            type="button"
            className="workspace-tab-close"
            aria-label={`Close ${title}`}
            onPointerDown={(event) => { event.preventDefault(); event.stopPropagation(); }}
            onClick={(event) => { event.preventDefault(); event.stopPropagation(); closeCurrent(); }}
          >
            <X />
          </button>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent onCloseAutoFocus={(event) => event.preventDefault()}>
        <ContextMenuItem disabled={!panel || !isCodexChatPanelId(api.id)} onSelect={() => panel && duplicateCodexChatPanel(containerApi, panel)}>
          Duplicate tab
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem disabled={compact || !panel || groupPanels.length < 2} onSelect={() => panel && splitPanel(panel, "right")}>
          Split right
        </ContextMenuItem>
        <ContextMenuItem disabled={compact || !panel || groupPanels.length < 2} onSelect={() => panel && splitPanel(panel, "bottom")}>
          Split down
        </ContextMenuItem>
        <ContextMenuItem disabled={!panel} onSelect={() => {
          if (!panel) return;
          if (panel.api.isMaximized()) panel.api.exitMaximized();
          else panel.api.maximize();
        }}>
          {panel?.api.isMaximized() ? "Restore panel size" : "Maximize panel"}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={closeCurrent}>
          Close tab
          <ContextMenuShortcut>⌘W</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuItem disabled={groupPanels.length < 2} onSelect={() => closePanels(groupPanels.filter((entry) => entry.id !== api.id))}>
          Close other tabs
        </ContextMenuItem>
        <ContextMenuItem disabled={!panelsToLeft.length} onSelect={() => closePanels(panelsToLeft)}>
          Close tabs to the left
        </ContextMenuItem>
        <ContextMenuItem disabled={!panelsToRight.length} onSelect={() => closePanels(panelsToRight)}>
          Close tabs to the right
        </ContextMenuItem>
        <ContextMenuItem disabled={!groupPanels.length} onSelect={() => closePanels(groupPanels, api.id)}>
          Close tab group
        </ContextMenuItem>
        <ContextMenuItem disabled={!containerApi.panels.length} onSelect={() => closePanels([...containerApi.panels], api.id)}>
          Close all tabs
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem disabled={!closedPanels.length} onSelect={() => reopenClosedPanel(containerApi)}>
          Reopen closed tab
          <ContextMenuShortcut>⌘⇧T</ContextMenuShortcut>
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

function WorkspaceHeaderActions({ activePanel }: IDockviewHeaderActionsProps) {
  const viewer = activePanel?.id.startsWith("remote-viewer:");
  if (activePanel?.id !== "terminal" && !viewer) return null;
  return (
    <Button
      className="mr-1"
      variant="ghost"
      size="icon-sm"
      aria-label={viewer ? "New Remote Viewer" : "New terminal"}
      title={viewer ? "New Remote Viewer" : "New terminal"}
      onClick={() => window.dispatchEvent(new Event(viewer ? newRemoteViewerEvent : newTerminalEvent))}
    >
      <Plus />
    </Button>
  );
}

function isCodexChatPanelId(id: string) {
  return id.startsWith("codex-chat:");
}

function isRemoteViewerPanelId(id: string) {
  return id.startsWith("remote-viewer:");
}

function mainReference(api: DockviewApi, excludeId?: string) {
  const active = api.activePanel;
  if (active && active.id !== excludeId && (active.id === "chat" || active.id === "task" || active.id === "taskboard" || active.id === "editor" || isCodexChatPanelId(active.id))) return active;
  return [
    api.getPanel("editor"),
    api.getPanel("chat"),
    api.getPanel("task"),
    api.getPanel("taskboard"),
    api.panels.find((panel) => isCodexChatPanelId(panel.id)),
  ].find((panel) => panel && panel.id !== excludeId);
}

function closeCodexChatPanels(api: DockviewApi) {
  for (const panel of api.panels.filter((entry) => isCodexChatPanelId(entry.id))) panel.api.close();
}

function addPanel(api: DockviewApi, id: keyof typeof components) {
  if (id === "codexChat" || id === "remoteViewer") return;
  const primaryIds: (keyof typeof components)[] = ["chat", "task", "taskboard"];
  const toolIds: (keyof typeof components)[] = ["files", "plan", "git", "history"];
  const closeOtherPrimaryPanels = () => {
    for (const panelId of primaryIds) {
      if (panelId !== id) api.getPanel(panelId)?.api.close();
    }
    closeCodexChatPanels(api);
  };
  const existing = api.getPanel(id);
  if (existing) {
    if (primaryIds.includes(id)) closeOtherPrimaryPanels();
    existing.api.setActive();
    return;
  }
  const toolReference = toolIds.map((panelId) => api.getPanel(panelId)).find(Boolean);
  const centerReference = mainReference(api);
  const compact = workspaceLayoutMode() === "compact";
  const compactReference = api.activePanel ?? centerReference ?? toolReference;
  const position = compact
    ? compactReference ? { referencePanel: compactReference.id, direction: "within" as const } : undefined
    : id === "terminal"
    ? (centerReference ?? toolReference) ? { referencePanel: (centerReference ?? toolReference)!.id, direction: "below" as const } : undefined
    : toolIds.includes(id)
      ? toolReference
        ? { referencePanel: toolReference.id, direction: "within" as const }
        : centerReference ? { referencePanel: centerReference.id, direction: "right" as const } : undefined
      : primaryIds.includes(id)
        ? centerReference
          ? { referencePanel: centerReference.id, direction: "within" as const }
          : toolReference ? { referencePanel: toolReference.id, direction: "left" as const } : undefined
        : centerReference ? { referencePanel: centerReference.id, direction: "within" as const } : undefined;
  const panel = api.addPanel({
    id,
    component: id,
    title: titles[id],
    position,
    ...(id === "terminal" ? { initialHeight: 220 } : toolIds.includes(id) && !toolReference ? { initialWidth: 390 } : {}),
  });
  if (primaryIds.includes(id)) closeOtherPrimaryPanels();
  panel.api.setActive();
}

function openRemoteViewerPanel(api: DockviewApi, alwaysNew = false) {
  const existing = api.panels.find((panel) => isRemoteViewerPanelId(panel.id));
  if (existing && !alwaysNew) {
    if (existing.group.panels.some((panel) => !isRemoteViewerPanelId(panel.id))) {
      existing.api.moveTo({ group: existing.group, position: "right" });
    }
    existing.api.setActive();
    if (!existing.api.isMaximized()) existing.api.maximize();
    return;
  }
  const viewerReference = api.panels.find((panel) => isRemoteViewerPanelId(panel.id));
  const centerReference = mainReference(api);
  const toolReference = ["files", "plan", "git", "history"].map((id) => api.getPanel(id)).find(Boolean);
  const panel = api.addPanel({
    id: `remote-viewer:${crypto.randomUUID()}`,
    component: "remoteViewer",
    title: titles.remoteViewer,
    position: viewerReference
      ? { referencePanel: viewerReference.id, direction: "within" }
      : centerReference
        ? { referencePanel: centerReference.id, direction: "right" }
        : toolReference ? { referencePanel: toolReference.id, direction: "left" } : undefined,
  });
  panel.api.setActive();
  panel.api.maximize();
}

function openCodexChatPanel(api: DockviewApi, detail: OpenCodexChatDetail) {
  const panelId = `codex-chat:${detail.threadId}`;
  const replacedPanel = detail.replaceThreadId ? api.getPanel(`codex-chat:${detail.replaceThreadId}`) : undefined;
  const existing = api.getPanel(panelId);
  if (existing) {
    existing.api.setTitle(detail.title);
    if (detail.split && workspaceLayoutMode() === "desktop") {
      const reference = mainReference(api, panelId);
      if (reference && reference.api.group === existing.api.group) existing.api.moveTo({ group: reference.api.group, position: "right" });
    }
    existing.api.setActive();
    if (replacedPanel && replacedPanel.id !== existing.id) replacedPanel.api.close();
    return;
  }

  const reference = replacedPanel ?? mainReference(api);
  const toolReference = ["files", "plan", "git", "history"].map((id) => api.getPanel(id)).find(Boolean);
  const panel = api.addPanel<CodexChatPanelParams>({
    id: panelId,
    component: "codexChat",
    title: detail.title,
    params: { threadId: detail.threadId },
    position: reference
      ? { referencePanel: reference.id, direction: detail.split && workspaceLayoutMode() === "desktop" ? "right" : "within" }
      : toolReference ? { referencePanel: toolReference.id, direction: "left" } : undefined,
  });
  api.getPanel("chat")?.api.close();
  api.getPanel("task")?.api.close();
  api.getPanel("taskboard")?.api.close();
  panel.api.setActive();
  if (replacedPanel) replacedPanel.api.close();
}

export function Workspace({ workspaceId }: { workspaceId: string }) {
  const apiRef = useRef<DockviewApi | null>(null);
  const layoutModeRef = useRef<WorkspaceLayoutMode>(workspaceLayoutMode());

  const createInitialLayout = useCallback((api: DockviewApi, mode: WorkspaceLayoutMode) => {
    const chat = api.addPanel({ id: "chat", component: "chat", title: titles.chat });
    if (mode === "compact") {
      chat.api.setActive();
      return;
    }
    const files = api.addPanel({ id: "files", component: "files", title: titles.files, position: { referencePanel: chat.id, direction: "right" }, initialWidth: 390 });
    api.addPanel({ id: "plan", component: "plan", title: titles.plan, position: { referencePanel: files.id, direction: "within" } });
    api.addPanel({ id: "git", component: "git", title: titles.git, position: { referencePanel: files.id, direction: "within" } });
    api.addPanel({ id: "history", component: "history", title: titles.history, position: { referencePanel: files.id, direction: "within" } });
    files.api.setActive();
  }, []);

  const restoreLayout = useCallback((api: DockviewApi, mode: WorkspaceLayoutMode) => {
    const layoutKey = workspaceLayoutKey(mode, workspaceId);
    const saved = localStorage.getItem(layoutKey) ?? localStorage.getItem(legacyWorkspaceLayoutKey(mode));
    if (saved) {
      try {
        api.fromJSON(JSON.parse(saved));
        isolateRemoteViewerPanels(api);
        localStorage.setItem(layoutKey, saved);
        const activePanelId = localStorage.getItem(workspaceActivePanelKey(mode, workspaceId))
          ?? localStorage.getItem(machinePreferenceKey(`boosted.workspace.active-panel.${mode}`));
        if (activePanelId) api.getPanel(activePanelId)?.api.setActive();
        return;
      } catch {
        localStorage.removeItem(layoutKey);
      }
    }
    api.closeAllGroups();
    createInitialLayout(api, mode);
  }, [createInitialLayout, workspaceId]);

  const onReady = useCallback((event: DockviewReadyEvent) => {
    apiRef.current = event.api;
    const mode = workspaceLayoutMode();
    layoutModeRef.current = mode;
    event.api.onDidLayoutChange(() => localStorage.setItem(workspaceLayoutKey(layoutModeRef.current, workspaceId), JSON.stringify(event.api.toJSON())));
    event.api.onDidActivePanelChange(({ panel }) => {
      const key = workspaceActivePanelKey(layoutModeRef.current, workspaceId);
      if (panel) localStorage.setItem(key, panel.id);
      else localStorage.removeItem(key);
      window.dispatchEvent(new CustomEvent(activeRemoteViewerEvent, { detail: panel && isRemoteViewerPanelId(panel.id) ? panel.id : undefined }));
    });
    restoreLayout(event.api, mode);
  }, [restoreLayout, workspaceId]);

  useEffect(() => {
    const media = window.matchMedia(compactWorkspaceQuery);
    const listener = (event: MediaQueryListEvent) => {
      const api = apiRef.current;
      if (!api) return;
      const previousMode = layoutModeRef.current;
      localStorage.setItem(workspaceLayoutKey(previousMode, workspaceId), JSON.stringify(api.toJSON()));
      if (api.activePanel) localStorage.setItem(workspaceActivePanelKey(previousMode, workspaceId), api.activePanel.id);
      const nextMode: WorkspaceLayoutMode = event.matches ? "compact" : "desktop";
      layoutModeRef.current = nextMode;
      restoreLayout(api, nextMode);
    };
    media.addEventListener("change", listener);
    return () => media.removeEventListener("change", listener);
  }, [restoreLayout, workspaceId]);

  useEffect(() => {
    const listener = (event: Event) => {
      if (!apiRef.current) return;
      const id = (event as CustomEvent<string>).detail;
      if (id === "remoteViewer") openRemoteViewerPanel(apiRef.current);
      else addPanel(apiRef.current, id as keyof typeof components);
    };
    window.addEventListener("boosted:open-panel", listener);
    return () => window.removeEventListener("boosted:open-panel", listener);
  }, []);

  useEffect(() => {
    const listener = () => { if (apiRef.current) openRemoteViewerPanel(apiRef.current, true); };
    window.addEventListener(newRemoteViewerEvent, listener);
    return () => window.removeEventListener(newRemoteViewerEvent, listener);
  }, []);

  useEffect(() => {
    const listener = (event: Event) => {
      if (apiRef.current) openCodexChatPanel(apiRef.current, (event as CustomEvent<OpenCodexChatDetail>).detail);
    };
    window.addEventListener("boosted:open-codex-chat", listener);
    return () => window.removeEventListener("boosted:open-codex-chat", listener);
  }, []);

  useEffect(() => {
    const listener = () => {
      const api = apiRef.current;
      if (!api) return;
      const reference = mainReference(api, "editor");
      const existing = api.getPanel("editor");
      if (existing) {
        if (reference && existing.group.id !== reference.group.id) {
          existing.api.moveTo({ group: reference.group, position: "center" });
        } else if (existing.group.panels.some((panel) => ["files", "plan", "git", "history"].includes(panel.id))) {
          existing.api.moveTo({ group: existing.group, position: "left" });
        }
        existing.api.setActive();
        return;
      }
      const toolReference = ["files", "plan", "git", "history"].map((id) => api.getPanel(id)).find(Boolean);
      api.addPanel({
        id: "editor",
        component: "editor",
        title: titles.editor,
        position: reference
          ? { referencePanel: reference.id, direction: "within" }
          : toolReference ? { referencePanel: toolReference.id, direction: "left" } : undefined,
      }).api.setActive();
    };
    window.addEventListener("boosted:open-file", listener);
    return () => window.removeEventListener("boosted:open-file", listener);
  }, []);

  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      const api = apiRef.current;
      const workspace = document.querySelector(".workspace");
      if (!api || !workspace?.contains(document.activeElement)) return;
      const accelerator = event.metaKey || event.ctrlKey;
      const key = event.key.toLowerCase();

      if (accelerator && key === "w") {
        const activePanel = api.activePanel;
        if (!activePanel) return;
        event.preventDefault();
        if (event.shiftKey) closePanels([...activePanel.group.panels], activePanel.id);
        else closePanels([activePanel], activePanel.id);
        return;
      }
      if (accelerator && event.shiftKey && key === "t") {
        event.preventDefault();
        reopenClosedPanel(api);
        return;
      }
      if (event.ctrlKey && key === "tab") {
        const activePanel = api.activePanel;
        if (!activePanel) return;
        const panels = activePanel.group.panels;
        const currentIndex = panels.findIndex((panel) => panel.id === activePanel.id);
        const nextIndex = (currentIndex + (event.shiftKey ? panels.length - 1 : 1)) % panels.length;
        event.preventDefault();
        panels[nextIndex]?.api.setActive();
        return;
      }
      if (accelerator && !event.shiftKey && /^[1-9]$/.test(event.key)) {
        const panels = api.activePanel?.group.panels;
        if (!panels?.length) return;
        const requestedIndex = Number(event.key) === 9 ? panels.length - 1 : Number(event.key) - 1;
        if (!panels[requestedIndex]) return;
        event.preventDefault();
        panels[requestedIndex].api.setActive();
      }
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, []);

  return <DockviewReact className="dockview-theme-boosted" components={components} defaultTabComponent={WorkspaceTab} dndStrategy={isTauriRuntime() ? "pointer" : "auto"} rightHeaderActionsComponent={WorkspaceHeaderActions} onReady={onReady} />;
}
