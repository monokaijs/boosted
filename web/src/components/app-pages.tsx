import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowUpRight, CalendarClock, FolderOpen, FolderPlus, GitBranch, LoaderCircle, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { useAppStore } from "@/lib/store";
import { cn } from "@/lib/utils";

export function ProjectsPage({ onOpenProject, onSelect }: { onOpenProject(): void; onSelect(): void }) {
  const [search, setSearch] = useState("");
  const projects = useQuery({ queryKey: ["projects"], queryFn: api.projects });
  const selectedId = useAppStore((state) => state.selectedProjectId);
  const filtered = projects.data?.filter((project) => `${project.name} ${project.repoPath}`.toLowerCase().includes(search.toLowerCase()));
  return <div className="full-page-scroll"><div className="page-content">
    <header className="page-heading"><div><h1>Projects</h1><p>A home for your code and conversations.</p></div><Button variant="secondary" onClick={onOpenProject}><FolderPlus />Open project</Button></header>
    <label className="page-search"><Search /><input aria-label="Search projects" placeholder="Search projects" value={search} onChange={(event) => setSearch(event.target.value)} /></label>
    {projects.isPending && <div className="page-empty"><LoaderCircle className="animate-spin" /><p>Loading projects…</p></div>}
    {projects.error && <div className="page-empty"><p className="text-destructive">{projects.error.message}</p><Button variant="secondary" onClick={() => void projects.refetch()}>Try again</Button></div>}
    <div className="project-page-list">{filtered?.map((project) => <button key={project.id} className={cn("project-page-row", selectedId === project.id && "is-current")} onClick={() => { useAppStore.getState().selectProject(project); onSelect(); }}><span className="project-page-icon"><FolderOpen /></span><span className="project-page-copy"><strong>{project.name}</strong><small>{project.repoPath}</small><span><GitBranch />{project.defaultBranch}{selectedId === project.id && <em>Current project</em>}</span></span><ArrowUpRight /></button>)}</div>
    {filtered?.length === 0 && <div className="page-empty"><FolderOpen /><h2>{search ? "No matching projects" : "Bring your project here"}</h2><p>{search ? "Try another name or folder path." : "Open a local repository to start a conversation."}</p>{!search && <Button variant="secondary" onClick={onOpenProject}><FolderPlus />Open project</Button>}</div>}
  </div></div>;
}

export function ScheduledPage() {
  return <div className="full-page-scroll"><div className="page-content"><header className="page-heading"><div><h1>Scheduled</h1><p>A place for work that runs on your schedule.</p></div></header><div className="page-empty scheduled-empty"><span className="page-empty-icon"><CalendarClock /></span><h2>Scheduled work is coming</h2><p>Scheduling isn’t available on this server yet.<br />You can create and run work from Tasks.</p><Button variant="secondary" onClick={() => { window.location.hash = "tasks"; }}>Go to tasks</Button></div></div></div>;
}
