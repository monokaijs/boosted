import { describe, expect, it } from "vitest"
import type { AssistantMessage } from "../types/assistant"
import { assistantMessageLayout } from "./assistant-conversation"

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
})
