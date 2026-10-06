import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { TaskMarkdown, toggleMarkdown, type CheckboxEdit } from "./task-markdown";

afterEach(cleanup);

it("maps parser positions for nested, duplicate, ordered and quoted tasks while preserving CRLF and code", async () => {
  const content = "😀 heading\r\n\r\n1. [ ] duplicate\r\n   - [X] duplicate\r\n2. [ ] duplicate\r\n\r\n> - [ ] quoted\r\n\r\n```md\r\n- [ ] code\r\n```\r\n\r\n    - [ ] indented code\r\n\r\n`- [ ] inline`\r\n";
  const edits: CheckboxEdit[] = [];
  const save = vi.fn(async (edit: CheckboxEdit) => { edits.push(edit); });
  render(<TaskMarkdown content={content} saveCheckbox={save} />);
  expect(screen.getAllByRole("checkbox")).toHaveLength(4);
  fireEvent.click(screen.getAllByRole("checkbox")[1]);
  await waitFor(() => expect(edits).toHaveLength(1));
  expect(edits[0]).toEqual({ expected: content, offset: content.indexOf("[X]") + 1, checked: false });
  expect(toggleMarkdown(edits[0])).toBe(content.replace("[X]", "[ ]"));
  await waitFor(() => expect(screen.getAllByRole("checkbox")[1]).not.toBeChecked());
  fireEvent.click(screen.getAllByRole("checkbox")[2]);
  await waitFor(() => expect(edits).toHaveLength(2));
  expect(edits[1].offset).toBe(content.indexOf("2. [ ]") + 4);
  expect(edits[1].expected).toBe(content.replace("[X]", "[ ]"));
});

it("uses accessible native controls, guards pending clicks and retains the original on failure", async () => {
  let reject!: (error: Error) => void;
  const save = vi.fn(() => new Promise<void>((_resolve, fail) => { reject = fail; }));
  render(<TaskMarkdown content="- [ ] Test task" saveCheckbox={save} />);
  const checkbox = screen.getByRole("checkbox", { name: "Test task" });
  expect(checkbox).toBeEnabled();
  checkbox.focus();
  expect(checkbox).toHaveFocus();
  fireEvent.click(checkbox);
  expect(checkbox).toBeDisabled();
  fireEvent.click(checkbox);
  expect(save).toHaveBeenCalledTimes(1);
  reject(new Error("Markdown changed. Refresh and retry."));
  expect(await screen.findByRole("alert")).toHaveTextContent("Markdown changed");
  expect(checkbox).not.toBeChecked();
  expect(checkbox).toBeEnabled();
});

it("clearly disables read-only sources and follows fresh persisted content", async () => {
  const { rerender } = render(<TaskMarkdown content="- [ ] persisted" />);
  expect(screen.getByRole("checkbox", { name: "persisted" })).toBeDisabled();
  expect(screen.getByRole("checkbox")).toHaveAttribute("title", "Read-only Markdown");
  rerender(<TaskMarkdown content="- [x] persisted" />);
  expect(screen.getByRole("checkbox")).toBeChecked();
  rerender(<TaskMarkdown content="- [ ] persisted" saveCheckbox={async () => {}} />);
  fireEvent.click(screen.getByRole("checkbox"));
  await waitFor(() => expect(screen.getByRole("checkbox")).toBeChecked());
  rerender(<TaskMarkdown content="- [ ] persisted\n- [ ] added by peer" saveCheckbox={async () => {}} />);
  expect(screen.getAllByRole("checkbox")[0]).not.toBeChecked();
});
