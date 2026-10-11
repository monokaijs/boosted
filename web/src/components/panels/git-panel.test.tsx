import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "@/lib/store";
import type { GitCommit, GitStatus } from "@/lib/types";

const api = vi.hoisted(() => ({ gitStatus: vi.fn(), gitHistory: vi.fn(), gitDiff: vi.fn(), gitStage: vi.fn(), gitUnstage: vi.fn(), gitDiscard: vi.fn(), gitCommit: vi.fn() }));
vi.mock("@/lib/api", () => ({ api }));
import { GitPanel } from "./git-panel";

const status: GitStatus = { branch: "main", ahead: 0, behind: 0, changes: [{ path: "file.txt", indexStatus: " ", worktreeStatus: "M", additions: 1, deletions: 1 }] };
const history: GitCommit[] = [{ hash: "abcdef1234567890", shortHash: "abcdef1", subject: "fix: latest change", authorName: "Test User", authorEmail: "test@example.com", authoredAt: "2026-10-09T00:00:00Z" }];
function renderPanel() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><GitPanel /></QueryClientProvider>);
}

afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  useAppStore.setState({ selectedProjectId: "alpha", selectedTaskId: undefined, gitDiffTarget: undefined });
  api.gitStatus.mockResolvedValue(status);
  api.gitHistory.mockResolvedValue(history);
  api.gitDiff.mockResolvedValue({ diff: "@@ -1 +1 @@\n-old\n+new" });
  api.gitStage.mockResolvedValue(status);
  api.gitUnstage.mockResolvedValue(status);
  api.gitDiscard.mockResolvedValue(status);
  api.gitCommit.mockResolvedValue({ commit: "abcdef" });
});

describe("project Changes panel", () => {
  it("loads project changes and history without a task and keeps the draft across task switches", async () => {
    renderPanel();
    expect(await screen.findByText("file.txt")).toBeInTheDocument();
    expect(await screen.findByText("fix: latest change")).toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText("Commit message"), { target: { value: "fix: update file" } });
    act(() => useAppStore.setState({ selectedTaskId: "task-one" }));
    act(() => useAppStore.setState({ selectedTaskId: "task-two" }));
    expect(screen.getByText("fix: latest change")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Commit message")).toHaveValue("fix: update file");
    expect(api.gitStatus).toHaveBeenCalledWith("alpha");
    expect(api.gitHistory).toHaveBeenCalledWith("alpha");
    expect(screen.queryByText("Select a changed file to inspect its diff.")).not.toBeInTheDocument();
  });

  it("resets the commit draft and reloads history when switching projects", async () => {
    renderPanel();
    await screen.findByText("fix: latest change");
    fireEvent.change(screen.getByPlaceholderText("Commit message"), { target: { value: "alpha draft" } });
    act(() => useAppStore.setState({ selectedProjectId: "beta" }));
    await waitFor(() => expect(api.gitStatus).toHaveBeenCalledWith("beta"));
    await waitFor(() => expect(api.gitHistory).toHaveBeenCalledWith("beta"));
    expect(screen.getByPlaceholderText("Commit message")).toHaveValue("");
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
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    fireEvent.click(screen.getByTitle("Discard file.txt"));
    await waitFor(() => expect(api.gitDiscard).toHaveBeenCalledWith("alpha", ["file.txt"]));
    confirm.mockRestore();
  });

  it("opens a selected file diff in the secondary pane", async () => {
    renderPanel();
    fireEvent.click((await screen.findByText("file.txt")).closest("button")!);
    const pane = await screen.findByRole("region", { name: "Diff for file.txt" });
    expect(api.gitDiff).toHaveBeenCalledWith("alpha", "file.txt", false);
    await waitFor(() => expect(pane).toHaveTextContent("-old"));
    expect(pane).toHaveTextContent("+new");
    fireEvent.click(within(pane).getByRole("button", { name: "Close diff" }));
    expect(await screen.findByText("fix: latest change")).toBeInTheDocument();
  });

  it("shows a recorded run patch without replacing it with the current repository diff", async () => {
    useAppStore.setState({ gitDiffTarget: { path: "historical.ts", staged: false, diff: "@@ -1 +1 @@\n-before\n+after" } });
    renderPanel();
    const pane = await screen.findByRole("region", { name: "Diff for historical.ts" });
    expect(pane).toHaveTextContent("-before");
    expect(pane).toHaveTextContent("+after");
    expect(api.gitDiff).not.toHaveBeenCalled();
  });

  it("asks for a project and makes no Git requests when only a task is selected", () => {
    useAppStore.setState({ selectedProjectId: undefined, selectedTaskId: "task-one" });
    renderPanel();
    expect(screen.getByText("Select a project to review its Git changes.")).toBeInTheDocument();
    expect(api.gitStatus).not.toHaveBeenCalled();
    expect(api.gitHistory).not.toHaveBeenCalled();
  });
});
