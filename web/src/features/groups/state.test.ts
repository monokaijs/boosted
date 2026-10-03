import { describe, expect, it } from 'vitest';
import { acceptGroupSnapshot, mergeGroupMessages, remainingGroupOutbox, taskOverlaps } from './state';
import type { GroupMessage, GroupPendingMessage, GroupState, GroupTask } from './types';

const message = (id: string, sequence: number) => ({ id, sequence, content: id }) as GroupMessage;
describe('group state recovery', () => {
  it('rejects late snapshots and snapshots for another conversation', () => {
    const current = { id: 'a', version: 5 } as GroupState;
    expect(acceptGroupSnapshot(current, { id: 'a', version: 4 } as GroupState, 'a')).toBe(false);
    expect(acceptGroupSnapshot(current, { id: 'b', version: 6 } as GroupState, 'a')).toBe(false);
    expect(acceptGroupSnapshot(current, { id: 'a', version: 6 } as GroupState, 'a')).toBe(true);
  });
  it('merges overlapping history pages by stable identity and message order', () => {
    expect(mergeGroupMessages([message('one', 1), message('two', 2)], [message('three', 3), { ...message('two', 2), content: 'updated' }]))
      .toEqual([message('one', 1), { ...message('two', 2), content: 'updated' }, message('three', 3)]);
  });
  it('reconciles a lost send response without dropping another user’s retry', () => {
    const outbox = [{ id: 'sent' }, { id: 'pending' }] as GroupPendingMessage[];
    expect(remainingGroupOutbox([message('g:u:sent', 1)], outbox, 'u', 'g')).toEqual([{ id: 'pending' }]);
    expect(remainingGroupOutbox([message('g:other:sent', 1)], outbox, 'u', 'g')).toEqual(outbox);
  });
  it('identifies shared subtree ownership while excluding another checkout', () => {
    const tasks = [
      { id: 'a', workingDirectory: '/repo', status: 'running', fileResponsibilities: ['src'] },
      { id: 'b', workingDirectory: '/repo', status: 'running', fileResponsibilities: ['src/api.ts'] },
      { id: 'c', workingDirectory: '/other', status: 'running', fileResponsibilities: ['src'] },
      { id: 'd', workingDirectory: '/repo', status: 'completed', fileResponsibilities: ['src'] },
    ] as GroupTask[];
    expect(taskOverlaps('a', tasks).map((t) => t.id)).toEqual(['b']);
  });
});
