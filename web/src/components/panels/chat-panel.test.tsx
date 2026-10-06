/// <reference types="node" />

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { machinePreferenceKey, useAppStore } from "@/lib/store";
import { applyCodexEvent } from "@/lib/codex-chat-state";
import type { Task, TaskEvent } from "@/lib/types";

const api = vi.hoisted(() => ({ toggleMarkdownCheckbox: vi.fn(), projects: vi.fn(), projectBranches: vi.fn(), projectBranch: vi.fn(), switchProjectBranch: vi.fn(), codexOptions: vi.fn(), threadCodexOptions: vi.fn(), codexChat: vi.fn(), codexApprovals: vi.fn(), codexAttachment: vi.fn(), uploadCodexAttachment: vi.fn(), workspaceFile: vi.fn(), createCodexChat: vi.fn(), sendCodexMessage: vi.fn(), task: vi.fn(), taskEvents: vi.fn(), startTaskPlan: vi.fn(), approvePlan: vi.fn(), sendMessage: vi.fn(), answerTaskQuestions: vi.fn() }));
vi.mock("@/lib/api", () => ({ api }));
vi.mock("@/lib/api-context", () => ({ useBoostedApiClient: () => api }));
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
  api.projectBranches.mockResolvedValue(["main", "feature"]);
  api.projectBranch.mockResolvedValue({ branch: "main" });
  api.switchProjectBranch.mockResolvedValue({ branch: "feature" });
  api.codexOptions.mockResolvedValue({ models: [{ id: "model", model: "model", displayName: "Model", defaultReasoningEffort: "high", supportedReasoningEfforts: [{ id: "high" }], inputModalities: [] }], defaultModel: "model", defaultAccessMode: "fullAccess", accessModes: [{ id: "fullAccess", label: "Full access" }] });
  api.createCodexChat.mockResolvedValue({ id: "chat-a" });
  api.sendCodexMessage.mockResolvedValue({ threadId: "chat-a", turnId: "turn-a" });
  api.task.mockResolvedValue(task);
  api.taskEvents.mockResolvedValue([]);
  api.startTaskPlan.mockResolvedValue(task);
  api.approvePlan.mockResolvedValue(task);
  api.sendMessage.mockResolvedValue(task);
  api.answerTaskQuestions.mockResolvedValue(task);
  api.threadCodexOptions.mockImplementation(api.codexOptions);
  api.codexApprovals.mockResolvedValue([]);
  api.codexChat.mockResolvedValue({
    chat: { id: "chat-a", title: "Planning chat", status: "idle", cwd: "/repo", model: "model" },
    runtimeDefaults: { model: "model", reasoningEffort: "high", accessMode: "fullAccess", collaborationMode: "plan" },
    messages: [{ id: "plan-a", role: "assistant", kind: "plan", content: "## Proposed work\n\nKeep the plan in this chat." }],
  });
});

it("keeps the Codex composer outside transcript scroll ownership", async () => {
  const { container } = renderPanel(<CodexChatPanel threadId="chat-a" />);
  const input = await screen.findByPlaceholderText("Message Codex...");
  const transcript = container.querySelector(".codex-thread-viewport")!;
  expect(transcript).not.toContainElement(input);
  expect(container.querySelector(".codex-composer-footer")?.parentElement).toBe(transcript.parentElement);
  fireEvent.change(input, { target: { value: "Multiple\nlines\nremain editable" } });
  expect(input).toHaveValue("Multiple\nlines\nremain editable");
});

it("keeps a replacement coding thread in its embedded view", async () => {
  useAppStore.setState({ selectedGroupId: "group-a", selectedCodexChatId: "chat-a" });
  api.sendCodexMessage.mockResolvedValueOnce({ threadId: "replacement-chat", turnId: "turn-b" });
  const onThreadChange = vi.fn();
  const navigate = vi.fn();
  window.addEventListener("boosted:open-codex-chat", navigate);
  try {
    renderPanel(<CodexChatPanel threadId="chat-a" onThreadChange={onThreadChange} />);
    const input = await screen.findByPlaceholderText("Message Codex...");
    fireEvent.change(input, { target: { value: "Continue coding" } });
    fireEvent.click(screen.getByTitle("Send message"));
    await waitFor(() => expect(onThreadChange).toHaveBeenCalledWith("replacement-chat"));
    expect(useAppStore.getState()).toMatchObject({ selectedGroupId: "group-a", selectedCodexChatId: "chat-a" });
    expect(navigate).not.toHaveBeenCalled();
  } finally { window.removeEventListener("boosted:open-codex-chat", navigate); }
});

describe("sending in place", () => {
  for (const newChat of [true, false]) {
    describe(newChat ? "new chat" : "task chat", () => {
      it.each(["click", "keyboard", "submit"])("sends via %s without native navigation and rejects repeated sends while pending", async (method) => {
        let finish!: (result: Task | { id: string }) => void;
        const mutation = newChat ? api.createCodexChat : api.sendMessage;
        mutation.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
        renderPanel(newChat ? <NewChatPanel /> : <TaskPanel />);
        const input = await screen.findByPlaceholderText(newChat ? "Ask anything…" : "Ask for a plan revision, or approve the plan…");
        const form = input.closest("form")!;
        const nativeSubmit = vi.fn();
        form.addEventListener("submit", nativeSubmit);
        const href = window.location.href;
        fireEvent.change(input, { target: { value: "  Stay in this page  " } });
        const button = screen.getByRole("button", { name: newChat ? "Create chat" : "Send message" });
        expect(button).toHaveAttribute("type", "button");
        if (method === "click") fireEvent.click(button);
        else if (method === "keyboard") {
          expect(fireEvent.keyDown(input, { key: "Enter", ctrlKey: newChat })).toBe(false);
        } else {
          expect(fireEvent.submit(form)).toBe(false);
        }
        if (method !== "submit") expect(nativeSubmit).not.toHaveBeenCalled();
        await waitFor(() => expect(mutation).toHaveBeenCalledTimes(1));
        expect(button).toBeDisabled();
        // Programmatic submit and shortcuts must obey the pending guard too.
        expect(fireEvent.submit(form)).toBe(false);
        expect(fireEvent.keyDown(input, { key: "Enter", ctrlKey: newChat })).toBe(false);
        expect(mutation).toHaveBeenCalledTimes(1);
        await act(async () => finish(newChat ? { id: "chat-a" } : task));
        await waitFor(() => expect(input).toHaveValue(""));
        expect(input).toBeInTheDocument();
        expect(input.closest("form")).toBe(form);
        expect(window.location.href).toBe(href);
        if (newChat) {
          expect(api.sendCodexMessage).toHaveBeenCalledWith("chat-a", "Stay in this page", expect.any(String), expect.any(Object));
          expect(useAppStore.getState().selectedCodexChatId).toBe("chat-a");
        } else expect(api.sendMessage).toHaveBeenCalledWith("task-a", "Stay in this page");
      });

      it("preserves multiline editing and composition, and cancels empty submissions", async () => {
        renderPanel(newChat ? <NewChatPanel /> : <TaskPanel />);
        const input = await screen.findByPlaceholderText(newChat ? "Ask anything…" : "Ask for a plan revision, or approve the plan…");
        expect(fireEvent.submit(input.closest("form")!)).toBe(false);
        fireEvent.change(input, { target: { value: "Draft" } });
        expect(fireEvent.keyDown(input, { key: "Enter", shiftKey: true, ctrlKey: newChat })).toBe(true);
        expect(fireEvent.keyDown(input, { key: "Enter", isComposing: true, ctrlKey: newChat })).toBe(true);
        if (newChat) expect(fireEvent.keyDown(input, { key: "Enter" })).toBe(true);
        expect(api.createCodexChat).not.toHaveBeenCalled();
        expect(api.sendMessage).not.toHaveBeenCalled();
        expect(input).toHaveValue("Draft");
      });

      it("keeps a failed send and its draft in place", async () => {
        const mutation = newChat ? api.createCodexChat : api.sendMessage;
        mutation.mockRejectedValueOnce(new Error("Unable to send"));
        renderPanel(newChat ? <NewChatPanel /> : <TaskPanel />);
        const input = await screen.findByPlaceholderText(newChat ? "Ask anything…" : "Ask for a plan revision, or approve the plan…");
        fireEvent.change(input, { target: { value: "Retry this draft" } });
        fireEvent.click(screen.getByRole("button", { name: newChat ? "Create chat" : "Send message" }));
        expect(await screen.findByText("Unable to send")).toBeInTheDocument();
        expect(input).toHaveValue("Retry this draft");
        expect(input).toBeInTheDocument();
      });
    });
  }
});

describe("message entrance", () => {
  it("animates task messages on entrance and preserves their nodes on updates", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const messages: TaskEvent[] = [
      { id: 1, taskId: task.id, kind: "user_message", payload: { text: "User message" }, createdAt: "now" },
      { id: 2, taskId: task.id, kind: "agent_message", payload: { text: "Assistant message" }, createdAt: "now" },
    ];
    api.taskEvents.mockResolvedValue(messages);
    const view = render(<QueryClientProvider client={client}><TaskPanel /></QueryClientProvider>);
    const user = (await screen.findByText("User message")).closest("article");
    const assistant = screen.getByText("Assistant message").closest("article");
    expect(user).toHaveClass("chat-message-enter");
    expect(assistant).toHaveClass("chat-message-enter");
    act(() => client.setQueryData(["events", task.id], [...messages.slice(0, 1), { ...messages[1], payload: { text: "Updated assistant message" } }, { ...messages[0], id: 3, payload: { text: "Next message" } }]));
    expect((await screen.findByText("Updated assistant message")).closest("article")).toBe(assistant);
    expect(screen.getByText("User message").closest("article")).toBe(user);
    expect(screen.getByText("Next message").closest("article")).toHaveClass("chat-message-enter");
    view.unmount(); client.clear();
  });

  it("animates Codex user and assistant messages without remounting streamed text", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = render(<QueryClientProvider client={client}><CodexChatPanel threadId="chat-a" /></QueryClientProvider>);
    const assistant = (await screen.findByRole("heading", { name: "Proposed work" })).closest(".chat-message-enter");
    expect(assistant).toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText("Message Codex..."), { target: { value: "New user message" } });
    fireEvent.click(screen.getByTitle("Send message"));
    expect((await screen.findByText("New user message")).closest(".chat-message-enter")).toBeInTheDocument();
    act(() => applyCodexEvent(client, { threadId: "chat-a", turnId: "turn-a", method: "item/agentMessage/delta", itemId: "plan-a", delta: " More detail." }));
    expect(await screen.findByText("Keep the plan in this chat. More detail.")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Proposed work" }).closest(".chat-message-enter")).toBe(assistant);
    view.unmount(); client.clear();
  });

  it("gates the blur and fly-up animation on no-preference with no persistent fill", () => {
    // jsdom does not evaluate reduced-motion media queries or run animations;
    // inspect the parsed CSS rules to verify the motion preference contract.
    const style = document.createElement("style");
    style.textContent = readFileSync(`${import.meta.dirname}/chat-panel.css`, "utf8");
    document.head.append(style);
    try {
      const rules = Array.from(style.sheet!.cssRules);
      const keyframes = rules.find((rule) => rule.cssText.startsWith("@keyframes")) as CSSKeyframesRule;
      expect(keyframes.name).toBe("chat-message-enter");
      const frames = Array.from(keyframes.cssRules) as CSSKeyframeRule[];
      expect(frames[0].style.opacity).toBe("0");
      expect(frames[0].style.filter).toBe("blur(3px)");
      expect(frames[0].style.transform).toBe("translateY(6px)");
      expect(frames[1].style.opacity).toBe("1");
      expect(frames[1].style.filter).toBe("blur(0)");
      expect(frames[1].style.transform).toBe("translateY(0)");
      const media = rules.find((rule) => rule.type === CSSRule.MEDIA_RULE) as CSSMediaRule;
      expect(media.conditionText).toBe("(prefers-reduced-motion: no-preference)");
      expect(rules.filter((rule) => rule.type === CSSRule.STYLE_RULE)).toHaveLength(0);
      const animation = media.cssRules[0] as CSSStyleRule;
      expect(animation.selectorText).toBe(".chat-message-enter");
      expect(animation.style.animation).toBe("chat-message-enter 240ms cubic-bezier(0.16, 1, 0.3, 1)");
      expect(animation.style.getPropertyValue("animation-fill-mode")).toBe("");
    } finally { style.remove(); }
  });
});

describe("planning in chats", () => {
  it("shows the checked-out branch, removes Local, and waits for branch switching before sending", async () => {
    api.projects.mockResolvedValue([{ id: "project-a", name: "Project", repoPath: "/repo", defaultBranch: "obsolete" }]);
    let finishSwitch!: (result: { branch: string }) => void;
    api.switchProjectBranch.mockImplementationOnce(() => new Promise((resolve) => { finishSwitch = resolve; }));
    renderPanel(<NewChatPanel />);
    const selector = await screen.findByRole("button", { name: "Select branch" });
    await waitFor(() => expect(selector).toHaveTextContent("main"));
    expect(screen.queryByText("Local")).not.toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText("Ask anything…"), { target: { value: "Work on feature" } });
    fireEvent.pointerDown(selector, { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByRole("menuitemradio", { name: "feature" }));
    await waitFor(() => expect(api.switchProjectBranch).toHaveBeenCalledWith("project-a", "feature"));
    expect(screen.getByRole("button", { name: "Create chat" })).toBeDisabled();
    fireEvent.submit(screen.getByPlaceholderText("Ask anything…").closest("form")!);
    expect(api.createCodexChat).not.toHaveBeenCalled();
    await act(async () => finishSwitch({ branch: "feature" }));
    await waitFor(() => expect(selector).toHaveTextContent("feature"));
    expect(screen.getByRole("button", { name: "Create chat" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Create chat" }));
    await waitFor(() => expect(api.createCodexChat).toHaveBeenCalledWith("/repo", expect.any(String)));
  });

  it("keeps the actual branch selected when checkout fails", async () => {
    api.switchProjectBranch.mockRejectedValueOnce(new Error("Your local changes would be overwritten"));
    renderPanel(<NewChatPanel />);
    const selector = await screen.findByRole("button", { name: "Select branch" });
    await waitFor(() => expect(selector).toHaveTextContent("main"));
    fireEvent.pointerDown(selector, { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByRole("menuitemradio", { name: "feature" }));
    expect(await screen.findByText("Your local changes would be overwritten")).toBeInTheDocument();
    expect(selector).toHaveTextContent("main");
    expect(selector).toBeEnabled();
  });

  it("loads the branch for the newly selected project", async () => {
    api.projects.mockResolvedValue([
      { id: "project-a", name: "Project", repoPath: "/repo", defaultBranch: "main" },
      { id: "project-b", name: "Other project", repoPath: "/other", defaultBranch: "main" },
    ]);
    api.projectBranch.mockImplementation(async (id: string) => ({ branch: id === "project-a" ? "feature" : "release" }));
    api.projectBranches.mockImplementation(async (id: string) => id === "project-a" ? ["main", "feature"] : ["main", "release"]);
    renderPanel(<NewChatPanel />);
    const selector = await screen.findByRole("button", { name: "Select branch" });
    await waitFor(() => expect(selector).toHaveTextContent("feature"));
    fireEvent.pointerDown(screen.getByRole("button", { name: "Project" }), { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByRole("menuitemradio", { name: "Other project" }));
    await waitFor(() => expect(selector).toHaveTextContent("release"));
    expect(api.projectBranch).toHaveBeenCalledWith("project-b");
    fireEvent.pointerDown(selector, { button: 0, ctrlKey: false });
    expect(await screen.findByRole("menuitemradio", { name: "release" })).toHaveAttribute("aria-checked", "true");
    expect(screen.queryByRole("menuitemradio", { name: "feature" })).not.toBeInTheDocument();
  });

  it("uses a configured preset instead of the remembered model and keeps a composer override", async () => {
    localStorage.setItem(machinePreferenceKey("boosted.codex.model"), "old-model");
    localStorage.setItem(machinePreferenceKey("boosted.codex.effort"), "high");
    api.codexOptions.mockResolvedValue({
      models: [
        { id: "old-model", model: "old-model", displayName: "Old Model", defaultReasoningEffort: "high", supportedReasoningEfforts: [{ id: "high" }] },
        { id: "preset-model", model: "preset-model", displayName: "Preset Model", defaultReasoningEffort: "low", supportedReasoningEfforts: [{ id: "low" }, { id: "high" }] },
      ],
      defaultModel: "preset-model", hasModelPreset: true, defaultAccessMode: "fullAccess", accessModes: [{ id: "fullAccess", label: "Full access" }],
    });
    renderPanel(<NewChatPanel />);
    fireEvent.change(await screen.findByPlaceholderText("Ask anything…"), { target: { value: "Use the preset" } });
    await waitFor(() => expect(screen.getByRole("button", { name: "Create chat" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Create chat" }));
    await waitFor(() => expect(api.sendCodexMessage).toHaveBeenCalledWith("chat-a", "Use the preset", expect.any(String), expect.objectContaining({ model: "preset-model", reasoningEffort: "low" })));
    await waitFor(() => expect(screen.getByRole("button", { name: "Preset Model" })).toBeEnabled());
    fireEvent.pointerDown(screen.getByRole("button", { name: "Preset Model" }), { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByRole("menuitemradio", { name: "Old Model" }));
    fireEvent.change(screen.getByPlaceholderText("Ask anything…"), { target: { value: "Use my override" } });
    fireEvent.click(screen.getByRole("button", { name: "Create chat" }));
    await waitFor(() => expect(api.sendCodexMessage).toHaveBeenLastCalledWith("chat-a", "Use my override", expect.any(String), expect.objectContaining({ model: "old-model", reasoningEffort: "high" })));
  });

  it("restores a draft and receives streaming updates while the conversation is hidden", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = (visible: boolean) => <QueryClientProvider client={client}>{visible ? <CodexChatPanel threadId="chat-a" /> : <div>Settings</div>}</QueryClientProvider>;
    const result = render(view(true));
    await screen.findByRole("heading", { name: "Proposed work" });
    fireEvent.change(screen.getByPlaceholderText("Message Codex..."), { target: { value: "Keep this draft" } });
    result.rerender(view(false));
    act(() => {
      applyCodexEvent(client, { threadId: "chat-a", turnId: "turn", method: "turn/started" });
      applyCodexEvent(client, { threadId: "chat-a", turnId: "turn", method: "item/agentMessage/delta", itemId: "answer", delta: "Arrived while hidden" });
    });
    result.rerender(view(true));
    expect(await screen.findByText("Arrived while hidden")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Message Codex...")).toHaveValue("Keep this draft");
    expect(screen.getByRole("button", { name: "Chat mode" })).toBeDisabled();
    expect(api.codexChat).toHaveBeenCalledTimes(1);
    result.unmount(); client.clear();
  });

  it("keeps new-chat and task drafts separate across view switches", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = (taskView: boolean) => <QueryClientProvider client={client}>{taskView ? <TaskPanel /> : <NewChatPanel />}</QueryClientProvider>;
    const result = render(view(false));
    fireEvent.change(await screen.findByPlaceholderText("Ask anything…"), { target: { value: "New chat draft" } });
    result.rerender(view(true));
    fireEvent.change(await screen.findByPlaceholderText("Ask for a plan revision, or approve the plan…"), { target: { value: "Task draft" } });
    result.rerender(view(false));
    expect(screen.getByPlaceholderText("Ask anything…")).toHaveValue("New chat draft");
    result.rerender(view(true));
    expect(screen.getByPlaceholderText("Ask for a plan revision, or approve the plan…")).toHaveValue("Task draft");
    result.unmount(); client.clear();
  });

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

  it("shows Codex choices with the normal question flow instead of a direct reply box", async () => {
    api.task.mockResolvedValue({ ...task, status: "needs_input" });
    api.taskEvents.mockResolvedValue([{ id: 7, taskId: "task-a", kind: "agent_message", createdAt: "now", payload: {
      text: "Should skipping the banner enable analytics cookies?",
      questions: [{ id: "analytics", header: "Analytics", question: "What should happen when no choice is saved?", options: [
        { label: "Keep disabled", description: "Wait for explicit opt-in." },
        { label: "Enable analytics", description: "Treat dismissal as consent." },
      ] }],
    } } satisfies TaskEvent]);
    renderPanel(<TaskPanel />);
    expect(await screen.findByText("Should skipping the banner enable analytics cookies?")).toBeInTheDocument();
    expect(screen.queryByPlaceholderText("Reply to Codex…")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Answer question" }));
    fireEvent.click(await screen.findByRole("radio", { name: "Keep disabled" }));
    fireEvent.click(screen.getByRole("button", { name: "Send answers" }));
    await waitFor(() => expect(api.answerTaskQuestions).toHaveBeenCalledWith("task-a", { analytics: { answers: ["Keep disabled"] } }));
  });
});


describe("Codex attachments", () => {
  beforeEach(() => {
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: vi.fn(() => "blob:image"), revokeObjectURL: vi.fn() }));
    api.codexAttachment.mockResolvedValue({ blob: new Blob(["image"], { type: "image/png" }) });
    api.workspaceFile.mockResolvedValue({ blob: new Blob(["image"], { type: "image/png" }) });
  });

  it("renders image-only saved and live messages with a viewer", async () => {
    api.codexChat.mockResolvedValueOnce({
      chat: { id: "chat-a", title: "Images", status: "idle", cwd: "/repo", model: "model" },
      messages: [{ id: "saved", role: "user", kind: "message", content: "", attachments: [{ name: "saved.png", mimeType: "image/png", path: "/uploads/saved.png" }] }],
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const result = render(<QueryClientProvider client={client}><CodexChatPanel threadId="chat-a" /></QueryClientProvider>);
    expect(await screen.findByRole("img", { name: "saved.png" })).toBeInTheDocument();
    expect(api.workspaceFile).toHaveBeenCalledWith({ kind: "codex", id: "chat-a" }, "/uploads/saved.png");
    act(() => applyCodexEvent(client, { threadId: "chat-a", turnId: "turn", method: "item/completed", message: { id: "live", role: "assistant", kind: "tool", content: "**Screenshot**", attachments: [{ name: "live.png", mimeType: "image/png", path: "/uploads/live.png" }] } }));
    fireEvent.click(await screen.findByText("Screenshot", { selector: "span" }));
    fireEvent.click(await screen.findByRole("button", { name: "View live.png" }));
    expect(screen.getByRole("dialog", { name: "live.png" })).toBeInTheDocument();
    expect(screen.queryByText("[Image attachment]")).not.toBeInTheDocument();
    result.unmount(); client.clear();
  });

  it.each(["click", "keyboard", "submit"])("shows uploaded images in the draft and optimistic image-only message sent by %s", async (method) => {
    api.codexOptions.mockResolvedValueOnce({ models: [{ id: "model", model: "model", displayName: "Model", defaultReasoningEffort: "high", supportedReasoningEfforts: [{ id: "high" }], inputModalities: ["image"] }], defaultModel: "model", defaultAccessMode: "fullAccess", accessModes: [{ id: "fullAccess", label: "Full access" }] });
    api.uploadCodexAttachment.mockResolvedValueOnce({ id: "upload.png", name: "photo.png", mimeType: "image/png" });
    let finish!: (result: { threadId: string; turnId: string }) => void;
    api.sendCodexMessage.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const { container } = renderPanel(<CodexChatPanel threadId="chat-a" />);
    await screen.findByPlaceholderText("Message Codex...");
    await waitFor(() => expect(screen.getByTitle("Attach images")).toBeEnabled());
    fireEvent.change(container.querySelector('input[type="file"]')!, { target: { files: [new File(["image"], "photo.png", { type: "image/png" })] } });
    expect(await screen.findByRole("img", { name: "photo.png" })).toBeInTheDocument();
    const input = screen.getByPlaceholderText("Message Codex...");
    if (method === "click") fireEvent.click(screen.getByTitle("Send message"));
    else if (method === "keyboard") fireEvent.keyDown(input, { key: "Enter" });
    else fireEvent.submit(input.closest("form")!);
    await waitFor(() => expect(api.sendCodexMessage).toHaveBeenCalledWith("chat-a", "", expect.any(String), expect.objectContaining({ attachmentIds: ["upload.png"] })));
    await waitFor(() => expect(screen.getAllByRole("img", { name: "photo.png" })).toHaveLength(2));
    expect(screen.queryByText("[Image attachment]")).not.toBeInTheDocument();
    await act(async () => finish({ threadId: "chat-a", turnId: "turn" }));
    await waitFor(() => expect(screen.getAllByRole("img", { name: "photo.png" })).toHaveLength(1));
  });
});

it("persists task descriptions, plans and existing messages without sending or navigating", async () => {
  let persisted = { ...task, description: "- [ ] Description", plan: { ...task.plan!, markdown: "- [ ] Plan" } };
  let messages = [{ id: 101, taskId: task.id, kind: "user_message", payload: { text: "- [ ] Message" }, createdAt: "now" }];
  api.task.mockImplementation(async () => persisted);
  api.taskEvents.mockImplementation(async () => messages);
  api.toggleMarkdownCheckbox.mockImplementation(async (_path, target, _recordId, edit) => {
    const next = edit.expected.slice(0, edit.offset) + "x" + edit.expected.slice(edit.offset + 1);
    if (target === "description") persisted = { ...persisted, description: next };
    if (target === "plan") persisted = { ...persisted, plan: { ...persisted.plan, markdown: next } };
    if (target === "event") messages = [{ ...messages[0], payload: { text: next } }];
    return persisted;
  });
  const href = window.location.href;
  const view = renderPanel(<TaskPanel />);
  for (const name of ["Description", "Plan", "Message"]) {
    fireEvent.click(await screen.findByRole("checkbox", { name }));
    await waitFor(() => expect(screen.getByRole("checkbox", { name })).toBeChecked());
  }
  expect(api.toggleMarkdownCheckbox.mock.calls.map((args) => args.slice(0, 3))).toEqual([
    ["/tasks/task-a", "description", undefined], ["/tasks/task-a", "plan", "3"], ["/tasks/task-a", "event", "101"],
  ]);
  expect(api.sendMessage).not.toHaveBeenCalled();
  expect(api.sendCodexMessage).not.toHaveBeenCalled();
  expect(api.startTaskPlan).not.toHaveBeenCalled();
  expect(window.location.href).toBe(href);
  view.unmount();
  renderPanel(<TaskPanel />);
  for (const name of ["Description", "Plan", "Message"]) expect(await screen.findByRole("checkbox", { name })).toBeChecked();
});
