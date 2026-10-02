import { Plus, RefreshCw, Wrench, X } from "lucide-react"
import { useEffect, useState } from "react"
import { ProviderGlyph, ProviderMark, ProviderStatusBadge } from "@/features/agents/components/session/provider-icons"
import { useProviderQuotas } from "@/features/agents/components/session/provider-quota-context"
import { apiClient, type ProviderAccountResponse, type ProviderDefinitionResponse } from "@/features/agents/lib/api-client"
import { formatProviderQuota, readError } from "@/features/agents/lib/session"
import { cn } from "@/lib/utils"
import { ProviderAccountDialog } from "@/features/agents/components/session/provider-account-dialog"

export function ProvidersManagementDialog({
  open,
  onClose,
  onProviderDataChange,
  readOnly = false,
}: {
  open: boolean
  readOnly?: boolean
  onClose: () => void
  onProviderDataChange: (providers: ProviderDefinitionResponse[], accounts: ProviderAccountResponse[]) => void
}) {
  const [accounts, setAccounts] = useState<ProviderAccountResponse[]>([])
  const [accountDialogId, setAccountDialogId] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [providers, setProviders] = useState<ProviderDefinitionResponse[]>([])
  const { accountLimits } = useProviderQuotas()
  const selectedAccount = accounts.find((account) => account.id === accountDialogId) ?? null
  const selectedProvider = selectedAccount
    ? providers.find((provider) => provider.id === selectedAccount.providerId) ?? null
    : null

  const loadProviderData = async () => {
    setIsLoading(true)
    setLoadError(null)
    try {
      const [nextProviders, nextAccounts] = await Promise.all([
        apiClient.providers.list(),
        apiClient.providerAccounts.list(),
      ])
      setProviders(nextProviders)
      setAccounts(nextAccounts)
      onProviderDataChange(nextProviders, nextAccounts)
    } catch (error) {
      setLoadError(readError(error))
    } finally {
      setIsLoading(false)
    }
  }

  useEffect(() => {
    if (open) {
      void loadProviderData()
    }
  }, [open])

  const createAccount = async (providerId: string) => {
    setLoadError(null)
    try {
      const account = await apiClient.providerAccounts.create({ providerId })
      const nextAccounts = [...accounts, account]
      setAccounts(nextAccounts)
      onProviderDataChange(providers, nextAccounts)
      setAccountDialogId(account.id)
    } catch (error) {
      setLoadError(readError(error))
    }
  }

  const updateAccount = (account: ProviderAccountResponse) => {
    const nextAccounts = accounts.map((entry) => entry.id === account.id ? account : entry)
    setAccounts(nextAccounts)
    onProviderDataChange(providers, nextAccounts)
  }

  const removeAccount = (accountId: string) => {
    const nextAccounts = accounts.filter((entry) => entry.id !== accountId)
    setAccounts(nextAccounts)
    onProviderDataChange(providers, nextAccounts)
    setAccountDialogId(null)
  }

  if (!open) {
    return null
  }

  return (
    <div className="safe-area-overlay fixed inset-0 z-50 grid place-items-center bg-black/65 p-4" role="dialog" aria-modal="true">
      <button aria-label="Close providers" className="absolute inset-0 cursor-default" type="button" onClick={onClose} />
      <section className="relative grid max-h-[82vh] min-h-72 w-full max-w-lg grid-rows-[auto_minmax(0,1fr)] overflow-hidden rounded-lg border border-border bg-card shadow-2xl">
        <header className="flex h-11 min-w-0 items-center gap-2 border-b border-border px-3">
          <ProviderMark icon={providers[0]?.icon ?? "codex"} className="size-4 shrink-0 text-info" />
          <h1 className="min-w-0 flex-1 truncate text-[13px] font-semibold text-foreground">Providers</h1>
          <button
            disabled={readOnly}
            aria-label="Add provider account"
            className="grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
            title="Add"
            type="button"
            onClick={() => void createAccount("codex")}
          >
            <Plus className="size-4" />
          </button>
          <button
            aria-label="Refresh providers"
            className="grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
            title="Refresh"
            type="button"
            onClick={() => void loadProviderData()}
          >
            <RefreshCw className={cn("size-4", isLoading && "animate-spin")} />
          </button>
          <button
            aria-label="Close providers"
            className="grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
            type="button"
            onClick={onClose}
          >
            <X className="size-4" />
          </button>
        </header>

        <div className="min-h-0 overflow-auto p-3 ide-scrollbar">
          {loadError ? (
            <div className="mb-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-[12px] text-destructive">
              {loadError}
            </div>
          ) : null}

          {isLoading ? (
            <div className="grid h-full min-h-44 place-items-center text-[13px] text-muted-foreground">Loading</div>
          ) : accounts.length ? (
            <div className="space-y-1.5">
              {accounts.map((account) => {
                const provider = providers.find((entry) => entry.id === account.providerId)
                const quota = formatProviderQuota(accountLimits[account.id])
                return (
                  <button
                    className="grid w-full grid-cols-[auto_minmax(0,1fr)_auto_auto] items-center gap-2 rounded-md px-2 py-2 text-left hover:bg-accent"
                    key={account.id}
                    type="button"
                    onClick={() => setAccountDialogId(account.id)}
                  >
                    <ProviderGlyph icon={provider?.icon ?? "bot"} />
                    <span className="min-w-0">
                      <span className="block truncate text-[13px] font-medium text-foreground">{account.displayName}</span>
                      <span className="block truncate text-[11px] text-muted-foreground">
                        {provider?.label ?? account.providerId}
                        {quota ? ` · ${quota}` : ""}
                      </span>
                      {account.status === "ERROR" && account.lastError ? (
                        <span className="block truncate text-[11px] text-destructive" title={account.lastError}>{account.lastError}</span>
                      ) : null}
                    </span>
                    <ProviderStatusBadge status={account.status} />
                    <Wrench className="size-4 text-muted-foreground" />
                  </button>
                )
              })}
            </div>
          ) : (
            <div className="grid h-full min-h-44 place-items-center text-[13px] text-muted-foreground">No accounts</div>
          )}
        </div>
      </section>

      <ProviderAccountDialog
        readOnly={readOnly}
        account={selectedAccount}
        provider={selectedProvider}
        onAccountChange={updateAccount}
        onAccountDelete={removeAccount}
        onClose={() => setAccountDialogId(null)}
        onReload={loadProviderData}
      />
    </div>
  )
}
