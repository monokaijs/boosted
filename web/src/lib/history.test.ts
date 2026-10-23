import { describe, expect, it, vi } from 'vitest';
import { mergeHistory, reconcileTail, captureScroll, retainConcurrentHistory } from './history';
const message = (id: number) => ({ id: String(id), content: `Message ${id}` });

describe('history windows', () => {
  it('retains loaded pages, server order and changed entries when timestamps tie', () => {
    expect(mergeHistory([message(2), message(3)], [message(1), { ...message(2), content: 'Updated' }, message(3), message(4)]))
      .toEqual([message(1), { ...message(2), content: 'Updated' }, message(3), message(4)]);
  });
  it('bridges a reconnect gap larger than a tail, even after fresh live arrivals', async () => {
    const load = vi.fn().mockResolvedValueOnce({ messages: [message(3), message(4)], olderCursor: '3' })
      .mockResolvedValueOnce({ messages: [message(1), message(2)], olderCursor: null });
    const current: import('./history').HistoryPage<ReturnType<typeof message>> = { messages: [message(0), message(1), message(6)], olderCursor: null, historyAnchor: '1' };
    const next = { messages: [message(5), message(6)], olderCursor: '5' };
    const result = await reconcileTail(current, next, load);
    expect(result.messages.map((m) => m.id)).toEqual(['0','1','2','3','4','5','6']);
    expect(result.olderCursor).toBeNull();
    expect(load.mock.calls).toEqual([['5'],['3']]);
  });
  it('does not fetch older history on an ordinary refresh', async () => {
    const load = vi.fn();
    const result = await reconcileTail({ messages: [message(1),message(2)], olderCursor: '1' }, { messages: [message(2),message(3)], olderCursor: '2' }, load);
    expect(load).not.toHaveBeenCalled();
    expect(result.messages.map((m) => m.id)).toEqual(['1','2','3']);
    expect(result.olderCursor).toBe('1');
  });
  it('preserves a visible anchor when older and live messages change height together', () => {
    const node = document.createElement('div'); const anchor = document.createElement('div'); anchor.dataset.historyId = 'kept';
    node.append(anchor); document.body.append(node); node.scrollTop = 120;
    node.getBoundingClientRect = () => ({ top: 10 } as DOMRect);
    let position = 30;
    anchor.getBoundingClientRect = () => ({ top: position, bottom: position + 30 } as DOMRect);
    const restore = captureScroll(node); position += 450; restore();
    expect(node.scrollTop).toBe(570); node.remove();
  });
  it('locates the same message after a transcript adapter reuses its DOM node', () => {
    const node = document.createElement('div'); const reused = document.createElement('div'); reused.id = 'codex-message-kept';
    node.append(reused); document.body.append(node); node.scrollTop = 100;
    node.getBoundingClientRect = () => ({ top: 0 } as DOMRect);
    reused.getBoundingClientRect = () => ({ top: 20, bottom: 80 } as DOMRect);
    const restore = captureScroll(node);
    reused.id = 'codex-message-older';
    const retained = document.createElement('div'); retained.id = 'codex-message-kept';
    retained.getBoundingClientRect = () => ({ top: 420, bottom: 480 } as DOMRect);
    node.append(retained); restore();
    expect(node.scrollTop).toBe(500); node.remove();
  });
  it('retains a page and live version that arrived during an HTTP refresh', () => {
    const started = { messages: [message(3)], olderCursor: '3' };
    const latest = { messages: [message(1),message(2),{...message(3),content:'Live'}], olderCursor: '1' };
    const refreshed = { messages: [message(3),message(4)], olderCursor: '3' };
    expect(retainConcurrentHistory(started,latest,refreshed)).toEqual({ messages: [message(1),message(2),{...message(3),content:'Live'},message(4)], olderCursor:'1' });
  });

  it('does not let unchanged copies in an older page overwrite refreshed message content', () => {
    const started = { messages: [message(3)], olderCursor: '3' };
    const latest = { messages: [message(1),message(2),{ ...message(3) }], olderCursor: '1' };
    const refreshed = { messages: [{ ...message(3),content:'Fresh HTTP edit' },message(4)], olderCursor: '3' };
    expect(retainConcurrentHistory(started,latest,refreshed).messages).toEqual([message(1),message(2),{...message(3),content:'Fresh HTTP edit'},message(4)]);
  });

});
