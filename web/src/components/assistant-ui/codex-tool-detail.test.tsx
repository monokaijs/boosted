import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CodexDetailScope, CodexToolDisclosure } from './codex-tool-detail';
const mock = vi.hoisted(() => ({ detail: vi.fn() }));
vi.mock('@/lib/api-context', () => ({ useBoostedApiClient: () => ({ profileId: 'machine', codexToolDetail: mock.detail }) }));
vi.mock('./codex-message-content', () => ({ CodexMessageContent: ({ content }: { content: string }) => <p>{content}</p> }));
let client: QueryClient;
beforeEach(() => { client = new QueryClient(); mock.detail.mockReset(); });
afterEach(() => { cleanup(); client.clear(); });
function view(thread = 'thread', revision = 'rev-1') {
  return <QueryClientProvider client={client}><CodexDetailScope.Provider value={thread}><CodexToolDisclosure id="tool" revision={revision} content="Command"><summary>Command</summary></CodexToolDisclosure></CodexDetailScope.Provider></QueryClientProvider>;
}
async function toggle(open: boolean) {
  const details = screen.getByText('Command').closest('details')!;
  await act(async () => { details.open = open; fireEvent(details, new Event('toggle')); });
}
it('makes zero detail requests before expansion, then caches close/reopen and remount', async () => {
  mock.detail.mockResolvedValue({ content: 'Full command and output' });
  const rendered = render(view());
  await act(async () => { await Promise.resolve(); });
  expect(mock.detail).toHaveBeenCalledTimes(0);
  expect(screen.queryByText('Full command and output')).not.toBeInTheDocument();
  await toggle(true); await screen.findByText('Full command and output');
  expect(mock.detail).toHaveBeenCalledTimes(1);
  await toggle(false); await toggle(true);
  expect(mock.detail).toHaveBeenCalledTimes(1);
  rendered.unmount(); render(view());
  expect(mock.detail).toHaveBeenCalledTimes(1);
  await toggle(true); await screen.findByText('Full command and output');
  expect(mock.detail).toHaveBeenCalledTimes(1);
});
it('allows retry, refreshes changed tool revisions only while open, and isolates chat switches', async () => {
  mock.detail.mockRejectedValueOnce(new Error('Offline')).mockResolvedValue({ content: 'Retried output' });
  const rendered = render(view()); await toggle(true);
  await screen.findByRole('alert'); fireEvent.click(screen.getByText('Retry tool details'));
  await screen.findByText('Retried output'); expect(mock.detail).toHaveBeenCalledTimes(2);
  await toggle(false); rendered.rerender(view('thread', 'rev-2'));
  expect(mock.detail).toHaveBeenCalledTimes(2);
  await toggle(true); await waitFor(() => expect(mock.detail).toHaveBeenCalledTimes(3));
  rendered.rerender(view('other-thread', 'rev-2'));
  await waitFor(() => expect(mock.detail).toHaveBeenCalledTimes(4));
  expect(mock.detail.mock.calls[3].slice(0,2)).toEqual(['other-thread','tool']);
});
