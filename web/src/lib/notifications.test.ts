import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BoostedApiClient } from "@/lib/api";
import { buildNotificationForEvent, defaultNotificationSettings, notificationEventId, readNotificationSettings, writeNotificationSettings } from "@/lib/notifications";
import type { LiveEvent } from "@/lib/types";

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

function live(topic: string, data: unknown): LiveEvent {
  return { sequence: 1, topic, data };
}

function api(overrides: Partial<BoostedApiClient> = {}) {
  return {
    profileId: "machine-a",
    task: vi.fn(),
    codexChat: vi.fn(),
    integrations: vi.fn(),
    ...overrides,
  } as unknown as BoostedApiClient;
}

describe("PWA notification settings", () => {
  beforeEach(() => vi.stubGlobal("localStorage", memoryStorage()));

  it("uses actionable defaults and keeps preferences isolated by machine", () => {
    expect(readNotificationSettings("machine-a")).toEqual(defaultNotificationSettings);
    writeNotificationSettings("machine-a", { version: 1, enabled: true, delivery: "always", events: ["taskFailed"] });

    expect(readNotificationSettings("machine-a")).toMatchObject({ enabled: true, delivery: "always", events: ["taskFailed"] });
    expect(readNotificationSettings("machine-b")).toEqual(defaultNotificationSettings);
  });

  it("sanitizes unknown stored event names", () => {
    localStorage.setItem("boosted.machine.machine-a.notifications.v1", JSON.stringify({ version: 1, enabled: true, delivery: "always", events: ["taskFailed", "unknown", "taskFailed"] }));
    expect(readNotificationSettings("machine-a").events).toEqual(["taskFailed"]);
  });
});

describe("live notification mapping", () => {
  it.each([
    [live("task.created", { taskId: "task-1" }), "taskCreated"],
    [live("task.updated", { taskId: "task-1", status: "needs_input" }), "taskNeedsInput"],
    [live("task.updated", { taskId: "task-1", status: "ready" }), "taskReady"],
    [live("task.updated", { taskId: "task-1", status: "review" }), "taskReview"],
    [live("task.updated", { taskId: "task-1", status: "done" }), "taskCompleted"],
    [live("task.updated", { taskId: "task-1", status: "failed" }), "taskFailed"],
    [live("codex.event", { threadId: "chat-1", method: "turn/completed", status: "completed", error: null }), "codexCompleted"],
    [live("codex.event", { threadId: "chat-1", method: "turn/completed", status: "failed" }), "codexFailed"],
    [live("integration.synced", { failed: 0, status: "success" }), "integrationSynced"],
    [live("integration.synced", { failed: 2, status: "partial" }), "integrationFailed"],
  ])("classifies %s", (event, expected) => {
    expect(notificationEventId(event)).toBe(expected);
  });

  it("builds task notifications with navigation data", async () => {
    const client = api({ task: vi.fn().mockResolvedValue({ id: "task-1", title: "Repair build", error: undefined }) });
    const content = await buildNotificationForEvent(live("task.updated", { taskId: "task-1", status: "review" }), client);

    expect(content).toMatchObject({
      event: "taskReview",
      title: "Repair build",
      data: { kind: "task", id: "task-1", url: "/?notification=task&notificationId=task-1" },
    });
  });

  it("builds failure details for integration notifications", async () => {
    const client = api({ integrations: vi.fn().mockResolvedValue([{ id: "integration-1", name: "GitLab issues" }]) });
    const content = await buildNotificationForEvent(live("integration.synced", { projectId: "project-1", integrationId: "integration-1", failed: 1, status: "failed", error: "GitLab is unavailable" }), client);

    expect(content).toMatchObject({ event: "integrationFailed", title: "GitLab issues", body: "GitLab is unavailable" });
  });
});
