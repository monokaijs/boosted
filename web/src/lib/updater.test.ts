import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const api = {
    updateStatus: vi.fn(),
    checkForUpdate: vi.fn(),
    installUpdate: vi.fn(),
    health: vi.fn(),
  };
  return { api, activeApi: undefined as typeof api | undefined, refreshWebApp: vi.fn() };
});

vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => false }));
vi.mock("@/lib/machines", () => ({ useMachineStore: (selector: (state: { activeId: string }) => unknown) => selector({ activeId: "machine-a" }) }));
vi.mock("@/lib/web-update", () => ({ refreshWebApp: mocks.refreshWebApp }));
vi.mock("@/lib/api", () => ({ getActiveApiClient: () => mocks.activeApi ?? mocks.api }));

import {
  checkAndInstallAppUpdate,
  formatUpdateProgress,
  refreshAppUpdateAvailability,
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
  beforeEach(() => { vi.clearAllMocks(); mocks.activeApi = undefined; mocks.refreshWebApp.mockResolvedValue(undefined); });
  afterEach(cleanup);

  it("loads support details, then checks, installs, and refreshes the app after the server restarts", async () => {
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

    await act(async () => checkAndInstallAppUpdate());

    expect(mocks.api.checkForUpdate).toHaveBeenCalledOnce();
    expect(mocks.api.installUpdate).toHaveBeenCalledOnce();
    expect(mocks.api.health).toHaveBeenCalledOnce();
    expect(mocks.refreshWebApp).toHaveBeenCalledOnce();
    expect(mocks.refreshWebApp).toHaveBeenCalledWith();
    expect(result.current).toMatchObject({ phase: "up-to-date", currentVersion: "0.3.6" });
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
    expect(mocks.refreshWebApp).toHaveBeenCalledWith(false);
  });

  it("shares duplicate update requests and surfaces failures without refreshing", async () => {
    let rejectCheck!: (error: Error) => void;
    mocks.api.checkForUpdate.mockImplementationOnce(() => new Promise((_, reject) => { rejectCheck = reject; }));
    const { result } = renderHook(() => useAppUpdateState());
    let first!: Promise<void>;
    act(() => {
      first = checkAndInstallAppUpdate();
      expect(checkAndInstallAppUpdate()).toBe(first);
    });
    await act(async () => { rejectCheck(new Error("Download unavailable")); await first; });
    expect(mocks.api.checkForUpdate).toHaveBeenCalledOnce();
    expect(mocks.api.installUpdate).not.toHaveBeenCalled();
    expect(mocks.refreshWebApp).not.toHaveBeenCalled();
    expect(result.current).toMatchObject({ phase: "error", error: "Download unavailable" });
  });

  it("leaves development installations available for manual updates", async () => {
    mocks.api.checkForUpdate.mockResolvedValue({ supported: false, currentVersion: "0.4.0", reason: "Development build" });
    const { result } = renderHook(() => useAppUpdateState());
    await act(async () => checkAndInstallAppUpdate());
    expect(result.current).toMatchObject({ phase: "unsupported", supportReason: "Development build" });
    expect(mocks.api.installUpdate).not.toHaveBeenCalled();
    expect(mocks.refreshWebApp).not.toHaveBeenCalled();
  });

  it("keeps an in-flight update on its original machine when the selection changes", async () => {
    let resolveCheck!: (status: unknown) => void;
    mocks.api.checkForUpdate.mockImplementationOnce(() => new Promise((resolve) => { resolveCheck = resolve; }));
    mocks.api.installUpdate.mockResolvedValue({ restartPending: true, targetVersion: "0.4.1" });
    mocks.api.health.mockResolvedValue({ version: "0.4.1" });
    const other = { updateStatus: vi.fn(), checkForUpdate: vi.fn(), installUpdate: vi.fn(), health: vi.fn() };
    other.updateStatus.mockResolvedValue({ supported: true, currentVersion: "0.4.2" });
    const { result, rerender } = renderHook(() => useAppUpdateState());
    let pending!: Promise<void>;
    act(() => { pending = checkAndInstallAppUpdate(); });
    mocks.activeApi = other;
    rerender();
    await act(async () => refreshAppUpdateAvailability());
    await act(async () => {
      resolveCheck({ supported: true, updateAvailable: true, currentVersion: "0.4.0", targetVersion: "0.4.1" });
      await pending;
    });
    expect(mocks.api.installUpdate).toHaveBeenCalledOnce();
    expect(mocks.api.health).toHaveBeenCalledOnce();
    expect(other.installUpdate).not.toHaveBeenCalled();
    expect(other.health).not.toHaveBeenCalled();
    expect(mocks.refreshWebApp).not.toHaveBeenCalled();
    expect(result.current).toMatchObject({ phase: "idle", currentVersion: "0.4.2" });
  });

  it("runs an explicit update while a support check is still loading", async () => {
    let resolveStatus!: (status: unknown) => void;
    mocks.api.updateStatus.mockImplementationOnce(() => new Promise((resolve) => { resolveStatus = resolve; }));
    mocks.api.checkForUpdate.mockResolvedValue({ supported: true, currentVersion: "0.4.1", updateAvailable: false });
    const { result } = renderHook(() => useAppUpdateState());
    let availability!: Promise<void>;
    await act(async () => {
      availability = refreshAppUpdateAvailability();
      await checkAndInstallAppUpdate();
    });
    expect(mocks.api.checkForUpdate).toHaveBeenCalledOnce();
    await act(async () => {
      resolveStatus({ supported: true, currentVersion: "0.4.0" });
      await availability;
    });
    expect(result.current).toMatchObject({ phase: "up-to-date", currentVersion: "0.4.1" });
  });
});
