import type { GroupMessage, GroupPendingMessage, GroupState } from './types';

export function acceptGroupSnapshot(current: GroupState | undefined, next: GroupState, groupId: string) {
  return next.id === groupId && (!current || current.id !== groupId || next.version >= current.version);
}
export function mergeGroupMessages(older: GroupMessage[], latest: GroupMessage[]) {
  const byId = new Map(older.map((message) => [message.id, message]));
  for (const message of latest) byId.set(message.id, message);
  return [...byId.values()].sort((a, b) => a.sequence - b.sequence);
}
export function remainingGroupOutbox(messages: GroupMessage[], outbox: GroupPendingMessage[], userId: string, groupId: string) {
  const saved = new Set(messages.map((message) => message.id));
  return outbox.filter((message) => !saved.has(groupId + ':' + userId + ':' + message.id));
}
export function taskOverlaps(taskId: string, tasks: GroupState['tasks']) {
  const own = tasks.find((task) => task.id === taskId);
  if (!own) return [];
  const normalized = (path: string) => path.replace(/\\/g, '/').replace(/\/+$/, '');
  return tasks.filter((task) => task.id !== taskId && task.workingDirectory === own.workingDirectory
    && !['completed', 'cancelled'].includes(task.status) && task.fileResponsibilities.some((b) => own.fileResponsibilities.some((a) => {
      const left = normalized(a); const right = normalized(b);
      return left === right || left.startsWith(right + '/') || right.startsWith(left + '/');
    })));
}
