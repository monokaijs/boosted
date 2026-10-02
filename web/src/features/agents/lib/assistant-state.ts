import type { AssistantState } from "@/features/agents/types/assistant"

export function shouldAcceptAssistantState(current: AssistantState | null, next: AssistantState, agentId: string): boolean {
  if (next.id !== agentId) return false
  return !current || current.id !== agentId || !Number.isFinite(Date.parse(current.updatedAt)) || Date.parse(next.updatedAt) >= Date.parse(current.updatedAt)
}
