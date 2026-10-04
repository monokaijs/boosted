import type { QueryClient } from "@tanstack/react-query";
import type { CodexChatMessage, CodexChatThread, CodexLiveEvent } from "@/lib/types";
import { applyChatStatusEvent } from "@/lib/codex-chat-status";
import { useWorkspaceStore } from "@/lib/workspace-state";

export function codexErrorText(error: unknown) {
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && "message" in error && typeof error.message === "string") return error.message;
  return "Codex stopped unexpectedly.";
}

export function applyCodexEvent(client: QueryClient, event: CodexLiveEvent) {
  if (!["turn/started", "turn/completed", "error", "item/started", "item/completed", "item/commandExecution/outputDelta", "item/agentMessage/delta", "item/reasoning/summaryTextDelta", "item/plan/delta"].includes(event.method)) return;
  const key = ["codex-chat", event.threadId];
  // Cancel a stale snapshot before applying a stream update. Cancellation keeps
  // its eventual response from replacing newer tokens in the shared cache.
  if (client.getQueryData(key)) void client.cancelQueries({ queryKey: key, exact: true });
  applyChatStatusEvent(client, event);
  const workspace = useWorkspaceStore.getState();
  if (event.method === "turn/started") workspace.write(`codex:${event.threadId}:error`, undefined, undefined, workspace.generation);
  if (event.method === "error" || (event.method === "turn/completed" && event.status === "failed")) {
    workspace.write(`codex:${event.threadId}:error`, codexErrorText(event.error), undefined, workspace.generation);
  }
  client.setQueryData<CodexChatThread>(key, (thread) => {
    if (!thread) return thread; // Never accumulate histories for unopened chats.
    let messages = thread.messages;
    if ((event.method === "item/started" || event.method === "item/completed" || event.method === "item/commandExecution/outputDelta") && event.message) {
      messages = upsertCodexMessage(messages, event.message, event.clientMessageId);
    }
    if (event.method === "item/agentMessage/delta") messages = appendCodexDelta(messages, event, "message");
    if (event.method === "item/reasoning/summaryTextDelta") messages = appendCodexDelta(messages, event, "reasoning");
    if (event.method === "item/plan/delta") messages = appendCodexDelta(messages, event, "plan");
    return messages === thread.messages ? thread : { ...thread, messages };
  });
}

export function upsertCodexMessage(messages: CodexChatMessage[], message: CodexChatMessage, clientMessageId?: string) {
  const canonical = message.role === "user" && clientMessageId ? { ...message, id: clientMessageId } : message;
  const index = messages.findIndex((item) => item.id === canonical.id || item.id === message.id);
  if (index === -1) return [...messages, canonical];
  const next = [...messages];
  next[index] = { ...next[index], ...canonical, createdAt: canonical.createdAt ?? next[index].createdAt };
  return next;
}

export function appendCodexDelta(messages: CodexChatMessage[], event: CodexLiveEvent, kind: CodexChatMessage["kind"]) {
  if (!event.itemId || !event.delta) return messages;
  const index = messages.findIndex((item) => item.id === event.itemId);
  if (index === -1) {
    const message: CodexChatMessage = { id: event.itemId, role: "assistant", content: event.delta, kind };
    return [...messages, message];
  }
  const next = [...messages];
  next[index] = { ...next[index], content: `${next[index].content}${event.delta}` };
  return next;
}
