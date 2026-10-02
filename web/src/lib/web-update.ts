/** Activate the latest web shell after an explicit update, including an unchanged service worker. */
export async function refreshWebApp(reload = true) {
  const registration = await navigator.serviceWorker?.getRegistration();
  if (!registration) {
    if (reload) window.location.reload();
    return;
  }

  await registration.update();
  const worker = registration.waiting ?? registration.installing;
  if (!worker) {
    if (reload) window.location.reload();
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      window.clearTimeout(timeout);
      worker.removeEventListener("statechange", changed);
    };
    const changed = () => {
      if (worker.state === "installed") worker.postMessage({ type: "SKIP_WAITING" });
      if (worker.state === "activated") { cleanup(); resolve(); }
      if (worker.state === "redundant") { cleanup(); reject(new Error("The web app update failed. Try again.")); }
    };
    const timeout = window.setTimeout(() => {
      cleanup();
      reject(new Error("The web app update did not finish. Try again."));
    }, 30_000);
    worker.addEventListener("statechange", changed);
    changed();
  });
  window.location.reload();
}
