import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Columns2, LoaderCircle, MessageSquare, Pin, Plus, RefreshCw, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { api } from "@/lib/api";
import { useAppStore } from "@/lib/store";
import type { CodexChat } from "@/lib/types";
import { cn, relativeTime } from "@/lib/utils";

function ChatRow({ chat }: { chat: CodexChat }) {
  const selected = useAppStore((state) => state.selectedCodexChatId === chat.id);
  const selectChat = useAppStore((state) => state.selectCodexChat);
  const setDrawerOpen = useAppStore((state) => state.setTaskDrawerOpen);
  function openChat(split = false) {
    selectChat(chat.id);
    if (window.matchMedia("(max-width: 900px)").matches) setDrawerOpen(false);
    window.dispatchEvent(new CustomEvent("boosted:open-codex-chat", { detail: { threadId: chat.id, title: chat.title, split } }));
  }
  return (
    <div className="group relative">
      <button className={cn("grid w-full grid-cols-[20px_1fr] gap-2 rounded-md px-2 py-2 text-left hover:bg-accent/65", selected && "bg-accent")} title={`${chat.cwd} · Shift-click to open beside`} onClick={(event) => openChat(event.shiftKey)}>
        <MessageSquare className="mt-0.5 size-4 text-muted-foreground" />
        <div className="min-w-0">
          <div className="flex items-center gap-1.5"><p className="min-w-0 flex-1 truncate text-[12px] font-medium">{chat.title}</p>{chat.isPinned && <Pin className="size-3 shrink-0 text-muted-foreground" />}</div>
          {chat.preview && <p className="mt-0.5 truncate text-[10px] text-muted-foreground">{chat.preview}</p>}
          <p className="mt-1 flex items-center gap-1.5 truncate text-[10px] text-muted-foreground"><span>{chat.model || "Codex"}</span><span>·</span><span>{chat.source}</span><span className="ml-auto shrink-0">{relativeTime(chat.updatedAt)}</span></p>
        </div>
      </button>
      <Button type="button" variant="ghost" size="icon-sm" className={cn("codex-chat-split absolute right-1.5 top-1.5 opacity-0 group-hover:opacity-100", selected && "opacity-100")} title="Open chat beside the current one" aria-label={`Open ${chat.title} to the side`} onClick={() => openChat(true)}><Columns2 /></Button>
    </div>
  );
}

export function CodexChatsDrawer() {
  const [search, setSearch] = useState("");
  const projectId = useAppStore((state) => state.selectedProjectId);
  const selectedChatId = useAppStore((state) => state.selectedCodexChatId);
  const selectChat = useAppStore((state) => state.selectCodexChat);
  const projects = useQuery({ queryKey: ["projects"], queryFn: api.projects });
  const project = projects.data?.find((entry) => entry.id === projectId);
  const chats = useQuery({ queryKey: ["codex-chats", project?.repoPath], queryFn: () => api.codexChats(project!.repoPath), enabled: Boolean(project), refetchInterval: 15_000 });

  useEffect(() => {
    if (selectedChatId && chats.data && !chats.data.some((chat) => chat.id === selectedChatId)) selectChat(undefined);
  }, [chats.data, selectChat, selectedChatId]);
  const groups = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const filtered = (chats.data ?? []).filter((chat) => !needle || `${chat.title} ${chat.preview} ${chat.cwd} ${chat.model ?? ""}`.toLowerCase().includes(needle));
    const grouped = new Map<string, CodexChat[]>();
    for (const chat of filtered) grouped.set(chat.cwd, [...(grouped.get(chat.cwd) ?? []), chat]);
    return [...grouped.entries()];
  }, [chats.data, search]);

  return (
    <aside className="task-drawer">
      <div className="flex h-full min-w-0 flex-col">
        <div className="flex h-11 items-center justify-between px-3">
          <p className="min-w-0 truncate text-xs font-semibold">Codex chats</p>
          <div className="flex items-center gap-1"><Button variant="ghost" size="sm" disabled={!project} onClick={() => window.dispatchEvent(new CustomEvent("boosted:open-panel", { detail: "chat" }))}><Plus />Chat</Button><Button variant="ghost" size="icon-sm" title="Refresh chats" disabled={!project} onClick={() => void chats.refetch()}><RefreshCw className={chats.isFetching ? "animate-spin" : ""} /></Button></div>
        </div>
        <div className="px-2 pb-2"><div className="relative"><Search className="absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" /><Input className="bg-background/35 pl-7" placeholder="Search chats" value={search} onChange={(event) => setSearch(event.target.value)} /></div></div>
        <ScrollArea className="min-h-0 flex-1 px-2 pb-3">
          {chats.isLoading && <div className="grid h-40 place-items-center"><LoaderCircle className="size-5 animate-spin text-muted-foreground" /></div>}
          {chats.error && <div className="px-3 py-10 text-center text-xs leading-5 text-destructive">{chats.error.message}</div>}
          {groups.map(([cwd, items]) => (
            <section key={cwd}>{items.map((chat) => <ChatRow key={chat.id} chat={chat} />)}</section>
          ))}
          {!project && <div className="px-3 py-12 text-center text-xs text-muted-foreground">Open a project folder to view its Codex chats.</div>}
          {project && !chats.isLoading && !chats.error && groups.length === 0 && <div className="px-3 py-12 text-center text-xs text-muted-foreground">{search ? "No matching chats" : "No Codex chats found for this workspace"}</div>}
        </ScrollArea>
      </div>
    </aside>
  );
}
