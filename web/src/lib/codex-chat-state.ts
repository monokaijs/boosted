import type { CodexChatMessage, CodexLiveEvent } from "@/lib/types";

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
