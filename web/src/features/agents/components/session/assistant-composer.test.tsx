import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { machinePreferenceKey } from "@/lib/store"
import { AssistantComposer } from "./assistant-composer"

const onSend = vi.fn(() => true)
const props = { agentId: "pock", assistantName: "Pock", canSend: true, showStop: false, stopping: false, onSend, onStop: vi.fn(), onError: vi.fn() }
const draftKey = machinePreferenceKey("boosted-agent-draft-pock")

beforeEach(() => { vi.clearAllMocks(); window.sessionStorage.clear() })
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks() })

it("restores drafts and writes only after a pause in typing", () => {
  vi.useFakeTimers()
  sessionStorage.setItem(draftKey, "Saved draft")
  render(<AssistantComposer {...props} />)
  const input = screen.getByRole("textbox")
  expect(input).toHaveValue("Saved draft")
  const write = vi.spyOn(Object.getPrototypeOf(window.sessionStorage), "setItem")
  for (let index = 1; index <= 10; index++) fireEvent.change(input, { target: { value: "x".repeat(index) } })
  expect(write).not.toHaveBeenCalled()
  act(() => vi.advanceTimersByTime(249))
  expect(write).not.toHaveBeenCalled()
  act(() => vi.advanceTimersByTime(1))
  expect(write).toHaveBeenCalledExactlyOnceWith(draftKey, "xxxxxxxxxx")
})

it("flushes pending drafts on page exit and agent switches", () => {
  vi.useFakeTimers()
  const { rerender } = render(<AssistantComposer {...props} key="pock" />)
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "First draft" } })
  fireEvent(window, new Event("pagehide"))
  expect(sessionStorage.getItem(draftKey)).toBe("First draft")
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "Updated draft" } })
  rerender(<AssistantComposer {...props} agentId="other" key="other" />)
  expect(sessionStorage.getItem(draftKey)).toBe("Updated draft")
  expect(screen.getByRole("textbox")).toHaveValue("")
  rerender(<AssistantComposer {...props} key="pock" />)
  expect(screen.getByRole("textbox")).toHaveValue("Updated draft")
})

it("preserves IME and multiline input, then clears a submitted draft immediately", () => {
  vi.useFakeTimers()
  render(<AssistantComposer {...props} />)
  const input = screen.getByRole("textbox")
  fireEvent.change(input, { target: { value: "Keep going" } })
  fireEvent.keyDown(input, { key: "Enter", shiftKey: true })
  fireEvent.keyDown(input, { key: "Enter", isComposing: true })
  expect(onSend).not.toHaveBeenCalled()
  fireEvent.keyDown(input, { key: "Enter" })
  expect(onSend).toHaveBeenCalledExactlyOnceWith("Keep going", [])
  expect(input).toHaveValue("")
  expect(input).toHaveFocus()
  expect(sessionStorage.getItem(draftKey)).toBe("")
})

it("keeps the draft when sending is unavailable or rejected", () => {
  const { rerender } = render(<AssistantComposer {...props} canSend={false} />)
  const input = screen.getByRole("textbox")
  fireEvent.change(input, { target: { value: "Keep this" } })
  fireEvent.keyDown(input, { key: "Enter" })
  expect(onSend).not.toHaveBeenCalled()
  onSend.mockReturnValueOnce(false)
  rerender(<AssistantComposer {...props} />)
  fireEvent.keyDown(input, { key: "Enter" })
  expect(input).toHaveValue("Keep this")
})

it("sends attachments without text and clears them only after enqueueing", async () => {
  render(<AssistantComposer {...props} />)
  fireEvent.change(screen.getByLabelText("Select attachments"), { target: { files: [new File(["Notes"], "notes.txt", { type: "text/plain" })] } })
  await screen.findByRole("button", { name: "Remove attachment notes.txt" })
  await waitFor(() => expect(screen.getByRole("button", { name: "Send message" })).toBeEnabled())
  fireEvent.click(screen.getByRole("button", { name: "Send message" }))
  expect(onSend).toHaveBeenCalledWith("", [expect.objectContaining({ name: "notes.txt", kind: "file", dataUrl: "data:text/plain;base64,Tm90ZXM=" })])
  expect(screen.queryByLabelText("Attachments to send")).not.toBeInTheDocument()
})

it("remains usable when browser draft storage is unavailable", () => {
  vi.spyOn(Object.getPrototypeOf(window.sessionStorage), "getItem").mockImplementation(() => { throw new Error("Storage unavailable") })
  vi.spyOn(Object.getPrototypeOf(window.sessionStorage), "setItem").mockImplementation(() => { throw new Error("Storage unavailable") })
  const { unmount } = render(<AssistantComposer {...props} />)
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "Send anyway" } })
  fireEvent.click(screen.getByRole("button", { name: "Send message" }))
  expect(onSend).toHaveBeenCalledWith("Send anyway", [])
  expect(() => unmount()).not.toThrow()
})
