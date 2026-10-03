import type { AssistantAction } from "../types/assistant"

const chatTools = new Set([
  "commandExecution", "fileChange", "computer_action", "computer_screenshot",
  "generate_avatar", "update_profile", "schedule_follow_up", "cancel_follow_up",
  "create_chat", "send_message", "set_chat_model", "stop_run", "stop_chat",
  "move_chat", "set_failover", "fork_chat", "rename_chat", "set_chat_access",
  "clear_chat", "delete_chat", "create_group_task", "submit_group_result",
  "review_group_task", "block_group_task",
])

export function isChatActionVisible(action: AssistantAction): boolean {
  return action.status === "failed" || chatTools.has(action.tool)
}
