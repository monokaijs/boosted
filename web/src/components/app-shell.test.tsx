import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useAppStore } from "@/lib/store";
import type { CodexChat, Project } from "@/lib/types";

const apiMock = vi.hoisted(() => {
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key), clear: () => values.clear() });
  return { projects: vi.fn(), codexChats: vi.fn(), logout: vi.fn(), agents: vi.fn() };
});
vi.mock("@/lib/api", () => ({ api: apiMock, setToken: vi.fn() }));
vi.mock("@/lib/api-context", () => ({ useBoostedApiClient: () => ({ profileId: "test-machine" }) }));
vi.mock("@/features/agents/lib/api-client", () => ({ apiClient: { assistant: { list: apiMock.agents } } }));
vi.mock("@/hooks/use-live-events", () => ({ useLiveEvents() {} }));
vi.mock("@/hooks/use-notification-navigation", () => ({ useNotificationNavigation() {} }));
vi.mock("@/lib/updater", () => ({ useAppUpdateState: () => ({ phase: "idle" }), formatUpdateProgress: () => undefined }));
vi.mock("@/features/agents/agents-panel", () => ({ openProvidersEvent: "boosted:open-providers", AgentsPanel: ({ selectedId, selectAgent }: { selectedId: string; selectAgent(id: string): void }) => <><p>Agent conversation {selectedId}</p><button onClick={() => selectAgent("pock")}>Switch to Pock</button></> }));
vi.mock("@/components/settings-page", () => ({ SettingsPage: () => <h1>Settings page content</h1> }));
vi.mock("@/components/create-dialogs", () => ({ ForcePasswordDialog: () => null, NewTaskDialog: () => null, OpenProjectDialog: () => null }));
vi.mock("@/components/machine-manager", () => ({ MachineSwitcher: () => <span>Test machine</span> }));
vi.mock("@/components/panels/chat-panel", () => ({ NewChatPanel: () => <h1>Start a conversation</h1>, TaskPanel: () => <p>Task detail content</p> }));
vi.mock("@/components/panels/codex-chat-panel", () => ({ CodexChatPanel: ({ threadId }: { threadId: string }) => <p>Conversation {threadId}</p> }));
vi.mock("@/components/panels/editor-panel", () => ({ EditorPanel: () => <p>Editor content</p> }));
vi.mock("@/components/panels/files-panel", () => ({ FilesPanel: () => <p>Files content</p> }));
vi.mock("@/components/panels/git-panel", () => ({ GitPanel: () => <p>Changes content</p> }));
vi.mock("@/components/panels/plan-panel", () => ({ PlanPanel: () => <p>Plan content</p> }));
vi.mock("@/components/panels/taskboard-panel", () => ({ TaskboardPanel: () => <h1>Task board content</h1> }));
vi.mock("@/components/panels/terminal-panel", () => ({ TerminalPanel: () => <p>Terminal content</p> }));

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
  window.history.replaceState(null, "", "/");
  localStorage.clear();
  useAppStore.setState({ selectedProjectId: "alpha", selectedCodexChatId: undefined, selectedTaskId: undefined, openFilePath: undefined, taskDrawerOpen: false, activeMachineId: undefined });
  apiMock.projects.mockResolvedValue(projects);
  apiMock.codexChats.mockResolvedValue([...chats, chats[0]]);
  apiMock.agents.mockResolvedValue([
    { id: "pock", profile: { name: "Pock" } },
    { id: "sage", profile: { name: "Sage", avatar: "/sage.png" } },
  ]);
});

describe("page navigation and conversations", () => {
  it("opens the chosen agent from another page and keeps the avatar selection in sync", async () => {
    renderShell();
    const agents = await screen.findByRole("navigation", { name: "Agents" });
    const sage = await within(agents).findByRole("button", { name: "Sage" });
    expect(within(agents).getAllByRole("button")).toHaveLength(2);
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
    act(() => window.dispatchEvent(new CustomEvent("boosted:open-panel", { detail: "terminal" })));
    const terminal = await screen.findByText("Terminal content");
    const terminalPage = terminal.closest(".tool-panel-slot") as HTMLElement;
    expect(terminalPage).not.toHaveAttribute("hidden");
    fireEvent.click(within(panel).getByRole("button", { name: "Close project tools" }));
    expect(panel).toHaveAttribute("hidden");
    expect(screen.getByText("Conversation old")).toBeInTheDocument();
    act(() => window.dispatchEvent(new CustomEvent("boosted:open-panel", { detail: "terminal" })));
    expect(panel).not.toHaveAttribute("hidden");
    expect(screen.getByText("Terminal content")).toBe(terminal);
    expect(screen.getByText("Conversation old")).toBeInTheDocument();
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
