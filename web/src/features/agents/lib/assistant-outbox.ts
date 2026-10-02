import type { AssistantMessage, AssistantMessageRequest } from "@/features/agents/types/assistant"

export type AssistantDisplayMessage = AssistantMessage & { localDelivery?: "sending" | "failed"; sendError?: string }
export type AssistantPendingMessage = AssistantDisplayMessage & { request: AssistantMessageRequest }

export function assistantMessagesWithOutbox(messages: AssistantMessage[], outbox: AssistantPendingMessage[]): AssistantDisplayMessage[] {
  const confirmed = new Set(messages.map((message) => message.id))
  const result: AssistantDisplayMessage[] = [...messages]
  for (const pending of outbox) {
    if (confirmed.has(pending.id)) continue
    const nextIndex = result.findIndex((message) => Date.parse(message.createdAt) > Date.parse(pending.createdAt))
    result.splice(nextIndex < 0 ? result.length : nextIndex, 0, pending)
  }
  return result
}
