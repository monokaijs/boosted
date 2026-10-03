import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, CircleAlert, Folder, FolderOpen, FolderPlus, LoaderCircle, MessageSquarePlus, Pin, Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { useAppStore } from "@/lib/store";
import { chatActivity } from "@/lib/codex-chat-status";
import { cn } from "@/lib/utils";
import type { CodexChat, Project } from "@/lib/types";

type ProjectChat = { chat: CodexChat; project?: Project };
const normalizedPath = (path: string) => path.replace(/\\/g, "/").replace(/\/+$/, "");

export function ChatList({ activeChatId, onNewChat, onOpenProject, onClose }: { activeChatId?: string; onNewChat(): void; onOpenProject(): void; onClose(): void }) {
  const [search, setSearch] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [visibleCounts, setVisibleCounts] = useState<Record<string, number>>({});
  const [searchOpen, setSearchOpen] = useState(false);
  const projectId = useAppStore((state) => state.selectedProjectId);
  const projects = useQuery({ queryKey: ["projects"], queryFn: api.projects });
  const chats = useQuery({ queryKey: ["codex-chats", "all"], queryFn: () => api.codexChats(""), refetchInterval: 15_000 });
  const needle = search.trim().toLowerCase();
  const entries = useMemo(() => {
    const sortedProjects = [...(projects.data ?? [])].sort((a, b) => b.repoPath.length - a.repoPath.length);
    const unique = new Map<string, ProjectChat>();
    for (const chat of chats.data ?? []) {
      const cwd = normalizedPath(chat.cwd);
      const project = sortedProjects.find((entry) => { const path = normalizedPath(entry.repoPath); return cwd === path || cwd.startsWith(`${path}/`); });
      if (!needle || `${chat.title} ${chat.preview} ${project?.name ?? ""}`.toLowerCase().includes(needle)) unique.set(chat.id, { chat, project });
    }
    return [...unique.values()].sort((a, b) => Date.parse(b.chat.updatedAt) - Date.parse(a.chat.updatedAt));
  }, [chats.data, projects.data, needle]);
  const groups = (projects.data ?? []).map((project) => ({ project, entries: entries.filter((entry) => entry.project?.id === project.id) }));
  const activeChatVisibleInProject = groups.some(({ project, entries }) => expanded.has(project.id) && entries.slice(0, visibleCounts[project.id] ?? 4).some(({ chat }) => chat.id === activeChatId));

  function toggleProject(id: string) {
    if (expanded.has(id)) setVisibleCounts((counts) => ({ ...counts, [id]: 4 }));
    setExpanded((current) => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  }

  function openChat(entry: ProjectChat) {
    if (entry.project) useAppStore.getState().selectProject(entry.project);
    useAppStore.getState().selectCodexChat(entry.chat.id);
    window.dispatchEvent(new CustomEvent("boosted:open-codex-chat", { detail: { threadId: entry.chat.id, title: entry.chat.title } }));
    onClose();
  }

  function chatRow(entry: ProjectChat, nested = false) {
    const selected = activeChatId === entry.chat.id && (nested || !activeChatVisibleInProject);
    const activity = chatActivity(entry.chat.status);
    const statusLabel = activity === "idle" && !["idle", "completed", "interrupted"].includes(entry.chat.status)
      ? "Status unavailable"
      : { running: "Running", waiting: "Needs your input", failed: "Failed", idle: "Idle" }[activity];
    return <button key={entry.chat.id} className={cn("chat-list-row", nested && "chat-list-child", selected && "is-selected")} aria-current={selected ? "true" : undefined} title={`${entry.chat.title}\n${entry.project?.name ?? entry.chat.cwd}\n${statusLabel}`} onClick={() => openChat(entry)}>
      <span>{entry.chat.title}</span>
      {entry.chat.isPinned && <Pin className="chat-pin" aria-label="Pinned" />}
      {activity === "running" && <LoaderCircle className="chat-status chat-status-running" role="img" aria-label="Running" />}
      {activity === "waiting" && <CircleAlert className="chat-status chat-status-waiting" role="img" aria-label="Needs your input" />}
      {activity === "failed" && <CircleAlert className="chat-status chat-status-failed" role="img" aria-label="Failed" />}
    </button>;
  }

  return <section className="chat-list immersive-panel" aria-label="Chats">
    <header className="chat-list-header"><button className="chat-list-row chat-new" aria-label="New chat" onClick={onNewChat}><MessageSquarePlus /><span>New chat</span><kbd>⌘ N</kbd></button><Button variant="ghost" size="icon-sm" aria-label="Search chats" aria-expanded={searchOpen} onClick={() => { if (searchOpen) setSearch(""); setSearchOpen(!searchOpen); }}><Search /></Button><Button variant="ghost" size="icon-sm" aria-label="Open project" onClick={onOpenProject}><FolderPlus /></Button><Button variant="ghost" size="icon-sm" className="chat-list-mobile-close" aria-label="Close chats" onClick={onClose}><X /></Button></header>
    {searchOpen && <label className="chat-search"><Search /><input autoFocus aria-label="Search chats" placeholder="Search chats" value={search} onChange={(event) => setSearch(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape") { setSearch(""); setSearchOpen(false); } }} /><button aria-label="Close search" onClick={() => { setSearch(""); setSearchOpen(false); }}><X /></button></label>}
    <div className="chat-list-scroll">
      <section aria-labelledby="project-chats-heading"><h2 id="project-chats-heading">Projects</h2>
        {projects.isPending && <p className="chat-list-note"><LoaderCircle className="animate-spin" />Loading projects…</p>}
        {projects.error && <p className="chat-list-note text-destructive">{projects.error.message}<button onClick={() => void projects.refetch()}>Retry</button></p>}
        {groups.filter(({ project, entries }) => !needle || entries.length || project.name.toLowerCase().includes(needle)).map(({ project, entries }) => <div key={project.id}>
          <button className={cn("chat-project-row", projectId === project.id && "is-current-project")} aria-label={`${expanded.has(project.id) ? "Collapse" : "Expand"} ${project.name}`} aria-expanded={expanded.has(project.id)} onClick={() => toggleProject(project.id)} title={project.repoPath}>
            {expanded.has(project.id) ? <ChevronDown className="project-chevron" /> : <ChevronRight className="project-chevron" />}{expanded.has(project.id) ? <FolderOpen /> : <Folder />}<span>{project.name}</span>
          </button>
          {expanded.has(project.id) && <div>{entries.slice(0, visibleCounts[project.id] ?? 4).map((entry) => chatRow(entry, true))}{entries.length > (visibleCounts[project.id] ?? 4) && <button className="chat-list-row chat-list-child chat-show-all" onClick={() => setVisibleCounts((counts) => ({ ...counts, [project.id]: (counts[project.id] ?? 4) + 4 }))}><span>Load more</span></button>}</div>}

        </div>)}
        {projects.data?.length === 0 && <button className="chat-list-row" onClick={onOpenProject}><FolderPlus /><span>Add your first project</span></button>}
      </section>
      <section aria-labelledby="recent-chats-heading"><h2 id="recent-chats-heading">Recent</h2>
        {chats.isPending && <p className="chat-list-note"><LoaderCircle className="animate-spin" />Loading chats…</p>}
        {chats.error && <p className="chat-list-note">Unable to load chats. <button onClick={() => void chats.refetch()}>Retry</button></p>}
        {entries.slice(0, 30).map((entry) => chatRow(entry))}
        {!entries.length && !chats.isPending && !chats.error && <p className="chat-list-note">{needle ? "No matching chats." : "Your recent chats will appear here."}</p>}
      </section>
    </div>
  </section>;
}
