import type { Project } from "@/lib/types";

const normalizedPath = (path: string) => path.replace(/\\/g, "/").replace(/\/+$/, "");

export function chatProject(projects: readonly Project[], cwd: string, projectId?: string) {
  const linked = projectId ? projects.find((project) => project.id === projectId) : undefined;
  if (linked) return linked;
  const path = normalizedPath(cwd);
  return projects.filter((project) => {
    const root = normalizedPath(project.repoPath);
    return path === root || path.startsWith(`${root}/`);
  }).sort((a, b) => b.repoPath.length - a.repoPath.length)[0];
}
