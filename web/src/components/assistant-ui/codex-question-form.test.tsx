import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodexQuestionForm } from "./codex-question-form";
import type { CodexQuestion } from "@/lib/types";

const questions: CodexQuestion[] = [
  { id: "choice", header: "Scope", question: "Which scope?", options: [{ label: "First (Recommended)", description: "First details" }, { label: "Second", description: "Second details" }], isOther: false },
  { id: "text", header: "Reason", question: "Why?" },
  { id: "secret", header: "Credential", question: "What secret?", isSecret: true },
];
function open() { fireEvent.click(screen.getByRole("button", { name: /^Answer question/ })); }
function next() { fireEvent.click(screen.getByRole("button", { name: "Next" })); }
function back() { fireEvent.click(screen.getByRole("button", { name: "Back" })); }
function answer(value: string) { fireEvent.change(screen.getByLabelText(/^Answer:/), { target: { value } }); }
function send() { fireEvent.click(screen.getByRole("button", { name: "Send answers" })); }
afterEach(cleanup);

describe("Codex question wizard", () => {
  it("shows one question per step without defaults, preserves choices/text/secret on Back, and sends only at the end", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<CodexQuestionForm requestId="request-a" questions={questions} onSubmit={onSubmit} />);
    open();
    expect(screen.getByText("Question 1/3")).toBeInTheDocument();
    expect(screen.getByRole("progressbar")).toHaveAttribute("value", "1");
    expect(screen.queryByLabelText("Answer: Why?")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Back" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
    expect(screen.getAllByRole("radio").every((radio) => !(radio as HTMLInputElement).checked)).toBe(true);
    expect(screen.getByRole("radio", { name: "First (Recommended)" })).toHaveAccessibleDescription("First details");
    fireEvent.submit(screen.getByRole("form"));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByText("Question 1/3")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("radio", { name: "Second" }));
    expect(screen.getByRole("textbox")).toHaveValue("Second");
    next();
    expect(screen.getByText("Question 2/3")).toBeInTheDocument();
    expect(document.activeElement?.tagName).toBe("LEGEND");
    answer("  A custom reason\nwith details  ");
    back();
    expect(screen.getByRole("radio", { name: "Second" })).toBeChecked();
    answer("My custom scope");
    expect(screen.getAllByRole("radio").every((radio) => !(radio as HTMLInputElement).checked)).toBe(true);
    next();
    expect(screen.getByRole("textbox")).toHaveValue("  A custom reason\nwith details  ");
    next();
    expect(screen.getByText("Question 3/3")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Next" })).not.toBeInTheDocument();
    expect(screen.getByLabelText("Answer: What secret?")).toHaveAttribute("type", "password");
    answer("secret");
    back(); next();
    expect(screen.getByLabelText("Answer: What secret?")).toHaveValue("secret");
    expect(onSubmit).not.toHaveBeenCalled();
    send();
    await waitFor(() => expect(onSubmit).toHaveBeenCalledExactlyOnceWith({
      choice: { answers: ["My custom scope"] }, text: { answers: ["A custom reason\nwith details"] }, secret: { answers: ["secret"] },
    }));
    expect(await screen.findByText("Answers sent to Codex.")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("keeps a single question simple and rejects whitespace answers", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<CodexQuestionForm requestId="single" questions={[questions[1]]} onSubmit={onSubmit} />);
    open();
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Back" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Next" })).not.toBeInTheDocument();
    answer(" \n ");
    expect(screen.getByRole("button", { name: "Send answers" })).toBeDisabled();
    fireEvent.submit(screen.getByRole("form"));
    expect(onSubmit).not.toHaveBeenCalled();
    answer("Yes"); send();
    expect(await screen.findByText("Answers sent to Codex.")).toBeInTheDocument();
  });

  it("preserves drafts and the current stage after closing and reopening", async () => {
    render(<CodexQuestionForm requestId="close" questions={questions} onSubmit={vi.fn()} />);
    open(); answer("Custom"); next(); answer("Draft");
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "Continue answers" })).toHaveFocus());
    fireEvent.click(screen.getByRole("button", { name: "Continue answers" }));
    expect(screen.getByText("Question 2/3")).toBeInTheDocument();
    expect(screen.getByRole("textbox")).toHaveValue("Draft");
    back(); expect(screen.getByRole("textbox")).toHaveValue("Custom");
  });

  it("guards repeated submit events, preserves every answer on failure, and allows an explicit retry", async () => {
    let reject!: (reason: Error) => void;
    const onSubmit = vi.fn().mockImplementationOnce(() => new Promise<void>((_, fail) => { reject = fail; })).mockResolvedValueOnce(undefined);
    render(<CodexQuestionForm requestId="retry" questions={questions.slice(0, 2)} onSubmit={onSubmit} />);
    open(); answer("Scope"); next(); answer("Reason");
    const form = screen.getByRole("form");
    act(() => { fireEvent.submit(form); fireEvent.submit(form); fireEvent.submit(form); });
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Sending…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Back" })).toBeDisabled();
    await act(async () => reject(new Error("Connection lost")));
    expect(screen.getByRole("alert")).toHaveTextContent("Connection lost");
    expect(screen.getByRole("textbox")).toHaveValue("Reason");
    back(); expect(screen.getByRole("textbox")).toHaveValue("Scope"); next();
    send();
    expect(await screen.findByText("Answers sent to Codex.")).toBeInTheDocument();
    expect(onSubmit).toHaveBeenCalledTimes(2);
    // Even a retained reference to the removed form cannot submit again after success.
    fireEvent.submit(form);
    expect(onSubmit).toHaveBeenCalledTimes(2);
  });

  it("retains state across equivalent polling payloads but resets on a different request or changed questions", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const { rerender } = render(<CodexQuestionForm requestId="a" questions={questions} onSubmit={onSubmit} />);
    open(); answer("Scope"); next(); answer("Reason");
    rerender(<CodexQuestionForm requestId="a" questions={structuredClone(questions)} onSubmit={onSubmit} />);
    expect(screen.getByText("Question 2/3")).toBeInTheDocument();
    expect(screen.getByRole("textbox")).toHaveValue("Reason");
    rerender(<CodexQuestionForm requestId="b" questions={questions} onSubmit={onSubmit} />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    open(); expect(screen.getByText("Question 1/3")).toBeInTheDocument();
    expect(screen.getByRole("textbox")).toHaveValue("");
    answer("Scope"); next(); answer("Reason"); next(); answer("Secret"); send();
    await screen.findByText("Answers sent to Codex.");
    rerender(<CodexQuestionForm requestId="c" questions={questions} onSubmit={onSubmit} />);
    open(); expect(screen.getByRole("textbox")).toHaveValue("");
    rerender(<CodexQuestionForm requestId="c" questions={[{ ...questions[1], question: "New question?" }]} onSubmit={onSubmit} />);
    open(); expect(screen.getByLabelText("Answer: New question?")).toHaveValue("");
  });

  it("does not let an old in-flight response mark a replacement request as sent", async () => {
    let resolve!: () => void;
    const oldSubmit = vi.fn(() => new Promise<void>((done) => { resolve = done; }));
    const newSubmit = vi.fn().mockResolvedValue(undefined);
    const { rerender } = render(<CodexQuestionForm requestId="old" questions={[questions[1]]} onSubmit={oldSubmit} />);
    open(); answer("Old"); send();
    rerender(<CodexQuestionForm requestId="new" questions={[questions[1]]} onSubmit={newSubmit} />);
    open();
    await act(async () => resolve());
    expect(screen.queryByText("Answers sent to Codex.")).not.toBeInTheDocument();
    expect(screen.getByRole("textbox")).toHaveValue("");
    answer("New"); send();
    await screen.findByText("Answers sent to Codex.");
    expect(newSubmit).toHaveBeenCalledExactlyOnceWith({ text: { answers: ["New"] } });
  });

  it("keeps simultaneous requests with identical question ids independent", async () => {
    const first = vi.fn().mockResolvedValue(undefined);
    const second = vi.fn().mockResolvedValue(undefined);
    render(<><CodexQuestionForm requestId="first" questions={[questions[0]]} onSubmit={first} /><CodexQuestionForm requestId="second" questions={[questions[0]]} onSubmit={second} /></>);
    fireEvent.click(screen.getAllByRole("button", { name: "Answer question" })[0]);
    fireEvent.click(screen.getByRole("radio", { name: "Second" }));
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    fireEvent.click(screen.getByRole("button", { name: "Answer question" }));
    expect(within(screen.getByRole("dialog")).getByRole("textbox")).toHaveValue("");
    answer("Other request"); send();
    await screen.findByText("Answers sent to Codex.");
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledExactlyOnceWith({ choice: { answers: ["Other request"] } });
    fireEvent.click(screen.getByRole("button", { name: "Continue answers" }));
    expect(screen.getByRole("radio", { name: "Second" })).toBeChecked();
  });

  it("handles an empty request without an actionable submit", () => {
    render(<CodexQuestionForm requestId="empty" questions={[]} onSubmit={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Answer question" })).toBeDisabled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
