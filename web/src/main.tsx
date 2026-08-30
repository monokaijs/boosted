import { lazy, StrictMode, Suspense, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from "@tanstack/react-query";
import { LoaderCircle, RefreshCw, Server } from "lucide-react";
import "dockview-react/dist/styles/dockview.css";
import "@xterm/xterm/css/xterm.css";
import "./index.css";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import { AuthScreen } from "@/components/auth-screen";
import { ConnectionsDialog, EmptyMachineScreen, MachineSwitcher } from "@/components/machine-manager";
import { MobileShell } from "@/components/mobile-shell";
import { getActiveApiClient } from "@/lib/api";
import { ApiClientProvider, useBoostedApiClient } from "@/lib/api-context";
import { isMixedContentConnection, useMachineStore, type MachineProfile } from "@/lib/machines";
import { isNativeMobileRuntime } from "@/lib/runtime";
import { useAppStore } from "@/lib/store";
import type { SetupState, User } from "@/lib/types";
import { startAutomaticAppUpdates } from "@/lib/updater";

const AppShell = lazy(() => import("@/components/app-shell").then((module) => ({ default: module.AppShell })));

function createQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { staleTime: 2_500, retry: 1, refetchOnWindowFocus: false },
    },
  });
}

function Unavailable({ profile, message, retry, retrying }: { profile: MachineProfile; message: string; retry: () => void; retrying: boolean }) {
  const [connectionsOpen, setConnectionsOpen] = useState(false);
  return (
    <main className="grid h-full place-items-center bg-background p-6 text-center">
      <section className="grid w-full max-w-md justify-items-center gap-4 rounded-2xl border border-border bg-card p-6 shadow-xl">
        <div className="grid size-11 place-items-center rounded-xl bg-destructive/10 text-destructive"><Server className="size-5" /></div>
        <div><p className="font-medium">{profile.name} is unavailable</p><p className="mt-1 break-words text-sm leading-6 text-muted-foreground">{message}</p><p className="mt-1 font-mono text-[10px] text-muted-foreground">{profile.baseUrl}</p></div>
        <div className="flex flex-wrap justify-center gap-2"><Button onClick={retry} disabled={retrying}>{retrying ? <LoaderCircle className="animate-spin" /> : <RefreshCw />}Retry</Button><MachineSwitcher onManage={() => setConnectionsOpen(true)} /></div>
      </section>
      <ConnectionsDialog open={connectionsOpen} onOpenChange={setConnectionsOpen} />
    </main>
  );
}

function SessionRoot({ profile }: { profile: MachineProfile }) {
  const api = useBoostedApiClient();
  const token = useMachineStore((state) => state.tokens[profile.id]);
  const setUser = useAppStore((state) => state.setUser);
  const queryClient = useQueryClient();
  const setup = useQuery({ queryKey: ["setup"], queryFn: api.setupState, retry: false });
  const me = useQuery({ queryKey: ["me"], queryFn: api.me, enabled: Boolean(token) && setup.data?.needsSetup === false, retry: false });

  useEffect(() => {
    if (me.data) setUser(me.data);
  }, [me.data, setUser]);

  function authenticated(user: User) {
    setUser(user);
    queryClient.setQueryData(["me"], user);
    queryClient.setQueryData<SetupState>(["setup"], (current) => current ? { ...current, needsSetup: false } : current);
  }

  if (setup.isLoading || (token && me.isLoading)) return <div className="grid h-full place-items-center text-sm text-muted-foreground"><LoaderCircle className="mr-2 inline size-4 animate-spin" />Connecting to {profile.name}…</div>;

  if (setup.isError || !setup.data) {
    const message = isMixedContentConnection(profile.baseUrl)
      ? "This HTTPS page cannot reach a plain-HTTP server because the browser blocks mixed content. Use an HTTP frontend or expose the server through HTTPS."
      : setup.error?.message ?? "Check that Boosted is listening at this address and that the network permits access.";
    return <Unavailable profile={profile} message={message} retry={() => void setup.refetch()} retrying={setup.isFetching} />;
  }

  if (setup.data.needsSetup && !profile.isBootstrap) {
    return <Unavailable profile={profile} message="This server needs its first administrator. Configure it from its local web or desktop app before connecting remotely." retry={() => void setup.refetch()} retrying={setup.isFetching} />;
  }

  if (setup.data.needsSetup || !token || me.isError || !me.data) return <AuthScreen setup={setup.data} onAuthenticated={authenticated} />;

  return isNativeMobileRuntime() ? <MobileShell /> : <Suspense fallback={<div className="grid h-full place-items-center text-sm text-muted-foreground">Loading workspace…</div>}><AppShell /></Suspense>;
}

function MachineBoundary({ profile }: { profile: MachineProfile }) {
  const [queryClient] = useState(createQueryClient);
  const [apiClient] = useState(getActiveApiClient);
  useEffect(() => () => apiClient.cancelRequests(), [apiClient]);
  if (useAppStore.getState().activeMachineId !== profile.id) useAppStore.getState().activateMachine(profile.id);
  return <ApiClientProvider client={apiClient}><QueryClientProvider client={queryClient}><TooltipProvider delayDuration={350}><SessionRoot profile={profile} /></TooltipProvider></QueryClientProvider></ApiClientProvider>;
}

function Bootstrap() {
  const hydrated = useMachineStore((state) => state.hydrated);
  const profiles = useMachineStore((state) => state.profiles);
  const activeId = useMachineStore((state) => state.activeId);
  const initialize = useMachineStore((state) => state.initialize);

  useEffect(() => {
    void initialize();
    startAutomaticAppUpdates();
  }, [initialize]);

  if (!hydrated) return <div className="grid h-full place-items-center text-sm text-muted-foreground"><LoaderCircle className="mr-2 inline size-4 animate-spin" />Loading Boosted…</div>;
  const profile = profiles.find((entry) => entry.id === activeId);
  if (!profile) return <TooltipProvider delayDuration={350}><EmptyMachineScreen /></TooltipProvider>;
  return <MachineBoundary key={`${profile.id}:${profile.baseUrl}`} profile={profile} />;
}

createRoot(document.getElementById("root")!).render(<StrictMode><Bootstrap /></StrictMode>);
