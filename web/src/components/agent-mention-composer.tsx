import { useRef, useState, type RefObject } from "react";
import { Send } from "lucide-react";
import { AgentAvatar } from "@/features/agents/components/session/agent-avatar";
import type { AssistantSummary } from "@/features/agents/types/assistant";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

export function agentMention(name: string) {
  return /\s/.test(name) ? `@(${name})` : `@${name}`;
}

export function AgentMentionComposer({ value, onChange, onSend, agents, pending, inputRef }: {
  value: string; onChange(value: string): void; onSend(): void;
  agents: readonly AssistantSummary[]; pending: boolean; inputRef?: RefObject<HTMLTextAreaElement | null>;
}) {
  const fallbackInput = useRef<HTMLTextAreaElement>(null);
  const input = inputRef ?? fallbackInput;
  const [cursor, setCursor] = useState(value.length);
  const [highlighted, setHighlighted] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const prefix = value.slice(0, cursor);
  const match = prefix.match(/(?:^|\s)@(\([^)]*|[^\s@()]*)$/);
  const query = match?.[1].replace(/^\(/, "").toLowerCase();
  const suggestions = !dismissed && query !== undefined ? agents.filter((agent) => agent.profile.name.toLowerCase().startsWith(query)) : [];
  const active = Math.min(highlighted, Math.max(0, suggestions.length - 1));

  function select(agent: AssistantSummary) {
    const start = prefix.lastIndexOf("@");
    const mention = `${agentMention(agent.profile.name)} `;
    onChange(`${value.slice(0, start)}${mention}${value.slice(cursor)}`);
    const next = start + mention.length;
    setCursor(next); setDismissed(true);
    requestAnimationFrame(() => { input.current?.focus(); input.current?.setSelectionRange(next, next); });
  }

  return <div className="task-comment-composer">
    {suggestions.length > 0 && <div id="task-agent-suggestions" role="listbox" aria-label="Mention an agent" className="task-agent-suggestions">
      {suggestions.map((agent, index) => <button key={agent.id} id={`task-mention-${agent.id}`} type="button" role="option" aria-label={`Mention ${agent.profile.name}`} aria-selected={index === active} onMouseDown={(event) => event.preventDefault()} onClick={() => select(agent)}>
        <AgentAvatar name={agent.profile.name} avatar={agent.profile.avatar} className="size-6 text-[10px]" /><span>{agent.profile.name}</span><small>Mention</small>
      </button>)}
    </div>}
    <div className="task-comment-input">
      <Textarea ref={input} aria-label="Task comment" aria-autocomplete="list" aria-controls={suggestions.length ? "task-agent-suggestions" : undefined} aria-activedescendant={suggestions.length ? `task-mention-${suggestions[active].id}` : undefined}
        className="min-h-10 flex-1 border-0 bg-transparent p-1.5 shadow-none focus-visible:border-0 focus-visible:ring-0"
        placeholder="Add a comment, or @mention an agent…" value={value} disabled={pending}
        onChange={(event) => { onChange(event.target.value); setCursor(event.target.selectionStart); setHighlighted(0); setDismissed(false); requestAnimationFrame(() => { if (input.current) setCursor(input.current.selectionStart); }); }}
        onSelect={(event) => setCursor(event.currentTarget.selectionStart)}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (suggestions.length && ["ArrowDown", "ArrowUp", "Enter", "Tab", "Escape"].includes(event.key) && !event.shiftKey) {
            event.preventDefault();
            if (event.key === "Escape") setDismissed(true);
            else if (event.key === "ArrowDown") setHighlighted((active + 1) % suggestions.length);
            else if (event.key === "ArrowUp") setHighlighted((active + suggestions.length - 1) % suggestions.length);
            else select(suggestions[active]);
          } else if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); onSend(); }
        }} />
      <Button type="button" onClick={onSend} size="icon" aria-label="Send comment" disabled={!value.trim() || pending}><Send /></Button>
    </div>
    <p className="task-comment-hint">Mention an agent to ask a question, plan, or start work. Shift + Enter for a new line.</p>
  </div>;
}
