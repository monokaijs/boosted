import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "@/lib/store";
import type { Task } from "@/lib/types";

const api = vi.hoisted(() => ({ tasks: vi.fn(), projects: vi.fn(), setTaskStatus: vi.fn() }));
vi.mock("@/lib/api", () => ({ api }));
import { BoardsPanel, TasksPanel } from "./taskboard-panel";

const task: Task = {
  id: "task-a", projectId: "project-a", title: "Simplify the task page", description: "Use a divided list.", status: "queued",
  branchName: "boosted/task-a", worktreePath: "/repo", baseBranch: "main", accessMode: "fullAccess", createdBy: "user",
  createdAt: "2026-10-06T08:00:00Z", updatedAt: "2026-10-06T08:00:00Z", additions: 2, deletions: 1, attachments: [],
};

afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  useAppStore.setState({ selectedProjectId: "project-a", selectedTaskId: "task-a" });
  api.tasks.mockResolvedValue([task]);
  api.projects.mockResolvedValue([{ id: "project-a", name: "Boosted", repoPath: "/repo", defaultBranch: "main", createdAt: "2026-10-01" }]);
});

describe("tasks and boards", () => {
  it("renders split-view tasks as divider-separated rows without a card wrapper", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { container } = render(<QueryClientProvider client={client}><TasksPanel detailOpen /></QueryClientProvider>);
    const row = await screen.findByRole("button", { name: /Simplify the task page/ });
    expect(row).toHaveClass("task-list-row");
    expect(row.parentElement).toHaveClass("tasks-list");
    expect(container.querySelector(".tasks-list > .rounded-lg")).not.toBeInTheDocument();
    expect(screen.getByText("To do")).toHaveClass("task-list-status");
    expect(screen.queryByRole("button", { name: "Board view" })).not.toBeInTheDocument();
  });

  it("searches tasks by title or branch and filters by workflow status", async () => {
    api.tasks.mockResolvedValue([
      task,
      { ...task, id: "task-b", title: "Review release notes", branchName: "boosted/release-notes", status: "running" },
    ]);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><TasksPanel detailOpen /></QueryClientProvider>);

    const search = await screen.findByRole("textbox", { name: "Search tasks" });
    fireEvent.change(search, { target: { value: "release-notes" } });
    expect(screen.queryByText("Simplify the task page")).not.toBeInTheDocument();
    expect(screen.getByText("Review release notes")).toBeInTheDocument();
    expect(screen.getByText("1/2")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Clear task search" }));
    fireEvent.keyDown(screen.getByRole("combobox", { name: "Filter tasks by status" }), { key: "ArrowDown" });
    fireEvent.click(await screen.findByRole("option", { name: "In progress" }));
    expect(screen.queryByText("Simplify the task page")).not.toBeInTheDocument();
    const runningTask = screen.getByRole("button", { name: /Review release notes/ });
    expect(within(runningTask).getByText("In progress")).toHaveClass("task-list-status", "text-chat-accent");
    expect(within(runningTask).getByText("In progress").querySelector("svg")).not.toHaveClass("animate-spin");
  });

  it("uses the board status presentation for every task list row", async () => {
    api.tasks.mockResolvedValue([
      task,
      { ...task, id: "task-b", title: "Implement feature", status: "running" },
      { ...task, id: "task-c", title: "Review failure", status: "failed" },
      { ...task, id: "task-d", title: "Shipped feature", status: "done" },
    ]);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><TasksPanel detailOpen /></QueryClientProvider>);

    expect(within(await screen.findByRole("button", { name: /Simplify the task page/ })).getByText("To do")).toHaveClass("text-muted-foreground");
    expect(within(screen.getByRole("button", { name: /Implement feature/ })).getByText("In progress")).toHaveClass("text-chat-accent");
    expect(within(screen.getByRole("button", { name: /Review failure/ })).getByText("Needs attention")).toHaveClass("text-warning");
    expect(within(screen.getByRole("button", { name: /Shipped feature/ })).getByText("Done")).toHaveClass("text-success");
  });

  it("renders a full task board with four grouped workflow columns", async () => {
    api.tasks.mockResolvedValue([{ ...task, source: { provider: "gitlab", externalId: "issue:42" }, attachments: [{ id: "attachment", name: "brief.png", mimeType: "image/png", size: 10 }] }]);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { container } = render(<QueryClientProvider client={client}><TasksPanel /></QueryClientProvider>);
    const card = await screen.findByRole("button", { name: /Simplify the task page/ });
    expect(card).toHaveClass("task-board-card");
    expect(within(card).getByText("Simplify the task page")).toHaveClass("task-card-title");
    expect(within(card).getByText("boosted/task-a")).toBeInTheDocument();
    expect(within(card).getByText(/gitlab #42/i)).toBeInTheDocument();
    expect(within(card).getByTitle("1 attachment")).toBeInTheDocument();
    expect(within(card).getByTitle("2 additions, 1 deletion")).toBeInTheDocument();
    expect(screen.getByText("Task board")).toBeInTheDocument();
    expect(container.querySelector(".boards-grid")).toBeInTheDocument();
    expect(screen.getByText("In progress")).toBeInTheDocument();
    expect(screen.getByText("Needs attention")).toBeInTheDocument();
    expect(screen.queryByText("Planning")).not.toBeInTheDocument();
    expect(screen.getAllByText("Drop task here")).toHaveLength(3);
  });

  it("renders Boards as a list of project boards", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><BoardsPanel /></QueryClientProvider>);
    expect(await screen.findByRole("heading", { name: "Boards" })).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: /Boosted/ })).toBeInTheDocument();
    expect(screen.queryByText("Drop task here")).not.toBeInTheDocument();
  });
});
