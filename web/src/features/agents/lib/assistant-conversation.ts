import type { AssistantMessage } from "@/features/agents/types/assistant"

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
