import { describe, expect, it } from "vitest"
import type { AssistantMessage } from "../types/assistant"
import { assistantConversationLayout, assistantMessageLayout } from "./assistant-conversation"

function message(role: AssistantMessage["role"], createdAt: string): AssistantMessage {
  return { id: createdAt, role, createdAt, content: "Message" }
}

describe("assistant conversation layout", () => {
  it("keeps consecutive replies together and separates a change of speaker", () => {
    const layout = assistantMessageLayout([
      message("assistant", "2026-10-02T06:00:00"),
      message("assistant", "2026-10-02T06:01:00"),
      message("user", "2026-10-02T06:02:00"),
      message("user", "2026-10-02T06:03:00"),
      message("assistant", "2026-10-02T06:04:00"),
    ])
    expect(layout.map((item) => item.startGroup)).toEqual([true, false, true, false, true])
    expect(layout.map((item) => item.showSentTime)).toEqual([false, false, false, true, false])
    expect(layout.map((item) => item.showDeliveryStatus)).toEqual([false, false, false, false, false])
  })

  it("keeps a delivery receipt visible only until another message follows it", () => {
    const sent = message("user", "2026-10-02T06:00:00")
    expect(assistantMessageLayout([sent])[0].showDeliveryStatus).toBe(true)
    const stacked = assistantMessageLayout([sent, message("user", "2026-10-02T06:01:00")])
    expect(stacked.map((item) => item.showDeliveryStatus)).toEqual([false, true])
    const replied = assistantMessageLayout([sent, message("assistant", "2026-10-02T06:02:00")])
    expect(replied[0].showSentTime).toBe(true)
    expect(replied[0].showDeliveryStatus).toBe(false)
  })

  it("shows a new timestamp after a pause or when the local date changes", () => {
    const layout = assistantMessageLayout([
      message("assistant", "2026-10-02T23:43:00"),
      message("assistant", "2026-10-02T23:58:00"),
      message("assistant", "2026-10-03T00:00:00"),
    ])
    expect(layout.map((item) => item.showTimestamp)).toEqual([true, true, true])
  })

  it("handles an empty conversation", () => {
    expect(assistantMessageLayout([])).toEqual([])
  })

  it("groups adjacent tool receipts while preserving replies and user messages", () => {
    const receipt = (id: string, minute: number): AssistantMessage => ({
      id, role: "assistant", content: "", createdAt: `2026-10-02T06:0${minute}:00`,
      actions: [{ id: `${id}-action`, tool: "commandExecution", arguments: {}, status: "completed" }],
    })
    const messages = [
      receipt("first", 0), receipt("second", 1), message("assistant", "2026-10-02T06:02:00"),
      receipt("third", 3), message("user", "2026-10-02T06:04:00"), receipt("fourth", 5),
    ]
    const layout = assistantConversationLayout(messages)
    expect(layout.map((item) => item.type)).toEqual(["tools", "message", "tools", "message", "tools"])
    expect(layout[0].message.id).toBe("first")
    expect(layout[0].type === "tools" && layout[0].actions.map((action) => action.id)).toEqual(["first-action", "second-action"])
    expect(messages[0].actions).toHaveLength(1)
    expect(layout[3].showSentTime).toBe(true)
  })

  it("keeps tool groups separate across timestamp breaks and attachment messages", () => {
    const first: AssistantMessage = {
      id: "first", role: "assistant", content: "", createdAt: "2026-10-02T06:00:00",
      actions: [{ id: "action", tool: "commandExecution", arguments: {}, status: "completed" }],
    }
    const afterPause = { ...first, id: "paused", createdAt: "2026-10-02T06:15:00" }
    const attachment = { ...afterPause, id: "attachment", attachments: [{ id: "image", kind: "image" as const, name: "image.png", mimeType: "image/png", size: 1, dataUrl: "data:image/png;base64,AA==" }] }
    const layout = assistantConversationLayout([first, afterPause, attachment, { ...afterPause, id: "last" }])
    expect(layout.map((item) => item.type)).toEqual(["tools", "tools", "message", "tools"])
    expect(layout[1].showTimestamp).toBe(true)
  })

  it("groups whitespace-only tool receipts into the same counter", () => {
    const messages: AssistantMessage[] = ["", " \n ", "\t"].map((content, index) => ({
      id: `receipt-${index}`, role: "assistant", content, createdAt: `2026-10-02T06:0${index}:00`,
      actions: [{ id: `action-${index}`, tool: "commandExecution", arguments: {}, status: "completed" }],
    }))
    const layout = assistantConversationLayout(messages)
    expect(layout).toHaveLength(1)
    expect(layout[0].type === "tools" && layout[0].actions).toHaveLength(3)
  })

  it("omits routine receipts without changing delivery status, timestamp grouping, or message content", () => {
    const sent = message("user", "2026-10-02T06:00:00")
    const hidden: AssistantMessage = { id: "lookup", role: "assistant", content: "", createdAt: "2026-10-02T06:20:00", actions: [
      { id: "read", tool: "read_chat", arguments: {}, status: "completed" },
      { id: "send", tool: "send_group_message", arguments: {}, status: "completed" },
    ] }
    const layout = assistantConversationLayout([sent, hidden])
    expect(layout).toHaveLength(1)
    expect(layout[0].showDeliveryStatus).toBe(true)
    const reply = { ...message("assistant", "2026-10-02T06:21:00"), actions: hidden.actions }
    const replied = assistantConversationLayout([sent, hidden, reply])
    expect(replied).toHaveLength(2)
    expect(replied[1].showTimestamp).toBe(true)
    expect(replied[1].message.content).toBe("Message")
    expect(replied[1].message.actions).toEqual([])
    expect(hidden.actions).toHaveLength(2)
  })
})
