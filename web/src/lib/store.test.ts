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

describe("app selection state", () => {
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

  it("clears conversation and file context when switching projects", async () => {
    const { useAppStore } = await import("@/lib/store");
    useAppStore.getState().selectProject(firstProject);
    useAppStore.getState().selectTask(task("task-a", firstProject.id));
    useAppStore.getState().openFile("src/alpha.ts");
    useAppStore.getState().selectProject(secondProject);
    useAppStore.getState().selectCodexChat("chat-b");
    useAppStore.getState().selectProject(firstProject);
    expect(useAppStore.getState()).toMatchObject({ selectedProjectId: firstProject.id, selectedTaskId: undefined, selectedCodexChatId: undefined, openFilePath: undefined });
    expect(localStorage.getItem("boosted.workspace-contexts.v1")).toBeNull();
  });

  it("keeps task and Codex chat selections mutually exclusive", async () => {
    const { useAppStore } = await import("@/lib/store");
    useAppStore.getState().selectTask(task("task-a", firstProject.id));
    useAppStore.getState().selectCodexChat("chat-a");
    expect(useAppStore.getState().selectedTaskId).toBeUndefined();
    useAppStore.getState().selectTask(task("task-b", secondProject.id));
    expect(useAppStore.getState()).toMatchObject({ selectedProjectId: secondProject.id, selectedTaskId: "task-b", selectedCodexChatId: undefined });
  });

  it("restores the selected project and conversation for every active machine", async () => {
    const { useAppStore } = await import("@/lib/store");

    useAppStore.getState().activateMachine("machine-a");
    useAppStore.getState().selectProject(firstProject);
    useAppStore.getState().selectTask(task("task-a", firstProject.id));
    useAppStore.getState().selectCodexChat("chat-a");

    useAppStore.getState().activateMachine("machine-b");
    expect(useAppStore.getState()).toMatchObject({
      selectedProjectId: undefined,
      selectedTaskId: undefined,
      selectedCodexChatId: undefined,
    });
    useAppStore.getState().selectProject(secondProject);
    useAppStore.getState().selectTask(task("task-b", secondProject.id));

    useAppStore.getState().activateMachine("machine-a");
    expect(useAppStore.getState()).toMatchObject({
      selectedProjectId: firstProject.id,
      selectedTaskId: undefined,
      selectedCodexChatId: "chat-a",
    });

    useAppStore.getState().activateMachine("machine-b");
    expect(useAppStore.getState()).toMatchObject({
      selectedProjectId: secondProject.id,
      selectedTaskId: "task-b",
      selectedCodexChatId: undefined,
    });
  });
});
