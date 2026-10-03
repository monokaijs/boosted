import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { machinePreferenceKey, useAppStore } from "@/lib/store";
import type { Task } from "@/lib/types";

const api = vi.hoisted(() => ({ projects: vi.fn(), codexOptions: vi.fn(), threadCodexOptions: vi.fn(), codexChat: vi.fn(), codexApprovals: vi.fn(), createCodexChat: vi.fn(), sendCodexMessage: vi.fn(), task: vi.fn(), taskEvents: vi.fn(), startTaskPlan: vi.fn(), approvePlan: vi.fn(), sendMessage: vi.fn() }));
vi.mock("@/lib/api", () => ({ api }));
import { NewChatPanel, TaskPanel } from "./chat-panel";
import { CodexChatPanel } from "./codex-chat-panel";

const task: Task = {
  id: "task-a", projectId: "project-a", title: "Ship a feature", description: "Keep planning in chat.", status: "ready",
  branchName: "task-a", worktreePath: "/repo", baseBranch: "main", accessMode: "fullAccess", createdBy: "user", createdAt: "now", updatedAt: "now", additions: 0, deletions: 0, attachments: [],
  plan: { revision: 3, explanation: "Use the existing chat flow.", markdown: "## Design details\n\nKeep **all planning context**.", steps: [{ step: "Inspect the chat", status: "completed" }, { step: "Implement the change", status: "in_progress" }] },
};

function renderPanel(panel: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{panel}</QueryClientProvider>);
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
beforeEach(() => {
  vi.clearAllMocks();
  // jsdom has no layout scrolling or resize notifications for the chat viewport.
  if (!HTMLElement.prototype.scrollTo) HTMLElement.prototype.scrollTo = vi.fn();
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  useAppStore.setState({ selectedProjectId: "project-a", selectedTaskId: "task-a", activeMachineId: undefined });
  api.projects.mockResolvedValue([{ id: "project-a", name: "Project", repoPath: "/repo" }]);
  api.codexOptions.mockResolvedValue({ models: [{ id: "model", model: "model", displayName: "Model", defaultReasoningEffort: "high", supportedReasoningEfforts: [{ id: "high" }], inputModalities: [] }], defaultModel: "model", defaultAccessMode: "fullAccess", accessModes: [{ id: "fullAccess", label: "Full access" }] });
  api.createCodexChat.mockResolvedValue({ id: "chat-a" });
  api.sendCodexMessage.mockResolvedValue({ threadId: "chat-a", turnId: "turn-a" });
  api.task.mockResolvedValue(task);
  api.taskEvents.mockResolvedValue([]);
  api.startTaskPlan.mockResolvedValue(task);
  api.approvePlan.mockResolvedValue(task);
  api.sendMessage.mockResolvedValue(task);
  api.threadCodexOptions.mockImplementation(api.codexOptions);
  api.codexApprovals.mockResolvedValue([]);
  api.codexChat.mockResolvedValue({
    chat: { id: "chat-a", title: "Planning chat", status: "idle", cwd: "/repo", model: "model" },
    runtimeDefaults: { model: "model", reasoningEffort: "high", accessMode: "fullAccess", collaborationMode: "plan" },
    messages: [{ id: "plan-a", role: "assistant", kind: "plan", content: "## Proposed work\n\nKeep the plan in this chat." }],
  });
});

describe("planning in chats", () => {
  it("restores Plan mode and the proposed plan in an existing conversation and sends planning followups", async () => {
    renderPanel(<CodexChatPanel threadId="chat-a" />);
    expect(within(await screen.findByRole("button", { name: "Chat mode" })).getByText("Plan")).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "Proposed work" })).toBeInTheDocument();
    const input = screen.getByPlaceholderText("Message Codex...");
    fireEvent.change(input, { target: { value: "Refine the plan" } });
    fireEvent.click(screen.getByTitle("Send message"));
    await waitFor(() => expect(api.sendCodexMessage).toHaveBeenCalledWith("chat-a", "Refine the plan", expect.any(String), expect.objectContaining({ collaborationMode: "plan" })));
    expect(screen.getByRole("button", { name: "Chat mode" })).toBeDisabled();
  });

  it("starts a general chat in Plan mode and lets the next chat switch to execution", async () => {
    localStorage.setItem(machinePreferenceKey("boosted.codex.mode"), "plan");
    renderPanel(<NewChatPanel />);
    expect(within(await screen.findByRole("button", { name: "Chat mode" })).getByText("Plan")).toBeInTheDocument();
    fireEvent.change(await screen.findByPlaceholderText("Ask anything…"), { target: { value: "Plan the feature" } });
    await waitFor(() => expect(screen.getByRole("button", { name: "Create chat" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Create chat" }));
    await waitFor(() => expect(api.sendCodexMessage).toHaveBeenCalledWith("chat-a", "Plan the feature", expect.any(String), expect.objectContaining({ collaborationMode: "plan" })));
    await waitFor(() => expect(screen.getByRole("button", { name: "Chat mode" })).toBeEnabled());
    fireEvent.pointerDown(screen.getByRole("button", { name: "Chat mode" }), { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByRole("menuitemradio", { name: /Work on requests/ }));
    expect(localStorage.getItem(machinePreferenceKey("boosted.codex.mode"))).toBe("default");
    fireEvent.change(screen.getByPlaceholderText("Ask anything…"), { target: { value: "Implement the plan" } });
    fireEvent.click(screen.getByRole("button", { name: "Create chat" }));
    await waitFor(() => expect(api.sendCodexMessage).toHaveBeenLastCalledWith("chat-a", "Implement the plan", expect.any(String), expect.objectContaining({ collaborationMode: "default" })));
  });

  it("shows full plan details and progress, approves the current revision, and accepts revisions in task chat", async () => {
    renderPanel(<TaskPanel />);
    const plan = await screen.findByRole("region", { name: "Task plan" });
    expect(within(plan).getByRole("heading", { name: "Design details" })).toBeInTheDocument();
    expect(within(plan).getByText("all planning context").tagName).toBe("STRONG");
    expect(within(plan).getByText("Inspect the chat")).toHaveClass("line-through");
    expect(within(plan).getByText("Implement the change").closest("li")).toHaveAttribute("aria-current", "step");
    fireEvent.click(within(plan).getByRole("button", { name: "Approve and run" }));
    await waitFor(() => expect(api.approvePlan).toHaveBeenCalledWith("task-a", 3));
    const input = screen.getByPlaceholderText("Ask for a plan revision, or approve the plan…");
    fireEvent.change(input, { target: { value: "Add a verification step" } });
    fireEvent.submit(input.closest("form")!);
    await waitFor(() => expect(api.sendMessage).toHaveBeenCalledWith("task-a", "Add a verification step"));
  });

  it("starts planning from a queued task and shows approval status during execution", async () => {
    api.task.mockResolvedValue({ ...task, status: "queued", plan: undefined });
    const view = renderPanel(<TaskPanel />);
    fireEvent.click(await screen.findByRole("button", { name: "Start planning" }));
    await waitFor(() => expect(api.startTaskPlan).toHaveBeenCalledWith("task-a"));
    view.unmount();
    api.task.mockResolvedValue({ ...task, status: "running", plan: { ...task.plan, approvedAt: "now" } });
    renderPanel(<TaskPanel />);
    expect(await screen.findByText("Plan approved")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Approve and run" })).not.toBeInTheDocument();
  });
});
