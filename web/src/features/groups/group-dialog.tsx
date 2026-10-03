import { useEffect, useId, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useBoostedApiClient } from '@/lib/api-context';
import { apiClient } from '@/features/agents/lib/api-client';
import { AgentAvatar } from '@/features/agents/components/session/agent-avatar';
import { Button } from '@/components/ui/button';
import { MultiSelect, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { createGroupsApi } from './api';
import { defaultGroupRoles, groupRoleDescriptions, groupRoleLabels, memberRoleNames, withMemberRoles } from './roles';
import type { GroupMemberRole, GroupRole, GroupState } from './types';

export function GroupDialog({ open, onOpenChange, initial, onCreated }: {
  open: boolean; onOpenChange(open: boolean): void; initial?: GroupState; onCreated?(group: GroupState): void;
}) {
  const client = useBoostedApiClient();
  const groups = useMemo(() => createGroupsApi(client), [client]);
  const queryClient = useQueryClient();
  const agents = useQuery({ queryKey: ['agents'], queryFn: apiClient.assistant.list, enabled: open });
  const projects = useQuery({ queryKey: ['projects'], queryFn: client.projects, enabled: open });
  const [name, setName] = useState('');
  const [memberIds, setMemberIds] = useState<string[]>([]);
  const [memberRoles, setMemberRoles] = useState<Record<string, GroupMemberRole>>({});
  const [projectId, setProjectId] = useState('');
  const projectSelectId = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => {
    if (open) { setName(initial?.name ?? ''); setMemberIds(initial?.memberIds ?? []); setMemberRoles(defaultGroupRoles(initial?.memberIds ?? [], initial?.memberRoles)); setProjectId(initial?.projectId ?? ''); setError(undefined); }
  }, [open, initial?.id]);
  async function save() {
    setBusy(true); setError(undefined);
    try {
      const group = initial ? await groups.update(initial.id, { name, memberIds, memberRoles, projectId: projectId || null }) : await groups.create({ name, memberIds, memberRoles, ...(projectId ? { projectId } : {}) });
      await queryClient.invalidateQueries({ queryKey: ['groups'] });
      onOpenChange(false); onCreated?.(group);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Unable to save group.'); }
    finally { setBusy(false); }
  }
  const hasCoordinator = memberIds.filter((id) => memberRoles[id] && memberRoleNames(memberRoles[id]).includes('coordinator')).length === 1;
  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent className="group-editor flex gap-0 overflow-clip p-0"><form className="group-editor-form" onSubmit={(event) => { event.preventDefault(); if (hasCoordinator) void save(); }}>
    <DialogHeader className="group-editor-header"><DialogTitle>{initial ? 'Edit group' : 'New group'}</DialogTitle><DialogDescription>Choose a leader to manage the group, then give each participant a role.</DialogDescription></DialogHeader>
    <div className="group-editor-body">
    <label className="group-field">Name<input autoFocus required maxLength={120} value={name} disabled={busy} onChange={(event) => setName(event.target.value)} /></label>
    <fieldset className="group-roster"><legend>Participants</legend>{(agents.data ?? initial?.members)?.map((agent) => {
      const selected = memberIds.includes(agent.id);
      const role = memberRoles[agent.id];
      return <div key={agent.id} className="group-member-item">
        <div className="group-member-row">
          <label className="group-roster-member">
            <input type="checkbox" checked={selected} disabled={busy} onChange={(event) => {
              const next = event.target.checked ? [...memberIds, agent.id] : memberIds.filter((id) => id !== agent.id);
              setMemberIds(next); setMemberRoles(defaultGroupRoles(next, memberRoles));
            }} />
            <AgentAvatar name={agent.profile.name} avatar={agent.profile.avatar} className="size-7" /><span>{agent.profile.name}</span>
          </label>
          <MultiSelect value={role ? memberRoleNames(role) : []} minSelected={1} disabled={busy || !selected} ariaLabel={agent.profile.name + ' role'} className="group-member-role-select" options={Object.entries(groupRoleLabels).map(([value,label]) => ({value,label}))} onValueChange={(values) => {
            const nextRoles = values as GroupRole[];
            setMemberRoles((previous) => Object.fromEntries(Object.entries(previous).map(([peer, value]) => [peer,
              peer === agent.id ? withMemberRoles(value, nextRoles) : nextRoles.includes('coordinator') && memberRoleNames(value).includes('coordinator') ? withMemberRoles(value, memberRoleNames(value).filter((role) => role !== 'coordinator').length ? memberRoleNames(value).filter((role) => role !== 'coordinator') : ['developer']) : value,
            ])));
          }} />
        </div>
        {selected && role && <div className="group-member-scope">
          <p className="text-xs text-muted-foreground">{memberRoleNames(role).map((value) => groupRoleDescriptions[value]).join(' ')}</p>
          <label className="group-field">{agent.profile.name} responsibilities
            <textarea maxLength={4000} rows={2} placeholder="Optional: specific scope, such as backend APIs or frontend components" value={role.responsibilities} disabled={busy} onChange={(event) => setMemberRoles((previous) => ({ ...previous, [agent.id]: { ...previous[agent.id], responsibilities: event.target.value } }))} />
          </label>
        </div>}
      </div>;
    })}{agents.data && agents.data.length < 2 && <p>Create another agent before creating a group.</p>}{memberIds.length > 0 && !hasCoordinator && <p role="status" className="text-xs text-destructive">Choose one leader to organize the group’s work.</p>}</fieldset>
    <div className="group-field"><label htmlFor={projectSelectId}>Project</label>
      <Select value={projectId || '__no_project__'} disabled={busy} onValueChange={(value) => setProjectId(value === '__no_project__' ? '' : value)}>
        <SelectTrigger id={projectSelectId}><SelectValue /></SelectTrigger>
        <SelectContent><SelectItem value="__no_project__">No project</SelectItem>{projects.data?.map((project) => <SelectItem key={project.id} value={project.id}>{project.name}</SelectItem>)}</SelectContent>
      </Select>
    </div>
    {(error || agents.error || projects.error) && <p role="alert" className="text-sm text-destructive">{error ?? agents.error?.message ?? projects.error?.message}</p>}
    </div>
    <DialogFooter><Button type="button" variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>Cancel</Button><Button type="submit" disabled={busy || !name.trim() || memberIds.length < 2 || !hasCoordinator}>{busy ? 'Saving…' : initial ? 'Save group' : 'Create group'}</Button></DialogFooter>
  </form></DialogContent></Dialog>;
}
