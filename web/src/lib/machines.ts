import { create } from "zustand";
import { defaultMachineBaseUrl, isTauriRuntime } from "@/lib/runtime";

export interface MachineProfile {
  id: string;
  name: string;
  baseUrl: string;
  createdAt: string;
  isBootstrap?: boolean;
}

type RegistrySnapshot = {
  version: 1;
  profiles: MachineProfile[];
  activeId?: string;
};

type MachineStore = {
  hydrated: boolean;
  profiles: MachineProfile[];
  activeId?: string;
  tokens: Record<string, string | undefined>;
  initialize: () => Promise<void>;
  addProfile: (profile: MachineProfile, token: string) => Promise<void>;
  updateProfile: (id: string, update: Pick<MachineProfile, "name" | "baseUrl">) => Promise<void>;
  removeProfile: (id: string) => Promise<void>;
  setActive: (id: string) => Promise<void>;
  setToken: (id: string, token?: string) => Promise<void>;
};

const registryKey = "boosted.machines.v1";
const legacyTokenKey = "boosted.session";
let initialization: Promise<void> | undefined;

function tokenKey(id: string) {
  return `machine.${id}.session`;
}

function storedTokenKey(id: string) {
  return `boosted.${tokenKey(id)}`;
}

async function readPreference(key: string) {
  return localStorage.getItem(key);
}

async function writePreference(key: string, value: string) {
  localStorage.setItem(key, value);
}

async function readToken(id: string) {
  return localStorage.getItem(storedTokenKey(id)) ?? undefined;
}

async function writeToken(id: string, token?: string) {
  if (token) localStorage.setItem(storedTokenKey(id), token);
  else localStorage.removeItem(storedTokenKey(id));
}

function machineLabel(baseUrl: string) {
  if (isTauriRuntime() && baseUrl === "http://127.0.0.1:4782") return "This PC";
  const host = new URL(baseUrl).hostname;
  return host === "localhost" || host === "127.0.0.1" ? "Local Boosted" : host;
}

export function normalizeMachineBaseUrl(input: string) {
  const raw = input.trim();
  if (!raw) throw new Error("Server URL is required.");
  const hasScheme = /^[a-z][a-z\d+.-]*:\/\//i.test(raw);
  let value = hasScheme ? raw : `http://${raw}`;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Enter a valid Boosted server URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Server URL must use HTTP or HTTPS.");
  if (url.username || url.password) throw new Error("Server URL cannot contain credentials.");
  if (url.search || url.hash) throw new Error("Server URL cannot contain a query or fragment.");
  if (url.pathname !== "/" && url.pathname !== "") throw new Error("Server URL must not contain a path.");
  if (!hasScheme && !url.port) url.port = "4782";
  url.pathname = "";
  value = url.origin;
  return value;
}

export function isMixedContentConnection(baseUrl: string) {
  if (window.location.protocol !== "https:") return false;
  try {
    return new URL(baseUrl).protocol === "http:";
  } catch {
    return false;
  }
}

export function machineScopedKey(machineId: string, key: string) {
  const suffix = key.startsWith("boosted.") ? key.slice("boosted.".length) : key;
  return `boosted.machine.${machineId}.${suffix}`;
}

function migrateLegacyState(machineId: string) {
  const exact = new Set([
    "boosted.project",
    "boosted.task",
    "boosted.codexChat",
    "boosted.workspace-contexts.v1",
    "boosted.codex.model",
    "boosted.codex.effort",
    "boosted.codex.access",
  ]);
  const keys = Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index)).filter((key): key is string => Boolean(key));
  for (const key of keys) {
    if (!exact.has(key) && !key.startsWith("boosted.layout.") && !key.startsWith("boosted.workspace.active-panel.")) continue;
    const scoped = machineScopedKey(machineId, key);
    const value = localStorage.getItem(key);
    if (value !== null && localStorage.getItem(scoped) === null) localStorage.setItem(scoped, value);
    localStorage.removeItem(key);
  }
}

async function saveRegistry(profiles: MachineProfile[], activeId?: string) {
  const snapshot: RegistrySnapshot = { version: 1, profiles, activeId };
  await writePreference(registryKey, JSON.stringify(snapshot));
}

function defaultProfile(): MachineProfile | undefined {
  const configured = defaultMachineBaseUrl();
  if (!configured) return undefined;
  const baseUrl = normalizeMachineBaseUrl(configured);
  return {
    id: crypto.randomUUID(),
    name: machineLabel(baseUrl),
    baseUrl,
    createdAt: new Date().toISOString(),
    isBootstrap: true,
  };
}

export const useMachineStore = create<MachineStore>((set, get) => ({
  hydrated: false,
  profiles: [],
  activeId: undefined,
  tokens: {},
  initialize: async () => {
    if (get().hydrated) return;
    if (initialization) return initialization;
    initialization = (async () => {
      let snapshot: RegistrySnapshot | undefined;
      const stored = await readPreference(registryKey);
      if (stored) {
        try {
          const parsed = JSON.parse(stored) as RegistrySnapshot;
          if (parsed.version === 1 && Array.isArray(parsed.profiles)) snapshot = parsed;
        } catch {
          // Replace malformed client-only connection state with a clean registry.
        }
      }
      if (!snapshot) {
        const profile = defaultProfile();
        snapshot = { version: 1, profiles: profile ? [profile] : [], activeId: profile?.id };
        if (profile) {
          migrateLegacyState(profile.id);
          const legacyToken = localStorage.getItem(legacyTokenKey);
          if (legacyToken) {
            await writeToken(profile.id, legacyToken);
            localStorage.removeItem(legacyTokenKey);
          }
        }
        await saveRegistry(snapshot.profiles, snapshot.activeId);
      }
      const validActiveId = snapshot.profiles.some((profile) => profile.id === snapshot.activeId)
        ? snapshot.activeId
        : snapshot.profiles[0]?.id;
      const tokens = Object.fromEntries(await Promise.all(snapshot.profiles.map(async (profile) => [profile.id, await readToken(profile.id)])));
      set({ hydrated: true, profiles: snapshot.profiles, activeId: validActiveId, tokens });
      if (validActiveId !== snapshot.activeId) await saveRegistry(snapshot.profiles, validActiveId);
    })().finally(() => { initialization = undefined; });
    return initialization;
  },
  addProfile: async (profile, token) => {
    const current = get();
    if (current.profiles.some((entry) => entry.baseUrl === profile.baseUrl)) throw new Error("That server is already saved.");
    const profiles = [...current.profiles, profile];
    await writeToken(profile.id, token);
    await saveRegistry(profiles, profile.id);
    set({ profiles, activeId: profile.id, tokens: { ...current.tokens, [profile.id]: token } });
  },
  updateProfile: async (id, update) => {
    const current = get();
    if (current.profiles.some((entry) => entry.id !== id && entry.baseUrl === update.baseUrl)) throw new Error("That server is already saved.");
    const profiles = current.profiles.map((profile) => profile.id === id ? { ...profile, ...update } : profile);
    await saveRegistry(profiles, current.activeId);
    set({ profiles });
  },
  removeProfile: async (id) => {
    const current = get();
    const profiles = current.profiles.filter((profile) => profile.id !== id);
    const activeId = current.activeId === id ? profiles[0]?.id : current.activeId;
    await writeToken(id);
    await saveRegistry(profiles, activeId);
    const prefix = `boosted.machine.${id}.`;
    const keys = Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index)).filter((key): key is string => Boolean(key));
    for (const key of keys) if (key.startsWith(prefix)) localStorage.removeItem(key);
    const tokens = { ...current.tokens };
    delete tokens[id];
    set({ profiles, activeId, tokens });
  },
  setActive: async (id) => {
    const current = get();
    if (!current.profiles.some((profile) => profile.id === id)) throw new Error("Machine not found.");
    await saveRegistry(current.profiles, id);
    set({ activeId: id });
  },
  setToken: async (id, token) => {
    await writeToken(id, token);
    set((state) => ({ tokens: { ...state.tokens, [id]: token } }));
  },
}));

export function activeMachine() {
  const state = useMachineStore.getState();
  return state.profiles.find((profile) => profile.id === state.activeId);
}

export function activeMachineToken() {
  const state = useMachineStore.getState();
  return state.activeId ? state.tokens[state.activeId] : undefined;
}
