import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAppStore } from '@/lib/store';
import { ApiError } from '@/lib/api';
import type { GroupState } from './types';

const mocks = vi.hoisted(() => ({ featureRequest: vi.fn(), projects: vi.fn(), listAgents: vi.fn() }));
vi.mock('@/lib/api-context', () => ({ useBoostedApiClient: () => ({ profileId: 'machine-a', featureRequest: mocks.featureRequest, projects: mocks.projects }) }));
vi.mock('@/features/agents/lib/api-client', () => ({ apiClient: { assistant: { list: mocks.listAgents } } }));
vi.mock('@/components/panels/codex-chat-panel', () => ({ CodexChatPanel: ({ threadId, onThreadChange }: { threadId: string; onThreadChange?: (id: string) => void }) => <><p>Coding conversation {threadId}</p><button onClick={() => onThreadChange?.('replacement-chat')}>Replace coding thread</button></> }));
import { GroupPanel } from './group-panel';
import { GroupDialog } from './group-dialog';

const base: GroupState = {
  id: 'g', name: 'Team', memberIds: ['a', 'b'], projectId: null, workingDirectory: null, stopped: false,
  memberRoles: { a: { role: 'coordinator', roles: ['coordinator'], responsibilities: '' }, b: { role: 'developer', roles: ['developer'], responsibilities: '' } },
  createdBy: 'u', initialGitState: null,
  stopReason: null, version: 1, createdAt: '2026-10-04T00:00:00Z', updatedAt: '2026-10-04T00:00:00Z',
  members: [{ id: 'a', profile: { name: 'Nova', personality: '' }, accountId: null }, { id: 'b', profile: { name: 'Pock', personality: '' }, accountId: null }],
  messageCount: 0, messages: [], deliveries: [], tasks: [], reviews: [], executions: [], receipts: [], requests: [],
};
function renderWithQuery(node: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
  return { ...view, client };
}
async function toggleRole(agent: string, role: string) {
  fireEvent.pointerDown(screen.getByRole('button', { name: agent + ' role' }), { button: 0, ctrlKey: false });
  fireEvent.click(await screen.findByRole('menuitemcheckbox', { name: role }));
  fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
}
beforeEach(() => {
  vi.clearAllMocks(); sessionStorage.clear();
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
  useAppStore.setState({ activeMachineId: 'machine-a', selectedGroupId: undefined, user: { id: 'u', username: 'User', role: 'admin', mustChangePassword: false, disabled: false, createdAt: 'now' } });
  mocks.featureRequest.mockImplementation((path: string) => path === '/groups/g' ? Promise.resolve(base) : Promise.resolve({}));
  mocks.projects.mockResolvedValue([]);
  mocks.listAgents.mockResolvedValue(base.members);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('group conversations', () => {
  it('uses the assigned project avatar for the group', async () => {
    const icon = 'data:image/png;base64,iVBORw0KGgo=';
    mocks.projects.mockResolvedValue([{ id: 'project', name: 'Project', icon }]);
    mocks.featureRequest.mockResolvedValue({ ...base, projectId: 'project' });
    const { container } = renderWithQuery(<GroupPanel groupId="g" />);
    await screen.findByRole('heading', { name: 'Team' });
    await waitFor(() => expect(container.querySelector('[data-slot="project-avatar"] img')).toHaveAttribute('src', icon));
    expect(container.querySelector('[data-slot="group-avatar"]')).toBeNull();
  });
  it('opens and switches coding chats beside the group without losing its draft or navigation', async () => {
    useAppStore.setState({ selectedGroupId: 'g', selectedCodexChatId: 'previous-chat' });
    mocks.featureRequest.mockResolvedValue({ ...base, executions: [
      { id: 'run-a', agentId: 'a', rootId: 'root', taskId: null, purpose: 'message', status: 'waiting', activity: null, chatId: 'chat-a' },
      { id: 'run-b', agentId: 'b', rootId: 'root', taskId: null, purpose: 'message', status: 'completed', activity: null, chatId: 'chat-b' },
    ] });
    const { container } = renderWithQuery(<GroupPanel groupId="g" />);
    const composer = await screen.findByRole('textbox', { name: 'Message group' });
    fireEvent.change(composer, { target: { value: 'Keep this draft' } });
    expect(container.querySelector('.group-chat-layout')).toHaveAttribute('data-split', 'false');
    fireEvent.click(screen.getByRole('button', { name: 'Open Nova’s chat' }));
    expect(await within(screen.getByRole('complementary', { name: 'Agent coding chat' })).findByText('Coding conversation chat-a')).toBeInTheDocument();
    expect(container.querySelector('.group-chat-layout')).toHaveAttribute('data-split', 'true');
    expect(screen.getByRole('textbox', { name: 'Message group' })).toBe(composer);
    expect(composer).toHaveValue('Keep this draft');
    fireEvent.click(screen.getByRole('button', { name: 'Open Pock’s chat' }));
    expect(await screen.findByText('Coding conversation chat-b')).toBeInTheDocument();
    expect(screen.queryByText('Coding conversation chat-a')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Replace coding thread' }));
    expect(await screen.findByText('Coding conversation replacement-chat')).toBeInTheDocument();
    expect(useAppStore.getState()).toMatchObject({ selectedGroupId: 'g', selectedCodexChatId: 'previous-chat' });
    fireEvent.click(screen.getByRole('button', { name: 'Close coding chat' }));
    expect(screen.queryByRole('complementary', { name: 'Agent coding chat' })).not.toBeInTheDocument();
    expect(container.querySelector('.group-chat-layout')).toHaveAttribute('data-split', 'false');
    expect(composer).toHaveValue('Keep this draft');
  });
  it('lets the desktop coding-chat panel be resized with an accessible separator', async () => {
    mocks.featureRequest.mockResolvedValue({ ...base, executions: [
      { id: 'run-a', agentId: 'a', rootId: 'root', taskId: null, purpose: 'message', status: 'waiting', activity: null, chatId: 'chat-a' },
    ] });
    const { container } = renderWithQuery(<GroupPanel groupId="g" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Open Nova’s chat' }));
    const separator = await screen.findByRole('separator', { name: 'Resize agent coding chat' });
    expect(separator).toHaveAttribute('aria-valuenow', '50');
    fireEvent.keyDown(separator, { key: 'ArrowLeft' });
    expect(separator).toHaveAttribute('aria-valuenow', '52');
    expect(container.querySelector<HTMLElement>('.group-chat-layout')?.style.getPropertyValue('--group-coding-chat-width')).toBe('52%');
    const layout = container.querySelector<HTMLElement>('.group-chat-layout')!;
    vi.spyOn(layout, 'getBoundingClientRect').mockReturnValue({ x: 0, y: 0, left: 0, top: 0, right: 1000, bottom: 700, width: 1000, height: 700, toJSON: () => ({}) });
    fireEvent.pointerDown(separator, { button: 0, clientX: 500 });
    fireEvent.pointerMove(window, { clientX: 600 });
    fireEvent.pointerUp(window);
    expect(separator).toHaveAttribute('aria-valuenow', '40');
    expect(layout.style.getPropertyValue('--group-coding-chat-width')).toBe('40%');
  });
  it('opens coding chats as the full chat route on mobile without mounting a split panel', async () => {
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
    mocks.featureRequest.mockResolvedValue({ ...base, executions: [
      { id: 'run-a', agentId: 'a', rootId: 'root', taskId: null, purpose: 'message', status: 'waiting', activity: null, chatId: 'chat-a' },
    ] });
    const opened = vi.fn();
    window.addEventListener('boosted:open-codex-chat', opened);
    const { container } = renderWithQuery(<GroupPanel groupId="g" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Open Nova’s chat' }));
    expect(opened).toHaveBeenCalledOnce();
    expect((opened.mock.calls[0][0] as CustomEvent).detail).toEqual({ threadId: 'chat-a' });
    expect(screen.queryByRole('complementary', { name: 'Agent coding chat' })).not.toBeInTheDocument();
    expect(container.querySelector('.group-chat-layout')).toHaveAttribute('data-split', 'false');
    window.removeEventListener('boosted:open-codex-chat', opened);
  });
  it.each(['tasks', 'activity'] as const)('opens an execution chat from %s and closes the details drawer', async (tab) => {
    mocks.featureRequest.mockResolvedValue({ ...base,
      tasks: [{ id: 'task', rootId: 'root', title: 'Implement endpoint', instructions: 'Implement', expectedResult: 'Works', ownerId: 'a', reviewerId: null, status: 'running', dependencyIds: [], fileResponsibilities: [], revision: 1 }],
      executions: [{ id: 'run', agentId: 'a', rootId: 'root', taskId: 'task', purpose: 'execute', status: 'waiting', activity: null, chatId: 'chat-a' }],
    });
    renderWithQuery(<GroupPanel groupId="g" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Group tasks' }));
    const drawer = screen.getByRole('dialog');
    if (tab === 'activity') fireEvent.click(within(drawer).getByRole('tab', { name: 'Activity' }));
    fireEvent.click(within(drawer).getByRole('button', { name: 'Open Nova’s chat' }));
    expect(await screen.findByText('Coding conversation chat-a')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.getByRole('textbox', { name: 'Message group' })).toBeInTheDocument();
  });
  it.each(['transcript', 'activity'] as const)('opens a receipt chat in the split view from %s', async (source) => {
    mocks.featureRequest.mockResolvedValue({ ...base,
      executions: [{ id: 'run', agentId: 'a', rootId: 'root', taskId: null, purpose: 'message', status: 'completed', activity: null }],
      receipts: [{ id: 'receipt', groupId: 'g', agentId: 'a', executionId: 'run', taskId: null, tool: 'create_chat', arguments: {}, status: 'completed', chatId: 'chat-a' }],
    });
    const { container } = renderWithQuery(<GroupPanel groupId="g" />);
    await screen.findByRole('textbox', { name: 'Message group' });
    if (source === 'activity') {
      fireEvent.click(screen.getByRole('button', { name: 'Participants and tasks' }));
      fireEvent.click(screen.getByRole('tab', { name: 'Activity' }));
    }
    const scope = source === 'activity' ? screen.getByRole('dialog') : container;
    fireEvent.click(within(scope).getByRole('button', { name: '1 tool' }));
    const receipt = scope.querySelector('details')!;
    receipt.open = true; fireEvent(receipt, new Event('toggle'));
    fireEvent.click(within(scope).getByRole('button', { name: 'Open chat' }));
    expect(await screen.findByText('Coding conversation chat-a')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Message group' })).toBeInTheDocument();
  });
  it('clears a deleted group when reconnecting after missing its live deletion event', async () => {
    useAppStore.getState().selectGroup('g');
    mocks.featureRequest.mockRejectedValue(new ApiError(404, 'Group not found'));
    renderWithQuery(<GroupPanel groupId="g" />);
    await waitFor(() => expect(useAppStore.getState().selectedGroupId).toBeUndefined());
  });
  it('keeps accepted messages delivered while waiting and shows typing only during an active reply', async () => {
    const queued: GroupState = { ...base,
      messages: [{ id: 'one', groupId: 'g', rootId: 'one', sequence: 1, senderType: 'user', senderId: 'u', senderName: 'User', content: 'Hello', recipientIds: ['a'], kind: 'message', createdAt: base.createdAt }],
      deliveries: [{ id: 'delivery', groupId: 'g', rootId: 'one', messageId: 'one', agentId: 'a', purpose: 'message', status: 'queued', createdAt: base.createdAt }],
    };
    mocks.featureRequest.mockResolvedValue(queued);
    const { client } = renderWithQuery(<GroupPanel groupId="g" />);
    expect(await screen.findByText('Delivered')).toBeInTheDocument();
    expect(screen.queryByText(/queued/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Participants and tasks' }));
    expect(within(await screen.findByRole('dialog')).queryByText(/queued/i)).not.toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    const active: GroupState = { ...queued, version: 2, executions: [{ id: 'execution', agentId: 'a', rootId: 'one', taskId: null, purpose: 'message', status: 'running', activity: 'responding' }] };
    act(() => client.setQueryData(['groups', 'g'], active));
    const typing = await screen.findByRole('status', { name: 'Nova is typing' });
    expect(typing).toHaveTextContent('•••');
    expect(typing.closest('.assistant-conversation-scroll')).not.toBeNull();
    expect(screen.queryByText(/Replying|Thinking|Messages queued/)).not.toBeInTheDocument();
    act(() => client.setQueryData(['groups', 'g'], { ...active, version: 3, executions: [{ ...active.executions[0], status: 'waiting' }] }));
    await waitFor(() => expect(screen.queryByRole('status', { name: 'Nova is typing' })).not.toBeInTheDocument());
    act(() => client.setQueryData(['groups', 'g'], { ...active, version: 4, stopped: true }));
    await screen.findByText('Group stopped. Your messages and work are saved.');
    expect(screen.queryByRole('status', { name: 'Nova is typing' })).not.toBeInTheDocument();
    expect(screen.getByText('Delivered')).toBeInTheDocument();
    expect(screen.queryByText(/queued/i)).not.toBeInTheDocument();
  });
  it('keeps the latest messages visible when the keyboard resizes the chat without moving someone reading history', async () => {
    const observers: { callback: ResizeObserverCallback; targets: Set<Element> }[] = [];
    vi.stubGlobal('ResizeObserver', class {
      targets = new Set<Element>();
      constructor(callback: ResizeObserverCallback) { observers.push({ callback, targets: this.targets }); }
      observe(target: Element) { this.targets.add(target); }
      disconnect() { this.targets.clear(); }
    });
    const { container } = renderWithQuery(<GroupPanel groupId="g" />);
    await screen.findByRole('textbox', { name: 'Message group' });
    const transcript = container.querySelector('.group-chat-scroll') as HTMLElement;
    let height = 600; let position = 800;
    Object.defineProperties(transcript, {
      scrollHeight: { configurable: true, get: () => 1400 },
      clientHeight: { configurable: true, get: () => height },
      scrollTop: { configurable: true, get: () => position, set: (value: number) => { position = Math.min(value, 1400 - height); } },
    });
    const resize = () => act(() => { for (const observer of observers) if (observer.targets.has(transcript)) observer.callback([{ target: transcript, contentRect: transcript.getBoundingClientRect(), borderBoxSize: [], contentBoxSize: [], devicePixelContentBoxSize: [] }], {} as ResizeObserver); });
    fireEvent.scroll(transcript);
    height = 300; resize();
    expect(transcript.scrollTop).toBe(1100);
    height = 600; resize();
    expect(transcript.scrollTop).toBe(800);
    transcript.scrollTop = 200; fireEvent.scroll(transcript);
    height = 300; resize();
    expect(transcript.scrollTop).toBe(200);
  });
  it('moves the title and detail controls into the mobile shell header without duplicating them', async () => {
    const header = document.createElement('div'); document.body.appendChild(header);
    const { container } = renderWithQuery(<GroupPanel groupId="g" headerTarget={header} />);
    expect(await within(header).findByRole('heading', { name: 'Team' })).toBeInTheDocument();
    expect(container.querySelector('.group-chat-header')).toBeNull();
    expect(screen.getAllByRole('heading', { name: 'Team' })).toHaveLength(1);
    expect(screen.queryByText(/participants · .*leads/)).not.toBeInTheDocument();
    fireEvent.click(within(header).getByRole('button', { name: 'Participants and tasks' }));
    expect(await screen.findByRole('dialog')).toHaveTextContent('Nova');
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(within(header).getByRole('button', { name: 'Participants and tasks' })).toHaveFocus();
    header.remove();
  });
  it('edits and unassigns the project through the shared selector', async () => {
    mocks.projects.mockResolvedValue([{ id: 'project', name: 'Project' }]);
    renderWithQuery(<GroupDialog open initial={{ ...base, projectId: 'project' }} onOpenChange={() => {}} />);
    const select = await screen.findByRole('combobox', { name: 'Project' });
    expect(select).not.toBeDisabled();
    await waitFor(() => expect(select).toHaveTextContent('Project'));
    fireEvent.click(select);
    fireEvent.click(await screen.findByRole('option', { name: 'No project' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save group' }));
    await waitFor(() => expect(JSON.parse(mocks.featureRequest.mock.calls.find(([path]) => path === '/groups/g')![1].body).projectId).toBeNull());
  });
  it('uses the shared role selector beside the participant without toggling membership', async () => {
    const { container } = renderWithQuery(<GroupDialog open initial={base} onOpenChange={() => {}} />);
    const checkbox = await screen.findByRole('checkbox', { name: 'Pock' });
    const selector = screen.getByRole('button', { name: 'Pock role' });
    expect(selector.closest('.group-member-row')).toBe(checkbox.closest('.group-member-row'));
    expect(selector.closest('label')).toBeNull();
    expect(container.querySelector('select')).toBeNull();
    await toggleRole('Pock', 'Reviewer');
    expect(checkbox).toBeChecked();
    expect(selector).toHaveTextContent('Developer, Reviewer');
    fireEvent.click(screen.getByRole('button', { name: 'Save group' }));
    await waitFor(() => expect(JSON.parse(mocks.featureRequest.mock.calls.find(([path]) => path === '/groups/g')![1].body).memberRoles.b.roles).toEqual(['developer', 'reviewer']));
  });
  it('defaults to the leader and broadcasts only when Everyone is selected', async () => {
    renderWithQuery(<GroupPanel groupId="g" />);
    const composer = await screen.findByRole('textbox', { name: 'Message group' });
    expect(composer).toHaveAttribute('placeholder', 'Message Nova');
    expect(screen.queryByText('To Nova · Leader')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Message recipients' })).toHaveAttribute('title', 'Tag agents · Leader: Nova');
    expect(screen.queryByText(/participants · .*leads/)).not.toBeInTheDocument();
    fireEvent.change(composer, { target: { value: 'Plan the work' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    await waitFor(() => expect(JSON.parse(mocks.featureRequest.mock.calls.find(([path]) => path.endsWith('/messages'))![1].body).recipientIds).toEqual([]));
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Message recipients' }), { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Everyone' }));
    fireEvent.change(composer, { target: { value: 'Hello everyone' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    await waitFor(() => expect(JSON.parse(mocks.featureRequest.mock.calls.filter(([path]) => path.endsWith('/messages'))[1][1].body).recipientIds).toEqual(['a', 'b']));
  });
  it('shows each participant’s role and specific responsibilities', async () => {
    mocks.featureRequest.mockResolvedValue({ ...base, memberRoles: { ...base.memberRoles, b: { role: 'developer', responsibilities: 'Backend APIs' } } });
    renderWithQuery(<GroupPanel groupId="g" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Participants and tasks' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Leader')).toBeInTheDocument();
    expect(within(dialog).getByText('Developer')).toBeInTheDocument();
    expect(within(dialog).getByText('Backend APIs')).toBeInTheDocument();
  });
  it('saves distinct roles and responsibilities with exactly one coordinator', async () => {
    mocks.featureRequest.mockResolvedValue(base);
    renderWithQuery(<GroupDialog open onOpenChange={() => {}} />);
    fireEvent.change(screen.getByRole('textbox', { name: 'Name' }), { target: { value: 'Team' } });
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Nova' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Pock' }));
    await toggleRole('Pock', 'Leader');
    expect(screen.getByRole('button', { name: 'Nova role' })).toHaveTextContent('Developer');
    fireEvent.change(screen.getByRole('textbox', { name: 'Nova responsibilities' }), { target: { value: 'Backend APIs' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create group' }));
    await waitFor(() => expect(JSON.parse(mocks.featureRequest.mock.calls.find(([path]) => path === '/groups')![1].body).memberRoles).toEqual({
      a: { role: 'developer', roles: ['developer'], responsibilities: 'Backend APIs' }, b: { role: 'coordinator', roles: ['developer', 'coordinator'], responsibilities: '' },
    }));
  });
  it('requires a coordinator and replaces a removed coordinator', async () => {
    renderWithQuery(<GroupDialog open onOpenChange={() => {}} />);
    fireEvent.change(screen.getByRole('textbox', { name: 'Name' }), { target: { value: 'Team' } });
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Nova' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Pock' }));
    await toggleRole('Nova', 'Reviewer');
    await toggleRole('Nova', 'Leader');
    expect(screen.getByRole('button', { name: 'Create group' })).toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent('Choose one leader');
    await toggleRole('Nova', 'Leader');
    expect(screen.getByRole('button', { name: 'Create group' })).toBeEnabled();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Nova' }));
    expect(screen.getByRole('button', { name: 'Pock role' })).toHaveTextContent('Leader');
    expect(screen.getByRole('button', { name: 'Nova role' })).toBeDisabled();
  });
  it('loads saved roles for editing and preserves responsibility text', async () => {
    const initial = { ...base, stopped: true, memberRoles: { a: { role: 'coordinator' as const, roles: ['coordinator' as const], responsibilities: 'Plan work' }, b: { role: 'reviewer' as const, roles: ['reviewer' as const], responsibilities: 'Security review' } } };
    mocks.featureRequest.mockResolvedValue(initial);
    renderWithQuery(<GroupDialog open initial={initial} onOpenChange={() => {}} />);
    expect(screen.getByRole('button', { name: 'Pock role' })).toHaveTextContent('Reviewer');
    expect(screen.getByRole('textbox', { name: 'Pock responsibilities' })).toHaveValue('Security review');
    fireEvent.click(screen.getByRole('button', { name: 'Save group' }));
    await waitFor(() => expect(JSON.parse(mocks.featureRequest.mock.calls.find(([path]) => path === '/groups/g')![1].body).memberRoles).toEqual(initial.memberRoles));
  });
  it('addresses exact agent IDs and keeps the user’s draft until send', async () => {
    renderWithQuery(<GroupPanel groupId="g" />);
    await screen.findByRole('heading', { name: 'Team' });
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Message recipients' }), { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByRole('menuitemcheckbox', { name: 'Nova' }));
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
    fireEvent.change(screen.getByRole('textbox', { name: 'Message group' }), { target: { value: 'Inspect the API' } });
    expect(screen.getByRole('textbox', { name: 'Message group' })).toHaveValue('Inspect the API');
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    await waitFor(() => {
      const sent = mocks.featureRequest.mock.calls.find(([path]) => path === '/groups/g/messages');
      expect(sent).toBeDefined();
      expect(JSON.parse(sent![1].body)).toMatchObject({ content: 'Inspect the API', recipientIds: ['a'] });
    });
  });
  it('retries a failed send with the original client message ID', async () => {
    let attempts = 0;
    mocks.featureRequest.mockImplementation((path: string) => {
      if (path.endsWith('/messages')) return ++attempts === 1 ? Promise.reject(new Error('Offline')) : Promise.resolve({});
      return Promise.resolve(base);
    });
    renderWithQuery(<GroupPanel groupId="g" />);
    await screen.findByRole('heading', { name: 'Team' });
    fireEvent.change(screen.getByRole('textbox', { name: 'Message group' }), { target: { value: 'Build this' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Retry message' }));
    await waitFor(() => expect(attempts).toBe(2));
    const sends = mocks.featureRequest.mock.calls.filter(([path]) => path.endsWith('/messages'));
    expect(JSON.parse(sends[0][1].body).clientMessageId).toBe(JSON.parse(sends[1][1].body).clientMessageId);
  });
  it('shows restart recovery and resumes only after user action', async () => {
    mocks.featureRequest.mockResolvedValue({ ...base, stopped: true, stopReason: 'restart' });
    renderWithQuery(<GroupPanel groupId="g" />);
    expect(await screen.findByText(/server restart/)).toBeInTheDocument();
    expect(mocks.featureRequest.mock.calls.some(([path]) => path.endsWith('/resume'))).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Resume' }));
    await waitFor(() => expect(mocks.featureRequest).toHaveBeenCalledWith('/groups/g/resume', { method: 'POST' }));
  });
  it('displays peer review, evidence, cancellation, and the participant drawer', async () => {
    mocks.featureRequest.mockResolvedValue({ ...base,
      tasks: [{ id: 't', rootId: 'r', title: 'Endpoint', instructions: 'Implement', expectedResult: 'Works', ownerId: 'a', reviewerId: 'b', status: 'awaiting_review', dependencyIds: [], fileResponsibilities: [], workingDirectory: null, revision: 2, result: 'Ready', verification: 'Tests passed', error: null }],
      reviews: [{ id: 'r', taskId: 't', reviewerId: 'b', decision: 'request_changes', evidence: 'Handle invalid input', revision: 1 }],
    });
    renderWithQuery(<GroupPanel groupId="g" />);
    await screen.findByRole('heading', { name: 'Team' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Group tasks' }));
    expect(await screen.findByText('Awaiting peer review')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Assignment and results'));
    expect(screen.getByText(/Handle invalid input/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Tasks/ })).toHaveAttribute('aria-selected', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel task' }));
    await waitFor(() => expect(mocks.featureRequest).toHaveBeenCalledWith('/groups/g/tasks/t/cancel', { method: 'POST' }));
  });
  it('keeps routine tool counters and participant rows out of chat but preserves them in Activity', async () => {
    mocks.featureRequest.mockResolvedValue({ ...base,
      messages: [{ id: 'one', groupId: 'g', rootId: 'one', sequence: 1, senderType: 'user', senderId: 'u', senderName: 'User', content: 'Hello', recipientIds: [], kind: 'message', createdAt: base.createdAt }],
      executions: [{ id: 'execution', rootId: 'one', agentId: 'a', status: 'completed' }],
      receipts: ['read_group_context', 'send_group_message', 'request_group_peers'].map((tool) => ({ id: tool, tool, arguments: {}, status: 'completed', agentId: 'a', executionId: 'execution' })),
    });
    const { container } = renderWithQuery(<GroupPanel groupId="g" />);
    await screen.findByText('Hello');
    expect(screen.queryByRole('button', { name: /\d+ tools?/ })).not.toBeInTheDocument();
    expect(container.querySelector('.group-work-tools')).toBeNull();
    expect(container.querySelector('.group-work-summary')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Participants and tasks' }));
    fireEvent.click(await screen.findByRole('tab', { name: 'Activity' }));
    const dialog = screen.getByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: '3 tools' }));
    expect(within(dialog).getByText('Read group context')).toBeInTheDocument();
    expect(within(dialog).getByText('Send group message')).toBeInTheDocument();
    expect(within(dialog).getByText('Ask a peer')).toBeInTheDocument();
  });
  it('loads earlier history without duplicating the current message', async () => {
    const latest = { id: 'three', sequence: 3, senderType: 'user', senderName: 'User', senderId: 'u', recipientIds: [], content: 'Latest', createdAt: '2026-10-04T00:00:00Z' };
    mocks.featureRequest.mockImplementation((path: string) => Promise.resolve(path.includes('?before') ? [{ ...latest, id: 'two', sequence: 2, content: 'Earlier' }] : { ...base, messages: [latest], messageCount: 3 }));
    renderWithQuery(<GroupPanel groupId="g" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Load older messages' }));
    expect(await screen.findByText('Earlier')).toBeInTheDocument();
    expect(screen.getAllByText('Latest')).toHaveLength(1);
  });
  it('uses chat bubbles, groups consecutive replies, and opens details on demand', async () => {
    const message = { groupId: 'g', rootId: 'one', kind: 'message', recipientIds: [], createdAt: base.createdAt };
    mocks.featureRequest.mockResolvedValue({ ...base, messages: [
      { ...message, id: 'one', sequence: 1, senderType: 'user', senderId: 'u', senderName: 'User', content: 'Build it' },
      { ...message, id: 'two', sequence: 2, senderType: 'agent', senderId: 'a', senderName: 'Nova', content: 'I will handle the API' },
      { ...message, id: 'three', sequence: 3, senderType: 'agent', senderId: 'a', senderName: 'Nova', content: 'Tests are next' },
      { ...message, id: 'four', sequence: 4, senderType: 'agent', senderId: 'b', senderName: 'Pock', content: 'I will review it' },
    ] });
    renderWithQuery(<GroupPanel groupId="g" />);
    const outgoing = await screen.findByRole('article', { name: 'Your message' });
    expect(outgoing.querySelector('.assistant-message-user')).not.toBeNull();
    const replies = screen.getAllByRole('article', { name: 'Nova reply' });
    expect(replies[0].querySelector('.assistant-message-reply')).not.toBeNull();
    expect(within(replies[0]).getByText('Nova')).toBeInTheDocument();
    expect(within(replies[1]).queryByText('Nova')).not.toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    const trigger = screen.getByRole('button', { name: 'Participants and tasks' });
    fireEvent.click(trigger);
    expect(await screen.findByRole('tab', { name: 'Participants' })).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(trigger).toHaveFocus();
  });
  it('keeps exact recipient IDs with a draft across navigation', async () => {
    const first = renderWithQuery(<GroupPanel groupId="g" />);
    await screen.findByRole('heading', { name: 'Team' });
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Message recipients' }), { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByRole('menuitemcheckbox', { name: 'Pock' }));
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
    fireEvent.change(screen.getByRole('textbox', { name: 'Message group' }), { target: { value: 'Review the API' } });
    first.unmount();
    renderWithQuery(<GroupPanel groupId="g" />);
    expect(await screen.findByRole('textbox', { name: 'Message group' })).toHaveValue('Review the API');
    expect(screen.getByRole('button', { name: 'Message recipients' })).toHaveAttribute('title', 'Tagged agents: Pock');
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    await waitFor(() => expect(JSON.parse(mocks.featureRequest.mock.calls.find(([path]) => path.endsWith('/messages'))![1].body).recipientIds).toEqual(['b']));
  });
  it('sends attachment-only messages and does not send on Shift+Enter or IME composition', async () => {
    renderWithQuery(<GroupPanel groupId="g" />);
    const composer = await screen.findByRole('textbox', { name: 'Message group' });
    fireEvent.change(composer, { target: { value: 'Draft' } });
    fireEvent.keyDown(composer, { key: 'Enter', shiftKey: true });
    fireEvent.keyDown(composer, { key: 'Enter', isComposing: true });
    expect(mocks.featureRequest.mock.calls.some(([path]) => path.endsWith('/messages'))).toBe(false);
    fireEvent.change(composer, { target: { value: '' } });
    fireEvent.change(screen.getByLabelText('Select attachments'), { target: { files: [new File(['notes'], 'notes.txt', { type: 'text/plain' })] } });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send message' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    await waitFor(() => {
      const sent = JSON.parse(mocks.featureRequest.mock.calls.find(([path]) => path.endsWith('/messages'))![1].body);
      expect(sent.attachments).toHaveLength(1); expect(sent.attachments[0].name).toBe('notes.txt');
    });
  });
  it('opens a modal task sheet on mobile and reports assignment errors inside the form', async () => {
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
    mocks.featureRequest.mockImplementation((path: string) => path.endsWith('/tasks') ? Promise.reject(new Error('Assignment rejected')) : Promise.resolve(base));
    renderWithQuery(<GroupPanel groupId="g" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Group tasks' }));
    expect(screen.getByRole('dialog')).toHaveClass('group-details-panel');
    expect(document.querySelector('[data-aria-hidden]')).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'New task' }));
    const dialog = await screen.findByRole('dialog', { name: 'New assignment' });
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Title' }), { target: { value: 'Endpoint' } });
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Instructions' }), { target: { value: 'Implement it' } });
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Expected result' }), { target: { value: 'Tests pass' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save assignment' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Assignment rejected');
  });
  it('selects a project through the shared select and includes it when creating a group', async () => {
    mocks.projects.mockResolvedValue([{ id: 'boosted', name: 'Boosted' }]);
    mocks.featureRequest.mockResolvedValue(base);
    renderWithQuery(<GroupDialog open onOpenChange={() => {}} />);
    fireEvent.change(screen.getByRole('textbox', { name: 'Name' }), { target: { value: 'Team' } });
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Nova' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Pock' }));
    const project = screen.getByRole('combobox', { name: 'Project' });
    expect(project.tagName).toBe('BUTTON');
    fireEvent.keyDown(project, { key: 'ArrowDown' });
    fireEvent.click(await screen.findByRole('option', { name: 'Boosted' }));
    expect(project).toHaveTextContent('Boosted');
    fireEvent.click(screen.getByRole('button', { name: 'Create group' }));
    await waitFor(() => {
      const call = mocks.featureRequest.mock.calls.find(([path]) => path === '/groups');
      expect(JSON.parse(call![1].body)).toEqual({ name: 'Team', memberIds: ['a', 'b'], memberRoles: base.memberRoles, projectId: 'boosted' });
    });
  });
  it('requires two selected peers and sends no implicit project', async () => {
    const created = vi.fn();
    mocks.featureRequest.mockResolvedValue(base);
    renderWithQuery(<GroupDialog open onOpenChange={() => {}} onCreated={created} />);
    fireEvent.change(screen.getByRole('textbox', { name: 'Name' }), { target: { value: 'Team' } });
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Nova' }));
    expect(screen.getByRole('button', { name: 'Create group' })).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Pock' }));
    fireEvent.click(screen.getByRole('button', { name: 'Create group' }));
    await waitFor(() => {
      const call = mocks.featureRequest.mock.calls.find(([path]) => path === '/groups');
      expect(JSON.parse(call![1].body)).toEqual({ name: 'Team', memberIds: ['a', 'b'], memberRoles: base.memberRoles });
      expect(created).toHaveBeenCalled();
    });
  });
});
