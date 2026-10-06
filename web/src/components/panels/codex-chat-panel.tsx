import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type ClipboardEvent } from "react";
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
import { ArrowDown, ArrowUp, Bot, ChevronDown, ChevronRight, LoaderCircle, MessageSquareText, Plus, Square, Wrench, X } from "lucide-react";
import { CodexThreadLayout } from "./codex-thread-layout";
import { CodexMessageText } from "@/components/assistant-ui/codex-message-content";
import { CodexQuestionForm } from "@/components/assistant-ui/codex-question-form";
import { CodexModeSelect } from "@/components/assistant-ui/codex-mode-select";
import { CodexAsyncQuestionProvider, CodexAsyncQuestions } from "@/components/assistant-ui/codex-async-questions";
import { codexQuestionReply, parseCodexMessage } from "@/lib/codex-message-format";
import { WorkspaceAttachment, WorkspaceFileProvider } from "@/components/assistant-ui/workspace-file-markdown";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useBoostedApiClient } from "@/lib/api-context";
import { upsertCodexMessage } from "@/lib/codex-chat-state";
import { pinWorkspaceValue, useWorkspaceState, useWorkspaceStore } from "@/lib/workspace-state";
import { conversationQueryOptions } from "@/lib/query-client";
import { chatActivity, setCachedChatStatus } from "@/lib/codex-chat-status";
import { machinePreferenceKey, useAppStore } from "@/lib/store";
import type { CodexAccessOption, CodexAttachment, CodexChatMessage, CodexChatThread, CodexCollaborationMode } from "@/lib/types";
import "./chat-panel.css";
import "./codex-chat-panel.css";

function CodexSendButton({ disabled, hasAttachments, onSendAttachments }: { disabled: boolean; hasAttachments: boolean; onSendAttachments: () => void }) {
  const empty = useAuiState((state) => state.composer.isEmpty);
  return empty && hasAttachments
    ? <Button type="button" className="codex-send-button" size="icon-sm" title="Send message" disabled={disabled} onClick={onSendAttachments}><ArrowUp /></Button>
    : <Button asChild className="codex-send-button" size="icon-sm" disabled={disabled} title="Send message"><ComposerPrimitive.Send><ArrowUp /></ComposerPrimitive.Send></Button>;
}

function UserMessage() {
  return (
    <MessagePrimitive.Root className="chat-message-enter codex-message-column flex justify-end py-3">
      <div className="min-w-0 max-w-[88%]">
        <div className="mb-1 pr-4 text-right text-xs text-muted-foreground">You</div>
        <div className="selectable-text rounded-[22px] bg-secondary px-4 py-2.5 text-left"><CodexMessageText /></div>
      </div>
    </MessagePrimitive.Root>
  );
}

function AssistantMessage() {
  const kind = useAuiState((state) => String(state.message.metadata.custom.kind ?? "message"));
  const label = useAuiState((state) => String(state.message.metadata.custom.label ?? "Tool call"));

  if (kind === "system") {
    return <MessagePrimitive.Root className="codex-message-column py-2 text-xs text-muted-foreground"><CodexMessageText /></MessagePrimitive.Root>;
  }
  if (kind === "tool" || kind === "reasoning") {
    return (
      <MessagePrimitive.Root className="codex-message-column py-0.5">
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
    <MessagePrimitive.Root className="chat-message-enter codex-message-column py-3">
      <div className="mb-2 flex items-center gap-2 text-xs text-muted-foreground">
        <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-secondary"><Bot className="size-3.5" /></span>
        <span>Codex</span>
      </div>
      <div className="min-w-0">
        <CodexMessageText />
        <CodexAsyncQuestions />
      </div>
    </MessagePrimitive.Root>
  );
}

function toolLabel(content: string) {
  const firstLine = content.split("\n").find((line) => line.trim()) ?? "Tool call";
  const label = firstLine.replace(/[*`>#]/g, "").replace(/^\$\s*/, "").trim();
  return label.length > 96 ? `${label.slice(0, 93)}...` : label;
}

const assistantMessageCache = new WeakMap<CodexChatMessage, ThreadMessageLike>();
function toAssistantMessage(message: CodexChatMessage): ThreadMessageLike {
  const cached = assistantMessageCache.get(message);
  if (cached) return cached;
  const converted: ThreadMessageLike = {
    id: message.id,
    role: message.role,
    content: [{ type: "text", text: message.content }],
    createdAt: message.createdAt ? new Date(message.createdAt) : undefined,
    metadata: { custom: { kind: message.kind, attachments: message.attachments, questions: message.questions, label: message.kind === "tool" ? toolLabel(message.content) : undefined } },
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
  const setMessages = useCallback((update: (messages: CodexChatMessage[]) => CodexChatMessage[]) => {
    queryClient.setQueryData<CodexChatThread>(["codex-chat", thread.chat.id], (current) => current ? { ...current, messages: update(current.messages) } : current);
  }, [queryClient, thread.chat.id]);
  const setIsRunning = useCallback((running: boolean) => setCachedChatStatus(queryClient, thread.chat.id, running ? "active" : "idle"), [queryClient, thread.chat.id]);
  const [error, setError] = useWorkspaceState<string | undefined>(`${sessionKey}:error`, undefined);
  const [model, setModel] = useWorkspaceState(`${sessionKey}:model`, () => thread.runtimeDefaults?.model ?? localStorage.getItem(machinePreferenceKey("boosted.codex.model")) ?? thread.chat.model ?? "");
  const [reasoningEffort, setReasoningEffort] = useWorkspaceState(`${sessionKey}:reasoningEffort`, () => thread.runtimeDefaults?.reasoningEffort ?? localStorage.getItem(machinePreferenceKey("boosted.codex.effort")) ?? "");
  const [collaborationMode, setCollaborationMode] = useWorkspaceState<CodexCollaborationMode>(`${sessionKey}:collaborationMode`, () => thread.runtimeDefaults?.collaborationMode === "plan" ? "plan" : "default");
  const [accessMode, setAccessMode] = useWorkspaceState<CodexAccessOption["id"]>(`${sessionKey}:accessMode`, () => {
    const stored = thread.runtimeDefaults?.accessMode ?? localStorage.getItem(machinePreferenceKey("boosted.codex.access"));
    return stored === "workspaceWrite" || stored === "readOnly" ? stored : "fullAccess";
  });
  const [attachments, setAttachments] = useWorkspaceState<CodexAttachment[]>(`${sessionKey}:attachments`, []);
  const [isUploading, setIsUploading] = useState(false);
  const sendingRef = useRef(false);
  const codexOptions = useQuery({ queryKey: ["codex-options", thread.chat.id], queryFn: () => api.threadCodexOptions(thread.chat.id), staleTime: 60_000 });
  const approvals = useQuery({ queryKey: ["codex-approvals", thread.chat.id], queryFn: () => api.codexApprovals(thread.chat.id), refetchInterval: isRunning ? 2000 : false });
  const selectedModel = codexOptions.data?.models.find((entry) => entry.model === model || entry.id === model);
  const selectedAccess = codexOptions.data?.accessModes.find((entry) => entry.id === accessMode);
  const supportsImages = selectedModel?.inputModalities.includes("image") ?? false;

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

  const sendMessage = useCallback(async (message: AppendMessage) => {
    const generation = useWorkspaceStore.getState().generation;
    const text = message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n").trim();
    if ((!text && attachments.length === 0) || !model || !reasoningEffort) return;
    const clientMessageId = createClientMessageId();
    if (sendingRef.current) return;
    sendingRef.current = true;
    const optimisticAttachments = attachments.map((attachment) => ({ name: attachment.name, mimeType: attachment.mimeType, uploadId: attachment.id }));
    try {
      await queryClient.cancelQueries({ queryKey: ["codex-chat", thread.chat.id], exact: true });
      if (useWorkspaceStore.getState().generation !== generation) return;
      setMessages((current) => upsertCodexMessage(current, { id: clientMessageId, role: "user", content: text, attachments: optimisticAttachments, kind: "message", createdAt: new Date().toISOString() }));
      setIsRunning(true);
      setError(undefined);
      const started = await api.sendCodexMessage(thread.chat.id, text, clientMessageId, { model, reasoningEffort, accessMode, collaborationMode, approvalPolicy: accessMode === thread.runtimeDefaults?.accessMode ? thread.runtimeDefaults?.approvalPolicy : "never", attachmentIds: attachments.map((attachment) => attachment.id) });
      if (useWorkspaceStore.getState().generation !== generation) return;
      setAttachments([]);
      if (started.threadId !== thread.chat.id) {
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
      setMessages((current) => current.filter((item) => item.id !== clientMessageId));
      setIsRunning(false);
      setError(cause instanceof Error ? cause.message : "Unable to send message.");
      throw cause;
    } finally { sendingRef.current = false; }
  }, [api, accessMode, attachments, collaborationMode, model, onThreadChange, queryClient, reasoningEffort, selectCodexChat, setAttachments, setError, setIsRunning, setMessages, thread.chat.id, thread.chat.title, thread.runtimeDefaults?.accessMode, thread.runtimeDefaults?.approvalPolicy]);

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

  const assistantMessages = useMemo(() => messages.map(toAssistantMessage), [messages]);
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
        <CodexAsyncQuestionProvider value={{ requestScope: `${api.profileId}:${thread.chat.id}`, answered: answeredQuestions, reply: replyToQuestions }}>
        <CodexThreadLayout footer={<>
            <ThreadPrimitive.ScrollToBottom asChild behavior="smooth"><Button className="absolute -top-9 right-0 z-20 shrink-0 rounded-full shadow-lg disabled:hidden" variant="secondary" size="icon-sm" aria-label="Scroll to bottom" title="Scroll to bottom"><ArrowDown /></Button></ThreadPrimitive.ScrollToBottom>
            <div className="codex-message-column">
              <div className="codex-composer-requests">{approvals.data?.map((approval) => approval.method === "item/tool/requestUserInput"
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
