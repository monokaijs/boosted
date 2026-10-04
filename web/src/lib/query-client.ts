import { QueryClient, type Query } from "@tanstack/react-query";

export const conversationQueryOptions = { staleTime: 30_000, gcTime: 120_000 };
const MAX_INACTIVE_CONVERSATIONS = 8;
const MAX_INACTIVE_TEXT_BYTES = 16 * 1024 * 1024;

function isConversation(query: Query) {
  const [kind] = query.queryKey;
  return kind === "codex-chat" || kind === "assistant-state" || kind === "events" || (kind === "groups" && query.queryKey.length === 2);
}

function textBytes(value: unknown): number {
  if (typeof value === "string") return value.length * 2;
  if (Array.isArray(value)) return value.reduce((size, item) => size + textBytes(item), 0);
  if (value && typeof value === "object") return Object.values(value).reduce<number>((size, item) => size + textBytes(item), 0);
  return 0;
}

// Active and in-flight queries are protected. The byte budget measures retained
// text, not total JS heap, and deliberately permits a large active conversation.
export function pruneConversationCache(client: QueryClient) {
  const inactive = client.getQueryCache().getAll().filter((query) => isConversation(query) && query.getObserversCount() === 0 && query.state.fetchStatus === "idle")
    .sort((a, b) => b.state.dataUpdatedAt - a.state.dataUpdatedAt);
  let bytes = 0;
  for (const [index, query] of inactive.entries()) {
    bytes += textBytes(query.state.data);
    if (index >= MAX_INACTIVE_CONVERSATIONS || bytes > MAX_INACTIVE_TEXT_BYTES) client.removeQueries({ queryKey: query.queryKey, exact: true });
  }
}

export function createWorkspaceQueryClient() {
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: 30_000, gcTime: 120_000, retry: 1, refetchOnWindowFocus: false } } });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const unsubscribe = client.getQueryCache().subscribe((event) => {
    if (!isConversation(event.query) || event.type === "removed" || timer !== undefined) return;
    // Streaming deltas must not scan all cached histories on every token.
    timer = setTimeout(() => { timer = undefined; pruneConversationCache(client); }, 1000);
  });
  return {
    client,
    dispose: () => {
      unsubscribe();
      clearTimeout(timer);
      client.clear();
    },
  };
}
