import type { BoostedApiClient } from "@/lib/api";
import { machineScopedKey } from "@/lib/machines";
import { isTauriRuntime } from "@/lib/runtime";
import type { LiveEvent } from "@/lib/types";

export const notificationEventDefinitions = [
  { id: "taskCreated", group: "Tasks", label: "Task created", description: "A new task is added to a workspace." },
  { id: "taskNeedsInput", group: "Tasks", label: "Input required", description: "Codex needs an answer before it can continue." },
  { id: "taskReady", group: "Tasks", label: "Plan ready", description: "A task plan is ready for approval." },
  { id: "taskReview", group: "Tasks", label: "Review required", description: "Task execution has finished and needs review." },
  { id: "taskCompleted", group: "Tasks", label: "Task completed", description: "A task is marked as done." },
  { id: "taskFailed", group: "Tasks", label: "Task failed", description: "A task stops because of an error." },
  { id: "codexCompleted", group: "Codex", label: "Chat completed", description: "A general Codex chat finishes successfully." },
  { id: "codexFailed", group: "Codex", label: "Chat failed", description: "A general Codex chat finishes with an error." },
  { id: "integrationSynced", group: "Integrations", label: "Sync completed", description: "An integration finishes syncing without errors." },
  { id: "integrationFailed", group: "Integrations", label: "Sync issues", description: "An integration sync reports failed items." },
] as const;

export type NotificationEventId = typeof notificationEventDefinitions[number]["id"];
export type NotificationDelivery = "background" | "always";

export interface PwaNotificationSettings {
  version: 1;
  enabled: boolean;
  delivery: NotificationDelivery;
  events: NotificationEventId[];
}

export interface PwaNotificationContent {
  event: NotificationEventId;
  title: string;
  body: string;
  tag: string;
  data: {
    kind: "task" | "codex" | "integration";
    id: string;
    url: string;
  };
}

export type PwaNotificationPermission = NotificationPermission | "unsupported";

const storageKey = "boosted.notifications.v1";
const knownEvents = new Set<NotificationEventId>(notificationEventDefinitions.map(({ id }) => id));

export const defaultNotificationSettings: PwaNotificationSettings = {
  version: 1,
  enabled: false,
  delivery: "background",
  events: [
    "taskNeedsInput",
    "taskReady",
    "taskReview",
    "taskCompleted",
    "taskFailed",
    "codexCompleted",
    "codexFailed",
    "integrationFailed",
  ],
};

function settingsKey(machineId: string) {
  return machineScopedKey(machineId, storageKey);
}

function isNotificationEventId(value: unknown): value is NotificationEventId {
  return typeof value === "string" && knownEvents.has(value as NotificationEventId);
}

export function readNotificationSettings(machineId: string): PwaNotificationSettings {
  try {
    const parsed = JSON.parse(localStorage.getItem(settingsKey(machineId)) ?? "null") as Partial<PwaNotificationSettings> | null;
    if (!parsed || parsed.version !== 1) return { ...defaultNotificationSettings, events: [...defaultNotificationSettings.events] };
    return {
      version: 1,
      enabled: parsed.enabled === true,
      delivery: parsed.delivery === "always" ? "always" : "background",
      events: Array.isArray(parsed.events) ? [...new Set(parsed.events.filter(isNotificationEventId))] : [...defaultNotificationSettings.events],
    };
  } catch {
    return { ...defaultNotificationSettings, events: [...defaultNotificationSettings.events] };
  }
}

export function writeNotificationSettings(machineId: string, settings: PwaNotificationSettings) {
  localStorage.setItem(settingsKey(machineId), JSON.stringify(settings));
  window.dispatchEvent(new CustomEvent("boosted:notification-settings", { detail: { machineId, settings } }));
}

export function notificationPermission(): PwaNotificationPermission {
  if (isTauriRuntime() || !window.isSecureContext || !("Notification" in window) || !("serviceWorker" in navigator)) return "unsupported";
  return Notification.permission;
}

export async function requestNotificationPermission(): Promise<PwaNotificationPermission> {
  if (notificationPermission() === "unsupported") return "unsupported";
  return Notification.requestPermission();
}

async function activeServiceWorkerRegistration() {
  if (notificationPermission() === "unsupported") return undefined;
  return (await navigator.serviceWorker.getRegistration()) ?? undefined;
}

export async function showPwaNotification(content: Omit<PwaNotificationContent, "event">) {
  if (notificationPermission() !== "granted") return false;
  const registration = await activeServiceWorkerRegistration();
  if (!registration) return false;
  await registration.showNotification(content.title, {
    body: content.body,
    icon: "/pwa-192x192.png",
    badge: "/favicon-32x32.png",
    tag: content.tag,
    data: content.data,
  });
  return true;
}

export async function showTestNotification() {
  return showPwaNotification({
    title: "Boosted notifications are ready",
    body: "You’ll receive the events selected in Global settings.",
    tag: "boosted:test",
    data: { kind: "integration", id: "test", url: "/" },
  });
}

function eventData(event: LiveEvent) {
  return event.data && typeof event.data === "object" ? event.data as Record<string, unknown> : {};
}

export function notificationEventId(event: LiveEvent): NotificationEventId | undefined {
  const data = eventData(event);
  if (event.topic === "task.created") return "taskCreated";
  if (event.topic === "task.updated") {
    if (data.status === "needs_input") return "taskNeedsInput";
    if (data.status === "ready") return "taskReady";
    if (data.status === "review") return "taskReview";
    if (data.status === "done") return "taskCompleted";
    if (data.status === "failed") return "taskFailed";
  }
  if (event.topic === "codex.event" && data.method === "turn/completed") {
    return data.status === "failed" || Boolean(data.error) ? "codexFailed" : "codexCompleted";
  }
  if (event.topic === "integration.synced") {
    return Number(data.failed ?? 0) > 0 || data.status === "failed" || data.status === "partial"
      ? "integrationFailed"
      : "integrationSynced";
  }
  return undefined;
}

function notificationUrl(kind: PwaNotificationContent["data"]["kind"], id: string) {
  if (kind === "integration") return "/";
  const params = new URLSearchParams({ notification: kind, notificationId: id });
  return `/?${params}`;
}

export async function buildNotificationForEvent(event: LiveEvent, api: BoostedApiClient): Promise<PwaNotificationContent | undefined> {
  const selectedEvent = notificationEventId(event);
  if (!selectedEvent) return undefined;
  const data = eventData(event);

  if (selectedEvent.startsWith("task")) {
    const taskId = typeof data.taskId === "string" ? data.taskId : undefined;
    if (!taskId) return undefined;
    const task = await api.task(taskId);
    const body = selectedEvent === "taskCreated" ? "A new task was added."
      : selectedEvent === "taskNeedsInput" ? "Codex needs your input to continue."
        : selectedEvent === "taskReady" ? "The plan is ready for approval."
          : selectedEvent === "taskReview" ? "Execution finished and is ready for review."
            : selectedEvent === "taskCompleted" ? "The task was marked as done."
              : task.error || "The task stopped because of an error.";
    return {
      event: selectedEvent,
      title: task.title,
      body,
      tag: `boosted:${api.profileId}:task:${task.id}`,
      data: { kind: "task", id: task.id, url: notificationUrl("task", task.id) },
    };
  }

  if (selectedEvent === "codexCompleted" || selectedEvent === "codexFailed") {
    const threadId = typeof data.threadId === "string" ? data.threadId : undefined;
    if (!threadId) return undefined;
    const thread = await api.codexChat(threadId);
    return {
      event: selectedEvent,
      title: thread.chat.title || "Codex chat",
      body: selectedEvent === "codexFailed" ? "The Codex chat stopped because of an error." : "The Codex chat finished.",
      tag: `boosted:${api.profileId}:codex:${threadId}`,
      data: { kind: "codex", id: threadId, url: notificationUrl("codex", threadId) },
    };
  }

  const projectId = typeof data.projectId === "string" ? data.projectId : undefined;
  const integrationId = typeof data.integrationId === "string" ? data.integrationId : undefined;
  if (!projectId || !integrationId) return undefined;
  const integrations = await api.integrations(projectId);
  const integration = integrations.find((entry) => entry.id === integrationId);
  const imported = Number(data.imported ?? 0);
  const failed = Number(data.failed ?? 0);
  const error = typeof data.error === "string" ? data.error : undefined;
  return {
    event: selectedEvent,
    title: integration?.name || "Integration sync",
    body: selectedEvent === "integrationFailed"
      ? error || `Sync finished with ${failed} failed item${failed === 1 ? "" : "s"}.`
      : `Sync completed${imported > 0 ? ` with ${imported} imported item${imported === 1 ? "" : "s"}` : ""}.`,
    tag: `boosted:${api.profileId}:integration:${integrationId}`,
    data: { kind: "integration", id: integrationId, url: "/" },
  };
}

export async function notifyForLiveEvent(event: LiveEvent, api: BoostedApiClient) {
  const selectedEvent = notificationEventId(event);
  if (!selectedEvent || notificationPermission() !== "granted") return false;
  const settings = readNotificationSettings(api.profileId);
  if (!settings.enabled || !settings.events.includes(selectedEvent)) return false;
  if (settings.delivery === "background" && document.visibilityState === "visible" && document.hasFocus()) return false;
  try {
    const content = await buildNotificationForEvent(event, api);
    return content ? showPwaNotification(content) : false;
  } catch {
    return false;
  }
}
