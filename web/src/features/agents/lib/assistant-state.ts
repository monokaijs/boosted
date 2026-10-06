import type { AssistantState, AssistantSummary } from "@/features/agents/types/assistant"

export function shouldAcceptAssistantState(current: Pick<AssistantState, "id" | "updatedAt"> | null, next: AssistantState, agentId: string): boolean {
  if (next.id !== agentId) return false
  return !current || current.id !== agentId || !Number.isFinite(Date.parse(current.updatedAt)) || Date.parse(next.updatedAt) >= Date.parse(current.updatedAt)
}

export function assistantSummary(state: AssistantState): AssistantSummary {
  const { id, profile, status, accountId, activeExternalSession, createdAt, updatedAt } = state
  const lastMessageAt = state.messages.filter((message) => message.role === "assistant" && message.content.trim()).at(-1)?.createdAt ?? null
  return { id, profile, status, accountId, activeExternalSession, createdAt, updatedAt, lastMessageAt }
}
