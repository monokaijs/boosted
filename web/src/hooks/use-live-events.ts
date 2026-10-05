import { forgetGroup } from "@/features/groups/lifecycle";
import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { getToken } from "@/lib/api";
import { useBoostedApiClient } from "@/lib/api-context";
import { notifyForLiveEvent } from "@/lib/notifications";
import { setCachedChatStatus } from "@/lib/codex-chat-status";
import { applyCodexEvent } from "@/lib/codex-chat-state";
import { useUnreadStore } from "@/lib/unread-conversations";
import { assistantSummary, shouldAcceptAssistantState } from "@/features/agents/lib/assistant-state";
import type { AssistantState, AssistantSummary } from "@/features/agents/types/assistant";
import type { CodexLiveEvent, LiveEvent } from "@/lib/types";

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
      connection.addEventListener("open", () => {
        connection.send(JSON.stringify({ type: "authenticate", token: getToken() }));
        void queryClient.invalidateQueries({ queryKey: ["groups"] });
        // Recover updates missed during a socket disconnect, including hidden views.
        for (const kind of ["codex-chat", "codex-chats", "agents", "assistant-state", "task", "events"]) {
          void queryClient.invalidateQueries({ queryKey: [kind] });
        }
      });
      connection.addEventListener("message", (message) => {
        try {
          const event = JSON.parse(message.data) as LiveEvent;
          void notifyForLiveEvent(event, api);
          if (event.topic === "assistant.message") {
            const data = event.data as { agentId?: string; content?: string };
            if (data.agentId && data.content?.trim()) useUnreadStore.getState().receive(api.profileId, "agent", data.agentId);
          }
          if (event.topic === "group.deleted") {
            const id = (event.data as { groupId?: string }).groupId;
            if (id) forgetGroup(queryClient, id, api.profileId);
          } else if (event.topic.startsWith("group.")) void queryClient.invalidateQueries({ queryKey: ["groups"] });
          if (event.topic === "assistant.updated") {
            const next = event.data as AssistantState;
            const key = ["assistant-state", next.id];
            const current = queryClient.getQueryData<AssistantState>(key);
            if (current && shouldAcceptAssistantState(current, next, next.id)) {
              void queryClient.cancelQueries({ queryKey: key, exact: true });
              queryClient.setQueryData(key, next);
            }
            queryClient.setQueryData<AssistantSummary[]>(["agents"], (agents) => agents?.map((current) =>
              current.id === next.id && shouldAcceptAssistantState(current, next, next.id) ? assistantSummary(next) : current));
            window.dispatchEvent(new CustomEvent("boosted:assistant-updated", { detail: event.data }));
          }
          if (event.topic === "provider-chats.updated") void queryClient.invalidateQueries({ queryKey: ["codex-chats"] });
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
          if (event.topic === "codex.approval") {
            const data = event.data as { threadId?: string; requestId?: unknown };
            if (data.threadId) {
              if (data.requestId !== undefined) setCachedChatStatus(queryClient, data.threadId, "needs_input");
              void queryClient.invalidateQueries({ queryKey: ["codex-approvals", data.threadId] });
              void queryClient.invalidateQueries({ queryKey: ["codex-chats"] });
              void queryClient.invalidateQueries({ queryKey: ["codex-chat", data.threadId] });
            }
          }
          if (event.topic === "codex.event") {
            const incoming = event.data as CodexLiveEvent;
            if ((incoming.method === "item/agentMessage/delta" && incoming.delta) ||
              (incoming.method === "item/completed" && incoming.message?.role === "assistant" && incoming.message.kind === "message" && incoming.message.content.trim())) {
              useUnreadStore.getState().receive(api.profileId, "codex", incoming.threadId);
            }
            applyCodexEvent(queryClient, event.data as CodexLiveEvent);
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
