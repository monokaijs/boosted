import { useEffect, useState } from "react";
import { Download, RefreshCw, WifiOff, X } from "lucide-react";
import { useRegisterSW } from "virtual:pwa-register/react";
import { Button } from "@/components/ui/button";

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
}

export function PwaLifecycle() {
  const [installPrompt, setInstallPrompt] = useState<BeforeInstallPromptEvent>();
  const [installDismissed, setInstallDismissed] = useState(false);
  const [online, setOnline] = useState(() => navigator.onLine);
  const {
    needRefresh: [needRefresh, setNeedRefresh],
    offlineReady: [offlineReady, setOfflineReady],
    updateServiceWorker,
  } = useRegisterSW({ immediate: true });

  useEffect(() => {
    const captureInstallPrompt = (event: Event) => {
      event.preventDefault();
      setInstallPrompt(event as BeforeInstallPromptEvent);
      setInstallDismissed(false);
    };
    const installed = () => setInstallPrompt(undefined);
    const wentOnline = () => setOnline(true);
    const wentOffline = () => setOnline(false);

    window.addEventListener("beforeinstallprompt", captureInstallPrompt);
    window.addEventListener("appinstalled", installed);
    window.addEventListener("online", wentOnline);
    window.addEventListener("offline", wentOffline);
    return () => {
      window.removeEventListener("beforeinstallprompt", captureInstallPrompt);
      window.removeEventListener("appinstalled", installed);
      window.removeEventListener("online", wentOnline);
      window.removeEventListener("offline", wentOffline);
    };
  }, []);

  useEffect(() => {
    if (!offlineReady) return;
    const timeout = window.setTimeout(() => setOfflineReady(false), 8_000);
    return () => window.clearTimeout(timeout);
  }, [offlineReady, setOfflineReady]);

  async function install() {
    if (!installPrompt) return;
    await installPrompt.prompt();
    await installPrompt.userChoice;
    setInstallPrompt(undefined);
  }

  const showInstall = Boolean(installPrompt) && !installDismissed && !needRefresh && online;

  return (
    <aside className="pwa-notices" aria-label="Application status">
      {needRefresh && (
        <section className="pwa-notice" role="alert">
          <RefreshCw />
          <p><strong>Update ready</strong><span>Reload to use the latest version of Boosted.</span></p>
          <div className="pwa-notice-actions">
            <Button size="sm" onClick={() => void updateServiceWorker(true)}>Reload</Button>
            <Button variant="ghost" size="icon-sm" aria-label="Dismiss update" onClick={() => setNeedRefresh(false)}><X /></Button>
          </div>
        </section>
      )}
      {!online && (
        <section className="pwa-notice" role="status">
          <WifiOff />
          <p><strong>You’re offline</strong><span>The app shell is available; server features reconnect when your network returns.</span></p>
        </section>
      )}
      {showInstall && (
        <section className="pwa-notice" role="status">
          <Download />
          <p><strong>Install Boosted</strong><span>Launch it from your desktop in its own app window.</span></p>
          <div className="pwa-notice-actions">
            <Button size="sm" onClick={() => void install()}>Install</Button>
            <Button variant="ghost" size="icon-sm" aria-label="Dismiss install prompt" onClick={() => setInstallDismissed(true)}><X /></Button>
          </div>
        </section>
      )}
      {offlineReady && online && !needRefresh && (
        <section className="pwa-notice" role="status">
          <Download />
          <p><strong>Ready for offline launch</strong><span>Boosted’s app files are now cached on this device.</span></p>
          <Button variant="ghost" size="icon-sm" aria-label="Dismiss offline-ready notice" onClick={() => setOfflineReady(false)}><X /></Button>
        </section>
      )}
    </aside>
  );
}
