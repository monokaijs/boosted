import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, Check, ChevronDown, ListTodo, LoaderCircle, MessageSquare, Play, Plus, Square, TriangleAlert, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { AssistantAttachmentList } from '@/features/agents/components/session/assistant-attachment-list';
import { ActionGroup } from '@/features/agents/components/session/conversation-tools';
import { assistantMessageLayout } from '@/features/agents/lib/assistant-conversation';
import { isChatActionVisible } from '@/features/agents/lib/assistant-actions';
import { GroupDetails, taskLabels, type GroupDetailTab } from './group-details';
import '@/features/agents/agents.css';
import { useBoostedApiClient } from '@/lib/api-context';
import { ApiError } from '@/lib/api';
import { conversationQueryOptions } from '@/lib/query-client';
import { machinePreferenceKey, useAppStore } from '@/lib/store';
import { AttachmentPreviewSplitGuard } from '@/components/attachment-preview-layout';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { AgentAvatar } from '@/features/agents/components/session/agent-avatar';
import { MarkdownContent } from '@/features/agents/components/session/chat-markdown';
import { assistantAttachmentsFromFiles, checkAssistantAttachmentLimits } from '@/features/agents/lib/assistant-attachments';
import type { AssistantAttachment } from '@/features/agents/types/assistant';
import { createGroupsApi } from './api';
import { DeleteGroupDialog } from './delete-group-dialog';
import { forgetGroup, groupLifetime } from './lifecycle';
import { GroupDialog } from './group-dialog';
import { GroupAvatar } from './group-avatar';
import { memberRoleNames } from './roles';
import { acceptGroupSnapshot, mergeGroupMessages, remainingGroupOutbox } from './state';
import type { GroupMessage, GroupPendingMessage, GroupState, GroupTask } from './types';
import './groups.css';

function persisted<T>(key: string, fallback: T): T {
  try { return JSON.parse(sessionStorage.getItem(key) ?? 'null') ?? fallback; } catch { return fallback; }
}
function persistValue(key: string, value: unknown) { try { sessionStorage.setItem(key, JSON.stringify(value)); } catch { /* Keep unsent content in memory when browser storage is full. */ } }
const errorText = (cause: unknown) => cause instanceof Error ? cause.message : 'Unable to complete this action.';
const CodexChatPanel = lazy(() => import('@/components/panels/codex-chat-panel').then((module) => ({ default: module.CodexChatPanel })));

export function GroupPanel({ groupId, headerTarget }: { groupId: string; headerTarget?: HTMLElement | null }) {
  const [chatId, setChatId] = useState<string>();
  return <AttachmentPreviewSplitGuard blocked={Boolean(chatId)}><div className="group-chat-layout" data-split={Boolean(chatId)}>
    <GroupConversation key={groupId} groupId={groupId} headerTarget={headerTarget} onOpenChat={setChatId} />
    {chatId && <aside className="group-coding-chat" aria-label="Agent coding chat">
      <header className="group-coding-chat-header"><MessageSquare className="size-4 text-muted-foreground" /><h2>Agent coding chat</h2><Button variant="ghost" size="icon-sm" aria-label="Close coding chat" onClick={() => setChatId(undefined)}><X /></Button></header>
      <Suspense fallback={<div className="empty-state">Loading chat…</div>}><CodexChatPanel key={chatId} threadId={chatId} onThreadChange={setChatId} /></Suspense>
    </aside>}
  </div></AttachmentPreviewSplitGuard>;
}

function GroupConversation({ groupId, headerTarget, onOpenChat }: { groupId: string; headerTarget?: HTMLElement | null; onOpenChat(chatId: string): void }) {
  const client = useBoostedApiClient();
  const groups = useMemo(() => createGroupsApi(client), [client]);
  const queryClient = useQueryClient();
  const lifetime = useMemo(() => groupLifetime(queryClient, groupId), [queryClient, groupId]);
  const persist = (key: string, value: unknown) => { if (!lifetime.deleted) persistValue(key, value); };
  const [deleting, setDeleting] = useState(false);
  const user = useAppStore((s) => s.user);
  const state = useQuery({
    ...conversationQueryOptions,
    queryKey: ['groups', groupId],
    enabled: !lifetime.deleted,
    queryFn: async () => {
      const next = await groups.read(groupId);
      const current = queryClient.getQueryData<GroupState>(['groups', groupId]);
      return acceptGroupSnapshot(current, next, groupId) ? next : current!;
    },
    refetchInterval: 5000,
  });
  useEffect(() => {
    // Recover a deletion missed while this client was disconnected.
    if (!lifetime.deleted && state.error instanceof ApiError && state.error.status === 404) {
      forgetGroup(queryClient, groupId, client.profileId);
    }
  }, [state.error, lifetime, queryClient, groupId, client.profileId]);
  const group = state.data;
  const draftKey = machinePreferenceKey('boosted.group-draft.' + groupId);
  const outboxKey = machinePreferenceKey('boosted.group-outbox.' + groupId);
  const [draft, setDraft] = useState(() => persisted<string>(draftKey, ''));
  const recipientsKey = machinePreferenceKey('boosted.group-recipients.' + groupId);
  const [recipients, setRecipients] = useState(() => persisted<string[]>(recipientsKey, []));
  const [attachments, setAttachments] = useState<AssistantAttachment[]>([]);
  const [outbox, setOutbox] = useState<GroupPendingMessage[]>(() => persisted<GroupPendingMessage[]>(outboxKey, []).map((m) => ({ ...m, status: 'failed', error: 'Message was not confirmed. Retry to check delivery.' })));
  const [older, setOlder] = useState<GroupMessage[]>([]);
  const [drawer, setDrawer] = useState(false);
  const [detailTab, setDetailTab] = useState<GroupDetailTab>('participants');
  const opener = useRef<HTMLElement | null>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const [following, setFollowing] = useState(true);
  const attachmentQueue = useRef(Promise.resolve());
  const attachmentList = useRef<AssistantAttachment[]>([]);
  const [editing, setEditing] = useState(false);
  const [creatingTask, setCreatingTask] = useState(false);
  const [editingTask, setEditingTask] = useState<GroupTask>();
  const [busy, setBusy] = useState(false);
  const [readingFiles, setReadingFiles] = useState(false);
  const [error, setError] = useState<string>();
  const fileInput = useRef<HTMLInputElement>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const mounted = useRef(true);
  const sendQueue = useRef(Promise.resolve());
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => persist(draftKey, draft), [draftKey, draft]);
  useEffect(() => persist(recipientsKey, recipients), [recipientsKey, recipients]);
  useEffect(() => {
    const node = textarea.current;
    if (node) { node.style.height = 'auto'; node.style.height = Math.min(160, Math.max(28, node.scrollHeight)) + 'px'; }
  }, [draft, group?.id]);
  useEffect(() => persist(outboxKey, outbox), [outboxKey, outbox]);
  useEffect(() => {
    if (group && user) setOutbox((old) => remainingGroupOutbox(group.messages, old, user.id, groupId));
  }, [group?.messages, groupId, user?.id]);
  const messages = mergeGroupMessages(older, group?.messages ?? []);
  useEffect(() => {
    if (follow.current && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight;
  }, [group?.version, outbox, attachments]);
  useEffect(() => {
    const node = scroll.current; const content = node?.firstElementChild;
    if (!node || !content || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => { if (follow.current) node.scrollTop = node.scrollHeight; });
    // Keyboard and composer resizing change the visible transcript height too.
    observer.observe(node);
    observer.observe(content); return () => observer.disconnect();
  }, [group?.id]);
  async function action(operation: () => Promise<unknown>) {
    setBusy(true); setError(undefined);
    try { await operation(); await queryClient.invalidateQueries({ queryKey: ['groups'] }); }
    catch (cause) { if (mounted.current) setError(errorText(cause)); }
    finally { if (mounted.current) setBusy(false); }
  }
  function dispatch(pending: GroupPendingMessage) {
    setOutbox((old) => old.map((m) => m.id === pending.id ? { ...m, status: 'sending', error: undefined } : m));
    sendQueue.current = sendQueue.current.then(async () => {
      try {
        await groups.send(groupId, pending.request);
        if (mounted.current) setOutbox((old) => old.filter((m) => m.id !== pending.id));
        else persist(outboxKey, persisted<GroupPendingMessage[]>(outboxKey, []).filter((m) => m.id !== pending.id));
        await queryClient.invalidateQueries({ queryKey: ['groups'] });
      } catch (cause) {
        const failed = { ...pending, status: 'failed' as const, error: errorText(cause) };
        if (mounted.current) setOutbox((old) => old.map((m) => m.id === pending.id ? failed : m));
        else persist(outboxKey, persisted<GroupPendingMessage[]>(outboxKey, []).map((m) => m.id === pending.id ? failed : m));
      }
    });
  }
  function send() {
    if ((!draft.trim() && !attachments.length) || readingFiles) return;
    const id = crypto.randomUUID();
    const pending: GroupPendingMessage = { id, createdAt: new Date().toISOString(), status: 'sending', request: {
      clientMessageId: id, content: draft.trim() || 'Please look at the attached files.', recipientIds: recipients.filter((id) => group?.memberIds.includes(id)),
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, ...(attachments.length ? { attachments } : {}),
    } };
    setOutbox((old) => [...old, pending]);
    // Persist before network dispatch, including retries across navigation.
    persist(outboxKey, [...outbox, pending]);
    setDraft(''); setRecipients([]); setAttachments([]); attachmentList.current = []; follow.current = true; setFollowing(true); dispatch(pending); textarea.current?.focus();
  }
  function addFiles(files: File[]) {
    if (!files.length) return;
    setReadingFiles(true); setError(undefined);
    const queued = attachmentQueue.current.then(async () => {
      try {
        const added = await assistantAttachmentsFromFiles(files);
        if (!mounted.current) return;
        const next = [...attachmentList.current, ...added];
        checkAssistantAttachmentLimits(next); attachmentList.current = next; setAttachments(next);
      } catch (cause) { if (mounted.current) setError(errorText(cause)); }
    });
    attachmentQueue.current = queued;
    void queued.finally(() => { if (mounted.current && attachmentQueue.current === queued) setReadingFiles(false); });
  }
  function openDetails(tab: GroupDetailTab, trigger?: HTMLElement) {
    opener.current = trigger ?? textarea.current; setDetailTab(tab); setDrawer(true);
  }
  if (state.isPending) return <div className="empty-state">Loading group…</div>;
  if (!group) return <div className="empty-state"><p role="alert">{state.error?.message ?? 'Group unavailable.'}</p><Button onClick={() => void state.refetch()}>Retry</Button></div>;
  const agentName = (id: string | null) => group.members.find((m) => m.id === id)?.profile.name ?? 'Unassigned';
  const leader = group.members.find((member) => memberRoleNames(group.memberRoles[member.id]).includes('coordinator'))!;
  const running = group.executions.filter((e) => e.status === 'running' || e.status === 'waiting');
  const stopping = group.stopped && running.some((e) => e.status === 'running');
  const limited = group.requests.some((r) => r.limited);
  const chatMessages = [
    ...messages.map((message) => ({ ...message, inReplyTo: message.inReplyTo ? [message.inReplyTo] : undefined, role: message.senderType === 'user' && message.senderId === user?.id ? 'user' as const : 'assistant' as const, attachments: message.attachments ?? undefined, pending: undefined as GroupPendingMessage | undefined })),
    ...outbox.map((pending) => ({ id: pending.id, rootId: pending.id, senderId: user?.id ?? '', senderType: 'user' as const, senderName: user?.username ?? 'You', role: 'user' as const, content: pending.request.content, createdAt: pending.createdAt, recipientIds: pending.request.recipientIds, attachments: pending.request.attachments, kind: 'message' as const, pending })),
  ];
  function workSummary(rootId: string) {
    const tasks = group!.tasks.filter((task) => task.rootId === rootId);
    const executions = group!.executions.filter((execution) => execution.rootId === rootId);
    const receipts = group!.receipts.filter((receipt) => isChatActionVisible(receipt) && executions.some((execution) => execution.id === receipt.executionId));
    if (!tasks.length && !receipts.length && !executions.some((execution) => execution.error || execution.chatId)) return null;
    return <div className="group-work-summary">
      {tasks.map((task) => <button type="button" className="group-task-update" key={task.id} onClick={(event) => openDetails('tasks', event.currentTarget)}>
        {task.status === 'completed' ? <Check className="size-3.5 shrink-0" /> : ['running', 'awaiting_review'].includes(task.status) ? <LoaderCircle className="size-3.5 shrink-0 animate-spin motion-reduce:animate-none" /> : <ListTodo className="size-3.5 shrink-0" />}
        <span><strong>{task.title}</strong><small>{agentName(task.ownerId)} · {taskLabels[task.status]}</small></span>
      </button>)}
      {executions.filter((execution, index) => execution.chatId && executions.findIndex((other) => other.chatId === execution.chatId) === index).map((execution) => <button type="button" className="group-task-update" key={execution.id} onClick={() => onOpenChat(execution.chatId!)}><MessageSquare className="size-3.5 shrink-0" /><span>Open {agentName(execution.agentId)}’s chat</span></button>)}
      {group!.members.filter((member) => receipts.some((receipt) => receipt.agentId === member.id)).map((member) => <div key={member.id} className="group-work-tools"><span>{member.profile.name}</span><ActionGroup actions={receipts.filter((receipt) => receipt.agentId === member.id)} onOpenChat={onOpenChat} /></div>)}
      {executions.filter((execution) => execution.error && (!execution.taskId || group!.tasks.some((task) => task.id === execution.taskId && ['failed', 'blocked', 'interrupted'].includes(task.status)))).map((execution) => <p className="px-2 text-xs text-destructive" key={execution.id}>{agentName(execution.agentId)}: {execution.error}</p>)}
    </div>;
  }
  const control = () => void action(() => group.stopped || limited ? groups.resume(groupId) : groups.stop(groupId));
  const taggedMembers = group.members.filter((member) => recipients.includes(member.id));
  const recipientAvatars = taggedMembers.length ? taggedMembers : group.members;
  const recipientTitle = taggedMembers.length ? 'Tagged agents: ' + taggedMembers.map((member) => member.profile.name).join(', ') : 'Tag agents · Leader: ' + leader.profile.name;
  const pendingDeliveries = group.deliveries.filter((delivery) => ['queued', 'processing'].includes(delivery.status));
  const header = <header className="group-chat-header">
    <button type="button" className="group-chat-identity" aria-label="Participants and tasks" onClick={(event) => openDetails('participants', event.currentTarget)}>
      <GroupAvatar group={group} className="size-6 rounded-md" /><h1>{group.name}</h1><ChevronDown className="size-3 shrink-0 text-muted-foreground" />
    </button>
    <button type="button" className="session-icon-button group-tasks-trigger" aria-label="Group tasks" title="Group tasks" onClick={(event) => openDetails('tasks', event.currentTarget)}><ListTodo className="size-4" />{group.tasks.some((task) => !['completed', 'cancelled'].includes(task.status)) && <span className="group-task-dot" />}</button>
  </header>;
  return <section className="assistant-conversation group-conversation relative flex h-full min-h-0 flex-col overflow-hidden" aria-label={'Group ' + group.name}>
    {headerTarget ? createPortal(header, headerTarget) : header}
    <div className="assistant-conversation-scroll group-chat-scroll min-h-0 flex-1 overflow-y-auto px-5 pb-4 pt-6 md:px-8" ref={scroll} onScroll={() => {
      const node = scroll.current; if (node) { follow.current = node.scrollHeight - node.scrollTop - node.clientHeight < 100; setFollowing(follow.current); }
    }}>
      <div className="session-conversation-column mx-auto">
        {messages.length > 0 && messages[0].sequence > 1 && <Button variant="ghost" size="sm" disabled={busy} onClick={() => void action(async () => {
          const node = scroll.current; const height = node?.scrollHeight ?? 0; const top = node?.scrollTop ?? 0;
          follow.current = false; setFollowing(false);
          const loaded = await groups.messages(groupId, messages[0].sequence); setOlder((old) => mergeGroupMessages(loaded, old));
          requestAnimationFrame(() => { if (node) node.scrollTop = top + node.scrollHeight - height; });
        })}>Load older messages</Button>}
        {!chatMessages.length && <div className="group-chat-empty"><h2>What should we work on?</h2><p>Talk to {leader.profile.name}, your group leader. They’ll delegate work and report results. You can also ask to assign a project, change roles, or add and remove agents here.</p>
          <div className="group-chat-suggestions">{['Plan a project together', 'Split up an implementation', 'Declare the team’s roles'].map((prompt) => <button key={prompt} type="button" onClick={() => { setDraft(prompt); textarea.current?.focus(); }}>{prompt}</button>)}</div>
        </div>}
        {assistantMessageLayout(chatMessages).map(({ message, showTimestamp, startGroup, showSentTime, showDeliveryStatus }, index) => {
          const boundary = startGroup || chatMessages[index - 1]?.senderId !== message.senderId;
          const member = group.members.find((peer) => peer.id === message.senderId);
          return <div className={cn('min-w-0', boundary ? 'mt-4 first:mt-0' : 'mt-1')} key={message.id}>
            {showTimestamp && <time className="mb-3 mt-6 block text-center text-[12px] text-muted-foreground" dateTime={message.createdAt}>{new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(message.createdAt))}</time>}
            <article className="group/message min-w-0" aria-label={message.role === 'user' ? 'Your message' : message.senderName + ' reply'} tabIndex={showSentTime ? 0 : undefined}>
              {message.role !== 'user' && boundary && <div className="group-message-sender"><AgentAvatar name={message.senderName} avatar={member?.profile.avatar} className="size-5" /><span>{message.senderName}</span>{message.kind === 'request' && <small>asked a peer</small>}</div>}
              {message.recipientIds.length > 0 && (message.kind === 'request' || message.recipientIds.length < group.memberIds.length) && <p className={cn('group-message-recipient', message.role === 'user' && 'text-right')}>To {message.recipientIds.map(agentName).join(', ')}</p>}
              {message.attachments?.length ? <div className={cn('mb-2 flex max-w-[88%]', message.role === 'user' && 'ml-auto justify-end')}><AssistantAttachmentList attachments={message.attachments} /></div> : null}
              {message.content && <div className={cn('assistant-message-bubble w-fit min-w-0 max-w-[88%] rounded-[22px] px-4 py-2.5', message.role === 'user' ? 'assistant-message-user ml-auto text-white' : 'assistant-message-reply text-foreground')}><MarkdownContent content={message.content} saveCheckbox={!message.pending && !group.executions.some((e) => ['running', 'waiting'].includes(e.status)) ? async (edit) => {
                try { await client.toggleMarkdownCheckbox(`/groups/${encodeURIComponent(groupId)}`, 'message', message.id, edit); }
                finally { void queryClient.invalidateQueries({ queryKey: ['groups', groupId] }); }
              } : undefined} /></div>}
              {message.pending ? <div role="status" className="mt-1 flex items-center justify-end gap-1 pr-4 text-[11px] text-muted-foreground">
                {message.pending.status === 'sending' ? <><LoaderCircle className="size-3 animate-spin" />Sending…</> : <><TriangleAlert className="size-3 text-destructive" /><span title={message.pending.error}>Not sent</span><button type="button" className="underline underline-offset-2" aria-label="Retry message" onClick={() => dispatch(message.pending!)}>Retry</button></>}
              </div> : showSentTime && <p aria-live={showDeliveryStatus ? 'polite' : undefined} className={cn('mt-1 pr-4 text-right text-[11px] text-muted-foreground', !showDeliveryStatus && 'opacity-0 group-hover/message:opacity-100 group-focus-within/message:opacity-100')}>Delivered</p>}
            </article>
            {message.senderType === 'user' && !message.pending && workSummary(message.rootId)}
          </div>;
        })}
        {Array.from(new Set([...group.tasks, ...group.executions].map((item) => item.rootId))).filter((rootId) => !messages.some((message) => message.senderType === 'user' && message.rootId === rootId)).map((rootId) => <div key={rootId}>{workSummary(rootId)}</div>)}
        {!group.stopped && running.filter((execution) => execution.status === 'running' && execution.activity).map((execution) => <div key={execution.id} className="mt-3" role="status" aria-label={agentName(execution.agentId) + ' is typing'}>
          <div className="group-message-sender"><span>{agentName(execution.agentId)}</span></div>
          <div className="assistant-message-bubble assistant-message-reply w-fit rounded-[22px] px-4 py-2.5 text-muted-foreground"><span aria-hidden="true" className="animate-pulse tracking-widest motion-reduce:animate-none">•••</span></div>
        </div>)}
      </div>
    </div>
    <div className="session-composer relative shrink-0">
      {!following && <Button type="button" className="absolute -top-9 right-0 z-20 shrink-0 rounded-full shadow-lg" variant="secondary" size="icon-sm" aria-label="Scroll to bottom" title="Scroll to bottom" onClick={() => { if (scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight; follow.current = true; setFollowing(true); }}><ArrowDown /></Button>}
      <div className="session-conversation-column mx-auto">
      {(group.stopped || limited) && <div className="group-chat-notice"><p>{limited ? 'Exchange limit reached. Continue when ready.' : group.stopReason === 'restart' ? 'Interrupted by a server restart. Review progress, then resume.' : 'Group stopped. Your messages and work are saved.'}</p><button type="button" disabled={busy || stopping} onClick={control}><Play className="size-3" />{limited ? 'Continue' : 'Resume'}</button></div>}
      {(error || state.error) && <p role="alert" className="mb-3 rounded-xl border border-destructive/20 bg-destructive/5 px-3 py-2 text-xs leading-5 text-destructive">{error ?? state.error?.message}</p>}
      {attachments.length > 0 && <div className="mb-2"><AssistantAttachmentList attachments={attachments} onRemove={(id) => { const next = attachmentList.current.filter((file) => file.id !== id); attachmentList.current = next; setAttachments(next); }} /></div>}
      {readingFiles && <p role="status" className="mb-2 text-xs text-muted-foreground">Attaching files…</p>}
      <form className="assistant-message-composer group-message-composer relative flex items-end gap-2 rounded-[25px] border border-border/40 bg-secondary p-2" onSubmit={(event) => { event.preventDefault(); send(); }}>
        <input ref={fileInput} aria-label="Select attachments" type="file" multiple hidden onChange={(event) => { addFiles(Array.from(event.target.files ?? [])); event.target.value = ''; }} />
        <button type="button" className="session-icon-button disabled:opacity-40" aria-label="Attach files or images" disabled={readingFiles} onClick={() => fileInput.current?.click()}><Plus className="size-4" /></button>
        <DropdownMenu><DropdownMenuTrigger asChild><button type="button" className="group-recipient-trigger" aria-label="Message recipients" title={recipientTitle}><span className="group-recipient-avatars">{recipientAvatars.slice(0, 4).map((member) => <AgentAvatar key={member.id} name={member.profile.name} avatar={member.profile.avatar} className="size-5 text-[9px]" />)}{recipientAvatars.length > 4 && <span className="group-recipient-overflow">+{recipientAvatars.length - 4}</span>}</span><ChevronDown className="size-3 shrink-0 text-muted-foreground" /></button></DropdownMenuTrigger><DropdownMenuContent side="top" align="end" sideOffset={8}><DropdownMenuLabel>Tag agents</DropdownMenuLabel><DropdownMenuItem onSelect={() => setRecipients([])}>Leader · {leader.profile.name}</DropdownMenuItem><DropdownMenuItem onSelect={() => setRecipients([...group.memberIds])}>Everyone</DropdownMenuItem><DropdownMenuSeparator />{group.members.map((member) => <DropdownMenuCheckboxItem key={member.id} checked={recipients.includes(member.id)} onSelect={(event) => event.preventDefault()} onCheckedChange={(checked) => setRecipients((old) => checked ? [...old, member.id] : old.filter((id) => id !== member.id))}><AgentAvatar name={member.profile.name} avatar={member.profile.avatar} className="size-5" />{member.profile.name}</DropdownMenuCheckboxItem>)}</DropdownMenuContent></DropdownMenu>
        <textarea ref={textarea} aria-label="Message group" className="block max-h-40 min-h-7 min-w-0 flex-1 resize-none bg-transparent py-1 text-[14px] leading-5 outline-none placeholder:text-muted-foreground" rows={1} maxLength={32000} placeholder={taggedMembers.length ? 'Message selected agents' : 'Message ' + leader.profile.name} value={draft} onChange={(event) => setDraft(event.target.value)} onPaste={(event) => {
          const images = Array.from(event.clipboardData.files).filter((file) => file.type.startsWith('image/')); if (images.length) { event.preventDefault(); addFiles(images); }
        }} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); send(); } }} />
        {!group.stopped && (running.length > 0 || pendingDeliveries.length > 0) && <button type="button" className="grid size-8 shrink-0 place-items-center rounded-full text-muted-foreground hover:bg-accent disabled:opacity-40" aria-label="Stop group" disabled={busy} onClick={control}><Square className="size-3 fill-current" /></button>}
        <button type="submit" className="assistant-message-send grid size-8 shrink-0 place-items-center rounded-full text-white disabled:opacity-40" aria-label="Send message" disabled={(!draft.trim() && !attachments.length) || readingFiles}><ArrowUp className="size-4" /></button>
      </form>
    </div></div>
    <GroupDetails group={group} open={drawer} onOpenChange={setDrawer} tab={detailTab} onTabChange={setDetailTab} busy={busy} error={error} opener={opener} onOpenChat={onOpenChat} onDelete={() => setDeleting(true)} onControl={control} onEdit={() => setEditing(true)} onCreateTask={() => setCreatingTask(true)} onEditTask={setEditingTask} onTaskAction={(task, next) => void action(() => groups.taskAction(groupId, task.id, next))} />
    <DeleteGroupDialog group={group} open={deleting} onOpenChange={setDeleting} />
    <GroupDialog open={editing} onOpenChange={setEditing} initial={group} />
    <AssignmentDialog key={editingTask?.id ?? 'new'} group={group} initial={editingTask} open={creatingTask || Boolean(editingTask)} onOpenChange={(open) => { if (!open) { setCreatingTask(false); setEditingTask(undefined); } }} onSave={async (body) => {
      if (editingTask) await groups.updateTask(groupId, editingTask.id, body); else await groups.createTask(groupId, body);
      await queryClient.invalidateQueries({ queryKey: ['groups'] }); setCreatingTask(false); setEditingTask(undefined);
    }} />
  </section>;
}

function AssignmentDialog({ group, initial, open, onOpenChange, onSave }: {
  group: GroupState; initial?: GroupTask; open: boolean; onOpenChange(open: boolean): void;
  onSave(body: { title: string; instructions: string; expectedResult: string; ownerId?: string; dependencyIds: string[] }): Promise<void>;
}) {
  const [title, setTitle] = useState(initial?.title ?? '');
  const [instructions, setInstructions] = useState(initial?.instructions ?? '');
  const [expectedResult, setExpected] = useState(initial?.expectedResult ?? '');
  const [owner, setOwner] = useState(initial?.ownerId ?? '');
  const [dependencies, setDependencies] = useState(initial?.dependencyIds ?? []);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent><form onSubmit={(event) => { event.preventDefault(); setSaving(true); setError(undefined); void onSave({ title, instructions, expectedResult, ...(owner ? { ownerId: owner } : {}), dependencyIds: dependencies }).catch((cause) => setError(errorText(cause))).finally(() => setSaving(false)); }}>
    <DialogHeader><DialogTitle>{initial ? 'Edit assignment' : 'New assignment'}</DialogTitle><DialogDescription>Another peer must review the result before completion.</DialogDescription></DialogHeader>
    <label className="group-field">Title<input required value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} /></label>
    <label className="group-field">Instructions<textarea required value={instructions} onChange={(e) => setInstructions(e.target.value)} /></label>
    <label className="group-field">Expected result<textarea required value={expectedResult} onChange={(e) => setExpected(e.target.value)} /></label>
    <div className="group-field"><span id="group-assignment-owner-label">Owner</span><Select value={owner || '__unassigned__'} onValueChange={(value) => setOwner(value === '__unassigned__' ? '' : value)}><SelectTrigger aria-labelledby="group-assignment-owner-label"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="__unassigned__">Let agents claim it</SelectItem>{group.members.map((m) => <SelectItem key={m.id} value={m.id}>{m.profile.name}</SelectItem>)}</SelectContent></Select></div>
    <fieldset className="group-roster"><legend>Dependencies</legend>{group.tasks.filter((t) => t.id !== initial?.id && t.status !== 'cancelled').map((t) => <label key={t.id}><input type="checkbox" checked={dependencies.includes(t.id)} onChange={(e) => setDependencies((old) => e.target.checked ? [...old, t.id] : old.filter((id) => id !== t.id))} />{t.title}</label>)}</fieldset>
    {error && <p role="alert" className="mb-3 text-xs text-destructive">{error}</p>}
    <DialogFooter><Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button><Button type="submit" disabled={saving || !title.trim() || !instructions.trim() || !expectedResult.trim()}>{saving ? 'Saving…' : 'Save assignment'}</Button></DialogFooter>
  </form></DialogContent></Dialog>;
}
