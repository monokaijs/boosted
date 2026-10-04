import { act, cleanup, fireEvent, render as renderReact, screen } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { ReactNode } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { AssistantState } from "@/features/agents/types/assistant"
import type { SessionShellState } from "./session-shell"

const apiMock = vi.hoisted(() => ({ read: vi.fn(), send: vi.fn(), accounts: vi.fn() }))
const renderWork = vi.hoisted(() => ({ markdown: vi.fn(), profile: vi.fn() }))
vi.mock("@/features/agents/lib/api-client", () => ({ apiClient: { assistant: { read: apiMock.read, send: apiMock.send }, providerAccounts: { list: apiMock.accounts } } }))
vi.mock("./assistant-profile-panel", () => ({ AssistantProfilePanel: () => { renderWork.profile(); return null } }))
vi.mock("./chat-markdown", () => ({ MarkdownContent: ({ content }: { content: string }) => { renderWork.markdown(content); return <p>{content}</p> } }))

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
let queryClient: QueryClient
function render(ui: ReactNode) {
  return renderReact(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>)
}
let onResize: () => void
const disconnect = vi.fn()
beforeEach(() => {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
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
afterEach(() => { cleanup(); queryClient.clear(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

async function renderConversation() {
  const result = render(<AssistantPage shell={shell} agentId="pock" />)
  await screen.findByText("Hello")
  const scroller = result.container.querySelector(".assistant-conversation-scroll") as HTMLElement
  Object.defineProperty(scroller, "scrollHeight", { configurable: true, value: 1000 })
  Object.defineProperty(scroller, "clientHeight", { configurable: true, value: 400 })
  return { ...result, scroller }
}

it("reopens cached conversations with their draft and retryable outbox", async () => {
  apiMock.send.mockRejectedValueOnce(new Error("Offline"))
  const first = await renderConversation()
  const input = screen.getByRole("textbox", { name: "Message Pock" })
  fireEvent.change(input, { target: { value: "Send this" } })
  fireEvent.keyDown(input, { key: "Enter" })
  await screen.findByText("Not sent")
  fireEvent.change(input, { target: { value: "Next draft" } })
  first.unmount()
  await renderConversation()
  expect(screen.getByRole("textbox", { name: "Message Pock" })).toHaveValue("Next draft")
  expect(apiMock.read).toHaveBeenCalledTimes(1)
  expect(apiMock.accounts).toHaveBeenCalledTimes(1)
  fireEvent.click(screen.getByRole("button", { name: "Retry" }))
  await act(async () => { await Promise.resolve() })
  expect(apiMock.send).toHaveBeenCalledTimes(2)
  expect(apiMock.send.mock.calls[1][1]).toEqual(apiMock.send.mock.calls[0][1])
})

it("keeps typing independent of the conversation history and profile", async () => {
  apiMock.read.mockResolvedValue({ ...initial, messages: Array.from({ length: 150 }, (_, index) => ({
    id: `history-${index}`, role: "assistant", content: `Reply ${index}`, createdAt: initial.createdAt,
  })) })
  const { unmount } = render(<AssistantPage shell={shell} agentId="pock" />)
  await screen.findByText("Reply 149")
  const input = screen.getByRole("textbox", { name: "Message Pock" })
  const markdownRenders = renderWork.markdown.mock.calls.length
  const profileRenders = renderWork.profile.mock.calls.length
  for (let index = 1; index <= 10; index++) fireEvent.change(input, { target: { value: "x".repeat(index) } })
  expect(input).toHaveValue("xxxxxxxxxx")
  expect(screen.getByRole("button", { name: "Send message" })).toBeEnabled()
  expect(renderWork.markdown).toHaveBeenCalledTimes(markdownRenders)
  expect(renderWork.profile).toHaveBeenCalledTimes(profileRenders)
  expect(apiMock.send).not.toHaveBeenCalled()
  unmount()
})

it("preserves the next draft through streamed replies, send failures, and retries", async () => {
  apiMock.send.mockRejectedValueOnce(new Error("Offline"))
  await renderConversation()
  const input = screen.getByRole("textbox", { name: "Message Pock" })
  fireEvent.change(input, { target: { value: "First message" } })
  fireEvent.keyDown(input, { key: "Enter" })
  expect(input).toHaveValue("")
  fireEvent.change(input, { target: { value: "Next draft" } })
  await screen.findByText("Not sent")
  act(() => window.dispatchEvent(new CustomEvent("boosted:assistant-updated", { detail: {
    ...initial, updatedAt: "2026-10-02T00:00:02.000Z",
    messages: [...initial.messages, { id: "reply", role: "assistant", content: "Live reply", createdAt: "2026-10-02T00:00:02.000Z" }],
  } })))
  expect(input).toHaveValue("Next draft")
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Retry" })))
  expect(apiMock.send).toHaveBeenCalledTimes(2)
  expect(apiMock.send.mock.calls[1][1]).toEqual(apiMock.send.mock.calls[0][1])
  expect(input).toHaveValue("Next draft")
})

it("shows only dots for runtime activity and clears them after sending or stopping", async () => {
  apiMock.read.mockResolvedValue({ ...initial, status: "running", activity: "thinking" })
  const { scroller } = await renderConversation()
  expect(screen.getByRole("status", { name: "Pock is typing" })).toHaveTextContent(/^•••$/)

  let revision = 1
  const update = (activity: AssistantState["activity"], status: AssistantState["status"] = "running") => {
    act(() => window.dispatchEvent(new CustomEvent("boosted:assistant-updated", { detail: {
      ...initial, status, activity, updatedAt: `2026-10-02T00:00:0${++revision}.000Z`,
    } })))
  }
  update("working")
  expect(screen.getByRole("status", { name: "Pock is typing" })).toHaveTextContent(/^•••$/)
  expect(scroller.scrollTop).toBe(1000)
  update("responding")
  expect(screen.getByRole("status", { name: "Pock is typing" })).toHaveTextContent(/^•••$/)
  update(null)
  expect(screen.queryByRole("status")).not.toBeInTheDocument()
  update("thinking")
  update(null, "idle")
  expect(screen.queryByRole("status")).not.toBeInTheDocument()
})

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

it("collapses adjacent tools into a count and preserves expansion as new calls arrive", async () => {
  const receipts: AssistantState["messages"] = [
    { id: "command", role: "assistant", content: "", createdAt: "2026-10-02T00:00:02.000Z", actions: [{ id: "command-action", tool: "commandExecution", arguments: { command: "glab issue list" }, status: "failed" }] },
    { id: "edit", role: "assistant", content: "", createdAt: "2026-10-02T00:00:03.000Z", actions: [{ id: "edit-action", tool: "fileChange", arguments: {}, status: "completed" }] },
  ]
  apiMock.read.mockResolvedValue({ ...initial, messages: [...initial.messages, ...receipts] })
  await renderConversation()
  const toggle = screen.getByRole("button", { name: "2 tools" })
  expect(toggle).toHaveTextContent(/^2$/)
  expect(toggle).toHaveAttribute("aria-expanded", "false")
  const panel = document.getElementById(toggle.getAttribute("aria-controls")!)!
  expect(panel).toHaveAttribute("aria-hidden", "true")
  expect(panel).toHaveAttribute("inert")
  expect(screen.queryByRole("img", { name: "Failed" })).not.toBeInTheDocument()
  fireEvent.click(toggle)
  expect(toggle).toHaveAttribute("aria-expanded", "true")
  expect(panel).toHaveAttribute("data-expanded", "true")
  expect(panel).toHaveAttribute("aria-hidden", "false")
  expect(panel).not.toHaveAttribute("inert")
  expect(screen.getByRole("img", { name: "Failed" })).toBeInTheDocument()
  expect(screen.getByRole("img", { name: "Completed" })).toBeInTheDocument()
  expect(screen.getByText("Run command").closest("summary")).toHaveTextContent(/^Run command$/)
  act(() => window.dispatchEvent(new CustomEvent("boosted:assistant-updated", { detail: {
    ...initial, updatedAt: "2026-10-02T00:00:04.000Z", messages: [...initial.messages, ...receipts,
      { id: "avatar", role: "assistant", content: "", createdAt: "2026-10-02T00:00:04.000Z", actions: [{ id: "avatar-action", tool: "generate_avatar", arguments: {}, status: "running" }] },
    ],
  } })))
  expect(await screen.findByRole("button", { name: "3 tools" })).toBe(toggle)
  expect(toggle).toHaveTextContent(/^3$/)
  expect(toggle).toHaveAttribute("aria-expanded", "true")
  expect(screen.getByRole("img", { name: "Running" })).toBeInTheDocument()
  fireEvent.click(toggle)
  expect(toggle).toHaveAttribute("aria-expanded", "false")
  expect(panel).toHaveAttribute("data-expanded", "false")
  expect(panel).toHaveAttribute("inert")
  expect(screen.queryByRole("img", { name: "Running" })).not.toBeInTheDocument()
})
