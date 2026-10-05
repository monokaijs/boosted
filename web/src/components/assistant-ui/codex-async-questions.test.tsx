import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CodexAsyncQuestionProvider, CodexAsyncQuestions } from "./codex-async-questions";
import { codexQuestionItemId } from "@/lib/codex-message-format";
import type { ComponentProps } from "react";

const state = vi.hoisted(() => ({ message: { id: "message-a", metadata: { custom: { questions: [{ title: "Which option?", options: ["First", "Second"] }, { title: "Why?", options: null }] } } } }));
vi.mock("@assistant-ui/react", () => ({ useAuiState: (select: (value: typeof state) => unknown) => select(state) }));
afterEach(cleanup);
beforeEach(() => { state.message.id = "message-a"; });

function fixture(reply: ComponentProps<typeof CodexAsyncQuestionProvider>["value"]["reply"], requestScope = "machine:chat", answered = new Set<string>()) {
  return <CodexAsyncQuestionProvider value={{ requestScope, answered, reply }}><CodexAsyncQuestions /></CodexAsyncQuestionProvider>;
}

describe("async Codex question requests", () => {
  it("maps stages to index-keyed answer arrays and the original message/questions", async () => {
    const reply = vi.fn().mockResolvedValue(undefined);
    render(fixture(reply));
    fireEvent.click(screen.getByRole("button", { name: "Answer questions" }));
    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
    fireEvent.click(screen.getByRole("radio", { name: "Second" }));
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "A custom reason" } });
    fireEvent.click(screen.getByRole("button", { name: "Send answers" }));
    await waitFor(() => expect(reply).toHaveBeenCalledExactlyOnceWith("message-a", state.message.metadata.custom.questions, { "0": { answers: ["Second"] }, "1": { answers: ["A custom reason"] } }));
  });

  it("resets drafts for a different message and for a different machine/chat scope", () => {
    const reply = vi.fn();
    const { rerender } = render(fixture(reply));
    fireEvent.click(screen.getByRole("button", { name: "Answer questions" }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Old draft" } });
    state.message.id = "message-b";
    rerender(fixture(reply));
    fireEvent.click(screen.getByRole("button", { name: "Answer questions" }));
    expect(screen.getByRole("textbox")).toHaveValue("");
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Another draft" } });
    rerender(fixture(reply, "other-machine:chat"));
    fireEvent.click(screen.getByRole("button", { name: "Answer questions" }));
    expect(screen.getByRole("textbox")).toHaveValue("");
    expect(reply).not.toHaveBeenCalled();
  });

  it("hides only the request whose exact question references have all been answered", () => {
    const reply = vi.fn();
    const answered = new Set([codexQuestionItemId("message-a", 0), codexQuestionItemId("message-a", 1)]);
    const { rerender } = render(fixture(reply, "machine:chat", answered));
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    state.message.id = "message-b";
    rerender(fixture(reply, "machine:chat", answered));
    expect(screen.getByRole("button", { name: "Answer questions" })).toBeInTheDocument();
  });
});
