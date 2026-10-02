import { useEffect, useMemo, useRef, useState } from "react"
import {
  apiClient,
  type AuthenticateProviderAccountResponse,
  type ProviderAccountResponse,
  type ProviderDefinitionResponse,
} from "@/features/agents/lib/api-client"
import {
  composerAccessModeValue,
  composerReasoningEffortValue,
  composerServiceTierValue,
  defaultRuntimeDefaultValue,
  formatJson,
  defaultProviderModelOption,
  parseJsonRecord,
  readCodexHomeValue,
  readCodexPersonalityValue,
  readComposerAccessMode,
  readComposerReasoningEffort,
  readComposerServiceTier,
  readDefaultCodexHomeValue,
  readError,
  readRecord,
  readRecordString,
  readSharedCodexHomeValue,
  withoutRecordKeys,
} from "@/features/agents/lib/session"
import { useProviderModels } from "./use-provider-models"
import type { ChatComposerAccessMode, ChatComposerReasoningEffort, ChatComposerServiceTier } from "@/features/agents/types/session"

type ProviderAccountNotice = { details?: Record<string, unknown> | null; kind: "error" | "info"; text: string }

export function useProviderAccountDialogState(
  account: ProviderAccountResponse | null,
  provider: ProviderDefinitionResponse | null,
  onAccountChange: (account: ProviderAccountResponse) => void,
  onAccountDelete: (accountId: string) => void,
  onReload: () => Promise<void>,
) {
  const authAttemptRef = useRef(0)
  useEffect(() => {
    setAuthenticating(false)
    return () => { authAttemptRef.current += 1 }
  }, [account?.id])
  const [authenticating, setAuthenticating] = useState(false)
  const [codexHome, setCodexHome] = useState("")
  const [defaultModel, setDefaultModel] = useState("")
  const [defaultPermissionMode, setDefaultPermissionMode] = useState<ChatComposerAccessMode>("askForApproval")
  const [defaultReasoningEffort, setDefaultReasoningEffort] = useState<ChatComposerReasoningEffort>("medium")
  const [defaultServiceTier, setDefaultServiceTier] = useState<ChatComposerServiceTier>("standard")
  const [deleting, setDeleting] = useState(false)
  const [displayName, setDisplayName] = useState("")
  const [notice, setNotice] = useState<ProviderAccountNotice | null>(null)
  const [personality, setPersonality] = useState<"friendly" | "pragmatic">("pragmatic")
  const [runtimeDefaultsJson, setRuntimeDefaultsJson] = useState("{}")
  const [saving, setSaving] = useState(false)
  const [settingsJson, setSettingsJson] = useState("{}")
  const hasDefaultModelField = Boolean(provider?.capabilities.includes("models") && provider.runtimeFields.some((field) => field.key === "model"))
  const hasDefaultPermissionField = Boolean(provider?.runtimeFields.some((field) => field.key === "permissionMode"))
  const hasDefaultReasoningField = Boolean(provider?.runtimeFields.some((field) => field.key === "reasoningEffort"))
  const hasDefaultServiceTierField = Boolean(provider?.runtimeFields.some((field) => field.key === "serviceTier"))
  const runtimeDefaultStructuredKeys = useMemo(
    () => [
      hasDefaultModelField ? "model" : null,
      hasDefaultPermissionField ? "permissionMode" : null,
      hasDefaultReasoningField ? "reasoningEffort" : null,
      hasDefaultServiceTierField ? "serviceTier" : null,
    ].filter((key): key is string => Boolean(key)),
    [hasDefaultModelField, hasDefaultPermissionField, hasDefaultReasoningField, hasDefaultServiceTierField],
  )

  useEffect(() => {
    if (!account || !provider) {
      return
    }
    setCodexHome(readCodexHomeValue(account, provider))
    setDefaultModel(readRecordString(account.runtimeDefaults, "model") || defaultRuntimeDefaultValue(provider.id, "model"))
    setDefaultPermissionMode(readComposerAccessMode(readRecordString(account.runtimeDefaults, "permissionMode") || defaultRuntimeDefaultValue(provider.id, "permissionMode")))
    setDefaultReasoningEffort(readComposerReasoningEffort(readRecordString(account.runtimeDefaults, "reasoningEffort") || defaultRuntimeDefaultValue(provider.id, "reasoningEffort")))
    setDefaultServiceTier(readComposerServiceTier(readRecordString(account.runtimeDefaults, "serviceTier") || defaultRuntimeDefaultValue(provider.id, "serviceTier")))
    setDisplayName(account.displayName)
    setPersonality(readCodexPersonalityValue(account.settings))
    setRuntimeDefaultsJson(formatJson(withoutRecordKeys(account.runtimeDefaults, runtimeDefaultStructuredKeys)))
    setSettingsJson(formatJson(withoutRecordKeys(account.settings, ["codexHome", "personality"])))
    setNotice(readAccountErrorNotice(account))
  }, [account, provider, runtimeDefaultStructuredKeys])

  const { modelOptions, refreshModels } = useProviderModels(account, hasDefaultModelField)

  const defaultCodexHome = account && provider ? readDefaultCodexHomeValue(account, provider) : ""
  const sharedCodexHome = provider ? readSharedCodexHomeValue(provider) : ""

  function readConfigDraft() {
    if (!account || !provider) {
      throw new Error("No provider account selected.")
    }
    const settings = parseJsonRecord(settingsJson, "Settings") as ProviderAccountResponse["settings"]
    const runtimeDefaults = parseJsonRecord(runtimeDefaultsJson, "Runtime defaults") as ProviderAccountResponse["runtimeDefaults"]
    const codexHomePath = codexHome.trim()
    if (codexHomePath === "~/.codex" || codexHomePath === sharedCodexHome) {
      throw new Error(`Choose a separate Codex home for this account.`)
    }
    if (codexHomePath && codexHomePath !== defaultCodexHome) {
      settings.codexHome = codexHomePath
    } else {
      delete settings.codexHome
    }
    if (provider.id === "codex") {
      settings.personality = personality
    }
    if (hasDefaultModelField) {
      if (defaultModel) runtimeDefaults.model = defaultModel
      else delete runtimeDefaults.model
    }
    if (hasDefaultPermissionField) {
      runtimeDefaults.permissionMode = composerAccessModeValue(defaultPermissionMode)
    }
    if (hasDefaultReasoningField) {
      runtimeDefaults.reasoningEffort = composerReasoningEffortValue(defaultReasoningEffort)
    }
    if (hasDefaultServiceTierField) {
      runtimeDefaults.serviceTier = composerServiceTierValue(defaultServiceTier)
    }
    return { displayName, runtimeDefaults, settings }
  }

  async function saveDraftConfig() {
    if (!account) {
      throw new Error("No provider account selected.")
    }
    const updated = await apiClient.providerAccounts.update(account.id, readConfigDraft())
    onAccountChange(updated)
    return updated
  }

  async function authenticate() {
    const attempt = ++authAttemptRef.current
    setAuthenticating(true)
    setNotice(null)
    try {
      const updated = await saveDraftConfig()
      const response = await apiClient.providerAccounts.authenticate(updated.id)
      if (authAttemptRef.current !== attempt) return
      onAccountChange(accountFromAuthResponse(updated, response))
      if (response.authUrl) {
        window.open(response.authUrl, "_blank", "noopener,noreferrer")
      }
      if (response.status === "ERROR") {
        const failedAccount = accountFromAuthResponse(updated, response)
        setNotice(readAccountErrorNotice(failedAccount, response.message ?? "Authentication failed."))
        return
      }
      setNotice({ kind: "info", text: response.message ?? "Authentication started." })
    } catch (error) {
      if (authAttemptRef.current === attempt) setNotice({ kind: "error", text: readError(error) })
    } finally {
      if (authAttemptRef.current === attempt) setAuthenticating(false)
    }
  }

  useEffect(() => {
    if (!account || account.status !== "AUTHENTICATING") return
    let cancelled = false
    let loading = false
    const poll = async () => {
      if (cancelled || loading || document.visibilityState !== "visible") return
      loading = true
      try {
        const refreshed = await apiClient.providerAccounts.get(account.id)
        if (cancelled || refreshed.status === "AUTHENTICATING") return
        onAccountChange(refreshed)
        if (refreshed.status === "CONNECTED") {
          setNotice({ kind: "info", text: "Connected" })
          await onReload()
        } else if (refreshed.status === "ERROR") {
          setNotice(readAccountErrorNotice(refreshed, "Authentication failed."))
        }
      } catch (error) {
        if (!cancelled) setNotice({ kind: "error", text: readError(error) })
      } finally {
        loading = false
      }
    }
    const interval = window.setInterval(() => { void poll() }, 2000)
    return () => {
      cancelled = true
      window.clearInterval(interval)
    }
  }, [account?.id, account?.status])

  async function saveConfig() {
    if (!account) {
      return
    }
    setSaving(true)
    setNotice(null)
    try {
      const updated = await apiClient.providerAccounts.update(account.id, {
        ...readConfigDraft(),
      })
      onAccountChange(updated)
      setNotice({ kind: "info", text: "Saved" })
    } catch (error) {
      setNotice({ kind: "error", text: readError(error) })
    } finally {
      setSaving(false)
    }
  }

  async function deleteProviderAccount() {
    if (!account) {
      return
    }
    if (!window.confirm("Delete provider account?")) {
      return
    }
    setDeleting(true)
    setNotice(null)
    try {
      await apiClient.providerAccounts.delete(account.id)
      onAccountDelete(account.id)
    } catch (error) {
      setNotice({ kind: "error", text: readError(error) })
    } finally {
      setDeleting(false)
    }
  }

  const connected = account?.status === "CONNECTED"
  const hasCodexHomeField = Boolean(provider?.accountFields.some((field) => field.key === "codexHome"))
  const visibleModelOptions = modelOptions.filter((option) => !option.hidden)
  const selectedDefaultModelOption = visibleModelOptions.find((option) => option.model === defaultModel || option.id === defaultModel) ?? defaultProviderModelOption(visibleModelOptions)

  return {
    deviceLogin: account?.status === "AUTHENTICATING" && account.lastAuthMode === "device" && account.lastAuthUrl && account.lastAuthUserCode
      ? { verificationUrl: account.lastAuthUrl, userCode: account.lastAuthUserCode }
      : null,
    refreshModels,
    authenticating,
    authenticate,
    codexHome,
    connected,
    defaultModel,
    defaultPermissionMode,
    defaultReasoningEffort,
    defaultServiceTier,
    deleteProviderAccount,
    deleting,
    displayName,
    hasCodexHomeField,
    hasDefaultModelField,
    hasDefaultPermissionField,
    hasDefaultReasoningField,
    hasDefaultServiceTierField,
    modelOptions: visibleModelOptions,
    notice,
    personality,
    runtimeDefaultsJson,
    saveConfig,
    saving,
    setCodexHome,
    setDefaultModel,
    setDefaultPermissionMode,
    setDefaultReasoningEffort,
    setDefaultServiceTier,
    setDisplayName,
    setPersonality,
    setRuntimeDefaultsJson,
    setSettingsJson,
    selectedDefaultModelOption,
    settingsJson,
  }
}

export type ProviderAccountDialogState = ReturnType<typeof useProviderAccountDialogState>

function readAccountErrorNotice(
  account: ProviderAccountResponse | null | undefined,
  fallback = "Authentication failed.",
): ProviderAccountNotice | null {
  if (!account || account.status !== "ERROR") {
    return null
  }
  return {
    details: readAuthDiagnostics(account.authState),
    kind: "error",
    text: account.lastError || fallback,
  }
}

function readAuthDiagnostics(authState: unknown): Record<string, unknown> | null {
  const diagnostics = readRecord(readRecord(authState).authDiagnostics)
  return Object.keys(diagnostics).length ? diagnostics : null
}

function accountFromAuthResponse(
  account: ProviderAccountResponse,
  response: AuthenticateProviderAccountResponse,
): ProviderAccountResponse {
  return {
    ...account,
    authState: response.authState ?? account.authState,
    lastAuthLoginId: response.loginId ?? null,
    lastAuthMode: response.authMode ?? null,
    lastAuthUrl: response.authUrl ?? null,
    lastAuthUserCode: response.userCode ?? null,
    lastError: response.status === "ERROR" ? response.message ?? "Authentication failed." : null,
    status: response.status,
  }
}
