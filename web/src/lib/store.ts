import { create } from "zustand";
import { machineScopedKey } from "@/lib/machines";
import type { Project, Task, User } from "@/lib/types";
import { useWorkspaceStore } from "@/lib/workspace-state";

function key(machineId: string | undefined, value: string) {
  return machineId ? machineScopedKey(machineId, value) : value;
}

function readMachineState(machineId?: string) {
  return {
    selectedProjectId: localStorage.getItem(key(machineId, "boosted.project")) ?? undefined,
    selectedTaskId: localStorage.getItem(key(machineId, "boosted.task")) ?? undefined,
    selectedGroupId: localStorage.getItem(key(machineId, "boosted.group")) ?? undefined,
    selectedCodexChatId: localStorage.getItem(key(machineId, "boosted.codexChat")) ?? undefined,
    openFilePath: undefined as string | undefined,
  };
}

function setOptional(machineId: string | undefined, storageKey: string, value?: string) {
  const resolved = key(machineId, storageKey);
  if (value) localStorage.setItem(resolved, value);
  else localStorage.removeItem(resolved);
}

type AppStore = ReturnType<typeof readMachineState> & {
  activeMachineId?: string;
  user?: User;
  taskDrawerOpen: boolean;
  activateMachine: (machineId?: string) => void;
  setUser: (user?: User) => void;
  selectProject: (project?: Project) => void;
  selectTask: (task?: Task) => void;
  selectCodexChat: (id?: string) => void;
  selectGroup: (id?: string) => void;
  openFile: (path?: string) => void;
  setTaskDrawerOpen: (open: boolean) => void;
};

export const useAppStore = create<AppStore>((set, get) => ({
  ...readMachineState(),
  activeMachineId: undefined,
  user: undefined,
  taskDrawerOpen: false,
  activateMachine: (activeMachineId) => {
    useWorkspaceStore.getState().reset();
    set({ ...readMachineState(activeMachineId), activeMachineId, user: undefined, taskDrawerOpen: false });
  },
  setUser: (user) => {
    if (!user) useWorkspaceStore.getState().reset();
    set({ user });
  },
  selectProject: (project) => {
    const state = get();
    if (state.selectedProjectId === project?.id) return;
    setOptional(state.activeMachineId, "boosted.project", project?.id);
    setOptional(state.activeMachineId, "boosted.task");
    setOptional(state.activeMachineId, "boosted.codexChat");
    set({ selectedProjectId: project?.id, selectedTaskId: undefined, selectedCodexChatId: undefined, openFilePath: undefined });
  },
  selectTask: (task) => {
    const state = get();
    setOptional(state.activeMachineId, "boosted.task", task?.id);
    if (task) {
      setOptional(state.activeMachineId, "boosted.project", task.projectId);
      setOptional(state.activeMachineId, "boosted.codexChat");
      setOptional(state.activeMachineId, "boosted.group");
    }
    set({ selectedTaskId: task?.id, selectedProjectId: task?.projectId ?? state.selectedProjectId, ...(task ? { selectedGroupId: undefined, selectedCodexChatId: undefined } : {}), openFilePath: undefined });
  },
  selectGroup: (id) => {
    const state = get();
    setOptional(state.activeMachineId, "boosted.group", id);
    if (id) { setOptional(state.activeMachineId, "boosted.codexChat"); setOptional(state.activeMachineId, "boosted.task"); }
    set({ selectedGroupId: id, ...(id ? { selectedCodexChatId: undefined, selectedTaskId: undefined, openFilePath: undefined } : {}) });
  },
  selectCodexChat: (id) => {
    const state = get();
    setOptional(state.activeMachineId, "boosted.codexChat", id);
    if (id) { setOptional(state.activeMachineId, "boosted.task"); setOptional(state.activeMachineId, "boosted.group"); }
    set({ selectedCodexChatId: id, ...(id ? { selectedGroupId: undefined, selectedTaskId: undefined, openFilePath: undefined } : {}) });
  },
  openFile: (openFilePath) => set({ openFilePath }),
  setTaskDrawerOpen: (taskDrawerOpen) => set({ taskDrawerOpen }),
}));

export function machinePreferenceKey(value: string) {
  return key(useAppStore.getState().activeMachineId, value);
}
