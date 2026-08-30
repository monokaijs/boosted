import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Project, Task } from "@/lib/types";

const firstProject: Project = {
  id: "project-a",
  name: "alpha",
  repoPath: "/repos/alpha",
  defaultBranch: "main",
  createdAt: "2026-08-30T00:00:00Z",
};

const secondProject: Project = {
  ...firstProject,
  id: "project-b",
  name: "beta",
  repoPath: "/repos/beta",
};

function task(id: string, projectId: string): Task {
  return {
    id,
    projectId,
    title: id,
    description: "",
    status: "ready",
    branchName: `boosted/${id}`,
    worktreePath: `/worktrees/${id}`,
    baseBranch: "main",
    accessMode: "fullAccess",
    createdBy: "user",
    createdAt: "2026-08-30T00:00:00Z",
    updatedAt: "2026-08-30T00:00:00Z",
    additions: 0,
    deletions: 0,
    attachments: [],
  };
}

describe("workspace state", () => {
  beforeEach(() => {
    const values = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      get length() { return values.size; },
      clear: () => values.clear(),
      getItem: (key: string) => values.get(key) ?? null,
      key: (index: number) => [...values.keys()][index] ?? null,
      removeItem: (key: string) => { values.delete(key); },
      setItem: (key: string, value: string) => { values.set(key, value); },
    } satisfies Storage);
    vi.resetModules();
  });

  it("restores each workspace's active task, chat, and file", async () => {
    const { useAppStore } = await import("@/lib/store");

    useAppStore.getState().selectProject(firstProject);
    useAppStore.getState().selectTask(task("task-a", firstProject.id));
    useAppStore.getState().selectCodexChat("chat-a");
    useAppStore.getState().openFile("src/alpha.ts");

    useAppStore.getState().selectProject(secondProject);
    expect(useAppStore.getState()).toMatchObject({
      selectedProjectId: secondProject.id,
      selectedTaskId: undefined,
      selectedCodexChatId: undefined,
      openFilePath: undefined,
    });

    useAppStore.getState().selectTask(task("task-b", secondProject.id));
    useAppStore.getState().selectCodexChat("chat-b");
    useAppStore.getState().openFile("src/beta.ts");
    useAppStore.getState().selectProject(firstProject);

    expect(useAppStore.getState()).toMatchObject({
      selectedProjectId: firstProject.id,
      selectedTaskId: "task-a",
      selectedCodexChatId: "chat-a",
      openFilePath: "src/alpha.ts",
    });

    useAppStore.getState().selectProject(secondProject);
    expect(useAppStore.getState()).toMatchObject({
      selectedProjectId: secondProject.id,
      selectedTaskId: "task-b",
      selectedCodexChatId: "chat-b",
      openFilePath: "src/beta.ts",
    });
  });
});
