import { useLayoutEffect, useRef, useState } from 'react';
import { useQueryClient, type QueryKey } from '@tanstack/react-query';
import { preserveHistoryPrepend, mergeHistory, type HistoryPage } from '@/lib/history';

export function useOlderHistory<Message extends { id: string | number; sequence?: number }, Page extends HistoryPage<Message>>({ queryKey, page, load, scroller, beforeLoad }: {
  queryKey: QueryKey; page?: Page; load(cursor: string): Promise<HistoryPage<Message>>; scroller(): HTMLElement | null; beforeLoad?(): void;
}) {
  const client = useQueryClient();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const inFlight = useRef(false);
  const scope = JSON.stringify(queryKey);
  const active = useRef(scope);
  active.current = scope;
  const stopPreserving = useRef<(() => void) | undefined>(undefined);
  useLayoutEffect(() => {
    active.current = scope; inFlight.current = false; setLoading(false); setError(undefined);
    return () => { active.current = ''; stopPreserving.current?.(); };
  }, [scope]);
  async function loadOlder() {
    const cursor = page?.olderCursor;
    if (!cursor || inFlight.current) return;
    const node = scroller();
    inFlight.current = true;
    beforeLoad?.();
    setLoading(true); setError(undefined);
    try {
      const older = await load(cursor);
      if (active.current !== scope) return;
      const current = client.getQueryData<Page>(queryKey);
      const known = new Set(current?.messages.map((message) => message.id));
      stopPreserving.current?.();
      if (node) stopPreserving.current = preserveHistoryPrepend(node, new Set(older.messages.filter((message) => !known.has(message.id)).map((message) => String(message.id))));
      client.setQueryData<Page>(queryKey, (current) => current ? { ...current, messages: mergeHistory(older.messages, current.messages), olderCursor: older.olderCursor ?? null } : current);
    } catch (cause) {
      if (active.current === scope) setError(cause instanceof Error ? cause.message : 'Unable to load earlier messages.');
    } finally {
      if (active.current === scope) { inFlight.current = false; setLoading(false); }
    }
  }
  return { loading, error, loadOlder, hasOlder: Boolean(page?.olderCursor) };
}
