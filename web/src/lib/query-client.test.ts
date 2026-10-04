import { QueryObserver } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createWorkspaceQueryClient, pruneConversationCache } from "./query-client";

afterEach(() => vi.useRealTimers());

describe("workspace conversation cache", () => {
  it("evicts the oldest inactive conversations without removing active views or lists", () => {
    const { client, dispose } = createWorkspaceQueryClient();
    const activeKey = ["codex-chat", "active"];
    client.setQueryData(activeKey, { messages: [] }, { updatedAt: 1 });
    const observer = new QueryObserver(client, { queryKey: activeKey, enabled: false });
    const unsubscribe = observer.subscribe(() => undefined);
    client.setQueryData(["projects"], [{ id: "project" }]);
    for (let i = 0; i < 12; i++) client.setQueryData(["codex-chat", `chat-${i}`], { messages: [] }, { updatedAt: i + 2 });
    pruneConversationCache(client);
    expect(client.getQueryData(activeKey)).toBeDefined();
    expect(client.getQueryData(["projects"])).toBeDefined();
    expect(client.getQueryData(["codex-chat", "chat-3"])).toBeUndefined();
    expect(client.getQueryData(["codex-chat", "chat-4"])).toBeDefined();
    expect(client.getQueryCache().findAll({ queryKey: ["codex-chat"] })).toHaveLength(9);
    unsubscribe(); dispose();
  });

  it("applies a text budget across conversation types and preserves in-flight requests", async () => {
    const { client, dispose } = createWorkspaceQueryClient();
    client.setQueryData(["assistant-state", "large"], { messages: [{ content: "x".repeat(9 * 1024 * 1024) }] });
    let resolve!: (value: string) => void;
    const request = client.fetchQuery({ queryKey: ["codex-chat", "loading"], queryFn: () => new Promise<string>((done) => { resolve = done; }) });
    pruneConversationCache(client);
    expect(client.getQueryData(["assistant-state", "large"])).toBeUndefined();
    expect(client.getQueryState(["codex-chat", "loading"])?.fetchStatus).toBe("fetching");
    resolve("Loaded"); await request; dispose();
  });

  it("expires inactive data and releases scheduled work on disposal", () => {
    vi.useFakeTimers();
    const { client, dispose } = createWorkspaceQueryClient();
    client.setQueryData(["codex-chat", "thread"], { messages: [] });
    vi.advanceTimersByTime(120_001);
    expect(client.getQueryData(["codex-chat", "thread"])).toBeUndefined();
    client.setQueryData(["codex-chat", "new"], { messages: [] });
    dispose();
    expect(client.getQueryCache().getAll()).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});
