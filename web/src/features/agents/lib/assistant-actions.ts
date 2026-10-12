import type { AssistantAction } from "../types/assistant"

export function isChatActionVisible(action: AssistantAction): boolean {
  return action.status === "completed" && Boolean(action.chatId?.trim()) && (action.tool === "create_chat" || action.tool === "fork_chat")
}
