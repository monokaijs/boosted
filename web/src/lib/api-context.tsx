import { createContext, useContext, useEffect, useRef, type ReactNode } from "react";
import type { BoostedApiClient } from "@/lib/api";

const ApiClientContext = createContext<BoostedApiClient | undefined>(undefined);

export function ApiClientProvider({ client, children }: { client: BoostedApiClient; children: ReactNode }) {
  const disposal = useRef<{ client: BoostedApiClient; timer: ReturnType<typeof setTimeout> } | undefined>(undefined);
  useEffect(() => {
    if (disposal.current?.client === client) {
      clearTimeout(disposal.current.timer);
      disposal.current = undefined;
    }
    return () => {
      // StrictMode immediately replays effects. Allow that replay to retain the
      // client, while still cancelling requests after a real unmount or switch.
      disposal.current = { client, timer: setTimeout(() => client.cancelRequests(), 0) };
    };
  }, [client]);
  return <ApiClientContext.Provider value={client}>{children}</ApiClientContext.Provider>;
}

export function useBoostedApiClient() {
  const client = useContext(ApiClientContext);
  if (!client) throw new Error("BoostedApiClient is unavailable outside a machine workspace.");
  return client;
}
