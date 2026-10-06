export function isTauriRuntime() {
  return "__TAURI_INTERNALS__" in window;
}

export async function openExternalUrl(value: string) {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Only web links can be opened externally");
  if (isTauriRuntime()) {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(url.href);
    return;
  }
  window.open(url.href, "_blank", "noopener,noreferrer");
}

export function defaultMachineBaseUrl() {
  const configured = import.meta.env.VITE_BOOSTED_API_URL?.trim();
  if (configured) return configured;
  if (isTauriRuntime()) return "http://127.0.0.1:4782";
  return window.location.origin;
}
