import { ProvidersSettings } from "@/features/agents/providers-settings";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Bell, Bot, Code2, Copy, ExternalLink, GitBranch, Globe2, LoaderCircle, Menu, Pencil, Plug, Plus, RefreshCw, Search, Server, Settings2, Shield, Trash2, UserPlus, Users, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api";
import { formatDuration, formatExactNumber, formatPercent, formatWindowDuration, rateLimitBuckets, rateLimitLabel } from "@/lib/codex-usage";
import { defaultNotificationSettings, notificationEventDefinitions, notificationPermission, readNotificationSettings, requestNotificationPermission, showTestNotification, writeNotificationSettings, type PwaNotificationSettings } from "@/lib/notifications";
import { useMachineStore } from "@/lib/machines";
import { useAppStore } from "@/lib/store";
import type { CodexRateLimitWindow, Integration, IntegrationDiscoveryTarget } from "@/lib/types";
import { checkAndInstallAppUpdate, formatUpdateProgress, refreshAppUpdateAvailability, useAppUpdateState } from "@/lib/updater";
import { cn, relativeTime } from "@/lib/utils";
import { ConnectionsManager } from "@/components/machine-manager";
import { SettingsGroup, SettingsRow, SettingsSection, SettingsSelect } from "@/components/settings-primitives";
import "./settings.css";

const Gitlab = GitBranch;

export type SettingsSectionId = "providers" | "connections" | "notifications" | "web" | "application" | "team" | "workspace" | "integrations" | "codex";
type Section = SettingsSectionId;

const sectionGroups: { label: string; sections: { id: Section; label: string; icon: typeof Settings2 }[] }[] = [
  { label: "This device", sections: [
    { id: "connections", label: "Connections", icon: Server },
    { id: "notifications", label: "Notifications", icon: Bell },
  ] },
  { label: "This machine", sections: [
    { id: "providers", label: "Providers", icon: Plug },
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
  return <div className="settings-content"><SettingsSection title="Saved machines" description="Connect to a Boosted server and switch between your machines."><ConnectionsManager embedded /></SettingsSection><SettingsSection title="Connection scope"><SettingsGroup><SettingsRow label="Independent workspaces" description="Each machine has its own accounts, projects, tasks, and settings."><Server className="size-4 text-muted-foreground" /></SettingsRow></SettingsGroup></SettingsSection></div>;
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
    <SettingsSection title="Browser access" description="Control how the selected machine serves Boosted in a browser.">
      <SettingsGroup>
        <SettingsRow label="Listening port" description="The port used for incoming browser and API connections."><Input className="settings-port-input" type="number" min={1} max={65535} value={port} disabled={!isAdmin || settings.isLoading} onChange={(event) => setPort(event.target.value)} /></SettingsRow>
        <SettingsRow label="Serve the web UI" description="Make the browser application available alongside the API."><Switch checked={webUiEnabled} disabled={!isAdmin || settings.isLoading} onCheckedChange={setWebUiEnabled} /></SettingsRow>
      </SettingsGroup>
    </SettingsSection>
    <SettingsSection title="Remote access">
      <SettingsGroup><SettingsRow stacked label="Allowed remote IPs" description="Leave empty to accept any remote address. Enter one IPv4 or IPv6 address per line; localhost is always allowed."><Textarea className="min-h-28 font-mono" value={allowedIps} disabled={!isAdmin || settings.isLoading} onChange={(event) => setAllowedIps(event.target.value)} placeholder={"192.0.2.10\n2001:db8::10"} /></SettingsRow><SettingsRow label="Sign-in required" description="Every user must authenticate, including connections allowed by this list."><Shield className="size-4 text-muted-foreground" /></SettingsRow></SettingsGroup>
    </SettingsSection>
    {!isAdmin && <p className="settings-note">Only an administrator can change global web settings.</p>}
    {settings.error && <p role="alert" className="settings-error">{settings.error.message}</p>}
    {save.error && <p role="alert" className="settings-error">{save.error.message}</p>}
    {save.isSuccess && <p role="status" className="settings-note text-success">Settings saved. Restart Boosted to apply them.</p>}
    <div className="settings-save-bar"><p>Changes take effect after a restart. CLI options override saved settings.</p><Button size="sm" disabled={!isAdmin || settings.isLoading || !validPort || save.isPending} onClick={() => save.mutate()}>{save.isPending && <LoaderCircle className="animate-spin" />}Save changes</Button></div>
  </div>;
}

function WorkspaceSettings() {
  const projectId = useAppStore((state) => state.selectedProjectId);
  const projects = useQuery({ queryKey: ["projects"], queryFn: api.projects });
  const project = projects.data?.find((entry) => entry.id === projectId);
  return <div className="settings-content">
    <SettingsSection title="Workspace details" description="The repository currently open in Boosted.">
      {project ? <SettingsGroup><SettingsRow label="Name"><span>{project.name}</span></SettingsRow><SettingsRow label="Repository" description="Working directory for this workspace."><code className="settings-path" title={project.repoPath}>{project.repoPath}</code></SettingsRow><SettingsRow label="Default branch"><code>{project.defaultBranch}</code></SettingsRow></SettingsGroup> : <p className="settings-empty">Open a workspace to view its settings.</p>}
      {projects.error && <p role="alert" className="settings-error">{projects.error.message}</p>}
    </SettingsSection>
    {project && <SettingsSection title="Task defaults"><SettingsGroup><SettingsRow label="Starting branch" description="Imported and manually created tasks start from the default branch."><code>{project.defaultBranch}</code></SettingsRow><SettingsRow label="Isolated worktrees" description="Each task gets its own boosted/* branch and execution directory."><span className="settings-value">Enabled</span></SettingsRow></SettingsGroup></SettingsSection>}
  </div>;
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
  const groups = ["Agents", "Tasks", "Codex", "Integrations"] as const;
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
    <SettingsSection title="Notifications" description="Preferences apply to this browser and the selected Boosted machine.">
      <SettingsGroup><SettingsRow label="Enable notifications" description={status}><Switch checked={effectiveEnabled} disabled={!machineId || requesting || permission === "unsupported" || permission === "denied"} onCheckedChange={(checked) => void toggleEnabled(checked)} /></SettingsRow><SettingsRow label="Delivery" description="Choose when this window should notify you."><SettingsSelect value={settings.delivery} disabled={!machineId} onValueChange={(value) => update({ ...settings, delivery: value as PwaNotificationSettings["delivery"] })} options={[{ value: "background", label: "Only in the background" }, { value: "always", label: "Always" }]} /></SettingsRow></SettingsGroup>
      {message && <p role={message.kind === "error" ? "alert" : "status"} className={cn("settings-note", message.kind === "success" ? "text-success" : "text-destructive")}>{message.text}</p>}
    </SettingsSection>
    {groups.map((group) => <SettingsSection key={group} title={group}><SettingsGroup>{notificationEventDefinitions.filter((event) => event.group === group).map((event) => <SettingsRow key={event.id} label={event.label} description={event.description}><Switch checked={settings.events.includes(event.id)} disabled={!machineId} onCheckedChange={(enabled) => toggleEvent(event.id, enabled)} /></SettingsRow>)}</SettingsGroup></SettingsSection>)}
    <div className="settings-save-bar"><p>Changes are saved automatically.</p><Button variant="secondary" size="sm" disabled={!effectiveEnabled} onClick={() => void testNotification()}><Bell />Send test notification</Button></div>
  </div>;
}

export function ApplicationSettings() {
  const update = useAppUpdateState();
  const user = useAppStore((state) => state.user);
  const machineId = useMachineStore((state) => state.activeId);
  const isAdmin = user?.role === "admin";
  useEffect(() => { void refreshAppUpdateAvailability(); }, [machineId]);
  const progress = formatUpdateProgress(update);
  const busy = ["checking", "downloading", "installing", "restarting"].includes(update.phase);
  const status = update.phase === "unsupported"
    ? update.supportReason ?? "This installation requires a manual update."
    : update.phase === "checking"
      ? "Checking for updates…"
      : update.phase === "up-to-date"
        ? "Boosted is up to date."
        : update.phase === "downloading"
          ? `Updating Boosted${progress === undefined ? "…" : ` — ${progress}%`}`
          : update.phase === "installing"
            ? "Installing update…"
            : update.phase === "restarting"
              ? "Restarting Boosted…"
              : update.phase === "error"
                ? "Update failed. Try again."
                : "Update the app and backend together.";

  return <div className="settings-content">
    <SettingsSection title="Software updates" description="One update for the selected machine: the app, backend, and web UI. Boosted restarts and refreshes this window when ready.">
      <SettingsGroup>
        <SettingsRow label="Installed version" description={update.lastCheckedAt ? `Last checked ${relativeTime(update.lastCheckedAt)} ago` : "Updates are checked on this machine."}><code>{update.currentVersion ?? "Reading version…"}</code></SettingsRow>
        <SettingsRow label="Update Boosted" description="Update the app, backend, and browser UI together."><Button size="sm" disabled={!isAdmin || busy || (!update.supported && update.phase !== "error")} onClick={() => void checkAndInstallAppUpdate()}>{busy ? <LoaderCircle className="animate-spin" /> : <RefreshCw />}{busy ? "Updating…" : "Update Boosted"}</Button></SettingsRow>
      </SettingsGroup>
      <div role="status" aria-live="polite" className="settings-note">{status}</div>
      {progress !== undefined && <progress className="settings-progress" aria-label="Update download progress" value={progress} max={100} />}
      {update.error && <p role="alert" className="settings-error">{update.error}</p>}
      <p className="settings-note">{isAdmin ? "Your projects and settings are kept." : "Only an administrator can update Boosted."}</p>
    </SettingsSection>
  </div>;
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
    <Checkbox className="mt-0.5" checked={selected} onChange={(event) => onToggle(event.target.checked)} />
    <span className="min-w-0 flex-1"><span className="block truncate text-xs font-medium">{label}</span>{detail && <span className="mt-0.5 block truncate font-mono text-[10px] text-muted-foreground">{detail}</span>}</span>
  </label>;
}

export function IntegrationsSettings() {
  const projectId = useAppStore((state) => state.selectedProjectId);
  const queryClient = useQueryClient();
  const [installing, setInstalling] = useState<Integration["provider"]>();
  const [editingId, setEditingId] = useState<string>();
  const [listFilter, setListFilter] = useState<"all" | "installed" | "available">("all");
  const [listSearch, setListSearch] = useState("");
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
  const hulyUsername = configString(config, "username").trim();
  const hulyPassword = configString(config, "password");
  const connectionKey = installing === "gitlab"
    ? `${installing}\0${baseUrl}\0${accessToken}`
    : installing === "huly"
      ? `${installing}\0${endpoint}\0${hulyUsername}\0${hulyPassword}`
      : "";
  const discoveryReady = Boolean(projectId && installing && (installing === "gitlab"
    ? baseUrl && accessToken
    : endpoint && hulyUsername && hulyPassword.trim()));

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
        : { endpoint, username: hulyUsername, password: hulyPassword };
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
  }, [accessToken, baseUrl, connectionKey, discoveryReady, discoveryRefresh, endpoint, hulyPassword, hulyUsername, installing, projectId]);

  const save = useMutation({
    mutationFn: () => {
      if (!installing) throw new Error("Choose an integration provider");
      const {
        targets: _targets,
        project: _project,
        workspace: _workspace,
        token: _token,
        username: _username,
        password: _password,
        ...sharedConfig
      } = config;
      const validGitlabTargets = gitlabTargets.filter((target) => target.identifier.trim());
      const validHulyTargets = hulyTargets.filter((target) => target.workspace.trim() && target.project.trim());
      const nextConfig = installing === "gitlab"
        ? { ...sharedConfig, baseUrl, token: accessToken, targets: validGitlabTargets.map((target) => ({ kind: target.kind, identifier: target.identifier.trim(), legacyExternalIds: Boolean(target.legacyExternalIds) })) }
        : { ...sharedConfig, endpoint, username: hulyUsername, password: hulyPassword, targets: validHulyTargets.map((target) => ({ workspace: target.workspace.trim(), project: target.project.trim(), legacyExternalIds: Boolean(target.legacyExternalIds) })) };
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
    setConfig(provider === "gitlab"
      ? { baseUrl: "https://gitlab.com", token: "" }
      : { endpoint: "", username: "", password: "" });
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
  const searchQuery = listSearch.trim().toLocaleLowerCase();
  const visibleIntegrations = integrations.data?.filter((entry) => `${entry.name} ${entry.provider}`.toLocaleLowerCase().includes(searchQuery));
  const pluginVisible = (provider: string) => provider.toLocaleLowerCase().includes(searchQuery);

  return <div className="settings-content">
    <div className="settings-list-toolbar"><div className="settings-filters" aria-label="Filter integrations">{(["all", "installed", "available"] as const).map((filter) => <Button variant="ghost" key={filter} type="button" aria-pressed={listFilter === filter} onClick={() => setListFilter(filter)}>{filter === "all" ? "All" : filter === "installed" ? "Installed" : "Available"}{filter === "installed" && <span>{integrations.data?.length ?? 0}</span>}</Button>)}</div><label className="settings-list-search"><Search /><Input aria-label="Search integrations" placeholder="Search integrations" value={listSearch} onChange={(event) => setListSearch(event.target.value)} /></label></div>
    {!projectId && <p className="settings-empty">Open a workspace to install integrations.</p>}
    {listFilter !== "available" && <SettingsSection title="Installed integrations" description="Import issues from external projects, repositories, or groups.">
      <div className="grid gap-2">
        {integrations.isLoading && <p className="text-xs text-muted-foreground">Loading integrations…</p>}
        {visibleIntegrations?.map((entry) => {
          const Icon = providerIcon(entry.provider);
          const targetCount = integrationTargetCount(entry);
          return <div key={entry.id} className="settings-integration-row settings-integration-installed">
            <div className="grid size-9 shrink-0 place-items-center rounded-lg bg-secondary"><Icon className="size-4" /></div>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2"><p className="text-xs font-medium">{entry.name}</p><span className={cn("rounded-full px-1.5 py-0.5 text-[9px] capitalize", entry.enabled ? "bg-success/10 text-success" : "bg-secondary text-muted-foreground")}>{entry.enabled ? "Active" : "Paused"}</span>{entry.lastSyncStatus && <span className="text-[10px] capitalize text-muted-foreground">{entry.lastSyncStatus}</span>}</div>
              <p className="mt-1 text-[11px] capitalize text-muted-foreground">{entry.provider} · {targetCount} {targetCount === 1 ? "source" : "sources"} · {entry.syncIntervalMinutes ? scheduleOptions.find((option) => Number(option.value) === entry.syncIntervalMinutes)?.label : "Manual sync"}{entry.lastSyncedAt ? ` · synced ${relativeTime(entry.lastSyncedAt)}` : " · never synced"}</p>
              {entry.lastSyncError && <p className="mt-1 text-[11px] text-destructive">{entry.lastSyncError}</p>}
              {toggle.error && toggle.variables?.id === entry.id && <p role="alert" className="settings-error">{toggle.error.message}</p>}
              {remove.error && remove.variables === entry.id && <p role="alert" className="settings-error">{remove.error.message}</p>}
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <Button variant="ghost" size="icon-sm" title="Edit integration" disabled={save.isPending} onClick={() => edit(entry)}><Pencil /></Button>
              <Switch aria-label={`Enable ${entry.name}`} checked={entry.enabled} disabled={toggle.isPending || save.isPending} onCheckedChange={() => toggle.mutate(entry)} />
              <Button variant="secondary" size="sm" disabled={sync.isPending} onClick={() => sync.mutate(entry.id)}>{sync.isPending && sync.variables === entry.id ? <LoaderCircle className="animate-spin" /> : <RefreshCw />}Sync now</Button>
              <Button variant="ghost" size="icon-sm" title="Remove integration" disabled={remove.isPending} onClick={() => remove.mutate(entry.id)}><Trash2 /></Button>
            </div>
          </div>;
        })}
        {integrations.data?.length === 0 && <div className="settings-empty"><p>No integrations installed</p><p>Choose a provider below to import external work.</p></div>}
        {Boolean(integrations.data?.length) && !visibleIntegrations?.length && <div className="settings-empty"><p>No integrations match your search.</p><Button variant="ghost" size="sm" onClick={() => setListSearch("")}>Clear search</Button></div>}
        {integrations.error && <p role="alert" className="settings-error">{integrations.error.message}</p>}
      </div>
    </SettingsSection>}
    {listFilter !== "installed" && <SettingsSection title="Available integrations" description="Choose a provider to add to this workspace.">
      <div className="settings-plugin-list">
        {pluginVisible("gitlab") && <Button variant="ghost" type="button" className="integration-plugin-card" disabled={save.isPending || !projectId} onClick={() => begin("gitlab")}><span className="grid size-10 place-items-center rounded-lg bg-[#FC6D26]/10 text-[#FC6D26]"><Gitlab className="size-5" /></span><span className="min-w-0 flex-1"><span className="block text-xs font-medium">GitLab</span><span className="mt-1 block text-[11px] leading-4 text-muted-foreground">Import open issues from GitLab projects and groups.</span></span><Plus className="size-4 text-muted-foreground" /></Button>}
        {pluginVisible("huly") && <Button variant="ghost" type="button" className="integration-plugin-card" disabled={save.isPending || !projectId} onClick={() => begin("huly")}><span className="grid size-10 place-items-center rounded-lg bg-primary/10 text-primary"><Code2 className="size-5" /></span><span className="min-w-0 flex-1"><span className="block text-xs font-medium">Huly</span><span className="mt-1 block text-[11px] leading-4 text-muted-foreground">Import issues from Huly workspace projects.</span></span><Plus className="size-4 text-muted-foreground" /></Button>}
        {!pluginVisible("gitlab") && !pluginVisible("huly") && <div className="settings-empty"><p>No available integrations match your search.</p><Button variant="ghost" size="sm" onClick={() => setListSearch("")}>Clear search</Button></div>}
      </div>
    </SettingsSection>}
    {installing && <SettingsSection title={`${editingId ? "Edit" : "Install"} ${installing === "gitlab" ? "GitLab" : "Huly"}`} description={installing === "gitlab" ? "Add every project, repository, or group whose open issues should feed this workspace." : "Add every Huly workspace/project pair that should feed this workspace through the connector."}>
      <form className="settings-card grid gap-4" onSubmit={(event) => { event.preventDefault(); if (!save.isPending && name.trim() && targetsValid) save.mutate(); }}>
        <label className="grid gap-1.5"><span className="settings-label">Connection name</span><Input value={name} onChange={(event) => setName(event.target.value)} required /></label>
        {installing === "gitlab"
          ? <label className="grid gap-1.5"><span className="settings-label">GitLab URL</span><Input value={configString(config, "baseUrl", "https://gitlab.com")} onChange={(event) => setConfig((current) => ({ ...current, baseUrl: event.target.value }))} placeholder="https://gitlab.com" required /></label>
          : <label className="grid gap-1.5"><span className="settings-label">Connector endpoint</span><Input value={configString(config, "endpoint")} onChange={(event) => setConfig((current) => ({ ...current, endpoint: event.target.value }))} placeholder="https://connector.example.com/huly/issues" required /></label>}
        {installing === "gitlab"
          ? <label className="grid gap-1.5"><span className="settings-label">Access token</span><Input type="password" value={configString(config, "token")} onChange={(event) => setConfig((current) => ({ ...current, token: event.target.value }))} required /></label>
          : <div className="grid gap-4 sm:grid-cols-2">
            <label className="grid gap-1.5"><span className="settings-label">Username</span><Input value={configString(config, "username")} onChange={(event) => setConfig((current) => ({ ...current, username: event.target.value }))} autoComplete="username" required /></label>
            <label className="grid gap-1.5"><span className="settings-label">Password</span><Input type="password" value={configString(config, "password")} onChange={(event) => setConfig((current) => ({ ...current, password: event.target.value }))} autoComplete="current-password" required /></label>
          </div>}
        <div className="grid gap-2">
          <div className="flex items-start justify-between gap-3">
            <div><span className="settings-label">Explore targets</span><p className="mt-1 text-[10px] leading-4 text-muted-foreground">{installing === "gitlab" ? "Select projects or groups visible to this token. A group imports issues from its visible projects." : "Select projects from any workspace returned by the Huly connector."}</p></div>
            <Button type="button" variant="secondary" size="sm" disabled={!discoveryReady || discoveryLoading} onClick={refreshTargets}>{discoveryLoading ? <LoaderCircle className="animate-spin" /> : <RefreshCw />}Refresh</Button>
          </div>
          <Input aria-label="Search integration targets" value={discoverySearch} onChange={(event) => setDiscoverySearch(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") event.preventDefault(); }} placeholder={installing === "gitlab" ? "Search groups and projects…" : "Search workspaces and projects…"} disabled={!discoveryReady} />
          <div className="max-h-80 overflow-y-auto rounded-lg border border-border bg-background/35 p-2">
            {!discoveryReady && <p className="px-2 py-5 text-center text-[11px] text-muted-foreground">{installing === "gitlab" ? "Enter the connection URL and access token to explore available targets." : "Enter the connector endpoint, username, and password to explore available targets."}</p>}
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
            {visibleMissingGitlabTargets.length > 0 && <section className="mt-3"><p className="px-2 pb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Saved or manual selections</p>{visibleMissingGitlabTargets.map((target, index) => <label key={`${target.kind}:${target.identifier}:${index}`} className="flex cursor-pointer items-start gap-2.5 rounded-md px-2 py-2 hover:bg-accent"><Checkbox className="mt-0.5" checked onChange={() => setGitlabTargets((current) => current.filter((entry) => entry !== target))} /><span className="min-w-0 flex-1"><span className="block truncate text-xs font-medium">{target.identifier}</span><span className="mt-0.5 block text-[10px] capitalize text-muted-foreground">{target.kind} · {discoveryAttempted ? "not returned by discovery" : "saved selection"}</span></span></label>)}</section>}
            {visibleMissingHulyTargets.length > 0 && <section className="mt-3"><p className="px-2 pb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Saved or manual selections</p>{visibleMissingHulyTargets.map((target, index) => <label key={`${target.workspace}:${target.project}:${index}`} className="flex cursor-pointer items-start gap-2.5 rounded-md px-2 py-2 hover:bg-accent"><Checkbox className="mt-0.5" checked onChange={() => setHulyTargets((current) => current.filter((entry) => entry !== target))} /><span className="min-w-0 flex-1"><span className="block truncate text-xs font-medium">{target.project}</span><span className="mt-0.5 block truncate font-mono text-[10px] text-muted-foreground">{target.workspace} · {discoveryAttempted ? "not returned by discovery" : "saved selection"}</span></span></label>)}</section>}
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
              <label className="grid gap-1.5"><span className="text-[10px] text-muted-foreground">Type</span><SettingsSelect aria-label="Target type" value={target.kind} onValueChange={(value) => setGitlabTargets((current) => current.map((entry, targetIndex) => targetIndex === index ? { ...entry, kind: value as GitlabTarget["kind"], legacyExternalIds: false } : entry))} options={[{ value: "project", label: "Project / repo" }, { value: "group", label: "Group" }]} /></label>
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
        <label className="grid gap-1.5"><span className="settings-label">Automatic import</span><SettingsSelect aria-label="Automatic import" value={schedule} onValueChange={setSchedule} options={scheduleOptions} /></label>
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
  return <div className="settings-quota-window">
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
  return <div className="settings-content">
    <SettingsSection title="Shared Codex account" description="The local Codex CLI account used by workspace tasks.">
      <SettingsGroup><SettingsRow label="Connection" description={codex?.available ? codex?.version ?? "Codex CLI detected" : "Install the Codex CLI on this machine to connect."}><span className={codex?.authenticated ? "text-success" : "text-muted-foreground"}>{codex?.authenticated ? "Ready" : codex?.available ? "Login required" : "Unavailable"}</span></SettingsRow>
      {!codex?.authenticated && codex?.available && <SettingsRow label="Sign in with ChatGPT" description="Connect this machine's shared Codex account."><Button variant="secondary" size="sm" disabled={user?.role !== "admin" || login.isPending} onClick={() => login.mutate()}>{login.isPending && <LoaderCircle className="animate-spin" />}Connect</Button></SettingsRow>}</SettingsGroup>
      {settings.isLoading && <p className="settings-note">Loading workspace configuration…</p>}
      {settings.error && <p role="alert" className="settings-error">{settings.error.message}</p>}
      {login.error && <p role="alert" className="settings-error">{login.error.message}</p>}
      {login.data && !codex?.authenticated && <div className="settings-auth-code"><p>Open <a href={login.data.verificationUrl} target="_blank" rel="noreferrer">the verification page <ExternalLink className="inline size-3" /></a> and enter this code:</p><Button variant="ghost" type="button" aria-label="Copy device code" onClick={() => { void navigator.clipboard.writeText(login.data!.userCode); setCopied(true); }}><code>{login.data.userCode}</code><Copy className="size-4" /></Button>{copied && <p role="status">Copied</p>}</div>}
    </SettingsSection>
    <SettingsSection title="Usage" description="Token activity reported for the shared Codex account.">
      {summary ? <SettingsGroup><SettingsRow label="Lifetime tokens"><span>{formatExactNumber(summary.lifetimeTokens)}</span></SettingsRow><SettingsRow label="Peak daily tokens"><span>{formatExactNumber(summary.peakDailyTokens)}</span></SettingsRow><SettingsRow label="Longest turn"><span>{formatDuration(summary.longestRunningTurnSec)}</span></SettingsRow><SettingsRow label="Current streak"><span>{formatDayCount(summary.currentStreakDays)}</span></SettingsRow><SettingsRow label="Longest streak"><span>{formatDayCount(summary.longestStreakDays)}</span></SettingsRow></SettingsGroup> : <p className="settings-note">Token activity is unavailable for this account.</p>}
      {dailyUsage && dailyUsage.length > 0 && <details className="settings-advanced"><summary>Daily token activity <span className="settings-inline-meta">{dailyUsage.length} days</span></summary><SettingsGroup>{dailyUsage.map((bucket) => <SettingsRow key={bucket.startDate} label={bucket.startDate}><span>{formatExactNumber(bucket.tokens)} tokens</span></SettingsRow>)}</SettingsGroup></details>}
    </SettingsSection>
    <SettingsSection title="Quota windows" description="Reported usage and exact local reset times.">
      {limits.length ? <div className="settings-quota-list">{limits.map((limit) => <div key={limit.limitId}><div className="settings-quota-title"><p>{rateLimitLabel(limit)}</p>{limit.planType && <span>{limit.planType}</span>}</div><div className="settings-group">{limit.primary && <QuotaWindow name="Primary window" window={limit.primary} />}{limit.secondary && <QuotaWindow name="Secondary window" window={limit.secondary} />}</div>{limit.rateLimitReachedType && <p className="settings-error">{limit.rateLimitReachedType}</p>}</div>)}</div> : <p className="settings-note">Quota-window usage is unavailable for this account.</p>}
    </SettingsSection>
    <SettingsSection title="Banked resets" description="Earned rate-limit resets available on this account."><SettingsGroup><SettingsRow label="Available resets"><span>{resetCredits ? formatExactNumber(resetCredits.availableCount) : "Unavailable"}</span></SettingsRow>{resetCredits?.credits?.map((credit) => <SettingsRow key={credit.id} label={credit.title ?? "Rate-limit reset"} description={<>{credit.description && <>{credit.description}<br /></>}{credit.resetType} · Granted {formatUnixTimestamp(credit.grantedAt)} · {credit.expiresAt ? `Expires ${formatUnixTimestamp(credit.expiresAt)}` : "Does not expire"}</>}><span className="settings-value">{credit.status}</span></SettingsRow>)}</SettingsGroup>{resetCredits && resetCredits.availableCount > (resetCredits.credits?.length ?? 0) && <p className="settings-note">The account reported {resetCredits.availableCount} available resets and returned {resetCredits.credits?.length ?? 0} individual details.</p>}</SettingsSection>
    <SettingsSection title="Workspace instructions" description="Included in every planning and execution run in this repository."><SettingsGroup><SettingsRow stacked label="Instructions" description="Repository conventions, required checks, and architecture boundaries."><Textarea className="min-h-44 font-mono" value={instructions} disabled={settings.isLoading || !settings.data} onChange={(event) => setInstructions(event.target.value)} placeholder="Describe how Codex should work in this repository…" /></SettingsRow></SettingsGroup><div className="settings-save-bar"><p>{save.isSuccess ? "Instructions saved." : "Applies to new runs in this workspace."}</p><Button size="sm" onClick={() => save.mutate()} disabled={save.isPending || settings.isLoading || !settings.data}>{save.isPending && <LoaderCircle className="animate-spin" />}Save instructions</Button></div>{save.error && <p role="alert" className="settings-error">{save.error.message}</p>}</SettingsSection>
    <SettingsSection title="MCP servers" description="Tools available to Codex in this workspace.">
      <div className="settings-mcp-list">{mcps.map((mcp, index) => <div key={String(mcp.name ?? mcp.id ?? index)} className="settings-integration-row"><div className="settings-integration-logo"><Plug /></div><div className="settings-row-copy"><p>{String(mcp.name ?? mcp.id ?? "MCP server")}</p><p>{String(mcp.status ?? mcp.authStatus ?? "Configured")}</p></div>{Array.isArray(mcp.tools) && <span className="settings-value">{mcp.tools.length} tools</span>}</div>)}{!mcps.length && <p className="settings-note">No MCP servers reported for this workspace.</p>}</div>
      <details className="settings-advanced"><summary>Add MCP server</summary><form onSubmit={(event) => { event.preventDefault(); if (!addMcp.isPending) addMcp.mutate(); }}><SettingsGroup><SettingsRow label="Server name"><Input value={mcpName} onChange={(event) => setMcpName(event.target.value)} required /></SettingsRow><SettingsRow label="Connection type"><SettingsSelect value={mcpType} onValueChange={(value) => setMcpType(value as "url" | "command")} options={[{ value: "url", label: "HTTP URL" }, { value: "command", label: "Command" }]} /></SettingsRow><SettingsRow stacked label={mcpType === "url" ? "Server URL" : "Command"}><Input placeholder={mcpType === "url" ? "https://mcp.example.com" : "npx"} value={mcpValue} onChange={(event) => setMcpValue(event.target.value)} required /></SettingsRow>{mcpType === "command" && <SettingsRow stacked label="Arguments" description="Separate arguments with spaces."><Input value={mcpArgs} onChange={(event) => setMcpArgs(event.target.value)} /></SettingsRow>}</SettingsGroup><div className="settings-save-bar"><p>Saved to .codex/config.toml in this repository.</p><Button size="sm" disabled={addMcp.isPending || !mcpName.trim() || !mcpValue.trim()}>{addMcp.isPending ? <LoaderCircle className="animate-spin" /> : <Plus />}Add server</Button></div>{addMcp.error && <p role="alert" className="settings-error">{addMcp.error.message}</p>}</form></details>
    </SettingsSection>
  </div>;
}

function TeamSettings() {
  const user = useAppStore((state) => state.user);
  const queryClient = useQueryClient();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const users = useQuery({ queryKey: ["users"], queryFn: api.users, enabled: user?.role === "admin" });
  const create = useMutation({ mutationFn: () => api.createUser(username, password), onSuccess: () => { setUsername(""); setPassword(""); void queryClient.invalidateQueries({ queryKey: ["users"] }); } });
  return <div className="settings-content">
    <SettingsSection title="Members" description="Members can access every workspace and task on this machine.">
      {user?.role === "admin" ? <>
        {users.isLoading && <p className="settings-note">Loading members…</p>}
        {users.error && <p role="alert" className="settings-error">{users.error.message}</p>}
        {users.data && <SettingsGroup>{users.data.map((entry) => <div key={entry.id} className="settings-person-row"><div className="settings-person-avatar">{entry.username.slice(0, 1)}</div><div className="settings-row-copy"><p>{entry.username}{entry.id === user.id && <span className="settings-inline-meta">You</span>}</p><p>{entry.mustChangePassword ? "Password change required" : "Active account"}</p></div><span className={cn("settings-value", entry.disabled && "text-destructive")}>{entry.disabled ? "Disabled" : entry.role === "admin" ? "Administrator" : "Member"}</span></div>)}</SettingsGroup>}
      </> : <SettingsGroup><SettingsRow label="Your access" description="An administrator manages member accounts on this machine."><span className="settings-value">Member</span></SettingsRow></SettingsGroup>}
    </SettingsSection>
    {user?.role === "admin" && <SettingsSection title="Invite member" description="Set a temporary password. The member will replace it on first sign-in."><form onSubmit={(event: FormEvent) => { event.preventDefault(); if (!create.isPending) create.mutate(); }}><SettingsGroup><SettingsRow label="Username" description="At least three characters."><Input autoComplete="off" minLength={3} value={username} onChange={(event) => setUsername(event.target.value)} required /></SettingsRow><SettingsRow label="Temporary password"><Input type="password" autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} required /></SettingsRow></SettingsGroup><div className="settings-save-bar"><p>{create.isSuccess ? "Member created." : "The account belongs to this machine."}</p><Button size="sm" disabled={create.isPending || username.length < 3 || !password}>{create.isPending ? <LoaderCircle className="animate-spin" /> : <UserPlus />}Create member</Button></div>{create.error && <p role="alert" className="settings-error">{create.error.message}</p>}</form></SettingsSection>}
  </div>;
}

const sectionDescriptions: Record<Section, string> = {
  providers: "Connect AI accounts and set their defaults.",
  connections: "Manage the Boosted machines available on this device.",
  notifications: "Choose what you hear about and when.",
  web: "Configure browser access to this machine.",
  application: "Keep Boosted up to date.",
  team: "Manage access to this machine.",
  workspace: "Repository details and task defaults.",
  integrations: "Bring external issues into your workspace.",
  codex: "Account usage, workspace instructions, and MCP servers.",
};

export function SettingsPage({ section, onSectionChange, onClose }: { section: Section; onSectionChange: (section: Section) => void; onClose: () => void }) {
  const [search, setSearch] = useState("");
  const [navigationOpen, setNavigationOpen] = useState(false);
  const projectId = useAppStore((state) => state.selectedProjectId);
  const scrollRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const selected = sectionGroups.flatMap((group) => group.sections).find((item) => item.id === section)!;
  const query = search.trim().toLocaleLowerCase();
  const visibleGroups = sectionGroups.map((group) => ({ ...group, sections: group.sections.filter((item) => `${group.label} ${item.label} ${sectionDescriptions[item.id]}`.toLocaleLowerCase().includes(query)) }));
  useEffect(() => { scrollRef.current?.scrollTo?.(0, 0); headingRef.current?.focus({ preventScroll: true }); }, [section]);
  function select(id: Section) { onSectionChange(id); setNavigationOpen(false); }
  const navigation = <>
    <div className="settings-sidebar-heading"><h2>Settings</h2><Button variant="ghost" size="icon-sm" type="button" aria-label="Back to workspace" title="Back to workspace" onClick={onClose}><ArrowLeft /></Button></div>
    <div className="settings-search"><Search /><Input aria-label="Search settings" placeholder="Search settings" value={search} onChange={(event) => setSearch(event.target.value)} />{search && <Button variant="ghost" size="icon-sm" type="button" aria-label="Clear settings search" onClick={() => setSearch("")}><X /></Button>}</div>
    <nav className="settings-nav" aria-label="Settings sections">{visibleGroups.map((group) => group.sections.length > 0 && <div key={group.label} className="settings-nav-group">
      <p className="settings-nav-heading">{group.label}</p>
      {group.sections.map(({ id, label, icon: Icon }) => <Button variant="ghost" size="sm" type="button" key={id} aria-current={section === id ? "page" : undefined} className={cn("settings-nav-item", section === id && "settings-nav-item-active")} onClick={() => select(id)}><Icon />{label}</Button>)}
    </div>)}{!visibleGroups.some((group) => group.sections.length) && <p className="settings-search-empty">No settings match your search.</p>}</nav>
    <p className="settings-sidebar-scope">{projectId ? "Workspace settings apply to the open repository." : "Open a workspace to configure repository settings."}</p>
  </>;
  return <section className="settings-page" aria-label="Settings">
    <aside className="settings-sidebar immersive-panel">{navigation}</aside>
    <div className="settings-main" ref={scrollRef}>
      <div className="settings-mobile-controls"><Button variant="ghost" size="sm" onClick={onClose}><ArrowLeft />Workspace</Button><Button variant="ghost" size="sm" aria-label="Browse settings sections" onClick={() => setNavigationOpen(true)}><Menu />Sections</Button></div>
      <div className="settings-page-heading"><h1 ref={headingRef} tabIndex={-1}>{selected.label === "General" ? "Workspace" : selected.label}</h1><p>{sectionDescriptions[section]}</p></div>
      <div key={section}>
        {section === "providers" && <ProvidersSettings />}
        {section === "connections" && <ConnectionsSettings />}
        {section === "notifications" && <NotificationSettings />}
        {section === "web" && <GlobalWebSettings />}
        {section === "application" && <ApplicationSettings />}
        {section === "team" && <TeamSettings />}
        {section === "workspace" && <WorkspaceSettings />}
        {section === "integrations" && <IntegrationsSettings />}
        {section === "codex" && (projectId ? <CodexSettings /> : <div className="settings-content"><p className="settings-empty">Open a workspace to configure Codex instructions and MCP servers.</p></div>)}
      </div>
    </div>
    <Dialog open={navigationOpen} onOpenChange={setNavigationOpen}><DialogContent className="settings-navigation-drawer immersive-panel"><DialogHeader className="sr-only"><DialogTitle>Settings sections</DialogTitle><DialogDescription>Choose a settings section.</DialogDescription></DialogHeader>{navigation}</DialogContent></Dialog>
  </section>;
}
