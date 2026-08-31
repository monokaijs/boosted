import { afterEach, describe, expect, it } from "vitest";
import { ApiError } from "@/lib/api";
import type { MachineProfile } from "@/lib/machines";
import { setupRetryDelay, shouldRetrySetup } from "@/lib/startup";

const localProfile: MachineProfile = {
  id: "local",
  name: "This PC",
  baseUrl: "http://127.0.0.1:4782",
  createdAt: "2026-08-31T00:00:00.000Z",
  isBootstrap: true,
};

describe("desktop startup recovery", () => {
  afterEach(() => {
    delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  });

  it("retries transient failures from the bundled desktop service", () => {
    (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};

    expect(shouldRetrySetup(localProfile, 0, new ApiError(0, "Load failed"))).toBe(true);
    expect(shouldRetrySetup(localProfile, 19, new ApiError(0, "Load failed"))).toBe(true);
    expect(shouldRetrySetup(localProfile, 20, new ApiError(0, "Load failed"))).toBe(false);
  });

  it("does not hide persistent HTTP errors or failures from other machines", () => {
    (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    const remoteProfile = { ...localProfile, id: "remote", baseUrl: "http://office.lan:4782", isBootstrap: false };

    expect(shouldRetrySetup(localProfile, 0, new ApiError(500, "Server error"))).toBe(false);
    expect(shouldRetrySetup(remoteProfile, 0, new ApiError(0, "Load failed"))).toBe(false);
  });

  it("does not retry outside the desktop runtime", () => {
    expect(shouldRetrySetup(localProfile, 0, new ApiError(0, "Failed to fetch"))).toBe(false);
  });

  it("backs off quickly and caps retries at one second", () => {
    expect([0, 1, 2, 3, 10].map(setupRetryDelay)).toEqual([250, 500, 1_000, 1_000, 1_000]);
  });
});
