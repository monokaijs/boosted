import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  api: {
    updateStatus: vi.fn(),
    checkForUpdate: vi.fn(),
    installUpdate: vi.fn(),
    health: vi.fn(),
  },
}));

vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => false }));
vi.mock("@tauri-apps/api/app", () => ({ getVersion: vi.fn() }));
vi.mock("@/lib/api", () => ({ getActiveApiClient: () => mocks.api }));

import {
  checkAndInstallAppUpdate,
  formatUpdateProgress,
  refreshAppUpdateAvailability,
  serverUpdatedEvent,
  type AppUpdateState,
  useAppUpdateState,
} from "./updater";

function downloading(downloadedBytes: number, totalBytes?: number): AppUpdateState {
  return { phase: "downloading", supported: true, downloadedBytes, totalBytes };
}

describe("formatUpdateProgress", () => {
  it("calculates and rounds download progress", () => {
    expect(formatUpdateProgress(downloading(51, 100))).toBe(51);
    expect(formatUpdateProgress(downloading(1, 3))).toBe(33);
  });

  it("clamps over-reported progress and handles an unknown total", () => {
    expect(formatUpdateProgress(downloading(120, 100))).toBe(100);
    expect(formatUpdateProgress(downloading(20))).toBeUndefined();
  });
});

describe("browser server updates", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(cleanup);

  it("loads support details, then checks, installs, and announces the restarted server", async () => {
    mocks.api.updateStatus.mockResolvedValue({
      supported: true,
      currentVersion: "0.3.5",
      updateAvailable: false,
      restartPending: false,
    });
    const { result } = renderHook(() => useAppUpdateState());

    await act(async () => refreshAppUpdateAvailability());

    expect(result.current).toMatchObject({
      phase: "idle",
      supported: true,
      currentVersion: "0.3.5",
    });

    mocks.api.checkForUpdate.mockResolvedValue({
      supported: true,
      currentVersion: "0.3.5",
      targetVersion: "0.3.6",
      updateAvailable: true,
      restartPending: false,
    });
    mocks.api.installUpdate.mockResolvedValue({
      supported: true,
      currentVersion: "0.3.5",
      targetVersion: "0.3.6",
      updateAvailable: true,
      restartPending: true,
    });
    mocks.api.health.mockResolvedValue({ ok: true, version: "0.3.6", codexAvailable: true });
    const updated = vi.fn();
    window.addEventListener(serverUpdatedEvent, updated, { once: true });

    await act(async () => checkAndInstallAppUpdate());

    expect(mocks.api.checkForUpdate).toHaveBeenCalledOnce();
    expect(mocks.api.installUpdate).toHaveBeenCalledOnce();
    expect(mocks.api.health).toHaveBeenCalledOnce();
    expect(updated).toHaveBeenCalledOnce();
    expect(result.current).toMatchObject({ phase: "restarting", targetVersion: "0.3.6" });
  });

  it("does not install when the server is already current", async () => {
    mocks.api.checkForUpdate.mockResolvedValue({
      supported: true,
      currentVersion: "0.3.6",
      targetVersion: "0.3.6",
      updateAvailable: false,
      restartPending: false,
    });
    const { result } = renderHook(() => useAppUpdateState());

    await act(async () => checkAndInstallAppUpdate());

    expect(mocks.api.installUpdate).not.toHaveBeenCalled();
    expect(result.current).toMatchObject({ phase: "up-to-date", currentVersion: "0.3.6" });
  });
});
