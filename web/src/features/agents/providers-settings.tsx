import { useCallback, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, ChevronRight, ExternalLink, LoaderCircle, Plus, RefreshCw, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { SettingsGroup, SettingsRow, SettingsSection, SettingsSelect } from "@/components/settings-primitives";
import { useAppStore } from "@/lib/store";
import { apiClient, type ProviderAccountResponse, type ProviderDefinitionResponse, type ProviderLimitSnapshot, type ProviderLimitWindow } from "./lib/api-client";
import { formatWindowDuration } from "@/lib/codex-usage";
import { composerReasoningEffortOptions, composerServiceTierOptions, formatProviderQuota, readComposerAccessMode, readComposerReasoningEffort, readComposerServiceTier } from "./lib/session";
import { ProviderGlyph, ProviderStatusBadge } from "./components/session/provider-icons";
import { ProviderQuotaProvider, useProviderQuotas, type ProviderQuotaHistoryPoint } from "./components/session/provider-quota-context";
import { useProviderAccountDialogState } from "./components/session/provider-account-dialog-state";
import { ModelPresetsSettings } from "./model-presets-settings";

export function ProvidersSettings() {
  return <ProviderQuotaProvider><ProviderAccounts /></ProviderQuotaProvider>;
}

function ProviderAccounts() {
  const queryClient = useQueryClient();
  const readOnly = useAppStore((state) => state.user?.role !== "admin");
  const providers = useQuery({ queryKey: ["providers"], queryFn: apiClient.providers.list });
  const accounts = useQuery({ queryKey: ["provider-accounts"], queryFn: apiClient.providerAccounts.list });
  const { accountLimits, accountErrors, error: quotaError, history: quotaHistory, isLoading: quotasLoading, updatedAt: quotasUpdatedAt, refreshQuotas } = useProviderQuotas();
  const [selectedId, setSelectedId] = useState<string>();
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<"all" | "connected">("all");
  const [newProviderId, setNewProviderId] = useState("codex");
  const reload = useCallback(async () => { await Promise.all([queryClient.invalidateQueries({ queryKey: ["provider-accounts"] }), refreshQuotas()]); }, [queryClient, refreshQuotas]);
  const updateAccount = useCallback((account: ProviderAccountResponse) => queryClient.setQueryData<ProviderAccountResponse[]>(["provider-accounts"], (old) => old?.map((item) => item.id === account.id ? account : item)), [queryClient]);
  const removeAccount = useCallback((id: string) => { queryClient.setQueryData<ProviderAccountResponse[]>(["provider-accounts"], (old) => old?.filter((item) => item.id !== id)); setSelectedId(undefined); }, [queryClient]);
  const create = useMutation({ mutationFn: (providerId: string) => apiClient.providerAccounts.create({ providerId }), onSuccess: (account) => { queryClient.setQueryData<ProviderAccountResponse[]>(["provider-accounts"], (old) => [...(old ?? []), account]); setSelectedId(account.id); } });
  const selected = accounts.data?.find((account) => account.id === selectedId);
  const provider = providers.data?.find((item) => item.id === selected?.providerId);
  const filtered = accounts.data?.filter((account) => (filter === "all" || account.status === "CONNECTED") && `${account.displayName} ${account.providerId}`.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())) ?? [];
  return <div className="settings-content">
    {selected && provider ? <ProviderAccountSettings key={selected.id} account={selected} provider={provider} readOnly={readOnly} onBack={() => setSelectedId(undefined)} onAccountChange={updateAccount} onAccountDelete={removeAccount} onReload={reload} /> : <>
      <ModelPresetsSettings providers={providers.data ?? []} accounts={accounts.data ?? []} readOnly={readOnly} />
      <SettingsSection title="Provider usage" description="Quota consumed by each account, with a locally recorded 24-hour trend. Refreshes every minute." actions={<><span className="provider-usage-refresh-state">{quotasLoading ? "Refreshing…" : quotasUpdatedAt ? `Updated ${new Intl.DateTimeFormat(undefined, { timeStyle: "short" }).format(new Date(quotasUpdatedAt))}` : null}</span><Button variant="ghost" size="icon-sm" aria-label="Refresh provider usage" disabled={quotasLoading} onClick={() => void refreshQuotas()}><RefreshCw className={quotasLoading ? "animate-spin" : ""} /></Button></>}>
        <ProviderUsageChart accounts={accounts.data ?? []} providers={providers.data ?? []} limits={accountLimits} history={quotaHistory} accountErrors={accountErrors} loading={quotasLoading} error={quotaError} />
      </SettingsSection>
      <SettingsSection title="Provider accounts" description="Connect isolated Codex and Claude accounts, then choose their chat defaults." actions={<><SettingsSelect aria-label="New account provider" value={newProviderId} onValueChange={setNewProviderId} disabled={readOnly || create.isPending || providers.isLoading} options={(providers.data ?? []).map((item) => ({ value: item.id, label: item.label }))} /><Button variant="ghost" size="icon-sm" aria-label="Refresh providers" disabled={accounts.isFetching || quotasLoading} onClick={() => void reload()}><RefreshCw className={accounts.isFetching || quotasLoading ? "animate-spin" : ""} /></Button><Button size="sm" disabled={readOnly || create.isPending || providers.isLoading || !newProviderId} onClick={() => create.mutate(newProviderId)}>{create.isPending ? <LoaderCircle className="animate-spin" /> : <Plus />}Add account</Button></>}>
        <div className="settings-list-toolbar"><div className="settings-filters" aria-label="Filter provider accounts"><Button variant="ghost" type="button" aria-pressed={filter === "all"} onClick={() => setFilter("all")}>All <span>{accounts.data?.length ?? 0}</span></Button><Button variant="ghost" type="button" aria-pressed={filter === "connected"} onClick={() => setFilter("connected")}>Connected <span>{accounts.data?.filter((item) => item.status === "CONNECTED").length ?? 0}</span></Button></div><label className="settings-list-search"><Search /><Input aria-label="Search provider accounts" placeholder="Search accounts" value={search} onChange={(event) => setSearch(event.target.value)} /></label></div>
        {accounts.isLoading || providers.isLoading ? <p className="settings-note">Loading provider accounts…</p> : <SettingsGroup>{filtered.map((account) => <Button variant="ghost" key={account.id} type="button" className="settings-account-row" onClick={() => setSelectedId(account.id)}><ProviderGlyph icon={providers.data?.find((item) => item.id === account.providerId)?.icon ?? "codex"} /><span className="settings-row-copy"><span>{account.displayName}</span><small>{providers.data?.find((item) => item.id === account.providerId)?.label ?? account.providerId}{accountLimits[account.id] ? ` · ${formatProviderQuota(accountLimits[account.id])}` : ""}</small></span><ProviderStatusBadge status={account.status} /><ChevronRight className="size-4 text-muted-foreground" /></Button>)}</SettingsGroup>}
        {!accounts.isLoading && !filtered.length && <div className="settings-empty"><p>{accounts.data?.length ? "No accounts match these filters." : "No provider accounts connected yet."}</p>{accounts.data?.length ? <Button variant="ghost" size="sm" onClick={() => { setSearch(""); setFilter("all"); }}>Clear filters</Button> : <p>Add an account to connect a coding provider and choose its defaults.</p>}</div>}
        {(accounts.error || providers.error || create.error) && <p role="alert" className="settings-error">{(accounts.error ?? providers.error ?? create.error)?.message}</p>}
      </SettingsSection>
      {readOnly && <p className="settings-note">An administrator manages provider accounts. You can use connected accounts.</p>}
    </>}
  </div>;
}

function ProviderUsageChart({ accounts, providers, limits, history, accountErrors, loading, error }: {
  accounts: ProviderAccountResponse[];
  providers: ProviderDefinitionResponse[];
  limits: ReturnType<typeof useProviderQuotas>["accountLimits"];
  history: ProviderQuotaHistoryPoint[];
  accountErrors: Record<string, string>;
  loading: boolean;
  error: string | null;
}) {
  const rows = accounts.flatMap((account) => {
    const snapshot = limits[account.id]?.rateLimits;
    if (!snapshot) return [];
    return [{ account, snapshot, windows: providerUsageWindows(snapshot) }];
  });
  if (!rows.length) return <div className="settings-empty provider-usage-empty">{loading ? <p role="status">Loading provider usage…</p> : <p>{error ?? "Quota usage is unavailable for connected accounts."}</p>}</div>;
  return <figure className="provider-usage-chart" aria-label="Provider quota usage">
    {error && <p role="alert" className="settings-error">Cached quota shown because refresh failed: {error}</p>}
    {rows.map(({ account, windows }) => <div className="provider-usage-account" data-limit-count={windows.length} key={account.id}>
      <figcaption className="provider-usage-identity"><ProviderGlyph icon={providers.find((provider) => provider.id === account.providerId)?.icon ?? "codex"} /><span><strong>{account.displayName}</strong><small>{providers.find((provider) => provider.id === account.providerId)?.label ?? account.providerId}</small></span></figcaption>
      <div className="provider-usage-windows">{windows.sort((first, second) => first.sort - second.sort).map((entry) => {
          const used = Math.max(0, Math.min(100, entry.window.usedPercent));
          const level = used >= 80 ? "critical" : used >= 60 ? "warning" : "normal";
          return <div className="provider-usage-window" key={entry.key}><div><span>{entry.label}</span><b>{Math.round(used)}% <small>used</small></b></div><div className="provider-usage-track" data-level={level} role="progressbar" aria-label={`${account.displayName} ${entry.label} usage`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(used)}><i style={{ width: `${used}%` }} /></div></div>;
        })}</div>
      <ProviderQuotaTrend account={account} windows={windows} history={history} />
      {accountErrors[account.id] && <p className="settings-error">{accountErrors[account.id]}</p>}
    </div>)}
  </figure>;
}

function ProviderQuotaTrend({ account, windows, history }: { account: ProviderAccountResponse; windows: ReturnType<typeof providerUsageWindows>; history: ProviderQuotaHistoryPoint[] }) {
  const width = 640;
  const height = 112;
  const plot = { left: 28, right: 628, top: 10, bottom: 84 };
  const samples = history.filter((point) => point.data[account.id]?.rateLimits).sort((first, second) => first.capturedAt - second.capturedAt);
  const end = samples.at(-1)?.capturedAt ?? Date.now();
  const start = end - 24 * 60 * 60_000;
  const x = (capturedAt: number) => plot.left + (capturedAt - start) / (end - start) * (plot.right - plot.left);
  const y = (used: number) => plot.bottom - Math.max(0, Math.min(100, used)) / 100 * (plot.bottom - plot.top);
  const colors = ["var(--chat-accent)", "var(--success)"];
  const series = windows.map((window) => ({ ...window, points: samples.flatMap((point) => {
    const snapshot = point.data[account.id]?.rateLimits;
    const match = snapshot && providerUsageWindows(snapshot).find((candidate) => candidate.key === window.key);
    return match ? [{ capturedAt: point.capturedAt, used: match.window.usedPercent }] : [];
  }) }));
  const hasTrend = series.some((item) => item.points.length > 1);
  return <div className="provider-quota-trend">
    <div className="provider-quota-trend-header"><span>Quota trend</span><small>Last 24 hours · recorded on this device</small></div>
    <div className="provider-quota-chart-wrap">
      <svg className="provider-quota-chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${account.displayName} quota usage trend`}>
        <title>{account.displayName} quota usage trend</title>
        <desc>Quota percent used over the last 24 hours for each reported provider window.</desc>
        {[0, 50, 100].map((tick) => <g key={tick}><line className="provider-quota-grid" x1={plot.left} x2={plot.right} y1={y(tick)} y2={y(tick)} /><text className="provider-quota-axis" x={plot.left - 5} y={y(tick) + 3} textAnchor="end">{tick}%</text></g>)}
        {series.map((item, index) => item.points.length > 1 ? <polyline key={item.key} fill="none" stroke={colors[index % colors.length]} strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" points={item.points.map((point) => `${x(point.capturedAt)},${y(point.used)}`).join(" ")} /> : item.points.map((point) => <circle key={item.key} cx={x(point.capturedAt)} cy={y(point.used)} r="3.5" fill={colors[index % colors.length]} />))}
        <text className="provider-quota-axis" x={plot.left} y="104">24h ago</text>
        <text className="provider-quota-axis" x={plot.right} y="104" textAnchor="end">Now</text>
      </svg>
      {!hasTrend && <p className="provider-quota-chart-empty">Collecting trend data…</p>}
    </div>
    <div className="provider-quota-legend">{series.map((item, index) => <span key={item.key}><i style={{ background: colors[index % colors.length] }} />{item.label}</span>)}</div>
  </div>;
}

function providerUsageWindows(snapshot: ProviderLimitSnapshot) {
  return ([snapshot.primary, snapshot.secondary] as const).flatMap((window, index) => {
    if (!window) return [];
    const minutes = window.windowDurationMins;
    return [{ key: minutes == null ? `slot-${index}` : `minutes-${minutes}`, label: formatWindowDuration(minutes), sort: minutes ?? Number.MAX_SAFE_INTEGER + index, window: window as ProviderLimitWindow }];
  });
}

function ProviderAccountSettings({ account, provider, readOnly, onBack, onAccountChange, onAccountDelete, onReload }: { account: ProviderAccountResponse; provider: ProviderDefinitionResponse; readOnly: boolean; onBack(): void; onAccountChange(account: ProviderAccountResponse): void; onAccountDelete(id: string): void; onReload(): Promise<void> }) {
  const draft = useProviderAccountDialogState(account, provider, onAccountChange, onAccountDelete, onReload);
  const modelOptions = draft.modelOptions.some((option) => option.model === draft.defaultModel) || !draft.defaultModel ? draft.modelOptions : [{ id: draft.defaultModel, model: draft.defaultModel, displayName: draft.defaultModel }, ...draft.modelOptions];
  return <>
    <Button className="settings-back-link" variant="ghost" size="sm" onClick={onBack}><ArrowLeft />All accounts</Button>
    <SettingsSection title={account.displayName} actions={<ProviderStatusBadge status={account.status} />}>
      {draft.notice && <p role={draft.notice.kind === "error" ? "alert" : "status"} className={draft.notice.kind === "error" ? "settings-error" : "settings-note"}>{draft.notice.text}</p>}
      {draft.deviceLogin && <div className="settings-auth-code"><p>Enter this code on the device sign-in page.</p><code>{draft.deviceLogin.userCode}</code><a href={draft.deviceLogin.verificationUrl} target="_blank" rel="noreferrer">Open device sign-in <ExternalLink className="size-3" /></a></div>}
      <fieldset disabled={readOnly || draft.saving || draft.deleting} className="settings-fieldset"><SettingsGroup>
        <SettingsRow label="Account name" description="A name to recognize this account in Boosted."><Input value={draft.displayName} onChange={(event) => draft.setDisplayName(event.target.value)} /></SettingsRow>
        {provider.id === "claude" ? <>
          <SettingsRow label="Authentication" description={draft.connected ? `Connected with ${draft.authMode === "apiKey" ? "an API key" : "Claude web sign-in"}.` : "Use your Claude subscription in the browser or an Anthropic API key."}><SettingsSelect value={draft.authMode} onValueChange={(value) => draft.setAuthMode(value as "web" | "apiKey")} options={[{ value: "web", label: "Claude web sign-in" }, { value: "apiKey", label: "Anthropic API key" }]} /></SettingsRow>
          {draft.authMode === "apiKey" && <SettingsRow label="API key" description="Stored only in this account's private provider directory."><Input type="password" autoComplete="off" placeholder={account.lastAuthMode === "apiKey" ? "Enter a new key to replace the saved key" : "sk-ant-…"} value={draft.apiKey} onChange={(event) => draft.setApiKey(event.target.value)} /></SettingsRow>}
          <SettingsRow label="Connect" description={draft.authMode === "web" ? "Claude Code opens your browser to complete sign-in." : "The key is injected only into this Claude account's runtime."}><Button variant="secondary" size="sm" disabled={draft.authenticating || (draft.authMode === "apiKey" && !draft.apiKey.trim())} onClick={() => void draft.authenticate()}>{draft.authenticating && <LoaderCircle className="animate-spin" />}{draft.authenticating ? "Connecting…" : draft.connected ? "Reconnect" : "Connect"}</Button></SettingsRow>
        </> : <SettingsRow label="Authentication" description={draft.connected ? "Signed in and ready to use." : "Sign in with your ChatGPT account using a device code."}><Button variant="secondary" size="sm" disabled={draft.authenticating} onClick={() => void draft.authenticate()}>{draft.authenticating && <LoaderCircle className="animate-spin" />}{draft.authenticating ? "Connecting…" : draft.connected ? "Sign in again" : "Sign in"}</Button></SettingsRow>}
        {provider.id === "codex" && <SettingsRow label="Personality" description="Default communication style for coding chats."><SettingsSelect value={draft.personality} onValueChange={(value) => draft.setPersonality(value as "pragmatic" | "friendly")} disabled={readOnly || draft.saving || draft.deleting} options={[{ value: "pragmatic", label: "Pragmatic" }, { value: "friendly", label: "Friendly" }]} /></SettingsRow>}
      </SettingsGroup></fieldset>
    </SettingsSection>
    <SettingsSection title="Chat defaults" description="Defaults for new coding chats using this account."><fieldset disabled={readOnly || draft.saving} className="settings-fieldset"><SettingsGroup>
      {draft.hasDefaultModelField && <SettingsRow label="Model"><SettingsSelect className="settings-model-select" value={draft.defaultModel} onFocus={draft.refreshModels} onValueChange={draft.setDefaultModel} disabled={readOnly || draft.saving} options={[{ value: "", label: "Use provider model preset" }, ...modelOptions.map((option) => ({ value: option.model, label: option.displayName }))]} /></SettingsRow>}
      {draft.hasDefaultPermissionField && <SettingsRow label="Access" description={`Choose whether ${provider.label} should ask before actions that require permission.`}><SettingsSelect value={draft.defaultPermissionMode} onValueChange={(value) => draft.setDefaultPermissionMode(readComposerAccessMode(value))} disabled={readOnly || draft.saving} options={[{ value: "askForApproval", label: "Ask for approval" }, { value: "fullAccess", label: "Full access" }]} /></SettingsRow>}
      {draft.hasDefaultReasoningField && <SettingsRow label="Reasoning"><SettingsSelect value={draft.defaultReasoningEffort} onValueChange={(value) => draft.setDefaultReasoningEffort(value ? readComposerReasoningEffort(value) : "")} disabled={readOnly || draft.saving} options={[{ value: "", label: "Use provider model preset" }, ...composerReasoningEffortOptions]} /></SettingsRow>}
      {draft.hasDefaultServiceTierField && <SettingsRow label="Speed"><SettingsSelect value={draft.defaultServiceTier} onValueChange={(value) => draft.setDefaultServiceTier(readComposerServiceTier(value))} disabled={readOnly || draft.saving} options={composerServiceTierOptions} /></SettingsRow>}
    </SettingsGroup></fieldset></SettingsSection>
    {draft.hasCodexHomeField && <SettingsSection title="Account storage"><fieldset disabled={readOnly || draft.saving} className="settings-fieldset"><SettingsGroup><SettingsRow stacked label={provider.id === "claude" ? "Claude home" : "Codex home"} description="An isolated directory for this account's credentials and chat history."><Input className="font-mono" value={draft.codexHome} onChange={(event) => draft.setCodexHome(event.target.value)} /></SettingsRow></SettingsGroup></fieldset></SettingsSection>}
    <details className="settings-advanced"><summary>Advanced configuration</summary><fieldset disabled={readOnly || draft.saving} className="settings-fieldset"><SettingsGroup><SettingsRow stacked label="Additional settings" description="Provider settings as a JSON object."><Textarea className="min-h-28 font-mono" value={draft.settingsJson} onChange={(event) => draft.setSettingsJson(event.target.value)} /></SettingsRow><SettingsRow stacked label="Additional runtime defaults" description="Extra chat runtime options as a JSON object."><Textarea className="min-h-28 font-mono" value={draft.runtimeDefaultsJson} onChange={(event) => draft.setRuntimeDefaultsJson(event.target.value)} /></SettingsRow></SettingsGroup></fieldset></details>
    {readOnly ? <p className="settings-note">Only an administrator can change this account.</p> : <div className="settings-save-bar"><Button variant="ghost" size="sm" className="text-destructive" disabled={draft.deleting || draft.saving || draft.authenticating} onClick={() => void draft.deleteProviderAccount()}>{draft.deleting ? "Removing…" : "Remove account"}</Button><Button size="sm" disabled={draft.saving || draft.deleting || draft.authenticating || !draft.displayName.trim()} onClick={() => void draft.saveConfig()}>{draft.saving && <LoaderCircle className="animate-spin" />}Save changes</Button></div>}
  </>;
}
