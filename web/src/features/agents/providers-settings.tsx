import { useCallback, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, ChevronRight, ExternalLink, LoaderCircle, Plus, RefreshCw, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { SettingsGroup, SettingsRow, SettingsSection, SettingsSelect } from "@/components/settings-primitives";
import { useAppStore } from "@/lib/store";
import { apiClient, type ProviderAccountResponse, type ProviderDefinitionResponse } from "./lib/api-client";
import { composerReasoningEffortOptions, composerServiceTierOptions, formatProviderQuota, readComposerAccessMode, readComposerReasoningEffort, readComposerServiceTier } from "./lib/session";
import { ProviderGlyph, ProviderStatusBadge } from "./components/session/provider-icons";
import { ProviderQuotaProvider, useProviderQuotas } from "./components/session/provider-quota-context";
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
  const { accountLimits, refreshQuotas } = useProviderQuotas();
  const [selectedId, setSelectedId] = useState<string>();
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<"all" | "connected">("all");
  const reload = useCallback(async () => { await Promise.all([queryClient.invalidateQueries({ queryKey: ["provider-accounts"] }), refreshQuotas()]); }, [queryClient, refreshQuotas]);
  const updateAccount = useCallback((account: ProviderAccountResponse) => queryClient.setQueryData<ProviderAccountResponse[]>(["provider-accounts"], (old) => old?.map((item) => item.id === account.id ? account : item)), [queryClient]);
  const removeAccount = useCallback((id: string) => { queryClient.setQueryData<ProviderAccountResponse[]>(["provider-accounts"], (old) => old?.filter((item) => item.id !== id)); setSelectedId(undefined); }, [queryClient]);
  const create = useMutation({ mutationFn: () => apiClient.providerAccounts.create({ providerId: "codex" }), onSuccess: (account) => { queryClient.setQueryData<ProviderAccountResponse[]>(["provider-accounts"], (old) => [...(old ?? []), account]); setSelectedId(account.id); } });
  const selected = accounts.data?.find((account) => account.id === selectedId);
  const provider = providers.data?.find((item) => item.id === selected?.providerId);
  const filtered = accounts.data?.filter((account) => (filter === "all" || account.status === "CONNECTED") && `${account.displayName} ${account.providerId}`.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())) ?? [];
  return <div className="settings-content">
    {selected && provider ? <ProviderAccountSettings key={selected.id} account={selected} provider={provider} readOnly={readOnly} onBack={() => setSelectedId(undefined)} onAccountChange={updateAccount} onAccountDelete={removeAccount} onReload={reload} /> : <>
      <ModelPresetsSettings providers={providers.data ?? []} accounts={accounts.data ?? []} readOnly={readOnly} />
      <SettingsSection title="Provider accounts" description="Each account uses its own Codex home and sign-in." actions={<><Button variant="ghost" size="icon-sm" aria-label="Refresh providers" disabled={accounts.isFetching} onClick={() => void reload()}><RefreshCw className={accounts.isFetching ? "animate-spin" : ""} /></Button><Button size="sm" disabled={readOnly || create.isPending || providers.isLoading} onClick={() => create.mutate()}>{create.isPending ? <LoaderCircle className="animate-spin" /> : <Plus />}Add account</Button></>}>
        <div className="settings-list-toolbar"><div className="settings-filters" aria-label="Filter provider accounts"><Button variant="ghost" type="button" aria-pressed={filter === "all"} onClick={() => setFilter("all")}>All <span>{accounts.data?.length ?? 0}</span></Button><Button variant="ghost" type="button" aria-pressed={filter === "connected"} onClick={() => setFilter("connected")}>Connected <span>{accounts.data?.filter((item) => item.status === "CONNECTED").length ?? 0}</span></Button></div><label className="settings-list-search"><Search /><Input aria-label="Search provider accounts" placeholder="Search accounts" value={search} onChange={(event) => setSearch(event.target.value)} /></label></div>
        {accounts.isLoading || providers.isLoading ? <p className="settings-note">Loading provider accounts…</p> : <SettingsGroup>{filtered.map((account) => <Button variant="ghost" key={account.id} type="button" className="settings-account-row" onClick={() => setSelectedId(account.id)}><ProviderGlyph icon={providers.data?.find((item) => item.id === account.providerId)?.icon ?? "codex"} /><span className="settings-row-copy"><span>{account.displayName}</span><small>{providers.data?.find((item) => item.id === account.providerId)?.label ?? account.providerId}{accountLimits[account.id] ? ` · ${formatProviderQuota(accountLimits[account.id])}` : ""}</small></span><ProviderStatusBadge status={account.status} /><ChevronRight className="size-4 text-muted-foreground" /></Button>)}</SettingsGroup>}
        {!accounts.isLoading && !filtered.length && <div className="settings-empty"><p>{accounts.data?.length ? "No accounts match these filters." : "No provider accounts connected yet."}</p>{accounts.data?.length ? <Button variant="ghost" size="sm" onClick={() => { setSearch(""); setFilter("all"); }}>Clear filters</Button> : <p>Add an account to connect Codex and choose its defaults.</p>}</div>}
        {(accounts.error || providers.error || create.error) && <p role="alert" className="settings-error">{(accounts.error ?? providers.error ?? create.error)?.message}</p>}
      </SettingsSection>
      {readOnly && <p className="settings-note">An administrator manages provider accounts. You can use connected accounts.</p>}
    </>}
  </div>;
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
        <SettingsRow label="Authentication" description={draft.connected ? "Signed in and ready to use." : "Sign in with your ChatGPT account using a device code."}><Button variant="secondary" size="sm" disabled={draft.authenticating} onClick={() => void draft.authenticate()}>{draft.authenticating && <LoaderCircle className="animate-spin" />}{draft.authenticating ? "Connecting…" : draft.connected ? "Sign in again" : "Sign in"}</Button></SettingsRow>
        <SettingsRow label="Personality" description="Default communication style for coding chats."><SettingsSelect value={draft.personality} onValueChange={(value) => draft.setPersonality(value as "pragmatic" | "friendly")} disabled={readOnly || draft.saving || draft.deleting} options={[{ value: "pragmatic", label: "Pragmatic" }, { value: "friendly", label: "Friendly" }]} /></SettingsRow>
      </SettingsGroup></fieldset>
    </SettingsSection>
    <SettingsSection title="Chat defaults" description="Defaults for new coding chats using this account."><fieldset disabled={readOnly || draft.saving} className="settings-fieldset"><SettingsGroup>
      {draft.hasDefaultModelField && <SettingsRow label="Model"><SettingsSelect className="settings-model-select" value={draft.defaultModel} onFocus={draft.refreshModels} onValueChange={draft.setDefaultModel} disabled={readOnly || draft.saving} options={[{ value: "", label: "Use provider model preset" }, ...modelOptions.map((option) => ({ value: option.model, label: option.displayName }))]} /></SettingsRow>}
      <SettingsRow label="Access" description="Choose whether Codex should ask before actions that require permission."><SettingsSelect value={draft.defaultPermissionMode} onValueChange={(value) => draft.setDefaultPermissionMode(readComposerAccessMode(value))} disabled={readOnly || draft.saving} options={[{ value: "askForApproval", label: "Ask for approval" }, { value: "fullAccess", label: "Full access" }]} /></SettingsRow>
      <SettingsRow label="Reasoning"><SettingsSelect value={draft.defaultReasoningEffort} onValueChange={(value) => draft.setDefaultReasoningEffort(value ? readComposerReasoningEffort(value) : "")} disabled={readOnly || draft.saving} options={[{ value: "", label: "Use provider model preset" }, ...composerReasoningEffortOptions]} /></SettingsRow>
      <SettingsRow label="Speed"><SettingsSelect value={draft.defaultServiceTier} onValueChange={(value) => draft.setDefaultServiceTier(readComposerServiceTier(value))} disabled={readOnly || draft.saving} options={composerServiceTierOptions} /></SettingsRow>
    </SettingsGroup></fieldset></SettingsSection>
    <SettingsSection title="Account storage"><fieldset disabled={readOnly || draft.saving} className="settings-fieldset"><SettingsGroup><SettingsRow stacked label="Codex home" description="An isolated directory for this account's credentials and chat history."><Input className="font-mono" value={draft.codexHome} onChange={(event) => draft.setCodexHome(event.target.value)} /></SettingsRow></SettingsGroup></fieldset></SettingsSection>
    <details className="settings-advanced"><summary>Advanced configuration</summary><fieldset disabled={readOnly || draft.saving} className="settings-fieldset"><SettingsGroup><SettingsRow stacked label="Additional settings" description="Provider settings as a JSON object."><Textarea className="min-h-28 font-mono" value={draft.settingsJson} onChange={(event) => draft.setSettingsJson(event.target.value)} /></SettingsRow><SettingsRow stacked label="Additional runtime defaults" description="Extra chat runtime options as a JSON object."><Textarea className="min-h-28 font-mono" value={draft.runtimeDefaultsJson} onChange={(event) => draft.setRuntimeDefaultsJson(event.target.value)} /></SettingsRow></SettingsGroup></fieldset></details>
    {readOnly ? <p className="settings-note">Only an administrator can change this account.</p> : <div className="settings-save-bar"><Button variant="ghost" size="sm" className="text-destructive" disabled={draft.deleting || draft.saving || draft.authenticating} onClick={() => void draft.deleteProviderAccount()}>{draft.deleting ? "Removing…" : "Remove account"}</Button><Button size="sm" disabled={draft.saving || draft.deleting || draft.authenticating || !draft.displayName.trim()} onClick={() => void draft.saveConfig()}>{draft.saving && <LoaderCircle className="animate-spin" />}Save changes</Button></div>}
  </>;
}
