import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Files, GitBranch, LoaderCircle, MessagesSquare, Plus, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { FilesPanel } from "@/components/panels/files-panel";
import { GitPanel } from "@/components/panels/git-panel";
import { api } from "@/lib/api";
import { chatProject } from "@/lib/chat-project";
import { chatActivity } from "@/lib/codex-chat-status";
import { useAppStore } from "@/lib/store";
import { cn } from "@/lib/utils";

export type ProjectView = "all" | "tasks" | "chat" | "editor";
export type ProjectPanelView = "chats" | "files" | "git";

const panels = [
  { id: "chats", label: "Chats", icon: MessagesSquare },
  { id: "files", label: "Files", icon: Files },
  { id: "git", label: "Changes", icon: GitBranch },
] as const;

export function ProjectNavigation({ view, panel, onPanel, onNewChat }: {
  view: ProjectView;
  panel: ProjectPanelView;
  onPanel(panel: ProjectPanelView): void;
  onNewChat(): void;
}) {
  const [search, setSearch] = useState("");
  const projectId = useAppStore((state) => state.selectedProjectId);
  const chatId = useAppStore((state) => state.selectedCodexChatId);
  const projects = useQuery({ queryKey: ["projects"], queryFn: api.projects });
  const project = projects.data?.find((entry) => entry.id === projectId);
  const chats = useQuery({
    queryKey: ["codex-chats", project?.repoPath ?? "project:none"],
    queryFn: () => api.codexChats(project!.repoPath),
    enabled: panel === "chats" && Boolean(project),
    refetchInterval: 5_000,
  });
  const needle = search.trim().toLowerCase();
  const projectChats = project && Array.from(new Map((chats.data ?? [])
    .filter((chat) => chatProject(projects.data ?? [], chat.cwd, chat.projectId)?.id === project.id)
    .filter((chat) => !needle || `${chat.title} ${chat.preview}`.toLowerCase().includes(needle))
    .map((chat) => [chat.id, chat])).values());

  return <section className="chat-list immersive-panel project-navigation" aria-label="Project navigation">
    <nav className="project-navigation-tabs" aria-label="Project panels" role="tablist">
      {panels.map(({ id, label, icon: Icon }) => <button key={id} role="tab" aria-selected={panel === id} onClick={() => onPanel(id)}><Icon /><span>{label}</span></button>)}
    </nav>
    {!project && <p className="chat-list-note">Select a project to see its chats, files, and changes.</p>}
    {project && panel === "chats" && <section className="project-conversations" aria-label="Project conversations">
      <div className="project-chat-toolbar">
        <label className="project-chat-search"><Search /><input aria-label="Search project chats" placeholder="Search chats" value={search} onChange={(event) => setSearch(event.target.value)} /></label>
        <Button variant="ghost" size="icon-sm" aria-label="New project chat" title="New project chat" onClick={onNewChat}><Plus /></Button>
      </div>
      <div className="chat-list-scroll">
        {chats.isPending && <p className="chat-list-note">Loading chats…</p>}
        {chats.error && <p role="alert" className="chat-list-note">Unable to load chats. <button onClick={() => void chats.refetch()}>Retry</button></p>}
        {projectChats?.map((chat) => <button key={chat.id} className={cn("chat-list-row", view === "chat" && chatId === chat.id && "is-selected")} aria-current={view === "chat" && chatId === chat.id ? "page" : undefined} onClick={() => window.dispatchEvent(new CustomEvent("boosted:open-codex-chat", { detail: { threadId: chat.id } }))}><MessagesSquare /><span>{chat.title}</span>{chatActivity(chat.status) === "running" && <LoaderCircle className="chat-status chat-status-running" aria-label="Running" />}</button>)}
        {!chats.isPending && !chats.error && projectChats?.length === 0 && <p className="chat-list-note">{needle ? "No matching chats." : "No chats in this project yet."}</p>}
      </div>
    </section>}
    {project && panel === "files" && <div className="project-navigation-tool"><FilesPanel key={project.id} /></div>}
    {project && panel === "git" && <div className="project-navigation-tool"><GitPanel key={project.id} /></div>}
  </section>;
}
