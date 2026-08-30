import { createContext, useContext, type ReactNode } from "react";
import type { BoostedApiClient } from "@/lib/api";

const ApiClientContext = createContext<BoostedApiClient | undefined>(undefined);

export function ApiClientProvider({ client, children }: { client: BoostedApiClient; children: ReactNode }) {
  return <ApiClientContext.Provider value={client}>{children}</ApiClientContext.Provider>;
}

export function useBoostedApiClient() {
  const client = useContext(ApiClientContext);
  if (!client) throw new Error("BoostedApiClient is unavailable outside a machine workspace.");
  return client;
}
