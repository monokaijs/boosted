import { useCallback, useEffect, useRef, useState } from "react"
import { apiClient, type ProviderAccountResponse, type ProviderModelListResponse } from "@/features/agents/lib/api-client"

const emptyModelOptions: ProviderModelListResponse["data"] = []

export function useProviderModels(account: ProviderAccountResponse | null, enabled: boolean) {
  const [catalog, setCatalog] = useState<{ accountId: string; data: ProviderModelListResponse["data"] } | null>(null)
  const [fetchState, setFetchState] = useState<{ accountId: string; loading: boolean; error: string | null } | null>(null)
  const accountId = account?.id
  const status = account?.status
  const refreshRef = useRef<(() => Promise<void>) | null>(null)
  const refreshModels = useCallback(() => { void refreshRef.current?.() }, [])

  useEffect(() => {
    if (!accountId || !enabled || status !== "CONNECTED") {
      return
    }
    let cancelled = false
    let loading = false
    const refresh = async () => {
      if (loading || cancelled) {
        return
      }
      loading = true
      setFetchState({ accountId, loading: true, error: null })
      try {
        const response = await apiClient.providerAccounts.models(accountId)
        if (!cancelled) {
          setCatalog({ accountId, data: response.data })
          setFetchState({ accountId, loading: false, error: null })
        }
      } catch (error) {
        // Keep the last fetched catalog for this account during temporary failures.
        if (!cancelled) {
          setFetchState({ accountId, loading: false, error: error instanceof Error ? error.message : "Couldn’t load models." })
        }
      } finally {
        loading = false
      }
    }
    const refreshVisible = () => {
      if (document.visibilityState === "visible") {
        void refresh()
      }
    }
    refreshRef.current = refresh
    void refresh()
    window.addEventListener("focus", refreshVisible)
    document.addEventListener("visibilitychange", refreshVisible)
    const interval = window.setInterval(refreshVisible, 5 * 60 * 1000)
    return () => {
      cancelled = true
      refreshRef.current = null
      window.clearInterval(interval)
      window.removeEventListener("focus", refreshVisible)
      document.removeEventListener("visibilitychange", refreshVisible)
    }
  }, [accountId, status, enabled])

  return {
    modelOptions: enabled && status === "CONNECTED" && catalog && catalog.accountId === accountId ? catalog.data : emptyModelOptions,
    modelsLoading: Boolean(enabled && status === "CONNECTED" && (fetchState?.accountId !== accountId || fetchState?.loading)),
    modelsError: enabled && status === "CONNECTED" && fetchState?.accountId === accountId ? fetchState?.error ?? null : null,
    refreshModels,
  }
}
