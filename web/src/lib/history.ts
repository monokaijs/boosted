export type HistoryPage<Message> = { messages: Message[]; olderCursor?: string | null; historyAnchor?: string | number };
type Identified = { id: string | number; sequence?: number };

// Incoming entries replace old versions. Relative server order wins, including
// when timestamps tie; identifiers, never array offsets, are pagination anchors.
export function mergeHistory<Message extends Identified>(older: Message[], newer: Message[]): Message[] {
  const incoming = new Map(newer.map((message) => [message.id, message]));
  const result = older.map((message) => incoming.get(message.id) ?? message);
  const known = new Set(older.map((message) => message.id));
  for (let index = 0; index < newer.length; index++) {
    const message = newer[index];
    if (known.has(message.id)) continue;
    const following = newer.slice(index + 1).find((item) => known.has(item.id));
    const at = following ? result.findIndex((item) => item.id === following.id) : result.length;
    result.splice(at, 0, message);
    known.add(message.id);
  }
  return result.every((message) => message.sequence !== undefined) ? result.sort((a, b) => a.sequence! - b.sequence!) : result;
}

// Reconnects can miss more than one tail. Bridge only the newly missed range in
// bounded server pages, stopping at overlap with the range already on screen.
export async function reconcileTail<Message extends Identified, Page extends HistoryPage<Message>>(
  current: Page | undefined, next: Page, load: (cursor: string) => Promise<HistoryPage<Message>>,
): Promise<Page> {
  if (!current?.messages.length) return { ...next, historyAnchor: next.messages.at(-1)?.id };
  const anchor = current.historyAnchor ? current.messages.findIndex((message) => message.id === current.historyAnchor) : current.messages.length - 1;
  const known = new Set(current.messages.slice(0, anchor + 1).map((message) => message.id));
  let messages = next.messages;
  let cursor = next.olderCursor;
  const visited = new Set<string>();
  while (messages.length && !messages.some((message) => known.has(message.id)) && cursor && !visited.has(cursor)) {
    visited.add(cursor);
    const page = await load(cursor);
    messages = mergeHistory(page.messages, messages);
    cursor = page.olderCursor;
  }
  return { ...next, messages: mergeHistory(current.messages, messages), olderCursor: current.olderCursor ?? null, historyAnchor: next.messages.at(-1)?.id };
}

// A page can finish while a refresh is in flight. Retain the range and live
// versions that entered the cache after the refresh took its starting snapshot.
export function retainConcurrentHistory<Message extends Identified, Page extends HistoryPage<Message>>(started: Page | undefined, latest: Page | undefined, refreshed: Page): Page {
  if (!latest || latest === started) return refreshed;
  const original = new Map(started?.messages.map((message) => [message.id, message]));
  const changed = new Map(latest.messages.filter((message) => {
    const before = original.get(message.id);
    return before && before !== message && JSON.stringify(before) !== JSON.stringify(message);
  }).map((message) => [message.id, message]));
  // A prepend can copy unchanged entries. Those copies must not overwrite a
  // newer HTTP version; only messages edited since the request started win.
  return { ...refreshed, messages: mergeHistory(latest.messages, refreshed.messages).map((message) => changed.get(message.id) ?? message), olderCursor: latest.olderCursor };
}

export function captureScroll(node: HTMLElement) {
  const top = node.getBoundingClientRect().top;
  const anchor = Array.from(node.querySelectorAll<HTMLElement>('[data-history-id], [id^="codex-message-"]')).find((element) => element.getBoundingClientRect().bottom > top);
  const identity = anchor?.getAttribute("data-history-id") ?? anchor?.id;
  const offset = anchor ? anchor.getBoundingClientRect().top - top : 0;
  const height = node.scrollHeight;
  const scrollTop = node.scrollTop;
  return () => {
    if (!node.isConnected) return;
    const retained = anchor?.isConnected && (anchor.getAttribute("data-history-id") ?? anchor.id) === identity ? anchor : Array.from(node.querySelectorAll<HTMLElement>('[data-history-id], [id^="codex-message-"]')).find((element) => (element.getAttribute('data-history-id') ?? element.id) === identity);
    if (retained) node.scrollTop += retained.getBoundingClientRect().top - node.getBoundingClientRect().top - offset;
    else node.scrollTop = scrollTop + node.scrollHeight - height;
  };
}

// Some transcript adapters commit their rows after the query's React commit.
// Observe the actual insertion so anchoring follows the DOM, not cache timing.
export function preserveHistoryPrepend(node: HTMLElement, addedIds: Set<string>) {
  if (!addedIds.size) return () => {};
  const restore = captureScroll(node);
  let frame = 0;
  let timeout: ReturnType<typeof setTimeout>;
  const stop = () => { observer.disconnect(); cancelAnimationFrame(frame); clearTimeout(timeout); };
  const observer = new MutationObserver(() => {
    restore();
    const inserted = Array.from(node.querySelectorAll<HTMLElement>('[data-history-id], [id^="codex-message-"]')).some((element) => {
      const id = element.getAttribute('data-history-id') ?? element.id.replace(/^codex-message-(?:activity-|changes-)?/, '');
      return addedIds.has(id);
    });
    if (inserted) {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => { restore(); stop(); });
    }
  });
  observer.observe(node, { childList: true, subtree: true });
  timeout = setTimeout(stop, 10_000);
  return stop;
}
