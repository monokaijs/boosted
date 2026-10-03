import { act, cleanup, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAppStore } from '@/lib/store';

const mock = vi.hoisted(() => ({ api: { profileId: 'machine-a', webSocket: () => 'ws://localhost/api/v1/ws' }, notify: vi.fn() }));
vi.mock('@/lib/api-context', () => ({ useBoostedApiClient: () => mock.api }));
vi.mock('@/lib/api', () => ({ getToken: () => 'test-session' }));
vi.mock('@/lib/notifications', () => ({ notifyForLiveEvent: mock.notify }));
import { useLiveEvents } from '@/hooks/use-live-events';
import { useNotificationNavigation } from '@/hooks/use-notification-navigation';

class TestSocket extends EventTarget {
  static instances: TestSocket[] = [];
  send = vi.fn();
  close = vi.fn();
  constructor() { super(); TestSocket.instances.push(this); }
}
beforeEach(() => { TestSocket.instances = []; vi.stubGlobal('WebSocket', TestSocket); window.history.replaceState({}, '', '/'); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('group live integration', () => {
  it('refetches group state after websocket reconnect and group activity', async () => {
    const client = new QueryClient();
    const invalidation = vi.spyOn(client, 'invalidateQueries');
    renderHook(() => useLiveEvents(), { wrapper: ({ children }) => <QueryClientProvider client={client}>{children}</QueryClientProvider> });
    const socket = TestSocket.instances[0];
    await act(async () => { socket.dispatchEvent(new Event('open')); });
    expect(socket.send).toHaveBeenCalledWith(JSON.stringify({ type: 'authenticate', token: 'test-session' }));
    expect(invalidation).toHaveBeenCalledWith({ queryKey: ['groups'] });
    invalidation.mockClear();
    await act(async () => { socket.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ sequence: 1, topic: 'group.task', data: { groupId: 'g' } }) })); });
    expect(invalidation).toHaveBeenCalledWith({ queryKey: ['groups'] });
  });
  it('opens group notification clicks and removes notification URL parameters', async () => {
    const serviceWorker = new EventTarget();
    Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: serviceWorker });
    useAppStore.getState().activateMachine('machine-a');
    window.history.replaceState({}, '', '/?notification=group&notificationId=team');
    const events: string[] = [];
    const listener = (event: Event) => events.push((event as CustomEvent<string>).detail);
    window.addEventListener('boosted:open-group', listener);
    renderHook(() => useNotificationNavigation());
    expect(useAppStore.getState().selectedGroupId).toBe('team');
    expect(window.location.search).toBe('');
    await act(async () => { serviceWorker.dispatchEvent(new MessageEvent('message', { data: { type: 'boosted:notification-click', data: { kind: 'group', id: 'other' } } })); });
    expect(useAppStore.getState().selectedGroupId).toBe('other');
    expect(events).toEqual(['team', 'other']);
    window.removeEventListener('boosted:open-group', listener);
    Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: undefined });
  });
});
