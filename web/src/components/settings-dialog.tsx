import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Activity, Bot, ChevronRight, CircleGauge, CloudDownload, Code2, Copy, ExternalLink, GitBranch, LoaderCircle, Plug, Plus, RefreshCw, Save, Settings2, Shield, Trash2, UserPlus, Users, Workflow } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api";
import { useAppStore } from "@/lib/store";
import type { Integration } from "@/lib/types";
import { cn, relativeTime } from "@/lib/utils";

const Gitlab = GitBranch;

type Section = "workspace" | "integrations" | "codex" | "team";

const sections: { id: Section; label: string; icon: typeof Settings2 }[] = [
  { id: "workspace", label: "Workspace", icon: Settings2 },
  { id: "integrations", label: "Integrations", icon: Plug },
  { id: "codex", label: "Codex", icon: Bot },
  { id: "team", label: "Team", icon: Users },
];

function SettingsSection({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  return <section className="settings-section"><div className="mb-4"><h2 className="text-sm font-semibold">{title}</h2><p className="mt-1 text-xs leading-5 text-muted-foreground">{description}</p></div>{children}</section>;
}

function WorkspaceSettings() {
  const projectId = useAppStore((state) => state.selectedProjectId);
  const projects = useQuery({ queryKey: ["projects"], queryFn: api.projects });
  const project = projects.data?.find((entry) => entry.id === projectId);
  return <div className="settings-content"><SettingsSection title="Workspace details" description="Settings on this page apply only to the selected workspace.">{project ? <div className="settings-card grid gap-4"><label className="grid gap-1.5"><span className="settings-label">Name</span><Input value={project.name} readOnly /></label><label className="grid gap-1.5"><span className="settings-label">Repository</span><Input className="font-mono text-xs" value={project.repoPath} readOnly /></label><label className="grid gap-1.5"><span className="settings-label">Default branch</span><Input className="font-mono text-xs" value={project.defaultBranch} readOnly /></label></div> : <p className="text-xs text-muted-foreground">Open a workspace to configure it.</p>}</SettingsSection><SettingsSection title="Task defaults" description="Imported and manually created tasks start on this workspace’s default branch."><div className="settings-card flex items-center gap-3"><Workflow className="size-5 text-muted-foreground" /><div><p className="text-xs font-medium">One isolated worktree per task</p><p className="mt-0.5 text-[11px] text-muted-foreground">Every task receives its own boosted/* branch and execution directory.</p></div></div></SettingsSection></div>;
}

const scheduleOptions = [
  { value: "", label: "Manual only" }, { value: "15", label: "Every 15 minutes" },
  { value: "60", label: "Every hour" }, { value: "360", label: "Every 6 hours" },
  { value: "1440", label: "Every day" },
];

function providerIcon(provider: Integration["provider"]) {
  return provider === "gitlab" ? GitBranch : Code2;
}

function IntegrationsSettings() {
  const projectId = useAppStore((state) => state.selectedProjectId);
  const queryClient = useQueryClient();
  const [installing, setInstalling] = useState<Integration["provider"]>();
  const [name, setName] = useState("");
  const [schedule, setSchedule] = useState("");
  const [config, setConfig] = useState<Record<string, string>>({});
  const integrations = useQuery({ queryKey: ["integrations", projectId], queryFn: () => api.integrations(projectId!), enabled: Boolean(projectId) });
  const install = useMutation({ mutationFn: () => api.createIntegration(projectId!, { provider: installing!, name, config, enabled: true, syncIntervalMinutes: schedule ? Number(schedule) : undefined }), onSuccess: () => { setInstalling(undefined); setName(""); setSchedule(""); setConfig({}); void queryClient.invalidateQueries({ queryKey: ["integrations", projectId] }); } });
  const sync = useMutation({ mutationFn: (id: string) => api.syncIntegration(projectId!, id), onSuccess: () => { void queryClient.invalidateQueries({ queryKey: ["integrations", projectId] }); void queryClient.invalidateQueries({ queryKey: ["tasks", projectId] }); } });
  const remove = useMutation({ mutationFn: (id: string) => api.deleteIntegration(projectId!, id), onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["integrations", projectId] }) });
  const toggle = useMutation({ mutationFn: (entry: Integration) => api.updateIntegration(projectId!, entry.id, { name: entry.name, config: entry.config, enabled: !entry.enabled, syncIntervalMinutes: entry.syncIntervalMinutes }), onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["integrations", projectId] }) });

  function begin(provider: Integration["provider"]) {
    setInstalling(provider); setName(provider === "gitlab" ? "GitLab issues" : "Huly tasks"); setSchedule("");
    setConfig(provider === "gitlab" ? { baseUrl: "https://gitlab.com", project: "", token: "" } : { endpoint: "", workspace: "", project: "", token: "" });
  }

  return <div className="settings-content"><SettingsSection title="Installed integrations" description="Connections belong to this workspace. Import on demand or keep the taskboard synchronized on a schedule."><div className="grid gap-2">{integrations.isLoading && <p className="text-xs text-muted-foreground">Loading integrations…</p>}{integrations.data?.map((entry) => { const Icon = providerIcon(entry.provider); return <div key={entry.id} className="settings-card flex items-start gap-3"><div className="grid size-9 shrink-0 place-items-center rounded-lg bg-secondary"><Icon className="size-4" /></div><div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><p className="text-xs font-medium">{entry.name}</p><span className={cn("rounded-full px-1.5 py-0.5 text-[9px] capitalize", entry.enabled ? "bg-success/10 text-success" : "bg-secondary text-muted-foreground")}>{entry.enabled ? "Active" : "Paused"}</span>{entry.lastSyncStatus && <span className="text-[10px] capitalize text-muted-foreground">{entry.lastSyncStatus}</span>}</div><p className="mt-1 text-[11px] capitalize text-muted-foreground">{entry.provider} · {entry.syncIntervalMinutes ? scheduleOptions.find((option) => Number(option.value) === entry.syncIntervalMinutes)?.label : "Manual sync"}{entry.lastSyncedAt ? ` · synced ${relativeTime(entry.lastSyncedAt)}` : " · never synced"}</p>{entry.lastSyncError && <p className="mt-1 text-[11px] text-destructive">{entry.lastSyncError}</p>}</div><div className="flex shrink-0 items-center gap-1"><Button variant="ghost" size="sm" onClick={() => toggle.mutate(entry)}>{entry.enabled ? "Pause" : "Enable"}</Button><Button variant="secondary" size="sm" disabled={sync.isPending} onClick={() => sync.mutate(entry.id)}>{sync.isPending && sync.variables === entry.id ? <LoaderCircle className="animate-spin" /> : <RefreshCw />}Sync now</Button><Button variant="ghost" size="icon-sm" title="Remove integration" onClick={() => remove.mutate(entry.id)}><Trash2 /></Button></div></div>; })}{integrations.data?.length === 0 && <div className="rounded-lg border border-dashed border-border px-5 py-8 text-center"><CloudDownload className="mx-auto size-6 text-muted-foreground" /><p className="mt-2 text-xs font-medium">No integrations installed</p><p className="mt-1 text-[11px] text-muted-foreground">Install a provider below to import external work.</p></div>}</div></SettingsSection>
    <SettingsSection title="Integration plugins" description="Choose a provider to install into this workspace."><div className="grid gap-2 sm:grid-cols-2"><button className="integration-plugin-card" onClick={() => begin("gitlab")}><span className="grid size-10 place-items-center rounded-lg bg-[#FC6D26]/10 text-[#FC6D26]"><Gitlab className="size-5" /></span><span className="min-w-0 flex-1"><span className="block text-xs font-medium">GitLab</span><span className="mt-1 block text-[11px] leading-4 text-muted-foreground">Import open issues from GitLab.com or self-managed projects.</span></span><ChevronRight className="size-4 text-muted-foreground" /></button><button className="integration-plugin-card" onClick={() => begin("huly")}><span className="grid size-10 place-items-center rounded-lg bg-primary/10 text-primary"><Code2 className="size-5" /></span><span className="min-w-0 flex-1"><span className="block text-xs font-medium">Huly</span><span className="mt-1 block text-[11px] leading-4 text-muted-foreground">Import project issues through a Huly SDK connector.</span></span><ChevronRight className="size-4 text-muted-foreground" /></button></div></SettingsSection>
    {installing && <SettingsSection title={`Install ${installing === "gitlab" ? "GitLab" : "Huly"}`} description={installing === "gitlab" ? "Use a personal, project, or group access token with permission to read issues." : "Point Boosted at a connector backed by Huly’s official API client. It should return an issue array from a GET request."}><form className="settings-card grid gap-3" onSubmit={(event) => { event.preventDefault(); install.mutate(); }}><label className="grid gap-1.5"><span className="settings-label">Connection name</span><Input value={name} onChange={(event) => setName(event.target.value)} required /></label>{installing === "gitlab" ? <><label className="grid gap-1.5"><span className="settings-label">GitLab URL</span><Input value={config.baseUrl ?? ""} onChange={(event) => setConfig({ ...config, baseUrl: event.target.value })} placeholder="https://gitlab.com" required /></label><label className="grid gap-1.5"><span className="settings-label">Project path or ID</span><Input value={config.project ?? ""} onChange={(event) => setConfig({ ...config, project: event.target.value })} placeholder="group/project" required /></label></> : <><label className="grid gap-1.5"><span className="settings-label">Connector endpoint</span><Input value={config.endpoint ?? ""} onChange={(event) => setConfig({ ...config, endpoint: event.target.value })} placeholder="https://connector.example.com/huly/issues" required /></label><div className="grid gap-3 sm:grid-cols-2"><label className="grid gap-1.5"><span className="settings-label">Huly workspace</span><Input value={config.workspace ?? ""} onChange={(event) => setConfig({ ...config, workspace: event.target.value })} required /></label><label className="grid gap-1.5"><span className="settings-label">Project identifier</span><Input value={config.project ?? ""} onChange={(event) => setConfig({ ...config, project: event.target.value })} required /></label></div></>}<label className="grid gap-1.5"><span className="settings-label">Access token</span><Input type="password" value={config.token ?? ""} onChange={(event) => setConfig({ ...config, token: event.target.value })} required /></label><label className="grid gap-1.5"><span className="settings-label">Automatic import</span><select className="settings-select" value={schedule} onChange={(event) => setSchedule(event.target.value)}>{scheduleOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>{install.error && <p className="text-xs text-destructive">{install.error.message}</p>}<div className="flex justify-end gap-2"><Button type="button" variant="ghost" onClick={() => setInstalling(undefined)}>Cancel</Button><Button disabled={install.isPending || !name.trim()}>{install.isPending && <LoaderCircle className="animate-spin" />}Install plugin</Button></div></form></SettingsSection>}
    {sync.data && <p className="text-xs text-success">{sync.data.message}</p>}{sync.error && <p className="text-xs text-destructive">{sync.error.message}</p>}</div>;
}

function collectObjects(value: unknown): Record<string, any>[] {
  if (Array.isArray(value)) return value.filter((entry): entry is Record<string, any> => Boolean(entry) && typeof entry === "object");
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  for (const key of ["data", "servers", "items", "mcpServers"]) { const found = collectObjects(record[key]); if (found.length) return found; }
  return [];
}

function JsonPanel({ value, empty }: { value: unknown; empty: string }) {
  if (!value) return <p className="text-[11px] text-muted-foreground">{empty}</p>;
  return <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-all rounded-md bg-background p-3 font-mono text-[10px] leading-5 text-muted-foreground">{JSON.stringify(value, null, 2)}</pre>;
}

function CodexSettings() {
  const projectId = useAppStore((state) => state.selectedProjectId);
  const user = useAppStore((state) => state.user);
  const queryClient = useQueryClient();
  const settings = useQuery({ queryKey: ["workspace-codex-settings", projectId], queryFn: () => api.workspaceCodexSettings(projectId!), enabled: Boolean(projectId), refetchInterval: 30_000, retry: false });
  const setup = useQuery({ queryKey: ["setup"], queryFn: api.setupState, refetchInterval: 5_000 });
  const [instructions, setInstructions] = useState("");
  const [mcpName, setMcpName] = useState("");
  const [mcpType, setMcpType] = useState<"url" | "command">("url");
  const [mcpValue, setMcpValue] = useState("");
  const [mcpArgs, setMcpArgs] = useState("");
  const [copied, setCopied] = useState(false);
  useEffect(() => { if (settings.data) setInstructions(settings.data.instructions); }, [settings.data]);
  const save = useMutation({ mutationFn: () => api.updateWorkspaceCodexSettings(projectId!, instructions), onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["workspace-codex-settings", projectId] }) });
  const addMcp = useMutation({ mutationFn: () => api.upsertWorkspaceMcp(projectId!, mcpName, mcpType === "url" ? { url: mcpValue } : { command: mcpValue, args: mcpArgs.split(/\s+/).filter(Boolean) }), onSuccess: () => { setMcpName(""); setMcpValue(""); setMcpArgs(""); void queryClient.invalidateQueries({ queryKey: ["workspace-codex-settings", projectId] }); } });
  const login = useMutation({ mutationFn: api.startCodexLogin, onSuccess: () => void setup.refetch() });
  const mcps = useMemo(() => collectObjects(settings.data?.mcps), [settings.data?.mcps]);
  const codex = setup.data?.codex;
  return <div className="settings-content"><SettingsSection title="Status" description="Connection, account, usage, and limits reported by the Codex app-server."><div className="grid gap-2 sm:grid-cols-3"><div className="settings-metric"><Activity /><span><span className="settings-label">CLI status</span><strong className={codex?.authenticated ? "text-success" : "text-warning"}>{codex?.authenticated ? "Ready" : codex?.available ? "Login required" : "Unavailable"}</strong><small>{codex?.version ?? "Not detected"}</small></span></div><div className="settings-metric"><CircleGauge /><span><span className="settings-label">Usage</span><strong>{settings.data?.usage ? "Available" : "No data"}</strong><small>Account token activity</small></span></div><div className="settings-metric"><Shield /><span><span className="settings-label">Limits</span><strong>{settings.data?.rateLimits ? "Current" : "No data"}</strong><small>Rolling account limits</small></span></div></div>{settings.error && <p className="mt-2 text-xs text-destructive">{settings.error.message}</p>}{!codex?.authenticated && codex?.available && user?.role === "admin" && !login.data && <Button className="mt-3" onClick={() => login.mutate()} disabled={login.isPending}>{login.isPending && <LoaderCircle className="animate-spin" />}Connect with ChatGPT</Button>}{login.data && !codex?.authenticated && <div className="mt-3 rounded-lg border border-primary/25 bg-primary/5 p-3"><p className="text-xs">Open <a className="text-primary hover:underline" href={login.data.verificationUrl} target="_blank" rel="noreferrer">the verification page <ExternalLink className="inline size-3" /></a>, then enter:</p><button className="mt-2 flex items-center gap-2 rounded-md border border-border bg-background px-3 py-2 font-mono tracking-[0.2em]" onClick={() => { void navigator.clipboard.writeText(login.data!.userCode); setCopied(true); }}>{login.data.userCode}<Copy className="size-3.5" /></button>{copied && <p className="mt-1 text-[10px] text-success">Copied</p>}</div>}<details className="mt-3"><summary className="cursor-pointer text-[11px] text-muted-foreground">Raw usage and limits</summary><div className="mt-2 grid gap-2 sm:grid-cols-2"><JsonPanel value={settings.data?.usage} empty="Usage is unavailable." /><JsonPanel value={settings.data?.rateLimits} empty="Limits are unavailable." /></div></details></SettingsSection>
    <SettingsSection title="Workspace instructions" description="These instructions are added to every planning and execution run created from this workspace."><Textarea className="min-h-36 font-mono text-xs leading-5" value={instructions} onChange={(event) => setInstructions(event.target.value)} placeholder="Repository conventions, required checks, architecture boundaries…" /><div className="mt-2 flex items-center justify-between"><span className="text-[10px] text-muted-foreground">Stored in Boosted and applied at run time.</span><Button size="sm" onClick={() => save.mutate()} disabled={save.isPending}>{save.isPending ? <LoaderCircle className="animate-spin" /> : <Save />}Save instructions</Button></div>{save.error && <p className="mt-2 text-xs text-destructive">{save.error.message}</p>}</SettingsSection>
    <SettingsSection title="MCP servers" description="Inspect active Codex MCPs and add workspace-local servers to .codex/config.toml."><div className="grid gap-1.5">{mcps.map((mcp, index) => <div key={String(mcp.name ?? mcp.id ?? index)} className="settings-card flex items-center gap-3 py-2.5"><Plug className="size-4 text-muted-foreground" /><div className="min-w-0 flex-1"><p className="truncate text-xs font-medium">{String(mcp.name ?? mcp.id ?? "MCP server")}</p><p className="mt-0.5 truncate text-[10px] text-muted-foreground">{String(mcp.status ?? mcp.authStatus ?? "Configured")}</p></div>{mcp.tools && <span className="text-[10px] text-muted-foreground">{Array.isArray(mcp.tools) ? mcp.tools.length : ""} tools</span>}</div>)}{mcps.length === 0 && <p className="text-[11px] text-muted-foreground">No MCP servers reported for this workspace.</p>}</div><form className="mt-3 grid gap-2 rounded-lg border border-border bg-background/25 p-3" onSubmit={(event) => { event.preventDefault(); addMcp.mutate(); }}><p className="text-xs font-medium">Add MCP server</p><div className="grid gap-2 sm:grid-cols-[1fr_120px]"><Input placeholder="Server name" value={mcpName} onChange={(event) => setMcpName(event.target.value)} required /><select className="settings-select" value={mcpType} onChange={(event) => setMcpType(event.target.value as "url" | "command")}><option value="url">HTTP URL</option><option value="command">Command</option></select></div><Input placeholder={mcpType === "url" ? "https://mcp.example.com" : "npx"} value={mcpValue} onChange={(event) => setMcpValue(event.target.value)} required />{mcpType === "command" && <Input placeholder="Arguments, separated by spaces" value={mcpArgs} onChange={(event) => setMcpArgs(event.target.value)} />}<div className="flex justify-end"><Button size="sm" disabled={addMcp.isPending || !mcpName || !mcpValue}>{addMcp.isPending ? <LoaderCircle className="animate-spin" /> : <Plus />}Add server</Button></div>{addMcp.error && <p className="text-xs text-destructive">{addMcp.error.message}</p>}</form></SettingsSection></div>;
}

function TeamSettings() {
  const user = useAppStore((state) => state.user);
  const queryClient = useQueryClient();
  const [username, setUsername] = useState(""); const [password, setPassword] = useState("");
  const users = useQuery({ queryKey: ["users"], queryFn: api.users, enabled: user?.role === "admin" });
  const create = useMutation({ mutationFn: () => api.createUser(username, password), onSuccess: () => { setUsername(""); setPassword(""); void queryClient.invalidateQueries({ queryKey: ["users"] }); } });
  return <div className="settings-content"><SettingsSection title="Workspace access" description="Boosted members currently have access to every registered workspace and task."><div className="grid gap-1">{users.data?.map((entry) => <div key={entry.id} className="settings-card flex items-center gap-3 py-2.5"><div className="grid size-8 place-items-center rounded-full bg-secondary text-xs font-semibold uppercase">{entry.username.slice(0, 1)}</div><div className="min-w-0 flex-1"><p className="text-xs font-medium">{entry.username}</p><p className="text-[10px] capitalize text-muted-foreground">{entry.role}{entry.mustChangePassword ? " · password change required" : ""}</p></div>{entry.disabled && <span className="text-[10px] text-destructive">Disabled</span>}</div>)}</div></SettingsSection>{user?.role === "admin" && <SettingsSection title="Invite member" description="Create an account with a temporary password. The member must replace it on first login."><form className="settings-card grid gap-2" onSubmit={(event: FormEvent) => { event.preventDefault(); create.mutate(); }}><div className="grid gap-2 sm:grid-cols-2"><Input placeholder="Username" minLength={3} value={username} onChange={(event) => setUsername(event.target.value)} required /><Input type="password" placeholder="Temporary password" value={password} onChange={(event) => setPassword(event.target.value)} required /></div><div className="flex justify-end"><Button size="sm" disabled={create.isPending || username.length < 3 || !password}>{create.isPending ? <LoaderCircle className="animate-spin" /> : <UserPlus />}Create member</Button></div>{create.error && <p className="text-xs text-destructive">{create.error.message}</p>}</form></SettingsSection>}</div>;
}

export function SettingsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [section, setSection] = useState<Section>("workspace");
  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent className="settings-dialog max-w-5xl gap-0 overflow-hidden p-0"><div className="settings-layout"><aside className="settings-sidebar"><DialogHeader className="px-3 pb-4 pt-2"><DialogTitle>Settings</DialogTitle><DialogDescription>Workspace and Codex configuration.</DialogDescription></DialogHeader><nav className="grid gap-0.5">{sections.map(({ id, label, icon: Icon }) => <button key={id} className={cn("settings-nav-item", section === id && "settings-nav-item-active")} onClick={() => setSection(id)}><Icon />{label}</button>)}</nav></aside><main className="min-h-0 overflow-y-auto">{section === "workspace" && <WorkspaceSettings />}{section === "integrations" && <IntegrationsSettings />}{section === "codex" && <CodexSettings />}{section === "team" && <TeamSettings />}</main></div></DialogContent></Dialog>;
}
