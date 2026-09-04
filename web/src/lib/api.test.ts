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

  it("revokes the current server session on explicit sign-out", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await client("https://boosted.example", { token: "machine-token" }).logout();

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://boosted.example/api/v1/auth/session");
    expect(init?.method).toBe("DELETE");
    expect((init?.headers as Headers).get("Authorization")).toBe("Bearer machine-token");
  });

  it("posts draft integration credentials to the workspace discovery endpoint", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ targets: [] }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const api = client("https://boosted.example", { token: "machine-token" });

    await api.discoverIntegrationTargets("workspace-a", {
      provider: "gitlab",
      config: { baseUrl: "https://gitlab.example", token: "gitlab-token" },
    });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://boosted.example/api/v1/projects/workspace-a/integrations/discover");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({
      provider: "gitlab",
      config: { baseUrl: "https://gitlab.example", token: "gitlab-token" },
    });
  });

  it("uses authenticated REST and WebSocket paths for Remote Viewer", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      id: "viewer-a",
      source: { id: "source-a", kind: "window", name: "Simulator", width: 1280, height: 720, scale: 2 },
      effectiveCodec: "h264",
      effectiveFps: 30,
      width: 1280,
      height: 720,
      audioEnabled: true,
    }), { status: 201, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const api = client("https://boosted.example", { token: "machine-token" });

    await api.createRemoteViewerSession({ sourceId: "source-a", fps: 30, resolution: "1080p" });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://boosted.example/api/v1/remote-viewer/sessions");
    expect(init?.method).toBe("POST");
    expect((init?.headers as Headers).get("Authorization")).toBe("Bearer machine-token");
    expect(api.webSocket("/remote-viewer/sessions/viewer-a/media")).toBe("wss://boosted.example/api/v1/remote-viewer/sessions/viewer-a/media");
    expect(api.webSocket("/remote-viewer/sessions/viewer-a/control")).toBe("wss://boosted.example/api/v1/remote-viewer/sessions/viewer-a/control");
  });

  it("fetches generated chat files through the authenticated remote server", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(new Blob(["report"]), {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": "inline; filename=\"report.pdf\"",
      },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const api = client("https://boosted.example", { token: "machine-token" });

    const file = await api.workspaceFile({ kind: "codex", id: "thread/a" }, "/srv/workspace/report final.pdf");

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://boosted.example/api/v1/codex/chats/thread%2Fa/file?path=%2Fsrv%2Fworkspace%2Freport%20final.pdf");
    expect((init?.headers as Headers).get("Authorization")).toBe("Bearer machine-token");
    expect(file.name).toBe("report.pdf");
    expect(file.blob.type).toBe("application/pdf");
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
