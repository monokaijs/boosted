import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
import type { AssistantAction } from "@/features/agents/types/assistant"
import { ActionGroup } from "./conversation-tools"

afterEach(cleanup)

it("omits routine calls and counts only visible actions, while keeping failures inspectable", () => {
  const routine: AssistantAction[] = ["read_group_context", "send_group_message", "request_group_peers", "list_chats", "webSearch", "mcpToolCall", "unknown_tool"].map((tool) => ({ id: tool, tool, arguments: {}, status: "completed" }))
  const { container, rerender } = render(<ActionGroup actions={routine} />)
  expect(container).toBeEmptyDOMElement()
  const failed = { ...routine[0], id: "failed", status: "failed" as const, result: "Unable to read group" }
  const avatar: AssistantAction = { id: "avatar", tool: "generate_avatar", arguments: {}, status: "running" }
  rerender(<ActionGroup actions={[...routine, avatar, failed]} />)
  const toggle = screen.getByRole("button", { name: "2 tools" })
  fireEvent.click(toggle)
  expect(screen.getByText("Generate avatar")).toBeInTheDocument()
  expect(screen.getByText("Read group context")).toBeInTheDocument()
  expect(screen.queryByText("Send group message")).not.toBeInTheDocument()
  expect(screen.getByRole("img", { name: "Failed" })).toBeInTheDocument()
  expect(container.querySelectorAll("details")).toHaveLength(2)
})

it("allows full receipts in the activity view", () => {
  render(<ActionGroup showAll actions={[{ id: "read", tool: "read_group_context", arguments: {}, status: "completed" }]} />)
  fireEvent.click(screen.getByRole("button", { name: "1 tool" }))
  expect(screen.getByText("Read group context")).toBeInTheDocument()
})

it("reads and formats tool payloads only when their individual details are opened", () => {
  const result = vi.fn(() => JSON.stringify({ output: "Large tool output" }))
  const action: AssistantAction = { id: "tool", tool: "commandExecution", arguments: {}, status: "completed", get result() { return result() } }
  const { container } = render(<ActionGroup actions={[action]} />)
  expect(container.querySelector("details")).toBeNull()
  expect(result).not.toHaveBeenCalled()
  const toggle = screen.getByRole("button", { name: "1 tool" })
  fireEvent.click(toggle)
  const details = container.querySelector("details")!
  expect(screen.getByText("Run command")).toBeInTheDocument()
  expect(result).not.toHaveBeenCalled()
  details.open = true
  fireEvent(details, new Event("toggle"))
  expect(result).toHaveBeenCalled()
  expect(screen.getByText(/Large tool output/)).toBeInTheDocument()
  fireEvent.click(toggle)
  fireEvent.click(toggle)
  expect(container.querySelector("details")).toBe(details)
  expect(details.open).toBe(true)
})
