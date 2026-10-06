import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, Files, FolderPlus, GitBranch, ListTodo, LoaderCircle, MessageSquarePlus, MessagesSquare, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ProjectAvatar } from "@/components/project-avatar";
import { api } from "@/lib/api";
import { chatProject } from "@/lib/chat-project";
import { chatActivity } from "@/lib/codex-chat-status";
import { useAppStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import type { Project } from "@/lib/types";

export type ProjectView = "all" | "tasks" | "chat" | "files" | "git" | "editor";
export function ProjectNavigation({ view, onView, onSelect, onOpenProject, onNewChat }: {
  view: ProjectView; onView(view: ProjectView): void; onSelect(project: Project): void;
  onOpenProject(): void; onNewChat(): void;
}) {
  const [search, setSearch] = useState("");
  const projectId = useAppStore((state) => state.selectedProjectId);
  const chatId = useAppStore((state) => state.selectedCodexChatId);
  const projects = useQuery({ queryKey: ["projects"], queryFn: api.projects });
  const tasks = useQuery({ queryKey: ["tasks", projectId], queryFn: () => api.tasks(projectId!), enabled: Boolean(projectId), refetchInterval: 5_000 });
  const chats = useQuery({ queryKey: ["codex-chats", "all"], queryFn: () => api.codexChats(""), refetchInterval: 5_000 });
  const project = projects.data?.find((entry) => entry.id === projectId);
  const projectChats = chats.data?.filter((chat) => chatProject(projects.data ?? [], chat.cwd, chat.projectId)?.id === projectId);
  const active = tasks.data?.filter((task) => ["planning", "running"].includes(task.status)).length ?? 0;
  const waiting = tasks.data?.filter((task) => task.status === "needs_input").length ?? 0;
  return <section className="chat-list immersive-panel project-navigation" aria-label="Project navigation">
    <header className="chat-list-header"><button className="chat-list-row chat-new" onClick={() => onView("all")} aria-current={view === "all" ? "page" : undefined}><ArrowLeft /><span>All projects</span></button><Button variant="ghost" size="icon-sm" aria-label="Open project" onClick={onOpenProject}><FolderPlus /></Button></header>
    <label className="chat-search"><Search /><input aria-label="Find a project" placeholder="Find a project" value={search} onChange={(event) => setSearch(event.target.value)} /></label>
    <div className="chat-list-scroll">
      <section aria-label="Project folders"><h2>Projects</h2>
        {projects.isPending && <p className="chat-list-note">Loading projects…</p>}
        {projects.error && <p role="alert" className="chat-list-note">Unable to load projects. <button onClick={() => void projects.refetch()}>Retry</button></p>}
        {projects.data?.filter((entry) => `${entry.name} ${entry.repoPath}`.toLowerCase().includes(search.toLowerCase())).map((entry) => <button key={entry.id} className={cn("chat-list-row", view !== "all" && projectId === entry.id && "is-selected")} aria-current={view !== "all" && projectId === entry.id ? "page" : undefined} onClick={() => onSelect(entry)}><ProjectAvatar project={entry} /><span>{entry.name}</span></button>)}
        {projects.data?.length === 0 && <button className="chat-list-row" onClick={onOpenProject}><FolderPlus /><span>Add your first project</span></button>}
      </section>
      {project && view !== "all" && <>
        <section className="project-observation" aria-label={`${project.name} overview`}>
          <h2>{project.name}</h2><p title={project.repoPath}>{project.repoPath}</p>
          <div><span><strong>{tasks.data?.length ?? "—"}</strong>Tasks</span><span><strong>{active}</strong>Active</span><span><strong>{waiting}</strong>Need input</span></div>
        </section>
        <nav aria-label="Project sections">
          {([{ id: "tasks", label: "Tasks", icon: ListTodo }, { id: "files", label: "Files", icon: Files }, { id: "git", label: "Changes", icon: GitBranch }] as const).map(({ id, label, icon: Icon }) => <button key={id} className={cn("chat-list-row", view === id && "is-selected")} aria-current={view === id ? "page" : undefined} onClick={() => onView(id)}><Icon /><span>{label}</span></button>)}
        </nav>
        <section aria-label="Project conversations"><h2>Chats</h2>
          <button className="chat-list-row" onClick={onNewChat}><MessageSquarePlus /><span>New project chat</span></button>
          {chats.isPending && <p className="chat-list-note">Loading chats…</p>}
          {chats.error && <p role="alert" className="chat-list-note">Unable to load chats. <button onClick={() => void chats.refetch()}>Retry</button></p>}
          {tasks.error && <p role="alert" className="chat-list-note">Unable to load tasks. <button onClick={() => void tasks.refetch()}>Retry</button></p>}
          {projectChats?.map((chat) => <button key={chat.id} className={cn("chat-list-row", view === "chat" && chatId === chat.id && "is-selected")} aria-current={view === "chat" && chatId === chat.id ? "page" : undefined} onClick={() => window.dispatchEvent(new CustomEvent("boosted:open-codex-chat", { detail: { threadId: chat.id } }))}><MessagesSquare /><span>{chat.title}</span>{chatActivity(chat.status) === "running" && <LoaderCircle className="chat-status chat-status-running" aria-label="Running" />}</button>)}
          {projectChats?.length === 0 && <p className="chat-list-note">Chats started from your tasks appear here.</p>}
        </section>
      </>}
    </div>
  </section>;
}
