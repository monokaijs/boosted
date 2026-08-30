import { useEffect } from "react";
import { useBoostedApiClient } from "@/lib/api-context";
import { useAppStore } from "@/lib/store";

type NotificationClickData = {
  kind?: "task" | "codex" | "integration";
  id?: string;
};

export function useNotificationNavigation() {
  const api = useBoostedApiClient();

  useEffect(() => {
    async function openNotification(data: NotificationClickData) {
      if (!data.id) return;
      if (data.kind === "task") {
        const task = await api.task(data.id);
        const store = useAppStore.getState();
        store.selectTask(task);
        store.setTaskDrawerOpen(true);
        window.dispatchEvent(new CustomEvent("boosted:show-drawer", { detail: "tasks" }));
        return;
      }
      if (data.kind === "codex") {
        const [thread, projects] = await Promise.all([api.codexChat(data.id), api.projects()]);
        const project = projects.find((entry) => entry.repoPath === thread.chat.cwd);
        if (project) useAppStore.getState().selectProject(project);
        useAppStore.getState().selectCodexChat(data.id);
        window.dispatchEvent(new CustomEvent("boosted:open-codex-chat", { detail: { threadId: data.id, title: thread.chat.title } }));
      }
    }

    const message = (event: MessageEvent<{ type?: string; data?: NotificationClickData }>) => {
      if (event.data?.type === "boosted:notification-click" && event.data.data) void openNotification(event.data.data).catch(() => undefined);
    };
    navigator.serviceWorker?.addEventListener("message", message);

    const params = new URLSearchParams(window.location.search);
    const kind = params.get("notification");
    const id = params.get("notificationId");
    if ((kind === "task" || kind === "codex") && id) {
      void openNotification({ kind, id }).catch(() => undefined);
      params.delete("notification");
      params.delete("notificationId");
      const search = params.toString();
      window.history.replaceState(window.history.state, "", `${window.location.pathname}${search ? `?${search}` : ""}${window.location.hash}`);
    }

    return () => navigator.serviceWorker?.removeEventListener("message", message);
  }, [api]);
}
