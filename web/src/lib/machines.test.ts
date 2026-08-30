import { beforeEach, describe, expect, it, vi } from "vitest";

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: (key: string) => values.get(key) ?? null,
    key: (index: number) => [...values.keys()][index] ?? null,
    removeItem: (key: string) => { values.delete(key); },
    setItem: (key: string, value: string) => { values.set(key, value); },
  } satisfies Storage;
}

describe("machine URLs", () => {
  it("normalizes origins and applies the default port only to scheme-less URLs", async () => {
    const { normalizeMachineBaseUrl } = await import("@/lib/machines");

    expect(normalizeMachineBaseUrl("server.lan")).toBe("http://server.lan:4782");
    expect(normalizeMachineBaseUrl("server.lan:9000")).toBe("http://server.lan:9000");
    expect(normalizeMachineBaseUrl("http://server.lan")).toBe("http://server.lan");
    expect(normalizeMachineBaseUrl("https://server.lan/")).toBe("https://server.lan");
  });

  it.each([
    ["", "required"],
    ["ftp://server.lan", "HTTP or HTTPS"],
    ["http://user:secret@server.lan", "credentials"],
    ["http://server.lan/boosted", "path"],
    ["http://server.lan?q=1", "query or fragment"],
    ["http://server.lan#details", "query or fragment"],
  ])("rejects non-origin input %s", async (input, message) => {
    const { normalizeMachineBaseUrl } = await import("@/lib/machines");
    expect(() => normalizeMachineBaseUrl(input)).toThrow(message);
  });
});

describe("machine registry", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", memoryStorage());
    vi.resetModules();
  });

  it("migrates the legacy session and workspace into the generated browser profile", async () => {
    localStorage.setItem("boosted.session", "legacy-token");
    localStorage.setItem("boosted.project", "legacy-project");
    const { machineScopedKey, useMachineStore } = await import("@/lib/machines");

    await useMachineStore.getState().initialize();

    const state = useMachineStore.getState();
    expect(state.profiles).toHaveLength(1);
    expect(state.profiles[0]).toMatchObject({ baseUrl: window.location.origin, isBootstrap: true });
    expect(state.tokens[state.profiles[0].id]).toBe("legacy-token");
    expect(localStorage.getItem("boosted.session")).toBeNull();
    expect(localStorage.getItem(machineScopedKey(state.profiles[0].id, "boosted.project"))).toBe("legacy-project");
  });

  it("keeps profiles, active selection, tokens, and removal isolated", async () => {
    const { machineScopedKey, useMachineStore } = await import("@/lib/machines");
    await useMachineStore.getState().initialize();
    const local = useMachineStore.getState().profiles[0];
    await useMachineStore.getState().setToken(local.id, "local-token");

    const remote = {
      id: "remote",
      name: "Office PC",
      baseUrl: "http://office.lan:4782",
      createdAt: "2026-08-31T00:00:00.000Z",
    };
    await useMachineStore.getState().addProfile(remote, "remote-token");
    expect(useMachineStore.getState()).toMatchObject({ activeId: "remote" });
    expect(useMachineStore.getState().tokens).toMatchObject({ [local.id]: "local-token", remote: "remote-token" });
    await expect(useMachineStore.getState().addProfile({ ...remote, id: "duplicate" }, "token")).rejects.toThrow("already saved");

    await useMachineStore.getState().setActive(local.id);
    const persisted = JSON.parse(localStorage.getItem("boosted.machines.v1") ?? "{}") as { activeId?: string };
    expect(persisted.activeId).toBe(local.id);

    localStorage.setItem(machineScopedKey("remote", "boosted.project"), "remote-project");
    await useMachineStore.getState().removeProfile("remote");
    expect(useMachineStore.getState().profiles).toEqual([local]);
    expect(useMachineStore.getState().tokens[local.id]).toBe("local-token");
    expect(localStorage.getItem(machineScopedKey("remote", "boosted.project"))).toBeNull();
  });
});
