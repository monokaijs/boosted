import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bot, Check, CheckCircle2, ChevronDown, ChevronRight, CircleStop, Download, ExternalLink, FileDiff, FolderOpen, ListChecks, ListTodo, LoaderCircle, Paperclip, Play, Plus, Send, Sparkles, TerminalSquare, UserRound } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Badge } from "@/components/ui/badge";
import { WorkspaceFileProvider, workspaceFileMarkdownComponents, workspaceMarkdownUrlTransform } from "@/components/assistant-ui/workspace-file-markdown";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api";
import { machinePreferenceKey, useAppStore } from "@/lib/store";
import { taskStatusMeta } from "@/lib/status";
import type { CodexAccessOption, TaskEvent } from "@/lib/types";
import { cn } from "@/lib/utils";

function textPayload(event: TaskEvent) {
  return String(event.payload.text ?? event.payload.message ?? event.payload.command ?? "");
}

function taskDescriptionPreview(value: string) {
  return value
    .replace(/```[\s\S]*?```/g, " code ")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^[#>\-*+\d.\s]+/gm, "")
    .replace(/[`*_~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
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

function TimelineEvent({ event }: { event: TaskEvent }) {
  if (["command", "command_output", "file_change"].includes(event.kind)) return <ToolEvent event={event} />;
  if (event.kind === "status_changed" || event.kind === "system") {
    return <div className="my-3 flex items-center gap-2 text-[11px] text-muted-foreground"><span className="h-px flex-1 bg-border" /><span>{textPayload(event)}</span><span className="h-px flex-1 bg-border" /></div>;
  }
  if (event.kind === "plan_updated") {
    return <div className="my-3 flex items-center gap-2 text-[11px] text-muted-foreground"><span className="h-px flex-1 bg-border" /><ListChecks className="size-3.5" /><span>Plan updated</span><span className="h-px flex-1 bg-border" /></div>;
  }
  if (event.kind === "reasoning") {
    return <details className="my-2 rounded-md border border-border/70 bg-background/20 px-3 py-2 text-xs text-muted-foreground"><summary className="cursor-pointer select-none">Reasoning summary</summary><div className="selectable-text mt-2 whitespace-pre-wrap leading-5">{textPayload(event)}</div></details>;
  }
  const user = event.kind === "user_message";
  const error = event.kind === "error";
  return (
    <article className={cn("group flex gap-3 py-3", user && "flex-row-reverse")}>
      <div className={cn("mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md border", user ? "border-primary/20 bg-primary/10 text-primary" : error ? "border-destructive/25 bg-destructive/10 text-destructive" : "border-border bg-secondary text-muted-foreground")}>{user ? <UserRound className="size-3.5" /> : <Bot className="size-3.5" />}</div>
      <div className={cn("min-w-0 max-w-[84%]", user && "text-right")}>
        <div className="mb-1 text-[10px] text-muted-foreground">{user ? event.actorName ?? "You" : error ? "Error" : "Codex"}</div>
        <div className={cn("selectable-text text-[13px] leading-5", user && "inline-block whitespace-pre-wrap rounded-lg bg-primary/10 px-3 py-2 text-left", error && "whitespace-pre-wrap text-destructive", !user && !error && "aui-markdown")}>
          {!user && !error
            ? <ReactMarkdown components={workspaceFileMarkdownComponents} remarkPlugins={[remarkGfm]} urlTransform={workspaceMarkdownUrlTransform}>{textPayload(event)}</ReactMarkdown>
            : textPayload(event)}
        </div>
      </div>
    </article>
  );
}

function chatTitle(prompt: string) {
  const firstLine = prompt.trim().split("\n").find(Boolean)?.replace(/\s+/g, " ") ?? "New chat";
  return firstLine.length > 72 ? `${firstLine.slice(0, 69)}…` : firstLine;
}

export function NewChatPanel() {
  const [prompt, setPrompt] = useState("");
  const [model, setModel] = useState(() => localStorage.getItem(machinePreferenceKey("boosted.codex.model")) ?? "");
  const [reasoningEffort, setReasoningEffort] = useState(() => localStorage.getItem(machinePreferenceKey("boosted.codex.effort")) ?? "");
  const [accessMode, setAccessMode] = useState<CodexAccessOption["id"]>(() => {
    const stored = localStorage.getItem(machinePreferenceKey("boosted.codex.access"));
    return stored === "workspaceWrite" || stored === "readOnly" ? stored : "fullAccess";
  });
  const projectId = useAppStore((state) => state.selectedProjectId);
  const selectProject = useAppStore((state) => state.selectProject);
  const selectCodexChat = useAppStore((state) => state.selectCodexChat);
  const queryClient = useQueryClient();
  const projects = useQuery({ queryKey: ["projects"], queryFn: api.projects });
  const project = projects.data?.find((entry) => entry.id === projectId);
  const codexOptions = useQuery({ queryKey: ["codex-options"], queryFn: api.codexOptions, staleTime: 60_000 });
  const selectedModel = codexOptions.data?.models.find((entry) => entry.model === model || entry.id === model);
  const selectedAccess = codexOptions.data?.accessModes.find((entry) => entry.id === accessMode);

  useEffect(() => {
    if (!codexOptions.data) return;
    const nextModel = codexOptions.data.models.find((entry) => entry.model === model || entry.id === model)
      ?? codexOptions.data.models.find((entry) => entry.model === codexOptions.data?.defaultModel)
      ?? codexOptions.data.models[0];
    if (nextModel && nextModel.model !== model) {
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
    const next = codexOptions.data?.models.find((entry) => entry.model === value);
    setModel(value);
    localStorage.setItem(machinePreferenceKey("boosted.codex.model"), value);
    if (next) {
      setReasoningEffort(next.defaultReasoningEffort);
      localStorage.setItem(machinePreferenceKey("boosted.codex.effort"), next.defaultReasoningEffort);
    }
  }

  function selectReasoningEffort(value: string) {
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
      await api.sendCodexMessage(chat.id, prompt.trim(), crypto.randomUUID(), { model, reasoningEffort, accessMode });
      return chat;
    },
    onSuccess: (chat) => {
      selectCodexChat(chat.id);
      setPrompt("");
      void queryClient.invalidateQueries({ queryKey: ["codex-chats"] });
      window.dispatchEvent(new CustomEvent("boosted:open-codex-chat", { detail: { threadId: chat.id, title: chatTitle(prompt) } }));
    },
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    if (project && prompt.trim() && model && reasoningEffort) create.mutate();
  }

  return (
    <div className="new-task-canvas">
      <div className="new-task-stack">
        <h1 className="new-task-title">new chat</h1>
        {project ? (
          <>
            <div className="new-task-context">
              <DropdownMenu>
                <DropdownMenuTrigger asChild><button type="button" className="new-task-option"><span>{project.name}</span><ChevronDown /></button></DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="w-64">
                  <DropdownMenuLabel>Workspace</DropdownMenuLabel>
                  <DropdownMenuRadioGroup value={project.id} onValueChange={(id) => { const next = projects.data?.find((entry) => entry.id === id); if (next) selectProject(next); }}>
                    {projects.data?.map((entry) => <DropdownMenuRadioItem key={entry.id} value={entry.id}><span className="truncate">{entry.name}</span></DropdownMenuRadioItem>)}
                  </DropdownMenuRadioGroup>
                </DropdownMenuContent>
              </DropdownMenu>
              <span className="context-divider" />
              <span className="inline-flex items-center gap-1.5"><TerminalSquare />Local</span>
              <span className="context-divider" />
              <span className="inline-flex items-center gap-1.5 font-mono">{project.defaultBranch}</span>
            </div>
            <form className="new-task-composer" onSubmit={submit}>
              <Textarea
                autoFocus
                className="new-task-input"
                placeholder="Ask Codex anything about this workspace…"
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
                onKeyDown={(event) => { if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) event.currentTarget.form?.requestSubmit(); }}
              />
              <div className="new-task-footer">
                <span className="new-task-plus" aria-hidden="true"><Plus /></span>
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
                <Button className="new-task-send-button" variant="ghost" aria-label="Create chat" disabled={!prompt.trim() || !model || !reasoningEffort || create.isPending}>{create.isPending ? <LoaderCircle className="animate-spin" /> : <Send />}<span className="new-task-send-label">Send</span></Button>
              </div>
            </form>
            {create.error && <p className="mt-2 text-xs text-destructive">{create.error.message}</p>}
            {codexOptions.error && <p className="mt-2 text-xs text-destructive">{codexOptions.error.message}</p>}
            <p className="mt-2 text-[10px] text-muted-foreground">⌘ Enter to start a separate Codex chat</p>
          </>
        ) : (
          <div className="mt-4 grid justify-items-start gap-3 text-sm text-muted-foreground"><p>Open a Git repository folder before starting a Codex chat.</p><Button onClick={() => window.dispatchEvent(new CustomEvent("boosted:open-project"))}><FolderOpen />Open project</Button></div>
        )}
      </div>
    </div>
  );
}

export function TaskPanel() {
  const [message, setMessage] = useState("");
  const selectedTaskId = useAppStore((state) => state.selectedTaskId);
  const queryClient = useQueryClient();
  const task = useQuery({ queryKey: ["task", selectedTaskId], queryFn: () => api.task(selectedTaskId!), enabled: Boolean(selectedTaskId) });
  const events = useQuery({ queryKey: ["events", selectedTaskId], queryFn: () => api.taskEvents(selectedTaskId!), enabled: Boolean(selectedTaskId), refetchInterval: task.data?.status === "running" || task.data?.status === "planning" ? 1_000 : false });
  const send = useMutation({
    mutationFn: () => api.sendMessage(selectedTaskId!, message.trim()),
    onSuccess: () => { setMessage(""); void queryClient.invalidateQueries({ queryKey: ["events", selectedTaskId] }); void queryClient.invalidateQueries({ queryKey: ["task", selectedTaskId] }); },
  });
  const startPlanning = useMutation({
    mutationFn: () => api.startTaskPlan(selectedTaskId!),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["events", selectedTaskId] });
      void queryClient.invalidateQueries({ queryKey: ["task", selectedTaskId] });
      void queryClient.invalidateQueries({ queryKey: ["tasks"] });
    },
  });
  const approve = useMutation({
    mutationFn: () => api.approvePlan(selectedTaskId!, task.data!.plan!.revision),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["task", selectedTaskId] });
      void queryClient.invalidateQueries({ queryKey: ["tasks"] });
    },
  });
  const stop = useMutation({ mutationFn: () => api.stopTask(selectedTaskId!), onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["task", selectedTaskId] }) });
  const ordered = useMemo(() => [...(events.data ?? [])].sort((a, b) => a.id - b.id), [events.data]);

  if (!selectedTaskId) return <div className="empty-state"><ListTodo className="size-8" /><p>Select a task to open its details and chat.</p></div>;
  const meta = task.data ? taskStatusMeta[task.data.status] : undefined;
  const StatusIcon = meta?.icon;
  const active = task.data?.status === "planning" || task.data?.status === "running";

  function submit(event: FormEvent) {
    event.preventDefault();
    if (message.trim()) send.mutate();
  }

  return (
    <WorkspaceFileProvider scope={{ kind: "task", id: selectedTaskId }}>
      <div className="panel-root">
      {task.data && (
        <section className="border-b border-border bg-background/20 px-4 py-3">
          <div className="mx-auto flex max-w-3xl items-start gap-3">
            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 items-center gap-2">
                <h1 className="truncate text-sm font-semibold">{task.data.title}</h1>
                {meta && StatusIcon && <Badge variant={task.data.status === "failed" ? "danger" : task.data.status === "needs_input" ? "warning" : "outline"}><StatusIcon className={cn("size-3", meta.color, task.data.status === "running" && "animate-spin")} />{meta.label}</Badge>}
              </div>
              <p className="mt-1 line-clamp-2 text-xs leading-5 text-muted-foreground">{taskDescriptionPreview(task.data.description)}</p>
              <p className="mt-1.5 truncate font-mono text-[9px] text-muted-foreground">{task.data.branchName}</p>
            </div>
            {task.data.status === "queued" && <Button size="sm" onClick={() => startPlanning.mutate()} disabled={startPlanning.isPending}>{startPlanning.isPending ? <LoaderCircle className="animate-spin" /> : <Sparkles />}Start planning</Button>}
            {active && <Button variant="ghost" size="icon-sm" onClick={() => stop.mutate()} title="Stop"><CircleStop /></Button>}
          </div>
          {startPlanning.error && <p className="mx-auto mt-2 max-w-3xl text-xs text-destructive">{startPlanning.error.message}</p>}
        </section>
      )}
      <ScrollArea className="chat-scroll min-h-0 flex-1 px-4">
        <div className="mx-auto max-w-3xl py-3">
          {task.data && <section className="mb-4 rounded-lg border border-border bg-background/25 p-4"><div className="aui-markdown text-xs"><ReactMarkdown components={workspaceFileMarkdownComponents} remarkPlugins={[remarkGfm]} urlTransform={workspaceMarkdownUrlTransform}>{task.data.description}</ReactMarkdown></div>{task.data.source && <a className="mt-3 inline-flex items-center gap-1.5 text-[11px] capitalize text-primary hover:underline" href={task.data.source.externalUrl} target="_blank" rel="noreferrer">Imported from {task.data.source.provider} · {task.data.source.externalId}<ExternalLink className="size-3" /></a>}{task.data.attachments.length > 0 && <div className="mt-3 flex flex-wrap gap-1.5">{task.data.attachments.map((attachment) => <Button key={attachment.id} type="button" variant="secondary" size="sm" onClick={() => void api.downloadTaskAttachment(task.data!.id, attachment)}><Paperclip />{attachment.name}<Download /></Button>)}</div>}</section>}
          {task.data?.status === "queued" && <div className="mb-4 grid gap-2 rounded-lg border border-border bg-background/25 p-4"><div className="flex items-center gap-2 text-xs font-medium"><Sparkles className="size-4 text-primary" />Ready to plan</div><p className="text-xs leading-5 text-muted-foreground">Start planning to let Codex inspect the repository and turn this task into concrete steps. You can answer any follow-up questions here.</p></div>}
          {task.data?.plan && <section className="mb-4 rounded-lg border border-border bg-background/25 p-3"><div className="mb-2 flex items-center gap-2"><ListChecks className="size-4 text-muted-foreground" /><h2 className="text-xs font-medium">Plan · revision {task.data.plan.revision}</h2>{task.data.status === "ready" && <Button className="ml-auto" size="sm" onClick={() => approve.mutate()} disabled={approve.isPending}>{approve.isPending ? <LoaderCircle className="animate-spin" /> : <Play />}Approve and run</Button>}</div>{task.data.plan.explanation && <p className="mb-2 text-xs leading-5 text-muted-foreground">{task.data.plan.explanation}</p>}<ol className="grid gap-1.5">{task.data.plan.steps.map((step, index) => <li key={`${step.step}-${index}`} className="flex gap-2 text-xs leading-5"><span className="mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border border-border text-[9px] text-muted-foreground">{step.status === "completed" ? <Check className="size-2.5 text-success" /> : index + 1}</span><span className={cn(step.status === "completed" && "text-muted-foreground line-through")}>{step.step}</span></li>)}</ol>{approve.error && <p className="mt-2 text-xs text-destructive">{approve.error.message}</p>}</section>}
          <div className="mb-1 flex items-center gap-2 text-[10px] font-medium uppercase tracking-[0.1em] text-muted-foreground"><span>Task chat</span><span className="h-px flex-1 bg-border" /></div>
          {ordered.length === 0 && events.isLoading && <div className="py-16 text-center text-xs text-muted-foreground">Loading conversation…</div>}
          {ordered.map((event) => <TimelineEvent key={event.id} event={event} />)}
          {active && <div className="flex items-center gap-2 py-3 text-xs text-muted-foreground"><LoaderCircle className="size-3.5 animate-spin text-primary" />Codex is working…</div>}
          {task.data?.status === "review" && <div className="my-4 flex items-center gap-2 rounded-lg border border-success/25 bg-success/10 p-3 text-xs text-success"><CheckCircle2 className="size-4" />Execution finished. Review the Git changes before marking the task done.</div>}
        </div>
      </ScrollArea>
      <form className="chat-composer-shell bg-background/25 p-3" onSubmit={submit}>
        <div className="mx-auto flex max-w-3xl items-end gap-2 rounded-lg border border-input bg-background/60 p-2 focus-within:border-primary/70 focus-within:ring-2 focus-within:ring-primary/15">
          <Textarea
            className="min-h-10 flex-1 border-0 bg-transparent p-1.5 shadow-none focus-visible:border-0 focus-visible:ring-0"
            placeholder={task.data?.status === "queued" ? "Send instructions to Codex and start planning…" : task.data?.status === "needs_input" ? "Reply to Codex…" : task.data?.status === "ready" ? "Ask for a plan revision, or approve the plan…" : "Message Codex…"}
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }}
          />
          <Button size="icon" disabled={!message.trim() || send.isPending}><Send /></Button>
        </div>
        {send.error && <p className="mx-auto mt-1.5 max-w-3xl text-xs text-destructive">{send.error.message}</p>}
      </form>
      </div>
    </WorkspaceFileProvider>
  );
}
