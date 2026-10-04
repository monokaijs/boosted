import { describe, expect, it } from "vitest"
import type { AssistantState } from "../types/assistant"
import { assistantSummary, shouldAcceptAssistantState } from "./assistant-state"

const state: AssistantState = {
  id: "pock", createdAt: "2026-10-02T00:00:00.000Z", updatedAt: "2026-10-02T00:00:01.000Z",
  profile: { name: "Pock", personality: "Concise." }, messages: [], status: "running", accountId: "account", error: null,
}

describe("live assistant updates", () => {
  it("keeps transcript and attachment data out of list caches", () => {
    const summary = assistantSummary({ ...state, messages: [{ id: "large", role: "user", content: "Transcript", createdAt: state.createdAt }] })
    expect(summary).not.toHaveProperty("messages")
    expect(summary).not.toHaveProperty("followUps")
    expect(summary).toMatchObject({ id: state.id, status: state.status, updatedAt: state.updatedAt })
  })
  it("rejects delayed poll and send responses after newer streamed text", () => {
    expect(shouldAcceptAssistantState(state, { ...state, updatedAt: "2026-10-02T00:00:00.999Z" }, "pock")).toBe(false)
    expect(shouldAcceptAssistantState(state, { ...state, status: "idle", updatedAt: "2026-10-02T00:00:01.001Z" }, "pock")).toBe(true)
    expect(shouldAcceptAssistantState(state, state, "pock")).toBe(true)
  })

  it("ignores another agent and accepts the selected agent when switching", () => {
    const other = { ...state, id: "nova" }
    expect(shouldAcceptAssistantState(null, other, "pock")).toBe(false)
    expect(shouldAcceptAssistantState(state, other, "pock")).toBe(false)
    expect(shouldAcceptAssistantState(state, other, "nova")).toBe(true)
    expect(shouldAcceptAssistantState(null, state, "pock")).toBe(true)
  })
})
