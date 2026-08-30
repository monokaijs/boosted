import { Capacitor } from "@capacitor/core";

export function isTauriRuntime() {
  return "__TAURI_INTERNALS__" in window;
}

export function isNativeMobileRuntime() {
  return Capacitor.isNativePlatform();
}

export function runtimePlatform() {
  if (isNativeMobileRuntime()) return Capacitor.getPlatform();
  if (isTauriRuntime()) return "tauri";
  return "web";
}

export function defaultMachineBaseUrl() {
  if (isNativeMobileRuntime()) return undefined;
  const configured = import.meta.env.VITE_BOOSTED_API_URL?.trim();
  if (configured) return configured;
  if (isTauriRuntime()) return "http://127.0.0.1:4782";
  return window.location.origin;
}
