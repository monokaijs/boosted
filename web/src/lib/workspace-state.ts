import { useCallback, useEffect, useRef, type SetStateAction } from "react";
import { create } from "zustand";

// Transcripts stay in the query cache. An outbox owns pending attachments until
// delivery, while composers release their references when sending.
const MAX_UI_VALUES = 128;
const operationQueues = new Map<string, Promise<void>>();
const activeValues = new Map<string, { count: number }>();

export function pinWorkspaceValue(key: string) {
  const entry = activeValues.get(key) ?? { count: 0 };
  entry.count++;
  activeValues.set(key, entry);
  return () => {
    if (activeValues.get(key) === entry && --entry.count === 0) activeValues.delete(key);
  };
}

export function enqueueWorkspaceOperation(key: string, operation: () => Promise<void>) {
  const pending = (operationQueues.get(key) ?? Promise.resolve()).catch(() => undefined).then(operation);
  operationQueues.set(key, pending);
  void pending.finally(() => { if (operationQueues.get(key) === pending) operationQueues.delete(key); }).catch(() => undefined);
  return pending;
}

export function waitForWorkspaceOperations(key: string) {
  return operationQueues.get(key) ?? Promise.resolve();
}
type WorkspaceState = {
  generation: number;
  values: Record<string, unknown>;
  write: <T>(key: string, value: SetStateAction<T>, fallback: T, generation: number) => void;
  reset: () => void;
};

export const useWorkspaceStore = create<WorkspaceState>((set) => ({
  generation: 0,
  values: {},
  write: (key, update, fallback, generation) => set((state) => {
    // A request from an old machine must never repopulate the new workspace.
    if (state.generation !== generation) return state;
    const current = (Object.hasOwn(state.values, key) ? state.values[key] : fallback) as typeof fallback;
    const value = typeof update === "function" ? (update as (old: typeof fallback) => typeof fallback)(current) : update;
    if (Object.is(current, value)) return state;
    const values = { ...state.values };
    delete values[key];
    values[key] = value;
    const keys = Object.keys(values);
    // Pending/failed deliveries must remain retryable even under cache pressure.
    const evictable = keys.filter((entry) => entry !== key && !activeValues.has(entry) && !(entry.endsWith(":outbox") && Array.isArray(values[entry]) && values[entry].length > 0));
    for (const expired of evictable.slice(0, Math.max(0, keys.length - MAX_UI_VALUES))) delete values[expired];
    return { values };
  }),
  reset: () => {
    operationQueues.clear();
    activeValues.clear();
    set((state) => ({ values: {}, generation: state.generation + 1 }));
  },
}));

export function useWorkspaceState<T>(key: string, initial: T | (() => T)): [T, (value: SetStateAction<T>) => void] {
  const generation = useWorkspaceStore((state) => state.generation);
  useEffect(() => pinWorkspaceValue(key), [key, generation]);
  const fallback = useRef<{ key: string; generation: number; value: T } | undefined>(undefined);
  if (!fallback.current || fallback.current.key !== key || fallback.current.generation !== generation) {
    fallback.current = { key, generation, value: typeof initial === "function" ? (initial as () => T)() : initial };
  }
  const initialValue = fallback.current.value;
  const value = useWorkspaceStore((state) => (Object.hasOwn(state.values, key) ? state.values[key] : initialValue) as T);
  const write = useWorkspaceStore((state) => state.write);
  const update = useCallback((next: SetStateAction<T>) => write(key, next, initialValue, generation), [key, initialValue, generation, write]);
  return [value, update];
}
