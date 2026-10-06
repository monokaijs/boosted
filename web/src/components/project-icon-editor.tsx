import { useRef } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { LoaderCircle, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ProjectAvatar } from "@/components/project-avatar";
import { getActiveApiClient } from "@/lib/api";
import type { Project } from "@/lib/types";
import { avatarFromFile } from "@/features/agents/lib/agent-avatar";

export function ProjectIconEditor({ project }: { project: Project }) {
  const input = useRef<HTMLInputElement>(null);
  const queryClient = useQueryClient();
  const save = useMutation({
    mutationFn: async (file: File | null) => {
      const client = getActiveApiClient();
      return client.updateProjectIcon(project.id, file ? await avatarFromFile(file) : null);
    },
    onSuccess: (saved) => {
      queryClient.setQueryData<Project[]>(["projects"], (projects) => projects?.map((entry) => entry.id === saved.id ? saved : entry));
      void queryClient.invalidateQueries({ queryKey: ["projects"] });
    },
  });
  return <div className="grid gap-2">
    <div className="flex flex-wrap items-center gap-3">
      <ProjectAvatar project={project} className="size-12 rounded-xl text-2xl" />
      <input ref={input} className="hidden" type="file" aria-label="Upload project icon" accept="image/png,image/jpeg,image/webp" disabled={save.isPending} onChange={(event) => {
        const file = event.target.files?.[0];
        event.target.value = "";
        if (file) save.mutate(file);
      }} />
      <Button type="button" size="sm" variant="secondary" disabled={save.isPending} onClick={() => input.current?.click()}>{save.isPending ? <LoaderCircle className="animate-spin" /> : <Upload />}Upload icon</Button>
      {project.icon && <Button type="button" size="sm" variant="ghost" disabled={save.isPending} onClick={() => save.mutate(null)}>Remove icon</Button>}
    </div>
    <p className="text-xs text-muted-foreground">PNG, JPEG, or WebP, up to 5 MB. Changes are saved automatically.</p>
    {save.error && <p role="alert" className="text-xs text-destructive">{save.error.message}</p>}
  </div>;
}
