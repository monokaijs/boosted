import type { QueryClient } from "@tanstack/react-query";
import type { CodexChat, CodexChatThread, CodexLiveEvent } from "@/lib/types";

export function chatActivity(status: string): "running" | "waiting" | "failed" | "idle" {
  if (["active", "running", "inProgress"].includes(status)) return "running";
  if (["needs_input", "waitingOnApproval", "waitingOnUserInput"].includes(status)) return "waiting";
  if (["failed", "systemError"].includes(status)) return "failed";
  return "idle";
}

export function setCachedChatStatus(client: QueryClient, threadId: string, status: string) {
  client.setQueriesData<CodexChat[]>({ queryKey: ["codex-chats"] }, (chats) =>
    chats?.map((chat) => chat.id === threadId ? { ...chat, status } : chat));
  client.setQueriesData<CodexChatThread>({ queryKey: ["codex-chat", threadId] }, (thread) =>
    thread ? { ...thread, chat: { ...thread.chat, status } } : thread);
}

export function applyChatStatusEvent(client: QueryClient, event: CodexLiveEvent) {
  if (event.method === "turn/started") setCachedChatStatus(client, event.threadId, "active");
  if (event.method === "turn/completed") setCachedChatStatus(client, event.threadId, event.status === "failed" ? "failed" : "idle");
}
