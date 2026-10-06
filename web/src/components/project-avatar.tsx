import type { Project } from "@/lib/types";
import { GradientAvatar } from "@/components/gradient-avatar";

export function ProjectAvatar({ project, className }: {
  project: Pick<Project, "id" | "name">;
  className?: string;
}) {
  return <GradientAvatar seed={project.id || project.name} className={className} slot="project-avatar" />;
}
