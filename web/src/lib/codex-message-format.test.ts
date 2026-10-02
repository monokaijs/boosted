import { describe, expect, it } from "vitest";
import { codexQuestionItemId, codexQuestionReply, parseCodexMessage } from "@/lib/codex-message-format";

describe("Codex protocol message presentation", () => {
  it("decodes the question reply format without displaying internal ids", () => {
    const id = '["request_user_input_async","call_vlGNfSBb8K69BPOIwFzEbB0n",0]';
    const text = `<send_user_message_question_reply> ${JSON.stringify([{ questionItemId: id, question: "Where is the signing certificate?", answer: "where can i get it?" }])} </send_user_message_question_reply>`;
    expect(parseCodexMessage(text)).toEqual([{ type: "question-reply", replies: [{ questionItemId: id, question: "Where is the signing certificate?", answer: "where can i get it?" }] }]);
  });

  it("retains every question and answer, including whitespace and markup", () => {
    const replies = [{ question: "First?", answer: "<script>alert(1)</script>\n\nSecond line" }, { question: "Second?", answer: "" }];
    expect(parseCodexMessage(`<send_user_message_question_reply>${JSON.stringify(replies)}</send_user_message_question_reply>`)).toEqual([{ type: "question-reply", replies }]);
  });

  it("preserves text around multiple context blocks, attributes, and a plan", () => {
    const text = 'Before\n<environment_context>\n<cwd>/repo</cwd>\n</environment_context>\nBetween\n<codex_internal_context source="goal">Goal</codex_internal_context>\n<proposed_plan>\n# Plan\n\n- Ship\n</proposed_plan>\nAfter';
    expect(parseCodexMessage(text)).toEqual([
      { type: "text", text: "Before\n" }, { type: "context", label: "Environment context", text: "<cwd>/repo</cwd>" },
      { type: "text", text: "\nBetween\n" }, { type: "context", label: "Codex context", text: "Goal" },
      { type: "plan", text: "# Plan\n\n- Ship" }, { type: "text", text: "\nAfter" },
    ]);
  });

  it.each([
    ["recommended_plugins", "Recommended plugins"], ["INSTRUCTIONS", "Project instructions"],
    ["external_codex_apps_open_page", "Open page context"], ["in-app-browser-context", "Browser context"], ["skill", "Skill instructions"],
  ])("labels the %s context format", (tag, label) => {
    expect(parseCodexMessage(`<${tag}>payload</${tag}>`)).toEqual([{ type: "context", label, text: "payload" }]);
  });

  it("presents interruptions as notices", () => {
    expect(parseCodexMessage("<turn_aborted>Stopped by user.</turn_aborted>")).toEqual([{ type: "notice", text: "Stopped by user." }]);
  });

  it.each(["not json", "[]", "null", '{"answer":"yes"}', '[{"question":"q","answer":42}]'])("retains unsupported reply payloads: %s", (payload) => {
    const result = parseCodexMessage(`<send_user_message_question_reply>${payload}</send_user_message_question_reply>`)[0];
    expect(result.type).toBe("context");
    if (result.type === "context") expect(result.text).toBeTruthy();
  });

  it.each([
    '```xml\n<proposed_plan>Example</proposed_plan>\n```',
    '~~~xml\n<environment_context>Example</environment_context>\n~~~',
    '````xml\n```\n<proposed_plan>Example</proposed_plan>\n````',
    '  ```xml\n<proposed_plan>Example</proposed_plan>\n  ```',
    'Use `<proposed_plan>Example</proposed_plan>`.',
    '> <proposed_plan>Example</proposed_plan>',
    '<div>Real HTML</div>', '<custom_component>XML</custom_component>',
    '<proposed_plan>Streaming', '    <proposed_plan>Indented code</proposed_plan>',
  ])("leaves ordinary messages and code examples intact", (text) => {
    expect(parseCodexMessage(text)).toEqual([{ type: "text", text }]);
  });

  it("keeps future protocol envelopes inspectable", () => {
    expect(parseCodexMessage('<external_codex_new_context>{"key":true}</external_codex_new_context>')).toEqual([
      { type: "context", label: "external codex new context", text: '{\n  "key": true\n}' },
    ]);
  });

  it("round-trips async answers with exact question references and closing tags in text", () => {
    const questions = [{ title: "First?" }, { title: "Second?" }];
    const content = codexQuestionReply("call-1", questions, { "0": { answers: ["Use </send_user_message_question_reply> here"] }, "1": { answers: ["yes", "details"] } });
    expect(parseCodexMessage(content)).toEqual([{ type: "question-reply", replies: [
      { questionItemId: codexQuestionItemId("call-1", 0), question: "First?", answer: "Use </send_user_message_question_reply> here" },
      { questionItemId: codexQuestionItemId("call-1", 1), question: "Second?", answer: "yes\ndetails" },
    ] }]);
  });

  it("decodes review directives with escaped quotes, braces, and source locations", () => {
    const text = 'Before\n::code-comment{title="[P2] Fix this" body="Use \\"safe\\" and {braces}." file="/repo/main.ts" start=12 end=15 priority=2}\nAfter';
    expect(parseCodexMessage(text)).toEqual([
      { type: "text", text: "Before\n" },
      { type: "review", title: "[P2] Fix this", body: 'Use "safe" and {braces}.', file: "/repo/main.ts", start: 12, end: 15, priority: 2 },
      { type: "text", text: "After" },
    ]);
  });

  it.each(['```text\n::code-comment{title="Example" body="Body"}\n```', '`::code-comment{title="Example" body="Body"}`'])("preserves directive examples", (text) => {
    expect(parseCodexMessage(text)).toEqual([{ type: "text", text }]);
  });

  it("retains future or malformed directive attributes in details", () => {
    expect(parseCodexMessage('::code-comment{title="Missing body"}')[0]).toEqual({ type: "context", label: "code comment", text: 'title="Missing body"' });
    expect(parseCodexMessage('::future-widget{title="Hello"}')[0]).toEqual({ type: "context", label: "future widget", text: 'title="Hello"' });
  });

  it("presents visualization references as artifact links and preserves invalid metadata", () => {
    expect(parseCodexMessage('visualize{"path":"/repo/preview.html"}')).toEqual([{ type: "artifact", label: "Visualization", path: "/repo/preview.html" }]);
    expect(parseCodexMessage('visualizebad')).toEqual([{ type: "context", label: "Visualization", text: "bad" }]);
    const example = '```text\nvisualize{"path":"/repo/preview.html"}\n```';
    expect(parseCodexMessage(example)).toEqual([{ type: "text", text: example }]);
  });
});
