import { useSyncExternalStore } from "react";
import { getActiveApiClient } from "@/lib/api";
import { useMachineStore } from "@/lib/machines";
import { refreshWebApp } from "@/lib/web-update";

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

const listeners = new Set<() => void>();

const initialState: AppUpdateState = {
  phase: "idle",
  supported: false,
  downloadedBytes: 0,
};
type ApiClient = ReturnType<typeof getActiveApiClient>;
const states = new WeakMap<ApiClient, AppUpdateState>();
const operations = new WeakMap<ApiClient, Promise<void>>();
const availabilityChecks = new WeakMap<ApiClient, Promise<void>>();

function publish(api: ApiClient, patch: Partial<AppUpdateState>) {
  states.set(api, { ...(states.get(api) ?? initialState), ...patch });
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function snapshot() {
  return states.get(getActiveApiClient()) ?? initialState;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

async function waitForUpdatedServer(api: ReturnType<typeof getActiveApiClient>, targetVersion: string) {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    try {
      const health = await api.health(AbortSignal.timeout(5_000));
      if (health.version === targetVersion) return;
    } catch {
      // The server briefly takes its listener down while replacing and restarting itself.
    }
    await new Promise((resolve) => window.setTimeout(resolve, 1_000));
  }
  throw new Error(`Boosted ${targetVersion} was installed, but the server did not reconnect.`);
}

async function runServerUpdateCheck(api: ApiClient) {
  const publishState = (patch: Partial<AppUpdateState>) => publish(api, patch);
  publishState({
    phase: "checking",
    targetVersion: undefined,
    downloadedBytes: 0,
    totalBytes: undefined,
    error: undefined,
  });
  const checked = await api.checkForUpdate();
  const checkedAt = new Date().toISOString();
  publishState({
    supported: checked.supported,
    currentVersion: checked.currentVersion,
    targetVersion: checked.targetVersion,
    supportReason: checked.reason,
    lastCheckedAt: checkedAt,
  });
  if (!checked.supported) {
    publishState({ phase: "unsupported" });
    return;
  }
  if (checked.reason) throw new Error(checked.reason);
  if (!checked.restartPending && (!checked.updateAvailable || !checked.targetVersion)) {
    publishState({ phase: "up-to-date" });
    if (api === getActiveApiClient()) await refreshWebApp(false);
    return;
  }

  publishState({ phase: "downloading", downloadedBytes: 0 });
  const installed = checked.restartPending ? checked : await api.installUpdate();
  if (!installed.restartPending || !installed.targetVersion) {
    publishState({ phase: "up-to-date", currentVersion: installed.currentVersion });
    if (api === getActiveApiClient()) await refreshWebApp(false);
    return;
  }
  publishState({ phase: "restarting", targetVersion: installed.targetVersion });
  await waitForUpdatedServer(api, installed.targetVersion);
  publishState({ phase: "up-to-date", currentVersion: installed.targetVersion });
  if (api === getActiveApiClient()) await refreshWebApp();
}

export function useAppUpdateState() {
  useMachineStore((state) => state.activeId);
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

export function checkAndInstallAppUpdate() {
  const api = getActiveApiClient();
  const currentOperation = operations.get(api);
  if (currentOperation) return currentOperation;

  const operation = runServerUpdateCheck(api)
    .catch((error) => {
      publish(api, { phase: "error", error: errorMessage(error) });
    })
    .finally(() => {
      operations.delete(api);
    });
  operations.set(api, operation);
  return operation;
}

export function refreshAppUpdateAvailability() {
  const api = getActiveApiClient();
  const currentOperation = operations.get(api) ?? availabilityChecks.get(api);
  if (currentOperation) return currentOperation;

  const previousState = states.get(api);
  const operation = api.updateStatus()
    .then((status) => {
      if (states.get(api) !== previousState) return;
      publish(api, {
        phase: status.supported ? "idle" : "unsupported",
        targetVersion: status.targetVersion,
        downloadedBytes: 0,
        totalBytes: undefined,
        lastCheckedAt: undefined,
        supported: status.supported,
        currentVersion: status.currentVersion,
        supportReason: status.reason,
        error: undefined,
      });
    })
    .catch((error) => {
      if (states.get(api) !== previousState) return;
      publish(api, { phase: "error", supported: false, error: errorMessage(error) });
    })
    .finally(() => {
      availabilityChecks.delete(api);
    });
  availabilityChecks.set(api, operation);
  return operation;
}

export function formatUpdateProgress(update: AppUpdateState) {
  if (update.phase !== "downloading" || !update.totalBytes) return undefined;
  return Math.min(100, Math.round((update.downloadedBytes / update.totalBytes) * 100));
}
