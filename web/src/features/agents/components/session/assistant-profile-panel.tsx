import { Tabs } from "@base-ui/react/tabs"
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { useRef, useState } from "react"
import { ArrowUpRight, ChevronRight, Folder, ImagePlus, LoaderCircle, MessageCircle, Pencil, Plug, Plus, RefreshCw, Sparkles, X } from "lucide-react"
import type { AssistantState } from "@/features/agents/types/assistant"
import type { ProviderAccountResponse } from "@/features/agents/lib/api-client"
import type { SessionShellState } from "@/features/agents/components/session/session-shell"
import { PushNotificationButton } from "@/features/agents/components/session/push-notification-button"
import { relativeTimeLabel } from "@/features/agents/lib/session"
import { AgentAvatar } from "@/features/agents/components/session/agent-avatar"
import { avatarFromFile } from "@/features/agents/lib/agent-avatar"
import { AgentIntegrationsPanel } from "@/features/agents/components/session/agent-integrations-panel"

export function AssistantProfilePanel({ open, onOpenChange, agentId, name, state, accounts, accountId, onAccountChange, disabled, onRefresh, onEditProfile, onAvatarChange, onGenerateAvatar, onCancelFollowUp, shell }: {
  open: boolean
  onOpenChange: (open: boolean) => void
  name: string
  agentId: string
  state: AssistantState | null
  accounts: ProviderAccountResponse[]
  accountId: string
  onAccountChange: (id: string) => void
  disabled: boolean
  onRefresh: () => void
  onEditProfile: () => void
  onAvatarChange: (avatar: string) => Promise<void>
  onGenerateAvatar: () => void
  onCancelFollowUp: (id: string) => Promise<void>
  shell: SessionShellState
}) {
  const afterCloseAction = useRef<(() => void) | null>(null)
  const closeWithAction = (action: () => void) => {
    afterCloseAction.current = action
    onOpenChange(false)
  }
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [uploading, setUploading] = useState(false)
  const [avatarError, setAvatarError] = useState<string | null>(null)
  const [followUpError, setFollowUpError] = useState<string | null>(null)
  const [cancellingFollowUp, setCancellingFollowUp] = useState<string | null>(null)
  const activeFollowUps = state?.followUps?.filter((followUp) => followUp.status !== "completed" && followUp.status !== "cancelled") ?? []
  const running = state?.status === "running"
  const lastReply = state?.messages.slice().reverse().find((message) => message.role === "assistant")
  const chatIds = [...new Set(state?.messages.flatMap((message) => message.actions?.flatMap((action) => action.chatId ? [action.chatId] : []) ?? []).reverse() ?? [])]
  const recentChats = chatIds.flatMap((id) => {
    const chat = shell.chats.find((item) => item.id === id)
    return chat ? [chat] : []
  }).slice(0, 5)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <div className="assistant-identity absolute left-1/2 top-2 z-20 -translate-x-1/2">
        <DialogTrigger asChild>
          <button type="button" aria-label={`Open ${name} details`} className="flex max-w-56 flex-col items-center gap-1 rounded-xl px-3 py-1 outline-none focus-visible:ring-2 focus-visible:ring-ring">
            <AgentAvatar name={name} avatar={state?.profile.avatar} />
            <span className="max-w-full truncate text-[14px] font-medium">{name}</span>
          </button>
        </DialogTrigger>
      </div>
      <DialogContent className="assistant-profile-panel session-app flex max-w-md flex-col gap-0 overflow-hidden rounded-2xl p-0" onCloseAutoFocus={(event) => {
        const action = afterCloseAction.current
        if (action) {
          // Let this dialog release focus before opening another dialog or focusing the composer.
          event.preventDefault()
          afterCloseAction.current = null
          action()
        }
      }}>
        <div className="flex shrink-0 items-center gap-4 px-6 pb-5 pt-6 pr-12">
          <AgentAvatar name={name} avatar={state?.profile.avatar} className="size-14" />
          <div className="min-w-0">
            <DialogTitle className="truncate text-lg font-medium">{name}</DialogTitle>
            <DialogDescription className="mt-1 flex items-center gap-1.5 text-xs">
              {running ? <><LoaderCircle className="size-3 animate-spin" />Working now</> : <><span aria-hidden="true" className="size-1.5 rounded-full bg-success" />{lastReply ? `Active ${relativeTimeLabel(lastReply.createdAt)}` : "Ready to chat"}</>}
            </DialogDescription>
          </div>
        </div>

        <Tabs.Root defaultValue="profile" className="flex min-h-0 flex-1 flex-col">
          <Tabs.List aria-label="Agent details" className="flex shrink-0 gap-5 border-b border-border px-6">
            <Tabs.Tab value="profile" className="border-b-2 border-transparent pb-3 text-[13px] text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring data-active:border-foreground data-active:text-foreground">Profile</Tabs.Tab>
            <Tabs.Tab value="activity" className="border-b-2 border-transparent pb-3 text-[13px] text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring data-active:border-foreground data-active:text-foreground">Activity{activeFollowUps.length ? <span className="ml-2 rounded-md bg-secondary px-1.5 py-0.5 text-[11px]">{activeFollowUps.length}</span> : null}</Tabs.Tab>
            <Tabs.Tab value="integrations" className="border-b-2 border-transparent pb-3 text-[13px] text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring data-active:border-foreground data-active:text-foreground">Integrations</Tabs.Tab>
          </Tabs.List>
          <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
            <Tabs.Panel value="profile" className="space-y-5 outline-none">
              <section aria-label="Agent appearance">
                <div className="mb-3 flex items-center justify-between gap-2">
                  <h2 className="text-[13px] font-medium">Appearance & personality</h2>
                  <button className="flex items-center gap-1.5 rounded-md text-xs text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-40" disabled={!state} type="button" onClick={() => closeWithAction(onEditProfile)}><Pencil className="size-3" />Edit in chat</button>
                </div>
                {state?.profile.personality ? <details className="mb-3 text-xs text-muted-foreground"><summary className="cursor-pointer">Personality</summary><p className="mt-2 max-h-32 overflow-y-auto whitespace-pre-wrap break-words leading-5">{state.profile.personality}</p></details> : null}
                <input aria-label="Upload agent avatar" className="hidden" ref={fileInputRef} type="file" accept="image/png,image/jpeg,image/webp" onChange={async (event) => {
                  const file = event.currentTarget.files?.[0]
                  event.currentTarget.value = ""
                  if (!file || uploading) return
                  setUploading(true)
                  setAvatarError(null)
                  try { await onAvatarChange(await avatarFromFile(file)) }
                  catch (cause) { setAvatarError(cause instanceof Error ? cause.message : "Unable to update avatar.") }
                  finally { setUploading(false) }
                }} />
                <div className="flex flex-wrap gap-2">
                  <button className="inline-flex h-8 items-center gap-2 rounded-lg border border-border px-3 text-xs hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-40" disabled={disabled || uploading || !state} type="button" onClick={() => fileInputRef.current?.click()}>{uploading ? <LoaderCircle className="size-3.5 animate-spin" /> : <ImagePlus className="size-3.5" />}Upload image</button>
                  <button className="inline-flex h-8 items-center gap-2 rounded-lg border border-border px-3 text-xs hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-40" disabled={disabled || uploading || !state || !accounts.length} type="button" onClick={() => closeWithAction(onGenerateAvatar)}><Sparkles className="size-3.5" />Generate avatar</button>
                </div>
                {avatarError ? <p role="alert" className="mt-2 text-xs text-destructive">{avatarError}</p> : null}
              </section>

              <section aria-label="Agent settings">
                <h2 className="mb-3 text-[13px] font-medium">Settings</h2>
                <div className="divide-y divide-border rounded-xl border border-border bg-card/40">
                  <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
                    <label className="text-xs" htmlFor="assistant-account">Provider account</label>
                    <select id="assistant-account" aria-label="Assistant account" className="h-8 w-44 max-w-full rounded-lg border border-border bg-secondary px-2 text-xs text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring" disabled={disabled} value={accountId} onChange={(event) => onAccountChange(event.target.value)}>
                      <option value="">{accounts.find((account) => account.id === state?.accountId)?.displayName ?? "Automatic account"}</option>
                      {accounts.map((account) => <option key={account.id} value={account.id}>{account.displayName}</option>)}
                    </select>
                  </div>
                  <button className="flex w-full items-center gap-2 px-4 py-3 text-left text-xs hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring" type="button" onClick={() => closeWithAction(() => shell.selectManagementView("providers"))}><Plug className="size-3.5 text-muted-foreground" /><span className="flex-1">Manage providers</span><ArrowUpRight className="size-3.5 text-muted-foreground" /></button>
                  <div className="px-4 py-3"><PushNotificationButton /></div>
                  {shell.agents.length > 1 ? <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
                    <label className="text-xs" htmlFor="assistant-agent">Switch agent</label>
                    <select id="assistant-agent" className="h-8 w-44 max-w-full rounded-lg border border-border bg-secondary px-2 text-xs text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring" value={agentId} onChange={(event) => { const id = event.target.value; closeWithAction(() => shell.selectAgent(id)) }}>
                      {shell.agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.profile.name}{agent.status === "running" ? " · Working" : ""}</option>)}
                    </select>
                  </div> : null}
                </div>
              </section>
            </Tabs.Panel>

            <Tabs.Panel value="activity" className="space-y-5 outline-none">
              <section aria-label="Agent follow-ups">
                <h2 className="mb-3 text-[13px] font-medium">Watches & schedules</h2>
                {activeFollowUps.length ? <div className="divide-y divide-border rounded-xl border border-border">
                  {activeFollowUps.map((followUp) => <div className="px-4 py-3" key={followUp.id}>
                    <div className="flex items-start gap-2">
                      <div className="min-w-0 flex-1"><p className="text-xs">{followUp.kind === "task-plan" ? `Planning · ${followUp.title ?? "Task"}` : followUp.kind === "run" ? "Watching coding task" : "Scheduled follow-up"}</p><p className="mt-1 text-[11px] capitalize text-muted-foreground">{followUp.status}</p></div>
                      <button aria-label="Cancel follow-up" className="session-icon-button disabled:opacity-40" disabled={Boolean(cancellingFollowUp)} type="button" onClick={() => {
                        setCancellingFollowUp(followUp.id); setFollowUpError(null)
                        void onCancelFollowUp(followUp.id).catch((cause) => setFollowUpError(cause instanceof Error ? cause.message : "Unable to cancel follow-up.")).finally(() => setCancellingFollowUp(null))
                      }}>{cancellingFollowUp === followUp.id ? <LoaderCircle className="size-3 animate-spin" /> : <X className="size-3" />}</button>
                    </div>
                    <p className="mt-2 line-clamp-3 break-words text-xs leading-5 text-muted-foreground">{followUp.instructions}</p>
                    {followUp.dueAt ? <time className="mt-2 block text-[11px] text-muted-foreground" dateTime={followUp.dueAt}>{new Date(followUp.dueAt).toLocaleString()}{followUp.intervalMinutes ? ` · Every ${followUp.intervalMinutes} min` : ""}</time> : null}
                    {followUp.error ? <p className="mt-1 text-xs text-destructive">{followUp.error}</p> : null}
                  </div>)}
                </div> : <p className="text-xs leading-5 text-muted-foreground">No active follow-ups. Ask {name} to watch a task or schedule a check-in.</p>}
                {activeFollowUps.length ? <p className="mt-2 text-[11px] leading-5 text-muted-foreground">Follow-ups run while Boosted is running, even with this browser closed.</p> : null}
                {followUpError ? <p role="alert" className="mt-2 text-xs text-destructive">{followUpError}</p> : null}
              </section>
              <section aria-label="Recent agent activity">
                <h2 className="mb-3 text-[13px] font-medium">Recent tasks</h2>
                {recentChats.length ? <div className="divide-y divide-border rounded-xl border border-border">{recentChats.map((chat) => <button className="flex w-full items-center gap-2 px-4 py-3 text-left text-xs hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring" key={chat.id} type="button" onClick={() => closeWithAction(() => { void shell.openSidebarChat(chat) })}>
                  <MessageCircle className="size-3.5 shrink-0 text-muted-foreground" /><span className="min-w-0 flex-1 truncate">{chat.title}</span>{chat.status === "RUNNING" ? <span aria-label="Running" className="size-1.5 shrink-0 rounded-full bg-success" /> : null}<ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
                </button>)}</div> : <p className="text-xs text-muted-foreground">No coding tasks yet.</p>}
              </section>
              <button className="inline-flex items-center gap-2 rounded-md text-xs text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring" type="button" onClick={() => closeWithAction(() => shell.selectNavigationView("projects"))}><Folder className="size-3.5" />Browse projects<ArrowUpRight className="size-3" /></button>
            </Tabs.Panel>
            <Tabs.Panel value="integrations" className="outline-none">
              <AgentIntegrationsPanel agentId={agentId} agentName={name} />
            </Tabs.Panel>
          </div>
        </Tabs.Root>
        <div className="flex shrink-0 items-center justify-between border-t border-border px-6 py-3">
          <button className="inline-flex h-8 items-center gap-2 rounded-lg px-2 text-xs text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring" type="button" onClick={() => closeWithAction(shell.openCreateAgent)}><Plus className="size-3.5" />New agent</button>
          <button className="inline-flex h-8 items-center gap-2 rounded-lg px-2 text-xs text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring" type="button" onClick={onRefresh}><RefreshCw className="size-3.5" />Refresh</button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
