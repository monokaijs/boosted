import { getVersion } from "@tauri-apps/api/app";
import { isTauri } from "@tauri-apps/api/core";
import { useSyncExternalStore } from "react";
import { getActiveApiClient } from "@/lib/api";

export const serverUpdatedEvent = "boosted:server-updated";

export type AppUpdatePhase =
  | "unsupported"
  | "idle"
  | "checking"
  | "up-to-date"
  | "downloading"
  | "installing"
  | "restarting"
  | "error";

export interface AppUpdateState {
  phase: AppUpdatePhase;
  supported: boolean;
  currentVersion?: string;
  targetVersion?: string;
  downloadedBytes: number;
  totalBytes?: number;
  lastCheckedAt?: string;
  error?: string;
  supportReason?: string;
}

const automaticCheckDelayMs = 5_000;
const automaticCheckIntervalMs = 6 * 60 * 60 * 1_000;
const desktopRuntime = isTauri();
const listeners = new Set<() => void>();

let state: AppUpdateState = {
  phase: desktopRuntime ? "idle" : "unsupported",
  supported: desktopRuntime,
  downloadedBytes: 0,
};
let currentOperation: Promise<void> | undefined;
let automaticUpdatesStarted = false;

function publish(patch: Partial<AppUpdateState>) {
  state = { ...state, ...patch };
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function snapshot() {
  return state;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

async function refreshCurrentVersion() {
  if (!desktopRuntime || state.currentVersion) return;
  try {
    publish({ currentVersion: await getVersion() });
  } catch {
    // A version is helpful context, but its absence must not prevent updates.
  }
}

async function runUpdateCheck() {
  await refreshCurrentVersion();
  publish({
    phase: "checking",
    targetVersion: undefined,
    downloadedBytes: 0,
    totalBytes: undefined,
    error: undefined,
  });

  const { check } = await import("@tauri-apps/plugin-updater");
  const update = await check({ timeout: 30_000 });
  const checkedAt = new Date().toISOString();

  if (!update) {
    publish({ phase: "up-to-date", lastCheckedAt: checkedAt });
    return;
  }

  try {
    let downloadedBytes = 0;
    publish({
      phase: "downloading",
      currentVersion: update.currentVersion,
      targetVersion: update.version,
      downloadedBytes,
      lastCheckedAt: checkedAt,
    });

    await update.downloadAndInstall((event) => {
      if (event.event === "Started") {
        publish({
          phase: "downloading",
          downloadedBytes: 0,
          totalBytes: event.data.contentLength,
        });
      } else if (event.event === "Progress") {
        downloadedBytes += event.data.chunkLength;
        publish({ phase: "downloading", downloadedBytes });
      } else {
        publish({ phase: "installing", downloadedBytes });
      }
    });

    await update.close();
    publish({ phase: "restarting" });
    const { relaunch } = await import("@tauri-apps/plugin-process");
    await relaunch();
  } catch (error) {
    await update.close().catch(() => undefined);
    throw error;
  }
}

async function waitForUpdatedServer(targetVersion: string) {
  const api = getActiveApiClient();
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    try {
      const health = await api.health();
      if (health.version === targetVersion) return;
    } catch {
      // The managed launcher briefly takes the listener down while changing binaries.
    }
    await new Promise((resolve) => window.setTimeout(resolve, 1_000));
  }
  throw new Error(`Boosted ${targetVersion} was installed, but the server did not reconnect.`);
}

async function runServerUpdateCheck() {
  const api = getActiveApiClient();
  publish({
    phase: "checking",
    targetVersion: undefined,
    downloadedBytes: 0,
    totalBytes: undefined,
    error: undefined,
  });
  const checked = await api.checkForUpdate();
  const checkedAt = new Date().toISOString();
  publish({
    supported: checked.supported,
    currentVersion: checked.currentVersion,
    targetVersion: checked.targetVersion,
    supportReason: checked.reason,
    lastCheckedAt: checkedAt,
  });
  if (!checked.supported) {
    publish({ phase: "unsupported" });
    return;
  }
  if (checked.reason) throw new Error(checked.reason);
  if (!checked.updateAvailable || !checked.targetVersion) {
    publish({ phase: "up-to-date" });
    return;
  }

  publish({ phase: "downloading", downloadedBytes: 0 });
  const installed = await api.installUpdate();
  if (!installed.restartPending || !installed.targetVersion) {
    publish({ phase: "up-to-date", currentVersion: installed.currentVersion });
    return;
  }
  publish({ phase: "restarting", targetVersion: installed.targetVersion });
  await waitForUpdatedServer(installed.targetVersion);
  window.dispatchEvent(new Event(serverUpdatedEvent));
}

export function isDesktopApp() {
  return desktopRuntime;
}

export function useAppUpdateState() {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

export function checkAndInstallAppUpdate() {
  if (currentOperation) return currentOperation;

  currentOperation = (desktopRuntime ? runUpdateCheck() : runServerUpdateCheck())
    .catch((error) => {
      publish({ phase: "error", error: errorMessage(error) });
    })
    .finally(() => {
      currentOperation = undefined;
    });
  return currentOperation;
}

export function refreshAppUpdateAvailability() {
  if (desktopRuntime) return refreshCurrentVersion();
  if (currentOperation) return currentOperation;

  currentOperation = getActiveApiClient().updateStatus()
    .then((status) => {
      publish({
        phase: status.supported ? "idle" : "unsupported",
        supported: status.supported,
        currentVersion: status.currentVersion,
        supportReason: status.reason,
        error: undefined,
      });
    })
    .catch((error) => {
      publish({ phase: "error", supported: false, error: errorMessage(error) });
    })
    .finally(() => {
      currentOperation = undefined;
    });
  return currentOperation;
}

export function startAutomaticAppUpdates() {
  if (!desktopRuntime || !import.meta.env.PROD || automaticUpdatesStarted) return;
  automaticUpdatesStarted = true;

  void refreshCurrentVersion();
  window.setTimeout(() => void checkAndInstallAppUpdate(), automaticCheckDelayMs);
  window.setInterval(() => void checkAndInstallAppUpdate(), automaticCheckIntervalMs);
  window.addEventListener("online", () => {
    if (state.phase === "error") void checkAndInstallAppUpdate();
  });
}

export function formatUpdateProgress(update: AppUpdateState) {
  if (update.phase !== "downloading" || !update.totalBytes) return undefined;
  return Math.min(100, Math.round((update.downloadedBytes / update.totalBytes) * 100));
}
