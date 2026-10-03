import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { AssistantState } from "@/features/agents/types/assistant"
import type { SessionShellState } from "./session-shell"

const apiMock = vi.hoisted(() => ({ read: vi.fn(), send: vi.fn(), accounts: vi.fn() }))
vi.mock("@/features/agents/lib/api-client", () => ({ apiClient: { assistant: { read: apiMock.read, send: apiMock.send }, providerAccounts: { list: apiMock.accounts } } }))
vi.mock("./assistant-profile-panel", () => ({ AssistantProfilePanel: () => null }))
vi.mock("./chat-markdown", () => ({ MarkdownContent: ({ content }: { content: string }) => <p>{content}</p> }))

import { AssistantPage } from "./assistant-page"

const initial: AssistantState = {
  id: "pock", createdAt: "2026-10-02T00:00:00.000Z", updatedAt: "2026-10-02T00:00:01.000Z",
  profile: { name: "Pock", personality: "Concise." }, status: "idle", accountId: "account", error: null,
  messages: [{ id: "first", role: "assistant", content: "Hello", createdAt: "2026-10-02T00:00:01.000Z" }],
}
const shell: SessionShellState = {
  agents: [initial], chatAccounts: [], chats: [], recentWorkspaces: [],
  updateAgent: vi.fn(), selectAgent: vi.fn(), openCreateAgent: vi.fn(), createAgent: vi.fn(),
  selectManagementView: vi.fn(), selectNavigationView: vi.fn(), openSidebarChat: vi.fn(),
}
let onResize: () => void
const disconnect = vi.fn()
beforeEach(() => {
  vi.clearAllMocks()
  window.sessionStorage.clear()
  apiMock.read.mockResolvedValue(initial)
  apiMock.accounts.mockResolvedValue([{ id: "account", status: "CONNECTED" }])
  apiMock.send.mockResolvedValue({ ...initial, updatedAt: "2026-10-02T00:00:03.000Z" })
  vi.stubGlobal("ResizeObserver", class {
    constructor(callback: () => void) { onResize = callback }
    observe() {}
    disconnect = disconnect
  })
})
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

async function renderConversation() {
  const result = render(<AssistantPage shell={shell} agentId="pock" />)
  await screen.findByText("Hello")
  const scroller = result.container.querySelector(".assistant-conversation-scroll") as HTMLElement
  Object.defineProperty(scroller, "scrollHeight", { configurable: true, value: 1000 })
  Object.defineProperty(scroller, "clientHeight", { configurable: true, value: 400 })
  return { ...result, scroller }
}

describe("agent conversation scrolling", () => {
  it("follows replies and keyboard resizing inside the transcript without scrolling ancestors", async () => {
    const scrollIntoView = vi.spyOn(HTMLElement.prototype, "scrollIntoView")
    const { scroller, unmount } = await renderConversation()
    act(() => window.dispatchEvent(new CustomEvent("boosted:assistant-updated", { detail: {
      ...initial, updatedAt: "2026-10-02T00:00:02.000Z",
      messages: [...initial.messages, { id: "reply", role: "assistant", content: "New reply", createdAt: "2026-10-02T00:00:02.000Z" }],
    } })))
    expect(screen.getByText("New reply")).toBeInTheDocument()
    expect(scroller.scrollTop).toBe(1000)
    scroller.scrollTop = 600
    Object.defineProperty(scroller, "clientHeight", { configurable: true, value: 200 })
    act(() => onResize())
    expect(scroller.scrollTop).toBe(1000)
    expect(scrollIntoView).not.toHaveBeenCalled()
    unmount()
    expect(disconnect).toHaveBeenCalledOnce()
  })

  it("preserves the reader's position when the keyboard resizes older messages", async () => {
    const { scroller } = await renderConversation()
    scroller.scrollTop = 100
    fireEvent.scroll(scroller)
    act(() => onResize())
    expect(scroller.scrollTop).toBe(100)
    act(() => window.dispatchEvent(new CustomEvent("boosted:assistant-updated", { detail: { ...initial, updatedAt: "2026-10-02T00:00:02.000Z" } })))
    expect(scroller.scrollTop).toBe(100)
  })

  it("refocuses the composer after sending without asking the browser to pan the page", async () => {
    await renderConversation()
    const input = screen.getByRole("textbox", { name: "Message Pock" })
    const focus = vi.spyOn(input, "focus")
    fireEvent.change(input, { target: { value: "Keep going" } })
    await act(async () => fireEvent.submit(input.closest("form")!))
    expect(apiMock.send).toHaveBeenCalledWith("pock", expect.objectContaining({ content: "Keep going" }))
    expect(focus).toHaveBeenCalledWith({ preventScroll: true })
  })
})
