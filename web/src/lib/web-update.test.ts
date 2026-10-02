import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { refreshWebApp } from "./web-update";

class Worker extends EventTarget {
  state: ServiceWorkerState = "installed";
  postMessage = vi.fn(() => {
    this.state = "activated";
    this.dispatchEvent(new Event("statechange"));
  });
}

describe("refreshWebApp", () => {
  const reload = vi.fn();
  const update = vi.fn();
  const getRegistration = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    update.mockResolvedValue(undefined);
    vi.stubGlobal("window", { location: { reload }, setTimeout, clearTimeout });
    vi.stubGlobal("navigator", { serviceWorker: { getRegistration } });
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

  it("activates a waiting worker before reloading", async () => {
    const worker = new Worker();
    getRegistration.mockResolvedValue({ update, waiting: worker });
    await refreshWebApp();
    expect(update).toHaveBeenCalledOnce();
    expect(worker.postMessage).toHaveBeenCalledWith({ type: "SKIP_WAITING" });
    expect(reload).toHaveBeenCalledOnce();
  });

  it("waits for an installing worker before activating and reloading", async () => {
    const worker = new Worker();
    worker.state = "installing";
    getRegistration.mockResolvedValue({ update, installing: worker });
    const pending = refreshWebApp();
    await vi.waitFor(() => expect(update).toHaveBeenCalledOnce());
    expect(reload).not.toHaveBeenCalled();
    worker.state = "installed";
    worker.dispatchEvent(new Event("statechange"));
    await pending;
    expect(worker.postMessage).toHaveBeenCalledOnce();
    expect(reload).toHaveBeenCalledOnce();
  });

  it("refreshes after a backend update even when the web shell has not changed", async () => {
    getRegistration.mockResolvedValue({ update });
    await refreshWebApp();
    expect(reload).toHaveBeenCalledOnce();
  });

  it("does not refresh a current app unnecessarily", async () => {
    getRegistration.mockResolvedValue({ update });
    await refreshWebApp(false);
    expect(update).toHaveBeenCalledOnce();
    expect(reload).not.toHaveBeenCalled();
  });

  it("still updates a stale web shell when the backend is already current", async () => {
    const worker = new Worker();
    getRegistration.mockResolvedValue({ update, waiting: worker });
    await refreshWebApp(false);
    expect(worker.postMessage).toHaveBeenCalledOnce();
    expect(reload).toHaveBeenCalledOnce();
  });

  it("reloads directly when service workers are unavailable", async () => {
    vi.stubGlobal("navigator", {});
    await refreshWebApp();
    expect(reload).toHaveBeenCalledOnce();
  });

  it("reports a failed activation without loading stale cached files", async () => {
    vi.useFakeTimers();
    window.setTimeout = setTimeout;
    window.clearTimeout = clearTimeout;
    const worker = new Worker();
    worker.postMessage.mockImplementation(() => {});
    getRegistration.mockResolvedValue({ update, waiting: worker });
    const pending = expect(refreshWebApp()).rejects.toThrow("did not finish");
    await vi.advanceTimersByTimeAsync(30_000);
    await pending;
    expect(reload).not.toHaveBeenCalled();
  });
});
