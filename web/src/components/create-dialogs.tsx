import { useEffect, useRef, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUp, Bold, ChevronRight, Code2, Eye, Folder, FolderOpen, GitBranch, HardDrive, Italic, Link, List, ListOrdered, LoaderCircle, Paperclip, Pencil, RefreshCw, Settings2, UserPlus, X } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api";
import { useAppStore } from "@/lib/store";
import type { CodexAccessOption, FolderBrowseEntry, Task, TaskAttachment } from "@/lib/types";

function folderBreadcrumbs(path: string) {
  const windows = /^[A-Za-z]:[\\/]/.test(path);
  const separator = windows ? "\\" : "/";
  const parts = path.split(/[\\/]+/).filter(Boolean);
  const root = windows ? `${parts.shift() ?? ""}\\` : "/";
  const crumbs = [{ label: windows ? root.slice(0, 2) : "/", path: root }];
  let current = root;
  for (const part of parts) {
    current = `${current}${current.endsWith(separator) ? "" : separator}${part}`;
    crumbs.push({ label: part, path: current });
  }
  return crumbs;
}

export function NewTaskDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [mode, setMode] = useState<"write" | "preview">("write");
  const [attachments, setAttachments] = useState<TaskAttachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState("");
  const [baseBranch, setBaseBranch] = useState("");
  const [model, setModel] = useState("");
  const [reasoningEffort, setReasoningEffort] = useState("");
  const [accessMode, setAccessMode] = useState<CodexAccessOption["id"]>("fullAccess");
  const [optionsOpen, setOptionsOpen] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const projectId = useAppStore((state) => state.selectedProjectId);
  const selectTask = useAppStore((state) => state.selectTask);
  const queryClient = useQueryClient();
  const projects = useQuery({ queryKey: ["projects"], queryFn: api.projects, enabled: open });
  const project = projects.data?.find((entry) => entry.id === projectId);
  const branches = useQuery({ queryKey: ["branches", projectId], queryFn: () => api.projectBranches(projectId!), enabled: open && Boolean(projectId) });
  const codexOptions = useQuery({ queryKey: ["codex-options"], queryFn: api.codexOptions, enabled: open, staleTime: 60_000 });
  const selectedModel = codexOptions.data?.models.find((entry) => entry.model === model || entry.id === model);

  useEffect(() => {
    if (!open) return;
    if (!baseBranch && project) setBaseBranch(project.defaultBranch);
    if (!model && codexOptions.data) {
      const next = codexOptions.data.models.find((entry) => entry.model === codexOptions.data?.defaultModel) ?? codexOptions.data.models[0];
      if (next) { setModel(next.model); setReasoningEffort(next.defaultReasoningEffort); }
      setAccessMode(codexOptions.data.defaultAccessMode);
    }
  }, [baseBranch, codexOptions.data, model, open, project]);

  function clear() {
    setTitle(""); setDescription(""); setMode("write"); setAttachments([]); setUploadError(""); setOptionsOpen(false);
  }

  const create = useMutation({
    mutationFn: () => api.createTask(projectId!, title, description, { baseBranch, model, reasoningEffort, accessMode, attachmentIds: attachments.map((entry) => entry.id) }),
    onSuccess: (task) => {
      queryClient.setQueryData<Task[]>(["tasks", projectId], (current) => current?.some((entry) => entry.id === task.id) ? current : [task, ...(current ?? [])]);
      selectTask(task);
      void queryClient.invalidateQueries({ queryKey: ["tasks"] });
      clear(); onOpenChange(false);
      window.dispatchEvent(new CustomEvent("boosted:open-panel", { detail: "task" }));
    },
  });

  async function addFiles(files: FileList | File[]) {
    const next = Array.from(files).slice(0, Math.max(0, 10 - attachments.length));
    if (!next.length) return;
    setUploading(true); setUploadError("");
    try {
      for (const file of next) {
        const uploaded = await api.uploadTaskAttachment(file);
        setAttachments((current) => [...current, uploaded]);
      }
    } catch (error) { setUploadError(error instanceof Error ? error.message : "Upload failed"); }
    finally { setUploading(false); if (fileRef.current) fileRef.current.value = ""; }
  }

  async function removeAttachment(attachment: TaskAttachment) {
    setAttachments((current) => current.filter((entry) => entry.id !== attachment.id));
    await api.removePendingTaskAttachment(attachment.id).catch(() => undefined);
  }

  function close(next: boolean) {
    if (!next) {
      for (const attachment of attachments) void api.removePendingTaskAttachment(attachment.id).catch(() => undefined);
      clear(); create.reset();
    }
    onOpenChange(next);
  }

  function format(before: string, after = before, fallback = "text") {
    const input = textareaRef.current;
    if (!input) return;
    const start = input.selectionStart; const end = input.selectionEnd;
    const selected = description.slice(start, end) || fallback;
    const next = `${description.slice(0, start)}${before}${selected}${after}${description.slice(end)}`;
    setDescription(next);
    requestAnimationFrame(() => { input.focus(); input.setSelectionRange(start + before.length, start + before.length + selected.length); });
  }

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="task-create-dialog max-w-3xl gap-0 overflow-hidden p-0">
        <DialogHeader className="task-create-header border-b border-border px-6 py-5 pr-12"><DialogTitle>Create task</DialogTitle></DialogHeader>
        <form className="task-create-form" onSubmit={(event) => { event.preventDefault(); create.mutate(); }}>
          <div className="task-create-body grid gap-4 px-6 py-5">
            <label className="grid gap-1.5"><span className="text-xs font-medium">Title</span><Input autoFocus className="h-10 text-sm" value={title} onChange={(event) => setTitle(event.target.value)} required /></label>
            <div className="grid gap-1.5">
              <div className="flex items-end justify-between"><p className="text-xs font-medium">Description</p><div className="flex rounded-md bg-background p-0.5"><Button type="button" size="sm" variant="ghost" className={mode === "write" ? "h-6 bg-accent px-2" : "h-6 px-2"} onClick={() => setMode("write")}><Pencil />Write</Button><Button type="button" size="sm" variant="ghost" className={mode === "preview" ? "h-6 bg-accent px-2" : "h-6 px-2"} onClick={() => setMode("preview")}><Eye />Preview</Button></div></div>
              <div className="overflow-hidden rounded-lg border border-input bg-[var(--surface-input)] focus-within:border-primary/60">
                {mode === "write" && <><div className="flex items-center gap-0.5 border-b border-border px-2 py-1"><Button type="button" variant="ghost" size="icon-sm" title="Bold" onClick={() => format("**")}><Bold /></Button><Button type="button" variant="ghost" size="icon-sm" title="Italic" onClick={() => format("_", "_")}><Italic /></Button><Button type="button" variant="ghost" size="icon-sm" title="Link" onClick={() => format("[", "](https://)", "link text")}><Link /></Button><span className="mx-1 h-4 w-px bg-border" /><Button type="button" variant="ghost" size="icon-sm" title="Bulleted list" onClick={() => format("- ", "", "list item")}><List /></Button><Button type="button" variant="ghost" size="icon-sm" title="Numbered list" onClick={() => format("1. ", "", "list item")}><ListOrdered /></Button><Button type="button" variant="ghost" size="icon-sm" title="Code" onClick={() => format("`", "`")}><Code2 /></Button></div><Textarea ref={textareaRef} className="min-h-52 resize-y rounded-none border-0 bg-transparent p-3 text-[13px] leading-6 shadow-none focus-visible:border-0 focus-visible:ring-0" placeholder="Describe the outcome, constraints, acceptance criteria, and useful implementation context…" value={description} onChange={(event) => setDescription(event.target.value)} required /></>}
                {mode === "preview" && <div className="aui-markdown min-h-64 p-4">{description.trim() ? <ReactMarkdown remarkPlugins={[remarkGfm]}>{description}</ReactMarkdown> : <p className="text-muted-foreground">Nothing to preview yet.</p>}</div>}
              </div>
            </div>
            <div className="grid gap-2"><div className="flex items-center justify-between"><div><p className="text-xs font-medium">Attachments</p><p className="mt-0.5 text-[11px] text-muted-foreground">Up to 10 files, 20 MB each.</p></div><input ref={fileRef} type="file" multiple className="hidden" onChange={(event) => event.target.files && void addFiles(event.target.files)} /><Button type="button" variant="secondary" size="sm" disabled={uploading || attachments.length >= 10} onClick={() => fileRef.current?.click()}>{uploading ? <LoaderCircle className="animate-spin" /> : <Paperclip />}Add files</Button></div>{attachments.length > 0 && <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">{attachments.map((attachment) => <div key={attachment.id} className="flex min-w-0 items-center gap-2 rounded-md border border-border bg-background/35 px-2.5 py-2"><Paperclip className="size-3.5 shrink-0 text-muted-foreground" /><span className="min-w-0 flex-1 truncate text-xs">{attachment.name}</span><span className="text-[10px] text-muted-foreground">{Math.max(1, Math.round(attachment.size / 1024))} KB</span><Button type="button" variant="ghost" size="icon-sm" className="size-5" title="Remove" onClick={() => void removeAttachment(attachment)}><X /></Button></div>)}</div>}{uploadError && <p className="text-xs text-destructive">{uploadError}</p>}</div>
            <button type="button" className="flex items-center gap-2 text-left text-xs font-medium text-muted-foreground hover:text-foreground" onClick={() => setOptionsOpen(!optionsOpen)}><Settings2 className="size-3.5" />Execution options<ChevronRight className={`ml-auto size-3.5 transition ${optionsOpen ? "rotate-90" : ""}`} /></button>
            {optionsOpen && <div className="grid grid-cols-1 gap-3 rounded-lg border border-border bg-background/25 p-3 sm:grid-cols-3"><label className="grid gap-1.5 text-[11px] text-muted-foreground">Base branch<select className="h-8 rounded-md border border-input bg-background px-2 text-xs text-foreground outline-none" value={baseBranch} onChange={(event) => setBaseBranch(event.target.value)}>{branches.data?.map((branch) => <option key={branch}>{branch}</option>)}</select></label><label className="grid gap-1.5 text-[11px] text-muted-foreground">Model<select className="h-8 rounded-md border border-input bg-background px-2 text-xs text-foreground outline-none" value={model} onChange={(event) => { const next = codexOptions.data?.models.find((entry) => entry.model === event.target.value); setModel(event.target.value); if (next) setReasoningEffort(next.defaultReasoningEffort); }}>{codexOptions.data?.models.map((entry) => <option key={entry.id} value={entry.model}>{entry.displayName}</option>)}</select></label><label className="grid gap-1.5 text-[11px] text-muted-foreground">Access<select className="h-8 rounded-md border border-input bg-background px-2 text-xs text-foreground outline-none" value={accessMode} onChange={(event) => setAccessMode(event.target.value as CodexAccessOption["id"])}>{codexOptions.data?.accessModes.map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>)}</select></label>{selectedModel && <label className="grid gap-1.5 text-[11px] text-muted-foreground sm:col-start-2">Reasoning<select className="h-8 rounded-md border border-input bg-background px-2 text-xs capitalize text-foreground outline-none" value={reasoningEffort} onChange={(event) => setReasoningEffort(event.target.value)}>{selectedModel.supportedReasoningEfforts.map((entry) => <option key={entry.id}>{entry.id}</option>)}</select></label>}</div>}
          </div>
          {(create.error || branches.error || codexOptions.error) && <p className="px-6 pb-3 text-xs text-destructive">{create.error?.message ?? branches.error?.message ?? codexOptions.error?.message}</p>}
          <DialogFooter className="border-t border-border bg-background/25 px-6 py-4"><Button type="button" variant="ghost" onClick={() => close(false)}>Cancel</Button><Button disabled={create.isPending || uploading || !title.trim() || !description.trim() || !baseBranch}>{create.isPending && <LoaderCircle className="animate-spin" />}Create</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function OpenProjectDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [folderPath, setFolderPath] = useState<string>();
  const [location, setLocation] = useState("");
  const [selected, setSelected] = useState<FolderBrowseEntry>();
  const queryClient = useQueryClient();
  const selectProject = useAppStore((state) => state.selectProject);
  const folders = useQuery({ queryKey: ["folder-browser", folderPath], queryFn: () => api.browseFolders(folderPath), enabled: open, retry: false });
  const openPath = selected?.isGitRepository ? selected.path : folders.data?.isGitRepository ? folders.data.path : undefined;
  const openProject = useMutation({
    mutationFn: () => api.openProject(openPath!),
    onSuccess: (project) => { selectProject(project); void queryClient.invalidateQueries({ queryKey: ["projects"] }); onOpenChange(false); },
  });

  useEffect(() => {
    if (folders.data) {
      setLocation(folders.data.path);
      setSelected(undefined);
    }
  }, [folders.data]);

  useEffect(() => {
    if (!open) {
      setFolderPath(undefined);
      setLocation("");
      setSelected(undefined);
      openProject.reset();
    }
  }, [open]);

  function navigate(path: string) {
    setSelected(undefined);
    setFolderPath(path);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="project-open-dialog max-w-2xl">
        <DialogHeader><div className="mb-2 flex size-9 items-center justify-center rounded-lg bg-primary/10 text-primary"><FolderOpen className="size-4" /></div><DialogTitle>Open project</DialogTitle></DialogHeader>
        <div className="overflow-hidden rounded-lg border border-border bg-background/35">
          <form className="flex items-center gap-1.5 p-2" onSubmit={(event) => { event.preventDefault(); if (location.trim()) navigate(location.trim()); }}>
            <Button type="button" variant="ghost" size="icon-sm" title="Parent folder" disabled={!folders.data?.parent} onClick={() => folders.data?.parent && navigate(folders.data.parent)}><ArrowUp /></Button>
            {folders.data && folders.data.roots.length > 1 && (
              <select className="h-7 rounded-md bg-secondary px-2 font-mono text-xs outline-none" aria-label="Filesystem root" value={folders.data.roots.find((root) => folders.data.path.startsWith(root)) ?? folders.data.roots[0]} onChange={(event) => navigate(event.target.value)}>
                {folders.data.roots.map((root) => <option key={root} value={root}>{root}</option>)}
              </select>
            )}
            <Input autoFocus className="h-7 min-w-0 flex-1 font-mono text-xs" aria-label="Folder location" value={location} onChange={(event) => setLocation(event.target.value)} placeholder="Folder path" />
            <Button type="submit" variant="secondary" size="sm">Go</Button>
            <Button type="button" variant="ghost" size="icon-sm" title="Refresh" onClick={() => void folders.refetch()}><RefreshCw className={folders.isFetching ? "animate-spin" : ""} /></Button>
          </form>

          {folders.data && (
            <div className="flex min-h-8 items-center gap-0.5 overflow-x-auto px-2 pb-2 text-xs text-muted-foreground">
              {folderBreadcrumbs(folders.data.path).map((crumb, index) => <div key={crumb.path} className="flex shrink-0 items-center"><Button type="button" variant="ghost" size="sm" className="h-6 px-1.5 font-normal" onClick={() => navigate(crumb.path)}>{index === 0 && <HardDrive />}{crumb.label}</Button>{index < folderBreadcrumbs(folders.data.path).length - 1 && <ChevronRight className="size-3" />}</div>)}
            </div>
          )}

          <ScrollArea className="folder-browser-scroll h-72 border-t border-border">
            <div className="grid content-start gap-0.5 p-1.5">
              {folders.isLoading && <div className="grid h-48 place-items-center text-muted-foreground"><LoaderCircle className="size-5 animate-spin" /></div>}
              {folders.error && <div className="grid h-48 place-items-center px-8 text-center text-xs text-destructive">{folders.error.message}</div>}
              {folders.data?.entries.map((entry) => (
                <div key={entry.path} className={`folder-entry flex min-h-8 w-full items-center rounded-md hover:bg-accent ${selected?.path === entry.path ? "bg-accent text-foreground" : "text-muted-foreground"}`}>
                  <button type="button" className="flex min-w-0 flex-1 items-center gap-2 self-stretch px-2 text-left text-xs" onClick={() => setSelected(entry)} onDoubleClick={() => navigate(entry.path)}>
                    <Folder className="size-4 shrink-0" />
                    <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                    {entry.isGitRepository && <span className="inline-flex items-center gap-1 rounded-md bg-secondary px-1.5 py-0.5 text-[10px] text-secondary-foreground"><GitBranch className="size-3" />Git repository</span>}
                  </button>
                  <Button type="button" variant="ghost" size="icon-sm" className="mr-0.5 shrink-0" aria-label={`Browse ${entry.name}`} title={`Browse ${entry.name}`} onClick={() => navigate(entry.path)}><ChevronRight /></Button>
                </div>
              ))}
              {folders.data?.entries.length === 0 && <div className="grid h-48 place-items-center text-xs text-muted-foreground">This folder has no subfolders.</div>}
            </div>
          </ScrollArea>

          {openPath && <div className="flex min-h-9 items-center gap-2 border-t border-border px-3 text-[11px] text-muted-foreground"><GitBranch className="size-3.5" /><span className="min-w-0 flex-1 truncate">{openPath}</span></div>}
        </div>
        {openProject.error && <p className="text-xs text-destructive">{openProject.error.message}</p>}
        <DialogFooter><Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button><Button disabled={openProject.isPending || !openPath} onClick={() => openProject.mutate()}>{openProject.isPending && <LoaderCircle className="animate-spin" />}<FolderOpen />Open</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function UsersDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const queryClient = useQueryClient();
  const users = useQuery({ queryKey: ["users"], queryFn: api.users, enabled: open });
  const create = useMutation({ mutationFn: () => api.createUser(username, password), onSuccess: () => { setUsername(""); setPassword(""); void queryClient.invalidateQueries({ queryKey: ["users"] }); } });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="users-dialog">
        <DialogHeader><div className="mb-2 flex size-9 items-center justify-center rounded-lg bg-primary/10 text-primary"><UserPlus className="size-4" /></div><DialogTitle>Manage users</DialogTitle></DialogHeader>
        <div className="grid max-h-52 gap-1 overflow-auto">
          {users.data?.map((user) => <div key={user.id} className="flex items-center justify-between rounded-md px-2 py-2 hover:bg-accent"><div><p className="text-sm font-medium">{user.username}</p><p className="text-[11px] capitalize text-muted-foreground">{user.role}{user.mustChangePassword ? " · password change required" : ""}</p></div>{user.disabled && <span className="text-xs text-destructive">Disabled</span>}</div>)}
        </div>
        <form className="grid gap-2 border-t border-border pt-4" onSubmit={(event) => { event.preventDefault(); create.mutate(); }}>
          <p className="text-xs font-medium">Create member</p>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2"><Input placeholder="Username" value={username} onChange={(event) => setUsername(event.target.value)} minLength={3} required /><Input type="password" placeholder="Temporary password" value={password} onChange={(event) => setPassword(event.target.value)} required /></div>
          {create.error && <p className="text-xs text-destructive">{create.error.message}</p>}
          <DialogFooter><Button disabled={create.isPending || username.length < 3 || !password}>{create.isPending && <LoaderCircle className="animate-spin" />}Create</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function ForcePasswordDialog() {
  const user = useAppStore((state) => state.user);
  const setUser = useAppStore((state) => state.setUser);
  const [currentPassword, setCurrentPassword] = useState("");
  const [nextPassword, setNextPassword] = useState("");
  const change = useMutation({ mutationFn: () => api.changePassword(currentPassword, nextPassword), onSuccess: setUser });
  useEffect(() => { if (!user?.mustChangePassword) { setCurrentPassword(""); setNextPassword(""); } }, [user?.mustChangePassword]);
  return (
    <Dialog open={Boolean(user?.mustChangePassword)}>
      <DialogContent className="password-dialog" onEscapeKeyDown={(event) => event.preventDefault()} onPointerDownOutside={(event) => event.preventDefault()}>
        <DialogHeader><DialogTitle>Choose a new password</DialogTitle><DialogDescription>Your administrator created this account with a temporary password.</DialogDescription></DialogHeader>
        <form className="grid gap-3" onSubmit={(event: FormEvent) => { event.preventDefault(); change.mutate(); }}>
          <Input type="password" placeholder="Temporary password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} required />
          <Input type="password" placeholder="New password" value={nextPassword} onChange={(event) => setNextPassword(event.target.value)} required />
          {change.error && <p className="text-xs text-destructive">{change.error.message}</p>}
          <Button disabled={change.isPending || !nextPassword}>Update password</Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
