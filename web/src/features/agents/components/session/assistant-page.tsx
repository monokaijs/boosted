import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { LoaderCircle, MessageSquarePlus, RefreshCw, ShieldCheck, TriangleAlert } from "lucide-react"
import type { AssistantAttachment, AssistantState } from "@/features/agents/types/assistant"
import { apiClient, type ProviderAccountResponse } from "@/features/agents/lib/api-client"
import { MarkdownContent } from "@/features/agents/components/session/chat-markdown"
import type { SessionShellState } from "@/features/agents/components/session/session-shell"
import { cn } from "@/lib/utils"
import { shouldAcceptAssistantState } from "@/features/agents/lib/assistant-state"
import { assistantConversationLayout } from "@/features/agents/lib/assistant-conversation"
import { assistantMessagesWithOutbox, type AssistantPendingMessage } from "@/features/agents/lib/assistant-outbox"
import { ActionGroup } from "./conversation-tools"
import { AssistantProfilePanel } from "@/features/agents/components/session/assistant-profile-panel"
import { AssistantAttachmentList } from "@/features/agents/components/session/assistant-attachment-list"
import { AssistantComposer, type AssistantComposerHandle } from "./assistant-composer"

const suggestions = [
  { icon: MessageSquarePlus, label: "Start a task", prompt: "Show me my projects and help me start a new coding task. I can give you work for several projects at once." },
  { icon: RefreshCw, label: "Keep work moving", prompt: "Check my connected accounts and chats. Which chats need attention, and which accounts still have quota?" },
  { icon: ShieldCheck, label: "Recover a chat", prompt: "Help me move a chat whose account has run out of quota to another connected account, preserving its conversation." },
]

export function AssistantPage({ shell, agentId }: { shell: SessionShellState; agentId: string }) {
  const [state, setState] = useState<AssistantState | null>(null)
  const [accounts, setAccounts] = useState<ProviderAccountResponse[]>([])
  const [accountId, setAccountId] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [outbox, setOutbox] = useState<AssistantPendingMessage[]>([])
  const sendQueue = useRef(Promise.resolve())
  const [stopping, setStopping] = useState(false)
  const [refreshKey, setRefreshKey] = useState(0)
  const [profileOpen, setProfileOpen] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const followRef = useRef(true)
  const requestId = useRef(0)
  const latestState = useRef<AssistantState | null>(null)
  const composerRef = useRef<AssistantComposerHandle>(null)
  const running = state?.status === "running"
  const activity = running && !state?.activeGroupId ? state?.activity : null
  const sending = outbox.some((message) => message.localDelivery === "sending")
  const messages = useMemo(() => assistantMessagesWithOutbox(state?.messages ?? [], outbox), [state?.messages, outbox])
  const conversation = useMemo(() => assistantConversationLayout(messages), [messages])
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
    composerRef.current?.focus()
  }

  const send = (message: string, sendingAttachments: AssistantAttachment[] = []) => {
    const content = message.trim() || (sendingAttachments.length ? "Please look at the attached files." : "")
    if (!content || stopping || !state || !accounts.length) return false
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
    void dispatchMessage(pending)
    return true
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
        onGenerateAvatar={() => {
          if (send("Design an original avatar that fits your name and personality. Use generate_avatar to save it as your profile picture.")) composerRef.current?.focus()
        }}
        onEditProfile={() => {
          composerRef.current?.setDraft((current) => current || "I'd like to update your name and personality.")
          composerRef.current?.focus()
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
                {suggestions.map(({ icon: Icon, label, prompt }) => <button className="rounded-2xl border border-border p-4 text-left transition-colors hover:bg-accent" key={label} type="button" onClick={() => { composerRef.current?.setDraft(prompt); composerRef.current?.focus() }}><Icon className="mb-4 size-4 text-muted-foreground" /><span className="text-[13px] font-medium">{label}</span><p className="mt-2 text-xs leading-5 text-muted-foreground">{label === "Start a task" ? "Create a chat and give it a job." : label === "Keep work moving" ? "See progress and available capacity." : "Continue with another account."}</p></button>)}
              </div>
            </div>
          ) : null}
          <div>
            {conversation.map((item) => {
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
                    <span aria-live={showDeliveryStatus ? "polite" : undefined}>{message.delivery === "processing" || message.delivery === "handled" ? "Read" : "Delivered"}</span>
                    <time className="hidden group-hover/message:ml-1 group-hover/message:block group-focus-within/message:ml-1 group-focus-within/message:block" dateTime={message.readAt ?? message.createdAt}>{conversationTime(message.readAt ?? message.createdAt)}</time>
                  </div> : null}
                </article>}
              </div>
            )})}
          </div>
          {activity ? <div aria-label={`${assistantName} is typing`} className="assistant-message-bubble assistant-message-reply mt-3 w-fit rounded-[22px] px-4 py-2.5 text-xs text-muted-foreground" role="status"><span aria-hidden="true" className="animate-pulse tracking-widest motion-reduce:animate-none">•••</span></div> : null}
        </div>
      </div>

      <div className="session-composer shrink-0">
        <div className="session-conversation-column mx-auto">
          {error || state?.error ? <p className="mb-3 rounded-xl border border-destructive/20 bg-destructive/5 px-3 py-2 text-xs leading-5 text-destructive" role="alert">{error ?? state?.error}</p> : null}
          {state && !accounts.length ? <div className="mb-3 flex items-center justify-between gap-3 text-xs text-muted-foreground"><span>Connect a Codex account to get started.</span><button className="text-foreground underline underline-offset-4" type="button" onClick={() => shell.selectManagementView("providers")}>Open Providers</button></div> : null}
          {state?.activeGroupId ? <button className="mb-2 text-xs text-muted-foreground underline" type="button" onClick={() => window.dispatchEvent(new CustomEvent("boosted:open-group", { detail: state.activeGroupId }))}>Working in a group. Open group</button> : null}
          <AssistantComposer
            key={agentId} ref={composerRef} agentId={agentId} assistantName={assistantName}
            canSend={Boolean(state && accounts.length)} stopping={stopping}
            showStop={Boolean((running && !state?.activeGroupId) || queuedCount > 0)}
            onSend={send} onStop={() => void stop()} onError={setError}
          />
        </div>
      </div>
    </section>
  )
}

function conversationDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(value))
}

function conversationTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(new Date(value))
}
