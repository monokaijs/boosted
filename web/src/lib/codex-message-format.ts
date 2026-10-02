export type CodexMessagePart =
  | { type: "text"; text: string }
  | { type: "question-reply"; replies: { question: string; answer: string; questionItemId?: string }[] }
  | { type: "plan"; text: string }
  | { type: "notice"; text: string }
  | { type: "review"; title: string; body: string; file?: string; start?: number; end?: number; priority?: number }
  | { type: "artifact"; label: string; path: string }
  | { type: "context"; label: string; text: string };

const contextLabels: Record<string, string> = {
  environment_context: "Environment context",
  recommended_plugins: "Recommended plugins",
  INSTRUCTIONS: "Project instructions",
  codex_internal_context: "Codex context",
  external_codex_apps_open_page: "Open page context",
  "in-app-browser-context": "Browser context",
  skill: "Skill instructions",
};

function isProtocolTag(tag: string) {
  return Object.hasOwn(contextLabels, tag)
    || ["send_user_message_question_reply", "proposed_plan", "turn_aborted"].includes(tag)
    || /^(?:codex_|external_codex_|send_user_message_)/.test(tag);
}

function formattedPayload(text: string) {
  try { return JSON.stringify(JSON.parse(text), null, 2); }
  catch { return text; }
}

function protocolPart(tag: string, body: string): CodexMessagePart {
  if (tag === "send_user_message_question_reply") {
    try {
      const replies: unknown = JSON.parse(body);
      if (Array.isArray(replies) && replies.length > 0 && replies.every((reply) =>
        reply && typeof reply === "object" && typeof reply.question === "string" && typeof reply.answer === "string",
      )) {
        return { type: "question-reply", replies: replies.map(({ question, answer, questionItemId }) => ({ question, answer, ...(typeof questionItemId === "string" ? { questionItemId } : {}) })) };
      }
    } catch { /* Keep malformed or future payloads available in details. */ }
  }
  if (tag === "proposed_plan") return { type: "plan", text: body };
  if (tag === "turn_aborted") return { type: "notice", text: body };
  return { type: "context", label: contextLabels[tag] ?? tag.replace(/[_-]/g, " "), text: formattedPayload(body) };
}

function directivePart(name: string, body: string): CodexMessagePart {
  const attributes: Record<string, string | number> = {};
  // Values use quoted strings with JSON-style escapes, or integer literals.
  const attribute = /\s*([A-Za-z_]\w*)=("(?:\\.|[^"\\])*"|-?\d+)\s*/y;
  let cursor = 0;
  while (cursor < body.length) {
    attribute.lastIndex = cursor;
    const match = attribute.exec(body);
    if (!match) break;
    try { attributes[match[1]] = JSON.parse(match[2]); }
    catch { break; }
    cursor = attribute.lastIndex;
  }
  if (name === "code-comment" && cursor === body.length && typeof attributes.title === "string" && typeof attributes.body === "string") {
    return {
      type: "review", title: attributes.title, body: attributes.body,
      file: typeof attributes.file === "string" ? attributes.file : undefined,
      start: typeof attributes.start === "number" ? attributes.start : undefined,
      end: typeof attributes.end === "number" ? attributes.end : undefined,
      priority: typeof attributes.priority === "number" ? attributes.priority : undefined,
    };
  }
  return { type: "context", label: name.replace(/-/g, " "), text: body };
}

export function codexQuestionItemId(messageId: string, index: number) {
  return JSON.stringify(["request_user_input_async", messageId, index]);
}

export function codexQuestionReply(messageId: string, questions: { title: string }[], answers: Record<string, { answers: string[] }>) {
  const replies = questions.map((question, index) => ({
    questionItemId: codexQuestionItemId(messageId, index), question: question.title, answer: answers[String(index)].answers.join("\n"),
  }));
  return `<send_user_message_question_reply> ${JSON.stringify(replies)} </send_user_message_question_reply>`;
}

/** Recognize standalone protocol envelopes, leaving quoted examples and HTML alone. */
export function parseCodexMessage(content: string): CodexMessagePart[] {
  const parts: CodexMessagePart[] = [];
  const lines = content.split(/(?<=\n)/);
  let offset = 0;
  let textStart = 0;
  let consumedUntil = 0;
  let fence: { character: string; length: number } | undefined;
  for (const line of lines) {
    const lineStart = offset;
    offset += line.length;
    if (lineStart < consumedUntil) continue;
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})([^\r\n]*)/);
    if (marker) {
      if (!fence) fence = { character: marker[1][0], length: marker[1].length };
      else if (marker[1][0] === fence.character && marker[1].length >= fence.length && !marker[2].trim()) fence = undefined;
      continue;
    }
    if (fence) continue;
    const visualization = line.match(/^ {0,3}visualize([^\r\n]*)\s*$/);
    if (visualization) {
      const text = content.slice(textStart, lineStart);
      if (text.trim()) parts.push({ type: "text", text });
      let part: CodexMessagePart = { type: "context", label: "Visualization", text: visualization[1] };
      try {
        const payload: unknown = JSON.parse(visualization[1]);
        if (payload && typeof payload === "object" && "path" in payload && typeof payload.path === "string") {
          part = { type: "artifact", label: "Visualization", path: payload.path };
        }
      } catch { /* Keep unresolved visualization references inspectable. */ }
      parts.push(part);
      textStart = offset;
      consumedUntil = offset;
      continue;
    }
    const directive = line.match(/^ {0,3}::([a-z][\w-]*)\{((?:"(?:\\.|[^"\\])*"|[^"\r\n])*)\}\s*$/);
    if (directive) {
      const text = content.slice(textStart, lineStart);
      if (text.trim()) parts.push({ type: "text", text });
      parts.push(directivePart(directive[1], directive[2]));
      textStart = offset;
      consumedUntil = offset;
      continue;
    }
    const opening = line.match(/^ {0,3}<([A-Za-z_][\w-]*)(?:\s[^<>]*?)?>/);
    if (!opening || !isProtocolTag(opening[1])) continue;
    const tag = opening[1];
    const bodyStart = lineStart + opening[0].length;
    const closingTag = `</${tag}>`;
    let closing = content.indexOf(closingTag, bodyStart);
    // Payload strings may themselves mention the closing tag.
    while (closing >= 0) {
      const end = closing + closingTag.length;
      const lineEnd = content.indexOf("\n", end);
      if (!content.slice(end, lineEnd < 0 ? content.length : lineEnd).trim()) break;
      closing = content.indexOf(closingTag, end);
    }
    if (closing < 0) continue; // Streaming and incomplete envelopes remain visible.
    const end = closing + closingTag.length;
    const text = content.slice(textStart, lineStart);
    if (text.trim()) parts.push({ type: "text", text });
    parts.push(protocolPart(tag, content.slice(bodyStart, closing).trim()));
    textStart = end;
    consumedUntil = end;
  }
  const remaining = content.slice(textStart);
  if (remaining.trim()) parts.push({ type: "text", text: remaining });
  return parts.length ? parts : [{ type: "text", text: content }];
}
