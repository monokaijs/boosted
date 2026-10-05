import { beforeEach, describe, expect, it } from "vitest";
import { conversationKey, useUnreadStore, type ConversationKind } from "./unread-conversations";

const earlier = "2026-10-05T09:00:00Z";
const later = "2026-10-05T09:01:00Z";
const unread = (kind: ConversationKind, id = "chat", profile = "machine-a") =>
  useUnreadStore.getState().profiles[profile]?.[conversationKey(kind, id)]?.unread;

beforeEach(() => {
  localStorage.clear();
  useUnreadStore.setState({ profiles: {}, active: undefined });
});

describe("conversation read receipts", () => {
  it.each(["agent", "group", "codex"] as const)("tracks new %s messages, ignores stale snapshots, and clears on opening", (kind) => {
    const store = useUnreadStore.getState();
    store.activate("machine-a");
    store.observe("machine-a", kind, "chat", earlier);
    expect(unread(kind)).toBe(false);
    store.observe("machine-a", kind, "chat", later);
    expect(unread(kind)).toBe(true);
    store.activate("machine-a", conversationKey(kind, "chat"));
    expect(unread(kind)).toBe(false);
    store.activate("machine-a");
    store.observe("machine-a", kind, "chat", earlier);
    store.observe("machine-a", kind, "chat", "");
    store.observe("machine-a", kind, "chat", later);
    expect(unread(kind)).toBe(false);
  });

  it("keeps incoming messages read only while their conversation is active", () => {
    const store = useUnreadStore.getState();
    store.activate("machine-a", "agent:chat");
    store.receive("machine-a", "agent", "chat");
    expect(unread("agent")).toBe(false);
    store.receive("machine-a", "group", "chat");
    expect(unread("group")).toBe(true);
    store.activate("machine-a");
    store.receive("machine-a", "agent", "chat");
    expect(unread("agent")).toBe(true);
  });

  it("persists markers and separates machines and conversation kinds", () => {
    const store = useUnreadStore.getState();
    store.receive("machine-a", "codex", "chat");
    useUnreadStore.setState({ profiles: {}, active: undefined });
    store.activate("machine-b", "codex:chat");
    expect(unread("codex", "chat", "machine-b")).toBeUndefined();
    store.activate("machine-a");
    expect(unread("codex")).toBe(true);
    expect(unread("agent")).toBeUndefined();
  });
});
