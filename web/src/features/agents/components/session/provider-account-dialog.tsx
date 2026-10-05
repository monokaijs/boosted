import { ExternalLink, MonitorCog, X } from "lucide-react"
import { ProviderGlyph, ProviderStatusBadge } from "@/features/agents/components/session/provider-icons"
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/features/agents/components/ui/select"
import type { ProviderAccountResponse, ProviderDefinitionResponse } from "@/features/agents/lib/api-client"
import {
  accessModeLabel,
  composerReasoningEffortLabel,
  composerReasoningEffortOptions,
  composerServiceTierLabel,
  composerServiceTierOptions,
  readComposerAccessMode,
  readComposerReasoningEffort,
  readComposerServiceTier,
} from "@/features/agents/lib/session"
import { cn } from "@/lib/utils"
import { useProviderAccountDialogState, type ProviderAccountDialogState } from "@/features/agents/components/session/provider-account-dialog-state"

export function ProviderAccountDialog({
  account,
  provider,
  onAccountChange,
  onAccountDelete,
  onClose,
  onReload,
  readOnly = false,
}: {
  readOnly?: boolean
  account: ProviderAccountResponse | null
  provider: ProviderDefinitionResponse | null
  onAccountChange: (account: ProviderAccountResponse) => void
  onAccountDelete: (accountId: string) => void
  onClose: () => void
  onReload: () => Promise<void>
}) {
  const dialog = useProviderAccountDialogState(account, provider, onAccountChange, onAccountDelete, onReload)

  if (!account || !provider) {
    return null
  }

  return (
    <div className="safe-area-overlay fixed inset-0 z-[70] grid place-items-center bg-black/55 p-4" role="dialog" aria-modal="true">
      <button aria-label="Close provider account" className="absolute inset-0 cursor-default" type="button" onClick={onClose} />
      <section className="relative grid max-h-[84vh] w-full max-w-lg grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden rounded-lg border border-border bg-card shadow-2xl">
        <ProviderAccountDialogHeader account={account} provider={provider} onClose={onClose} />
        <fieldset disabled={readOnly} className="min-h-0 overflow-auto border-0 p-0"><ProviderAccountDialogBody dialog={dialog} provider={provider} /></fieldset>
        <ProviderAccountDialogFooter deleting={readOnly || dialog.deleting} saving={readOnly || dialog.saving} onClose={onClose} onDelete={dialog.deleteProviderAccount} onSave={dialog.saveConfig} />
      </section>
    </div>
  )
}

function ProviderAccountDialogHeader({
  account,
  provider,
  onClose,
}: {
  account: ProviderAccountResponse
  provider: ProviderDefinitionResponse
  onClose: () => void
}) {
  return (
    <header className="flex h-11 min-w-0 items-center gap-2 border-b border-border px-3">
      <ProviderGlyph icon={provider.icon} />
      <h2 className="min-w-0 flex-1 truncate text-[13px] font-semibold text-foreground">{provider.label}</h2>
      <ProviderStatusBadge status={account.status} />
      <button
        aria-label="Close provider account"
        className="grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
        type="button"
        onClick={onClose}
      >
        <X className="size-4" />
      </button>
    </header>
  )
}

function ProviderAccountDialogBody({
  dialog,
  provider,
}: {
  dialog: ProviderAccountDialogState
  provider: ProviderDefinitionResponse
}) {
  return (
    <div className="min-h-0 overflow-auto p-3 ide-scrollbar">
      <ProviderAccountNotice notice={dialog.notice} />
      {dialog.deviceLogin ? (
        <div className="mb-3 grid gap-2 rounded-md border border-border bg-background p-3 text-[12px]">
          <span>Enter this code to connect your Codex account:</span>
          <code className="select-all font-mono text-lg font-semibold tracking-widest">{dialog.deviceLogin.userCode}</code>
          <a className="flex items-center gap-1 text-info hover:underline" href={dialog.deviceLogin.verificationUrl} target="_blank" rel="noopener noreferrer">
            Open device sign-in <ExternalLink className="size-3" />
          </a>
        </div>
      ) : null}
      <div className="space-y-3">
        <ProviderAccountNameAuth dialog={dialog} />
        {provider.id === "codex" ? <ProviderPersonalityField dialog={dialog} /> : null}
        {dialog.hasCodexHomeField ? <ProviderCodexHomeField dialog={dialog} /> : null}
        {dialog.hasDefaultModelField || dialog.hasDefaultPermissionField || dialog.hasDefaultReasoningField || dialog.hasDefaultServiceTierField
          ? <ProviderRuntimeDefaultsField dialog={dialog} />
          : null}
        <ProviderConfigEditors dialog={dialog} />
      </div>
    </div>
  )
}

function ProviderAccountNotice({ notice }: { notice: ProviderAccountDialogState["notice"] }) {
  if (!notice) {
    return null
  }
  return (
    <div
      className={cn(
        "mb-3 rounded-md border px-3 py-2 text-[12px]",
        notice.kind === "error"
          ? "border-destructive/30 bg-destructive/10 text-destructive"
          : "border-info/20 bg-info/10 text-info",
      )}
    >
      {notice.text}
      {notice.details ? (
        <details className="mt-2">
          <summary className="cursor-pointer select-none text-[11px] font-medium">Details</summary>
          <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded border border-current/15 bg-background/55 p-2 font-mono text-[11px] leading-relaxed">
            {JSON.stringify(notice.details, null, 2)}
          </pre>
        </details>
      ) : null}
    </div>
  )
}

function ProviderAccountNameAuth({ dialog }: { dialog: ProviderAccountDialogState }) {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto] items-end gap-2">
      <label className="block">
        <span className="mb-1 block text-[11px] font-medium text-muted-foreground">Name</span>
        <input
          className="h-8 w-full rounded-md border border-input bg-background px-2 text-[13px] text-foreground outline-none focus:border-primary"
          value={dialog.displayName}
          onChange={(event) => dialog.setDisplayName(event.target.value)}
        />
      </label>
      <ProviderAccountAuthButton dialog={dialog} />
    </div>
  )
}

function ProviderAccountAuthButton({ dialog }: { dialog: ProviderAccountDialogState }) {
  return (
    <button
      className="flex h-8 items-center gap-1.5 rounded-md border border-border px-2.5 text-[12px] font-medium text-foreground hover:bg-accent disabled:cursor-not-allowed disabled:opacity-55"
      disabled={dialog.authenticating}
      type="button"
      onClick={() => void dialog.authenticate()}
    >
      <MonitorCog className="size-3.5" />
      <span className="whitespace-nowrap">
        {dialog.authenticating ? "Authenticating" : dialog.connected ? "Re-authenticate" : "Sign in with device code"}
      </span>
    </button>
  )
}

function ProviderPersonalityField({ dialog }: { dialog: ProviderAccountDialogState }) {
  return (
    <div>
      <span className="mb-1 block text-[11px] font-medium text-muted-foreground">Personality</span>
      <div className="inline-flex rounded-md border border-input bg-background p-0.5">
        {(["pragmatic", "friendly"] as const).map((option) => (
          <button
            className={cn(
              "h-7 rounded px-2.5 text-[12px] font-medium",
              dialog.personality === option
                ? "bg-primary/20 text-foreground"
                : "text-muted-foreground hover:bg-accent hover:text-foreground",
            )}
            key={option}
            type="button"
            onClick={() => dialog.setPersonality(option)}
          >
            {option === "pragmatic" ? "Pragmatic" : "Friendly"}
          </button>
        ))}
      </div>
    </div>
  )
}

function ProviderCodexHomeField({ dialog }: { dialog: ProviderAccountDialogState }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] font-medium text-muted-foreground">Codex home</span>
      <input
        className="h-8 w-full rounded-md border border-input bg-background px-2 font-mono text-[12px] text-foreground outline-none focus:border-primary disabled:opacity-65"
        value={dialog.codexHome}
        onChange={(event) => dialog.setCodexHome(event.target.value)}
      />
    </label>
  )
}

function ProviderRuntimeDefaultsField({ dialog }: { dialog: ProviderAccountDialogState }) {
  const hasExactDefaultModel = dialog.modelOptions.some((option) => option.model === dialog.defaultModel || option.id === dialog.defaultModel)
  const modelOptions = dialog.defaultModel && !hasExactDefaultModel
    ? [
        {
          id: dialog.defaultModel,
          model: dialog.defaultModel,
          displayName: dialog.defaultModel,
        },
        ...dialog.modelOptions,
      ]
    : dialog.modelOptions

  return (
    <div className="grid gap-2">
      <span className="block text-[11px] font-medium text-muted-foreground">Defaults</span>
      <div className="grid gap-2 sm:grid-cols-2">
        {dialog.hasDefaultModelField ? (
          <label className="block min-w-0">
            <span className="mb-1 block text-[11px] text-muted-foreground">Model</span>
            <Select className="w-full min-w-0" value={dialog.defaultModel} onValueChange={dialog.setDefaultModel} onOpenChange={(open) => { if (open) dialog.refreshModels() }}>
              <SelectTrigger aria-label="Default model" className="h-8 w-full border-input bg-background px-2 text-[12px] text-foreground shadow-none hover:bg-secondary/60">
                <span className="min-w-0 truncate">
                  {!dialog.defaultModel
                    ? "Use provider model preset"
                    : hasExactDefaultModel
                    ? dialog.selectedDefaultModelOption?.displayName ?? dialog.defaultModel
                    : dialog.defaultModel}
                </span>
              </SelectTrigger>
              <SelectContent align="start" className="max-h-72 border-border bg-popover text-foreground">
                <SelectItem className="text-[12px] hover:bg-accent focus-visible:bg-accent" value="">Use provider model preset</SelectItem>
                {modelOptions.map((option) => (
                  <SelectItem className="text-[12px] hover:bg-accent focus-visible:bg-accent" key={option.id} value={option.model}>
                    {option.displayName}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
        ) : null}
        {dialog.hasDefaultPermissionField ? (
          <label className="block min-w-0">
            <span className="mb-1 block text-[11px] text-muted-foreground">Access</span>
            <Select className="w-full min-w-0" value={dialog.defaultPermissionMode} onValueChange={(value) => dialog.setDefaultPermissionMode(readComposerAccessMode(value))}>
              <SelectTrigger aria-label="Default access" className="h-8 w-full border-input bg-background px-2 text-[12px] text-foreground shadow-none hover:bg-secondary/60">
                <span className="min-w-0 truncate">{accessModeLabel(dialog.defaultPermissionMode)}</span>
              </SelectTrigger>
              <SelectContent align="start" className="border-border bg-popover text-foreground">
                <SelectItem className="text-[12px] hover:bg-accent focus-visible:bg-accent" value="askForApproval">
                  Ask for approval
                </SelectItem>
                <SelectItem className="text-[12px] hover:bg-accent focus-visible:bg-accent" value="fullAccess">
                  Full access
                </SelectItem>
              </SelectContent>
            </Select>
          </label>
        ) : null}
        {dialog.hasDefaultReasoningField ? (
          <label className="block min-w-0">
            <span className="mb-1 block text-[11px] text-muted-foreground">Reasoning</span>
            <Select className="w-full min-w-0" value={dialog.defaultReasoningEffort} onValueChange={(value) => dialog.setDefaultReasoningEffort(value ? readComposerReasoningEffort(value) : "")}>
              <SelectTrigger aria-label="Default reasoning" className="h-8 w-full border-input bg-background px-2 text-[12px] text-foreground shadow-none hover:bg-secondary/60">
                <span className="min-w-0 truncate">{dialog.defaultReasoningEffort ? composerReasoningEffortLabel(dialog.defaultReasoningEffort) : "Use provider model preset"}</span>
              </SelectTrigger>
              <SelectContent align="start" className="border-border bg-popover text-foreground">
                <SelectItem className="text-[12px] hover:bg-accent focus-visible:bg-accent" value="">Use provider model preset</SelectItem>
                {composerReasoningEffortOptions.map((option) => (
                  <SelectItem className="text-[12px] hover:bg-accent focus-visible:bg-accent" key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
        ) : null}
        {dialog.hasDefaultServiceTierField ? (
          <label className="block min-w-0">
            <span className="mb-1 block text-[11px] text-muted-foreground">Speed</span>
            <Select className="w-full min-w-0" value={dialog.defaultServiceTier} onValueChange={(value) => dialog.setDefaultServiceTier(readComposerServiceTier(value))}>
              <SelectTrigger aria-label="Default speed" className="h-8 w-full border-input bg-background px-2 text-[12px] text-foreground shadow-none hover:bg-secondary/60">
                <span className="min-w-0 truncate">{composerServiceTierLabel(dialog.defaultServiceTier)}</span>
              </SelectTrigger>
              <SelectContent align="start" className="border-border bg-popover text-foreground">
                {composerServiceTierOptions.map((option) => (
                  <SelectItem className="text-[12px] hover:bg-accent focus-visible:bg-accent" key={option.value} value={option.value}>
                    <span className="grid min-w-0">
                      <span className="truncate">{option.label}</span>
                      <span className="truncate text-[11px] font-normal text-muted-foreground">{option.description}</span>
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
        ) : null}
      </div>
    </div>
  )
}

function ProviderConfigEditors({ dialog }: { dialog: ProviderAccountDialogState }) {
  return (
    <div className="grid gap-3">
      <label className="block">
        <span className="mb-1 block text-[11px] font-medium text-muted-foreground">Settings</span>
        <textarea
          className="h-28 w-full resize-none rounded-md border border-input bg-background px-2 py-2 font-mono text-[12px] text-foreground outline-none focus:border-primary"
          spellCheck={false}
          value={dialog.settingsJson}
          onChange={(event) => dialog.setSettingsJson(event.target.value)}
        />
      </label>
      <label className="block">
        <span className="mb-1 block text-[11px] font-medium text-muted-foreground">Runtime defaults</span>
        <textarea
          className="h-28 w-full resize-none rounded-md border border-input bg-background px-2 py-2 font-mono text-[12px] text-foreground outline-none focus:border-primary"
          spellCheck={false}
          value={dialog.runtimeDefaultsJson}
          onChange={(event) => dialog.setRuntimeDefaultsJson(event.target.value)}
        />
      </label>
    </div>
  )
}

function ProviderAccountDialogFooter({
  deleting,
  saving,
  onClose,
  onDelete,
  onSave,
}: {
  deleting: boolean
  saving: boolean
  onClose: () => void
  onDelete: () => Promise<void>
  onSave: () => Promise<void>
}) {
  return (
    <footer className="flex h-11 items-center justify-between gap-2 border-t border-border px-3">
      <button
        className="h-8 rounded-md border border-destructive/30 px-3 text-[12px] font-medium text-destructive hover:bg-destructive/10 disabled:cursor-not-allowed disabled:opacity-55"
        disabled={deleting}
        type="button"
        onClick={() => void onDelete()}
      >
        {deleting ? "Deleting" : "Delete"}
      </button>
      <div className="flex items-center justify-end gap-2">
        <button
          className="h-8 rounded-md border border-border px-3 text-[12px] font-medium text-foreground hover:bg-accent"
          type="button"
          onClick={onClose}
        >
          Close
        </button>
        <button
          className="h-8 rounded-md bg-primary px-3 text-[12px] font-semibold text-primary-foreground disabled:cursor-not-allowed disabled:opacity-45"
          disabled={saving}
          type="button"
          onClick={() => void onSave()}
        >
          {saving ? "Saving" : "Save"}
        </button>
      </div>
    </footer>
  )
}
