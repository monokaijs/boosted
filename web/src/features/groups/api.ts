import type { BoostedApiClient } from '@/lib/api';
import type { GroupMemberRole, GroupMessage, GroupSendRequest, GroupState, GroupSummary, GroupTask, GroupTaskCreate } from './types';

export function createGroupsApi(client: BoostedApiClient) {
  const path = (id: string) => '/groups/' + encodeURIComponent(id);
  const request = <T,>(url: string, method = 'GET', body?: unknown) => client.featureRequest<T>(url, {
    method, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return {
    list: () => request<GroupSummary[]>('/groups'),
    create: (body: { name: string; memberIds: string[]; memberRoles: Record<string, GroupMemberRole>; projectId?: string }) => request<GroupState>('/groups', 'POST', body),
    read: (id: string) => request<GroupState>(path(id)),
    update: (id: string, body: { projectId?: string | null; name: string; memberIds: string[]; memberRoles: Record<string, GroupMemberRole> }) => request<GroupState>(path(id), 'PATCH', body),
    send: (id: string, body: GroupSendRequest) => request<GroupMessage>(path(id) + '/messages', 'POST', body),
    messages: (id: string, before: number) => request<GroupMessage[]>(path(id) + '/messages?before=' + before),
    stop: (id: string) => request<GroupState>(path(id) + '/stop', 'POST'),
    resume: (id: string) => request<GroupState>(path(id) + '/resume', 'POST'),
    createTask: (id: string, body: GroupTaskCreate) => request<GroupTask>(path(id) + '/tasks', 'POST', body),
    updateTask: (id: string, taskId: string, body: Partial<GroupTaskCreate>) => request<GroupTask>(path(id) + '/tasks/' + encodeURIComponent(taskId), 'PATCH', body),
    taskAction: (id: string, taskId: string, action: 'cancel' | 'retry') => request<GroupTask>(path(id) + '/tasks/' + encodeURIComponent(taskId) + '/' + action, 'POST'),
  };
}
