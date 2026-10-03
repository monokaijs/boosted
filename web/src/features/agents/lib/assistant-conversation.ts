import type { AssistantAction, AssistantMessage } from "@/features/agents/types/assistant"
import { isChatActionVisible } from "./assistant-actions"

export function assistantMessageLayout<Message extends AssistantMessage>(messages: Message[]) {
  return messages.map((message, index) => {
    const previous = messages[index - 1]
    const next = messages[index + 1]
    const timestamp = new Date(message.createdAt)
    const previousTimestamp = previous ? new Date(previous.createdAt) : null
    const elapsed = previousTimestamp ? timestamp.getTime() - previousTimestamp.getTime() : Infinity
    const showTimestamp = !previous || elapsed >= 15 * 60_000 || timestamp.toDateString() !== previousTimestamp?.toDateString()
    return {
      message,
      showTimestamp,
      startGroup: showTimestamp || previous?.role !== message.role,
      showSentTime: message.role === "user" && (!next || next.role !== "user"),
      showDeliveryStatus: message.role === "user" && index === messages.length - 1,
    }
  })
}

type ConversationItem<Message extends AssistantMessage> = ReturnType<typeof assistantMessageLayout<Message>>[number] & (
  { type: "message" } | { type: "tools"; actions: AssistantAction[] }
)

export function assistantConversationLayout<Message extends AssistantMessage>(messages: Message[]) {
  const visibleMessages = messages.flatMap((message) => {
    const actions = message.actions?.filter(isChatActionVisible)
    if (message.role === "assistant" && !message.content.trim() && !message.attachments?.length && message.actions?.length && !actions?.length) return []
    return [actions && actions.length !== message.actions?.length ? { ...message, actions } : message]
  })
  const items: ConversationItem<Message>[] = []
  for (const entry of assistantMessageLayout(visibleMessages)) {
    const { message } = entry
    const toolsOnly = message.role === "assistant" && !message.content.trim() && !message.attachments?.length && message.actions?.length
    const previous = items.at(-1)
    if (toolsOnly && previous?.type === "tools" && !entry.startGroup && previous.message.assistantName === message.assistantName) {
      previous.actions.push(...message.actions!)
    } else if (toolsOnly) {
      items.push({ ...entry, type: "tools", actions: [...message.actions!] })
    } else {
      items.push({ ...entry, type: "message" })
    }
  }
  return items
}
