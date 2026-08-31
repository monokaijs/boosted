import { invoke, isTauri } from "@tauri-apps/api/core";

export type MacOSRemoteViewerPermission = "screen-recording" | "accessibility";

export interface MacOSPermissionAppInfo {
  appName: string;
  appPath: string;
  runningFromBundle: boolean;
}

export function canUseMacOSPermissionHelper() {
  return isTauri();
}

export function macOSPermissionLabel(permission: MacOSRemoteViewerPermission) {
  return permission === "screen-recording" ? "Screen Recording" : "Accessibility";
}

export function macOSPermissionAppInfo() {
  return invoke<MacOSPermissionAppInfo>("macos_permission_app_info");
}

export function showMacOSPermissionHelper(permission: MacOSRemoteViewerPermission) {
  return invoke<void>("show_macos_permission_helper", { permission });
}

export function openMacOSPrivacySettings(permission: MacOSRemoteViewerPermission) {
  return invoke<void>("open_macos_privacy_settings", { permission });
}

export function revealMacOSPermissionApp() {
  return invoke<void>("reveal_macos_permission_app");
}
