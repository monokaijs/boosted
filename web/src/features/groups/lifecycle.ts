import type { QueryClient } from '@tanstack/react-query';
import { machinePreferenceKey, useAppStore } from '@/lib/store';
import type { GroupSummary } from './types';

// Pending sends retain the token, including after unmount. Weak references let
// discarded transcripts and their attachments be collected normally.
const lifetimes = new WeakMap<QueryClient, Map<string, WeakRef<{ deleted: boolean }>>>();
export function groupLifetime(client: QueryClient, id: string) {
  let entries = lifetimes.get(client);
  if (!entries) { entries = new Map(); lifetimes.set(client, entries); }
  for (const [key, reference] of entries) if (!reference.deref()) entries.delete(key);
  let token = entries.get(id)?.deref();
  if (!token) { token = { deleted: false }; entries.set(id, new WeakRef(token)); }
  return token;
}
export function forgetGroup(client: QueryClient, id: string, machineId?: string) {
  const entries = lifetimes.get(client);
  const token = entries?.get(id)?.deref();
  if (token) token.deleted = true;
  entries?.delete(id);
  for (const name of ['draft', 'outbox', 'recipients']) {
    try { sessionStorage.removeItem(machinePreferenceKey(`boosted.group-${name}.${id}`, machineId)); } catch { /* Storage may be unavailable. */ }
  }
  try {
    const selection = machinePreferenceKey('boosted.group', machineId);
    if (localStorage.getItem(selection) === id) localStorage.removeItem(selection);
  } catch { /* Storage may be unavailable. */ }
  void client.cancelQueries({ queryKey: ['groups', id], exact: true });
  client.removeQueries({ queryKey: ['groups', id], exact: true });
  void client.cancelQueries({ queryKey: ['group-usage', id] });
  client.removeQueries({ queryKey: ['group-usage', id] });
  void client.cancelQueries({ queryKey: ['groups'], exact: true });
  client.setQueryData<GroupSummary[]>(['groups'], (groups) => groups?.filter((group) => group.id !== id));
  void client.invalidateQueries({ queryKey: ['groups'], exact: true });
  const state = useAppStore.getState();
  if (state.activeMachineId === machineId && state.selectedGroupId === id) {
    state.selectGroup(undefined);
    window.dispatchEvent(new CustomEvent('boosted:group-deleted', { detail: id }));
  }
}
