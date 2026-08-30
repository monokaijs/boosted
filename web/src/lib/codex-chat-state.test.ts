import { describe, expect, it } from "vitest";
import { appendCodexDelta, upsertCodexMessage } from "@/lib/codex-chat-state";
import type { CodexChatMessage, CodexLiveEvent } from "@/lib/types";

describe("Codex chat live state", () => {
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
