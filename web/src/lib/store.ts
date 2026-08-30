import { create } from "zustand";
import { machineScopedKey } from "@/lib/machines";
import type { Project, Task, User } from "@/lib/types";

type WorkspaceContext = {
  selectedTaskId?: string;
  selectedCodexChatId?: string;
  openFilePath?: string;
};

type StoredWorkspaceState = {
  selectedProjectId?: string;
  selectedTaskId?: string;
  selectedCodexChatId?: string;
  openFilePath?: string;
  workspaceContexts: Record<string, WorkspaceContext>;
};

function key(machineId: string | undefined, value: string) {
  return machineId ? machineScopedKey(machineId, value) : value;
}

function readWorkspaceContexts(machineId?: string) {
  try {
    return JSON.parse(localStorage.getItem(key(machineId, "boosted.workspace-contexts.v1")) ?? "{}") as Record<string, WorkspaceContext>;
  } catch {
    return {};
  }
}

function readMachineState(machineId?: string): StoredWorkspaceState {
  const selectedProjectId = localStorage.getItem(key(machineId, "boosted.project")) ?? undefined;
  const workspaceContexts = readWorkspaceContexts(machineId);
  const context = selectedProjectId
    ? workspaceContexts[selectedProjectId] ?? {
        selectedTaskId: localStorage.getItem(key(machineId, "boosted.task")) ?? undefined,
        selectedCodexChatId: localStorage.getItem(key(machineId, "boosted.codexChat")) ?? undefined,
      }
    : {};
  return {
    selectedProjectId,
    selectedTaskId: context.selectedTaskId,
    selectedCodexChatId: context.selectedCodexChatId,
    openFilePath: context.openFilePath,
    workspaceContexts: selectedProjectId && !workspaceContexts[selectedProjectId]
      ? { ...workspaceContexts, [selectedProjectId]: context }
      : workspaceContexts,
  };
}

function persistWorkspaceContexts(machineId: string | undefined, contexts: Record<string, WorkspaceContext>) {
  localStorage.setItem(key(machineId, "boosted.workspace-contexts.v1"), JSON.stringify(contexts));
}

function setOptional(machineId: string | undefined, storageKey: string, value?: string) {
  const resolved = key(machineId, storageKey);
  if (value) localStorage.setItem(resolved, value);
  else localStorage.removeItem(resolved);
}

type AppStore = StoredWorkspaceState & {
  activeMachineId?: string;
  user?: User;
  taskDrawerOpen: boolean;
  activateMachine: (machineId?: string) => void;
  setUser: (user?: User) => void;
  selectProject: (project?: Project) => void;
  selectTask: (task?: Task) => void;
  selectCodexChat: (id?: string) => void;
  openFile: (path?: string) => void;
  setTaskDrawerOpen: (open: boolean) => void;
};

const initial = readMachineState();

export const useAppStore = create<AppStore>((set, get) => ({
  ...initial,
  activeMachineId: undefined,
  user: undefined,
  taskDrawerOpen: false,
  activateMachine: (activeMachineId) => {
    const stored = readMachineState(activeMachineId);
    set({ ...stored, activeMachineId, user: undefined, taskDrawerOpen: false });
  },
  setUser: (user) => set({ user }),
  selectProject: (project) => {
    const state = get();
    setOptional(state.activeMachineId, "boosted.project", project?.id);
    const context = project ? state.workspaceContexts[project.id] ?? {} : {};
    setOptional(state.activeMachineId, "boosted.task", context.selectedTaskId);
    setOptional(state.activeMachineId, "boosted.codexChat", context.selectedCodexChatId);
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
    setOptional(state.activeMachineId, "boosted.task", task?.id);
    if (!projectId) {
      set({ selectedTaskId: task?.id, selectedProjectId: task?.projectId, openFilePath: undefined });
      return;
    }
    if (task && task.projectId !== state.selectedProjectId) setOptional(state.activeMachineId, "boosted.project", task.projectId);
    const previous = state.workspaceContexts[projectId] ?? {};
    const nextContext = { ...previous, selectedTaskId: task?.id, openFilePath: undefined };
    const workspaceContexts = { ...state.workspaceContexts, [projectId]: nextContext };
    persistWorkspaceContexts(state.activeMachineId, workspaceContexts);
    set({
      workspaceContexts,
      selectedTaskId: task?.id,
      selectedProjectId: projectId,
      selectedCodexChatId: nextContext.selectedCodexChatId,
      openFilePath: undefined,
    });
  },
  selectCodexChat: (id) => {
    const state = get();
    setOptional(state.activeMachineId, "boosted.codexChat", id);
    if (!state.selectedProjectId) {
      set({ selectedCodexChatId: id });
      return;
    }
    const workspaceContexts = {
      ...state.workspaceContexts,
      [state.selectedProjectId]: { ...state.workspaceContexts[state.selectedProjectId], selectedCodexChatId: id },
    };
    persistWorkspaceContexts(state.activeMachineId, workspaceContexts);
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
    persistWorkspaceContexts(state.activeMachineId, workspaceContexts);
    set({ openFilePath, workspaceContexts });
  },
  setTaskDrawerOpen: (taskDrawerOpen) => set({ taskDrawerOpen }),
}));

export function machinePreferenceKey(value: string) {
  return key(useAppStore.getState().activeMachineId, value);
}
