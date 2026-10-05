import { act, cleanup, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useUnreadStore } from "@/lib/unread-conversations";
import { useConversationReadState } from "./use-conversation-read-state";

vi.mock("@/lib/api-context", () => ({ useBoostedApiClient: () => ({ profileId: "machine" }) }));
beforeEach(() => {
  localStorage.clear();
  useUnreadStore.setState({ profiles: {}, active: undefined });
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("visible conversation read tracking", () => {
  it("tracks incoming group snapshots while preserving unread state in the background", () => {
    const client = new QueryClient();
    const wrapper = ({ children }: { children: React.ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
    renderHook(() => useConversationReadState({ kind: "group", id: "team" }), { wrapper });
    act(() => client.setQueryData(["groups"], [{ id: "team", lastMessageAt: null }]));
    act(() => client.setQueryData(["groups"], [{ id: "team", lastMessageAt: "2026-10-05T09:00:00Z" }]));
    expect(useUnreadStore.getState().profiles.machine["group:team"].unread).toBe(false);
    vi.mocked(document.hasFocus).mockReturnValue(false);
    act(() => window.dispatchEvent(new Event("blur")));
    act(() => client.setQueryData(["groups"], [{ id: "team", lastMessageAt: "2026-10-05T09:01:00Z" }]));
    expect(useUnreadStore.getState().profiles.machine["group:team"].unread).toBe(true);
    vi.mocked(document.hasFocus).mockReturnValue(true);
    act(() => window.dispatchEvent(new Event("focus")));
    expect(useUnreadStore.getState().profiles.machine["group:team"].unread).toBe(false);
  });
});
