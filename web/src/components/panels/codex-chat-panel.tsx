import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type ClipboardEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AssistantRuntimeProvider,
  AuiIf,
  ComposerPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  type AppendMessage,
  type ThreadMessageLike,
  useAuiState,
  useExternalStoreRuntime,
} from "@assistant-ui/react";
import { ArrowDown, Bot, ChevronDown, ChevronRight, Image, LoaderCircle, MessageSquareText, Plus, Send, Square, UserRound, Wrench, X } from "lucide-react";
import { MarkdownText } from "@/components/assistant-ui/markdown-text";
import { WorkspaceFileProvider } from "@/components/assistant-ui/workspace-file-markdown";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { api } from "@/lib/api";
import { appendCodexDelta, upsertCodexMessage } from "@/lib/codex-chat-state";
import { machinePreferenceKey, useAppStore } from "@/lib/store";
import type { CodexAccessOption, CodexAttachment, CodexChatMessage, CodexChatThread, CodexLiveEvent } from "@/lib/types";

function UserMessage() {
  return (
    <MessagePrimitive.Root className="mx-auto flex w-full max-w-3xl justify-end gap-3 py-3">
      <div className="min-w-0 max-w-[84%]">
        <div className="mb-1 text-right text-[10px] text-muted-foreground">You</div>
        <div className="selectable-text rounded-lg bg-primary/10 px-3 py-2 text-left text-[13px] leading-5"><MessagePrimitive.Parts /></div>
      </div>
      <div className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md border border-primary/20 bg-primary/10 text-primary"><UserRound className="size-3.5" /></div>
    </MessagePrimitive.Root>
  );
}

function AssistantMessage() {
  const kind = useAuiState((state) => String(state.message.metadata.custom.kind ?? "message"));
  const label = useAuiState((state) => String(state.message.metadata.custom.label ?? "Tool call"));

  if (kind === "tool") {
    return (
      <MessagePrimitive.Root className="mx-auto w-full max-w-3xl py-0.5 pl-9">
        <details className="group rounded-md border border-border/70 bg-secondary/20 text-xs">
          <summary className="flex cursor-pointer list-none items-center gap-2 px-2.5 py-1.5 text-muted-foreground marker:hidden hover:text-foreground [&::-webkit-details-marker]:hidden">
            <ChevronRight className="size-3 shrink-0 transition-transform group-open:rotate-90" />
            <Wrench className="size-3 shrink-0" />
            <span className="truncate font-mono text-[10px]">{label}</span>
          </summary>
          <div className="max-h-72 overflow-auto border-t border-border/50 px-3 py-2 text-xs"><MessagePrimitive.Parts components={{ Text: MarkdownText }} /></div>
        </details>
      </MessagePrimitive.Root>
    );
  }

  return (
    <MessagePrimitive.Root className="mx-auto flex w-full max-w-3xl gap-3 py-3">
      <div className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md border border-border bg-secondary text-muted-foreground"><Bot className="size-3.5" /></div>
      <div className="min-w-0 max-w-[calc(100%-2.25rem)] flex-1">
        <div className="mb-1 text-[10px] text-muted-foreground">Codex</div>
        <MessagePrimitive.Parts components={{ Text: MarkdownText }} />
      </div>
    </MessagePrimitive.Root>
  );
}

function toolLabel(content: string) {
  const firstLine = content.split("\n").find((line) => line.trim()) ?? "Tool call";
  const label = firstLine.replace(/[*`>#]/g, "").replace(/^\$\s*/, "").trim();
  return label.length > 96 ? `${label.slice(0, 93)}...` : label;
}

function toAssistantMessage(message: CodexChatMessage): ThreadMessageLike {
  return {
    id: message.id,
    role: message.role,
    content: [{ type: "text", text: message.content }],
    createdAt: message.createdAt ? new Date(message.createdAt) : undefined,
    metadata: { custom: { kind: message.kind, label: message.kind === "tool" ? toolLabel(message.content) : undefined } },
  };
}

function passthroughMessage(message: ThreadMessageLike): ThreadMessageLike {
  return message;
}

function errorText(error: unknown) {
  if (!error) return "Codex stopped unexpectedly.";
  if (typeof error === "string") return error;
  if (typeof error === "object" && "message" in error && typeof error.message === "string") return error.message;
  return "Codex stopped unexpectedly.";
}

function createClientMessageId() {
  return globalThis.crypto?.randomUUID?.() ?? `web-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function CodexTranscript({ thread }: { thread: CodexChatThread }) {
  const queryClient = useQueryClient();
  const selectCodexChat = useAppStore((state) => state.selectCodexChat);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [messages, setMessages] = useState<CodexChatMessage[]>(thread.messages);
  const [isRunning, setIsRunning] = useState(thread.chat.status === "active");
  const [error, setError] = useState<string>();
  const [model, setModel] = useState(() => localStorage.getItem(machinePreferenceKey("boosted.codex.model")) ?? thread.chat.model ?? "");
  const [reasoningEffort, setReasoningEffort] = useState(() => localStorage.getItem(machinePreferenceKey("boosted.codex.effort")) ?? "");
  const [accessMode, setAccessMode] = useState<CodexAccessOption["id"]>(() => {
    const stored = localStorage.getItem(machinePreferenceKey("boosted.codex.access"));
    return stored === "workspaceWrite" || stored === "readOnly" ? stored : "fullAccess";
  });
  const [attachments, setAttachments] = useState<CodexAttachment[]>([]);
  const [isUploading, setIsUploading] = useState(false);
  const codexOptions = useQuery({ queryKey: ["codex-options"], queryFn: api.codexOptions, staleTime: 60_000 });
  const selectedModel = codexOptions.data?.models.find((entry) => entry.model === model || entry.id === model);
  const selectedAccess = codexOptions.data?.accessModes.find((entry) => entry.id === accessMode);
  const supportsImages = selectedModel?.inputModalities.includes("image") ?? false;

  useEffect(() => setMessages(thread.messages), [thread.messages]);

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

  useEffect(() => {
    const handleCodexEvent = (rawEvent: Event) => {
      const event = (rawEvent as CustomEvent<CodexLiveEvent>).detail;
      if (!event || event.threadId !== thread.chat.id) return;
      if (event.method === "turn/started") {
        setIsRunning(true);
        setError(undefined);
        return;
      }
      if ((event.method === "item/started" || event.method === "item/completed") && event.message) {
        setMessages((current) => upsertCodexMessage(current, event.message!, event.clientMessageId));
        return;
      }
      if (event.method === "item/agentMessage/delta") setMessages((current) => appendCodexDelta(current, event, "message"));
      if (event.method === "item/reasoning/summaryTextDelta") setMessages((current) => appendCodexDelta(current, event, "reasoning"));
      if (event.method === "item/plan/delta") setMessages((current) => appendCodexDelta(current, event, "plan"));
      if (event.method === "error") setError(errorText(event.error));
      if (event.method === "turn/completed") {
        setIsRunning(false);
        if (event.status === "failed") setError(errorText(event.error));
        void queryClient.invalidateQueries({ queryKey: ["codex-chat", thread.chat.id] });
        void queryClient.invalidateQueries({ queryKey: ["codex-chats"] });
      }
    };
    window.addEventListener("boosted:codex-event", handleCodexEvent);
    return () => window.removeEventListener("boosted:codex-event", handleCodexEvent);
  }, [queryClient, thread.chat.id]);

  const sendMessage = useCallback(async (message: AppendMessage) => {
    const text = message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n").trim();
    if ((!text && attachments.length === 0) || !model || !reasoningEffort) return;
    const clientMessageId = createClientMessageId();
    const optimisticContent = [text, ...attachments.map(() => "[Image attachment]")].filter(Boolean).join("\n\n");
    setMessages((current) => [...current, { id: clientMessageId, role: "user", content: optimisticContent, kind: "message", createdAt: new Date().toISOString() }]);
    setIsRunning(true);
    setError(undefined);
    try {
      const started = await api.sendCodexMessage(thread.chat.id, text, clientMessageId, { model, reasoningEffort, accessMode, attachmentIds: attachments.map((attachment) => attachment.id) });
      setAttachments([]);
      if (started.threadId !== thread.chat.id) {
        selectCodexChat(started.threadId);
        void queryClient.invalidateQueries({ queryKey: ["codex-chats"] });
        window.dispatchEvent(new CustomEvent("boosted:open-codex-chat", {
          detail: {
            threadId: started.threadId,
            title: thread.chat.title,
            replaceThreadId: thread.chat.id,
          },
        }));
      }
    } catch (cause) {
      setMessages((current) => current.filter((item) => item.id !== clientMessageId));
      setIsRunning(false);
      setError(cause instanceof Error ? cause.message : "Unable to send message.");
      throw cause;
    }
  }, [accessMode, attachments, model, queryClient, reasoningEffort, selectCodexChat, thread.chat.id, thread.chat.title]);

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
  const runtime = useExternalStoreRuntime({
    messages: assistantMessages,
    convertMessage: passthroughMessage,
    isRunning,
    onNew: sendMessage,
    onCancel: cancelTurn,
  });

  return (
    <WorkspaceFileProvider scope={{ kind: "codex", id: thread.chat.id }}>
      <AssistantRuntimeProvider runtime={runtime}>
        <ThreadPrimitive.Root className="min-h-0 flex-1">
          <ThreadPrimitive.Viewport className="codex-thread-viewport relative flex h-full flex-col overflow-y-auto px-4">
          <ThreadPrimitive.Empty><div className="empty-state min-h-48 flex-1"><MessageSquareText className="size-8" /><p>Send a message to continue this Codex chat.</p></div></ThreadPrimitive.Empty>
          <ThreadPrimitive.Messages components={{ UserMessage, AssistantMessage }} />
          <ThreadPrimitive.ViewportFooter className="codex-composer-footer sticky bottom-0 z-10 mt-auto bg-[var(--surface)] pb-3 pt-2">
            <ThreadPrimitive.ScrollToBottom asChild behavior="smooth"><Button className="absolute -top-9 right-0 z-20 shrink-0 rounded-full shadow-lg" variant="secondary" size="icon-sm" title="Scroll to bottom"><ArrowDown /></Button></ThreadPrimitive.ScrollToBottom>
            <div className="mx-auto w-full max-w-3xl">
              {error && <div className="mb-2 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-[11px] text-destructive">{error}</div>}
              <ComposerPrimitive.Root className="rounded-lg border border-border p-2 focus-within:border-ring/60">
                {attachments.length > 0 && <div className="mb-1.5 flex flex-wrap gap-1.5">{attachments.map((attachment) => <span key={attachment.id} className="inline-flex max-w-48 items-center gap-1.5 rounded-md border border-border bg-background/55 px-2 py-1 text-[10px] text-muted-foreground"><Image className="size-3 shrink-0" /><span className="truncate">{attachment.name}</span><button type="button" className="rounded-sm hover:text-foreground" aria-label={`Remove ${attachment.name}`} onClick={() => removeAttachment(attachment)}><X className="size-3" /></button></span>)}</div>}
                <ComposerPrimitive.Input className="max-h-40 min-h-14 w-full resize-none bg-transparent px-1 py-1 text-[13px] leading-5 outline-none placeholder:text-muted-foreground" placeholder="Message Codex..." onPaste={pasteImages} autoFocus />
                <div className="codex-composer-controls mt-1 flex h-7 items-center gap-1 text-[10px] text-muted-foreground">
                  <input ref={fileInputRef} className="hidden" type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple onChange={uploadImages} />
                  <Button type="button" variant="ghost" size="icon-sm" className="size-6" title={supportsImages ? "Attach images" : "Selected model does not support images"} disabled={!supportsImages || attachments.length >= 4 || isRunning || isUploading} onClick={() => fileInputRef.current?.click()}>{isUploading ? <LoaderCircle className="animate-spin" /> : <Plus />}</Button>
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
                  <span className="mx-1 h-4 w-px bg-border" />
                  <AuiIf condition={(state) => !state.thread.isRunning}><Button asChild size="icon-sm" disabled={!model || !reasoningEffort || isUploading} title="Send message"><ComposerPrimitive.Send><Send /></ComposerPrimitive.Send></Button></AuiIf>
                  <AuiIf condition={(state) => state.thread.isRunning}><Button asChild variant="secondary" size="icon-sm" title="Stop Codex"><ComposerPrimitive.Cancel><Square /></ComposerPrimitive.Cancel></Button></AuiIf>
                </div>
              </ComposerPrimitive.Root>
            </div>
          </ThreadPrimitive.ViewportFooter>
          </ThreadPrimitive.Viewport>
        </ThreadPrimitive.Root>
      </AssistantRuntimeProvider>
    </WorkspaceFileProvider>
  );
}

export function CodexChatPanel({ threadId }: { threadId: string }) {
  const thread = useQuery({ queryKey: ["codex-chat", threadId], queryFn: () => api.codexChat(threadId) });
  return (
    <div className="panel-root">
      {thread.isLoading && <div className="grid min-h-0 flex-1 place-items-center"><LoaderCircle className="size-5 animate-spin text-muted-foreground" /></div>}
      {thread.error && <div className="grid min-h-0 flex-1 place-items-center p-8 text-center text-xs text-destructive">{thread.error.message}</div>}
      {thread.data && <CodexTranscript key={threadId} thread={thread.data} />}
    </div>
  );
}
