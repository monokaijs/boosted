import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Project } from "@/lib/types";
import { ProjectIconEditor } from "./project-icon-editor";

const mocks = vi.hoisted(() => ({ updateProjectIcon: vi.fn(), avatarFromFile: vi.fn() }));
vi.mock("@/lib/api", () => ({ getActiveApiClient: () => mocks }));
vi.mock("@/features/agents/lib/agent-avatar", () => ({ avatarFromFile: mocks.avatarFromFile }));

const project: Project = { id: "alpha", name: "alpha", repoPath: "/alpha", defaultBranch: "main", createdAt: "2026-10-06" };
afterEach(cleanup);
beforeEach(() => vi.resetAllMocks());

function setup(icon?: string) {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  client.setQueryData(["projects"], [{ ...project, icon }]);
  const view = render(<QueryClientProvider client={client}><ProjectIconEditor project={{ ...project, icon }} /></QueryClientProvider>);
  return { client, ...view };
}

it("uploads an image and updates the project cache", async () => {
  mocks.avatarFromFile.mockResolvedValue("data:image/webp;base64,icon");
  mocks.updateProjectIcon.mockResolvedValue({ ...project, icon: "data:image/webp;base64,icon" });
  const { client } = setup();
  const file = new File(["image"], "icon.png", { type: "image/png" });
  fireEvent.change(screen.getByLabelText("Upload project icon"), { target: { files: [file] } });
  await waitFor(() => expect(mocks.updateProjectIcon).toHaveBeenCalledWith("alpha", "data:image/webp;base64,icon"));
  await waitFor(() => expect(client.getQueryData<Project[]>(["projects"])?.[0].icon).toBe("data:image/webp;base64,icon"));
});

it("removes the saved icon", async () => {
  mocks.updateProjectIcon.mockResolvedValue({ ...project, icon: null });
  const { client } = setup("data:image/webp;base64,icon");
  fireEvent.click(screen.getByRole("button", { name: "Remove icon" }));
  await waitFor(() => expect(mocks.updateProjectIcon).toHaveBeenCalledWith("alpha", null));
  await waitFor(() => expect(client.getQueryData<Project[]>(["projects"])?.[0].icon).toBeNull());
});

it("shows invalid image errors without saving", async () => {
  mocks.avatarFromFile.mockRejectedValue(new Error("Choose a PNG, JPEG, or WebP image."));
  const { client } = setup();
  fireEvent.change(screen.getByLabelText("Upload project icon"), { target: { files: [new File(["text"], "icon.txt", { type: "text/plain" })] } });
  expect(await screen.findByRole("alert")).toHaveTextContent("Choose a PNG, JPEG, or WebP image.");
  expect(mocks.updateProjectIcon).not.toHaveBeenCalled();
  expect(client.getQueryData<Project[]>(["projects"])?.[0].icon).toBeUndefined();
});
