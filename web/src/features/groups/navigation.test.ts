import { describe, expect, it } from 'vitest';
import { useAppStore, machinePreferenceKey } from '@/lib/store';
import { buildNotificationForEvent, notificationEventId } from '@/lib/notifications';
import type { BoostedApiClient } from '@/lib/api';

describe('group navigation and notifications', () => {
  it('keeps selections and drafts scoped to the selected machine', () => {
    const store = useAppStore.getState();
    store.activateMachine('one'); store.selectGroup('team');
    const one = machinePreferenceKey('draft');
    useAppStore.getState().activateMachine('two');
    expect(useAppStore.getState().selectedGroupId).toBeUndefined();
    expect(machinePreferenceKey('draft')).not.toBe(one);
    useAppStore.getState().activateMachine('one');
    expect(useAppStore.getState().selectedGroupId).toBe('team');
    useAppStore.getState().selectCodexChat('chat');
    expect(useAppStore.getState().selectedGroupId).toBeUndefined();
  });
  it('only notifies for human attention and links to the group', async () => {
    expect(notificationEventId({ sequence: 1, topic: 'group.message', data: {} })).toBeUndefined();
    const event = { sequence: 2, topic: 'group.attention', data: { id: 'm', groupId: 'g', senderName: 'Nova', content: 'Need a decision' } };
    const notification = await buildNotificationForEvent(event, { profileId: 'machine' } as BoostedApiClient);
    expect(notification).toMatchObject({ event: 'agentMessage', title: 'Nova', data: { kind: 'group', id: 'g', url: '/?notification=group&notificationId=g' } });
  });
});
