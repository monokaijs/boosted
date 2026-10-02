import { describe, expect, it } from "vitest"
import type { AssistantMessage } from "../types/assistant"
import { assistantMessagesWithOutbox, type AssistantPendingMessage } from "./assistant-outbox"

const pending: AssistantPendingMessage = { id: "outgoing", role: "user", content: "Hello", createdAt: "2026-10-02T00:00:00Z", localDelivery: "sending", request: { content: "Hello", clientMessageId: "outgoing" } }

describe("agent outbox", () => {
  it("keeps an immediate bubble across polls until the server acknowledges its ID", () => {
    expect(assistantMessagesWithOutbox([], [pending])).toEqual([pending])
    const confirmed: AssistantMessage = { id: pending.id, role: "user", content: pending.content, createdAt: pending.createdAt, delivery: "processing", readAt: pending.createdAt }
    expect(assistantMessagesWithOutbox([confirmed], [pending])).toEqual([confirmed])
  })

  it("keeps pending messages before replies arriving while their requests are in flight", () => {
    const reply: AssistantMessage = { id: "reply", role: "assistant", content: "Hi", createdAt: "2026-10-02T00:00:01Z" }
    expect(assistantMessagesWithOutbox([reply], [pending]).map((message) => message.id)).toEqual(["outgoing", "reply"])
  })

  it("keeps failed content and attachments available to retry without altering the next draft", () => {
    const failed: AssistantPendingMessage = { ...pending, localDelivery: "failed", sendError: "Offline", attachments: [{ id: "file", kind: "file", name: "note.txt", mimeType: "text/plain", size: 1, dataUrl: "data:text/plain;base64,YQ==" }] }
    expect(assistantMessagesWithOutbox([], [failed])).toEqual([failed])
  })
})
