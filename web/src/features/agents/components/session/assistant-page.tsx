import { useCallback, useEffect, useId, useRef, useState } from "react"
import { machinePreferenceKey } from "@/lib/store"
import { ArrowUp, Check, ChevronRight, LoaderCircle, MessageSquarePlus, Plus, RefreshCw, ShieldCheck, Square, TriangleAlert, Wrench } from "lucide-react"
import type { AssistantAction, AssistantAttachment, AssistantState } from "@/features/agents/types/assistant"
import { apiClient, type ProviderAccountResponse } from "@/features/agents/lib/api-client"
import { MarkdownContent } from "@/features/agents/components/session/chat-markdown"
import type { SessionShellState } from "@/features/agents/components/session/session-shell"
import { cn } from "@/lib/utils"
import { shouldAcceptAssistantState } from "@/features/agents/lib/assistant-state"
import { readRecord } from "@/features/agents/lib/session"
import { assistantConversationLayout } from "@/features/agents/lib/assistant-conversation"
import { assistantMessagesWithOutbox, type AssistantPendingMessage } from "@/features/agents/lib/assistant-outbox"
import { AssistantProfilePanel } from "@/features/agents/components/session/assistant-profile-panel"
import { AssistantAttachmentList } from "@/features/agents/components/session/assistant-attachment-list"
import { assistantAttachmentsFromFiles, checkAssistantAttachmentLimits, pastedImages } from "@/features/agents/lib/assistant-attachments"

const labels: Record<string, string> = {
  computer_status: "Inspect computer", computer_screenshot: "Capture screen", computer_action: "Control computer",
  commandExecution: "Run command", fileChange: "Edit files", mcpToolCall: "Call MCP tool", webSearch: "Search the web", imageView: "View image",
  watch_chat: "Watch coding run", schedule_follow_up: "Schedule follow-up", list_follow_ups: "Read follow-ups", cancel_follow_up: "Cancel follow-up",
  get_profile: "Read assistant profile", update_profile: "Update name and personality",
  generate_avatar: "Generate avatar",
  list_workspaces: "Read projects", list_chats: "Read chats", read_chat: "Read conversation", read_run: "Read coding run",
  list_accounts: "Check provider capacity", list_models: "Read Codex models", set_chat_model: "Switch chat model", create_chat: "Create chat", send_message: "Send instructions",
  stop_chat: "Stop chat", stop_run: "Stop coding run", set_chat_access: "Change chat access", clear_chat: "Clear conversation", delete_chat: "Delete conversation", move_chat: "Move chat to another account", set_failover: "Update quota recovery",
  fork_chat: "Fork conversation", rename_chat: "Rename chat",
}
const suggestions = [
  { icon: MessageSquarePlus, label: "Start a task", prompt: "Show me my projects and help me start a new coding task. I can give you work for several projects at once." },
  { icon: RefreshCw, label: "Keep work moving", prompt: "Check my connected accounts and chats. Which chats need attention, and which accounts still have quota?" },
  { icon: ShieldCheck, label: "Recover a chat", prompt: "Help me move a chat whose account has run out of quota to another connected account, preserving its conversation." },
]

export function AssistantPage({ shell, agentId }: { shell: SessionShellState; agentId: string }) {
  const [state, setState] = useState<AssistantState | null>(null)
  const [accounts, setAccounts] = useState<ProviderAccountResponse[]>([])
  const [accountId, setAccountId] = useState("")
  const [draft, setDraft] = useState(() => window.sessionStorage.getItem(machinePreferenceKey(`boosted-agent-draft-${agentId}`)) ?? "")
  const [error, setError] = useState<string | null>(null)
  const [outbox, setOutbox] = useState<AssistantPendingMessage[]>([])
  const sendQueue = useRef(Promise.resolve())
  const [stopping, setStopping] = useState(false)
  const [refreshKey, setRefreshKey] = useState(0)
  const [profileOpen, setProfileOpen] = useState(false)
  const [attachments, setAttachments] = useState<AssistantAttachment[]>([])
  const [readingAttachments, setReadingAttachments] = useState(false)
  const attachmentsRef = useRef<AssistantAttachment[]>([])
  const attachmentQueue = useRef(Promise.resolve())
  const fileInputRef = useRef<HTMLInputElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const followRef = useRef(true)
  const requestId = useRef(0)
  const latestState = useRef<AssistantState | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const running = state?.status === "running"
  const sending = outbox.some((message) => message.localDelivery === "sending")
  const messages = assistantMessagesWithOutbox(state?.messages ?? [], outbox)
  const queuedCount = state?.messages.filter((message) => message.delivery === "queued").length ?? 0
  const assistantName = state?.profile.name ?? shell.agents.find((agent) => agent.id === agentId)?.profile.name ?? "Agent"

  const acceptState = useCallback((next: AssistantState) => {
    // A poll or send response may arrive after a newer streamed update.
    if (!shouldAcceptAssistantState(latestState.current, next, agentId)) return
    latestState.current = next
    setState(next)
    shell.updateAgent(next)
    setError(null)
  }, [agentId, shell.updateAgent])

  useEffect(() => {
    let disposed = false
    let pollId = 0
    let timer: ReturnType<typeof setTimeout>

    const poll = async () => {
      const currentPollId = ++pollId
      const id = ++requestId.current
      let next: AssistantState | null = null
      try {
        next = await apiClient.assistant.read(agentId)
        if (!disposed && id === requestId.current) acceptState(next)
      } catch (cause) {
        if (!disposed && id === requestId.current) setError(cause instanceof Error ? cause.message : "Unable to load assistant.")
      }
      if (!disposed && currentPollId === pollId) timer = setTimeout(() => void poll(), next?.status === "running" ? 1000 : 5000)
    }
    const handleUpdate = (event: Event) => {
      const payload = (event as CustomEvent<AssistantState>).detail
      if (!disposed && payload.id === agentId) acceptState(payload)
    }
    window.addEventListener("boosted:assistant-updated", handleUpdate)
    void poll()
    return () => {
      disposed = true
      clearTimeout(timer)
      window.removeEventListener("boosted:assistant-updated", handleUpdate)
    }
  }, [agentId, refreshKey, acceptState])

  useEffect(() => { window.sessionStorage.setItem(machinePreferenceKey(`boosted-agent-draft-${agentId}`), draft) }, [agentId, draft])

  useEffect(() => {
    const textarea = textareaRef.current
    if (!textarea) return
    textarea.style.height = "auto"
    textarea.style.height = `${Math.max(28, Math.min(textarea.scrollHeight, 160))}px`
  }, [draft])

  useEffect(() => {
    let disposed = false
    void apiClient.providerAccounts.list().then((items) => {
      if (!disposed) setAccounts(items.filter((account) => account.status === "CONNECTED"))
    }).catch((cause) => { if (!disposed) setError(cause instanceof Error ? cause.message : "Unable to load providers.") })
    return () => { disposed = true }
  }, [shell.chatAccounts, refreshKey])

  useEffect(() => {
    const scroller = scrollRef.current
    if (followRef.current && scroller) scroller.scrollTop = scroller.scrollHeight
  }, [state, outbox])

  useEffect(() => {
    const scroller = scrollRef.current
    if (!scroller || typeof ResizeObserver === "undefined") return
    // Keep the latest reply visible when the keyboard resizes the transcript, without
    // scrolling its ancestors or interrupting someone reading older messages.
    const observer = new ResizeObserver(() => {
      if (followRef.current) scroller.scrollTop = scroller.scrollHeight
    })
    observer.observe(scroller)
    return () => observer.disconnect()
  }, [])

  const dispatchMessage = (message: AssistantPendingMessage) => {
    const operation = sendQueue.current.then(async () => {
      try {
        const next = await apiClient.assistant.send(agentId, message.request)
        acceptState(next)
        setOutbox((current) => current.filter((pending) => pending.id !== message.id))
      } catch (cause) {
        const sendError = cause instanceof Error ? cause.message : "Unable to send message."
        setOutbox((current) => current.map((pending) => pending.id === message.id ? { ...pending, localDelivery: "failed", sendError } : pending))
      }
    })
    sendQueue.current = operation
    return operation
  }

  const retryMessage = (message: AssistantPendingMessage) => {
    setOutbox((current) => current.map((pending) => pending.id === message.id ? { ...pending, localDelivery: "sending", sendError: undefined } : pending))
    void dispatchMessage(message)
    textareaRef.current?.focus({ preventScroll: true })
  }

  const send = async (message = draft) => {
    const sendingAttachments = message === draft ? attachmentsRef.current : []
    const content = message.trim() || (sendingAttachments.length ? "Please look at the attached files." : "")
    if (!content || stopping || readingAttachments || !state || !accounts.length) return
    setError(null)
    ++requestId.current
    followRef.current = true
    const id = crypto.randomUUID()
    const pending: AssistantPendingMessage = {
      id, role: "user", content, createdAt: new Date().toISOString(), delivery: "queued", localDelivery: "sending",
      ...(sendingAttachments.length ? { attachments: sendingAttachments } : {}),
      request: { clientMessageId: id, content, accountId: accountId || undefined, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, ...(sendingAttachments.length ? { attachments: sendingAttachments } : {}) },
    }
    setOutbox((current) => [...current, pending])
    if (message === draft) {
      setDraft("")
      attachmentsRef.current = []
      setAttachments([])
    }
    textareaRef.current?.focus({ preventScroll: true })
    await dispatchMessage(pending)
  }

  const addFiles = (files: File[]) => {
    if (!files.length) return
    setReadingAttachments(true)
    setError(null)
    attachmentQueue.current = attachmentQueue.current.then(async () => {
      checkAssistantAttachmentLimits([...attachmentsRef.current, ...files])
      const additions = await assistantAttachmentsFromFiles(files)
      const next = [...attachmentsRef.current, ...additions]
      attachmentsRef.current = next
      setAttachments(next)
    }).catch((cause) => setError(cause instanceof Error ? cause.message : "Unable to attach files."))
    const queued = attachmentQueue.current
    void queued.finally(() => { if (attachmentQueue.current === queued) setReadingAttachments(false) })
  }

  const removeAttachment = (id: string) => {
    attachmentsRef.current = attachmentsRef.current.filter((file) => file.id !== id)
    setAttachments(attachmentsRef.current)
  }

  const stop = async () => {
    setStopping(true)
    try { await sendQueue.current; const next = await apiClient.assistant.stop(agentId); acceptState(next); setRefreshKey((key) => key + 1) }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Unable to stop assistant.") }
    finally { setStopping(false) }
  }

  return (
    <section aria-label={`${assistantName} assistant`} className="assistant-conversation relative flex min-h-0 min-w-0 flex-col overflow-hidden">
      <div aria-hidden="true" className="assistant-identity-backdrop pointer-events-none absolute inset-x-0 top-0 z-10 h-28" />
      <AssistantProfilePanel
        open={profileOpen} onOpenChange={setProfileOpen} agentId={agentId} name={assistantName} state={state}
        accounts={accounts} accountId={accountId} onAccountChange={setAccountId} disabled={running || sending}
        onRefresh={() => setRefreshKey((key) => key + 1)} shell={shell}
        onAvatarChange={async (avatar) => acceptState(await apiClient.assistant.updateAvatar(agentId, avatar))}
        onCancelFollowUp={async (id) => acceptState(await apiClient.assistant.cancelFollowUp(agentId, id))}
        onGenerateAvatar={() => void send("Design an original avatar that fits your name and personality. Use generate_avatar to save it as your profile picture.")}
        onEditProfile={() => {
          setDraft((current) => current || "I'd like to update your name and personality.")
          textareaRef.current?.focus({ preventScroll: true })
        }}
      />

      <div className="assistant-conversation-scroll min-h-0 flex-1 overflow-y-auto px-5 pb-4 pt-28 md:px-8" ref={scrollRef} onScroll={() => {
        const element = scrollRef.current
        if (element) followRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 100
      }}>
        <div className="session-conversation-column mx-auto">
          {!state && !error ? <div className="flex justify-center gap-2 text-sm text-muted-foreground"><LoaderCircle className="size-4 animate-spin" />Loading conversation…</div> : null}
          {state && !messages.length ? (
            <div className="py-8 md:py-16">
              <h2 className="text-2xl font-medium tracking-tight">What should we work on?</h2>
              <p className="mt-3 max-w-lg text-sm leading-6 text-muted-foreground">Direct work across all your projects in one conversation. Start Codex chats, check progress, and keep several projects moving at once.</p>
              <div className="mt-8 grid gap-3 sm:grid-cols-3">
                {suggestions.map(({ icon: Icon, label, prompt }) => <button className="rounded-2xl border border-border p-4 text-left transition-colors hover:bg-accent" key={label} type="button" onClick={() => { setDraft(prompt); textareaRef.current?.focus({ preventScroll: true }) }}><Icon className="mb-4 size-4 text-muted-foreground" /><span className="text-[13px] font-medium">{label}</span><p className="mt-2 text-xs leading-5 text-muted-foreground">{label === "Start a task" ? "Create a chat and give it a job." : label === "Keep work moving" ? "See progress and available capacity." : "Continue with another account."}</p></button>)}
              </div>
            </div>
          ) : null}
          <div>
            {assistantConversationLayout(messages).map((item) => {
              const { message, showTimestamp, startGroup, showSentTime, showDeliveryStatus } = item
              return (
              <div className={cn("min-w-0", startGroup ? "mt-4 first:mt-0" : "mt-1")} key={message.id}>
                {showTimestamp ? <time className="mb-3 mt-6 block text-center text-[12px] text-muted-foreground" dateTime={message.createdAt}>{conversationDate(message.createdAt)}</time> : null}
                {item.type === "tools" ? <ActionGroup actions={item.actions} shell={shell} /> : <article aria-label={message.role === "user" ? "Your message" : `${message.assistantName ?? assistantName} reply`} className="group/message min-w-0 rounded-xl focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring" tabIndex={showSentTime ? 0 : undefined}>
                  {message.attachments?.length ? <div className={cn("mb-2 flex max-w-[88%]", message.role === "user" && "ml-auto justify-end")}><AssistantAttachmentList attachments={message.attachments} /></div> : null}
                  {message.content ? <div className={cn("assistant-message-bubble w-fit min-w-0 max-w-[88%] rounded-[22px] px-4 py-2.5", message.role === "user" ? "assistant-message-user ml-auto text-white" : "assistant-message-reply text-foreground")}>
                    <MarkdownContent content={message.content} />
                  </div> : null}
                  {message.actions?.length ? <div className={cn(message.content && "mt-2")}><ActionGroup actions={message.actions} shell={shell} /></div> : null}
                  {message.delivery === "cancelled" ? <p className="mt-1 pr-4 text-right text-[11px] text-muted-foreground">Cancelled</p> : null}
                  {message.localDelivery ? <div className="mt-1 flex items-center justify-end gap-1 pr-4 text-[11px] text-muted-foreground" role="status">
                    {message.localDelivery === "sending" ? <><LoaderCircle aria-hidden="true" className="size-3 animate-spin" />Sending…</> : <><TriangleAlert aria-hidden="true" className="size-3 text-destructive" /><span title={message.sendError}>Not sent</span><button className="underline underline-offset-2" type="button" onClick={() => { const pending = outbox.find((item) => item.id === message.id); if (pending) retryMessage(pending) }}>Retry</button></>}
                  </div> : null}
                  {showSentTime && !message.localDelivery && message.delivery !== "cancelled" ? <div className={cn("mt-1 flex justify-end pr-4 text-[11px] text-muted-foreground", !showDeliveryStatus && "opacity-0 group-hover/message:opacity-100 group-focus-within/message:opacity-100")}>
                    <span aria-live={showDeliveryStatus ? "polite" : undefined}>{message.delivery === "processing" || message.delivery === "handled" ? "Read" : "Sent"}</span>
                    <time className="hidden group-hover/message:ml-1 group-hover/message:block group-focus-within/message:ml-1 group-focus-within/message:block" dateTime={message.readAt ?? message.createdAt}>{conversationTime(message.readAt ?? message.createdAt)}</time>
                  </div> : null}
                </article>}
              </div>
            )})}
          </div>
          {running && state?.typing ? <div aria-label={`${assistantName} is typing`} className="mt-3 flex items-center gap-2 px-4 text-xs text-muted-foreground" role="status"><span>{assistantName} is typing</span><span aria-hidden="true" className="animate-pulse tracking-widest motion-reduce:animate-none">•••</span></div> : null}
        </div>
      </div>

      <div className="session-composer shrink-0">
        <div className="session-conversation-column mx-auto">
          {error || state?.error ? <p className="mb-3 rounded-xl border border-destructive/20 bg-destructive/5 px-3 py-2 text-xs leading-5 text-destructive" role="alert">{error ?? state?.error}</p> : null}
          {state && !accounts.length ? <div className="mb-3 flex items-center justify-between gap-3 text-xs text-muted-foreground"><span>Connect a Codex account to get started.</span><button className="text-foreground underline underline-offset-4" type="button" onClick={() => shell.selectManagementView("providers")}>Open Providers</button></div> : null}
          {attachments.length ? <div className="mb-2"><AssistantAttachmentList attachments={attachments} onRemove={removeAttachment} /></div> : null}
          {readingAttachments ? <p role="status" className="mb-2 flex items-center gap-2 text-xs text-muted-foreground"><LoaderCircle className="size-3 animate-spin" />Attaching files…</p> : null}
          <form className="assistant-message-composer flex min-h-11 items-end gap-2 rounded-[24px] border border-border/40 bg-secondary px-3 py-[7px]" onSubmit={(event) => { event.preventDefault(); void send() }}>
            <button aria-label="Attach files or images" className="session-icon-button disabled:opacity-40" disabled={readingAttachments} type="button" onClick={() => fileInputRef.current?.click()}><Plus className="size-4" /></button>
            <input aria-label="Select attachments" className="hidden" multiple ref={fileInputRef} type="file" onChange={(event) => { const files = Array.from(event.currentTarget.files ?? []); event.currentTarget.value = ""; addFiles(files) }} />
            <textarea aria-label={`Message ${assistantName}`} className="block max-h-40 min-h-7 min-w-0 flex-1 resize-none bg-transparent py-1 text-[14px] leading-5 outline-none placeholder:text-muted-foreground" maxLength={32_000} placeholder="Send a message" ref={textareaRef} rows={1} value={draft} onChange={(event) => setDraft(event.target.value)} onPaste={(event) => {
              const images = pastedImages(event.clipboardData)
              if (images.length) { event.preventDefault(); addFiles(images) }
            }} onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send() }
            }} />
            {running || queuedCount > 0 ? <button aria-label="Stop assistant" title="Stop work and cancel waiting messages" className="grid size-7 shrink-0 place-items-center rounded-full text-muted-foreground hover:bg-accent disabled:opacity-40" disabled={stopping} type="button" onClick={() => void stop()}>{stopping ? <LoaderCircle className="size-3 animate-spin" /> : <Square className="size-3 fill-current" />}</button> : null}
            <button aria-label="Send message" className="assistant-message-send grid size-7 shrink-0 place-items-center rounded-full text-white disabled:opacity-40" disabled={(!draft.trim() && !attachments.length) || stopping || readingAttachments || !state || !accounts.length} type="submit"><ArrowUp className="size-4" /></button>
          </form>
        </div>
      </div>
    </section>
  )
}

function ActionGroup({ actions, shell }: { actions: AssistantAction[]; shell: SessionShellState }) {
  const [expanded, setExpanded] = useState(false)
  const panelId = useId()
  const running = actions.some((action) => action.status === "running")
  return (
    <div className="w-fit min-w-0 max-w-[88%]">
      <button className="inline-flex min-h-8 items-center gap-2 rounded-full border border-border bg-card px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring" type="button" aria-expanded={expanded} aria-controls={panelId} onClick={() => setExpanded((open) => !open)}>
        {running ? <LoaderCircle aria-hidden="true" className="size-3.5 animate-spin motion-reduce:animate-none" /> : <Wrench aria-hidden="true" className="size-3.5" />}
        <span>{actions.length} {actions.length === 1 ? "tool" : "tools"}</span>
        <ChevronRight aria-hidden="true" className={cn("size-3 transition-transform duration-200 motion-reduce:transition-none", expanded && "rotate-90")} />
      </button>
      <div className="assistant-tool-reveal" data-expanded={expanded} id={panelId} aria-hidden={!expanded} inert={!expanded}>
        <div className="min-h-0 overflow-hidden">
          <div className="flex min-w-0 flex-col items-start gap-1 pt-1.5">
            {actions.map((action) => <ActionReceipt action={action} key={action.id} shell={shell} />)}
          </div>
        </div>
      </div>
    </div>
  )
}

function ActionReceipt({ action, shell }: { action: AssistantAction; shell: SessionShellState }) {
  const chat = shell.chats.find((item) => item.id === action.chatId)
  const directory = action.workingDirectory ?? chat?.workingDirectory
  const workspace = shell.recentWorkspaces.find((item) => item.path === directory)
  const linkedChat = action.chatId ? { id: action.chatId, title: chat?.title ?? "Codex chat" } : null
  return (
    <details className="group min-w-0 max-w-full">
      <summary className="inline-flex min-h-8 max-w-full cursor-pointer list-none items-center gap-2 rounded-full border border-border bg-card px-3 py-1.5 text-xs transition-colors hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
        {action.status === "running" ? <LoaderCircle role="img" aria-label="Running" className="size-3.5 shrink-0 animate-spin text-muted-foreground motion-reduce:animate-none" /> : action.status === "failed" ? <TriangleAlert role="img" aria-label="Failed" className="size-3.5 shrink-0 text-destructive" /> : <Check role="img" aria-label="Completed" className="size-3.5 shrink-0 text-emerald-500" />}
        <span className="truncate">{labels[action.tool] ?? action.tool}</span>
        <ChevronRight aria-hidden="true" className="size-3 shrink-0 text-muted-foreground transition-transform duration-200 group-open:rotate-90 motion-reduce:transition-none" />
      </summary>
      <div className="mt-1 rounded-2xl border border-border bg-card px-3 py-3">
        {linkedChat ? <button type="button" className="mb-3 inline-block text-xs text-info underline underline-offset-4" onClick={() => void shell.openSidebarChat(linkedChat)}>Open chat{workspace ? ` · ${workspace.name}` : ""}</button> : null}
        <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all text-[11px] leading-5 text-muted-foreground">{action.result ? prettyResult(action.result) : prettyResult(JSON.stringify(action.arguments))}</pre>
      </div>
    </details>
  )
}

function prettyResult(result: string): string {
  try { return JSON.stringify(JSON.parse(result), null, 2) }
  catch { return result }
}

function conversationDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(value))
}

function conversationTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(new Date(value))
}
