import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { GitBranch, LoaderCircle, Pencil, Plus, Trash2 } from "lucide-react";
import { api } from "@/lib/api";
import type { GitlabConnection } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SettingsSection } from "@/components/settings-primitives";

export function GitlabConnectionsSettings() {
  const queryClient = useQueryClient();
  const connections = useQuery({ queryKey: ["gitlab-connections"], queryFn: api.gitlabConnections });
  const [editing, setEditing] = useState<string>();
  const [draft, setDraft] = useState<Omit<GitlabConnection, "id">>();
  const save = useMutation({
    mutationFn: () => editing ? api.updateGitlabConnection(editing, draft!) : api.createGitlabConnection(draft!),
    onSuccess: () => { setDraft(undefined); setEditing(undefined); void queryClient.invalidateQueries({ queryKey: ["gitlab-connections"] }); },
  });
  const remove = useMutation({ mutationFn: api.deleteGitlabConnection, onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["gitlab-connections"] }) });
  function edit(connection?: GitlabConnection) {
    save.reset();
    setEditing(connection?.id);
    setDraft(connection ? { name: connection.name, baseUrl: connection.baseUrl, token: connection.token } : { name: "GitLab", baseUrl: "https://gitlab.com", token: "" });
  }
  return <div className="settings-content">
    <SettingsSection title="GitLab connections" description="Set up an account once for this machine. In each project’s General settings, choose the GitLab groups or projects to import into that project’s taskboard.">
      <div className="grid gap-2">
        {connections.isLoading && <p className="settings-note">Loading connections…</p>}
        {connections.data?.map((connection) => <div key={connection.id} className="settings-integration-row">
          <GitBranch className="size-4 shrink-0" /><div className="min-w-0 flex-1"><p className="text-xs font-medium">{connection.name}</p><p className="mt-1 truncate text-[11px] text-muted-foreground">{connection.baseUrl}</p></div>
          <Button variant="ghost" size="icon-sm" title={`Edit ${connection.name}`} disabled={save.isPending} onClick={() => edit(connection)}><Pencil /></Button>
          <Button variant="ghost" size="icon-sm" title={`Remove ${connection.name}`} disabled={remove.isPending || save.isPending || editing === connection.id} onClick={() => remove.mutate(connection.id)}><Trash2 /></Button>
        </div>)}
        {connections.data?.length === 0 && <p className="settings-empty">No GitLab connections configured.</p>}
        {connections.error && <p role="alert" className="settings-error">{connections.error.message}</p>}
        {remove.error && <p role="alert" className="settings-error">{remove.error.message}</p>}
        <Button className="justify-self-start" variant="secondary" size="sm" disabled={save.isPending} onClick={() => edit()}><Plus />Add GitLab connection</Button>
      </div>
    </SettingsSection>
    {draft && <SettingsSection title={editing ? "Edit GitLab connection" : "Add GitLab connection"}>
      <form className="settings-card grid gap-4" onSubmit={(event) => { event.preventDefault(); if (!save.isPending && draft.name.trim() && draft.baseUrl.trim() && draft.token.trim()) save.mutate(); }}>
        <label className="grid gap-1.5"><span className="settings-label">Connection name</span><Input value={draft.name} required onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></label>
        <label className="grid gap-1.5"><span className="settings-label">GitLab URL</span><Input value={draft.baseUrl} required onChange={(event) => setDraft({ ...draft, baseUrl: event.target.value })} /></label>
        <label className="grid gap-1.5"><span className="settings-label">Access token</span><Input type="password" value={draft.token} required onChange={(event) => setDraft({ ...draft, token: event.target.value })} /></label>
        {save.error && <p role="alert" className="settings-error">{save.error.message}</p>}
        <div className="flex justify-end gap-2"><Button type="button" variant="ghost" disabled={save.isPending} onClick={() => setDraft(undefined)}>Cancel</Button><Button disabled={save.isPending || !draft.name.trim() || !draft.baseUrl.trim() || !draft.token.trim()}>{save.isPending && <LoaderCircle className="animate-spin" />}Save connection</Button></div>
      </form>
    </SettingsSection>}
  </div>;
}
