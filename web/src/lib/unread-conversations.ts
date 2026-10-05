import { create } from "zustand";
import { machineScopedKey } from "@/lib/machines";

export type ConversationKind = "agent" | "group" | "codex";
type Receipt = { latest: string; unread: boolean };
type Receipts = Record<string, Receipt>;
export const conversationKey = (kind: ConversationKind, id: string) => `${kind}:${id}`;
const storageKey = (profileId: string) => machineScopedKey(profileId, "boosted.chat-read-state.v1");

function loadReceipts(profileId: string): Receipts {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(storageKey(profileId)) ?? "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).filter(([, receipt]) => receipt && typeof receipt.latest === "string" && typeof receipt.unread === "boolean"));
  } catch { return {}; }
}

type UnreadStore = {
  profiles: Record<string, Receipts>;
  active?: { profileId: string; key: string };
  activate(profileId: string, key?: string): void;
  observe(profileId: string, kind: ConversationKind, id: string, latest: string): void;
  receive(profileId: string, kind: ConversationKind, id: string): void;
};

export const useUnreadStore = create<UnreadStore>((set, get) => {
  function update(profileId: string, key: string, receipt: Receipt) {
    const state = get();
    const receipts = state.profiles[profileId] ?? loadReceipts(profileId);
    if (receipts[key]?.latest === receipt.latest && receipts[key]?.unread === receipt.unread) return;
    const next = { ...receipts, [key]: receipt };
    try { localStorage.setItem(storageKey(profileId), JSON.stringify(next)); } catch { /* Read tracking also works without storage. */ }
    set({ profiles: { ...state.profiles, [profileId]: next } });
  }
  return {
    profiles: {},
    activate(profileId, key) {
      const state = get();
      const receipts = state.profiles[profileId] ?? loadReceipts(profileId);
      set({ profiles: { ...state.profiles, [profileId]: receipts }, active: key ? { profileId, key } : undefined });
      if (key && receipts[key]?.unread) update(profileId, key, { ...receipts[key], unread: false });
    },
    observe(profileId, kind, id, latest) {
      const state = get();
      const key = conversationKey(kind, id);
      const previous = (state.profiles[profileId] ?? loadReceipts(profileId))[key];
      // Establish a baseline for existing history; only subsequent messages are unread.
      if (previous && (previous.latest === latest || (!latest && previous.latest) || (latest && previous.latest && Date.parse(latest) <= Date.parse(previous.latest)))) return;
      const active = state.active?.profileId === profileId && state.active.key === key;
      update(profileId, key, { latest, unread: !active && Boolean(previous && (latest || previous.unread)) });
    },
    receive(profileId, kind, id) {
      const state = get();
      const key = conversationKey(kind, id);
      const previous = (state.profiles[profileId] ?? loadReceipts(profileId))[key];
      const active = state.active?.profileId === profileId && state.active.key === key;
      update(profileId, key, { latest: previous?.latest ?? "", unread: !active });
    },
  };
});
