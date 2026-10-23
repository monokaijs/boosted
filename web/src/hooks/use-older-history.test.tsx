import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { useRef } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { useOlderHistory } from './use-older-history';
import type { HistoryPage } from '@/lib/history';
type Message = { id: string; sequence: number; content: string };
const m = (sequence: number, content = String(sequence)): Message => ({ id: String(sequence), sequence, content });
let client: QueryClient;
afterEach(() => { cleanup(); client.clear(); });
function Harness({ id, load }: { id: string; load: (cursor: string) => Promise<HistoryPage<Message>> }) {
  const node = useRef<HTMLDivElement>(null);
  const { data } = useQuery({ queryKey: ['history', id], queryFn: async () => ({ messages: [m(3)], olderCursor: '3' }), initialData: { messages: [m(3)], olderCursor: '3' }, enabled: false });
  const history = useOlderHistory({ queryKey: ['history', id], page: data, load, scroller: () => node.current });
  return <div ref={node} data-testid="scroll"><button disabled={history.loading} onClick={() => void history.loadOlder()}>Earlier</button>{history.error && <p role="alert">{history.error}</p>}{data.messages.map((message) => <p key={message.id} data-history-id={message.id}>{message.content}</p>)}</div>;
}
function view(id: string, load: (cursor: string) => Promise<HistoryPage<Message>>) {
  return <QueryClientProvider client={client}><Harness id={id} load={load} /></QueryClientProvider>;
}
it('preserves scroll and concurrent live versions while merging an older page', async () => {
  client = new QueryClient(); let finish!: (page: HistoryPage<Message>) => void;
  const load = vi.fn(() => new Promise<HistoryPage<Message>>((resolve) => { finish = resolve; }));
  render(view('a', load)); const node = screen.getByTestId('scroll'); node.scrollTop = 25;
  const anchor = screen.getByText('3');
  anchor.getBoundingClientRect = () => { const top = Array.from(node.querySelectorAll<HTMLElement>('p')).indexOf(anchor) * 100 - node.scrollTop; return { top, bottom: top + 100 } as DOMRect; };
  Object.defineProperty(node, 'scrollHeight', { get: () => node.querySelectorAll('p').length * 100 });
  fireEvent.click(screen.getByText('Earlier')); fireEvent.click(screen.getByText('Earlier'));
  expect(load).toHaveBeenCalledTimes(1);
  act(() => client.setQueryData(['history','a'], { messages: [m(3,'Live update'),m(4)], olderCursor: '3' }));
  await act(async () => finish({ messages: [m(1),m(2),m(3,'Old version')], olderCursor: null }));
  expect(client.getQueryData<HistoryPage<Message>>(['history','a'])?.messages).toEqual([m(1),m(2),m(3,'Live update'),m(4)]);
  expect(node.scrollTop).toBe(225);
});
it('keeps the cursor retryable after a failed page', async () => {
  client = new QueryClient();
  const load = vi.fn().mockRejectedValueOnce(new Error('Offline')).mockResolvedValue({ messages: [m(1),m(2)], olderCursor: null });
  render(view('a', load)); fireEvent.click(screen.getByText('Earlier'));
  await screen.findByRole('alert'); fireEvent.click(screen.getByText('Earlier')); await screen.findByText('1');
  expect(load.mock.calls).toEqual([['3'],['3']]);
});
it('ignores a late older page after switching chats and allows the new chat to paginate', async () => {
  client = new QueryClient(); let finish!: (page: HistoryPage<Message>) => void;
  const oldLoad = vi.fn(() => new Promise<HistoryPage<Message>>((resolve) => { finish = resolve; }));
  const newLoad = vi.fn().mockResolvedValue({ messages: [m(2,'Other chat')], olderCursor: null });
  const rendered = render(view('a', oldLoad)); fireEvent.click(screen.getByText('Earlier'));
  rendered.rerender(view('b', newLoad)); fireEvent.click(screen.getByText('Earlier'));
  await screen.findByText('Other chat');
  await act(async () => finish({ messages: [m(1,'Wrong chat')], olderCursor: null }));
  expect(screen.queryByText('Wrong chat')).not.toBeInTheDocument();
  expect(client.getQueryData<HistoryPage<Message>>(['history','b'])?.messages.map((m) => m.content)).toEqual(['Other chat','3']);
});
