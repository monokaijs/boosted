import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { machinePreferenceKey, useAppStore } from '@/lib/store';
import { DeleteGroupDialog } from './delete-group-dialog';
import { forgetGroup, groupLifetime } from './lifecycle';

const mocks = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('@/lib/api-context', () => ({ useBoostedApiClient: () => ({ profileId: 'machine', featureRequest: mocks.request }) }));
beforeEach(() => {
  mocks.request.mockReset(); mocks.request.mockResolvedValue(undefined);
  sessionStorage.clear(); localStorage.clear();
  useAppStore.setState({ activeMachineId: 'machine', selectedGroupId: 'g' });
});
afterEach(cleanup);
function show() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(['groups'], [{ id: 'g', name: 'Team' }, { id: 'other', name: 'Other' }]);
  client.setQueryData(['groups', 'g'], { id: 'g' });
  client.setQueryData(['group-usage', 'g', 30], {});
  const closed = vi.fn();
  render(<QueryClientProvider client={client}><DeleteGroupDialog group={{ id: 'g', name: 'Team' }} open onOpenChange={closed} /></QueryClientProvider>);
  return { client, closed };
}

it('focuses cancellation and never deletes until confirmed', async () => {
  const { closed } = show();
  await waitFor(() => expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus());
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(closed).toHaveBeenCalledWith(false);
  expect(mocks.request).not.toHaveBeenCalled();
});

it('clears only deleted group state and prevents a pending send from restoring its draft', async () => {
  const { client, closed } = show();
  const token = groupLifetime(client, 'g');
  for (const name of ['draft', 'outbox', 'recipients']) sessionStorage.setItem(machinePreferenceKey(`boosted.group-${name}.g`), 'private');
  const otherKey = machinePreferenceKey('boosted.group-draft.other');
  sessionStorage.setItem(otherKey, 'Keep this');
  fireEvent.click(screen.getByRole('button', { name: 'Delete group' }));
  await waitFor(() => expect(closed).toHaveBeenCalledWith(false));
  expect(mocks.request).toHaveBeenCalledWith('/groups/g', { method: 'DELETE' });
  expect(token.deleted).toBe(true);
  expect(sessionStorage.getItem(machinePreferenceKey('boosted.group-draft.g'))).toBeNull();
  expect(sessionStorage.getItem(otherKey)).toBe('Keep this');
  expect(client.getQueryData(['groups', 'g'])).toBeUndefined();
  expect(client.getQueryData(['group-usage', 'g', 30])).toBeUndefined();
  expect(client.getQueryData(['groups'])).toEqual([{ id: 'other', name: 'Other' }]);
  expect(useAppStore.getState().selectedGroupId).toBeUndefined();
});

it('keeps saved state and allows retry after a server error', async () => {
  mocks.request.mockRejectedValueOnce(new Error('Group is stopping. Retry deletion.'));
  const { client, closed } = show();
  fireEvent.click(screen.getByRole('button', { name: 'Delete group' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Group is stopping');
  expect(closed).not.toHaveBeenCalled();
  expect(client.getQueryData(['groups', 'g'])).toEqual({ id: 'g' });
  expect(useAppStore.getState().selectedGroupId).toBe('g');
  fireEvent.click(screen.getByRole('button', { name: 'Delete group' }));
  await waitFor(() => expect(closed).toHaveBeenCalledWith(false));
});

it('does not clear a selection on a different machine when an old deletion finishes', () => {
  const { client } = show();
  const oldSelection = machinePreferenceKey('boosted.group', 'machine');
  localStorage.setItem(oldSelection, 'g');
  useAppStore.setState({ activeMachineId: 'another', selectedGroupId: 'g' });
  act(() => forgetGroup(client, 'g', 'machine'));
  expect(useAppStore.getState().selectedGroupId).toBe('g');
  expect(localStorage.getItem(oldSelection)).toBeNull();
});
