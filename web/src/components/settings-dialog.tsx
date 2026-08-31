import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Activity, Bell, BellRing, Bot, ChevronRight, CircleGauge, Clock, CloudDownload, Code2, Copy, ExternalLink, Flame, GitBranch, Globe2, LoaderCircle, Pencil, Plug, Plus, RefreshCw, Save, Server, Settings2, Shield, Trash2, UserPlus, Users, Workflow } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api";
import { formatDuration, formatExactNumber, formatPercent, formatWindowDuration, rateLimitBuckets, rateLimitLabel } from "@/lib/codex-usage";
import { defaultNotificationSettings, notificationEventDefinitions, notificationPermission, readNotificationSettings, requestNotificationPermission, showTestNotification, writeNotificationSettings, type PwaNotificationSettings } from "@/lib/notifications";
import { useAppStore } from "@/lib/store";
import type { CodexRateLimitWindow, Integration, IntegrationDiscoveryTarget } from "@/lib/types";
import { checkAndInstallAppUpdate, formatUpdateProgress, isDesktopApp, useAppUpdateState } from "@/lib/updater";
import { cn, relativeTime } from "@/lib/utils";
import { ConnectionsManager } from "@/components/machine-manager";

const Gitlab = GitBranch;

type Section = "connections" | "notifications" | "web" | "application" | "team" | "workspace" | "integrations" | "codex";

const sectionGroups: { label: string; sections: { id: Section; label: string; icon: typeof Settings2 }[] }[] = [
  { label: "Global", sections: [
    { id: "connections", label: "Connections", icon: Server },
    { id: "notifications", label: "Notifications", icon: Bell },
    { id: "web", label: "Web interface", icon: Globe2 },
    { id: "application", label: "Application", icon: RefreshCw },
    { id: "team", label: "Team", icon: Users },
  ] },
  { label: "Workspace", sections: [
    { id: "workspace", label: "General", icon: Settings2 },
    { id: "integrations", label: "Integrations", icon: Plug },
    { id: "codex", label: "Codex", icon: Bot },
  ] },
];

function ConnectionsSettings() {
  return <div className="settings-content"><SettingsSection title="Boosted machines" description="Switch between independent Boosted servers. Accounts, projects, tasks, and sessions stay isolated per connection."><ConnectionsManager embedded /></SettingsSection></div>;
}

function SettingsSection({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  return <section className="settings-section"><div className="mb-4"><h2 className="text-sm font-semibold">{title}</h2><p className="mt-1 text-xs leading-5 text-muted-foreground">{description}</p></div>{children}</section>;
}

function GlobalWebSettings() {
  const user = useAppStore((state) => state.user);
  const queryClient = useQueryClient();
  const settings = useQuery({ queryKey: ["global-settings"], queryFn: api.globalSettings });
  const [port, setPort] = useState("4782");
  const [webUiEnabled, setWebUiEnabled] = useState(true);
  const [allowedIps, setAllowedIps] = useState("");
  useEffect(() => {
    if (!settings.data) return;
    setPort(String(settings.data.webPort));
    setWebUiEnabled(settings.data.webUiEnabled);
    setAllowedIps(settings.data.allowedIps.join("\n"));
  }, [settings.data]);
  const parsedPort = Number(port);
  const save = useMutation({
    mutationFn: () => api.updateGlobalSettings({
      webPort: parsedPort,
      webUiEnabled,
      allowedIps: allowedIps.split(/[\n,]+/).map((value) => value.trim()).filter(Boolean),
    }),
    onSuccess: (saved) => {
      setPort(String(saved.webPort));
      setAllowedIps(saved.allowedIps.join("\n"));
      void queryClient.invalidateQueries({ queryKey: ["global-settings"] });
    },
  });
  const isAdmin = user?.role === "admin";
  const validPort = Number.isInteger(parsedPort) && parsedPort >= 1 && parsedPort <= 65535;
  return <div className="settings-content">
    <SettingsSection title="Web interface" description="Configure how this Boosted instance accepts browser connections. The default is public access on port 4782.">
      <div className="settings-card grid gap-4">
        <label className="grid gap-1.5"><span className="settings-label">Listening port</span><Input type="number" min={1} max={65535} value={port} disabled={!isAdmin} onChange={(event) => setPort(event.target.value)} /></label>
        <label className="flex items-start gap-3"><input className="mt-0.5 size-4 accent-primary" type="checkbox" checked={webUiEnabled} disabled={!isAdmin} onChange={(event) => setWebUiEnabled(event.target.checked)} /><span><span className="block text-xs font-medium">Serve the web UI</span><span className="mt-0.5 block text-[11px] leading-4 text-muted-foreground">Turn this off to keep the API available without serving the browser application.</span></span></label>
        <label className="grid gap-1.5"><span className="settings-label">Allowed remote IPs</span><Textarea className="min-h-28 font-mono text-xs leading-5" value={allowedIps} disabled={!isAdmin} onChange={(event) => setAllowedIps(event.target.value)} placeholder={"Leave empty for public access\n192.0.2.10\n2001:db8::10"} /><span className="text-[10px] leading-4 text-muted-foreground">Enter one IPv4 or IPv6 address per line. Localhost is always allowed.</span></label>
        {!isAdmin && <p className="text-xs text-muted-foreground">Only an administrator can change global web settings.</p>}
        {settings.error && <p className="text-xs text-destructive">{settings.error.message}</p>}
        {save.error && <p className="text-xs text-destructive">{save.error.message}</p>}
        {save.isSuccess && <p className="text-xs text-success">Settings saved. Restart Boosted to apply them.</p>}
        <div className="flex items-center justify-between gap-3"><span className="text-[10px] leading-4 text-muted-foreground">CLI options override saved settings for that launch.</span><Button size="sm" disabled={!isAdmin || !validPort || save.isPending} onClick={() => save.mutate()}>{save.isPending ? <LoaderCircle className="animate-spin" /> : <Save />}Save web settings</Button></div>
      </div>
    </SettingsSection>
    <SettingsSection title="Access behavior" description="An empty allowlist accepts connections from any remote address. Once addresses are listed, all other remote clients receive a forbidden response.">
      <div className="settings-card flex items-center gap-3"><Shield className="size-5 text-muted-foreground" /><div><p className="text-xs font-medium">Authentication still applies</p><p className="mt-0.5 text-[11px] text-muted-foreground">The IP allowlist is an additional network boundary; users must still sign in to protected Boosted APIs.</p></div></div>
    </SettingsSection>
  </div>;
}

function WorkspaceSettings() {
  const projectId = useAppStore((state) => state.selectedProjectId);
  const projects = useQuery({ queryKey: ["projects"], queryFn: api.projects });
  const project = projects.data?.find((entry) => entry.id === projectId);
  return <div className="settings-content"><SettingsSection title="Workspace details" description="Settings on this page apply only to the selected workspace.">{project ? <div className="settings-card grid gap-4"><label className="grid gap-1.5"><span className="settings-label">Name</span><Input value={project.name} readOnly /></label><label className="grid gap-1.5"><span className="settings-label">Repository</span><Input className="font-mono text-xs" value={project.repoPath} readOnly /></label><label className="grid gap-1.5"><span className="settings-label">Default branch</span><Input className="font-mono text-xs" value={project.defaultBranch} readOnly /></label></div> : <p className="text-xs text-muted-foreground">Open a workspace to configure it.</p>}</SettingsSection><SettingsSection title="Task defaults" description="Imported and manually created tasks start on this workspace’s default branch."><div className="settings-card flex items-center gap-3"><Workflow className="size-5 text-muted-foreground" /><div><p className="text-xs font-medium">One isolated worktree per task</p><p className="mt-0.5 text-[11px] text-muted-foreground">Every task receives its own boosted/* branch and execution directory.</p></div></div></SettingsSection></div>;
}

function NotificationSettings() {
  const machineId = useAppStore((state) => state.activeMachineId);
  const [settings, setSettings] = useState<PwaNotificationSettings>({ ...defaultNotificationSettings, events: [...defaultNotificationSettings.events] });
  const [permission, setPermission] = useState(notificationPermission);
  const [requesting, setRequesting] = useState(false);
  const [message, setMessage] = useState<{ kind: "success" | "error"; text: string }>();

  useEffect(() => {
    if (machineId) setSettings(readNotificationSettings(machineId));
  }, [machineId]);

  useEffect(() => {
    const refreshPermission = () => setPermission(notificationPermission());
    window.addEventListener("focus", refreshPermission);
    document.addEventListener("visibilitychange", refreshPermission);
    return () => {
      window.removeEventListener("focus", refreshPermission);
      document.removeEventListener("visibilitychange", refreshPermission);
    };
  }, []);

  function update(next: PwaNotificationSettings) {
    if (!machineId) return;
    setSettings(next);
    writeNotificationSettings(machineId, next);
    setMessage(undefined);
  }

  async function toggleEnabled(enabled: boolean) {
    if (!enabled) {
      update({ ...settings, enabled: false });
      return;
    }
    setRequesting(true);
    setMessage(undefined);
    const nextPermission = await requestNotificationPermission();
    setPermission(nextPermission);
    setRequesting(false);
    if (nextPermission === "granted") update({ ...settings, enabled: true });
    else if (nextPermission === "denied") setMessage({ kind: "error", text: "Notifications are blocked in this browser’s site settings." });
    else setMessage({ kind: "error", text: "Notification permission was not granted." });
  }

  function toggleEvent(id: PwaNotificationSettings["events"][number], enabled: boolean) {
    const events = enabled ? [...new Set([...settings.events, id])] : settings.events.filter((entry) => entry !== id);
    update({ ...settings, events });
  }

  async function testNotification() {
    setMessage(undefined);
    const shown = await showTestNotification();
    setMessage(shown
      ? { kind: "success", text: "Test notification sent." }
      : { kind: "error", text: "The PWA service worker is not ready. Reload the production app and try again." });
  }

  const effectiveEnabled = settings.enabled && permission === "granted";
  const groups = ["Tasks", "Codex", "Integrations"] as const;
  const status = permission === "unsupported"
    ? "Notifications require the web app over HTTPS or localhost. They are not used by the desktop shell."
    : permission === "denied"
      ? "Permission is blocked. Allow notifications in your browser’s site settings, then return here."
      : permission === "default"
        ? "Your browser will ask for permission when you enable notifications."
        : effectiveEnabled
          ? "Notifications are enabled for this browser and Boosted machine."
          : "Permission is granted. Turn notifications on when you’re ready.";

  return <div className="settings-content">
    <SettingsSection title="PWA notifications" description="Receive system notifications for activity on this Boosted machine. Permission and preferences are stored per browser because each device controls its own notification access.">
      <div className="settings-card flex items-start gap-3">
        <div className="grid size-9 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary"><BellRing className="size-4" /></div>
        <div className="min-w-0 flex-1"><p className="text-xs font-medium">Enable notifications</p><p className="mt-1 text-[11px] leading-4 text-muted-foreground">{status}</p></div>
        <div className="inline-flex items-center gap-2 text-xs"><Switch aria-label="Enable notifications" checked={effectiveEnabled} disabled={!machineId || requesting || permission === "unsupported" || permission === "denied"} onCheckedChange={(checked) => void toggleEnabled(checked)} /><span className="min-w-8">{requesting ? "Requesting…" : effectiveEnabled ? "On" : "Off"}</span></div>
      </div>
      {message && <p className={cn("mt-2 text-xs", message.kind === "success" ? "text-success" : "text-destructive")}>{message.text}</p>}
    </SettingsSection>
    <SettingsSection title="Delivery" description="Choose whether Boosted should stay quiet while you are actively using this window.">
      <div className="grid gap-2 sm:grid-cols-2">
        <label className={cn("settings-card flex cursor-pointer items-start gap-3", settings.delivery === "background" && "border-primary/40 bg-accent")}><input className="mt-0.5 size-4 accent-primary" type="radio" name="notification-delivery" checked={settings.delivery === "background"} onChange={() => update({ ...settings, delivery: "background" })} /><span><span className="block text-xs font-medium">Only in the background</span><span className="mt-0.5 block text-[11px] leading-4 text-muted-foreground">Notify when this Boosted window is hidden or unfocused.</span></span></label>
        <label className={cn("settings-card flex cursor-pointer items-start gap-3", settings.delivery === "always" && "border-primary/40 bg-accent")}><input className="mt-0.5 size-4 accent-primary" type="radio" name="notification-delivery" checked={settings.delivery === "always"} onChange={() => update({ ...settings, delivery: "always" })} /><span><span className="block text-xs font-medium">Always</span><span className="mt-0.5 block text-[11px] leading-4 text-muted-foreground">Notify even while you are actively using Boosted.</span></span></label>
      </div>
    </SettingsSection>
    <SettingsSection title="Events" description="Select the activity that should produce a notification.">
      <div className="grid gap-4">{groups.map((group) => <section key={group}><p className="settings-label mb-2">{group}</p><div className="grid gap-2 sm:grid-cols-2">{notificationEventDefinitions.filter((event) => event.group === group).map((event) => <label key={event.id} className="settings-card flex cursor-pointer items-start gap-3 py-3"><input className="mt-0.5 size-4 accent-primary" type="checkbox" checked={settings.events.includes(event.id)} onChange={(input) => toggleEvent(event.id, input.target.checked)} /><span><span className="block text-xs font-medium">{event.label}</span><span className="mt-0.5 block text-[11px] leading-4 text-muted-foreground">{event.description}</span></span></label>)}</div></section>)}</div>
      <div className="mt-4 flex items-center justify-between gap-3"><span className="text-[10px] text-muted-foreground">Changes are saved immediately for this browser.</span><Button variant="secondary" size="sm" disabled={!effectiveEnabled} onClick={() => void testNotification()}><Bell />Send test notification</Button></div>
    </SettingsSection>
  </div>;
}

function ApplicationSettings() {
  const update = useAppUpdateState();
  const progress = formatUpdateProgress(update);
  const busy = ["checking", "downloading", "installing", "restarting"].includes(update.phase);
  const status = update.phase === "unsupported"
    ? "Automatic updates are available in the Boosted desktop app."
    : update.phase === "checking"
      ? "Checking GitHub Releases…"
      : update.phase === "up-to-date"
        ? "Boosted is up to date."
        : update.phase === "downloading"
          ? `Downloading version ${update.targetVersion ?? ""}${progress === undefined ? "…" : ` — ${progress}%`}`
          : update.phase === "installing"
            ? `Installing version ${update.targetVersion ?? ""}…`
            : update.phase === "restarting"
              ? "Update installed. Restarting Boosted…"
              : update.phase === "error"
                ? "The update check failed."
                : "Boosted checks for updates automatically.";

  return <div className="settings-content"><SettingsSection title="Application updates" description="Boosted checks GitHub Releases at startup and every six hours. New signed releases are downloaded, installed, and relaunched automatically."><div className="settings-card flex items-start gap-3"><div className="grid size-9 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary"><CloudDownload className="size-4" /></div><div className="min-w-0 flex-1"><p className="text-xs font-medium">{status}</p><p className="mt-1 text-[11px] text-muted-foreground">{update.currentVersion ? `Current version ${update.currentVersion}` : isDesktopApp() ? "Reading desktop version…" : "Browser session"}{update.lastCheckedAt ? ` · checked ${relativeTime(update.lastCheckedAt)} ago` : ""}</p>{update.error && <p className="mt-1 break-words text-[11px] text-destructive">{update.error}</p>}{update.phase === "downloading" && update.totalBytes && <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-secondary"><div className="h-full rounded-full bg-primary transition-[width]" style={{ width: `${progress ?? 0}%` }} /></div>}</div><Button variant="secondary" size="sm" disabled={!isDesktopApp() || busy} onClick={() => void checkAndInstallAppUpdate()}>{busy ? <LoaderCircle className="animate-spin" /> : <RefreshCw />}{update.phase === "error" ? "Try again" : "Check now"}</Button></div></SettingsSection><SettingsSection title="Release security" description="Every downloaded updater package must match Boosted’s embedded signing key before it can be installed."><div className="settings-card flex items-center gap-3"><Shield className="size-5 text-success" /><div><p className="text-xs font-medium">Signed updates required</p><p className="mt-0.5 text-[11px] text-muted-foreground">Update metadata and packages are served from monokaijs/boosted on GitHub.</p></div></div></SettingsSection></div>;
}

const scheduleOptions = [
  { value: "", label: "Manual only" }, { value: "15", label: "Every 15 minutes" },
  { value: "60", label: "Every hour" }, { value: "360", label: "Every 6 hours" },
  { value: "1440", label: "Every day" },
];

type GitlabTarget = { kind: "project" | "group"; identifier: string; legacyExternalIds?: boolean };
type HulyTarget = { workspace: string; project: string; legacyExternalIds?: boolean };
type DiscoveredIntegrationTarget = IntegrationDiscoveryTarget;

function providerIcon(provider: Integration["provider"]) {
  return provider === "gitlab" ? GitBranch : Code2;
}

function configString(config: Record<string, unknown>, key: string, fallback = "") {
  const value = config[key];
  return typeof value === "string" ? value : fallback;
}

function configTargets(config: Record<string, unknown>) {
  return Array.isArray(config.targets)
    ? config.targets.filter((target): target is Record<string, unknown> => Boolean(target) && typeof target === "object")
    : [];
}

function integrationTargetCount(integration: Integration) {
  return Math.max(configTargets(integration.config).length, configString(integration.config, "project") ? 1 : 0);
}

function discoveryTargetLabel(target: DiscoveredIntegrationTarget) {
  return target.name || target.fullPath || target.identifier;
}

function discoveryTargetMatchesSearch(target: DiscoveredIntegrationTarget, search: string) {
  const query = search.trim().toLocaleLowerCase();
  if (!query) return true;
  return [target.name, target.identifier, target.fullPath, target.workspace, target.workspaceName]
    .some((value) => value?.toLocaleLowerCase().includes(query));
}

function gitlabTargetMatches(target: GitlabTarget, discovered: DiscoveredIntegrationTarget) {
  return target.kind === discovered.kind
    && (target.identifier === discovered.identifier || Boolean(discovered.fullPath && target.identifier === discovered.fullPath));
}

function hulyTargetMatches(target: HulyTarget, discovered: DiscoveredIntegrationTarget) {
  return target.workspace === discovered.workspace
    && (target.project === discovered.identifier || Boolean(discovered.fullPath && target.project === discovered.fullPath));
}

function sameGitlabTarget(left: GitlabTarget, right: GitlabTarget) {
  return left.kind === right.kind && left.identifier === right.identifier;
}

function sameHulyTarget(left: HulyTarget, right: HulyTarget) {
  return left.workspace === right.workspace && left.project === right.project;
}

function DiscoveryTargetOption({ target, selected, onToggle }: { target: DiscoveredIntegrationTarget; selected: boolean; onToggle: (selected: boolean) => void }) {
  const label = discoveryTargetLabel(target);
  const detail = target.fullPath && target.fullPath !== label ? target.fullPath : target.identifier !== label ? target.identifier : undefined;
  return <label className="flex cursor-pointer items-start gap-2.5 rounded-md px-2 py-2 hover:bg-accent">
    <input className="mt-0.5 size-4 accent-primary" type="checkbox" checked={selected} onChange={(event) => onToggle(event.target.checked)} />
    <span className="min-w-0 flex-1"><span className="block truncate text-xs font-medium">{label}</span>{detail && <span className="mt-0.5 block truncate font-mono text-[10px] text-muted-foreground">{detail}</span>}</span>
  </label>;
}

export function IntegrationsSettings() {
  const projectId = useAppStore((state) => state.selectedProjectId);
  const queryClient = useQueryClient();
  const [installing, setInstalling] = useState<Integration["provider"]>();
  const [editingId, setEditingId] = useState<string>();
  const [name, setName] = useState("");
  const [schedule, setSchedule] = useState("");
  const [config, setConfig] = useState<Record<string, unknown>>({});
  const [gitlabTargets, setGitlabTargets] = useState<GitlabTarget[]>([]);
  const [hulyTargets, setHulyTargets] = useState<HulyTarget[]>([]);
  const [discoveredTargets, setDiscoveredTargets] = useState<DiscoveredIntegrationTarget[]>([]);
  const [discoverySearch, setDiscoverySearch] = useState("");
  const [discoveryError, setDiscoveryError] = useState<string>();
  const [discoveryLoading, setDiscoveryLoading] = useState(false);
  const [discoveryAttempted, setDiscoveryAttempted] = useState(false);
  const [discoveryRefresh, setDiscoveryRefresh] = useState(0);
  const discoveryGeneration = useRef(0);
  const immediateDiscovery = useRef(false);
  const persistedGitlabTargets = useRef<GitlabTarget[]>([]);
  const persistedHulyTargets = useRef<HulyTarget[]>([]);
  const selectionConnectionKey = useRef("");
  const integrations = useQuery({ queryKey: ["integrations", projectId], queryFn: () => api.integrations(projectId!), enabled: Boolean(projectId) });
  const baseUrl = configString(config, "baseUrl", "https://gitlab.com").trim();
  const endpoint = configString(config, "endpoint").trim();
  const accessToken = configString(config, "token").trim();
  const connectionKey = installing ? `${installing}\0${installing === "gitlab" ? baseUrl : endpoint}\0${accessToken}` : "";
  const discoveryReady = Boolean(projectId && installing && accessToken && (installing === "gitlab" ? baseUrl : endpoint));

  useEffect(() => {
    if (selectionConnectionKey.current !== connectionKey) {
      selectionConnectionKey.current = connectionKey;
      setGitlabTargets((current) => current.filter((target) => persistedGitlabTargets.current.some((saved) => sameGitlabTarget(target, saved))));
      setHulyTargets((current) => current.filter((target) => persistedHulyTargets.current.some((saved) => sameHulyTarget(target, saved))));
    }
    const generation = ++discoveryGeneration.current;
    setDiscoveredTargets([]);
    setDiscoveryError(undefined);
    setDiscoveryAttempted(false);
    setDiscoveryLoading(false);
    if (!projectId || !installing || !discoveryReady) return;

    let cancelled = false;
    const controller = new AbortController();
    const delay = immediateDiscovery.current ? 0 : 600;
    immediateDiscovery.current = false;
    const timeout = window.setTimeout(() => {
      setDiscoveryLoading(true);
      const connectionConfig = installing === "gitlab"
        ? { baseUrl, token: accessToken }
        : { endpoint, token: accessToken };
      void api.discoverIntegrationTargets(projectId, { provider: installing, config: connectionConfig }, controller.signal)
        .then((result) => {
          if (cancelled || generation !== discoveryGeneration.current) return;
          setDiscoveredTargets(result.targets);
          setDiscoveryAttempted(true);
        })
        .catch((caught: unknown) => {
          if (cancelled || generation !== discoveryGeneration.current) return;
          setDiscoveryError(caught instanceof Error ? caught.message : "Unable to explore integration targets.");
          setDiscoveryAttempted(true);
        })
        .finally(() => {
          if (!cancelled && generation === discoveryGeneration.current) setDiscoveryLoading(false);
        });
    }, delay);
    return () => {
      cancelled = true;
      controller.abort();
      window.clearTimeout(timeout);
    };
  }, [accessToken, baseUrl, connectionKey, discoveryReady, discoveryRefresh, endpoint, installing, projectId]);

  const save = useMutation({
    mutationFn: () => {
      if (!installing) throw new Error("Choose an integration provider");
      const { targets: _targets, project: _project, workspace: _workspace, ...sharedConfig } = config;
      const validGitlabTargets = gitlabTargets.filter((target) => target.identifier.trim());
      const validHulyTargets = hulyTargets.filter((target) => target.workspace.trim() && target.project.trim());
      const nextConfig = installing === "gitlab"
        ? { ...sharedConfig, baseUrl, token: accessToken, targets: validGitlabTargets.map((target) => ({ kind: target.kind, identifier: target.identifier.trim(), legacyExternalIds: Boolean(target.legacyExternalIds) })) }
        : { ...sharedConfig, endpoint, token: accessToken, targets: validHulyTargets.map((target) => ({ workspace: target.workspace.trim(), project: target.project.trim(), legacyExternalIds: Boolean(target.legacyExternalIds) })) };
      const enabled = editingId ? integrations.data?.find((entry) => entry.id === editingId)?.enabled ?? true : true;
      const input = { name, config: nextConfig, enabled, syncIntervalMinutes: schedule ? Number(schedule) : undefined };
      return editingId
        ? api.updateIntegration(projectId!, editingId, input)
        : api.createIntegration(projectId!, { provider: installing, ...input });
    },
    onSuccess: () => {
      closeEditor();
      void queryClient.invalidateQueries({ queryKey: ["integrations", projectId] });
    },
  });
  const sync = useMutation({ mutationFn: (id: string) => api.syncIntegration(projectId!, id), onSuccess: () => { void queryClient.invalidateQueries({ queryKey: ["integrations", projectId] }); void queryClient.invalidateQueries({ queryKey: ["tasks", projectId] }); } });
  const remove = useMutation({ mutationFn: (id: string) => api.deleteIntegration(projectId!, id), onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["integrations", projectId] }) });
  const toggle = useMutation({ mutationFn: (entry: Integration) => api.updateIntegration(projectId!, entry.id, { name: entry.name, config: entry.config, enabled: !entry.enabled, syncIntervalMinutes: entry.syncIntervalMinutes }), onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["integrations", projectId] }) });

  function resetDiscovery() {
    discoveryGeneration.current += 1;
    immediateDiscovery.current = false;
    setDiscoveredTargets([]);
    setDiscoverySearch("");
    setDiscoveryError(undefined);
    setDiscoveryLoading(false);
    setDiscoveryAttempted(false);
    setDiscoveryRefresh((current) => current + 1);
  }

  function begin(provider: Integration["provider"]) {
    resetDiscovery();
    persistedGitlabTargets.current = [];
    persistedHulyTargets.current = [];
    selectionConnectionKey.current = "";
    setInstalling(provider);
    setEditingId(undefined);
    setName(provider === "gitlab" ? "GitLab issues" : "Huly tasks");
    setSchedule("");
    setConfig(provider === "gitlab" ? { baseUrl: "https://gitlab.com", token: "" } : { endpoint: "", token: "" });
    setGitlabTargets([]);
    setHulyTargets([]);
  }

  function edit(entry: Integration) {
    resetDiscovery();
    setInstalling(entry.provider);
    setEditingId(entry.id);
    setName(entry.name);
    setSchedule(entry.syncIntervalMinutes ? String(entry.syncIntervalMinutes) : "");
    setConfig(entry.config);
    const targets = configTargets(entry.config);
    if (entry.provider === "gitlab") {
      const parsed = targets.flatMap((target): GitlabTarget[] => {
        const kind = target.kind === "group" ? "group" : "project";
        const identifier = typeof target.identifier === "string" ? target.identifier.trim() : "";
        return identifier ? [{ kind, identifier, legacyExternalIds: target.legacyExternalIds === true }] : [];
      });
      const legacyProject = configString(entry.config, "project").trim();
      const savedTargets = parsed.length ? parsed : legacyProject ? [{ kind: "project" as const, identifier: legacyProject, legacyExternalIds: true }] : [];
      persistedGitlabTargets.current = savedTargets;
      persistedHulyTargets.current = [];
      selectionConnectionKey.current = "";
      setGitlabTargets(savedTargets);
      setHulyTargets([]);
    } else {
      const parsed = targets.flatMap((target): HulyTarget[] => {
        const workspace = typeof target.workspace === "string" ? target.workspace.trim() : "";
        const project = typeof target.project === "string" ? target.project.trim() : "";
        return workspace || project ? [{ workspace, project, legacyExternalIds: target.legacyExternalIds === true }] : [];
      });
      const legacyWorkspace = configString(entry.config, "workspace").trim();
      const legacyProject = configString(entry.config, "project").trim();
      const savedTargets = parsed.length ? parsed : legacyWorkspace && legacyProject ? [{ workspace: legacyWorkspace, project: legacyProject, legacyExternalIds: true }] : [];
      persistedGitlabTargets.current = [];
      persistedHulyTargets.current = savedTargets;
      selectionConnectionKey.current = "";
      setHulyTargets(savedTargets);
      setGitlabTargets([]);
    }
  }

  function closeEditor() {
    resetDiscovery();
    persistedGitlabTargets.current = [];
    persistedHulyTargets.current = [];
    selectionConnectionKey.current = "";
    setInstalling(undefined);
    setEditingId(undefined);
    setName("");
    setSchedule("");
    setConfig({});
  }

  function refreshTargets() {
    if (!discoveryReady || discoveryLoading) return;
    immediateDiscovery.current = true;
    setDiscoveryRefresh((current) => current + 1);
  }

  function toggleDiscoveredTarget(target: DiscoveredIntegrationTarget, selected: boolean) {
    if (installing === "gitlab") {
      setGitlabTargets((current) => {
        const matches = current.some((entry) => gitlabTargetMatches(entry, target));
        if (selected && !matches) return [...current, { kind: target.kind, identifier: target.identifier }];
        if (!selected) return current.filter((entry) => !gitlabTargetMatches(entry, target));
        return current;
      });
      return;
    }
    if (target.kind !== "project" || !target.workspace) return;
    const workspace = target.workspace;
    setHulyTargets((current) => {
      const matches = current.some((entry) => hulyTargetMatches(entry, target));
      if (selected && !matches) return [...current, { workspace, project: target.identifier }];
      if (!selected) return current.filter((entry) => !hulyTargetMatches(entry, target));
      return current;
    });
  }

  const hasPartialHulyTarget = hulyTargets.some((target) => Boolean(target.workspace.trim()) !== Boolean(target.project.trim()));
  const selectionsMatchConnection = selectionConnectionKey.current === connectionKey;
  const targetsValid = discoveryReady && (installing === "gitlab"
    ? selectionsMatchConnection && gitlabTargets.some((target) => target.identifier.trim())
    : selectionsMatchConnection && !hasPartialHulyTarget && hulyTargets.some((target) => target.workspace.trim() && target.project.trim()));
  const selectedTargetCount = installing === "gitlab"
    ? gitlabTargets.filter((target) => target.identifier.trim()).length
    : hulyTargets.filter((target) => target.workspace.trim() && target.project.trim()).length;
  const visibleDiscoveredTargets = discoveredTargets.filter((target) => discoveryTargetMatchesSearch(target, discoverySearch));
  const missingGitlabTargets = installing === "gitlab"
    ? gitlabTargets.filter((target) => target.identifier.trim() && !discoveredTargets.some((discovered) => gitlabTargetMatches(target, discovered)))
    : [];
  const missingHulyTargets = installing === "huly"
    ? hulyTargets.filter((target) => target.workspace.trim() && target.project.trim() && !discoveredTargets.some((discovered) => hulyTargetMatches(target, discovered)))
    : [];
  const visibleMissingGitlabTargets = missingGitlabTargets.filter((target) => `${target.kind} ${target.identifier}`.toLocaleLowerCase().includes(discoverySearch.trim().toLocaleLowerCase()));
  const visibleMissingHulyTargets = missingHulyTargets.filter((target) => `${target.workspace} ${target.project}`.toLocaleLowerCase().includes(discoverySearch.trim().toLocaleLowerCase()));
  const gitlabGroups = visibleDiscoveredTargets.filter((target) => target.kind === "group");
  const gitlabProjects = visibleDiscoveredTargets.filter((target) => target.kind === "project");
  const hulyWorkspaces = visibleDiscoveredTargets.reduce<Map<string, { name: string; targets: DiscoveredIntegrationTarget[] }>>((workspaces, target) => {
    if (target.kind !== "project") return workspaces;
    const workspace = target.workspace || "Unknown workspace";
    const current = workspaces.get(workspace) ?? { name: target.workspaceName || workspace, targets: [] };
    current.targets.push(target);
    workspaces.set(workspace, current);
    return workspaces;
  }, new Map());

  return <div className="settings-content">
    <SettingsSection title="Installed integrations" description="Connections belong to this workspace and can import from several external projects, repositories, or groups.">
      <div className="grid gap-2">
        {integrations.isLoading && <p className="text-xs text-muted-foreground">Loading integrations…</p>}
        {integrations.data?.map((entry) => {
          const Icon = providerIcon(entry.provider);
          const targetCount = integrationTargetCount(entry);
          return <div key={entry.id} className="settings-card flex items-start gap-3">
            <div className="grid size-9 shrink-0 place-items-center rounded-lg bg-secondary"><Icon className="size-4" /></div>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2"><p className="text-xs font-medium">{entry.name}</p><span className={cn("rounded-full px-1.5 py-0.5 text-[9px] capitalize", entry.enabled ? "bg-success/10 text-success" : "bg-secondary text-muted-foreground")}>{entry.enabled ? "Active" : "Paused"}</span>{entry.lastSyncStatus && <span className="text-[10px] capitalize text-muted-foreground">{entry.lastSyncStatus}</span>}</div>
              <p className="mt-1 text-[11px] capitalize text-muted-foreground">{entry.provider} · {targetCount} {targetCount === 1 ? "source" : "sources"} · {entry.syncIntervalMinutes ? scheduleOptions.find((option) => Number(option.value) === entry.syncIntervalMinutes)?.label : "Manual sync"}{entry.lastSyncedAt ? ` · synced ${relativeTime(entry.lastSyncedAt)}` : " · never synced"}</p>
              {entry.lastSyncError && <p className="mt-1 text-[11px] text-destructive">{entry.lastSyncError}</p>}
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <Button variant="ghost" size="icon-sm" title="Edit integration" disabled={save.isPending} onClick={() => edit(entry)}><Pencil /></Button>
              <Button variant="ghost" size="sm" onClick={() => toggle.mutate(entry)}>{entry.enabled ? "Pause" : "Enable"}</Button>
              <Button variant="secondary" size="sm" disabled={sync.isPending} onClick={() => sync.mutate(entry.id)}>{sync.isPending && sync.variables === entry.id ? <LoaderCircle className="animate-spin" /> : <RefreshCw />}Sync now</Button>
              <Button variant="ghost" size="icon-sm" title="Remove integration" onClick={() => remove.mutate(entry.id)}><Trash2 /></Button>
            </div>
          </div>;
        })}
        {integrations.data?.length === 0 && <div className="rounded-lg border border-dashed border-border px-5 py-8 text-center"><CloudDownload className="mx-auto size-6 text-muted-foreground" /><p className="mt-2 text-xs font-medium">No integrations installed</p><p className="mt-1 text-[11px] text-muted-foreground">Install a provider below to import external work.</p></div>}
      </div>
    </SettingsSection>
    <SettingsSection title="Integration plugins" description="Choose a provider to install into this workspace.">
      <div className="grid gap-2 sm:grid-cols-2">
        <button className="integration-plugin-card" disabled={save.isPending} onClick={() => begin("gitlab")}><span className="grid size-10 place-items-center rounded-lg bg-[#FC6D26]/10 text-[#FC6D26]"><Gitlab className="size-5" /></span><span className="min-w-0 flex-1"><span className="block text-xs font-medium">GitLab</span><span className="mt-1 block text-[11px] leading-4 text-muted-foreground">Import open issues from multiple GitLab projects, repositories, or groups.</span></span><ChevronRight className="size-4 text-muted-foreground" /></button>
        <button className="integration-plugin-card" disabled={save.isPending} onClick={() => begin("huly")}><span className="grid size-10 place-items-center rounded-lg bg-primary/10 text-primary"><Code2 className="size-5" /></span><span className="min-w-0 flex-1"><span className="block text-xs font-medium">Huly</span><span className="mt-1 block text-[11px] leading-4 text-muted-foreground">Import issues from multiple Huly workspace projects.</span></span><ChevronRight className="size-4 text-muted-foreground" /></button>
      </div>
    </SettingsSection>
    {installing && <SettingsSection title={`${editingId ? "Edit" : "Install"} ${installing === "gitlab" ? "GitLab" : "Huly"}`} description={installing === "gitlab" ? "Add every project, repository, or group whose open issues should feed this workspace." : "Add every Huly workspace/project pair that should feed this workspace through the connector."}>
      <form className="settings-card grid gap-4" onSubmit={(event) => { event.preventDefault(); if (!save.isPending && name.trim() && targetsValid) save.mutate(); }}>
        <label className="grid gap-1.5"><span className="settings-label">Connection name</span><Input value={name} onChange={(event) => setName(event.target.value)} required /></label>
        {installing === "gitlab"
          ? <label className="grid gap-1.5"><span className="settings-label">GitLab URL</span><Input value={configString(config, "baseUrl", "https://gitlab.com")} onChange={(event) => setConfig((current) => ({ ...current, baseUrl: event.target.value }))} placeholder="https://gitlab.com" required /></label>
          : <label className="grid gap-1.5"><span className="settings-label">Connector endpoint</span><Input value={configString(config, "endpoint")} onChange={(event) => setConfig((current) => ({ ...current, endpoint: event.target.value }))} placeholder="https://connector.example.com/huly/issues" required /></label>}
        <label className="grid gap-1.5"><span className="settings-label">Access token</span><Input type="password" value={configString(config, "token")} onChange={(event) => setConfig((current) => ({ ...current, token: event.target.value }))} required /></label>
        <div className="grid gap-2">
          <div className="flex items-start justify-between gap-3">
            <div><span className="settings-label">Explore targets</span><p className="mt-1 text-[10px] leading-4 text-muted-foreground">{installing === "gitlab" ? "Select projects or groups visible to this token. A group imports issues from its visible projects." : "Select projects from any workspace returned by the Huly connector."}</p></div>
            <Button type="button" variant="secondary" size="sm" disabled={!discoveryReady || discoveryLoading} onClick={refreshTargets}>{discoveryLoading ? <LoaderCircle className="animate-spin" /> : <RefreshCw />}Refresh</Button>
          </div>
          <Input aria-label="Search integration targets" value={discoverySearch} onChange={(event) => setDiscoverySearch(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") event.preventDefault(); }} placeholder={installing === "gitlab" ? "Search groups and projects…" : "Search workspaces and projects…"} disabled={!discoveryReady} />
          <div className="max-h-80 overflow-y-auto rounded-lg border border-border bg-background/35 p-2">
            {!discoveryReady && <p className="px-2 py-5 text-center text-[11px] text-muted-foreground">Enter the connection URL and access token to explore available targets.</p>}
            {discoveryReady && discoveryLoading && <p className="flex items-center justify-center gap-2 px-2 py-5 text-[11px] text-muted-foreground"><LoaderCircle className="size-3.5 animate-spin" />Exploring available targets…</p>}
            {discoveryReady && !discoveryLoading && !discoveryAttempted && !discoveryError && <p className="px-2 py-5 text-center text-[11px] text-muted-foreground">Preparing to explore available targets…</p>}
            {discoveryError && <div className="px-2 py-4 text-center"><p className="text-[11px] text-destructive">{discoveryError}</p>{selectedTargetCount > 0 && <p className="mt-1 text-[10px] text-muted-foreground">Your {selectedTargetCount} saved {selectedTargetCount === 1 ? "selection remains" : "selections remain"} selected and can be reviewed under advanced manual entry.</p>}<Button className="mt-2" type="button" variant="secondary" size="sm" onClick={refreshTargets}>Try again</Button></div>}
            {!discoveryLoading && !discoveryError && installing === "gitlab" && <div className="grid gap-3">
              {gitlabGroups.length > 0 && <section><div className="flex items-center justify-between px-2 pb-1"><p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Groups</p><span className="text-[10px] text-muted-foreground">{gitlabGroups.length}</span></div>{gitlabGroups.map((target) => <DiscoveryTargetOption key={`group:${target.identifier}`} target={target} selected={gitlabTargets.some((entry) => gitlabTargetMatches(entry, target))} onToggle={(selected) => toggleDiscoveredTarget(target, selected)} />)}</section>}
              {gitlabProjects.length > 0 && <section><div className="flex items-center justify-between px-2 pb-1"><p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Projects</p><span className="text-[10px] text-muted-foreground">{gitlabProjects.length}</span></div>{gitlabProjects.map((target) => <DiscoveryTargetOption key={`project:${target.identifier}`} target={target} selected={gitlabTargets.some((entry) => gitlabTargetMatches(entry, target))} onToggle={(selected) => toggleDiscoveredTarget(target, selected)} />)}</section>}
            </div>}
            {!discoveryLoading && !discoveryError && installing === "huly" && <div className="grid gap-3">
              {Array.from(hulyWorkspaces.entries()).map(([workspace, group]) => <section key={workspace}><div className="flex items-center justify-between px-2 pb-1"><div><p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{group.name}</p>{group.name !== workspace && <p className="font-mono text-[9px] text-muted-foreground">{workspace}</p>}</div><span className="text-[10px] text-muted-foreground">{group.targets.length}</span></div>{group.targets.map((target) => <DiscoveryTargetOption key={`${workspace}:${target.identifier}`} target={target} selected={hulyTargets.some((entry) => hulyTargetMatches(entry, target))} onToggle={(selected) => toggleDiscoveredTarget(target, selected)} />)}</section>)}
            </div>}
            {visibleMissingGitlabTargets.length > 0 && <section className="mt-3"><p className="px-2 pb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Saved or manual selections</p>{visibleMissingGitlabTargets.map((target, index) => <label key={`${target.kind}:${target.identifier}:${index}`} className="flex cursor-pointer items-start gap-2.5 rounded-md px-2 py-2 hover:bg-accent"><input className="mt-0.5 size-4 accent-primary" type="checkbox" checked onChange={() => setGitlabTargets((current) => current.filter((entry) => entry !== target))} /><span className="min-w-0 flex-1"><span className="block truncate text-xs font-medium">{target.identifier}</span><span className="mt-0.5 block text-[10px] capitalize text-muted-foreground">{target.kind} · {discoveryAttempted ? "not returned by discovery" : "saved selection"}</span></span></label>)}</section>}
            {visibleMissingHulyTargets.length > 0 && <section className="mt-3"><p className="px-2 pb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Saved or manual selections</p>{visibleMissingHulyTargets.map((target, index) => <label key={`${target.workspace}:${target.project}:${index}`} className="flex cursor-pointer items-start gap-2.5 rounded-md px-2 py-2 hover:bg-accent"><input className="mt-0.5 size-4 accent-primary" type="checkbox" checked onChange={() => setHulyTargets((current) => current.filter((entry) => entry !== target))} /><span className="min-w-0 flex-1"><span className="block truncate text-xs font-medium">{target.project}</span><span className="mt-0.5 block truncate font-mono text-[10px] text-muted-foreground">{target.workspace} · {discoveryAttempted ? "not returned by discovery" : "saved selection"}</span></span></label>)}</section>}
            {discoveryAttempted && !discoveryLoading && !discoveryError && discoveredTargets.length === 0 && selectedTargetCount === 0 && <p className="px-2 py-5 text-center text-[11px] text-muted-foreground">No available targets were returned.</p>}
            {discoveryAttempted && !discoveryLoading && !discoveryError && discoveredTargets.length > 0 && visibleDiscoveredTargets.length === 0 && visibleMissingGitlabTargets.length === 0 && visibleMissingHulyTargets.length === 0 && <p className="px-2 py-5 text-center text-[11px] text-muted-foreground">No targets match your search.</p>}
          </div>
          <p className="text-[10px] text-muted-foreground">{selectedTargetCount} {selectedTargetCount === 1 ? "target" : "targets"} selected</p>
        </div>
        <details className="rounded-lg border border-border bg-background/25 p-3">
          <summary className="cursor-pointer text-xs font-medium">Advanced manual entry</summary>
          <p className="mt-2 text-[10px] leading-4 text-muted-foreground">Add a target manually when it is not returned by discovery.</p>
          {installing === "gitlab" ? <div className="mt-3 grid gap-2">
            {gitlabTargets.map((target, index) => <div key={index} className="grid items-end gap-2 sm:grid-cols-[120px_minmax(0,1fr)_auto]">
              <label className="grid gap-1.5"><span className="text-[10px] text-muted-foreground">Type</span><select className="settings-select" value={target.kind} onChange={(event) => setGitlabTargets((current) => current.map((entry, targetIndex) => targetIndex === index ? { ...entry, kind: event.target.value as GitlabTarget["kind"], legacyExternalIds: false } : entry))}><option value="project">Project / repo</option><option value="group">Group</option></select></label>
              <label className="grid gap-1.5"><span className="text-[10px] text-muted-foreground">Path or ID</span><Input value={target.identifier} onChange={(event) => setGitlabTargets((current) => current.map((entry, targetIndex) => targetIndex === index ? { ...entry, identifier: event.target.value, legacyExternalIds: false } : entry))} placeholder={target.kind === "group" ? "group/subgroup" : "group/project"} /></label>
              <Button type="button" variant="ghost" size="icon-sm" title="Remove target" onClick={() => setGitlabTargets((current) => current.filter((_, targetIndex) => targetIndex !== index))}><Trash2 /></Button>
            </div>)}
            <Button className="justify-self-start" type="button" variant="secondary" size="sm" onClick={() => setGitlabTargets((current) => [...current, { kind: "project", identifier: "" }])}><Plus />Add GitLab target</Button>
          </div> : <div className="mt-3 grid gap-2">
            {hulyTargets.map((target, index) => <div key={index} className="grid items-end gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]">
              <label className="grid gap-1.5"><span className="text-[10px] text-muted-foreground">Workspace</span><Input value={target.workspace} onChange={(event) => setHulyTargets((current) => current.map((entry, targetIndex) => targetIndex === index ? { ...entry, workspace: event.target.value, legacyExternalIds: false } : entry))} placeholder="acme" /></label>
              <label className="grid gap-1.5"><span className="text-[10px] text-muted-foreground">Project identifier</span><Input value={target.project} onChange={(event) => setHulyTargets((current) => current.map((entry, targetIndex) => targetIndex === index ? { ...entry, project: event.target.value, legacyExternalIds: false } : entry))} placeholder="BOOST" /></label>
              <Button type="button" variant="ghost" size="icon-sm" title="Remove target" onClick={() => setHulyTargets((current) => current.filter((_, targetIndex) => targetIndex !== index))}><Trash2 /></Button>
            </div>)}
            <Button className="justify-self-start" type="button" variant="secondary" size="sm" onClick={() => setHulyTargets((current) => [...current, { workspace: "", project: "" }])}><Plus />Add Huly project</Button>
          </div>}
        </details>
        {hasPartialHulyTarget && <p className="text-xs text-destructive">Complete or remove each manual Huly workspace/project row before saving.</p>}
        <label className="grid gap-1.5"><span className="settings-label">Automatic import</span><select className="settings-select" value={schedule} onChange={(event) => setSchedule(event.target.value)}>{scheduleOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
        {save.error && <p className="text-xs text-destructive">{save.error.message}</p>}
        <div className="flex justify-end gap-2"><Button type="button" variant="ghost" onClick={closeEditor}>Cancel</Button><Button disabled={save.isPending || !name.trim() || !targetsValid}>{save.isPending && <LoaderCircle className="animate-spin" />}{editingId ? "Save integration" : "Install plugin"}</Button></div>
      </form>
    </SettingsSection>}
    {sync.data && <p className="text-xs text-success">{sync.data.message}</p>}{sync.error && <p className="text-xs text-destructive">{sync.error.message}</p>}
  </div>;
}

function collectObjects(value: unknown): Record<string, any>[] {
  if (Array.isArray(value)) return value.filter((entry): entry is Record<string, any> => Boolean(entry) && typeof entry === "object");
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  for (const key of ["data", "servers", "items", "mcpServers"]) { const found = collectObjects(record[key]); if (found.length) return found; }
  return [];
}

function formatDayCount(value?: number | null) {
  if (value === undefined || value === null) return "Unavailable";
  return `${formatExactNumber(value)} ${value === 1 ? "day" : "days"}`;
}

function formatUnixTimestamp(value?: number | null) {
  if (value === undefined || value === null) return "Not provided";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "medium" }).format(new Date(value * 1_000));
}

function QuotaWindow({ name, window }: { name: string; window: CodexRateLimitWindow }) {
  const percentage = window.usedPercent;
  const width = percentage === undefined || percentage === null ? 0 : Math.min(100, Math.max(0, percentage));
  return <div className="rounded-md border border-border/70 bg-background/40 p-3">
    <div className="flex items-center justify-between gap-3"><span className="text-[11px] font-medium">{window.windowDurationMins === undefined || window.windowDurationMins === null ? name : formatWindowDuration(window.windowDurationMins)}</span><strong className="text-xs">{percentage === undefined || percentage === null ? "Usage unavailable" : `${formatPercent(percentage)} used`}</strong></div>
    <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-secondary"><div className="h-full rounded-full bg-primary transition-[width]" style={{ width: `${width}%` }} /></div>
    <p className="mt-2 text-[10px] text-muted-foreground">{window.resetsAt === undefined || window.resetsAt === null ? "Reset time unavailable" : `Resets ${formatUnixTimestamp(window.resetsAt)}`}</p>
  </div>;
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
  const usage = settings.data?.usage;
  const summary = usage?.summary;
  const dailyUsage = usage?.dailyUsageBuckets;
  const limits = rateLimitBuckets(settings.data?.rateLimits);
  const resetCredits = settings.data?.rateLimits?.rateLimitResetCredits;
  return <div className="settings-content"><SettingsSection title="Status" description="Connection and account status reported by the Codex app-server."><div className="settings-metric"><Activity /><span><span className="settings-label">CLI status</span><strong className={codex?.authenticated ? "text-success" : "text-warning"}>{codex?.authenticated ? "Ready" : codex?.available ? "Login required" : "Unavailable"}</strong><small>{codex?.version ?? "Not detected"}</small></span></div>{settings.error && <p className="mt-2 text-xs text-destructive">{settings.error.message}</p>}{!codex?.authenticated && codex?.available && user?.role === "admin" && !login.data && <Button className="mt-3" onClick={() => login.mutate()} disabled={login.isPending}>{login.isPending && <LoaderCircle className="animate-spin" />}Connect with ChatGPT</Button>}{login.data && !codex?.authenticated && <div className="mt-3 rounded-lg border border-primary/25 bg-primary/5 p-3"><p className="text-xs">Open <a className="text-primary hover:underline" href={login.data.verificationUrl} target="_blank" rel="noreferrer">the verification page <ExternalLink className="inline size-3" /></a>, then enter:</p><button className="mt-2 flex items-center gap-2 rounded-md border border-border bg-background px-3 py-2 font-mono tracking-[0.2em]" onClick={() => { void navigator.clipboard.writeText(login.data!.userCode); setCopied(true); }}>{login.data.userCode}<Copy className="size-3.5" /></button>{copied && <p className="mt-1 text-[10px] text-success">Copied</p>}</div>}</SettingsSection>
    <SettingsSection title="Usage" description="Exact ChatGPT token activity and rolling quota windows reported for this Codex account.">
      {summary ? <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        <div className="settings-metric"><CircleGauge /><span><span className="settings-label">Lifetime tokens</span><strong>{formatExactNumber(summary.lifetimeTokens)}</strong><small>All reported activity</small></span></div>
        <div className="settings-metric"><Activity /><span><span className="settings-label">Peak daily tokens</span><strong>{formatExactNumber(summary.peakDailyTokens)}</strong><small>Highest reported day</small></span></div>
        <div className="settings-metric"><Clock /><span><span className="settings-label">Longest turn</span><strong>{formatDuration(summary.longestRunningTurnSec)}</strong><small>Continuous running time</small></span></div>
        <div className="settings-metric"><Flame /><span><span className="settings-label">Current streak</span><strong>{formatDayCount(summary.currentStreakDays)}</strong><small>Consecutive active days</small></span></div>
        <div className="settings-metric"><Shield /><span><span className="settings-label">Longest streak</span><strong>{formatDayCount(summary.longestStreakDays)}</strong><small>Personal best</small></span></div>
      </div> : <p className="text-[11px] text-muted-foreground">Token activity is unavailable for this account.</p>}
      {dailyUsage && dailyUsage.length > 0 && <div className="settings-card mt-3">
        <div className="mb-2 flex items-center justify-between gap-3"><p className="text-xs font-medium">Daily token activity</p><span className="text-[10px] text-muted-foreground">{dailyUsage.length} {dailyUsage.length === 1 ? "day" : "days"}</span></div>
        <div className="max-h-48 divide-y divide-border overflow-y-auto">{dailyUsage.map((bucket) => <div key={bucket.startDate} className="flex items-center justify-between gap-4 py-2 text-[11px]"><time className="font-mono text-muted-foreground" dateTime={bucket.startDate}>{bucket.startDate}</time><strong>{formatExactNumber(bucket.tokens)} tokens</strong></div>)}</div>
      </div>}
      <div className="mb-2 mt-5"><p className="text-xs font-medium">Quota windows</p><p className="mt-1 text-[10px] text-muted-foreground">Usage percentages and exact local reset times.</p></div>
      {limits.length > 0 ? <div className="grid gap-2">{limits.map((limit) => <div key={limit.limitId} className="settings-card">
        <div className="mb-3 flex items-start justify-between gap-3"><div><p className="text-xs font-medium">{rateLimitLabel(limit)}</p><p className="mt-0.5 font-mono text-[9px] text-muted-foreground">{limit.limitId}</p></div><div className="text-right">{limit.planType && <span className="rounded-full bg-secondary px-2 py-1 text-[9px] uppercase tracking-wide text-muted-foreground">{limit.planType}</span>}{limit.rateLimitReachedType && <p className="mt-1 text-[10px] text-destructive">{limit.rateLimitReachedType}</p>}</div></div>
        <div className="grid gap-2 sm:grid-cols-2">{limit.primary && <QuotaWindow name="Primary window" window={limit.primary} />}{limit.secondary && <QuotaWindow name="Secondary window" window={limit.secondary} />}</div>
      </div>)}</div> : <p className="text-[11px] text-muted-foreground">Quota-window usage is unavailable for this account.</p>}
    </SettingsSection>
    <SettingsSection title="Banked resets" description="Earned rate-limit resets currently available on this Codex account.">
      <div className="settings-card flex items-center gap-3"><RefreshCw className="size-5 text-primary" /><div><p className="text-xl font-semibold">{resetCredits ? formatExactNumber(resetCredits.availableCount) : "Unavailable"}</p><p className="text-[11px] text-muted-foreground">{resetCredits ? `${resetCredits.availableCount === 1 ? "reset" : "resets"} available · the total is authoritative` : "The service did not return a banked-reset count."}</p></div></div>
      {resetCredits?.credits && resetCredits.credits.length > 0 && <div className="mt-2 grid gap-2">{resetCredits.credits.map((credit) => <div key={credit.id} className="settings-card">
        <div className="flex items-start justify-between gap-3"><div><p className="text-xs font-medium">{credit.title ?? "Rate-limit reset"}</p>{credit.description && <p className="mt-1 text-[11px] leading-4 text-muted-foreground">{credit.description}</p>}</div><span className="rounded-full bg-success/10 px-2 py-1 text-[9px] uppercase tracking-wide text-success">{credit.status}</span></div>
        <dl className="mt-3 grid gap-2 text-[10px] sm:grid-cols-3"><div><dt className="settings-label">Type</dt><dd className="mt-1">{credit.resetType}</dd></div><div><dt className="settings-label">Granted</dt><dd className="mt-1">{formatUnixTimestamp(credit.grantedAt)}</dd></div><div><dt className="settings-label">Expires</dt><dd className="mt-1">{credit.expiresAt ? formatUnixTimestamp(credit.expiresAt) : "Does not expire"}</dd></div></dl>
      </div>)}</div>}
      {resetCredits && resetCredits.availableCount === 0 && <p className="mt-2 text-[11px] text-muted-foreground">No earned resets are currently banked.</p>}
      {resetCredits && resetCredits.availableCount > 0 && (!resetCredits.credits || resetCredits.credits.length === 0) && <p className="mt-2 text-[11px] text-muted-foreground">The account reported the count but did not provide individual reset details.</p>}
      {resetCredits?.credits && resetCredits.availableCount > resetCredits.credits.length && <p className="mt-2 text-[11px] text-muted-foreground">Showing {resetCredits.credits.length} of {resetCredits.availableCount} reset details returned by the service.</p>}
    </SettingsSection>
    <SettingsSection title="Workspace instructions" description="These instructions are added to every planning and execution run created from this workspace."><Textarea className="min-h-36 font-mono text-xs leading-5" value={instructions} onChange={(event) => setInstructions(event.target.value)} placeholder="Repository conventions, required checks, architecture boundaries…" /><div className="mt-2 flex items-center justify-between"><span className="text-[10px] text-muted-foreground">Stored in Boosted and applied at run time.</span><Button size="sm" onClick={() => save.mutate()} disabled={save.isPending}>{save.isPending ? <LoaderCircle className="animate-spin" /> : <Save />}Save instructions</Button></div>{save.error && <p className="mt-2 text-xs text-destructive">{save.error.message}</p>}</SettingsSection>
    <SettingsSection title="MCP servers" description="Inspect active Codex MCPs and add workspace-local servers to .codex/config.toml."><div className="grid gap-1.5">{mcps.map((mcp, index) => <div key={String(mcp.name ?? mcp.id ?? index)} className="settings-card flex items-center gap-3 py-2.5"><Plug className="size-4 text-muted-foreground" /><div className="min-w-0 flex-1"><p className="truncate text-xs font-medium">{String(mcp.name ?? mcp.id ?? "MCP server")}</p><p className="mt-0.5 truncate text-[10px] text-muted-foreground">{String(mcp.status ?? mcp.authStatus ?? "Configured")}</p></div>{mcp.tools && <span className="text-[10px] text-muted-foreground">{Array.isArray(mcp.tools) ? mcp.tools.length : ""} tools</span>}</div>)}{mcps.length === 0 && <p className="text-[11px] text-muted-foreground">No MCP servers reported for this workspace.</p>}</div><form className="mt-3 grid gap-2 rounded-lg border border-border bg-background/25 p-3" onSubmit={(event) => { event.preventDefault(); addMcp.mutate(); }}><p className="text-xs font-medium">Add MCP server</p><div className="grid gap-2 sm:grid-cols-[1fr_120px]"><Input placeholder="Server name" value={mcpName} onChange={(event) => setMcpName(event.target.value)} required /><select className="settings-select" value={mcpType} onChange={(event) => setMcpType(event.target.value as "url" | "command")}><option value="url">HTTP URL</option><option value="command">Command</option></select></div><Input placeholder={mcpType === "url" ? "https://mcp.example.com" : "npx"} value={mcpValue} onChange={(event) => setMcpValue(event.target.value)} required />{mcpType === "command" && <Input placeholder="Arguments, separated by spaces" value={mcpArgs} onChange={(event) => setMcpArgs(event.target.value)} />}<div className="flex justify-end"><Button size="sm" disabled={addMcp.isPending || !mcpName || !mcpValue}>{addMcp.isPending ? <LoaderCircle className="animate-spin" /> : <Plus />}Add server</Button></div>{addMcp.error && <p className="text-xs text-destructive">{addMcp.error.message}</p>}</form></SettingsSection></div>;
}

function TeamSettings() {
  const user = useAppStore((state) => state.user);
  const queryClient = useQueryClient();
  const [username, setUsername] = useState(""); const [password, setPassword] = useState("");
  const users = useQuery({ queryKey: ["users"], queryFn: api.users, enabled: user?.role === "admin" });
  const create = useMutation({ mutationFn: () => api.createUser(username, password), onSuccess: () => { setUsername(""); setPassword(""); void queryClient.invalidateQueries({ queryKey: ["users"] }); } });
  return <div className="settings-content"><SettingsSection title="Global access" description="Boosted members have access to every registered workspace and task on this instance."><div className="grid gap-1">{users.data?.map((entry) => <div key={entry.id} className="settings-card flex items-center gap-3 py-2.5"><div className="grid size-8 place-items-center rounded-full bg-secondary text-xs font-semibold uppercase">{entry.username.slice(0, 1)}</div><div className="min-w-0 flex-1"><p className="text-xs font-medium">{entry.username}</p><p className="text-[10px] capitalize text-muted-foreground">{entry.role}{entry.mustChangePassword ? " · password change required" : ""}</p></div>{entry.disabled && <span className="text-[10px] text-destructive">Disabled</span>}</div>)}</div></SettingsSection>{user?.role === "admin" && <SettingsSection title="Invite member" description="Create an account with a temporary password. The member must replace it on first login."><form className="settings-card grid gap-2" onSubmit={(event: FormEvent) => { event.preventDefault(); create.mutate(); }}><div className="grid gap-2 sm:grid-cols-2"><Input placeholder="Username" minLength={3} value={username} onChange={(event) => setUsername(event.target.value)} required /><Input type="password" placeholder="Temporary password" value={password} onChange={(event) => setPassword(event.target.value)} required /></div><div className="flex justify-end"><Button size="sm" disabled={create.isPending || username.length < 3 || !password}>{create.isPending ? <LoaderCircle className="animate-spin" /> : <UserPlus />}Create member</Button></div>{create.error && <p className="text-xs text-destructive">{create.error.message}</p>}</form></SettingsSection>}</div>;
}

export function SettingsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [section, setSection] = useState<Section>("connections");
  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent className="settings-dialog max-w-5xl gap-0 overflow-hidden p-0"><div className="settings-layout"><aside className="settings-sidebar"><DialogHeader className="px-3 pb-4 pt-2"><DialogTitle>Settings</DialogTitle></DialogHeader><nav className="settings-nav">{sectionGroups.map((group) => <div key={group.label} className="settings-nav-group"><p className="settings-nav-heading">{group.label}</p>{group.sections.map(({ id, label, icon: Icon }) => <button key={id} className={cn("settings-nav-item", section === id && "settings-nav-item-active")} onClick={() => setSection(id)}><Icon />{label}</button>)}</div>)}</nav></aside><main className="settings-main min-h-0 overflow-y-auto">{section === "connections" && <ConnectionsSettings />}{section === "notifications" && <NotificationSettings />}{section === "web" && <GlobalWebSettings />}{section === "application" && <ApplicationSettings />}{section === "team" && <TeamSettings />}{section === "workspace" && <WorkspaceSettings />}{section === "integrations" && <IntegrationsSettings />}{section === "codex" && <CodexSettings />}</main></div></DialogContent></Dialog>;
}
