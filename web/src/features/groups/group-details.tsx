import { useRef, useSyncExternalStore } from 'react';
import { Tabs } from '@base-ui/react/tabs';
import { CheckCheck, Folder, ListTodo, LoaderCircle, Pencil, Play, Plus, Square, Users } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { AgentAvatar } from '@/features/agents/components/session/agent-avatar';
import { MarkdownContent } from '@/features/agents/components/session/chat-markdown';
import { ActionGroup } from '@/features/agents/components/session/conversation-tools';
import { taskOverlaps } from './state';
import { memberRoleLabel } from './roles';
import type { GroupState, GroupTask } from './types';

export const taskLabels = { queued: 'To do', running: 'Running', awaiting_review: 'Awaiting peer review', completed: 'Reviewed and complete', blocked: 'Blocked', failed: 'Failed', interrupted: 'Interrupted', cancelled: 'Cancelled' };
export type GroupDetailTab = 'participants' | 'tasks' | 'activity';
const compactQuery = '(max-width: 900px)';
function subscribeCompact(callback: () => void) {
  const query = window.matchMedia(compactQuery);
  query.addEventListener('change', callback);
  return () => query.removeEventListener('change', callback);
}

export function GroupDetails({ group, open, onOpenChange, tab, onTabChange, busy, error, opener, onControl, onEdit, onCreateTask, onEditTask, onTaskAction }: {
  group: GroupState; open: boolean; onOpenChange(open: boolean): void;
  tab: GroupDetailTab; onTabChange(tab: GroupDetailTab): void; busy: boolean; error?: string;
  opener: React.RefObject<HTMLElement | null>; onControl(): void; onEdit(): void; onCreateTask(): void;
  onEditTask(task: GroupTask): void; onTaskAction(task: GroupTask, action: 'cancel' | 'retry'): void;
}) {
  const compact = useSyncExternalStore(subscribeCompact, () => window.matchMedia(compactQuery).matches, () => false);
  const afterClose = useRef<(() => void) | null>(null);
  const closeWith = (action: () => void) => { afterClose.current = action; onOpenChange(false); };
  const running = group.executions.filter((e) => ['running', 'waiting'].includes(e.status));
  const limited = group.requests.some((r) => r.limited);
  const stopping = group.stopped && running.some((e) => e.status === 'running');
  const name = (id: string | null) => group.members.find((m) => m.id === id)?.profile.name ?? 'Unassigned';
  return <Dialog open={open} onOpenChange={onOpenChange} modal={compact}>
    <DialogContent className="group-details-panel assistant-profile-panel translate-x-0 translate-y-0 flex flex-col gap-0 overflow-hidden p-0" onCloseAutoFocus={(event) => {
      event.preventDefault();
      const action = afterClose.current; afterClose.current = null;
      if (action) action(); else opener.current?.focus({ preventScroll: true });
    }}>
      <div className="flex shrink-0 items-center gap-3 px-5 pb-4 pt-5 pr-12">
        <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-secondary"><Users className="size-5 text-muted-foreground" /></span>
        <div className="min-w-0"><DialogTitle className="truncate text-base font-medium">{group.name}</DialogTitle>
          <DialogDescription className="mt-1 text-xs">{group.memberIds.length} participants · {group.stopped ? 'Stopped' : running.length ? 'Working now' : 'Ready to chat'}</DialogDescription>
        </div>
      </div>
      <Tabs.Root value={tab} onValueChange={(value) => onTabChange(value as GroupDetailTab)} className="flex min-h-0 flex-1 flex-col">
        <Tabs.List aria-label="Group details" className="group-details-tabs">
          <Tabs.Tab value="participants">Participants</Tabs.Tab>
          <Tabs.Tab value="tasks">Tasks{group.tasks.length > 0 && <span>{group.tasks.length}</span>}</Tabs.Tab>
          <Tabs.Tab value="activity">Activity</Tabs.Tab>
        </Tabs.List>
        <div className="group-details-content">
          {error && <p role="alert" className="mb-3 text-xs text-destructive">{error}</p>}
          <Tabs.Panel value="participants" className="outline-none">
            <div className="group-participant-list">{group.members.map((member) => {
              const active = running.find((e) => e.agentId === member.id);
              return <div className="group-participant" key={member.id}>
                <AgentAvatar name={member.profile.name} avatar={member.profile.avatar} className="size-9" />
                <div className="min-w-0"><p>{member.profile.name}</p><small>{memberRoleLabel(group.memberRoles[member.id])}</small>{group.memberRoles[member.id].responsibilities && <p className="group-participant-scope">{group.memberRoles[member.id].responsibilities}</p>}{active && <small>{active.activity === 'responding' && active.status === 'running' ? 'Typing…' : 'Working…'}</small>}</div>
                {active && <LoaderCircle aria-label="Active" className="ml-auto size-3.5 animate-spin text-muted-foreground motion-reduce:animate-none" />}
              </div>;
            })}</div>
            <div className="group-settings-rows">
              <div><Folder className="size-3.5 shrink-0 text-muted-foreground" /><span>{group.workingDirectory ?? 'No project'}</span></div>
              <button type="button" disabled={!group.stopped || running.length > 0 || busy} onClick={() => closeWith(onEdit)}><Pencil className="size-3.5" /><span>Edit group</span></button>
            </div>
            {!group.stopped && <p className="mt-2 text-[11px] leading-5 text-muted-foreground">Stop the group to edit its settings. You can also ask the leader in chat.</p>}
            <Button className="mt-4 w-full" variant="secondary" size="sm" disabled={busy || stopping} onClick={onControl}>
              {group.stopped || limited ? <Play /> : <Square />}{limited ? 'Continue' : group.stopped ? 'Resume' : 'Stop group'}
            </Button>
          </Tabs.Panel>
          <Tabs.Panel value="tasks" className="outline-none">
            <div className="mb-3 flex items-center justify-between"><p className="text-xs text-muted-foreground">Assignments & peer reviews</p><Button variant="ghost" size="sm" onClick={() => closeWith(onCreateTask)}><Plus />New task</Button></div>
            {!group.tasks.length && <div className="group-details-empty"><ListTodo className="size-5" /><p>Give the group a task in chat.</p><small>Assignments and reviews will appear here.</small></div>}
            <div className="group-task-list">{group.tasks.map((task) => <article className="group-task" key={task.id}>
              <header><strong>{task.title}</strong><span data-status={task.status}>{taskLabels[task.status]}</span></header>
              <p>{name(task.ownerId)}{task.reviewerId && ' · Review: ' + name(task.reviewerId)}</p>
              <details><summary>Assignment and results</summary><div className="group-task-detail">
                <MarkdownContent content={task.instructions} /><p><strong>Expected:</strong> {task.expectedResult}</p>
                {task.workingDirectory && <p className="group-path">{task.workingDirectory}</p>}
                {task.dependencyIds.length > 0 && <p>Depends on: {task.dependencyIds.map((id) => group.tasks.find((t) => t.id === id)?.title ?? id).join(', ')}</p>}
                {task.fileResponsibilities.length > 0 && <p>Files: {task.fileResponsibilities.join(', ')}</p>}
                {taskOverlaps(task.id, group.tasks).length > 0 && <p className="text-warning">Shared files with {taskOverlaps(task.id, group.tasks).map((t) => t.title).join(', ')}</p>}
                {task.result && <MarkdownContent content={task.result} />}
                {task.verification && <p><strong>Verification:</strong> {task.verification}</p>}
                {group.reviews.filter((r) => r.taskId === task.id).map((review) => <p key={review.id}><strong>{name(review.reviewerId)} · {review.decision === 'approve' ? 'Approved' : 'Changes requested'}:</strong> {review.evidence}</p>)}
                {group.receipts.some((r) => r.taskId === task.id) && <ActionGroup showAll actions={group.receipts.filter((r) => r.taskId === task.id)} />}
              </div></details>
              {task.error && <p className="text-destructive">{task.error}</p>}
              <footer>
                {!['completed', 'cancelled'].includes(task.status) && <Button size="sm" variant="ghost" disabled={busy} onClick={() => onTaskAction(task, 'cancel')}>Cancel task</Button>}
                {(['failed', 'blocked', 'interrupted', 'cancelled'].includes(task.status) || task.status === 'awaiting_review' && task.error) && <Button size="sm" variant="outline" disabled={busy} onClick={() => onTaskAction(task, 'retry')}>Retry{task.status === 'awaiting_review' ? ' review' : ''}</Button>}
                {group.stopped && !['running', 'awaiting_review', 'completed', 'cancelled'].includes(task.status) && <Button size="sm" variant="ghost" onClick={() => closeWith(() => onEditTask(task))}>Edit assignment</Button>}
              </footer>
            </article>)}</div>
            {group.tasks.length > 0 && group.tasks.every((t) => t.status === 'completed') && <p className="mt-4 flex items-center gap-2 text-xs text-muted-foreground"><CheckCheck className="size-4 text-success" />All assignments reviewed</p>}
          </Tabs.Panel>
          <Tabs.Panel value="activity" className="outline-none">
            {!group.receipts.length && <div className="group-details-empty"><p>No activity yet.</p><small>Tool results and coding runs will appear here.</small></div>}
            {group.members.filter((m) => group.receipts.some((r) => r.agentId === m.id)).map((member) => <section className="mb-5" key={member.id}><div className="mb-2 flex items-center gap-2 text-xs"><AgentAvatar name={member.profile.name} avatar={member.profile.avatar} className="size-5" />{member.profile.name}</div><ActionGroup showAll actions={group.receipts.filter((r) => r.agentId === member.id)} /></section>)}
            {group.executions.filter((e) => e.error).map((e) => <p className="mb-2 text-xs leading-5 text-muted-foreground" key={e.id}>{name(e.agentId)}: {e.error}</p>)}
          </Tabs.Panel>
        </div>
      </Tabs.Root>
    </DialogContent>
  </Dialog>;
}
