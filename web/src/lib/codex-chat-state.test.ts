import { describe, expect, it } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { applyCodexEvent, appendCodexDelta, upsertCodexMessage } from "@/lib/codex-chat-state";
import type { CodexChatMessage, CodexChatThread, CodexLiveEvent } from "@/lib/types";

describe("Codex chat live state", () => {
  it("protects streamed tokens from a late snapshot and ignores unopened histories", async () => {
    const client = new QueryClient();
    const key = ["codex-chat", "thread"];
    const thread: CodexChatThread = { chat: { id: "thread", title: "Chat", status: "active", cwd: "/repo", preview: "", source: "cli", isPinned: false, updatedAt: "now" }, messages: [] };
    client.setQueryData(key, thread);
    let resolve!: (snapshot: CodexChatThread) => void;
    const loading = client.fetchQuery({ queryKey: key, queryFn: () => new Promise<CodexChatThread>((done) => { resolve = done; }) }).catch(() => undefined);
    applyCodexEvent(client, { threadId: "thread", turnId: "turn", method: "item/agentMessage/delta", itemId: "answer", delta: "Newest tokens" });
    resolve(thread); await loading;
    expect(client.getQueryData<CodexChatThread>(key)?.messages[0]?.content).toBe("Newest tokens");
    applyCodexEvent(client, { threadId: "unopened", turnId: "turn", method: "item/agentMessage/delta", itemId: "answer", delta: "Ignored" });
    expect(client.getQueryState(["codex-chat", "unopened"])).toBeUndefined();
    client.clear();
  });
  it("reconciles a live user item with its optimistic message", () => {
    const optimistic: CodexChatMessage = { id: "client-message", role: "user", content: "Check the tests", kind: "message", createdAt: "2026-08-30T00:00:00Z" };
    const live: CodexChatMessage = { id: "server-item", role: "user", content: "Check the tests", kind: "message" };

    const messages = upsertCodexMessage([optimistic], live, "client-message");

    expect(messages).toEqual([optimistic]);
  });

  it("appends assistant deltas before a turn-completed event exists", () => {
    const first: CodexLiveEvent = { threadId: "thread", turnId: "turn", method: "item/agentMessage/delta", itemId: "answer", delta: "Live " };
    const second: CodexLiveEvent = { ...first, delta: "response" };

    const afterFirst = appendCodexDelta([], first, "message");
    const afterSecond = appendCodexDelta(afterFirst, second, "message");

    expect(afterFirst[0]?.content).toBe("Live ");
    expect(afterSecond[0]?.content).toBe("Live response");
  });
});
