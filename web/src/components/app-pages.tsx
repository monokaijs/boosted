import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowUpRight, CalendarClock, FolderOpen, FolderPlus, GitBranch, LoaderCircle, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ProjectAvatar } from "@/components/project-avatar";
import { ProjectIconEditor } from "@/components/project-icon-editor";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { api } from "@/lib/api";
import { useAppStore } from "@/lib/store";
import { cn } from "@/lib/utils";

export function ProjectsPage({ onOpenProject, onSelect }: { onOpenProject(): void; onSelect(): void }) {
  const [search, setSearch] = useState("");
  const [editingIconId, setEditingIconId] = useState<string>();
  const projects = useQuery({ queryKey: ["projects"], queryFn: api.projects });
  const editingProject = projects.data?.find((project) => project.id === editingIconId);
  const selectedId = useAppStore((state) => state.selectedProjectId);
  const filtered = projects.data?.filter((project) => `${project.name} ${project.repoPath}`.toLowerCase().includes(search.toLowerCase()));
  return <div className="full-page-scroll projects-page"><div className="page-content">
    <header className="page-heading"><div><h1>Projects</h1><p>A home for your code and conversations.</p></div><Button variant="secondary" onClick={onOpenProject}><FolderPlus />Open project</Button></header>
    <label className="page-search"><Search /><input aria-label="Search projects" placeholder="Search projects" value={search} onChange={(event) => setSearch(event.target.value)} /></label>
    {projects.isPending && <div className="page-empty"><LoaderCircle className="animate-spin" /><p>Loading projects…</p></div>}
    {projects.error && <div className="page-empty"><p className="text-destructive">{projects.error.message}</p><Button variant="secondary" onClick={() => void projects.refetch()}>Try again</Button></div>}
    <div className="project-page-list">{filtered?.map((project) => <div key={project.id} className={cn("project-page-row", selectedId === project.id && "is-current")}>
      <button type="button" className="shrink-0 rounded-xl outline-offset-4 focus-visible:outline-2 focus-visible:outline-ring" aria-label={`Customize icon for ${project.name}`} title="Customize project icon" onClick={() => setEditingIconId(project.id)}>
        <ProjectAvatar project={project} className="project-page-icon" />
      </button>
      <button type="button" className="flex min-w-0 flex-1 items-center gap-4 text-left" onClick={() => { useAppStore.getState().selectProject(project); onSelect(); }}>
        <span className="project-page-copy">
          <strong>{project.name}</strong><small title={project.repoPath}>{project.repoPath}</small>
          <span><span className="project-page-branch"><GitBranch /><span title={project.defaultBranch}>{project.defaultBranch}</span></span>{selectedId === project.id && <em>Current project</em>}</span>
        </span>
        <ArrowUpRight className="size-4 shrink-0 text-muted-foreground" />
      </button>
    </div>)}</div>
    {filtered?.length === 0 && <div className="page-empty"><FolderOpen /><h2>{search ? "No matching projects" : "Bring your project here"}</h2><p>{search ? "Try another name or folder path." : "Open a local repository to start a conversation."}</p>{!search && <Button variant="secondary" onClick={onOpenProject}><FolderPlus />Open project</Button>}</div>}
    <Dialog open={Boolean(editingProject)} onOpenChange={(open) => { if (!open) setEditingIconId(undefined); }}>
      <DialogContent>
        <DialogHeader><DialogTitle>Project icon</DialogTitle><DialogDescription>{editingProject?.name}</DialogDescription></DialogHeader>
        {editingProject && <ProjectIconEditor key={editingProject.id} project={editingProject} />}
      </DialogContent>
    </Dialog>
  </div></div>;
}

export function ScheduledPage() {
  return <div className="full-page-scroll"><div className="page-content"><header className="page-heading"><div><h1>Scheduled</h1><p>A place for work that runs on your schedule.</p></div></header><div className="page-empty scheduled-empty"><span className="page-empty-icon"><CalendarClock /></span><h2>Scheduled work is coming</h2><p>Scheduling isn’t available on this server yet.<br />You can create and run work from Tasks.</p><Button variant="secondary" onClick={() => { window.location.hash = "tasks"; }}>Go to tasks</Button></div></div></div>;
}
