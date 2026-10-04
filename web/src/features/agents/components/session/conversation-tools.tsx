import { useId, useState } from "react"
import { Check, ChevronRight, LoaderCircle, TriangleAlert, Wrench } from "lucide-react"
import type { AssistantAction } from "@/features/agents/types/assistant"
import type { SessionShellState } from "./session-shell"
import { isChatActionVisible } from "@/features/agents/lib/assistant-actions"
import { cn } from "@/lib/utils"

const labels: Record<string, string> = {
  read_group_context: "Read group context", send_group_message: "Send group message",
  request_group_peers: "Ask a peer", create_group_task: "Create assignment", claim_group_task: "Claim assignment",
  submit_group_result: "Submit result", review_group_task: "Review assignment", block_group_task: "Report a blocker",
  computer_status: "Inspect computer", computer_screenshot: "Capture screen", computer_action: "Control computer",
  commandExecution: "Run command", fileChange: "Edit files", mcpToolCall: "Call MCP tool", webSearch: "Search the web", imageView: "View image",
  watch_chat: "Watch coding run", schedule_follow_up: "Schedule follow-up", list_follow_ups: "Read follow-ups", cancel_follow_up: "Cancel follow-up",
  get_profile: "Read assistant profile", update_profile: "Update name and personality",
  generate_avatar: "Generate avatar",
  select_agent_model: "Adjust reasoning",
  list_workspaces: "Read projects", list_chats: "Read chats", read_chat: "Read conversation", read_run: "Read coding run",
  list_accounts: "Check provider capacity", list_models: "Read Codex models", set_chat_model: "Switch chat model", create_chat: "Create chat", send_message: "Send instructions",
  stop_chat: "Stop chat", stop_run: "Stop coding run", set_chat_access: "Change chat access", clear_chat: "Clear conversation", delete_chat: "Delete conversation", move_chat: "Move chat to another account", set_failover: "Update quota recovery",
  fork_chat: "Fork conversation", rename_chat: "Rename chat",
}
export function ActionGroup({ actions, shell, showAll = false }: { actions: AssistantAction[]; shell?: SessionShellState; showAll?: boolean }) {
  const listed = showAll ? actions : actions.filter(isChatActionVisible)
  return listed.length ? <ActionGroupContent actions={listed} shell={shell} /> : null
}

function ActionGroupContent({ actions, shell }: { actions: AssistantAction[]; shell?: SessionShellState }) {
  const [expanded, setExpanded] = useState(false)
  const [revealed, setRevealed] = useState(false)
  const panelId = useId()
  const running = actions.some((action) => action.status === "running")
  return (
    <div className="w-fit min-w-0 max-w-[88%]">
      <button className="inline-flex h-6 items-center gap-1.5 rounded-full border border-border/60 bg-card px-2 text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring" type="button" aria-label={`${actions.length} ${actions.length === 1 ? "tool" : "tools"}`} aria-expanded={expanded} aria-controls={panelId} onClick={() => { setRevealed(true); setExpanded((open) => !open) }}>
        {running ? <LoaderCircle aria-hidden="true" className="size-3 animate-spin motion-reduce:animate-none" /> : <Wrench aria-hidden="true" className="size-3" />}
        <span className="tabular-nums">{actions.length}</span>
        <ChevronRight aria-hidden="true" className={cn("size-3 transition-transform duration-200 motion-reduce:transition-none", expanded && "rotate-90")} />
      </button>
      <div className="assistant-tool-reveal" data-expanded={expanded} id={panelId} aria-hidden={!expanded} inert={!expanded}>
        <div className="min-h-0 overflow-hidden">
          <div className="flex min-w-0 flex-col items-start gap-1 pt-1.5">
            {revealed ? actions.map((action) => <ActionReceipt action={action} key={action.id} shell={shell} />) : null}
          </div>
        </div>
      </div>
    </div>
  )
}

function ActionReceipt({ action, shell }: { action: AssistantAction; shell?: SessionShellState }) {
  const [open, setOpen] = useState(false)
  const chat = shell?.chats.find((item) => item.id === action.chatId)
  const directory = action.workingDirectory ?? chat?.workingDirectory
  const workspace = shell?.recentWorkspaces.find((item) => item.path === directory)
  const linkedChat = action.chatId ? { id: action.chatId, title: chat?.title ?? "Codex chat" } : null
  return (
    <details className="group min-w-0 max-w-full" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary className="inline-flex min-h-8 max-w-full cursor-pointer list-none items-center gap-2 rounded-full border border-border bg-card px-3 py-1.5 text-xs transition-colors hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
        {action.status === "running" ? <LoaderCircle role="img" aria-label="Running" className="size-3.5 shrink-0 animate-spin text-muted-foreground motion-reduce:animate-none" /> : action.status === "failed" ? <TriangleAlert role="img" aria-label="Failed" className="size-3.5 shrink-0 text-destructive" /> : <Check role="img" aria-label="Completed" className="size-3.5 shrink-0 text-emerald-500" />}
        <span className="truncate">{labels[action.tool] ?? action.tool}</span>
        <ChevronRight aria-hidden="true" className="size-3 shrink-0 text-muted-foreground transition-transform duration-200 group-open:rotate-90 motion-reduce:transition-none" />
      </summary>
      {open ? <div className="mt-1 rounded-2xl border border-border bg-card px-3 py-3">
        {linkedChat ? <button type="button" className="mb-3 inline-block text-xs text-info underline underline-offset-4" onClick={() => shell ? void shell.openSidebarChat(linkedChat) : window.dispatchEvent(new CustomEvent("boosted:open-codex-chat", { detail: { threadId: linkedChat.id } }))}>Open chat{workspace ? ` · ${workspace.name}` : ""}</button> : null}
        <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all text-[11px] leading-5 text-muted-foreground">{action.result ? prettyResult(action.result) : prettyResult(JSON.stringify(action.arguments))}</pre>
      </div> : null}
    </details>
  )
}

function prettyResult(result: string): string {
  try { return JSON.stringify(JSON.parse(result), null, 2) }
  catch { return result }
}
