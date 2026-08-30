import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { apiWebSocket, getToken } from "@/lib/api";
import type { LiveEvent } from "@/lib/types";

export function useLiveEvents() {
  const queryClient = useQueryClient();
  const retryRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    let disposed = false;
    let socket: WebSocket | undefined;

    const connect = () => {
      if (disposed || !getToken()) return;
      socket = new WebSocket(apiWebSocket("/ws"));
      socket.addEventListener("open", () => socket?.send(JSON.stringify({ type: "authenticate", token: getToken() })));
      socket.addEventListener("message", (message) => {
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
      socket.addEventListener("close", () => {
        if (!disposed) retryRef.current = window.setTimeout(connect, 1_500);
      });
    };

    connect();
    return () => {
      disposed = true;
      if (retryRef.current) window.clearTimeout(retryRef.current);
      socket?.close();
    };
  }, [queryClient]);
}
