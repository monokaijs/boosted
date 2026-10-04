import { createPortal } from "react-dom";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useAppStore } from "@/lib/store";
import type { CodexChat, Project } from "@/lib/types";
import { CreateAgentDialog } from "@/features/agents/components/session/create-agent-dialog";
import type { SessionShellState } from "@/features/agents/components/session/session-shell";

const apiMock = vi.hoisted(() => {
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key), clear: () => values.clear() });
  return { projects: vi.fn(), codexChats: vi.fn(), logout: vi.fn(), agents: vi.fn(), usage: vi.fn(), featureRequest: vi.fn(), createAgent: vi.fn() };
});
vi.mock("@/lib/api", () => ({ api: apiMock, setToken: vi.fn() }));
vi.mock("@/lib/api-context", () => ({ useBoostedApiClient: () => ({ profileId: "test-machine", featureRequest: apiMock.featureRequest, projects: apiMock.projects }) }));
vi.mock("@/features/agents/lib/api-client", () => ({ apiClient: { assistant: { list: apiMock.agents, usage: apiMock.usage } } }));
vi.mock("@/hooks/use-live-events", () => ({ useLiveEvents() {} }));
vi.mock("@/hooks/use-notification-navigation", () => ({ useNotificationNavigation() {} }));
vi.mock("@/lib/updater", () => ({ useAppUpdateState: () => ({ phase: "idle" }), formatUpdateProgress: () => undefined }));
vi.mock("@/features/agents/agents-panel", () => ({ openProvidersEvent: "boosted:open-providers", AgentsPanel: ({ selectedId, selectAgent, createAgentOpen, onCreateAgentOpenChange }: { selectedId: string; selectAgent(id: string): void; createAgentOpen: boolean; onCreateAgentOpenChange(open: boolean): void }) => <><p>Agent conversation {selectedId}</p><button onClick={() => selectAgent("pock")}>Switch to Pock</button><CreateAgentDialog shell={{ createAgent: apiMock.createAgent } as unknown as SessionShellState} open={createAgentOpen} onOpenChange={onCreateAgentOpenChange} /></> }));
vi.mock("@/features/groups/group-panel", () => ({ GroupPanel: ({ groupId, headerTarget }: { groupId: string; headerTarget?: HTMLElement | null }) => <>{headerTarget && createPortal(<h1>Build team</h1>, headerTarget)}<p>Group conversation {groupId}</p></> }));
vi.mock("@/components/settings-page", () => ({ SettingsPage: ({ onClose }: { onClose(): void }) => <><h1>Settings page content</h1><button onClick={onClose}>Close settings</button></> }));
vi.mock("@/components/create-dialogs", () => ({ ForcePasswordDialog: () => null, NewTaskDialog: () => null, OpenProjectDialog: () => null }));
vi.mock("@/components/machine-manager", () => ({ MachineSwitcher: () => <span>Test machine</span> }));
vi.mock("@/components/panels/chat-panel", () => ({ NewChatPanel: () => <h1>Start a conversation</h1>, TaskPanel: () => <p>Task detail content</p> }));
vi.mock("@/components/panels/codex-chat-panel", () => ({ CodexChatPanel: ({ threadId }: { threadId: string }) => <p>Conversation {threadId}</p> }));
vi.mock("@/components/panels/editor-panel", () => ({ EditorPanel: () => <p>Editor content</p> }));
vi.mock("@/components/panels/files-panel", () => ({ FilesPanel: () => <p>Files content</p> }));
vi.mock("@/components/panels/git-panel", () => ({ GitPanel: () => <p>Changes content</p> }));
vi.mock("@/components/panels/taskboard-panel", () => ({ TaskboardPanel: () => <h1>Task board content</h1> }));

import { AppShell } from "./app-shell";

const projects: Project[] = [
  { id: "alpha", name: "Alpha", repoPath: "/repos/alpha", defaultBranch: "main", createdAt: "2026-10-01" },
  { id: "beta", name: "Beta", repoPath: "/repos/beta", defaultBranch: "main", createdAt: "2026-10-01" },
];
const chats: CodexChat[] = [
  { id: "old", title: "Older alpha chat", cwd: "/repos/alpha", updatedAt: "2026-10-01T10:00:00Z", preview: "", source: "cli", isPinned: false, status: "idle" },
  { id: "new", title: "Latest beta chat", cwd: "/repos/beta", updatedAt: "2026-10-02T10:00:00Z", preview: "", source: "cli", isPinned: false, status: "idle" },
];

function renderShell() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><TooltipProvider><AppShell /></TooltipProvider></QueryClientProvider>);
}
function goTo(name: string) { fireEvent.click(within(screen.getByRole("navigation", { name: "Primary navigation" })).getByRole("button", { name })); }

afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("innerWidth", 1024);
  window.history.replaceState(null, "", "/");
  localStorage.clear();
  useAppStore.setState({ selectedProjectId: "alpha", selectedGroupId: undefined, selectedCodexChatId: undefined, selectedTaskId: undefined, openFilePath: undefined, taskDrawerOpen: false, activeMachineId: undefined });
  apiMock.projects.mockResolvedValue(projects);
  apiMock.codexChats.mockResolvedValue([...chats, chats[0]]);
  apiMock.featureRequest.mockResolvedValue([]);
  apiMock.usage.mockResolvedValue({ trackedSince: null, series: [] });
  apiMock.createAgent.mockResolvedValue(undefined);
  apiMock.agents.mockResolvedValue([
    { id: "pock", profile: { name: "Pock" } },
    { id: "sage", profile: { name: "Sage", avatar: "/sage.png" } },
  ]);
});

describe("page navigation and conversations", () => {
  it("keeps navigation clickable while the agent selector is open", async () => {
    renderShell();
    fireEvent.click(await within(await screen.findByRole("navigation", { name: "Agents" })).findByRole("button", { name: "Pock" }));
    const trigger = screen.getByRole("button", { name: "Switch agent" });
    expect(fireEvent.mouseDown(trigger, { button: 0 })).toBe(false);
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
    const sage = await screen.findByRole("menuitem", { name: "Sage" });
    expect(fireEvent.mouseDown(sage, { button: 0 })).toBe(false);
    expect(document.body.style.pointerEvents).not.toBe("none");

    const settings = within(screen.getByRole("navigation", { name: "Primary navigation" })).getByRole("button", { name: "Settings" });
    fireEvent.pointerDown(settings, { button: 0, ctrlKey: false, pointerType: "mouse" });
    fireEvent.click(settings);
    expect(await screen.findByText("Settings page content")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());
    expect(document.body.style.pointerEvents).not.toBe("none");
  });

  it("opens mobile Chats as a page and gives agent and chat conversations the full screen", async () => {
    vi.stubGlobal("innerWidth", 393);
    localStorage.setItem("boosted.selected-agent.test-machine", "sage");
    useAppStore.setState({ selectedCodexChatId: "old" });
    renderShell();
    const mobile = within(screen.getByRole("navigation", { name: "Mobile navigation" }));
    expect(mobile.getAllByRole("button").map((button) => button.getAttribute("aria-label"))).toEqual(["Chats", "Scheduled", "Projects", "Tasks", "Settings"]);
    expect(screen.getByRole("heading", { name: "Chats" })).toBeInTheDocument();
    expect(screen.queryByText("Conversation old")).not.toBeInTheDocument();
    fireEvent.click(mobile.getByRole("button", { name: "Settings" }));
    expect(await screen.findByText("Settings page content")).toBeInTheDocument();
    fireEvent.click(mobile.getByRole("button", { name: "Chats" }));
    fireEvent.click(await within(screen.getByRole("navigation", { name: "Agents" })).findByRole("button", { name: "Sage" }));
    expect(await screen.findByText("Agent conversation sage")).toBeInTheDocument();
    expect(screen.getByRole("main")).toHaveAttribute("data-mobile-chat-open", "true");
    expect(screen.queryByRole("navigation", { name: "Mobile navigation" })).not.toBeInTheDocument();
    expect(screen.queryByRole("complementary", { name: "Navigation and chats" })).not.toBeInTheDocument();
    expect(screen.queryByText("Test machine")).not.toBeVisible();
    fireEvent.pointerDown(screen.getByRole("button", { name: "Switch agent" }), { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Pock" }));
    expect(await screen.findByText("Agent conversation pock")).toBeInTheDocument();
    expect(localStorage.getItem("boosted.selected-agent.test-machine")).toBe("pock");
    fireEvent.click(screen.getByRole("button", { name: "Back to chats" }));
    expect(screen.getByRole("navigation", { name: "Mobile navigation" })).toBeInTheDocument();
    expect(screen.getByRole("main")).toHaveAttribute("data-mobile-chat-open", "false");
    fireEvent.click(await within(screen.getByRole("region", { name: "Recent" })).findByRole("button", { name: "Older alpha chat" }));
    expect(await screen.findByText("Conversation old")).toBeInTheDocument();
    const back = screen.getByRole("button", { name: "Back to chats" });
    expect(back.nextElementSibling).toHaveTextContent("Older alpha chat");
    expect(screen.getByRole("main")).toHaveAttribute("data-mobile-chat-open", "true");
    fireEvent.click(screen.getByRole("button", { name: "Back to chats" }));
    expect(mobile.getByRole("button", { name: "Chats" })).toHaveAttribute("aria-current", "page");
    expect(useAppStore.getState().selectedCodexChatId).toBe("old");
  });

  it("keeps mobile tabs available on each page and opens new chats full screen", async () => {
    vi.stubGlobal("innerWidth", 393);
    renderShell();
    const mobile = within(screen.getByRole("navigation", { name: "Mobile navigation" }));
    for (const [tab, content] of [["Scheduled", "Scheduled work is coming"], ["Projects", "A home for your code and conversations."], ["Tasks", "Task board content"], ["Settings", "Settings page content"]]) {
      fireEvent.click(mobile.getByRole("button", { name: tab }));
      expect(await screen.findByText(content)).toBeInTheDocument();
      expect(mobile.getByRole("button", { name: tab })).toHaveAttribute("aria-current", "page");
      expect(screen.queryByRole("complementary", { name: "Navigation and chats" })).not.toBeInTheDocument();
    }
    fireEvent.click(mobile.getByRole("button", { name: "Chats" }));
    fireEvent.click(screen.getByRole("button", { name: "New chat" }));
    expect(screen.getByText("Start a conversation")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Back to chats" })).toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "Mobile navigation" })).not.toBeInTheDocument();
    act(() => { window.history.replaceState(null, "", "/#chats"); window.dispatchEvent(new HashChangeEvent("hashchange")); });
    expect(screen.getByRole("heading", { name: "Chats" })).toBeInTheDocument();
    expect(screen.queryByText("Start a conversation")).not.toBeInTheDocument();
  });

  it("returns to the mobile chat list when closing Settings", async () => {
    vi.stubGlobal("innerWidth", 393);
    renderShell();
    fireEvent.click(within(screen.getByRole("navigation", { name: "Mobile navigation" })).getByRole("button", { name: "Settings" }));
    fireEvent.click(screen.getByRole("button", { name: "Close settings" }));
    expect(screen.getByRole("heading", { name: "Chats" })).toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "Mobile navigation" })).toBeInTheDocument();
    expect(screen.queryByText("Start a conversation")).not.toBeInTheDocument();
  });

  it("opens mobile group and notification conversations and restores the desktop layout on resize", async () => {
    vi.stubGlobal("innerWidth", 393);
    apiMock.featureRequest.mockResolvedValue([{ id: "team", name: "Build team", memberIds: ["pock", "sage"] }]);
    renderShell();
    fireEvent.click(await screen.findByRole("button", { name: "Build team" }));
    expect(await screen.findByText("Group conversation team")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Back to chats" }).nextElementSibling).toContainElement(screen.getByRole("heading", { name: "Build team" }));
    expect(screen.getByRole("main")).toHaveAttribute("data-mobile-chat-open", "true");
    fireEvent.click(screen.getByRole("button", { name: "Back to chats" }));
    act(() => window.dispatchEvent(new CustomEvent("boosted:open-codex-chat", { detail: { threadId: "new" } })));
    expect(await screen.findByText("Conversation new")).toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "Mobile navigation" })).not.toBeInTheDocument();
    act(() => { vi.stubGlobal("innerWidth", 1200); window.dispatchEvent(new Event("resize")); });
    expect(screen.getByRole("navigation", { name: "Primary navigation" })).toBeInTheDocument();
    expect(screen.getByRole("complementary", { name: "Navigation and chats" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Back to chats" })).not.toBeInTheDocument();
  });

  it("opens the chosen agent from another page and keeps the avatar selection in sync", async () => {
    renderShell();
    const agents = await screen.findByRole("navigation", { name: "Agents" });
    const sage = await within(agents).findByRole("button", { name: "Sage" });
    expect(within(agents).getAllByRole("button")).toHaveLength(3);
    expect(screen.getByRole("region", { name: "Chats" })).toContainElement(agents);
    expect(document.querySelector(".navigation-rail")).not.toContainElement(agents);
    expect(sage.querySelector("img")).toHaveAttribute("src", "/sage.png");
    expect(within(agents).getByRole("button", { name: "Pock" })).toHaveTextContent("P");
    expect(screen.getByRole("separator")).toBeInTheDocument();
    goTo("Projects");
    fireEvent.click(sage);
    expect(await screen.findByText("Agent conversation sage")).toBeInTheDocument();
    expect(sage).toHaveAttribute("aria-current", "page");
    expect(localStorage.getItem("boosted.selected-agent.test-machine")).toBe("sage");
    fireEvent.click(screen.getByRole("button", { name: "Switch to Pock" }));
    expect(within(agents).getByRole("button", { name: "Pock" })).toHaveAttribute("aria-current", "page");
    expect(sage).not.toHaveAttribute("aria-current");
    goTo("Home");
    expect(await screen.findByText("Start a conversation")).toBeInTheDocument();
    expect(within(agents).getByRole("button", { name: "Pock" })).not.toHaveAttribute("aria-current");
    act(() => window.dispatchEvent(new CustomEvent("boosted:select-agent", { detail: "sage" })));
    expect(await screen.findByText("Agent conversation sage")).toBeInTheDocument();
    expect(sage).toHaveAttribute("aria-current", "page");
  });

  it("opens agent creation from the chat list even without any existing agents", async () => {
    apiMock.agents.mockResolvedValue([]);
    renderShell();
    fireEvent.click(await screen.findByRole("button", { name: "New agent" }));
    const dialog = within(await screen.findByRole("dialog", { name: "New agent" }));
    fireEvent.change(dialog.getByRole("textbox", { name: "Name" }), { target: { value: "Nova" } });
    fireEvent.click(dialog.getByRole("button", { name: "Create agent" }));
    await waitFor(() => expect(apiMock.createAgent).toHaveBeenCalledWith({ name: "Nova", personality: undefined }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("shows stacked participant avatars beside group names and only highlights the visible group", async () => {
    apiMock.featureRequest.mockResolvedValue([{ id: "team", name: "Build team", memberIds: ["pock", "sage"] }]);
    renderShell();
    const groups = within(screen.getByRole("region", { name: "Groups" }));
    const team = await groups.findByRole("button", { name: "Build team" });
    const participants = within(team).getByRole("img", { name: "Participants: Pock, Sage" });
    expect(participants.querySelectorAll(".agent-avatar")).toHaveLength(2);
    expect(participants.querySelector("img")).toHaveAttribute("src", "/sage.png");
    fireEvent.click(team);
    expect(await screen.findByText("Group conversation team")).toBeInTheDocument();
    expect(team).toHaveAttribute("aria-current", "true");
    goTo("Projects");
    expect(team).not.toHaveAttribute("aria-current");
    fireEvent.click(within(screen.getByRole("navigation", { name: "Agents" })).getByRole("button", { name: "Pock" }));
    expect(await screen.findByText("Agent conversation pock")).toBeInTheDocument();
    expect(team).not.toHaveAttribute("aria-current");
  });

  it("highlights only the visible current chat and clears the highlight on other pages", async () => {
    useAppStore.setState({ selectedCodexChatId: "old" });
    renderShell();
    const projectList = screen.getByRole("region", { name: "Projects" });
    const recent = screen.getByRole("region", { name: "Recent" });
    await within(recent).findByRole("button", { name: "Older alpha chat" });
    expect(within(recent).getByRole("button", { name: "Older alpha chat" })).toHaveAttribute("aria-current", "true");
    const projectRow = within(projectList).getByRole("button", { name: "Expand Alpha" });
    expect(projectRow).not.toHaveClass("is-selected");
    fireEvent.click(projectRow);
    expect(within(projectList).getByRole("button", { name: "Older alpha chat" })).toHaveAttribute("aria-current", "true");
    expect(within(recent).getByRole("button", { name: "Older alpha chat" })).not.toHaveAttribute("aria-current");
    goTo("Projects");
    expect(document.querySelectorAll(".chat-list-row[aria-current]")).toHaveLength(0);
    goTo("Home");
    expect(document.querySelectorAll(".chat-list-row[aria-current]")).toHaveLength(1);
    fireEvent.click(within(projectList).getByRole("button", { name: "Collapse Alpha" }));
    expect(within(recent).getByRole("button", { name: "Older alpha chat" })).toHaveAttribute("aria-current", "true");
    fireEvent.click(screen.getByRole("button", { name: "New chat" }));
    expect(document.querySelectorAll(".chat-list-row[aria-current]")).toHaveLength(0);
  });

  it("shows running, approval, and error states independently of selection", async () => {
    apiMock.codexChats.mockResolvedValue([
      { ...chats[0], status: "active" },
      { ...chats[1], status: "needs_input" },
      { ...chats[0], id: "failed", title: "Failed chat", status: "systemError" },
    ]);
    renderShell();
    const recent = screen.getByRole("region", { name: "Recent" });
    await within(recent).findByRole("img", { name: "Running" });
    expect(within(recent).getByRole("img", { name: "Needs your input" })).toBeInTheDocument();
    expect(within(recent).getByRole("img", { name: "Failed" })).toBeInTheDocument();
    expect(document.querySelectorAll(".chat-list-row[aria-current]")).toHaveLength(0);
  });

  it("sorts and deduplicates recent chats, then opens a chat from another project on Home", async () => {
    renderShell();
    const recent = screen.getByRole("region", { name: "Recent" });
    await within(recent).findByRole("button", { name: "Latest beta chat" });
    expect(within(recent).getAllByRole("button").map((button) => button.textContent)).toEqual(["Latest beta chat", "Older alpha chat"]);
    goTo("Projects");
    fireEvent.click(within(recent).getByRole("button", { name: "Latest beta chat" }));
    expect(await screen.findByText("Conversation new")).toBeInTheDocument();
    expect(useAppStore.getState()).toMatchObject({ selectedProjectId: "beta", selectedCodexChatId: "new" });
    expect(screen.getByRole("region", { name: "Home page" })).toBeInTheDocument();
  });

  it("replaces the content page for each destination and responds to browser history", async () => {
    renderShell();
    await screen.findByRole("button", { name: "Expand Alpha" });
    goTo("Scheduled");
    expect(screen.getByRole("heading", { name: "Scheduled work is coming" })).toBeInTheDocument();
    expect(screen.queryByText("Start a conversation")).not.toBeInTheDocument();
    goTo("Tasks");
    expect(screen.getByText("Task board content")).toBeInTheDocument();
    goTo("Settings");
    expect(screen.getByText("Settings page content")).toBeInTheDocument();
    expect(screen.queryByRole("complementary", { name: "Navigation and chats" })).not.toBeInTheDocument();
    act(() => { window.history.replaceState(null, "", "/#projects"); window.dispatchEvent(new HashChangeEvent("hashchange")); });
    expect(screen.getByRole("region", { name: "Projects page" })).toBeInTheDocument();
  });

  it("opens tools on the left while keeping the conversation and file preview in the main pane", async () => {
    useAppStore.setState({ selectedCodexChatId: "old" });
    renderShell();
    await screen.findByRole("button", { name: "Expand Alpha" });
    await screen.findByText("Conversation old");
    act(() => window.dispatchEvent(new CustomEvent("boosted:open-panel", { detail: "files" })));
    const panel = screen.getByRole("complementary", { name: "Project tools panel" });
    expect(within(panel).getByText("Files content")).toBeInTheDocument();
    expect(screen.getByText("Conversation old")).toBeInTheDocument();
    act(() => window.dispatchEvent(new Event("boosted:open-file")));
    expect(screen.getByText("Editor content")).toBeInTheDocument();
    expect(within(panel).getByText("Files content")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Back to chat" }));
    expect(await screen.findByText("Conversation old")).toBeInTheDocument();
    act(() => window.dispatchEvent(new CustomEvent("boosted:open-panel", { detail: "git" })));
    expect(screen.queryByText("Files content")).not.toBeInTheDocument();
    expect(screen.getByText("Changes content")).toBeInTheDocument();
    expect(within(panel).getAllByRole("button").map((button) => button.getAttribute("aria-label"))).toEqual(["Files", "Changes", "Close project tools"]);
    for (const removed of ["plan", "terminal"]) {
      act(() => window.dispatchEvent(new CustomEvent("boosted:open-panel", { detail: removed })));
      act(() => window.dispatchEvent(new CustomEvent("boosted:toggle-panel", { detail: removed })));
      expect(within(panel).getByText("Changes content")).toBeInTheDocument();
    }
    fireEvent.click(within(panel).getByRole("button", { name: "Close project tools" }));
    expect(screen.queryByRole("complementary", { name: "Project tools panel" })).not.toBeInTheDocument();
    expect(screen.getByText("Conversation old")).toBeInTheDocument();
    act(() => window.dispatchEvent(new CustomEvent("boosted:open-panel", { detail: "files" })));
    expect(screen.getByText("Files content")).toBeInTheDocument();
    act(() => window.dispatchEvent(new CustomEvent("boosted:open-codex-chat", { detail: { threadId: "old", split: true } })));
    await screen.findByText("Conversation old");
    act(() => window.dispatchEvent(new CustomEvent("boosted:open-codex-chat", { detail: { threadId: "new", split: true } })));
    expect(await screen.findByText("Conversation new")).toBeInTheDocument();
    expect(screen.queryByText("Conversation old")).not.toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "Content" })).getByRole("complementary", { name: "Navigation and chats" })).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "Content" })).queryByRole("navigation", { name: "Primary navigation" })).not.toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "Primary navigation" })).toBeInTheDocument();
  });

  it("starts projects collapsed and loads four chats at a time from the full project row", async () => {
    apiMock.codexChats.mockResolvedValue(Array.from({ length: 9 }, (_, index) => ({ ...chats[0], id: `alpha-${index}`, title: `Alpha chat ${index}` })));
    renderShell();
    const projectList = screen.getByRole("region", { name: "Projects" });
    const projectRow = await within(projectList).findByRole("button", { name: "Expand Alpha" });
    expect(projectRow).toHaveAttribute("aria-expanded", "false");
    expect(within(projectList).queryByText("Alpha chat 0")).not.toBeInTheDocument();
    fireEvent.click(projectRow);
    expect(within(projectList).getAllByRole("button", { name: /^Alpha chat/ })).toHaveLength(4);
    fireEvent.click(within(projectList).getByRole("button", { name: "Load more" }));
    expect(within(projectList).getAllByRole("button", { name: /^Alpha chat/ })).toHaveLength(8);
    fireEvent.click(within(projectList).getByRole("button", { name: "Collapse Alpha" }));
    expect(within(projectList).queryByRole("button", { name: /^Alpha chat/ })).not.toBeInTheDocument();
    fireEvent.click(within(projectList).getByRole("button", { name: "Expand Alpha" }));
    expect(within(projectList).getAllByRole("button", { name: /^Alpha chat/ })).toHaveLength(4);
  });

  it("keeps recent chats searchable when a project is collapsed", async () => {
    renderShell();
    await screen.findByRole("button", { name: "Expand Alpha" });
    expect(screen.queryByRole("textbox", { name: "Search chats" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Search chats" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Search chats" }), { target: { value: "beta" } });
    expect(within(screen.getByRole("region", { name: "Recent" })).getByRole("button", { name: "Latest beta chat" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Older alpha chat" })).not.toBeInTheDocument();
  });
});
