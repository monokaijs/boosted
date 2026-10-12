import { MessageSquare } from "lucide-react"
import type { AssistantAction } from "@/features/agents/types/assistant"
import type { SessionShellState } from "./session-shell"
import { isChatActionVisible } from "@/features/agents/lib/assistant-actions"

export function SpawnedChatLinks({ actions, shell, onOpenChat }: { actions: AssistantAction[]; shell?: SessionShellState; onOpenChat?: (chatId: string) => void }) {
  const chats = actions.filter(isChatActionVisible).filter((action, index, spawned) => spawned.findIndex((other) => other.chatId === action.chatId) === index)
  if (!chats.length) return null
  return <div className="flex w-fit min-w-0 max-w-[88%] flex-col items-start gap-1">
    {chats.map((action) => {
      const chat = shell?.chats.find((item) => item.id === action.chatId)
      const linkedChat = { id: action.chatId!, title: chat?.title ?? "Codex chat" }
      const workspace = shell?.recentWorkspaces.find((item) => item.path === (action.workingDirectory ?? chat?.workingDirectory))
      return <button key={action.chatId} type="button" className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs text-info hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring" onClick={() => onOpenChat ? onOpenChat(linkedChat.id) : shell ? void shell.openSidebarChat(linkedChat) : window.dispatchEvent(new CustomEvent("boosted:open-codex-chat", { detail: { threadId: linkedChat.id } }))}>
        <MessageSquare aria-hidden="true" className="size-3.5 shrink-0" />Open chat{workspace ? ` · ${workspace.name}` : ""}
      </button>
    })}
  </div>
}
