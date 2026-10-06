import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "@/lib/store";
import type { Task } from "@/lib/types";

const api = vi.hoisted(() => ({ tasks: vi.fn(), setTaskStatus: vi.fn() }));
vi.mock("@/lib/api", () => ({ api }));
import { TaskboardPanel } from "./taskboard-panel";

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
});

describe("task list", () => {
  it("renders split-view tasks as divider-separated rows without a card wrapper", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { container } = render(<QueryClientProvider client={client}><TaskboardPanel detailOpen /></QueryClientProvider>);
    const row = await screen.findByRole("button", { name: /Simplify the task page/ });
    expect(row).toHaveClass("border-b");
    expect(row.parentElement).toHaveClass("taskboard-list");
    expect(container.querySelector(".taskboard-list > .rounded-lg")).not.toBeInTheDocument();
    expect(screen.getByText("To do")).toHaveClass("whitespace-nowrap");
  });
});
