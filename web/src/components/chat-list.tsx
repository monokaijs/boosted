import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, CircleAlert, Folder, FolderOpen, FolderPlus, LoaderCircle, MessageSquarePlus, Pin, Plus, Search, Trash2, Ellipsis, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { useAppStore } from "@/lib/store";
import { useWorkspaceState } from "@/lib/workspace-state";
import { chatActivity } from "@/lib/codex-chat-status";
import { useBoostedApiClient } from "@/lib/api-context";
import { createGroupsApi } from "@/features/groups/api";
import { DeleteGroupDialog } from "@/features/groups/delete-group-dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { GroupDialog } from "@/features/groups/group-dialog";
import { AgentAvatar } from "@/features/agents/components/session/agent-avatar";
import type { AssistantSummary } from "@/features/agents/types/assistant";
import { Separator } from "@/components/ui/separator";
import "@/features/groups/groups.css";
import { cn } from "@/lib/utils";
import type { CodexChat, Project } from "@/lib/types";

type ProjectChat = { chat: CodexChat; project?: Project };
const normalizedPath = (path: string) => path.replace(/\\/g, "/").replace(/\/+$/, "");

export function ChatList({ agents, activeAgentId, activeGroupId, activeChatId, onSelectAgent, onCreateAgent, onNewChat, onOpenProject, onClose }: {
  agents: readonly AssistantSummary[];
  activeAgentId?: string;
  activeGroupId?: string;
  activeChatId?: string;
  onSelectAgent(id: string): void;
  onCreateAgent(): void;
  onNewChat(): void;
  onOpenProject(): void;
  onClose(): void;
}) {
  const client = useBoostedApiClient();
  const groupApi = useMemo(() => createGroupsApi(client), [client]);
  const rooms = useQuery({ queryKey: ["groups"], queryFn: groupApi.list, refetchInterval: 15000 });
  const agentsById = new Map(agents.map((agent) => [agent.id, agent]));
  const [deletingGroup, setDeletingGroup] = useState<{ id: string; name: string }>();
  const [creatingGroup, setCreatingGroup] = useState(false);
  const [search, setSearch] = useWorkspaceState("chat-list:search", "");
  const [expanded, setExpanded] = useWorkspaceState<Set<string>>("chat-list:expanded", () => new Set());
  const [visibleCounts, setVisibleCounts] = useWorkspaceState<Record<string, number>>("chat-list:visibleCounts", {});
  const [searchOpen, setSearchOpen] = useWorkspaceState("chat-list:searchOpen", false);
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
    <header className="chat-list-header"><button className="chat-list-row chat-new" aria-label="New chat" onClick={onNewChat}><MessageSquarePlus /><span>New chat</span><kbd>⌘ N</kbd></button><Button variant="ghost" size="icon-sm" aria-label="Search chats" aria-expanded={searchOpen} onClick={() => { if (searchOpen) setSearch(""); setSearchOpen(!searchOpen); }}><Search /></Button><Button variant="ghost" size="icon-sm" aria-label="Open project" onClick={onOpenProject}><FolderPlus /></Button></header>
    {searchOpen && <label className="chat-search"><Search /><input autoFocus aria-label="Search chats" placeholder="Search chats" value={search} onChange={(event) => setSearch(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape") { setSearch(""); setSearchOpen(false); } }} /><button aria-label="Close search" onClick={() => { setSearch(""); setSearchOpen(false); }}><X /></button></label>}
    <div className="chat-list-scroll">
      <>
        <nav className="chat-list-agents" aria-label="Agents">
          <div className="chat-agents-heading"><h2>Agents</h2><Button variant="ghost" size="icon-sm" aria-label="New agent" title="New agent" onClick={() => { onCreateAgent(); onClose(); }}><Plus /></Button></div>
          {agents.filter((agent) => !needle || agent.profile.name.toLowerCase().includes(needle)).map((agent) => <button key={agent.id} type="button" className={cn("chat-list-row chat-agent-row", activeAgentId === agent.id && "is-selected")} aria-current={activeAgentId === agent.id ? "page" : undefined} onClick={() => { onSelectAgent(agent.id); onClose(); }}>
            <AgentAvatar name={agent.profile.name} avatar={agent.profile.avatar} className="size-6 text-[10px]" /><span>{agent.profile.name}</span>
          </button>)}
        </nav>
        <Separator className="chat-agents-divider" decorative={false} />
      </>
      <section aria-labelledby="group-chats-heading"><h2 id="group-chats-heading">Groups</h2>
        <button className="chat-list-row chat-new" onClick={() => setCreatingGroup(true)}><MessageSquarePlus /><span>New group</span></button>
        {rooms.data?.filter((room) => !needle || room.name.toLowerCase().includes(needle)).map((room) => {
          const members = room.memberIds.map((id) => agentsById.get(id) ?? { id, profile: { name: id, avatar: undefined } });
          const memberNames = members.map((member) => member.profile.name).join(", ");
          return <div key={room.id} className="chat-group-row"><button aria-label={room.name} className={cn("chat-list-row", activeGroupId === room.id && "is-selected")} aria-current={activeGroupId === room.id ? "true" : undefined} onClick={() => { useAppStore.getState().selectGroup(room.id); window.dispatchEvent(new CustomEvent("boosted:open-group", { detail: room.id })); onClose(); }}>
            <span>{room.name}</span>
            {room.stopped && <CircleAlert aria-label="Stopped" className="chat-status" />}
            {!!members.length && <span className="chat-group-avatars" role="img" aria-label={`Participants: ${memberNames}`} title={memberNames}>
              {members.slice(0, 4).map((member) => <AgentAvatar key={member.id} name={member.profile.name} avatar={member.profile.avatar} className="size-6 text-[10px]" />)}
              {members.length > 4 && <span className="chat-group-avatar-count">+{members.length - 4}</span>}
            </span>}
          </button><DropdownMenu><DropdownMenuTrigger asChild><Button variant="ghost" size="icon-sm" aria-label={`Options for ${room.name}`}><Ellipsis /></Button></DropdownMenuTrigger><DropdownMenuContent align="end"><DropdownMenuItem className="text-destructive" onSelect={() => setDeletingGroup(room)}><Trash2 className="size-4" />Delete group</DropdownMenuItem></DropdownMenuContent></DropdownMenu></div>;
        })}
        {rooms.error && <p className="chat-list-note text-destructive">{rooms.error.message}<button onClick={() => void rooms.refetch()}>Retry</button></p>}
      </section>
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
    {deletingGroup && <DeleteGroupDialog group={deletingGroup} open onOpenChange={(open) => { if (!open) setDeletingGroup(undefined); }} />}
    <GroupDialog open={creatingGroup} onOpenChange={setCreatingGroup} onCreated={(room) => { useAppStore.getState().selectGroup(room.id); window.dispatchEvent(new CustomEvent("boosted:open-group", { detail: room.id })); onClose(); }} />
  </section>;
}
