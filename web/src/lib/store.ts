import { create } from "zustand";
import type { Project, Task, User } from "@/lib/types";

type WorkspaceContext = {
  selectedTaskId?: string;
  selectedCodexChatId?: string;
  openFilePath?: string;
};

const workspaceContextsKey = "boosted.workspace-contexts.v1";

function readWorkspaceContexts() {
  try {
    return JSON.parse(localStorage.getItem(workspaceContextsKey) ?? "{}") as Record<string, WorkspaceContext>;
  } catch {
    return {};
  }
}

function persistWorkspaceContexts(contexts: Record<string, WorkspaceContext>) {
  localStorage.setItem(workspaceContextsKey, JSON.stringify(contexts));
}

const initialProjectId = localStorage.getItem("boosted.project") ?? undefined;
const storedWorkspaceContexts = readWorkspaceContexts();
const initialWorkspaceContext = initialProjectId
  ? storedWorkspaceContexts[initialProjectId] ?? {
      selectedTaskId: localStorage.getItem("boosted.task") ?? undefined,
      selectedCodexChatId: localStorage.getItem("boosted.codexChat") ?? undefined,
    }
  : {};

type AppStore = {
  user?: User;
  selectedProjectId?: string;
  selectedTaskId?: string;
  selectedCodexChatId?: string;
  openFilePath?: string;
  workspaceContexts: Record<string, WorkspaceContext>;
  taskDrawerOpen: boolean;
  setUser: (user?: User) => void;
  selectProject: (project?: Project) => void;
  selectTask: (task?: Task) => void;
  selectCodexChat: (id?: string) => void;
  openFile: (path?: string) => void;
  setTaskDrawerOpen: (open: boolean) => void;
};

export const useAppStore = create<AppStore>((set, get) => ({
  user: undefined,
  selectedProjectId: initialProjectId,
  selectedTaskId: initialWorkspaceContext.selectedTaskId,
  selectedCodexChatId: initialWorkspaceContext.selectedCodexChatId,
  openFilePath: initialWorkspaceContext.openFilePath,
  workspaceContexts: initialProjectId && !storedWorkspaceContexts[initialProjectId]
    ? { ...storedWorkspaceContexts, [initialProjectId]: initialWorkspaceContext }
    : storedWorkspaceContexts,
  taskDrawerOpen: false,
  setUser: (user) => set({ user }),
  selectProject: (project) => {
    if (project) localStorage.setItem("boosted.project", project.id);
    else localStorage.removeItem("boosted.project");
    const context = project ? get().workspaceContexts[project.id] ?? {} : {};
    if (context.selectedTaskId) localStorage.setItem("boosted.task", context.selectedTaskId);
    else localStorage.removeItem("boosted.task");
    if (context.selectedCodexChatId) localStorage.setItem("boosted.codexChat", context.selectedCodexChatId);
    else localStorage.removeItem("boosted.codexChat");
    set({
      selectedProjectId: project?.id,
      selectedTaskId: context.selectedTaskId,
      selectedCodexChatId: context.selectedCodexChatId,
      openFilePath: context.openFilePath,
    });
  },
  selectTask: (task) => {
    const state = get();
    const projectId = task?.projectId ?? state.selectedProjectId;
    if (task) localStorage.setItem("boosted.task", task.id);
    else localStorage.removeItem("boosted.task");
    if (!projectId) {
      set({ selectedTaskId: task?.id, selectedProjectId: task?.projectId, openFilePath: undefined });
      return;
    }
    if (task && task.projectId !== state.selectedProjectId) localStorage.setItem("boosted.project", task.projectId);
    const previous = state.workspaceContexts[projectId] ?? {};
    const nextContext = { ...previous, selectedTaskId: task?.id, openFilePath: undefined };
    const workspaceContexts = { ...state.workspaceContexts, [projectId]: nextContext };
    persistWorkspaceContexts(workspaceContexts);
    set({
      workspaceContexts,
      selectedTaskId: task?.id,
      selectedProjectId: projectId,
      selectedCodexChatId: nextContext.selectedCodexChatId,
      openFilePath: undefined,
    });
  },
  selectCodexChat: (id) => {
    if (id) localStorage.setItem("boosted.codexChat", id);
    else localStorage.removeItem("boosted.codexChat");
    const state = get();
    if (!state.selectedProjectId) {
      set({ selectedCodexChatId: id });
      return;
    }
    const workspaceContexts = {
      ...state.workspaceContexts,
      [state.selectedProjectId]: { ...state.workspaceContexts[state.selectedProjectId], selectedCodexChatId: id },
    };
    persistWorkspaceContexts(workspaceContexts);
    set({ selectedCodexChatId: id, workspaceContexts });
  },
  openFile: (openFilePath) => {
    const state = get();
    if (!state.selectedProjectId) {
      set({ openFilePath });
      return;
    }
    const workspaceContexts = {
      ...state.workspaceContexts,
      [state.selectedProjectId]: { ...state.workspaceContexts[state.selectedProjectId], openFilePath },
    };
    persistWorkspaceContexts(workspaceContexts);
    set({ openFilePath, workspaceContexts });
  },
  setTaskDrawerOpen: (taskDrawerOpen) => set({ taskDrawerOpen }),
}));
