import { StrictMode } from "react";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createBoostedApiClient } from "@/lib/api";
import { ApiClientProvider, useBoostedApiClient } from "@/lib/api-context";

function client(id = "local") {
  return createBoostedApiClient({
    profile: { id, baseUrl: "http://127.0.0.1:4782" },
    getToken: () => undefined,
  });
}

function Setup() {
  const api = useBoostedApiClient();
  const setup = useQuery({ queryKey: ["setup"], queryFn: api.setupState, retry: false });
  return <p>{setup.isError ? setup.error.message : setup.data ? "Connected" : "Connecting"}</p>;
}

describe("machine API lifecycle", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("completes startup through StrictMode's effect cleanup and replay", async () => {
    const api = client();
    const cancel = vi.spyOn(api, "cancelRequests");
    vi.stubGlobal("fetch", vi.fn<typeof fetch>((_input, init) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve(new Response(JSON.stringify({ needsSetup: false }))), 20);
      init?.signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(new DOMException("aborted", "AbortError"));
      }, { once: true });
    })));
    const queryClient = new QueryClient();
    const view = render(
      <StrictMode>
        <ApiClientProvider client={api}>
          <QueryClientProvider client={queryClient}><Setup /></QueryClientProvider>
        </ApiClientProvider>
      </StrictMode>,
    );

    expect(await screen.findByText("Connected")).toBeInTheDocument();
    expect(cancel).not.toHaveBeenCalled();

    view.unmount();
    await waitFor(() => expect(cancel).toHaveBeenCalledOnce());
    queryClient.clear();
  });

  it("cancels pending requests on a real unmount", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>((_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    })));
    const api = client();
    const view = render(<StrictMode><ApiClientProvider client={api}>Workspace</ApiClientProvider></StrictMode>);
    const request = api.projects();
    const canceled = expect(request).rejects.toMatchObject({ status: 408 });

    view.unmount();

    await canceled;
  });

  it("disposes the previous client when switching machines", async () => {
    const previous = client("previous");
    const current = client("current");
    const cancelPrevious = vi.spyOn(previous, "cancelRequests");
    const cancelCurrent = vi.spyOn(current, "cancelRequests");
    const view = render(<ApiClientProvider client={previous}>Workspace</ApiClientProvider>);

    view.rerender(<ApiClientProvider client={current}>Workspace</ApiClientProvider>);

    await waitFor(() => expect(cancelPrevious).toHaveBeenCalledOnce());
    expect(cancelCurrent).not.toHaveBeenCalled();
    view.unmount();
    await waitFor(() => expect(cancelCurrent).toHaveBeenCalledOnce());
  });
});
