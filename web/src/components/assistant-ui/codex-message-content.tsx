import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useAuiState } from "@assistant-ui/react";
import { parseCodexMessage } from "@/lib/codex-message-format";
import { workspaceFileMarkdownComponents, workspaceMarkdownUrlTransform } from "@/components/assistant-ui/workspace-file-markdown";

function Markdown({ text }: { text: string }) {
  return <div className="aui-markdown"><ReactMarkdown components={workspaceFileMarkdownComponents} remarkPlugins={[remarkGfm]} urlTransform={workspaceMarkdownUrlTransform}>{text}</ReactMarkdown></div>;
}

function artifactLink(path: string, label: string) {
  const title = label.replace(/[\[\]]/g, "");
  return `[${title}](<${encodeURI(path).replace(/>/g, "%3E")}>)`;
}

export function CodexMessageContent({ content, user = false }: { content: string; user?: boolean }) {
  return <div className="space-y-2">{parseCodexMessage(content).map((part, index) => {
    switch (part.type) {
      case "text": return user
        ? <div key={index} className="whitespace-pre-wrap break-words">{part.text}</div>
        : <Markdown key={index} text={part.text} />;
      case "question-reply": return <div key={index} className="space-y-3">{part.replies.map((reply, replyIndex) => <div key={replyIndex}>
        <div className="mb-1 text-[10px] font-medium text-muted-foreground">Reply to Codex</div>
        <blockquote className="mb-2 whitespace-pre-wrap break-words border-l-2 border-border pl-2 text-xs text-muted-foreground">{reply.question}</blockquote>
        <div className="whitespace-pre-wrap break-words">{reply.answer}</div>
      </div>)}</div>;
      case "plan": return <section key={index} className="rounded-md border border-border p-3"><div className="mb-2 text-xs font-medium text-muted-foreground">Proposed plan</div><Markdown text={part.text} /></section>;
      case "notice": return <div key={index} className="rounded-md border border-border px-3 py-2 text-xs text-muted-foreground"><div className="mb-1 font-medium">Turn interrupted</div><p className="whitespace-pre-wrap break-words">{part.text}</p></div>;
      case "review": return <section key={index} className="rounded-md border border-border bg-secondary/20 p-3">
        <div className="mb-2 flex items-start gap-2"><span className="text-sm font-medium">{part.title}</span>{part.priority !== undefined && !part.title.includes(`[P${part.priority}]`) && <span className="rounded border border-border px-1 text-[10px] text-muted-foreground">P{part.priority}</span>}</div>
        <Markdown text={part.body} />
        {part.file && <div className="mt-2 break-words text-xs text-muted-foreground"><Markdown text={artifactLink(`${part.file}${part.start !== undefined ? `:${part.start}` : ""}`, `${part.file.split(/[\\/]/).pop()}${part.start !== undefined ? `:${part.start}${part.end !== undefined && part.end !== part.start ? `–${part.end}` : ""}` : ""}`)} /></div>}
      </section>;
      case "artifact": return <div key={index} className="rounded-md border border-border p-3 text-xs"><div className="mb-1 font-medium text-muted-foreground">{part.label}</div><Markdown text={artifactLink(part.path, part.path.split(/[\\/]/).pop() ?? part.path)} /></div>;
      case "context": return <details key={index} className="rounded-md border border-border/70 text-xs text-muted-foreground">
        <summary className="cursor-pointer px-3 py-2">{part.label}</summary>
        <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words border-t border-border/50 px-3 py-2 text-[11px]">{part.text}</pre>
      </details>;
    }
  })}</div>;
}

export function CodexMessageText() {
  const content = useAuiState((state) => state.message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n\n"));
  const user = useAuiState((state) => state.message.role === "user");
  return <CodexMessageContent content={content} user={user} />;
}
