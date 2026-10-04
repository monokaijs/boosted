import { useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { LoaderCircle, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useBoostedApiClient } from '@/lib/api-context';
import { createGroupsApi } from './api';
import { forgetGroup } from './lifecycle';

export function DeleteGroupDialog({ group, open, onOpenChange }: {
  group: { id: string; name: string }; open: boolean; onOpenChange(open: boolean): void;
}) {
  const client = useBoostedApiClient();
  const groups = useMemo(() => createGroupsApi(client), [client]);
  const queries = useQueryClient();
  const cancel = useRef<HTMLButtonElement>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  async function remove() {
    setPending(true); setError(undefined);
    try {
      await groups.remove(group.id);
      forgetGroup(queries, group.id, client.profileId);
      onOpenChange(false);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Unable to delete this group.'); }
    finally { setPending(false); }
  }
  return <Dialog open={open} onOpenChange={(next) => { if (!pending) { setError(undefined); onOpenChange(next); } }}>
    <DialogContent onOpenAutoFocus={(event) => { event.preventDefault(); cancel.current?.focus(); }}>
      <DialogHeader><DialogTitle>Delete {group.name}?</DialogTitle><DialogDescription>Active work will stop. This permanently removes the group’s messages, assignments, reviews, and usage analytics. Agents, coding chats, and repository files are kept.</DialogDescription></DialogHeader>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <DialogFooter><Button ref={cancel} variant="outline" disabled={pending} onClick={() => onOpenChange(false)}>Cancel</Button><Button variant="destructive" disabled={pending} onClick={() => void remove()}>{pending ? <LoaderCircle className="animate-spin" /> : <Trash2 />}{pending ? 'Stopping and deleting…' : 'Delete group'}</Button></DialogFooter>
    </DialogContent>
  </Dialog>;
}
