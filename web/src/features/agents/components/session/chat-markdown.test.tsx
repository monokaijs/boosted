import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"

const parse = vi.hoisted(() => vi.fn())
vi.mock("react-markdown", async (importOriginal) => {
  const original = await importOriginal<typeof import("react-markdown")>()
  return { ...original, default: (props: Parameters<typeof original.default>[0]) => { parse(props.children); return original.default(props) } }
})
import { MarkdownContent } from "./chat-markdown"

afterEach(() => { cleanup(); vi.clearAllMocks() })

it("skips unchanged Markdown on background updates and parses new content", () => {
  const { rerender } = render(<MarkdownContent content="**Original reply**" />)
  expect(screen.getByText("Original reply").tagName).toBe("STRONG")
  expect(parse).toHaveBeenCalledTimes(1)
  rerender(<MarkdownContent content="**Original reply**" />)
  expect(parse).toHaveBeenCalledTimes(1)
  rerender(<MarkdownContent content="**Updated reply**" />)
  expect(parse).toHaveBeenCalledTimes(2)
  expect(screen.getByText("Updated reply").tagName).toBe("STRONG")
})

it("preserves link elements while content streams and uses the current file handler", () => {
  const openFileLink = vi.fn(() => true)
  const { rerender } = render(<MarkdownContent content="[Source](/src/app.ts)" openFileLink={openFileLink} />)
  const link = screen.getByRole("link", { name: "Source" })
  rerender(<MarkdownContent content="[Source](/src/app.ts) plus more" openFileLink={openFileLink} />)
  expect(screen.getByRole("link", { name: "Source" })).toBe(link)
  const nextHandler = vi.fn(() => true)
  rerender(<MarkdownContent content="[Source](/src/app.ts) plus more" openFileLink={nextHandler} />)
  fireEvent.click(screen.getByRole("link", { name: "Source" }))
  expect(openFileLink).not.toHaveBeenCalled()
  expect(nextHandler).toHaveBeenCalledWith("/src/app.ts")
})

it("does not reparse unchanged task Markdown when only its persistence callback changes", () => {
  const { rerender } = render(<MarkdownContent content="- [ ] Task" saveCheckbox={async () => {}} />)
  const checkbox = screen.getByRole("checkbox", { name: "Task" })
  const save = vi.fn(async () => {})
  rerender(<MarkdownContent content="- [ ] Task" saveCheckbox={save} />)
  expect(parse).toHaveBeenCalledTimes(1)
  expect(screen.getByRole("checkbox")).toBe(checkbox)
  fireEvent.click(checkbox)
  expect(save).toHaveBeenCalledTimes(1)
})
