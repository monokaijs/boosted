import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { apiClient, type ProviderLimitsResponse } from "@/features/agents/lib/api-client"

type ProviderQuotaContextValue = {
  accountLimits: Record<string, ProviderLimitsResponse>
  accountErrors: Record<string, string>
  error: string | null
  isLoading: boolean
  refreshQuotas: () => Promise<void>
}

const ProviderQuotaContext = createContext<ProviderQuotaContextValue | null>(null)
const quotaReloadIntervalMs = 60_000

export function ProviderQuotaProvider({ children }: { children: ReactNode }) {
  const [accountLimits, setAccountLimits] = useState<Record<string, ProviderLimitsResponse>>({})
  const [accountErrors, setAccountErrors] = useState<Record<string, string>>({})
  const [error, setError] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const loadingRef = useRef(false)

  const refreshQuotas = useCallback(async () => {
    if (loadingRef.current) {
      return
    }
    loadingRef.current = true
    setIsLoading(true)
    try {
      const response = await apiClient.providerAccounts.limits()
      setAccountLimits(response.data)
      setAccountErrors(response.errors ?? {})
      setError(null)
    } catch (error) {
      setError(error instanceof Error ? error.message : "Unable to load usage.")
    } finally {
      loadingRef.current = false
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    let timeout: number | null = null

    const reload = async () => {
      await refreshQuotas()
      if (!cancelled) {
        timeout = window.setTimeout(reload, quotaReloadIntervalMs)
      }
    }

    timeout = window.setTimeout(reload, 0)
    return () => {
      cancelled = true
      if (timeout !== null) {
        window.clearTimeout(timeout)
      }
    }
  }, [refreshQuotas])

  const value = useMemo<ProviderQuotaContextValue>(
    () => ({ accountLimits, accountErrors, error, isLoading, refreshQuotas }),
    [accountLimits, accountErrors, error, isLoading, refreshQuotas],
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
