import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { getToken } from "@/lib/api";
import { useBoostedApiClient } from "@/lib/api-context";
import type { LiveEvent } from "@/lib/types";

export function useLiveEvents() {
  const api = useBoostedApiClient();
  const queryClient = useQueryClient();
  const retryRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    let disposed = false;
    let socket: WebSocket | undefined;

    const connect = () => {
      if (disposed || !getToken()) return;
      const connection = new WebSocket(api.webSocket("/ws"));
      socket = connection;
      connection.addEventListener("open", () => connection.send(JSON.stringify({ type: "authenticate", token: getToken() })));
      connection.addEventListener("message", (message) => {
        try {
          const event = JSON.parse(message.data) as LiveEvent;
          if (event.topic.startsWith("task.")) {
            void queryClient.invalidateQueries({ queryKey: ["tasks"] });
            const taskId = (event.data as { taskId?: string })?.taskId;
            if (taskId) {
              void queryClient.invalidateQueries({ queryKey: ["task", taskId] });
              void queryClient.invalidateQueries({ queryKey: ["events", taskId] });
              void queryClient.invalidateQueries({ queryKey: ["git", taskId] });
              void queryClient.invalidateQueries({ queryKey: ["files", taskId] });
            }
          }
          if (event.topic.startsWith("project.")) void queryClient.invalidateQueries({ queryKey: ["projects"] });
          if (event.topic.startsWith("integration.")) void queryClient.invalidateQueries({ queryKey: ["integrations"] });
          if (event.topic === "codex.event") {
            window.dispatchEvent(new CustomEvent("boosted:codex-event", { detail: event.data }));
            const data = event.data as { threadId?: string; method?: string };
            if (data.method === "turn/completed" && data.threadId) {
              void queryClient.invalidateQueries({ queryKey: ["codex-chat", data.threadId] });
              void queryClient.invalidateQueries({ queryKey: ["codex-chats"] });
            }
          }
        } catch {
          // Ignore malformed extension events while preserving the stream.
        }
      });
      connection.addEventListener("close", () => {
        if (!disposed && socket === connection) retryRef.current = window.setTimeout(connect, 1_500);
      });
    };

    const resume = () => {
      if (retryRef.current) window.clearTimeout(retryRef.current);
      const previous = socket;
      socket = undefined;
      previous?.close();
      retryRef.current = window.setTimeout(connect, 50);
    };

    connect();
    window.addEventListener("boosted:resume", resume);
    return () => {
      disposed = true;
      window.removeEventListener("boosted:resume", resume);
      if (retryRef.current) window.clearTimeout(retryRef.current);
      socket?.close();
    };
  }, [api, queryClient]);
}
