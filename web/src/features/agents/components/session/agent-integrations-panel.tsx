import { useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Check, Copy, LoaderCircle, MessageCircle, Plus, RefreshCw, ShieldAlert, Trash2, X } from "lucide-react"
import { useAppStore } from "@/lib/store"
import { apiClient } from "@/features/agents/lib/api-client"
import type { AgentIntegration, AgentIntegrationCreate, AgentIntegrationProvider, AgentIntegrationUpdate } from "@/features/agents/types/assistant"

function statusLabel(connection: AgentIntegration) {
  if (!connection.enabled) return "Disabled"
  return connection.status.charAt(0).toUpperCase() + connection.status.slice(1)
}

export function AgentIntegrationsPanel({ agentId, agentName }: { agentId: string; agentName: string }) {
  const admin = useAppStore((state) => state.user?.role === "admin")
  const queryClient = useQueryClient()
  const queryKey = ["agent-integrations", agentId]
  const connections = useQuery({ queryKey, queryFn: () => apiClient.assistant.integrations(agentId), refetchInterval: 5_000 })
  const [adding, setAdding] = useState<AgentIntegrationProvider | null>(null)
  const [name, setName] = useState("")
  const [botToken, setBotToken] = useState("")
  const [appToken, setAppToken] = useState("")
  const [expanded, setExpanded] = useState<string | null>(null)
  const [editingCredentials, setEditingCredentials] = useState<string | null>(null)
  const [replacementBotToken, setReplacementBotToken] = useState("")
  const [replacementAppToken, setReplacementAppToken] = useState("")
  const [notice, setNotice] = useState<string | null>(null)

  const refresh = () => queryClient.invalidateQueries({ queryKey })
  const create = useMutation({
    mutationFn: (input: AgentIntegrationCreate) => apiClient.assistant.createIntegration(agentId, input),
    onSuccess: () => { setAdding(null); setName(""); setBotToken(""); setAppToken(""); setNotice("Connection added."); void refresh() },
  })
  const update = useMutation({ mutationFn: ({ connection, body }: { connection: AgentIntegration; body: AgentIntegrationUpdate }) => apiClient.assistant.updateIntegration(agentId, connection.id, body), onSuccess: () => void refresh() })
  const remove = useMutation({ mutationFn: (id: string) => apiClient.assistant.deleteIntegration(agentId, id), onSuccess: () => void refresh() })
  const test = useMutation({ mutationFn: (id: string) => apiClient.assistant.testIntegration(agentId, id), onSuccess: () => setNotice("Connection test succeeded.") })
  const approval = useMutation({ mutationFn: ({ connection, chatId, approved }: { connection: AgentIntegration; chatId: string; approved: boolean }) => apiClient.assistant.setIntegrationChatApproval(agentId, connection.id, chatId, approved), onSuccess: () => void refresh() })
  const error = connections.error ?? create.error ?? update.error ?? remove.error ?? test.error ?? approval.error

  return <section aria-label="Agent integrations" className="space-y-4">
    <div>
      <h2 className="text-[13px] font-medium">Slack & Telegram</h2>
      <p className="mt-1 text-xs leading-5 text-muted-foreground">Connect approved external chats to {agentName}. Each chat or thread keeps separate context.</p>
    </div>
    <div className="rounded-xl border border-amber-500/25 bg-amber-500/5 px-3 py-2.5 text-[11px] leading-5 text-muted-foreground">
      <span className="flex items-start gap-2"><ShieldAlert className="mt-0.5 size-3.5 shrink-0 text-amber-500" />Every member of an approved chat can use {agentName}&apos;s coding-chat and computer-control capabilities. Approve only trusted chats.</span>
    </div>

    {connections.data?.map((connection) => {
      const pending = connection.chats.filter((chat) => chat.status === "pending")
      const approved = connection.chats.filter((chat) => chat.status === "approved")
      const revoked = connection.chats.filter((chat) => chat.status === "revoked")
      return <div className="rounded-xl border border-border" key={connection.id}>
        <button className="flex w-full items-center gap-3 px-4 py-3 text-left" type="button" onClick={() => setExpanded((value) => value === connection.id ? null : connection.id)}>
          <span className="grid size-8 place-items-center rounded-lg bg-secondary"><MessageCircle className="size-4" /></span>
          <span className="min-w-0 flex-1"><span className="block truncate text-xs font-medium">{connection.name}</span><span className="mt-0.5 block text-[11px] text-muted-foreground">{connection.provider === "slack" ? connection.workspace || "Slack" : `@${connection.bot.username ?? connection.bot.name ?? "Telegram bot"}`} · {statusLabel(connection)}</span></span>
          {pending.length ? <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] text-amber-600">{pending.length} pending</span> : null}
        </button>
        {expanded === connection.id ? <div className="space-y-4 border-t border-border px-4 py-4">
          {connection.lastError ? <p role="alert" className="text-xs text-destructive">{connection.lastError}</p> : null}
          <p className="text-[11px] text-muted-foreground">{connection.lastActivityAt ? `Last chat activity ${new Date(connection.lastActivityAt).toLocaleString()}` : connection.lastConnectedAt ? `Connected ${new Date(connection.lastConnectedAt).toLocaleString()}` : "No chat activity yet."}</p>
          {admin ? <div className="flex flex-wrap gap-2">
            <button className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border px-2.5 text-xs hover:bg-accent disabled:opacity-50" disabled={update.isPending} onClick={() => update.mutate({ connection, body: { enabled: !connection.enabled } })}><span aria-hidden="true" className={`size-1.5 rounded-full ${connection.enabled ? "bg-emerald-500" : "bg-muted-foreground"}`} />{connection.enabled ? "Disable" : "Enable"}</button>
            {connection.enabled ? <button className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border px-2.5 text-xs hover:bg-accent disabled:opacity-50" disabled={update.isPending} onClick={() => update.mutate({ connection, body: { reconnect: true } })}><RefreshCw className="size-3" />Reconnect</button> : null}
            <button className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border px-2.5 text-xs hover:bg-accent disabled:opacity-50" disabled={test.isPending} onClick={() => test.mutate(connection.id)}>{test.isPending ? <LoaderCircle className="size-3 animate-spin" /> : <RefreshCw className="size-3" />}Test</button>
            <button className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border px-2.5 text-xs hover:bg-accent" onClick={() => { setEditingCredentials((value) => value === connection.id ? null : connection.id); setReplacementBotToken(""); setReplacementAppToken("") }}>Replace credentials</button>
            {connection.slackManifest ? <button className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border px-2.5 text-xs hover:bg-accent" onClick={() => { void navigator.clipboard.writeText(connection.slackManifest!); setNotice("Slack app manifest copied.") }}><Copy className="size-3" />Copy manifest</button> : null}
            <button className="ml-auto inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-xs text-destructive hover:bg-destructive/10 disabled:opacity-50" disabled={remove.isPending} onClick={() => { if (window.confirm(`Delete ${connection.name} and its external conversation history?`)) remove.mutate(connection.id) }}><Trash2 className="size-3" />Delete</button>
          </div> : null}
          {admin && editingCredentials === connection.id ? <form className="space-y-3 rounded-lg border border-border p-3" onSubmit={(event) => { event.preventDefault(); update.mutate({ connection, body: { botToken: replacementBotToken.trim(), ...(connection.provider === "slack" ? { appToken: replacementAppToken.trim() } : {}) } }, { onSuccess: () => { setEditingCredentials(null); setReplacementBotToken(""); setReplacementAppToken(""); setNotice("Credentials replaced.") } }) }}>
            <p className="text-[11px] text-muted-foreground">Saved credentials are write-only. Enter a complete replacement token set.</p>
            <div><label className="mb-1 block text-xs" htmlFor={`replacement-bot-token-${connection.id}`}>{connection.provider === "slack" ? "New bot token (xoxb-)" : "New BotFather token"}</label><input id={`replacement-bot-token-${connection.id}`} type="password" autoComplete="off" className="h-9 w-full rounded-lg border border-border bg-background px-3 font-mono text-xs outline-none focus:ring-2 focus:ring-ring" value={replacementBotToken} onChange={(event) => setReplacementBotToken(event.target.value)} /></div>
            {connection.provider === "slack" ? <div><label className="mb-1 block text-xs" htmlFor={`replacement-app-token-${connection.id}`}>New app token (xapp-)</label><input id={`replacement-app-token-${connection.id}`} type="password" autoComplete="off" className="h-9 w-full rounded-lg border border-border bg-background px-3 font-mono text-xs outline-none focus:ring-2 focus:ring-ring" value={replacementAppToken} onChange={(event) => setReplacementAppToken(event.target.value)} /></div> : null}
            <div className="flex justify-end gap-2"><button type="button" className="h-8 rounded-lg px-3 text-xs hover:bg-accent" onClick={() => setEditingCredentials(null)}>Cancel</button><button className="h-8 rounded-lg bg-primary px-3 text-xs text-primary-foreground disabled:opacity-50" disabled={update.isPending || !replacementBotToken.trim() || (connection.provider === "slack" && !replacementAppToken.trim())}>Replace</button></div>
          </form> : null}
          {pending.length ? <div><h3 className="mb-2 text-xs font-medium">Pending approval</h3><div className="divide-y divide-border rounded-lg border border-border">{pending.map((chat) => <div className="flex items-center gap-2 px-3 py-2.5" key={chat.id}><span className="min-w-0 flex-1"><span className="block truncate text-xs">{chat.name}</span><span className="text-[10px] text-muted-foreground">{chat.kind} · {chat.externalId}</span></span>{admin ? <><button aria-label={`Approve ${chat.name}`} className="grid size-7 place-items-center rounded-md text-emerald-600 hover:bg-emerald-500/10" onClick={() => approval.mutate({ connection, chatId: chat.id, approved: true })}><Check className="size-3.5" /></button><button aria-label={`Reject ${chat.name}`} className="grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-accent" onClick={() => approval.mutate({ connection, chatId: chat.id, approved: false })}><X className="size-3.5" /></button></> : null}</div>)}</div></div> : null}
          <div><h3 className="mb-2 text-xs font-medium">Approved chats</h3>{approved.length ? <div className="divide-y divide-border rounded-lg border border-border">{approved.map((chat) => <div className="flex items-center gap-2 px-3 py-2.5" key={chat.id}><span className="min-w-0 flex-1"><span className="block truncate text-xs">{chat.name}</span><span className="text-[10px] text-muted-foreground">Last seen {new Date(chat.lastSeenAt).toLocaleString()}</span></span>{admin ? <button className="text-[11px] text-muted-foreground hover:text-destructive" onClick={() => approval.mutate({ connection, chatId: chat.id, approved: false })}>Revoke</button> : null}</div>)}</div> : <p className="text-xs text-muted-foreground">No approved chats yet. Message the bot, then approve the pending chat here.</p>}</div>
          {revoked.length ? <div><h3 className="mb-2 text-xs font-medium">Revoked chats</h3><div className="divide-y divide-border rounded-lg border border-border">{revoked.map((chat) => <div className="flex items-center gap-2 px-3 py-2.5" key={chat.id}><span className="min-w-0 flex-1"><span className="block truncate text-xs">{chat.name}</span><span className="text-[10px] text-muted-foreground">Blocked · last seen {new Date(chat.lastSeenAt).toLocaleString()}</span></span>{admin ? <button className="text-[11px] text-muted-foreground hover:text-foreground" onClick={() => approval.mutate({ connection, chatId: chat.id, approved: true })}>Approve again</button> : null}</div>)}</div></div> : null}
          {connection.provider === "telegram" ? <p className="text-[11px] leading-5 text-muted-foreground">For group conversations, keep BotFather privacy mode enabled. Members invoke the agent by mentioning the bot or replying to it.</p> : null}
        </div> : null}
      </div>
    })}
    {!connections.isLoading && !connections.data?.length && !adding ? <p className="rounded-xl border border-dashed border-border px-4 py-7 text-center text-xs text-muted-foreground">No external chat connections.</p> : null}

    {admin && !adding ? <div className="flex gap-2"><button className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border px-3 text-xs hover:bg-accent" onClick={() => { setAdding("slack"); setName("Slack") }}><Plus className="size-3.5" />Slack</button><button className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border px-3 text-xs hover:bg-accent" onClick={() => { setAdding("telegram"); setName("Telegram") }}><Plus className="size-3.5" />Telegram</button></div> : null}
    {adding ? <form className="space-y-3 rounded-xl border border-border p-4" onSubmit={(event) => { event.preventDefault(); create.mutate({ provider: adding, name: name.trim(), botToken: botToken.trim(), ...(adding === "slack" ? { appToken: appToken.trim() } : {}) }) }}>
      <div><label className="mb-1 block text-xs" htmlFor="agent-integration-name">Connection name</label><input id="agent-integration-name" className="h-9 w-full rounded-lg border border-border bg-background px-3 text-xs outline-none focus:ring-2 focus:ring-ring" value={name} onChange={(event) => setName(event.target.value)} /></div>
      <div><label className="mb-1 block text-xs" htmlFor="agent-integration-bot-token">{adding === "slack" ? "Bot token (xoxb-)" : "BotFather token"}</label><input id="agent-integration-bot-token" autoComplete="off" type="password" className="h-9 w-full rounded-lg border border-border bg-background px-3 font-mono text-xs outline-none focus:ring-2 focus:ring-ring" value={botToken} onChange={(event) => setBotToken(event.target.value)} /></div>
      {adding === "slack" ? <div><label className="mb-1 block text-xs" htmlFor="agent-integration-app-token">App token (xapp-)</label><input id="agent-integration-app-token" autoComplete="off" type="password" className="h-9 w-full rounded-lg border border-border bg-background px-3 font-mono text-xs outline-none focus:ring-2 focus:ring-ring" value={appToken} onChange={(event) => setAppToken(event.target.value)} /><p className="mt-1 text-[10px] leading-4 text-muted-foreground">Enable Socket Mode and grant the app token <code>connections:write</code>.</p></div> : null}
      <div className="flex justify-end gap-2"><button className="h-8 rounded-lg px-3 text-xs hover:bg-accent" type="button" onClick={() => setAdding(null)}>Cancel</button><button className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-primary px-3 text-xs text-primary-foreground disabled:opacity-50" disabled={create.isPending || !name.trim() || !botToken.trim() || (adding === "slack" && !appToken.trim())}>{create.isPending ? <LoaderCircle className="size-3 animate-spin" /> : null}Connect</button></div>
    </form> : null}
    {connections.isLoading ? <p className="flex items-center gap-2 text-xs text-muted-foreground"><LoaderCircle className="size-3 animate-spin" />Loading connections…</p> : null}
    {error ? <p role="alert" className="text-xs text-destructive">{error.message}</p> : null}
    {notice ? <p role="status" className="text-xs text-emerald-600">{notice}</p> : null}
  </section>
}
