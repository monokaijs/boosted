import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import ReactMarkdown from "react-markdown";
import { ApiClientProvider } from "@/lib/api-context";
import { createBoostedApiClient } from "@/lib/api";
import { useMachineStore } from "@/lib/machines";
import { WorkspaceAttachment, WorkspaceFileProvider, workspaceFileMarkdownComponents, workspaceMarkdownUrlTransform } from "./workspace-file-markdown";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); useMachineStore.setState({ profiles: [], activeId: undefined, tokens: {} }); });

it.each([false, true])("fetches preview files with the conversation machine's URL and token (upload: %s)", async (upload) => {
  // A global machine selection must not redirect this mounted conversation's files.
  useMachineStore.setState({ profiles: [{ id: "other", name: "Other", baseUrl: "http://localhost:4782", createdAt: "now" }], activeId: "other", tokens: { other: "other-token" } });
  const client = createBoostedApiClient({ profile: { id: "remote", baseUrl: "https://remote.example" }, getToken: () => "remote-token" });
  const fetchMock = vi.fn(async () => new Response(new Blob(["pdf"], { type: "application/pdf" }), { headers: { "Content-Type": "application/pdf" } }));
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: vi.fn(() => "blob:remote-preview"), revokeObjectURL: vi.fn() }));
  render(<ApiClientProvider client={client}><WorkspaceFileProvider scope={{ kind: "codex", id: "remote-chat" }}>
    {upload ? <WorkspaceAttachment attachment={{ name: "report.pdf", uploadId: "upload.pdf" }} />
      : <ReactMarkdown components={workspaceFileMarkdownComponents} urlTransform={workspaceMarkdownUrlTransform}>{"[Report](/srv/project/report.pdf)"}</ReactMarkdown>}
  </WorkspaceFileProvider></ApiClientProvider>);
  fireEvent.click(screen.getByRole("button", { name: "View report.pdf" }));
  await screen.findByTitle("Preview report.pdf");
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
  expect(url).toBe(upload ? "https://remote.example/api/v1/codex/attachments/upload.pdf" : "https://remote.example/api/v1/codex/chats/remote-chat/file?path=%2Fsrv%2Fproject%2Freport.pdf");
  expect((init.headers as Headers).get("Authorization")).toBe("Bearer remote-token");
});
