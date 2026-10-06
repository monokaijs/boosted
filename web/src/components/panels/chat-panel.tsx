import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUpRight, MessagesSquare, Bot, Check, ChevronDown, ChevronRight, CircleStop, ExternalLink, FileDiff, FolderOpen, GitBranch, History, ListChecks, ListTodo, LoaderCircle, Plus, RefreshCw, Send, TerminalSquare, UserRound, X } from "lucide-react";
import { TaskMarkdown, type SaveCheckbox } from "@/components/assistant-ui/task-markdown";
import { CodexQuestionForm } from "@/components/assistant-ui/codex-question-form";
import { AgentMentionComposer, agentMention } from "@/components/agent-mention-composer";
import { AttachmentPreview } from "@/components/attachment-preview";
import { Badge } from "@/components/ui/badge";
import { CodexModeSelect } from "@/components/assistant-ui/codex-mode-select";
import { WorkspaceFileProvider, workspaceFileMarkdownComponents, workspaceMarkdownUrlTransform } from "@/components/assistant-ui/workspace-file-markdown";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api";
import { useBoostedApiClient } from "@/lib/api-context";
import { machinePreferenceKey, useAppStore } from "@/lib/store";
import { openExternalUrl } from "@/lib/runtime";
import { useWorkspaceState } from "@/lib/workspace-state";
import { conversationQueryOptions } from "@/lib/query-client";
import { taskStatusMeta } from "@/lib/status";
import type { AssistantSummary } from "@/features/agents/types/assistant";
import type { CodexAccessOption, CodexCollaborationMode, CodexQuestion, TaskEvent, TaskPlan } from "@/lib/types";
import { cn, relativeTime } from "@/lib/utils";
import "./chat-panel.css";

function textPayload(event: TaskEvent) {
  return String(event.payload.text ?? event.payload.message ?? event.payload.command ?? "");
}

function markdownPlanStep(plan: TaskPlan) {
  if (plan.markdown?.trim() || plan.steps.length !== 1) return undefined;
  const [step] = plan.steps;
  return /(?:^|\n)\s*(?:#{1,6}\s|[-*+]\s|\d+[.)]\s)|\*\*|`/.test(step.step) ? step : undefined;
}

function GitlabActivityPanel({ taskId, issueUrl, onClose }: { taskId: string; issueUrl: string; onClose(): void }) {
  const activity = useQuery({ queryKey: ["task-source-activity", taskId], queryFn: () => api.taskSourceActivity(taskId) });
  useEffect(() => {
    const close = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [onClose]);
  return <div className="task-source-activity-layer">
    <button type="button" className="task-source-activity-scrim" aria-label="Close GitLab activity" onClick={onClose} />
    <aside className="task-source-activity-panel" aria-label="GitLab issue activity">
      <header className="task-source-activity-header">
        <div className="min-w-0"><div className="flex items-center gap-2 text-sm font-semibold"><GitBranch className="size-4 text-[#FC6D26]" />GitLab activity</div><p className="mt-0.5 text-[11px] text-muted-foreground">Comments and system updates from the imported issue.</p></div>
        <Button variant="ghost" size="icon-sm" aria-label="Refresh GitLab activity" title="Refresh" onClick={() => void activity.refetch()} disabled={activity.isFetching}><RefreshCw className={cn(activity.isFetching && "animate-spin")} /></Button>
        <Button variant="ghost" size="icon-sm" aria-label="Close GitLab activity" onClick={onClose}><X /></Button>
      </header>
      <ScrollArea className="min-h-0 flex-1">
        <div className="task-source-activity-content">
          <Button variant="secondary" size="sm" className="w-full" onClick={() => void openExternalUrl(issueUrl)}><ExternalLink />Open issue in GitLab</Button>
          {activity.isLoading && <div className="grid justify-items-center gap-2 py-16 text-xs text-muted-foreground"><LoaderCircle className="size-4 animate-spin" />Loading issue activity…</div>}
          {activity.error && <div className="grid gap-3 py-10 text-center text-xs text-destructive"><p>{activity.error.message}</p><Button variant="secondary" size="sm" className="justify-self-center" onClick={() => void activity.refetch()}>Try again</Button></div>}
          {!activity.isLoading && !activity.error && activity.data?.items.length === 0 && <div className="py-16 text-center text-xs text-muted-foreground">No GitLab activity yet.</div>}
          {activity.data?.items.map((item) => <article key={item.id} className="task-source-activity-item">
            <div className="task-source-activity-avatar">{item.author.name.trim().charAt(0).toUpperCase() || "G"}</div>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5"><span className="text-xs font-medium">{item.author.name}</span>{item.author.username && <span className="text-[10px] text-muted-foreground">@{item.author.username}</span>}<time className="ml-auto text-[10px] text-muted-foreground" dateTime={item.createdAt} title={new Date(item.createdAt).toLocaleString()}>{relativeTime(item.createdAt)}</time></div>
              {item.system && <p className="mt-1 text-[10px] font-medium uppercase tracking-[0.08em] text-muted-foreground">System update</p>}
              <TaskMarkdown className="aui-markdown selectable-text mt-1 text-xs" content={item.body} />
            </div>
          </article>)}
          {activity.data?.truncated && <p className="py-4 text-center text-[10px] text-muted-foreground">Showing the 100 most recent activities.</p>}
        </div>
      </ScrollArea>
    </aside>
  </div>;
}

function questionsFromEvent(event: TaskEvent | undefined): CodexQuestion[] {
  if (!Array.isArray(event?.payload.questions)) return [];
  return event.payload.questions.flatMap((value) => {
    if (!value || typeof value !== "object") return [];
    const question = value as Record<string, unknown>;
    if (typeof question.id !== "string" || typeof question.question !== "string") return [];
    const options = Array.isArray(question.options) ? question.options.flatMap((option) => {
      if (!option || typeof option !== "object") return [];
      const record = option as Record<string, unknown>;
      return typeof record.label === "string" ? [{ label: record.label, description: typeof record.description === "string" ? record.description : "" }] : [];
    }) : undefined;
    return [{ id: question.id, header: typeof question.header === "string" ? question.header : "", question: question.question, options, isOther: question.isOther === true, isSecret: question.isSecret === true }];
  });
}

function ToolEvent({ event }: { event: TaskEvent }) {
  const [open, setOpen] = useState(false);
  const isCommand = event.kind === "command" || event.kind === "command_output";
  const Icon = isCommand ? TerminalSquare : FileDiff;
  const title = isCommand ? String(event.payload.command ?? "Command output") : String(event.payload.path ?? "Files changed");
  const detail = String(event.payload.output ?? event.payload.diff ?? event.payload.summary ?? "");
  return (
    <div className="my-2 overflow-hidden rounded-md border border-border bg-background/35">
      <button className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs hover:bg-accent/50" onClick={() => setOpen(!open)}>
        {open ? <ChevronDown className="size-3.5 text-muted-foreground" /> : <ChevronRight className="size-3.5 text-muted-foreground" />}
        <Icon className="size-3.5 text-muted-foreground" /><span className="min-w-0 flex-1 truncate font-mono">{title}</span>
        {event.payload.exitCode !== undefined && <Badge variant={event.payload.exitCode === 0 ? "success" : "danger"}>exit {String(event.payload.exitCode)}</Badge>}
      </button>
      {open && detail && <pre className="max-h-72 overflow-auto border-t border-border p-3 font-mono text-[11px] leading-5 text-muted-foreground whitespace-pre-wrap">{detail}</pre>}
    </div>
  );
}

function TimelineEvent({ event, saveCheckbox, onReply }: { event: TaskEvent; saveCheckbox?: SaveCheckbox; onReply?(name: string, agentId?: string): void }) {
  if (["command", "command_output", "file_change"].includes(event.kind)) return <ToolEvent event={event} />;
  if (event.kind === "status_changed" || event.kind === "system") {
    return <div className="my-3 flex items-center gap-2 text-[11px] text-muted-foreground"><span className="h-px flex-1 bg-border" /><span>{textPayload(event)}</span><span className="h-px flex-1 bg-border" /></div>;
  }
  if (event.kind === "plan_updated") {
    return <div className="my-3 flex items-center gap-2 text-[11px] text-muted-foreground"><span className="h-px flex-1 bg-border" /><ListChecks className="size-3.5" /><span>Plan updated</span><span className="h-px flex-1 bg-border" /></div>;
  }
  if (event.kind === "reasoning") {
    return <details className="my-2 rounded-md border border-border/70 bg-background/20 px-3 py-2 text-xs text-muted-foreground"><summary className="cursor-pointer select-none">Reasoning summary</summary><TaskMarkdown className="aui-markdown selectable-text mt-2 leading-5" content={textPayload(event)} components={workspaceFileMarkdownComponents} urlTransform={workspaceMarkdownUrlTransform} /></details>;
  }
  const user = event.kind === "user_message";
  const error = event.kind === "error";
  return (
    <article className={cn("chat-message-enter group flex gap-3 py-3", user && "flex-row-reverse")} aria-label={event.payload.replyTo ? `Reply from ${event.payload.agentName ?? "agent"}` : undefined}>
      <div className={cn("mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md border", user ? "border-primary/20 bg-primary/10 text-primary" : error ? "border-destructive/25 bg-destructive/10 text-destructive" : "border-border bg-secondary text-muted-foreground")}>{user ? <UserRound className="size-3.5" /> : <Bot className="size-3.5" />}</div>
      <div className={cn("min-w-0 max-w-[84%]", user && "text-right")}>
        <div className="mb-1 text-[10px] text-muted-foreground">{user ? event.actorName ?? "You" : error ? "Error" : String(event.payload.agentName ?? "Codex")}</div>
        <div className={cn("selectable-text text-[13px] leading-5", user && "inline-block whitespace-pre-wrap rounded-lg bg-primary/10 px-3 py-2 text-left", error && "whitespace-pre-wrap text-destructive", !user && !error && "aui-markdown")}>
          {!error
            ? <TaskMarkdown className="aui-markdown" content={textPayload(event)} saveCheckbox={saveCheckbox} components={workspaceFileMarkdownComponents} urlTransform={workspaceMarkdownUrlTransform} />
            : textPayload(event)}
        </div>
        {user && Array.isArray(event.payload.agentNames) && event.payload.agentNames.length > 0 && <p className="mt-1 text-[10px] text-muted-foreground">{event.payload.agentNames.join(", ")} notified</p>}
        {typeof event.payload.chatId === "string" && <button type="button" className="task-agent-chat-link" onClick={() => window.dispatchEvent(new CustomEvent("boosted:open-codex-chat", { detail: { threadId: event.payload.chatId } }))}>
          <MessagesSquare className="size-4" /><span><strong>Open chat</strong><small>Continue with {String(event.payload.agentName ?? "the agent")}</small></span><ArrowUpRight className="size-4" />
        </button>}
        {typeof event.payload.agentName === "string" && onReply && <button type="button" className="task-agent-reply" onClick={() => onReply(event.payload.agentName as string, typeof event.payload.agentId === "string" ? event.payload.agentId : undefined)}>Reply to {event.payload.agentName}</button>}
      </div>
    </article>
  );
}

function chatTitle(prompt: string) {
  const firstLine = prompt.trim().split("\n").find(Boolean)?.replace(/\s+/g, " ") ?? "New chat";
  return firstLine.length > 72 ? `${firstLine.slice(0, 69)}…` : firstLine;
}

export function NewChatPanel() {
  const projectId = useAppStore((state) => state.selectedProjectId);
  const [prompt, setPrompt] = useWorkspaceState(`new-chat:${projectId ?? "none"}:draft`, "");
  const [model, setModel] = useState(() => localStorage.getItem(machinePreferenceKey("boosted.codex.model")) ?? "");
  const [reasoningEffort, setReasoningEffort] = useState(() => localStorage.getItem(machinePreferenceKey("boosted.codex.effort")) ?? "");
  const hasModelOverride = useRef(false);
  const [collaborationMode, setCollaborationMode] = useState<CodexCollaborationMode>(() => localStorage.getItem(machinePreferenceKey("boosted.codex.mode")) === "plan" ? "plan" : "default");
  const [accessMode, setAccessMode] = useState<CodexAccessOption["id"]>(() => {
    const stored = localStorage.getItem(machinePreferenceKey("boosted.codex.access"));
    return stored === "workspaceWrite" || stored === "readOnly" ? stored : "fullAccess";
  });
  const selectProject = useAppStore((state) => state.selectProject);
  const selectCodexChat = useAppStore((state) => state.selectCodexChat);
  const queryClient = useQueryClient();
  const projects = useQuery({ queryKey: ["projects"], queryFn: api.projects });
  const project = projects.data?.find((entry) => entry.id === projectId);
  const branches = useQuery({ queryKey: ["branches", projectId], queryFn: () => api.projectBranches(projectId!), enabled: Boolean(projectId) });
  const branch = useQuery({ queryKey: ["project-branch", projectId], queryFn: () => api.projectBranch(projectId!), enabled: Boolean(projectId), staleTime: 0 });
  const switchBranch = useMutation({
    mutationFn: ({ id, branch }: { id: string; branch: string }) => api.switchProjectBranch(id, branch),
    onMutate: ({ id }) => queryClient.cancelQueries({ queryKey: ["project-branch", id], exact: true }),
    onSuccess: (result, { id }) => {
      queryClient.setQueryData(["project-branch", id], result);
      void queryClient.invalidateQueries({ queryKey: ["branches", id] });
      void queryClient.invalidateQueries({ queryKey: ["files", `project:${id}`] });
      void queryClient.invalidateQueries({ queryKey: ["file", "project", id] });
    },
  });
  useEffect(() => { switchBranch.reset(); }, [projectId]);
  const codexOptions = useQuery({ queryKey: ["codex-options"], queryFn: api.codexOptions, staleTime: 60_000 });
  const selectedModel = codexOptions.data?.models.find((entry) => entry.model === model || entry.id === model);
  const selectedAccess = codexOptions.data?.accessModes.find((entry) => entry.id === accessMode);

  useEffect(() => {
    if (!codexOptions.data) return;
    const usePreset = codexOptions.data.hasModelPreset && !hasModelOverride.current;
    const nextModel = (usePreset ? undefined : codexOptions.data.models.find((entry) => entry.model === model || entry.id === model))
      ?? codexOptions.data.models.find((entry) => entry.model === codexOptions.data?.defaultModel)
      ?? codexOptions.data.models[0];
    if (nextModel && (nextModel.model !== model || (usePreset && nextModel.defaultReasoningEffort !== reasoningEffort))) {
      setModel(nextModel.model);
      setReasoningEffort(nextModel.defaultReasoningEffort);
      localStorage.setItem(machinePreferenceKey("boosted.codex.model"), nextModel.model);
      localStorage.setItem(machinePreferenceKey("boosted.codex.effort"), nextModel.defaultReasoningEffort);
    } else if (nextModel && !nextModel.supportedReasoningEfforts.some((effort) => effort.id === reasoningEffort)) {
      setReasoningEffort(nextModel.defaultReasoningEffort);
      localStorage.setItem(machinePreferenceKey("boosted.codex.effort"), nextModel.defaultReasoningEffort);
    }
    if (!codexOptions.data.accessModes.some((entry) => entry.id === accessMode)) {
      setAccessMode(codexOptions.data.defaultAccessMode);
      localStorage.setItem(machinePreferenceKey("boosted.codex.access"), codexOptions.data.defaultAccessMode);
    }
  }, [accessMode, codexOptions.data, model, reasoningEffort]);

  function selectModel(value: string) {
    hasModelOverride.current = true;
    const next = codexOptions.data?.models.find((entry) => entry.model === value);
    setModel(value);
    localStorage.setItem(machinePreferenceKey("boosted.codex.model"), value);
    if (next) {
      setReasoningEffort(next.defaultReasoningEffort);
      localStorage.setItem(machinePreferenceKey("boosted.codex.effort"), next.defaultReasoningEffort);
    }
  }

  function selectReasoningEffort(value: string) {
    hasModelOverride.current = true;
    setReasoningEffort(value);
    localStorage.setItem(machinePreferenceKey("boosted.codex.effort"), value);
  }

  function selectAccessMode(value: string) {
    const next = value as CodexAccessOption["id"];
    setAccessMode(next);
    localStorage.setItem(machinePreferenceKey("boosted.codex.access"), next);
  }

  const create = useMutation({
    mutationFn: async () => {
      const chat = await api.createCodexChat(project!.repoPath, model);
      await api.sendCodexMessage(chat.id, prompt.trim(), crypto.randomUUID(), { model, reasoningEffort, accessMode, collaborationMode });
      return chat;
    },
    onSuccess: (chat) => {
      selectCodexChat(chat.id);
      setPrompt("");
      void queryClient.invalidateQueries({ queryKey: ["codex-chats"] });
      window.dispatchEvent(new CustomEvent("boosted:open-codex-chat", { detail: { threadId: chat.id, title: chatTitle(prompt) } }));
    },
  });

  function sendMessage() {
    if (project && prompt.trim() && model && reasoningEffort && !switchBranch.isPending && !create.isPending) create.mutate();
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    sendMessage();
  }

  return (
    <div className="new-task-canvas">
      <div className="new-task-stack">
        <div className="new-chat-welcome"><Bot aria-hidden="true" /><h1 className="new-task-title">What should we work on{project ? <> in <span>{project.name}</span></> : " today"}?</h1></div>
        {project ? (
          <>
            <div className="new-task-context">
              <DropdownMenu>
                <DropdownMenuTrigger asChild><button type="button" className="new-task-option" disabled={create.isPending || switchBranch.isPending}><span>{project.name}</span><ChevronDown /></button></DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="w-64">
                  <DropdownMenuLabel>Project</DropdownMenuLabel>
                  <DropdownMenuRadioGroup value={project.id} onValueChange={(id) => { const next = projects.data?.find((entry) => entry.id === id); if (next) selectProject(next); }}>
                    {projects.data?.map((entry) => <DropdownMenuRadioItem key={entry.id} value={entry.id}><span className="truncate">{entry.name}</span></DropdownMenuRadioItem>)}
                  </DropdownMenuRadioGroup>
                </DropdownMenuContent>
              </DropdownMenu>
              <span className="context-divider" />
              <DropdownMenu onOpenChange={(open) => { if (open) { void branches.refetch(); void branch.refetch(); } }}>
                <DropdownMenuTrigger asChild><button type="button" className="new-task-option font-mono" aria-label="Select branch" disabled={create.isPending || switchBranch.isPending || !branch.data}>{switchBranch.isPending ? <LoaderCircle className="animate-spin" /> : <GitBranch />}<span>{branch.data?.branch ?? (branch.isPending ? "Loading branch…" : "Branch unavailable")}</span><ChevronDown /></button></DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="w-64">
                  <DropdownMenuLabel>Branch</DropdownMenuLabel>
                  <DropdownMenuRadioGroup value={branch.data?.branch} onValueChange={(next) => { if (next !== branch.data?.branch) switchBranch.mutate({ id: project.id, branch: next }); }}>
                    {branches.data?.map((entry) => <DropdownMenuRadioItem key={entry} value={entry}><span className="truncate font-mono">{entry}</span></DropdownMenuRadioItem>)}
                  </DropdownMenuRadioGroup>
                  {branches.isPending && <p className="px-2 py-1 text-xs text-muted-foreground">Loading branches…</p>}
                  {branches.data?.length === 0 && <p className="px-2 py-1 text-xs text-muted-foreground">No local branches</p>}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
            <form className="new-task-composer" onSubmit={submit}>
              <Textarea
                autoFocus
                className="new-task-input"
                placeholder="Ask anything…"
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
                onKeyDown={(event) => { if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); sendMessage(); } }}
              />
              <div className="new-task-footer">
                <span className="new-task-plus" aria-hidden="true"><Plus /></span>
                <CodexModeSelect value={collaborationMode} onChange={(mode) => { setCollaborationMode(mode); localStorage.setItem(machinePreferenceKey("boosted.codex.mode"), mode); }} disabled={create.isPending} />
                <span className="context-divider" />
                <DropdownMenu>
                  <DropdownMenuTrigger asChild><button type="button" className="new-task-option new-task-model-option"><Bot className="size-3.5" /><span className="max-w-40 truncate">{selectedModel?.displayName ?? (codexOptions.isLoading ? "Loading Codex…" : "Codex")}</span><ChevronDown /></button></DropdownMenuTrigger>
                  <DropdownMenuContent align="start" className="w-80 max-w-[calc(100vw-1rem)]">
                    <DropdownMenuLabel>Model</DropdownMenuLabel>
                    <DropdownMenuRadioGroup value={model} onValueChange={selectModel}>
                      {codexOptions.data?.models.map((entry) => <DropdownMenuRadioItem key={entry.id} value={entry.model}><span className="min-w-0"><span className="block font-medium text-foreground">{entry.displayName}</span>{entry.description && <span className="mt-0.5 block text-[10px] leading-4 text-muted-foreground">{entry.description}</span>}</span></DropdownMenuRadioItem>)}
                    </DropdownMenuRadioGroup>
                    {selectedModel && <><DropdownMenuSeparator /><DropdownMenuLabel>Reasoning effort</DropdownMenuLabel><DropdownMenuRadioGroup value={reasoningEffort} onValueChange={selectReasoningEffort}>{selectedModel.supportedReasoningEfforts.map((effort) => <DropdownMenuRadioItem key={effort.id} value={effort.id}><span><span className="block capitalize text-foreground">{effort.id}</span>{effort.description && <span className="mt-0.5 block text-[10px] leading-4 text-muted-foreground">{effort.description}</span>}</span></DropdownMenuRadioItem>)}</DropdownMenuRadioGroup></>}
                  </DropdownMenuContent>
                </DropdownMenu>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild><button type="button" className="new-task-option new-task-access-option ml-auto"><span>{selectedAccess?.label ?? "Full access"}</span><ChevronDown /></button></DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-72 max-w-[calc(100vw-1rem)]">
                    <DropdownMenuLabel>Codex access</DropdownMenuLabel>
                    <DropdownMenuRadioGroup value={accessMode} onValueChange={selectAccessMode}>
                      {codexOptions.data?.accessModes.map((entry) => <DropdownMenuRadioItem key={entry.id} value={entry.id}><span><span className="block font-medium text-foreground">{entry.label}</span><span className="mt-0.5 block text-[10px] leading-4 text-muted-foreground">{entry.description}</span></span></DropdownMenuRadioItem>)}
                    </DropdownMenuRadioGroup>
                  </DropdownMenuContent>
                </DropdownMenu>
                <span className="context-divider" />
                <Button type="button" onClick={sendMessage} className="new-task-send-button" variant="ghost" aria-label="Create chat" disabled={!prompt.trim() || !model || !reasoningEffort || create.isPending || switchBranch.isPending}>{create.isPending ? <LoaderCircle className="animate-spin" /> : <Send />}<span className="new-task-send-label">Send</span></Button>
              </div>
            </form>
            {create.error && <p className="mt-2 text-xs text-destructive">{create.error.message}</p>}
            {(branch.error || branches.error || switchBranch.error) && <p className="mt-2 text-xs text-destructive">{switchBranch.error?.message ?? branch.error?.message ?? branches.error?.message}</p>}
            {codexOptions.error && <p className="mt-2 text-xs text-destructive">{codexOptions.error.message}</p>}
          </>
        ) : (
          <div className="mt-4 grid justify-items-start gap-3 text-sm text-muted-foreground"><p>Open a Git repository folder before starting a Codex chat.</p><Button onClick={() => window.dispatchEvent(new CustomEvent("boosted:open-project"))}><FolderOpen />Open project</Button></div>
        )}
      </div>
    </div>
  );
}

export function TaskPanel({ onClose }: { onClose?: () => void } = {}) {
  const client = useBoostedApiClient();
  const selectedTaskId = useAppStore((state) => state.selectedTaskId);
  const [sourceActivityOpen, setSourceActivityOpen] = useState(false);
  const [message, setMessage] = useWorkspaceState(`task:${selectedTaskId ?? "none"}:draft`, "");
  const queryClient = useQueryClient();
  const commentInput = useRef<HTMLTextAreaElement>(null);
  const task = useQuery({
    ...conversationQueryOptions,
    queryKey: ["task", selectedTaskId],
    queryFn: () => api.task(selectedTaskId!),
    enabled: Boolean(selectedTaskId),
    refetchInterval: (query) => query.state.data?.status === "planning" || query.state.data?.status === "running" ? 1_000 : false,
  });
  const events = useQuery({ ...conversationQueryOptions, queryKey: ["events", selectedTaskId], queryFn: () => api.taskEvents(selectedTaskId!), enabled: Boolean(selectedTaskId), refetchInterval: 3_000 });
  const agents = useQuery({ queryKey: ["agents"], queryFn: () => client.featureRequest<AssistantSummary[]>("/agents"), refetchInterval: 5_000 });
  const send = useMutation({
    mutationFn: () => api.sendMessage(selectedTaskId!, message.trim()),
    onSuccess: () => { setMessage(""); void queryClient.invalidateQueries({ queryKey: ["events", selectedTaskId] }); void queryClient.invalidateQueries({ queryKey: ["task", selectedTaskId] }); },
  });
  const answerQuestions = useMutation({
    mutationFn: (answers: Record<string, { answers: string[] }>) => api.answerTaskQuestions(selectedTaskId!, answers),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["events", selectedTaskId] });
      void queryClient.invalidateQueries({ queryKey: ["task", selectedTaskId] });
      void queryClient.invalidateQueries({ queryKey: ["tasks"] });
    },
  });
  const markComplete = useMutation({
    mutationFn: (status: "done" | "review") => api.setTaskStatus(selectedTaskId!, status),
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: ["task", selectedTaskId] }); void queryClient.invalidateQueries({ queryKey: ["tasks"] }); },
  });
  const stop = useMutation({ mutationFn: () => api.stopTask(selectedTaskId!), onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["task", selectedTaskId] }) });
  const ordered = useMemo(() => [...(events.data ?? [])].sort((a, b) => a.id - b.id), [events.data]);

  useEffect(() => setSourceActivityOpen(false), [selectedTaskId]);

  if (!selectedTaskId) return <div className="empty-state"><ListTodo className="size-8" /><p>Select a task to open its details and chat.</p></div>;
  const meta = task.data ? taskStatusMeta[task.data.status] : undefined;
  const StatusIcon = meta?.icon;
  const active = task.data?.status === "planning" || task.data?.status === "running";
  const questionEvent = task.data?.status === "needs_input" ? [...ordered].reverse().find((event) => questionsFromEvent(event).length > 0) : undefined;
  const pendingQuestions = questionsFromEvent(questionEvent);
  const documentStep = task.data?.plan ? markdownPlanStep(task.data.plan) : undefined;
  const planMarkdown = task.data?.plan?.markdown?.trim() || documentStep?.step;
  const planSteps = task.data?.plan?.steps.filter((step) => step !== documentStep && !(task.data?.plan?.steps.length === 1 && step.step.trim() === task.data.plan.markdown?.trim())) ?? [];
  const gitlabSource = task.data?.source?.provider === "gitlab" && task.data.source.externalUrl ? task.data.source : undefined;

  async function saveCheckbox(target: string, recordId: string | undefined, edit: Parameters<SaveCheckbox>[0]) {
    try { await api.toggleMarkdownCheckbox(`/tasks/${encodeURIComponent(selectedTaskId!)}`, target, recordId, edit); }
    finally {
      void queryClient.invalidateQueries({ queryKey: ["task", selectedTaskId] });
      void queryClient.invalidateQueries({ queryKey: ["events", selectedTaskId] });
      void queryClient.invalidateQueries({ queryKey: ["tasks"] });
    }
  }

  function replyToAgent(name: string, agentId?: string) {
    const currentName = agents.data?.find((agent) => agent.id === agentId)?.profile.name ?? name;
    const mention = agentMention(currentName);
    const draft = message.startsWith(`${mention} `) ? message : `${mention} ${message}`;
    setMessage(draft);
    requestAnimationFrame(() => { commentInput.current?.focus(); commentInput.current?.setSelectionRange(draft.length, draft.length); });
  }

  function sendMessage() {
    if (message.trim() && !send.isPending) send.mutate();
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    sendMessage();
  }

  return (
    <WorkspaceFileProvider scope={{ kind: "task", id: selectedTaskId }} readOnly={active}>
      <div className="panel-root relative">
      {task.data && (
        <header className="task-detail-header px-4 py-3">
          <div className="mx-auto max-w-3xl">
            <div className="flex min-w-0 flex-wrap items-start gap-3">
              <h1 className="min-w-0 basis-64 flex-1 text-[15px] font-semibold leading-5">{task.data.title}</h1>
              <div className="ml-auto flex flex-wrap items-center justify-end gap-1">
                {gitlabSource && <>
                  <Button variant="ghost" size="sm" onClick={() => setSourceActivityOpen(true)}><History />Activity</Button>
                  <Button asChild variant="ghost" size="sm"><a href={gitlabSource.externalUrl} target="_blank" rel="noreferrer" onClick={(event) => { event.preventDefault(); void openExternalUrl(gitlabSource.externalUrl!); }}><ExternalLink />Open in GitLab</a></Button>
                </>}
                {task.data.status === "review" && <Button size="sm" onClick={() => markComplete.mutate("done")} disabled={markComplete.isPending}><Check />Mark done</Button>}
                {task.data.status === "done" && <Button variant="ghost" size="sm" onClick={() => markComplete.mutate("review")} disabled={markComplete.isPending}><RefreshCw />Reopen</Button>}
                {active && task.data.activeTurnId && <Button variant="ghost" size="icon-sm" onClick={() => stop.mutate()} aria-label="Stop task" title="Stop task"><CircleStop /></Button>}
                {onClose && <Button variant="ghost" size="icon-sm" aria-label="Close task details" onClick={onClose}><X /></Button>}
              </div>
            </div>
            <div className="mt-2 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-muted-foreground">
              {meta && StatusIcon && <Badge variant={task.data.status === "failed" ? "danger" : task.data.status === "needs_input" ? "warning" : "outline"}><StatusIcon className={cn("size-3", meta.color, task.data.status === "running" && "animate-spin")} />{meta.label}</Badge>}
              <span className="inline-flex min-w-0 items-center gap-1 font-mono"><GitBranch className="size-3 shrink-0" /><span className="truncate">{task.data.branchName}</span></span>
              {task.data.source && <span className="capitalize">{task.data.source.provider} · {task.data.source.externalId}</span>}
              {(task.data.additions > 0 || task.data.deletions > 0) && <span><span className="text-success">+{task.data.additions}</span> <span className="text-destructive">−{task.data.deletions}</span></span>}
            </div>
          </div>
          {markComplete.error && <p role="alert" className="mt-2 text-xs text-destructive">{markComplete.error.message}</p>}
        </header>
      )}
      <ScrollArea className="chat-scroll min-h-0 flex-1 px-4">
        <div className="mx-auto max-w-3xl py-3">
          {task.data && <section className="mb-4 px-1 pb-2"><div className="aui-markdown text-xs"><TaskMarkdown key={`${selectedTaskId}:description`} content={task.data.description} saveCheckbox={active ? undefined : (edit) => saveCheckbox("description", undefined, edit)} components={workspaceFileMarkdownComponents} urlTransform={workspaceMarkdownUrlTransform} /></div>{task.data.attachments.length > 0 && <div className="mt-3 flex flex-wrap gap-1.5">{task.data.attachments.map((attachment) => <AttachmentPreview key={attachment.id} name={attachment.name} mimeType={attachment.mimeType} sourceKey={`${task.data!.id}:${attachment.id}`} load={() => api.taskAttachment(task.data!.id, attachment.id)} />)}</div>}</section>}
          <div className="mb-1 flex items-center gap-2 text-[10px] font-medium uppercase tracking-[0.1em] text-muted-foreground"><span>Comments</span><span className="h-px flex-1 bg-border" /></div>
          {ordered.length === 0 && events.isLoading && <div className="py-16 text-center text-xs text-muted-foreground">Loading comments…</div>}
          {ordered.filter((event) => !event.payload.replyTo || !ordered.some((parent) => parent.payload.commentId === event.payload.replyTo)).map((event) => <div key={event.id}>
            <TimelineEvent event={event} saveCheckbox={!active && ["user_message", "agent_message"].includes(event.kind) ? (edit) => saveCheckbox("event", String(event.id), edit) : undefined} onReply={replyToAgent} />
            {typeof event.payload.commentId === "string" && <div className="task-comment-replies">{ordered.filter((reply) => reply.payload.replyTo === event.payload.commentId).map((reply) => <TimelineEvent key={reply.id} event={reply} onReply={replyToAgent} />)}</div>}
          </div>)}
          {questionEvent && pendingQuestions.length > 0 && <div className="my-3"><CodexQuestionForm requestId={`${selectedTaskId}:${questionEvent.id}`} questions={pendingQuestions} onSubmit={async (answers) => { await answerQuestions.mutateAsync(answers); }} /></div>}
          {task.data?.plan && <section className="my-4 px-1 py-3" aria-label="Task plan">
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <ListChecks className="size-4 text-muted-foreground" /><h2 className="text-xs font-medium">Plan · revision {task.data.plan.revision}</h2>

            </div>
            {task.data.plan.explanation && <p className="selectable-text mb-2 text-xs leading-5 text-muted-foreground">{task.data.plan.explanation}</p>}
            {planMarkdown && <div className="aui-markdown selectable-text mb-3 text-xs"><TaskMarkdown key={`${selectedTaskId}:plan:${task.data.plan.revision}`} content={planMarkdown} saveCheckbox={active || documentStep ? undefined : (edit) => saveCheckbox("plan", String(task.data!.plan!.revision), edit)} components={workspaceFileMarkdownComponents} urlTransform={workspaceMarkdownUrlTransform} /></div>}
            {planSteps.length > 0 && <ol className="grid gap-1.5">{planSteps.map((step, index) => <li key={`${step.step}-${index}`} className="flex gap-2 text-xs leading-5" aria-current={step.status === "in_progress" ? "step" : undefined}>
              <span className={cn("mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border text-[9px]", step.status === "completed" ? "border-success/30 bg-success/10 text-success" : step.status === "in_progress" ? "border-primary/40 bg-primary/10 text-primary" : "border-border text-muted-foreground")}>{step.status === "completed" ? <Check className="size-2.5" /> : index + 1}</span>
              <span className={cn("selectable-text", step.status === "completed" && "text-muted-foreground line-through")}>{step.step}</span>
            </li>)}</ol>}
            {task.data.plan.approvedAt && task.data.status !== "ready" && <p className="mt-3 flex items-center gap-1.5 text-[11px] text-success"><Check className="size-3" />Plan approved</p>}
          </section>}
          {active && <div className="flex items-center gap-2 py-3 text-xs text-muted-foreground"><LoaderCircle className="size-3.5 animate-spin text-primary" />Work is in progress. Open the linked chat to follow along.</div>}
        </div>
      </ScrollArea>
      {pendingQuestions.length === 0 && <form className="chat-composer-shell bg-background/25 p-3" onSubmit={submit}>
        <AgentMentionComposer inputRef={commentInput} value={message} onChange={setMessage} onSend={sendMessage} agents={agents.data ?? []} pending={send.isPending} />
        {agents.error && <p role="alert" className="mx-auto mt-1.5 max-w-3xl text-xs text-destructive">Unable to load agents. <button type="button" onClick={() => void agents.refetch()}>Retry</button></p>}
        {send.error && <p className="mx-auto mt-1.5 max-w-3xl text-xs text-destructive">{send.error.message}</p>}
      </form>}
      {sourceActivityOpen && gitlabSource && <GitlabActivityPanel taskId={selectedTaskId} issueUrl={gitlabSource.externalUrl!} onClose={() => setSourceActivityOpen(false)} />}
      </div>
    </WorkspaceFileProvider>
  );
}
