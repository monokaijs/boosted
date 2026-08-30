import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, createBoostedApiClient } from "@/lib/api";

function client(baseUrl = "http://machine.lan:4782", options: { token?: string; unauthorized?: () => void } = {}) {
  return createBoostedApiClient({
    profile: { id: "machine-a", baseUrl },
    getToken: () => options.token,
    onUnauthorized: options.unauthorized,
  });
}

describe("Boosted API client", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("constructs HTTP and WebSocket URLs from the same machine origin", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const api = client("https://boosted.example", { token: "machine-token" });

    await api.projects();

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://boosted.example/api/v1/projects");
    expect((init?.headers as Headers).get("Authorization")).toBe("Bearer machine-token");
    expect(api.webSocket("/terminals/terminal-a/ws")).toBe("wss://boosted.example/api/v1/terminals/terminal-a/ws");
    expect(client().webSocket("/ws")).toBe("ws://machine.lan:4782/api/v1/ws");
  });

  it("classifies timeouts and network failures", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new DOMException("aborted", "AbortError"); }));
    await expect(client().health()).rejects.toMatchObject({ status: 408, message: "Connection timed out." });

    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch"); }));
    await expect(client().health()).rejects.toMatchObject({ status: 0, message: "Failed to fetch" });
  });

  it("runs only that client's unauthorized handler on a 401", async () => {
    const tokens: Record<string, string | undefined> = { a: "token-a", b: "token-b" };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "expired" }), { status: 401 })));

    await expect(client("http://a.lan", { unauthorized: () => { tokens.a = undefined; } }).me()).rejects.toEqual(new ApiError(401, "expired"));

    expect(tokens).toEqual({ a: undefined, b: "token-b" });
  });

  it("aborts this client's outstanding requests when its workspace is disposed", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    })));
    const api = client();
    const request = api.projects();

    api.cancelRequests();

    await expect(request).rejects.toMatchObject({ status: 408 });
  });
});
