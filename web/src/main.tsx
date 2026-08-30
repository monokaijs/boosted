import { StrictMode, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import "dockview-react/dist/styles/dockview.css";
import "@xterm/xterm/css/xterm.css";
import "./index.css";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AuthScreen } from "@/components/auth-screen";
import { AppShell } from "@/components/app-shell";
import { api, getToken } from "@/lib/api";
import { useAppStore } from "@/lib/store";
import type { SetupState, User } from "@/lib/types";
import { startAutomaticAppUpdates } from "@/lib/updater";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 2_500, retry: 1, refetchOnWindowFocus: false },
  },
});

function Root() {
  const setUser = useAppStore((state) => state.setUser);
  const setup = useQuery({ queryKey: ["setup"], queryFn: api.setupState });
  const me = useQuery({
    queryKey: ["me"],
    queryFn: api.me,
    enabled: Boolean(getToken()) && setup.data?.needsSetup === false,
  });

  useEffect(() => {
    startAutomaticAppUpdates();
  }, []);

  useEffect(() => {
    if (me.data) setUser(me.data);
  }, [me.data, setUser]);

  function authenticated(user: User) {
    setUser(user);
    queryClient.setQueryData(["me"], user);
    queryClient.setQueryData<SetupState>(["setup"], (current) => current ? { ...current, needsSetup: false } : current);
  }

  if (setup.isLoading || (getToken() && me.isLoading)) {
    return <div className="grid h-full place-items-center text-sm text-muted-foreground">Connecting to Boosted…</div>;
  }

  if (setup.isError || !setup.data) {
    return (
      <div className="grid h-full place-items-center p-6 text-center">
        <div><p className="font-medium">Boosted service is unavailable</p><p className="mt-1 text-sm text-muted-foreground">Start the local server on port 4782 and reload.</p></div>
      </div>
    );
  }

  if (setup.data.needsSetup || !getToken() || me.isError || !me.data) {
    return <AuthScreen setup={setup.data} onAuthenticated={authenticated} />;
  }

  return <AppShell />;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <TooltipProvider delayDuration={350}>
        <Root />
      </TooltipProvider>
    </QueryClientProvider>
  </StrictMode>,
);
