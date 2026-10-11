import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ChangeEvent, type ClipboardEvent, type CSSProperties } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AssistantRuntimeProvider,
  AuiIf,
  ComposerPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  type AppendMessage,
  type AssistantRuntime,
  type ThreadMessageLike,
  useAuiState,
  useExternalStoreRuntime,
} from "@assistant-ui/react";
import { ArrowDown, ArrowUp, Bot, Brain, Check, ChevronDown, ChevronRight, FileDiff, FilePenLine, FileText, LoaderCircle, MessageSquareText, Plus, Search, Square, Terminal, TriangleAlert, Wrench, X, type LucideIcon } from "lucide-react";
import { CodexThreadLayout } from "./codex-thread-layout";
import { CodexMessageContent, CodexMessageText } from "@/components/assistant-ui/codex-message-content";
import { CodexQuestionForm } from "@/components/assistant-ui/codex-question-form";
import { CodexModeSelect } from "@/components/assistant-ui/codex-mode-select";
import { CodexAsyncQuestionProvider, CodexAsyncQuestions } from "@/components/assistant-ui/codex-async-questions";
import { codexQuestionReply, parseCodexMessage } from "@/lib/codex-message-format";
import { WorkspaceAttachment, WorkspaceFileProvider } from "@/components/assistant-ui/workspace-file-markdown";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useBoostedApiClient } from "@/lib/api-context";
import { pinWorkspaceValue, useWorkspaceState, useWorkspaceStore } from "@/lib/workspace-state";
import { conversationQueryOptions } from "@/lib/query-client";
import { chatActivity, setCachedChatStatus } from "@/lib/codex-chat-status";
import { machinePreferenceKey, useAppStore } from "@/lib/store";
import type { CodexAccessOption, CodexAttachment, CodexChatMessage, CodexChatThread, CodexCollaborationMode, CodexFileChange, MessageAttachment } from "@/lib/types";
import "./chat-panel.css";
import "./codex-chat-panel.css";

function CodexSendButton({ disabled, hasAttachments, onSendAttachments }: { disabled: boolean; hasAttachments: boolean; onSendAttachments: () => void }) {
  const empty = useAuiState((state) => state.composer.isEmpty);
  return empty && hasAttachments
    ? <Button type="button" className="codex-send-button" size="icon-sm" title="Send message" disabled={disabled} onClick={onSendAttachments}><ArrowUp /></Button>
    : <Button asChild className="codex-send-button" size="icon-sm" disabled={disabled} title="Send message"><ComposerPrimitive.Send><ArrowUp /></ComposerPrimitive.Send></Button>;
}

type CodexSendRequest = {
  text: string;
  model: string;
  reasoningEffort: string;
  accessMode: CodexAccessOption["id"];
  collaborationMode: CodexCollaborationMode;
  approvalPolicy?: string;
  attachmentIds: string[];
};

type CodexOutboxMessage = CodexChatMessage & {
  localDelivery: "sending" | "sent" | "failed";
  sendError?: string;
  request: CodexSendRequest;
};

type CodexDisplayMessage = CodexChatMessage & {
  localDelivery?: CodexOutboxMessage["localDelivery"];
  sendError?: string;
  activity?: CodexActivity;
  changesSummary?: CodexChangesSummary;
};

type CodexActivityItem = Pick<CodexChatMessage, "id" | "content" | "kind" | "attachments"> & {
  type: "commentary" | "tool" | "reasoning" | "system";
  label: string;
};

type CodexActivity = {
  items: CodexActivityItem[];
  running: boolean;
  startedAt?: string;
  durationSeconds?: number;
};

type CodexChangesSummary = {
  files: CodexFileChange[];
  additions: number;
  deletions: number;
};

function messagesWithOutbox(messages: CodexChatMessage[], outbox: CodexOutboxMessage[]): CodexDisplayMessage[] {
  const result: CodexDisplayMessage[] = [...messages];
  for (const pending of outbox) {
    const confirmedIndex = result.findIndex((message) => message.id === pending.id);
    if (confirmedIndex >= 0) {
      result[confirmedIndex] = { ...result[confirmedIndex], localDelivery: "sent" };
      continue;
    }
    const nextIndex = result.findIndex((message) => Date.parse(message.createdAt ?? "") > Date.parse(pending.createdAt ?? ""));
    result.splice(nextIndex < 0 ? result.length : nextIndex, 0, pending);
  }
  return result;
}

const CodexRetryContext = createContext<(id: string) => void>(() => undefined);

function UserMessage() {
  const id = useAuiState((state) => state.message.id);
  const content = useAuiState((state) => state.message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n\n"));
  const attachments = useAuiState((state) => state.message.metadata.custom.attachments as MessageAttachment[] | undefined) ?? [];
  const delivery = useAuiState((state) => state.message.metadata.custom.localDelivery as CodexOutboxMessage["localDelivery"] | undefined);
  const sendError = useAuiState((state) => state.message.metadata.custom.sendError as string | undefined);
  const retry = useContext(CodexRetryContext);
  return (
    <MessagePrimitive.Root id={`codex-message-${id}`} className="chat-message-enter codex-message-column flex justify-end py-3">
      <div className="min-w-0 max-w-[88%]">
        {attachments.length > 0 && <div aria-label="Message attachments" className="mb-2 flex flex-wrap justify-end gap-2">{attachments.map((attachment, index) => <WorkspaceAttachment key={index} attachment={attachment} compact />)}</div>}
        {content && <div className="selectable-text rounded-[22px] bg-secondary px-4 py-2.5 text-left"><CodexMessageContent content={content} user /></div>}
        {delivery && <div className="codex-message-delivery" role="status" aria-live="polite">
          {delivery === "sending" && <><LoaderCircle aria-hidden="true" className="size-3 animate-spin" />Sending…</>}
          {delivery === "sent" && <><Check aria-hidden="true" className="size-3" />Sent</>}
          {delivery === "failed" && <><TriangleAlert aria-hidden="true" className="size-3 text-destructive" /><span title={sendError}>Not sent</span><button type="button" onClick={() => retry(id)}>Retry</button></>}
        </div>}
      </div>
    </MessagePrimitive.Root>
  );
}

function activityIcon(item: CodexActivityItem): LucideIcon {
  if (item.type === "reasoning") return Brain;
  if (item.type === "system") return FileText;
  if (/command|ran |npm|pnpm|cargo|git\b|shell/i.test(item.label)) return Terminal;
  if (/file|edit|patch|chang/i.test(item.label)) return FilePenLine;
  if (/search|find|read|view/i.test(item.label)) return Search;
  return Wrench;
}

function formatActivityDuration(seconds: number) {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${minutes}m${remainder ? ` ${remainder}s` : ""}`;
}

function runningActivityDuration(startedAt: string | undefined, fallback: number) {
  const started = Date.parse(startedAt ?? "");
  return Math.max(0, Math.floor((Date.now() - (Number.isFinite(started) ? started : fallback)) / 1000));
}

function ActivityMessage() {
  const id = useAuiState((state) => state.message.id);
  const activity = useAuiState((state) => state.message.metadata.custom.activity as CodexActivity);
  const [open, setOpen] = useState(activity.running);
  const fallbackStart = useRef(Date.now());
  const [elapsedSeconds, setElapsedSeconds] = useState(() => activity.durationSeconds ?? runningActivityDuration(activity.startedAt, fallbackStart.current));

  useEffect(() => setOpen(activity.running), [activity.running]);
  useEffect(() => {
    if (!activity.running) {
      if (activity.durationSeconds !== undefined) setElapsedSeconds(activity.durationSeconds);
      return;
    }
    const update = () => setElapsedSeconds(runningActivityDuration(activity.startedAt, fallbackStart.current));
    update();
    const timer = window.setInterval(update, 1000);
    return () => window.clearInterval(timer);
  }, [activity.durationSeconds, activity.running, activity.startedAt]);

  const label = `${activity.running ? "Working" : "Worked"} for ${formatActivityDuration(elapsedSeconds)}`;
  return (
    <MessagePrimitive.Root id={`codex-message-${id}`} className="chat-message-enter codex-message-column codex-activity-message">
      <button type="button" className="codex-activity-toggle" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <span>{label}</span>
        <ChevronDown aria-hidden="true" />
        <span className="codex-activity-rule" aria-hidden="true" />
      </button>
      <div className="codex-activity-disclosure" data-open={open ? "true" : "false"}>
        <div className="codex-activity-disclosure-inner" aria-hidden={!open} inert={!open}>
          {activity.items.map((item) => {
            if (item.type === "commentary") {
              return <div key={item.id} className="codex-activity-commentary"><CodexMessageContent content={item.content} attachments={item.attachments} /></div>;
            }
            const Icon = activityIcon(item);
            return <details key={item.id} className="codex-activity-item">
              <summary>
                <Icon aria-hidden="true" />
                <span>{item.label}</span>
                <ChevronDown aria-hidden="true" className="codex-activity-item-chevron" />
              </summary>
              <div className="codex-activity-item-body"><CodexMessageContent content={item.content} attachments={item.attachments} /></div>
            </details>;
          })}
        </div>
      </div>
    </MessagePrimitive.Root>
  );
}

function changeCountLabel(count: number) {
  return `${count} ${count === 1 ? "file" : "files"}`;
}

function ChangeStats({ additions, deletions }: { additions: number; deletions: number }) {
  return <span className="codex-change-stats"><b>+{additions}</b><i>−{deletions}</i></span>;
}

function openChangesPanel(path?: string, diff?: string) {
  useAppStore.getState().openGitDiff(path ? { path, staged: false, ...(diff ? { diff } : {}) } : undefined);
  window.dispatchEvent(new CustomEvent("boosted:open-panel", { detail: "git" }));
}

function RunChangesToast({ summary }: { summary: CodexChangesSummary }) {
  return <button type="button" className="codex-run-changes-toast" aria-label={`View ${changeCountLabel(summary.files.length)} changed`} aria-live="polite" onClick={() => openChangesPanel()}>
    <span>{changeCountLabel(summary.files.length)} changed</span>
    <ChangeStats additions={summary.additions} deletions={summary.deletions} />
  </button>;
}

function ChangesMessage() {
  const id = useAuiState((state) => state.message.id);
  const summary = useAuiState((state) => state.message.metadata.custom.changesSummary as CodexChangesSummary);
  const [expanded, setExpanded] = useState(false);
  const hiddenCount = Math.max(0, summary.files.length - 3);
  const files = expanded ? summary.files : summary.files.slice(0, 3);
  return <MessagePrimitive.Root id={`codex-message-${id}`} className="chat-message-enter codex-message-column py-3">
    <section className="codex-changes-block" aria-label={`Edited ${changeCountLabel(summary.files.length)}`}>
      <header>
        <span className="codex-changes-icon" aria-hidden="true"><FileDiff /></span>
        <div><strong>Edited {changeCountLabel(summary.files.length)}</strong><ChangeStats additions={summary.additions} deletions={summary.deletions} /></div>
        <Button type="button" variant="outline" size="sm" onClick={() => openChangesPanel()}>View changes</Button>
      </header>
      <div className="codex-changes-files">{files.map((change) => <button type="button" className="codex-change-file" key={change.path} onClick={() => openChangesPanel(change.path, change.diff)}>
        <span title={change.path}>{change.path}</span>
        <ChangeStats additions={change.additions} deletions={change.deletions} />
      </button>)}
      {hiddenCount > 0 && <button type="button" className="codex-changes-expand" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>
        <span>{expanded ? "Show fewer files" : `Show ${hiddenCount} more ${hiddenCount === 1 ? "file" : "files"}`}</span><ChevronDown aria-hidden="true" />
      </button>}</div>
    </section>
  </MessagePrimitive.Root>;
}

function AssistantMessage() {
  const id = useAuiState((state) => state.message.id);
  const kind = useAuiState((state) => String(state.message.metadata.custom.kind ?? "message"));
  const label = useAuiState((state) => String(state.message.metadata.custom.label ?? "Tool call"));

  if (kind === "activity") return <ActivityMessage />;
  if (kind === "changes") return <ChangesMessage />;

  if (kind === "system") {
    return <MessagePrimitive.Root id={`codex-message-${id}`} className="codex-message-column py-2 text-xs text-muted-foreground"><CodexMessageText /></MessagePrimitive.Root>;
  }
  if (kind === "tool" || kind === "reasoning") {
    return (
      <MessagePrimitive.Root id={`codex-message-${id}`} className="codex-message-column py-0.5">
        <details className="group rounded-xl bg-secondary/50 text-xs">
          <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-muted-foreground marker:hidden hover:text-foreground [&::-webkit-details-marker]:hidden">
            <ChevronRight className="size-3 shrink-0 transition-transform group-open:rotate-90" />
            <Wrench className="size-3 shrink-0" />
            <span className="min-w-0 truncate font-mono text-[11px]">{kind === "reasoning" ? "Reasoning summary" : label}</span>
          </summary>
          <div className="max-h-72 overflow-auto border-t border-border/50 px-3 py-2 text-xs"><CodexMessageText /></div>
        </details>
      </MessagePrimitive.Root>
    );
  }

  return (
    <MessagePrimitive.Root id={`codex-message-${id}`} className="chat-message-enter codex-message-column py-3">
      <div className="min-w-0">
        <CodexMessageText />
        <CodexAsyncQuestions />
      </div>
    </MessagePrimitive.Root>
  );
}

function timelineText(content: string) {
  return content
    .replace(/```[\s\S]*?```/g, " Code snippet ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " Attachment ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[*_`>#~-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

type TimelineEntry = { id: string; title: string; preview: string; markerWidth: number };

function conversationTurns(messages: CodexChatMessage[]): TimelineEntry[] {
  const turns: TimelineEntry[] = [];
  for (const message of messages) {
    const text = timelineText(message.content);
    if (message.role === "user") {
      turns.push({ id: message.id, title: text || "Message", preview: "", markerWidth: 8 + Math.min(18, Math.round(text.length / 12)) });
      continue;
    }
    const turn = turns.at(-1);
    if (!turn || !text || message.phase === "commentary" || message.kind === "tool" || message.kind === "reasoning" || message.kind === "system") continue;
    turn.preview = `${turn.preview} ${text}`.trim();
  }
  return turns;
}

function ChatTimeline({ messages }: { messages: CodexChatMessage[] }) {
  const entries = useMemo(() => conversationTurns(messages), [messages]);
  const navigationRef = useRef<HTMLElement>(null);
  const [activeId, setActiveId] = useState(entries.at(-1)?.id);

  useEffect(() => {
    const root = navigationRef.current?.closest(".codex-thread-root");
    const viewport = root?.querySelector<HTMLElement>(".codex-thread-viewport");
    if (!viewport || entries.length === 0) return;
    const update = () => {
      const bounds = viewport.getBoundingClientRect();
      const focusLine = bounds.top + Math.min(bounds.height * .34, 240);
      let closest = entries[0];
      let distance = Number.POSITIVE_INFINITY;
      for (const entry of entries) {
        const element = document.getElementById(`codex-message-${entry.id}`);
        if (!element) continue;
        const nextDistance = Math.abs(element.getBoundingClientRect().top - focusLine);
        if (nextDistance < distance) { closest = entry; distance = nextDistance; }
      }
      setActiveId(closest.id);
    };
    update();
    viewport.addEventListener("scroll", update, { passive: true });
    return () => viewport.removeEventListener("scroll", update);
  }, [entries]);

  if (entries.length < 2) return null;
  return <nav ref={navigationRef} className="chat-timeline" aria-label="Conversation timeline">
    <div className="chat-timeline-track">{entries.map((entry) => <button
      key={entry.id}
      type="button"
      className="chat-timeline-marker"
      data-active={activeId === entry.id ? "true" : undefined}
      style={{ "--timeline-marker-width": `${entry.markerWidth}px` } as CSSProperties}
      aria-label={`Jump to: ${entry.title}`}
      onClick={() => document.getElementById(`codex-message-${entry.id}`)?.scrollIntoView({ behavior: "smooth", block: "center" })}
    >
      <span aria-hidden="true" />
      <span className="chat-timeline-preview" role="tooltip">
        <strong>{entry.title}</strong>
        {entry.preview && <small>{entry.preview}</small>}
      </span>
    </button>)}</div>
  </nav>;
}

function toolLabel(content: string) {
  const firstLine = content.split("\n").find((line) => line.trim()) ?? "Tool call";
  const label = firstLine.replace(/[*`>#]/g, "").replace(/^\$\s*/, "").trim();
  return label.length > 96 ? `${label.slice(0, 93)}...` : label;
}

function activityItem(message: CodexDisplayMessage): CodexActivityItem {
  const type = message.phase === "commentary" || message.kind === "message"
    ? "commentary"
    : message.kind === "reasoning"
      ? "reasoning"
      : message.kind === "system"
        ? "system"
        : "tool";
  const label = type === "reasoning" ? "Thought through the approach" : toolLabel(message.content);
  return { id: message.id, content: message.content, kind: message.kind, attachments: message.attachments, type, label };
}

function activityDuration(messages: CodexDisplayMessage[], finalMessages: CodexDisplayMessage[]) {
  const activityTimes = messages.map((message) => Date.parse(message.createdAt ?? "")).filter(Number.isFinite);
  const allTimes = [...messages, ...finalMessages].map((message) => Date.parse(message.createdAt ?? "")).filter(Number.isFinite);
  if (activityTimes.length === 0 || allTimes.length === 0) return undefined;
  const start = Math.min(...activityTimes);
  const end = Math.max(...allTimes);
  if (end <= start) return undefined;
  return Math.max(1, Math.round((end - start) / 1000));
}

function activityStartedAt(messages: CodexDisplayMessage[]) {
  return messages
    .map((message) => message.createdAt)
    .filter((createdAt): createdAt is string => Boolean(createdAt))
    .sort((left, right) => Date.parse(left) - Date.parse(right))[0];
}

function summarizeChanges(messages: CodexDisplayMessage[]): CodexChangesSummary | undefined {
  const files = new Map<string, CodexFileChange>();
  for (const message of messages) {
    for (const change of message.changes ?? []) {
      const current = files.get(change.path);
      files.delete(change.path);
      files.set(change.path, {
        path: change.path,
        additions: (current?.additions ?? 0) + change.additions,
        deletions: (current?.deletions ?? 0) + change.deletions,
        diff: [current?.diff, change.diff].filter(Boolean).join("\n") || undefined,
      });
    }
  }
  if (files.size === 0) return undefined;
  const entries = [...files.values()].reverse();
  return {
    files: entries,
    additions: entries.reduce((total, change) => total + change.additions, 0),
    deletions: entries.reduce((total, change) => total + change.deletions, 0),
  };
}

function currentRunChanges(messages: CodexDisplayMessage[]) {
  let lastUser = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === "user") { lastUser = index; break; }
  }
  return summarizeChanges(messages.slice(lastUser + 1));
}

function compactAssistantSegment(segment: CodexDisplayMessage[], running: boolean): CodexDisplayMessage[] {
  if (segment.length === 0) return segment;
  const explicitFinal = new Set(segment
    .filter((message) => message.phase === "final_answer" || message.kind === "plan" || (message.questions?.length ?? 0) > 0)
    .map((message) => message.id));
  const hasActivity = segment.some((message) => message.phase === "commentary" || ["tool", "reasoning", "system"].includes(message.kind));
  if (explicitFinal.size === 0 && (!running || !hasActivity)) {
    const lastActivityIndex = segment.reduce((latest, message, index) => (
      message.phase === "commentary" || ["tool", "reasoning", "system"].includes(message.kind) ? index : latest
    ), -1);
    for (let index = segment.length - 1; index > lastActivityIndex; index -= 1) {
      const candidate = segment[index];
      if (candidate.kind === "message" && candidate.phase !== "commentary") {
        explicitFinal.add(candidate.id);
        break;
      }
    }
  }

  const activityMessages = segment.filter((message) => {
    if (explicitFinal.has(message.id)) return false;
    return message.phase === "commentary" || ["tool", "reasoning", "system"].includes(message.kind) || (hasActivity && message.kind === "message");
  });
  if (activityMessages.length === 0) return segment;
  const finalMessages = segment.filter((message) => !activityMessages.includes(message));
  const changesSummary = summarizeChanges(segment);
  const activity: CodexDisplayMessage = {
    id: `activity-${activityMessages[0].id}`,
    role: "assistant",
    kind: "reasoning",
    content: "",
    createdAt: activityMessages[0]?.createdAt,
    activity: {
      items: activityMessages.map(activityItem),
      running,
      startedAt: activityStartedAt(activityMessages),
      durationSeconds: activityDuration(activityMessages, finalMessages),
    },
  };
  const changes: CodexDisplayMessage[] = !running && changesSummary ? [{
    id: `changes-${activityMessages[0].id}`,
    role: "assistant",
    kind: "system",
    content: "",
    changesSummary,
  }] : [];
  return [activity, ...finalMessages, ...changes];
}

function compactCodexMessages(messages: CodexDisplayMessage[], isRunning: boolean): CodexDisplayMessage[] {
  const compacted: CodexDisplayMessage[] = [];
  let assistants: CodexDisplayMessage[] = [];
  const flush = (running: boolean) => {
    compacted.push(...compactAssistantSegment(assistants, running));
    assistants = [];
  };
  for (const message of messages) {
    if (message.role === "user") {
      flush(false);
      compacted.push(message);
    } else {
      assistants.push(message);
    }
  }
  flush(isRunning);
  return compacted;
}

const assistantMessageCache = new WeakMap<CodexDisplayMessage, ThreadMessageLike>();
function toAssistantMessage(message: CodexDisplayMessage): ThreadMessageLike {
  const cached = assistantMessageCache.get(message);
  if (cached) return cached;
  const converted: ThreadMessageLike = {
    id: message.id,
    role: message.role,
    content: [{ type: "text", text: message.content }],
    createdAt: message.createdAt ? new Date(message.createdAt) : undefined,
    metadata: { custom: { kind: message.activity ? "activity" : message.changesSummary ? "changes" : message.kind, activity: message.activity, changesSummary: message.changesSummary, attachments: message.attachments, questions: message.questions, label: message.kind === "tool" ? toolLabel(message.content) : undefined, localDelivery: message.localDelivery, sendError: message.sendError } },
  };
  assistantMessageCache.set(message, converted);
  return converted;
}

function passthroughMessage(message: ThreadMessageLike): ThreadMessageLike {
  return message;
}

function createClientMessageId() {
  return globalThis.crypto?.randomUUID?.() ?? `web-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function CodexDraftSync({ runtime, sessionKey }: { runtime: AssistantRuntime; sessionKey: string }) {
  useEffect(() => {
    const composer = runtime.thread.composer;
    const key = `${sessionKey}:draft`;
    const { generation, values, write } = useWorkspaceStore.getState();
    const unpin = pinWorkspaceValue(key);
    composer.setText(typeof values[key] === "string" ? values[key] : "");
    const unsubscribe = composer.subscribe(() => write(key, composer.getState().text, "", generation));
    return () => { unsubscribe(); unpin(); };
  }, [runtime, sessionKey]);
  return null;
}

function CodexTranscript({ thread, onThreadChange }: { thread: CodexChatThread; onThreadChange?: (threadId: string) => void }) {
  const api = useBoostedApiClient();
  const queryClient = useQueryClient();
  const selectCodexChat = useAppStore((state) => state.selectCodexChat);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const messages = thread.messages;
  const isRunning = ["running", "waiting"].includes(chatActivity(thread.chat.status));
  const sessionKey = `codex:${thread.chat.id}`;
  const setIsRunning = useCallback((running: boolean) => setCachedChatStatus(queryClient, thread.chat.id, running ? "active" : "idle"), [queryClient, thread.chat.id]);
  const [error, setError] = useWorkspaceState<string | undefined>(`${sessionKey}:error`, undefined);
  const [outbox, setOutbox] = useWorkspaceState<CodexOutboxMessage[]>(`${sessionKey}:outbox`, []);
  const [model, setModel] = useWorkspaceState(`${sessionKey}:model`, () => thread.runtimeDefaults?.model ?? localStorage.getItem(machinePreferenceKey("boosted.codex.model")) ?? thread.chat.model ?? "");
  const [reasoningEffort, setReasoningEffort] = useWorkspaceState(`${sessionKey}:reasoningEffort`, () => thread.runtimeDefaults?.reasoningEffort ?? localStorage.getItem(machinePreferenceKey("boosted.codex.effort")) ?? "");
  const [collaborationMode, setCollaborationMode] = useWorkspaceState<CodexCollaborationMode>(`${sessionKey}:collaborationMode`, () => thread.runtimeDefaults?.collaborationMode === "plan" ? "plan" : "default");
  const [accessMode, setAccessMode] = useWorkspaceState<CodexAccessOption["id"]>(`${sessionKey}:accessMode`, () => {
    const stored = thread.runtimeDefaults?.accessMode ?? localStorage.getItem(machinePreferenceKey("boosted.codex.access"));
    return stored === "workspaceWrite" || stored === "readOnly" ? stored : "fullAccess";
  });
  const [attachments, setAttachments] = useWorkspaceState<CodexAttachment[]>(`${sessionKey}:attachments`, []);
  const [isUploading, setIsUploading] = useState(false);
  const sendingIdsRef = useRef(new Set<string>());
  const codexOptions = useQuery({ queryKey: ["codex-options", thread.chat.id], queryFn: () => api.threadCodexOptions(thread.chat.id), staleTime: 60_000 });
  const approvals = useQuery({ queryKey: ["codex-approvals", thread.chat.id], queryFn: () => api.codexApprovals(thread.chat.id), refetchInterval: isRunning ? 2000 : false });
  const selectedModel = codexOptions.data?.models.find((entry) => entry.model === model || entry.id === model);
  const selectedAccess = codexOptions.data?.accessModes.find((entry) => entry.id === accessMode);
  const supportsImages = selectedModel?.inputModalities.includes("image") ?? false;

  const displayMessages = useMemo(() => messagesWithOutbox(messages, outbox), [messages, outbox]);
  const runChanges = useMemo(() => isRunning ? currentRunChanges(displayMessages) : undefined, [displayMessages, isRunning]);

  useEffect(() => {
    const confirmed = new Set(messages.map((message) => message.id));
    if (!outbox.some((message) => confirmed.has(message.id))) return;
    const timer = window.setTimeout(() => setOutbox((current) => current.filter((message) => !confirmed.has(message.id))), 1200);
    return () => window.clearTimeout(timer);
  }, [messages, outbox, setOutbox]);

  useEffect(() => {
    if (!codexOptions.data) return;
    const nextModel = codexOptions.data.models.find((entry) => entry.model === model || entry.id === model)
      ?? codexOptions.data.models.find((entry) => entry.model === thread.chat.model)
      ?? codexOptions.data.models.find((entry) => entry.model === codexOptions.data?.defaultModel)
      ?? codexOptions.data.models[0];
    if (nextModel && nextModel.model !== model) {
      setModel(nextModel.model);
      setReasoningEffort(nextModel.defaultReasoningEffort);
      localStorage.setItem(machinePreferenceKey("boosted.codex.model"), nextModel.model);
      localStorage.setItem(machinePreferenceKey("boosted.codex.effort"), nextModel.defaultReasoningEffort);
    } else if (nextModel && !nextModel.supportedReasoningEfforts.some((effort) => effort.id === reasoningEffort)) {
      setReasoningEffort(nextModel.defaultReasoningEffort);
      localStorage.setItem(machinePreferenceKey("boosted.codex.effort"), nextModel.defaultReasoningEffort);
    }
    if (!codexOptions.data.accessModes.some((entry) => entry.id === accessMode)) {
      setAccessMode(codexOptions.data.defaultAccessMode);
      localStorage.setItem(machinePreferenceKey("boosted.codex.access"), codexOptions.data.defaultAccessMode);
    }
  }, [accessMode, codexOptions.data, model, reasoningEffort, thread.chat.model]);

  const dispatchMessage = useCallback(async (pending: CodexOutboxMessage) => {
    if (sendingIdsRef.current.has(pending.id)) return;
    const generation = useWorkspaceStore.getState().generation;
    sendingIdsRef.current.add(pending.id);
    setOutbox((current) => current.map((message) => message.id === pending.id ? { ...message, localDelivery: "sending", sendError: undefined } : message));
    setIsRunning(true);
    setError(undefined);
    try {
      // The outbox already owns the visible message, so stale snapshots can be
      // cancelled without delaying or erasing the local send.
      await queryClient.cancelQueries({ queryKey: ["codex-chat", thread.chat.id], exact: true });
      if (useWorkspaceStore.getState().generation !== generation) return;
      const request = pending.request;
      const started = await api.sendCodexMessage(thread.chat.id, request.text, pending.id, {
        model: request.model,
        reasoningEffort: request.reasoningEffort,
        accessMode: request.accessMode,
        collaborationMode: request.collaborationMode,
        approvalPolicy: request.approvalPolicy,
        attachmentIds: request.attachmentIds,
      });
      if (useWorkspaceStore.getState().generation !== generation) return;
      setOutbox((current) => current.map((message) => message.id === pending.id ? { ...message, localDelivery: "sent", sendError: undefined } : message));
      if (started.threadId !== thread.chat.id) {
        const workspace = useWorkspaceStore.getState();
        workspace.write<CodexOutboxMessage[]>(`codex:${started.threadId}:outbox`, (current) => current.some((message) => message.id === pending.id) ? current : [...current, { ...pending, localDelivery: "sent" }], [], generation);
        setIsRunning(false);
        void queryClient.invalidateQueries({ queryKey: ["codex-chats"] });
        if (onThreadChange) {
          onThreadChange(started.threadId);
        } else if (useAppStore.getState().selectedCodexChatId === thread.chat.id) {
          selectCodexChat(started.threadId);
          window.dispatchEvent(new CustomEvent("boosted:open-codex-chat", {
            detail: {
              threadId: started.threadId,
              title: thread.chat.title,
              replaceThreadId: thread.chat.id,
            },
          }));
        }
      }
    } catch (cause) {
      if (useWorkspaceStore.getState().generation !== generation) return;
      const sendError = cause instanceof Error ? cause.message : "Unable to send message.";
      setOutbox((current) => current.map((message) => message.id === pending.id ? { ...message, localDelivery: "failed", sendError } : message));
      setIsRunning(false);
    } finally { sendingIdsRef.current.delete(pending.id); }
  }, [api, onThreadChange, queryClient, selectCodexChat, setError, setIsRunning, setOutbox, thread.chat.id, thread.chat.title]);

  const retryMessage = useCallback((id: string) => {
    const pending = outbox.find((message) => message.id === id);
    if (pending) void dispatchMessage(pending);
  }, [dispatchMessage, outbox]);

  const sendMessage = useCallback(async (message: AppendMessage) => {
    const text = message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n").trim();
    if ((!text && attachments.length === 0) || !model || !reasoningEffort) return;
    const id = createClientMessageId();
    const outgoingAttachments = attachments.map((attachment) => ({ name: attachment.name, mimeType: attachment.mimeType, uploadId: attachment.id }));
    const pending: CodexOutboxMessage = {
      id,
      role: "user",
      content: text,
      attachments: outgoingAttachments,
      kind: "message",
      createdAt: new Date().toISOString(),
      localDelivery: "sending",
      request: {
        text,
        model,
        reasoningEffort,
        accessMode,
        collaborationMode,
        approvalPolicy: accessMode === thread.runtimeDefaults?.accessMode ? thread.runtimeDefaults?.approvalPolicy : "never",
        attachmentIds: attachments.map((attachment) => attachment.id),
      },
    };
    // Insert synchronously before cancellation or network work. The composer and
    // attachment tray can clear immediately because the outbox now owns the send.
    setOutbox((current) => [...current, pending]);
    setAttachments([]);
    void dispatchMessage(pending);
  }, [accessMode, attachments, collaborationMode, dispatchMessage, model, reasoningEffort, setAttachments, setOutbox, thread.runtimeDefaults?.accessMode, thread.runtimeDefaults?.approvalPolicy]);

  const uploadFiles = useCallback(async (incoming: File[]) => {
    const availableSlots = Math.max(0, 4 - attachments.length);
    const files = incoming
      .filter((file) => ["image/png", "image/jpeg", "image/webp", "image/gif"].includes(file.type))
      .slice(0, availableSlots);
    if (files.length === 0) {
      if (incoming.length > 0 && availableSlots > 0) setError("Images must be PNG, JPEG, WebP, or GIF files.");
      return;
    }
    if (!supportsImages) {
      setError("The selected Codex model does not support image input.");
      return;
    }
    if (isRunning || isUploading) return;
    setIsUploading(true);
    setError(undefined);
    const uploaded: CodexAttachment[] = [];
    try {
      for (const file of files) uploaded.push(await api.uploadCodexAttachment(file));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to upload image.");
    } finally {
      if (uploaded.length > 0) setAttachments((current) => [...current, ...uploaded].slice(0, 4));
      setIsUploading(false);
    }
  }, [attachments.length, isRunning, isUploading, supportsImages]);

  const uploadImages = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    event.target.value = "";
    void uploadFiles(files);
  }, [uploadFiles]);

  const pasteImages = useCallback((event: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(event.clipboardData.items)
      .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
      .map((item) => item.getAsFile())
      .filter((file): file is File => Boolean(file));
    if (files.length === 0) return;
    event.preventDefault();
    void uploadFiles(files);
  }, [uploadFiles]);

  const removeAttachment = useCallback((attachment: CodexAttachment) => {
    setAttachments((current) => current.filter((entry) => entry.id !== attachment.id));
    void api.removeCodexAttachment(attachment.id).catch((cause) => {
      setError(cause instanceof Error ? cause.message : "Unable to remove image.");
    });
  }, []);

  const selectModel = useCallback((value: string) => {
    const next = codexOptions.data?.models.find((entry) => entry.model === value);
    setModel(value);
    localStorage.setItem(machinePreferenceKey("boosted.codex.model"), value);
    if (next) {
      setReasoningEffort(next.defaultReasoningEffort);
      localStorage.setItem(machinePreferenceKey("boosted.codex.effort"), next.defaultReasoningEffort);
      if (!next.inputModalities.includes("image")) {
        const removed = attachments;
        setAttachments([]);
        void Promise.all(removed.map((attachment) => api.removeCodexAttachment(attachment.id))).catch(() => undefined);
      }
    }
  }, [attachments, codexOptions.data]);

  const selectEffort = useCallback((value: string) => {
    setReasoningEffort(value);
    localStorage.setItem(machinePreferenceKey("boosted.codex.effort"), value);
  }, []);

  const selectAccess = useCallback((value: string) => {
    const next = value as CodexAccessOption["id"];
    setAccessMode(next);
    localStorage.setItem(machinePreferenceKey("boosted.codex.access"), next);
  }, []);

  const cancelTurn = useCallback(async () => {
    try {
      await api.stopCodexTurn(thread.chat.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to stop Codex.");
      throw cause;
    }
  }, [thread.chat.id]);

  const assistantMessages = useMemo(() => compactCodexMessages(displayMessages, isRunning).map(toAssistantMessage), [displayMessages, isRunning]);
  const answeredQuestions = useMemo(() => new Set(messages.filter((message) => message.role === "user").flatMap((message) =>
    parseCodexMessage(message.content).flatMap((part) => part.type === "question-reply" ? part.replies.flatMap((reply) => reply.questionItemId ? [reply.questionItemId] : []) : []),
  )), [messages]);
  const replyToQuestions = useCallback(async (messageId: string, questions: NonNullable<CodexChatMessage["questions"]>, answers: Record<string, { answers: string[] }>) => {
    const generation = useWorkspaceStore.getState().generation;
    const started = await api.sendCodexMessage(thread.chat.id, codexQuestionReply(messageId, questions, answers), createClientMessageId(), { model, reasoningEffort, accessMode, collaborationMode, approvalPolicy: accessMode === thread.runtimeDefaults?.accessMode ? thread.runtimeDefaults?.approvalPolicy : "never" });
    if (useWorkspaceStore.getState().generation !== generation) return;
    setIsRunning(true);
    if (started.threadId !== thread.chat.id) {
      setIsRunning(false);
      if (onThreadChange) {
        onThreadChange(started.threadId);
      } else if (useAppStore.getState().selectedCodexChatId === thread.chat.id) {
        selectCodexChat(started.threadId);
        window.dispatchEvent(new CustomEvent("boosted:open-codex-chat", { detail: { threadId: started.threadId, title: thread.chat.title, replaceThreadId: thread.chat.id } }));
      }
    }
    void queryClient.invalidateQueries({ queryKey: ["codex-chat", started.threadId] });
    void queryClient.invalidateQueries({ queryKey: ["codex-chats"] });
  }, [api, accessMode, collaborationMode, model, onThreadChange, queryClient, reasoningEffort, selectCodexChat, setIsRunning, thread.chat.id, thread.chat.title, thread.runtimeDefaults?.accessMode, thread.runtimeDefaults?.approvalPolicy]);
  const runtime = useExternalStoreRuntime({
    messages: assistantMessages,
    convertMessage: passthroughMessage,
    isRunning,
    onNew: sendMessage,
    onCancel: cancelTurn,
  });

  const sendAttachmentMessage = () => {
    if (!isRunning && !isUploading && model && reasoningEffort && attachments.length > 0) {
      runtime.thread.append({ role: "user", content: [] });
    }
  };

  return (
    <WorkspaceFileProvider scope={{ kind: "codex", id: thread.chat.id }}>
      <AssistantRuntimeProvider runtime={runtime}>
        <CodexDraftSync runtime={runtime} sessionKey={sessionKey} />
        <CodexRetryContext.Provider value={retryMessage}>
        <CodexAsyncQuestionProvider value={{ requestScope: `${api.profileId}:${thread.chat.id}`, answered: answeredQuestions, reply: replyToQuestions }}>
        <CodexThreadLayout timeline={<ChatTimeline messages={displayMessages} />} footer={<>
            <ThreadPrimitive.ScrollToBottom asChild behavior="smooth"><Button className="absolute -top-9 right-0 z-20 shrink-0 rounded-full shadow-lg disabled:hidden" variant="secondary" size="icon-sm" aria-label="Scroll to bottom" title="Scroll to bottom"><ArrowDown /></Button></ThreadPrimitive.ScrollToBottom>
            <div className="codex-message-column">
              <div className="codex-composer-requests">
              {runChanges && <RunChangesToast summary={runChanges} />}
              {approvals.data?.map((approval) => approval.method === "item/tool/requestUserInput"
                ? <div key={approval.id} className="mb-2"><CodexQuestionForm requestId={`${api.profileId}:${thread.chat.id}:approval:${approval.id}`} questions={approval.params.questions ?? []} onSubmit={async (answers) => { await api.answerCodexQuestions(thread.chat.id, approval.id, answers); void approvals.refetch(); }} /></div>
                : <div className="mb-2 rounded-md border border-border bg-secondary px-3 py-2 text-xs" key={approval.id}>
                <p className="font-medium">{approval.method.includes("commandExecution") ? "Command approval requested" : "File change approval requested"}</p>
                <pre className="my-2 max-h-40 overflow-auto whitespace-pre-wrap break-words text-[11px]">{String(approval.params.command ?? approval.params.reason ?? "Codex needs permission to continue.")}</pre>
                <div className="flex justify-end gap-2">{(["decline", "accept"] as const).map((decision) => <Button key={decision} size="sm" variant={decision === "accept" ? "default" : "outline"} onClick={async () => { try { await api.answerCodexApproval(thread.chat.id, approval.id, decision); await approvals.refetch(); } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not answer approval."); } }}>{decision === "accept" ? "Approve" : "Decline"}</Button>)}</div>
              </div>)}
              {error && <div className="mb-2 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-[11px] text-destructive">{error}</div>}
              </div>
              <ComposerPrimitive.Root className="codex-message-composer rounded-[24px] border border-border/40 bg-secondary px-3 py-2 focus-within:border-ring" onSubmit={(event) => {
                if (attachments.length > 0 && runtime.thread.composer.getState().isEmpty) { event.preventDefault(); sendAttachmentMessage(); }
              }}>
                {attachments.length > 0 && <div className="mb-1.5 flex flex-wrap gap-1.5">{attachments.map((attachment) => <span key={attachment.id} className="relative inline-block"><WorkspaceAttachment attachment={{ name: attachment.name, mimeType: attachment.mimeType, uploadId: attachment.id }} compact /><button type="button" className="absolute right-1 top-1 rounded-full bg-background p-0.5 text-muted-foreground hover:text-foreground" aria-label={`Remove ${attachment.name}`} onClick={() => removeAttachment(attachment)}><X className="size-3" /></button></span>)}</div>}
                <ComposerPrimitive.Input className="block max-h-40 min-h-14 w-full resize-none bg-transparent px-1 py-1.5 text-sm leading-5 outline-none placeholder:text-muted-foreground" placeholder="Message Codex..." aria-label="Message Codex" onPaste={pasteImages} onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && attachments.length > 0 && runtime.thread.composer.getState().isEmpty) { event.preventDefault(); sendAttachmentMessage(); }
                }} autoFocus />
                <div className="codex-composer-controls mt-1 text-xs text-muted-foreground">
                  <input ref={fileInputRef} className="hidden" type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple onChange={uploadImages} />
                  <Button type="button" variant="ghost" size="icon-sm" className="size-7 rounded-full" title={supportsImages ? "Attach images" : "Selected model does not support images"} disabled={!supportsImages || attachments.length >= 4 || isRunning || isUploading} onClick={() => fileInputRef.current?.click()}>{isUploading ? <LoaderCircle className="animate-spin" /> : <Plus />}</Button>
                  <CodexModeSelect value={collaborationMode} onChange={setCollaborationMode} disabled={isRunning} />
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild><button type="button" className="new-task-option codex-model-option" aria-label="Codex model and reasoning"><Bot className="size-3.5" /><span className="max-w-40 truncate">{selectedModel?.displayName ?? (codexOptions.isLoading ? "Loading Codex…" : "Codex")}</span>{reasoningEffort && <span className="codex-effort-label capitalize text-muted-foreground">· {reasoningEffort}</span>}<ChevronDown /></button></DropdownMenuTrigger>
                    <DropdownMenuContent align="start" side="top" className="w-80 max-w-[calc(100vw-1rem)]">
                      <DropdownMenuLabel>Model</DropdownMenuLabel>
                      <DropdownMenuRadioGroup value={model} onValueChange={selectModel}>{codexOptions.data?.models.map((entry) => <DropdownMenuRadioItem key={entry.id} value={entry.model}><span className="min-w-0"><span className="block font-medium text-foreground">{entry.displayName}</span>{entry.description && <span className="mt-0.5 block text-[10px] leading-4 text-muted-foreground">{entry.description}</span>}</span></DropdownMenuRadioItem>)}</DropdownMenuRadioGroup>
                      {selectedModel && <><DropdownMenuSeparator /><DropdownMenuLabel>Reasoning effort</DropdownMenuLabel><DropdownMenuRadioGroup value={reasoningEffort} onValueChange={selectEffort}>{selectedModel.supportedReasoningEfforts.map((effort) => <DropdownMenuRadioItem key={effort.id} value={effort.id}><span><span className="block capitalize text-foreground">{effort.id}</span>{effort.description && <span className="mt-0.5 block text-[10px] leading-4 text-muted-foreground">{effort.description}</span>}</span></DropdownMenuRadioItem>)}</DropdownMenuRadioGroup></>}
                    </DropdownMenuContent>
                  </DropdownMenu>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild><button type="button" className="new-task-option codex-access-option ml-auto" aria-label="Codex access"><span>{selectedAccess?.label ?? "Full access"}</span><ChevronDown /></button></DropdownMenuTrigger>
                    <DropdownMenuContent align="end" side="top" className="w-72 max-w-[calc(100vw-1rem)]"><DropdownMenuLabel>Codex access</DropdownMenuLabel><DropdownMenuRadioGroup value={accessMode} onValueChange={selectAccess}>{codexOptions.data?.accessModes.map((entry) => <DropdownMenuRadioItem key={entry.id} value={entry.id}><span><span className="block font-medium text-foreground">{entry.label}</span><span className="mt-0.5 block text-[10px] leading-4 text-muted-foreground">{entry.description}</span></span></DropdownMenuRadioItem>)}</DropdownMenuRadioGroup></DropdownMenuContent>
                  </DropdownMenu>
                  <AuiIf condition={(state) => !state.thread.isRunning}><CodexSendButton disabled={!model || !reasoningEffort || isUploading} hasAttachments={attachments.length > 0} onSendAttachments={sendAttachmentMessage} /></AuiIf>
                  <AuiIf condition={(state) => state.thread.isRunning}><Button asChild variant="ghost" className="size-8 rounded-full" size="icon-sm" title="Stop Codex"><ComposerPrimitive.Cancel><Square className="size-3 fill-current" /></ComposerPrimitive.Cancel></Button></AuiIf>
                </div>
              </ComposerPrimitive.Root>
            </div>
          </>}>
          <ThreadPrimitive.Empty><div className="empty-state min-h-48 flex-1"><MessageSquareText className="size-8" /><p>Send a message to continue this Codex chat.</p></div></ThreadPrimitive.Empty>
          <ThreadPrimitive.Messages components={{ UserMessage, AssistantMessage }} />
        </CodexThreadLayout>
        </CodexAsyncQuestionProvider>
        </CodexRetryContext.Provider>
      </AssistantRuntimeProvider>
    </WorkspaceFileProvider>
  );
}

export function CodexChatPanel({ threadId, onThreadChange }: { threadId: string; onThreadChange?: (threadId: string) => void }) {
  const api = useBoostedApiClient();
  const thread = useQuery({ ...conversationQueryOptions, queryKey: ["codex-chat", threadId], queryFn: ({ signal }) => api.codexChat(threadId, signal) });
  return (
    <div className="panel-root">
      {thread.isLoading && <div className="grid min-h-0 flex-1 place-items-center"><LoaderCircle className="size-5 animate-spin text-muted-foreground" /></div>}
      {thread.error && <div className="grid min-h-0 flex-1 place-items-center p-8 text-center text-xs text-destructive">{thread.error.message}</div>}
      {thread.data && <CodexTranscript key={threadId} thread={thread.data} onThreadChange={onThreadChange} />}
    </div>
  );
}
