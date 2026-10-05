import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { LoaderCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SettingsGroup, SettingsRow, SettingsSection, SettingsSelect } from "@/components/settings-primitives";
import { api } from "@/lib/api";
import { apiClient, type ModelPreset, type ProviderAccountResponse, type ProviderDefinitionResponse, type ProviderModelOption, type ProviderModelPresets } from "./lib/api-client";
import { useProviderModels } from "./components/session/use-provider-models";

function PresetFields({ preset, models, disabled, onChange }: { preset: ModelPreset; models: ProviderModelOption[]; disabled: boolean; onChange(preset: ModelPreset): void }) {
  const selected = models.find((model) => model.model === preset.model);
  const modelOptions = models.filter((model) => !model.hidden).map((model) => ({ value: model.model, label: model.displayName }));
  if (preset.model && !modelOptions.some((option) => option.value === preset.model)) modelOptions.unshift({ value: preset.model, label: preset.model });
  const efforts = selected?.supportedReasoningEfforts?.map((option) => option.reasoningEffort) ?? ["low", "medium", "high", "xhigh", "max"];
  if (preset.reasoningEffort && !efforts.includes(preset.reasoningEffort)) efforts.push(preset.reasoningEffort);
  return <>
    <SettingsRow label="Preset model"><SettingsSelect value={preset.model} disabled={disabled} options={[{ value: "", label: "Automatic (provider default)" }, ...modelOptions]} onValueChange={(model) => onChange({ model, reasoningEffort: "" })} /></SettingsRow>
    <SettingsRow label="Preset reasoning"><SettingsSelect value={preset.reasoningEffort} disabled={disabled} options={[{ value: "", label: "Automatic (model default)" }, ...efforts.map((effort) => ({ value: effort, label: effort === "xhigh" ? "Extra high" : effort.charAt(0).toUpperCase() + effort.slice(1) }))]} onValueChange={(reasoningEffort) => onChange({ ...preset, reasoningEffort })} /></SettingsRow>
  </>;
}

function ProviderPreset({ provider, accounts, shared, override, disabled, onChange }: { provider: ProviderDefinitionResponse; accounts: ProviderAccountResponse[]; shared: ModelPreset; override?: ModelPreset; disabled: boolean; onChange(preset?: ModelPreset): void }) {
  const account = accounts.find((account) => account.providerId === provider.id && account.status === "CONNECTED") ?? null;
  const { modelOptions, modelsError, refreshModels } = useProviderModels(account, true);
  return <SettingsSection title={`${provider.label} model preset`} description="Applies to new chats unless the account or chat selects its own model.">
    <SettingsGroup>
      <SettingsRow label="Model preset"><SettingsSelect value={override ? "custom" : "default"} disabled={disabled} options={[{ value: "default", label: "Use default preset" }, { value: "custom", label: "Choose provider model" }]} onValueChange={(value) => { refreshModels(); onChange(value === "custom" ? { ...shared } : undefined); }} /></SettingsRow>
      {override && <PresetFields preset={override} models={modelOptions} disabled={disabled} onChange={onChange} />}
    </SettingsGroup>
    {override && !account && <p className="settings-note">Connect an account to load this provider's models.</p>}
    {override && modelsError && <p role="alert" className="settings-error">{modelsError}</p>}
  </SettingsSection>;
}

export function ModelPresetsSettings({ providers, accounts, readOnly }: { providers: ProviderDefinitionResponse[]; accounts: ProviderAccountResponse[]; readOnly: boolean }) {
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: ["provider-model-presets"], queryFn: apiClient.modelPresets.read });
  const [draft, setDraft] = useState<ProviderModelPresets>();
  const account = accounts.find((account) => account.status === "CONNECTED") ?? null;
  const { modelOptions, modelsError } = useProviderModels(account, true);
  const sharedModels = useQuery({ queryKey: ["codex-model-catalog"], queryFn: api.codexModelCatalog, enabled: !account });
  const models = account ? modelOptions : (sharedModels.data?.models.map((model) => ({ ...model, supportedReasoningEfforts: model.supportedReasoningEfforts.map((effort) => ({ reasoningEffort: effort.id })) })) ?? []);
  const save = useMutation({
    mutationFn: apiClient.modelPresets.update,
    onSuccess: async (presets) => {
      queryClient.setQueryData(["provider-model-presets"], presets);
      setDraft(undefined);
      await queryClient.invalidateQueries({ queryKey: ["codex-options"] });
    },
  });
  const value = draft ?? query.data;
  if (!value) return <SettingsSection title="Default model preset"><p role={query.error ? "alert" : undefined} className={query.error ? "settings-error" : "settings-note"}>{query.error?.message ?? "Loading model presets…"}</p></SettingsSection>;
  const disabled = readOnly || save.isPending;
  return <>
    <SettingsSection title="Default model preset" description="The shared model and reasoning settings for providers using the default preset.">
      <SettingsGroup><PresetFields preset={value.default} models={models} disabled={disabled} onChange={(preset) => { save.reset(); setDraft({ ...value, default: preset }); }} /></SettingsGroup>
      {(account ? modelsError : sharedModels.error) && <p className="settings-note">{account ? modelsError : sharedModels.error?.message}</p>}
    </SettingsSection>
    {providers.filter((provider) => provider.capabilities.includes("models")).map((provider) => <ProviderPreset key={provider.id} provider={provider} accounts={accounts} shared={value.default} override={value.providers[provider.id]} disabled={disabled} onChange={(preset) => {
      save.reset();
      const overrides = { ...value.providers };
      if (preset) overrides[provider.id] = preset;
      else delete overrides[provider.id];
      setDraft({ ...value, providers: overrides });
    }} />)}
    {save.error && <p role="alert" className="settings-error">{save.error.message}</p>}
    {save.isSuccess && <p role="status" className="settings-note">Model presets saved.</p>}
    {!readOnly && <div className="settings-save-bar"><Button size="sm" disabled={!draft || save.isPending} onClick={() => save.mutate(value)}>{save.isPending && <LoaderCircle className="animate-spin" />}Save model presets</Button></div>}
  </>;
}
