import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useBoostedApiClient } from "@/lib/api-context";
import { conversationKey, useUnreadStore, type ConversationKind } from "@/lib/unread-conversations";
import { assistantSummary } from "@/features/agents/lib/assistant-state";
import type { AssistantState, AssistantSummary } from "@/features/agents/types/assistant";
import type { GroupState, GroupSummary } from "@/features/groups/types";
import type { CodexChat, CodexChatThread } from "@/lib/types";

export function useConversationReadState(active?: { kind: ConversationKind; id: string }) {
  const { profileId } = useBoostedApiClient();
  const client = useQueryClient();
  const key = active ? conversationKey(active.kind, active.id) : undefined;

  useEffect(() => {
    const sync = () => useUnreadStore.getState().activate(profileId,
      document.visibilityState === "visible" && document.hasFocus() ? key : undefined);
    sync();
    window.addEventListener("focus", sync);
    window.addEventListener("blur", sync);
    document.addEventListener("visibilitychange", sync);
    return () => {
      window.removeEventListener("focus", sync);
      window.removeEventListener("blur", sync);
      document.removeEventListener("visibilitychange", sync);
      useUnreadStore.getState().activate(profileId);
    };
  }, [profileId, key]);

  useEffect(() => {
    const observe = (queryKey: readonly unknown[], data: unknown) => {
      const store = useUnreadStore.getState();
      if (data && queryKey[0] === "assistant-state") {
        const agent = assistantSummary(data as AssistantState);
        store.observe(profileId, "agent", agent.id, agent.lastMessageAt ?? "");
      }
      if (data && queryKey[0] === "groups" && queryKey.length === 2) {
        const group = data as GroupState;
        const lastMessage = group.messages?.filter((message) => message.senderType === "agent" && message.content.trim()).at(-1);
        store.observe(profileId, "group", group.id, lastMessage?.createdAt ?? "");
      }
      if (data && queryKey[0] === "codex-chat") {
        const thread = data as CodexChatThread;
        store.observe(profileId, "codex", thread.chat.id, thread.chat.updatedAt);
      }
      if (!Array.isArray(data)) return;
      if (queryKey[0] === "agents") for (const agent of data as AssistantSummary[]) store.observe(profileId, "agent", agent.id, agent.lastMessageAt ?? "");
      if (queryKey[0] === "groups" && queryKey.length === 1) for (const group of data as GroupSummary[]) store.observe(profileId, "group", group.id, group.lastMessageAt ?? "");
      if (queryKey[0] === "codex-chats") for (const chat of data as CodexChat[]) store.observe(profileId, "codex", chat.id, chat.updatedAt);
    };
    for (const query of client.getQueryCache().getAll()) observe(query.queryKey, query.state.data);
    return client.getQueryCache().subscribe((event) => {
      if (event.type === "updated" && event.action.type === "success") observe(event.query.queryKey, event.query.state.data);
    });
  }, [client, profileId]);
}
