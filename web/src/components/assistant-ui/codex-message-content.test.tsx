import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodexMessageContent } from "@/components/assistant-ui/codex-message-content";
import { CodexQuestionForm } from "@/components/assistant-ui/codex-question-form";
import { ApiClientProvider } from "@/lib/api-context";
import { createBoostedApiClient } from "@/lib/api";

describe("Codex transcript rendering", () => {
  afterEach(cleanup);
  it("renders readable question replies and escapes user content", () => {
    const content = `<send_user_message_question_reply>${JSON.stringify([{ questionItemId: "internal-id", question: "Where is it?", answer: "where can i get it? <script>bad()</script>" }])}</send_user_message_question_reply>`;
    const { container } = render(<CodexMessageContent content={content} user />);
    expect(screen.getByText("Where is it?")).toBeInTheDocument();
    expect(screen.getByText("where can i get it? <script>bad()</script>")).toBeInTheDocument();
    expect(container.textContent).not.toContain("internal-id");
    expect(container.textContent).not.toContain("send_user_message_question_reply");
    expect(container.querySelector("script")).toBeNull();
  });

  it("collapses context while retaining its contents and renders plan markdown", () => {
    const { container } = render(<CodexMessageContent content={'<environment_context><cwd>/repo</cwd></environment_context>\n<proposed_plan>\n# Ship it\n\n- Verify\n</proposed_plan>'} />);
    expect(screen.getByText("Environment context")).toBeInTheDocument();
    expect(container.querySelector("details")).not.toHaveAttribute("open");
    expect(screen.getByText("<cwd>/repo</cwd>")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Ship it" })).toBeInTheDocument();
    expect(screen.getByText("Verify")).toBeInTheDocument();
  });

  it("renders review directives with a source link and readable finding", () => {
    const client = createBoostedApiClient({ profile: { id: "test", baseUrl: "http://localhost:4782" }, getToken: () => undefined });
    render(<ApiClientProvider client={client}><CodexMessageContent content={'::code-comment{title="Fix animation" body="Respect **Reduce Motion**." file="/repo/sheet.tsx" start=12 end=15 priority=2}'} /></ApiClientProvider>);
    expect(screen.getByText("Fix animation")).toBeInTheDocument();
    expect(screen.getByText("Reduce Motion")).toBeInTheDocument();
    expect(screen.getByText("P2")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "sheet.tsx:12–15" })).toHaveAttribute("href", "/repo/sheet.tsx:12");
    expect(screen.queryByText(/::code-comment/)).not.toBeInTheDocument();
  });

  it("submits only explicitly supplied answers for all questions", async () => {
    const onSubmit = vi.fn(async () => {});
    render(<CodexQuestionForm requestId="request" questions={[
      { id: "q1", header: "Choice", question: "Which one?", options: [{ label: "First", description: "Details" }, { label: "Second", description: "" }] },
      { id: "q2", header: "Text", question: "Why?" },
    ]} onSubmit={onSubmit} />);
    fireEvent.click(screen.getByRole("button", { name: "Answer questions" }));
    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
    fireEvent.click(screen.getByRole("radio", { name: "First" }));
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByRole("button", { name: "Send answers" })).toBeDisabled();
    fireEvent.change(screen.getByRole("textbox", { name: "Answer: Why?" }), { target: { value: "My reason" } });
    fireEvent.click(screen.getByRole("button", { name: "Send answers" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith({ q1: { answers: ["First"] }, q2: { answers: ["My reason"] } }));
    expect(await screen.findByText("Answers sent to Codex.")).toBeInTheDocument();
  });

  it("keeps answers available after a submission failure and permits retry", async () => {
    const onSubmit = vi.fn().mockRejectedValueOnce(new Error("Connection lost")).mockResolvedValueOnce(undefined);
    render(<CodexQuestionForm requestId="request" questions={[{ id: "q", header: "Question", question: "Answer?" }]} onSubmit={onSubmit} />);
    fireEvent.click(screen.getByRole("button", { name: "Answer question" }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Custom answer" } });
    fireEvent.click(screen.getByRole("button", { name: "Send answers" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Connection lost");
    expect(screen.getByRole("textbox")).toHaveValue("Custom answer");
    fireEvent.click(screen.getByRole("button", { name: "Send answers" }));
    expect(await screen.findByText("Answers sent to Codex.")).toBeInTheDocument();
    expect(onSubmit).toHaveBeenCalledTimes(2);
  });
});
