import { createContext, useCallback, useContext, useMemo, type ReactNode } from "react"
import { useQuery } from "@tanstack/react-query"
import { apiClient, type ProviderLimitsResponse } from "@/features/agents/lib/api-client"
import { useAppStore } from "@/lib/store"
import { machineScopedKey } from "@/lib/machines"

type ProviderQuotaContextValue = {
  accountLimits: Record<string, ProviderLimitsResponse>
  accountErrors: Record<string, string>
  error: string | null
  history: ProviderQuotaHistoryPoint[]
  isLoading: boolean
  updatedAt: number | null
  refreshQuotas: () => Promise<void>
}

const ProviderQuotaContext = createContext<ProviderQuotaContextValue | null>(null)
const quotaReloadIntervalMs = 60_000
const quotaCacheMaxAgeMs = 24 * 60 * 60_000
const quotaHistorySampleMs = 5 * 60_000
const quotaCacheName = "boosted.providerQuotas"

export type ProviderQuotaHistoryPoint = {
  capturedAt: number
  data: Record<string, ProviderLimitsResponse>
}

type CachedQuotas = {
  history: ProviderQuotaHistoryPoint[]
  savedAt: number
  value: Awaited<ReturnType<typeof apiClient.providerAccounts.limits>>
  version: 1
}

function readCachedQuotas(machineId: string): CachedQuotas | undefined {
  try {
    const parsed = JSON.parse(localStorage.getItem(machineScopedKey(machineId, quotaCacheName)) ?? "null") as Partial<CachedQuotas> | null
    if (parsed?.version !== 1 || typeof parsed.savedAt !== "number" || Date.now() - parsed.savedAt > quotaCacheMaxAgeMs || !parsed.value?.data) return undefined
    const history = Array.isArray(parsed.history)
      ? parsed.history.filter((point): point is ProviderQuotaHistoryPoint => Boolean(point && typeof point.capturedAt === "number" && point.data && typeof point.data === "object"))
      : [{ capturedAt: parsed.savedAt, data: parsed.value.data }]
    return { ...(parsed as CachedQuotas), history }
  } catch {
    return undefined
  }
}

function writeCachedQuotas(machineId: string, value: CachedQuotas["value"]): CachedQuotas {
  const savedAt = Date.now()
  const previous = readCachedQuotas(machineId)
  const history = (previous?.history ?? []).filter((point) => savedAt - point.capturedAt <= quotaCacheMaxAgeMs)
  const nextPoint = { capturedAt: savedAt, data: value.data }
  if (history.length && savedAt - history[history.length - 1].capturedAt < quotaHistorySampleMs) history[history.length - 1] = nextPoint
  else history.push(nextPoint)
  const cached = { version: 1, savedAt, value, history } satisfies CachedQuotas
  try {
    localStorage.setItem(machineScopedKey(machineId, quotaCacheName), JSON.stringify(cached))
  } catch {
    // In-memory query caching still works when persistent storage is unavailable.
  }
  return cached
}

export function ProviderQuotaProvider({ children }: { children: ReactNode }) {
  const machineId = useAppStore((state) => state.activeMachineId) ?? "default"
  const cached = useMemo(() => readCachedQuotas(machineId), [machineId])
  const quotas = useQuery({
    queryKey: ["provider-account-limits", machineId],
    queryFn: async () => {
      const value = await apiClient.providerAccounts.limits()
      return writeCachedQuotas(machineId, value)
    },
    initialData: cached,
    initialDataUpdatedAt: cached?.savedAt,
    staleTime: quotaReloadIntervalMs,
    gcTime: quotaCacheMaxAgeMs,
    refetchInterval: quotaReloadIntervalMs,
  })

  const refreshQuotas = useCallback(async () => {
    await quotas.refetch({ cancelRefetch: false })
  }, [quotas])

  const value = useMemo<ProviderQuotaContextValue>(
    () => ({
      accountLimits: quotas.data?.value.data ?? {},
      accountErrors: quotas.data?.value.errors ?? {},
      error: quotas.error instanceof Error ? quotas.error.message : quotas.error ? "Unable to load usage." : null,
      history: quotas.data?.history ?? [],
      isLoading: quotas.isFetching,
      updatedAt: quotas.data?.savedAt ?? null,
      refreshQuotas,
    }),
    [quotas.data, quotas.error, quotas.isFetching, refreshQuotas],
  )

  return <ProviderQuotaContext.Provider value={value}>{children}</ProviderQuotaContext.Provider>
}

export function useProviderQuotas(): ProviderQuotaContextValue {
  const value = useContext(ProviderQuotaContext)
  if (!value) {
    throw new Error("useProviderQuotas must be used within ProviderQuotaProvider.")
  }
  return value
}
