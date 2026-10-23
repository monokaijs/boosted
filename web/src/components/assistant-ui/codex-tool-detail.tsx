import { createContext, useContext, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { BoostedApiClient } from '@/lib/api';
import { useBoostedApiClient } from '@/lib/api-context';
import type { MessageAttachment } from '@/lib/types';
import { CodexMessageContent } from './codex-message-content';

export const CodexDetailScope = createContext('');

export function codexToolDetailQuery(api: BoostedApiClient, thread: string, id: string, revision?: string) {
  return {
    queryKey: ['codex-tool-detail', api.profileId, thread, id, revision],
    queryFn: ({ signal }: { signal: AbortSignal }) => api.codexToolDetail(thread, id, signal),
    staleTime: Infinity, gcTime: 120_000, retry: false,
  };
}

export function CodexToolDisclosure({ id, revision, content, attachments, children, className, bodyClassName }: {
  id: string; revision?: string; content: string; attachments?: MessageAttachment[]; children: ReactNode; className?: string; bodyClassName?: string;
}) {
  const api = useBoostedApiClient();
  const thread = useContext(CodexDetailScope);
  const [open, setOpen] = useState(false);
  const detail = useQuery({
    ...codexToolDetailQuery(api, thread, id, revision),
    enabled: open && Boolean(revision && thread),
  });
  return <details className={className} onToggle={(event) => setOpen(event.currentTarget.open)}>
    {children}
    {open && <div className={bodyClassName}>
      {revision && thread ? detail.error
        ? <p role="alert">{detail.error.message} <button type="button" onClick={() => void detail.refetch()}>Retry tool details</button></p>
        : detail.data ? <CodexMessageContent content={detail.data.content} attachments={detail.data.attachments} />
          : <p role="status">Loading tool details…</p>
        : <CodexMessageContent content={content} attachments={attachments} />}
    </div>}
  </details>;
}
