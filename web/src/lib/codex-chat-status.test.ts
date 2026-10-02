import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { applyChatStatusEvent, chatActivity, setCachedChatStatus } from "./codex-chat-status";
import type { CodexChat, CodexChatThread } from "./types";

const chat: CodexChat = { id: "thread", title: "Chat", preview: "", cwd: "/repo", source: "cli", updatedAt: "2026-10-02", isPinned: false, status: "notLoaded" };

describe("chat activity", () => {
  it("recognizes server statuses without treating loaded or selected chats as running", () => {
    for (const status of ["active", "running", "inProgress"]) expect(chatActivity(status)).toBe("running");
    expect(chatActivity("needs_input")).toBe("waiting");
    expect(chatActivity("systemError")).toBe("failed");
    for (const status of ["idle", "notLoaded", "completed", "unknown"]) expect(chatActivity(status)).toBe("idle");
  });

  it("updates all list caches and the open transcript through start, approval, and completion", () => {
    const client = new QueryClient();
    const other = { ...chat, id: "other", status: "idle" };
    client.setQueryData(["codex-chats", "all"], [chat, other]);
    client.setQueryData(["codex-chats", "/repo"], [chat]);
    client.setQueryData(["codex-chat", "thread"], { chat, messages: [] });
    const event = { threadId: "thread", turnId: "turn", method: "turn/started" };
    const status = () => client.getQueryData<CodexChat[]>(["codex-chats", "all"])?.[0].status;

    applyChatStatusEvent(client, event);
    expect(status()).toBe("active");
    expect(client.getQueryData<CodexChat[]>(["codex-chats", "/repo"])?.[0].status).toBe("active");
    expect(client.getQueryData<CodexChatThread>(["codex-chat", "thread"])?.chat.status).toBe("active");
    setCachedChatStatus(client, "thread", "needs_input");
    expect(status()).toBe("needs_input");
    applyChatStatusEvent(client, { ...event, method: "turn/completed", status: "failed" });
    expect(status()).toBe("failed");
    applyChatStatusEvent(client, event);
    applyChatStatusEvent(client, { ...event, method: "turn/completed", status: "interrupted" });
    expect(status()).toBe("idle");
    expect(client.getQueryData<CodexChat[]>(["codex-chats", "all"])?.[1]).toEqual(other);
    expect(client.getQueryData(["codex-chat", "other"])).toBeUndefined();
    client.clear();
  });
});
