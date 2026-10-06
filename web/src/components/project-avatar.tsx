import type { Project } from "@/lib/types";
import { GradientAvatar } from "@/components/gradient-avatar";
import { useState } from "react";
import { cn } from "@/lib/utils";

export function ProjectAvatar({ project, className }: {
  project: Pick<Project, "id" | "name" | "icon">;
  className?: string;
}) {
  const [failedIcon, setFailedIcon] = useState<string>();
  const initial = Array.from(project.name.trim())[0]?.toUpperCase() ?? "?";
  return <GradientAvatar seed={project.id || project.name} className={cn("relative overflow-hidden text-[10px] text-white font-semibold", className)} slot="project-avatar">
    {project.icon && project.icon !== failedIcon
      ? <img alt="" src={project.icon} className="absolute inset-0 size-full object-cover" onError={() => setFailedIcon(project.icon!)} />
      : <span className="absolute inset-0 flex items-center justify-center leading-none [text-shadow:0_1px_2px_rgb(0_0_0/0.5)]">{initial}</span>}
  </GradientAvatar>;
}
