export function isTauriRuntime() {
  return "__TAURI_INTERNALS__" in window;
}

export function defaultMachineBaseUrl() {
  const configured = import.meta.env.VITE_BOOSTED_API_URL?.trim();
  if (configured) return configured;
  if (isTauriRuntime()) return "http://127.0.0.1:4782";
  return window.location.origin;
}
