import { ApiError } from "@/lib/api";
import type { MachineProfile } from "@/lib/machines";
import { isTauriRuntime } from "@/lib/runtime";

const desktopLocalBaseUrl = "http://127.0.0.1:4782";
const desktopStartupRetryLimit = 20;

export function shouldRetrySetup(profile: MachineProfile, failureCount: number, error: Error) {
  return isTauriRuntime()
    && profile.isBootstrap === true
    && profile.baseUrl === desktopLocalBaseUrl
    && error instanceof ApiError
    && error.status === 0
    && failureCount < desktopStartupRetryLimit;
}

export function setupRetryDelay(attemptIndex: number) {
  return Math.min(250 * (2 ** Math.min(attemptIndex, 2)), 1_000);
}
