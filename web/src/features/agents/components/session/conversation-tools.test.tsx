import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
import type { AssistantAction } from "@/features/agents/types/assistant"
import type { SessionShellState } from "./session-shell"
import { SpawnedChatLinks } from "./conversation-tools"

afterEach(cleanup)

const spawned: AssistantAction = { id: "create", tool: "create_chat", arguments: {}, status: "completed", chatId: "spawned-chat" }

it("opens a spawned chat through the embedded handler, shell, or default navigation", () => {
  const onOpenChat = vi.fn()
  const openSidebarChat = vi.fn()
  const navigate = vi.fn()
  window.addEventListener("boosted:open-codex-chat", navigate)
  try {
    const { container, rerender } = render(<SpawnedChatLinks actions={[spawned]} onOpenChat={onOpenChat} />)
    expect(container.querySelector("details, pre, .assistant-tool-panel")).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "New chat" }))
    expect(onOpenChat).toHaveBeenCalledWith("spawned-chat")
    expect(navigate).not.toHaveBeenCalled()
    rerender(<SpawnedChatLinks actions={[spawned]} shell={{ chats: [], recentWorkspaces: [], openSidebarChat } as unknown as SessionShellState} />)
    fireEvent.click(screen.getByRole("button", { name: "New chat" }))
    expect(openSidebarChat).toHaveBeenCalledWith({ id: "spawned-chat", title: "New chat" })
    rerender(<SpawnedChatLinks actions={[spawned]} />)
    fireEvent.click(screen.getByRole("button", { name: "New chat" }))
    expect(navigate).toHaveBeenCalledTimes(1)
    expect((navigate.mock.calls[0][0] as CustomEvent).detail).toEqual({ threadId: "spawned-chat" })
  } finally { window.removeEventListener("boosted:open-codex-chat", navigate) }
})

it("hides all non-spawn calls, including failures and tools that reference existing chats", () => {
  const result = vi.fn(() => "Hidden tool result")
  const actions: AssistantAction[] = ["commandExecution", "fileChange", "generate_avatar", "read_group_context", "send_group_message", "read_chat", "send_message", "watch_chat", "clear_chat", "stop_chat", "unknown_tool"].flatMap((tool) =>
    (["completed", "running", "failed"] as const).map((status) => ({ id: `${tool}-${status}`, tool, status, arguments: { chatId: "existing-chat" }, chatId: "existing-chat", get result() { return result() } })),
  )
  const { container } = render(<SpawnedChatLinks actions={actions} />)
  expect(container).toBeEmptyDOMElement()
  expect(result).not.toHaveBeenCalled()
})

it("requires completed creation with a child ID and deduplicates actual spawned chats", () => {
  const actions: AssistantAction[] = [
    { ...spawned, status: "running" }, { ...spawned, status: "failed" }, { ...spawned, chatId: undefined }, { ...spawned, chatId: " " },
  ]
  const { container, rerender } = render(<SpawnedChatLinks actions={actions} />)
  expect(container).toBeEmptyDOMElement()
  rerender(<SpawnedChatLinks actions={[...actions, spawned, { ...spawned, id: "duplicate" }, { ...spawned, id: "fork", tool: "fork_chat", chatId: "forked-chat" }]} />)
  expect(screen.getAllByRole("button", { name: "New chat" })).toHaveLength(2)
  expect(container.querySelector("details, pre, .assistant-tool-panel")).toBeNull()
})

it("uses the current title instead of creation arguments or workspace labels and follows renames", () => {
  const openSidebarChat = vi.fn()
  const action = { ...spawned, arguments: { title: "Old request title" }, workingDirectory: "/repo" }
  const shell = { chats: [{ id: "spawned-chat", title: "Implement search", workingDirectory: "/repo", status: "RUNNING" }], recentWorkspaces: [{ id: "repo", name: "Workspace", path: "/repo" }], openSidebarChat } as unknown as SessionShellState
  const { rerender } = render(<SpawnedChatLinks actions={[action]} shell={shell} />)
  fireEvent.click(screen.getByRole("button", { name: "Implement search" }))
  expect(openSidebarChat).toHaveBeenLastCalledWith({ id: "spawned-chat", title: "Implement search" })
  rerender(<SpawnedChatLinks actions={[action]} shell={{ ...shell, chats: [{ ...shell.chats[0], title: "Search is ready" }] }} />)
  expect(screen.queryByRole("button", { name: "Implement search" })).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole("button", { name: "Search is ready" }))
  expect(openSidebarChat).toHaveBeenLastCalledWith({ id: "spawned-chat", title: "Search is ready" })
})

it.each([undefined, null, "", "   ", "spawned-chat"])("uses a human fallback for an unavailable title (%j)", (title) => {
  const openSidebarChat = vi.fn()
  const shell = { chats: [{ id: "spawned-chat", title, status: "IDLE" }], openSidebarChat } as unknown as SessionShellState
  render(<SpawnedChatLinks actions={[spawned]} shell={shell} />)
  fireEvent.click(screen.getByRole("button", { name: "New chat" }))
  expect(openSidebarChat).toHaveBeenCalledWith({ id: "spawned-chat", title: "New chat" })
  expect(screen.queryByText("spawned-chat")).not.toBeInTheDocument()
})
