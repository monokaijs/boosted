import type { ProviderAccountResponse, ProviderDefinitionResponse, ProviderLimitsResponse, ProviderModelListResponse } from '../types/providers';
import type { ChatComposerAccessMode, ChatComposerReasoningEffort, ChatComposerServiceTier } from '../types/session';
export function relativeTimeLabel(value: string): string {
  const timestamp = new Date(value).getTime()
  if (Number.isNaN(timestamp)) {
    return ""
  }
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000))
  if (seconds < 60) {
    return "just now"
  }
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) {
    return `${minutes}m ago`
  }
  const hours = Math.floor(minutes / 60)
  if (hours < 24) {
    return `${hours}h ago`
  }
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

export function formatProviderQuota(limits: ProviderLimitsResponse | undefined): string | null {
  const rateLimits = limits?.rateLimits
  if (!rateLimits) {
    return null
  }

  const windows = [
    { fallbackLabel: "5H", window: rateLimits.primary },
    { fallbackLabel: "W", window: rateLimits.secondary },
  ]
    .filter((entry): entry is { fallbackLabel: string; window: NonNullable<typeof entry.window> } => Boolean(entry.window))
    .sort((first, second) => quotaSortMinutes(first) - quotaSortMinutes(second))
    .map(({ fallbackLabel, window }) => {
      const remainingPercent = clampPercent(100 - window.usedPercent)
      return `${quotaWindowLabel(window.windowDurationMins, fallbackLabel)}: ${Math.round(remainingPercent)}%`
    })

  return windows.length ? windows.join(" | ") : null
}

export function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

export function readError(error: unknown) {
  return error instanceof Error ? error.message : "Failed"
}

export function composerAccessModeValue(value: ChatComposerAccessMode): string {
  return value
}

export function composerReasoningEffortValue(value: ChatComposerReasoningEffort): string {
  return value === "extraHigh" ? "xhigh" : value
}

export function composerServiceTierValue(value: ChatComposerServiceTier): string {
  return value
}

export function defaultRuntimeDefaultValue(providerId: string | null | undefined, key: string): string {
  if (key === "permissionMode" && providerId === "codex") {
    return "askForApproval"
  }
  if (key === "reasoningEffort" && providerId === "codex") {
    return "medium"
  }
  if (providerId === "codex" && key === "serviceTier") {
    return "standard"
  }
  return ""
}

export function formatJson(value: unknown) {
  return JSON.stringify(value ?? {}, null, 2)
}

export function defaultProviderModelOption(options: ProviderModelListResponse["data"]): ProviderModelListResponse["data"][number] | null {
  return options.find((option) => !option.hidden && option.isDefault) ?? options.find((option) => !option.hidden) ?? null
}

export function parseJsonRecord(value: string, label: string): Record<string, unknown> {
  const parsed = JSON.parse(value || "{}") as unknown
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${label} must be a JSON object.`)
  }
  return parsed as Record<string, unknown>
}

export function readCodexHomeValue(account: ProviderAccountResponse, provider: ProviderDefinitionResponse): string {
  return readRecordString(account.settings, "codexHome") || readDefaultCodexHomeValue(account, provider)
}

export function readCodexPersonalityValue(value: unknown): "friendly" | "pragmatic" {
  return readRecordString(value, "personality") === "friendly" ? "friendly" : "pragmatic"
}

export function readComposerAccessMode(value: string | null | undefined): ChatComposerAccessMode {
  return value === "fullAccess" ? "fullAccess" : "askForApproval"
}

export function readComposerReasoningEffort(value: string | null | undefined): ChatComposerReasoningEffort {
  if (value === "fast") return "low"
  if (value === "deep") return "high"
  if (value === "extraHigh" || value === "extra-high" || value === "extra_high" || value === "xhigh") return "extraHigh"
  return value?.trim() || "medium"
}

export function readComposerServiceTier(value: string | null | undefined): ChatComposerServiceTier {
  return value === "fast" ? "fast" : "standard"
}

export function readDefaultCodexHomeValue(account: ProviderAccountResponse, provider: ProviderDefinitionResponse): string {
  const accountsHome = readRecordString(provider.defaultSettings, "accountsHome") || "~/.pockcode/providers/codex/accounts"
  return joinDisplayPath(accountsHome, account.id)
}

export function readSharedCodexHomeValue(provider: ProviderDefinitionResponse): string {
  return readRecordString(provider.defaultSettings, "sharedChatHome") || "~/.codex"
}

export function readRecordString(value: unknown, key: string): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return ""
  }
  const recordValue = (value as Record<string, unknown>)[key]
  return typeof recordValue === "string" ? recordValue : ""
}

export function withoutRecordKeys(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {}
  }
  const copy = { ...(value as Record<string, unknown>) }
  for (const key of keys) {
    delete copy[key]
  }
  return copy
}

export function accessModeLabel(value: ChatComposerAccessMode): string {
  return value === "fullAccess" ? "Full access" : "Ask for approval"
}

export function composerReasoningEffortLabel(value: ChatComposerReasoningEffort): string {
  if (value === "extraHigh") return "Extra High"
  return value.replace(/[-_]/gu, " ").replace(/\b\w/gu, (letter) => letter.toUpperCase())
}

export const composerReasoningEffortOptions: { label: string; value: ChatComposerReasoningEffort }[] = [
  { label: "None", value: "none" },
  { label: "Minimal", value: "minimal" },
  { label: "Low", value: "low" },
  { label: "Medium", value: "medium" },
  { label: "High", value: "high" },
  { label: "Extra High", value: "extraHigh" },
]

export function composerServiceTierLabel(value: ChatComposerServiceTier): string {
  if (value === "fast") {
    return "Fast"
  }
  return "Standard"
}

export const composerServiceTierOptions: { description: string; label: string; value: ChatComposerServiceTier }[] = [
  { description: "Default speed", label: "Standard", value: "standard" },
  { description: "1.5x speed, increased usage", label: "Fast", value: "fast" },
]

export function quotaSortMinutes(entry: {
  fallbackLabel: string
  window: NonNullable<NonNullable<ProviderLimitsResponse["rateLimits"]>["primary"]>
}): number {
  if (entry.window.windowDurationMins && Number.isFinite(entry.window.windowDurationMins)) {
    return entry.window.windowDurationMins
  }
  return entry.fallbackLabel === "5H" ? 5 * 60 : 7 * 24 * 60
}

export function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, Number.isFinite(value) ? value : 0))
}

export function quotaWindowLabel(windowDurationMins: number | null | undefined, fallbackLabel: string): string {
  if (!windowDurationMins || !Number.isFinite(windowDurationMins)) {
    return fallbackLabel
  }
  if (windowDurationMins >= 6 * 24 * 60) {
    return "W"
  }
  if (windowDurationMins >= 60) {
    return `${Math.round(windowDurationMins / 60)}H`
  }
  return `${Math.round(windowDurationMins)}M`
}

export function joinDisplayPath(parent: string, child: string): string {
  const trimmed = parent.trim()
  return trimmed.endsWith("/") ? `${trimmed}${child}` : `${trimmed}/${child}`
}
export function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error ?? new Error("Unable to read file."))
    reader.onload = () => resolve(String(reader.result ?? ""))
    reader.readAsDataURL(file)
  })
}

export function fileRelativePath(file: File): string | null {
  const path = (file as File & { webkitRelativePath?: string }).webkitRelativePath
  return path?.trim() || null
}

export function createClientId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`
}

