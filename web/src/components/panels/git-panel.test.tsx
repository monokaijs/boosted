import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "@/lib/store";
import type { GitStatus } from "@/lib/types";

const api = vi.hoisted(() => ({ gitStatus: vi.fn(), gitDiff: vi.fn(), gitStage: vi.fn(), gitUnstage: vi.fn(), gitDiscard: vi.fn(), gitCommit: vi.fn() }));
vi.mock("@/lib/api", () => ({ api }));
import { GitPanel } from "./git-panel";

const status: GitStatus = { branch: "main", ahead: 0, behind: 0, changes: [{ path: "file.txt", indexStatus: " ", worktreeStatus: "M", additions: 1, deletions: 1 }] };
function renderPanel() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><GitPanel /></QueryClientProvider>);
}

afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  useAppStore.setState({ selectedProjectId: "alpha", selectedTaskId: undefined });
  api.gitStatus.mockResolvedValue(status);
  api.gitDiff.mockImplementation(async (projectId: string) => ({ diff: `+${projectId} change` }));
  api.gitStage.mockResolvedValue(status);
  api.gitUnstage.mockResolvedValue(status);
  api.gitDiscard.mockResolvedValue(status);
  api.gitCommit.mockResolvedValue({ commit: "abcdef" });
});

describe("project Changes panel", () => {
  it("loads project changes without a task and keeps the diff and draft across task switches", async () => {
    renderPanel();
    fireEvent.click(await screen.findByText("file.txt"));
    expect(await screen.findByText("+alpha change")).toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText("Commit message"), { target: { value: "fix: update file" } });
    act(() => useAppStore.setState({ selectedTaskId: "task-one" }));
    act(() => useAppStore.setState({ selectedTaskId: "task-two" }));
    expect(screen.getByText("+alpha change")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Commit message")).toHaveValue("fix: update file");
    expect(api.gitStatus).toHaveBeenCalledWith("alpha");
    expect(api.gitDiff).toHaveBeenCalledWith("alpha", "file.txt", false);
  });

  it("resets the diff and commit draft when switching projects", async () => {
    renderPanel();
    fireEvent.click(await screen.findByText("file.txt"));
    await screen.findByText("+alpha change");
    fireEvent.change(screen.getByPlaceholderText("Commit message"), { target: { value: "alpha draft" } });
    act(() => useAppStore.setState({ selectedProjectId: "beta" }));
    await waitFor(() => expect(api.gitStatus).toHaveBeenCalledWith("beta"));
    expect(screen.getByPlaceholderText("Commit message")).toHaveValue("");
    expect(screen.queryByText("+alpha change")).not.toBeInTheDocument();
    fireEvent.click(await screen.findByText("file.txt"));
    expect(await screen.findByText("+beta change")).toBeInTheDocument();
    expect(api.gitDiff).toHaveBeenLastCalledWith("beta", "file.txt", false);
  });

  it("stages, unstages, commits, and discards using the project ID even with a selected task", async () => {
    useAppStore.setState({ selectedTaskId: "task-one" });
    api.gitStatus.mockResolvedValue({ ...status, changes: [...status.changes, { ...status.changes[0], path: "staged.txt", indexStatus: "M", worktreeStatus: " " }] });
    renderPanel();
    fireEvent.click(await screen.findByTitle("Stage all"));
    await waitFor(() => expect(api.gitStage).toHaveBeenCalledWith("alpha", ["file.txt"]));
    fireEvent.click(screen.getByTitle("Unstage all"));
    await waitFor(() => expect(api.gitUnstage).toHaveBeenCalledWith("alpha", ["staged.txt"]));
    fireEvent.change(screen.getByPlaceholderText("Commit message"), { target: { value: "fix: project change" } });
    fireEvent.click(screen.getByRole("button", { name: "Commit 1" }));
    await waitFor(() => expect(api.gitCommit).toHaveBeenCalledWith("alpha", "fix: project change"));
    fireEvent.click(screen.getByText("file.txt"));
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    await waitFor(() => expect(api.gitDiscard).toHaveBeenCalledWith("alpha", ["file.txt"]));
    confirm.mockRestore();
  });

  it("asks for a project and makes no Git requests when only a task is selected", () => {
    useAppStore.setState({ selectedProjectId: undefined, selectedTaskId: "task-one" });
    renderPanel();
    expect(screen.getByText("Select a project to review its Git changes.")).toBeInTheDocument();
    expect(api.gitStatus).not.toHaveBeenCalled();
  });
});
