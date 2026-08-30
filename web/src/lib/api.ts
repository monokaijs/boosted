import type {
  FileContent,
  FileEntry,
  FolderBrowseResponse,
  GlobalSettings,
  CodexLogin,
  CodexChat,
  CodexChatThread,
  CodexTurnStart,
  CodexAttachment,
  CodexOptions,
  CodexAccessOption,
  GitCommit,
  GitStatus,
  Health,
  Project,
  Session,
  SetupState,
  Task,
  TaskEvent,
  TaskStatus,
  TaskAttachment,
  Integration,
  IntegrationSyncResult,
  WorkspaceCodexSettings,
  User,
} from "@/lib/types";
import { activeMachine, activeMachineToken, useMachineStore, type MachineProfile } from "@/lib/machines";

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

function json(method: string, body?: unknown): RequestInit {
  return { method, body: body === undefined ? undefined : JSON.stringify(body) };
}

type ApiClientOptions = {
  profile: Pick<MachineProfile, "id" | "baseUrl">;
  getToken: () => string | undefined;
  onUnauthorized?: () => void | Promise<void>;
};

export function createBoostedApiClient(options: ApiClientOptions) {
  const baseUrl = options.profile.baseUrl.replace(/\/$/, "");
  const activeRequests = new Set<AbortController>();

  async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set("Accept", "application/json");
    if (init.body && !(init.body instanceof FormData) && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
    const token = options.getToken();
    if (token) headers.set("Authorization", `Bearer ${token}`);
    const controller = new AbortController();
    const relayAbort = () => controller.abort(init.signal?.reason);
    if (init.signal?.aborted) relayAbort();
    else init.signal?.addEventListener("abort", relayAbort, { once: true });
    activeRequests.add(controller);
    let response: Response;
    try {
      response = await fetch(`${baseUrl}/api/v1${path}`, { ...init, headers, signal: controller.signal });
    } catch (error) {
      if (error instanceof DOMException && (error.name === "AbortError" || error.name === "TimeoutError")) {
        throw new ApiError(408, "Connection timed out.");
      }
      throw new ApiError(0, error instanceof Error ? error.message : "Unable to reach the Boosted server.");
    } finally {
      activeRequests.delete(controller);
      init.signal?.removeEventListener("abort", relayAbort);
    }
    if (response.status === 204) return undefined as T;
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (response.status === 401) await options.onUnauthorized?.();
      throw new ApiError(response.status, body.error ?? body.message ?? `Request failed (${response.status})`);
    }
    return body as T;
  }

  const client = {
  cancelRequests: () => {
    for (const controller of activeRequests) controller.abort();
    activeRequests.clear();
  },
  health: (signal?: AbortSignal) => request<Health>("/health", { signal }),
  setupState: () => request<SetupState>("/setup"),
  createAdmin: (username: string, password: string) => request<Session>("/setup/admin", json("POST", { username, password })),
  login: (username: string, password: string) => request<Session>("/auth/login", json("POST", { username, password })),
  me: () => request<User>("/auth/me"),
  changePassword: (currentPassword: string, nextPassword: string) => request<User>("/auth/password", json("PUT", { currentPassword, nextPassword })),
  globalSettings: () => request<GlobalSettings>("/settings/global"),
  updateGlobalSettings: (settings: Pick<GlobalSettings, "webPort" | "webUiEnabled" | "allowedIps">) => request<GlobalSettings>("/settings/global", json("PUT", settings)),
  users: () => request<User[]>("/users"),
  createUser: (username: string, password: string) => request<User>("/users", json("POST", { username, password })),
  setUserDisabled: (id: string, disabled: boolean) => request<User>(`/users/${id}`, json("PATCH", { disabled })),
  startCodexLogin: () => request<CodexLogin>("/codex/login", json("POST")),
  codexOptions: () => request<CodexOptions>("/codex/options"),
  uploadCodexAttachment: (file: File) => {
    const form = new FormData();
    form.append("file", file);
    return request<CodexAttachment>("/codex/attachments", { method: "POST", body: form });
  },
  removeCodexAttachment: (id: string) => request<void>(`/codex/attachments/${encodeURIComponent(id)}`, { method: "DELETE" }),
  codexChats: (cwd: string) => request<CodexChat[]>(`/codex/chats?cwd=${encodeURIComponent(cwd)}`),
  createCodexChat: (cwd: string, model?: string) => request<CodexChat>("/codex/chats", json("POST", { cwd, model })),
  codexChat: (id: string) => request<CodexChatThread>(`/codex/chats/${encodeURIComponent(id)}`),
  sendCodexMessage: (id: string, message: string, clientMessageId: string, options: { model: string; reasoningEffort: string; accessMode: CodexAccessOption["id"]; attachmentIds?: string[] }) => request<CodexTurnStart>(`/codex/chats/${encodeURIComponent(id)}/messages`, json("POST", { message, clientMessageId, ...options })),
  stopCodexTurn: (id: string) => request<void>(`/codex/chats/${encodeURIComponent(id)}/stop`, json("POST")),
  browseFolders: (path?: string) => request<FolderBrowseResponse>(`/folders${path ? `?path=${encodeURIComponent(path)}` : ""}`),
  projects: () => request<Project[]>("/projects"),
  openProject: (repoPath: string) => {
    const normalized = repoPath.trim().replace(/[\\/]+$/, "");
    const name = normalized.split(/[\\/]/).pop() || "Project";
    return request<Project>("/projects", json("POST", { name, repoPath: repoPath.trim() }));
  },
  projectFiles: (projectId: string, path = "") => request<FileEntry[]>(`/projects/${projectId}/files?path=${encodeURIComponent(path)}`),
  readProjectFile: (projectId: string, path: string) => request<FileContent>(`/projects/${projectId}/file?path=${encodeURIComponent(path)}`),
  projectBranches: (projectId: string) => request<string[]>(`/projects/${projectId}/git/branches`),
  projectGitHistory: (projectId: string, limit = 100) => request<GitCommit[]>(`/projects/${projectId}/git/history?limit=${limit}`),
  createProjectTerminal: (projectId: string) => request<{ id: string }>(`/projects/${projectId}/terminals`, json("POST")),
  uploadTaskAttachment: (file: File) => {
    const form = new FormData();
    form.append("file", file);
    return request<TaskAttachment>("/task-attachments", { method: "POST", body: form });
  },
  removePendingTaskAttachment: (id: string) => request<void>(`/task-attachments/${encodeURIComponent(id)}`, { method: "DELETE" }),
  tasks: (projectId?: string) => request<Task[]>(`/tasks${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ""}`),
  task: (id: string) => request<Task>(`/tasks/${id}`),
  createTask: (projectId: string, title: string, description: string, options: { baseBranch?: string; model?: string; reasoningEffort?: string; accessMode?: CodexAccessOption["id"]; attachmentIds?: string[] } = {}) => request<Task>("/tasks", json("POST", { projectId, title, description, ...options })),
  downloadTaskAttachment: async (taskId: string, attachment: TaskAttachment) => {
    const headers = new Headers();
    const token = options.getToken();
    if (token) headers.set("Authorization", `Bearer ${token}`);
    const controller = new AbortController();
    activeRequests.add(controller);
    let response: Response;
    try {
      response = await fetch(`${baseUrl}/api/v1/tasks/${encodeURIComponent(taskId)}/attachments/${encodeURIComponent(attachment.id)}`, { headers, signal: controller.signal });
    } finally {
      activeRequests.delete(controller);
    }
    if (!response.ok) {
      if (response.status === 401) await options.onUnauthorized?.();
      throw new ApiError(response.status, "Unable to download attachment");
    }
    const url = URL.createObjectURL(await response.blob());
    const link = document.createElement("a");
    link.href = url; link.download = attachment.name; link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
  },
  integrations: (projectId: string) => request<Integration[]>(`/projects/${projectId}/integrations`),
  createIntegration: (projectId: string, input: { provider: Integration["provider"]; name: string; config: Record<string, unknown>; enabled: boolean; syncIntervalMinutes?: number }) => request<Integration>(`/projects/${projectId}/integrations`, json("POST", input)),
  updateIntegration: (projectId: string, id: string, input: { name: string; config: Record<string, unknown>; enabled: boolean; syncIntervalMinutes?: number }) => request<Integration>(`/projects/${projectId}/integrations/${id}`, json("PUT", input)),
  deleteIntegration: (projectId: string, id: string) => request<void>(`/projects/${projectId}/integrations/${id}`, { method: "DELETE" }),
  syncIntegration: (projectId: string, id: string) => request<IntegrationSyncResult>(`/projects/${projectId}/integrations/${id}/sync`, json("POST")),
  workspaceCodexSettings: (projectId: string) => request<WorkspaceCodexSettings>(`/projects/${projectId}/codex-settings`),
  updateWorkspaceCodexSettings: (projectId: string, instructions: string) => request<{ instructions: string }>(`/projects/${projectId}/codex-settings`, json("PUT", { instructions })),
  upsertWorkspaceMcp: (projectId: string, name: string, config: Record<string, unknown>) => request<Record<string, unknown>>(`/projects/${projectId}/codex-settings/mcps`, json("POST", { name, config })),
  taskEvents: (id: string, after = 0) => request<TaskEvent[]>(`/tasks/${id}/events?after=${after}`),
  startTaskPlan: (id: string) => request<Task>(`/tasks/${id}/plan`, json("POST")),
  sendMessage: (id: string, message: string) => request<Task>(`/tasks/${id}/messages`, json("POST", { message })),
  approvePlan: (id: string, revision: number) => request<Task>(`/tasks/${id}/plan/approve`, json("POST", { revision })),
  stopTask: (id: string) => request<Task>(`/tasks/${id}/stop`, json("POST")),
  setTaskStatus: (id: string, status: TaskStatus) => request<Task>(`/tasks/${id}/status`, json("PUT", { status })),
  files: (taskId: string, path = "") => request<FileEntry[]>(`/tasks/${taskId}/files?path=${encodeURIComponent(path)}`),
  readFile: (taskId: string, path: string) => request<FileContent>(`/tasks/${taskId}/file?path=${encodeURIComponent(path)}`),
  writeFile: (taskId: string, path: string, content: string, revision: string) => request<FileContent>(`/tasks/${taskId}/file`, json("PUT", { path, content, revision })),
  gitStatus: (taskId: string) => request<GitStatus>(`/tasks/${taskId}/git/status`),
  gitDiff: (taskId: string, path?: string, staged = false) => request<{ diff: string }>(`/tasks/${taskId}/git/diff?staged=${staged}${path ? `&path=${encodeURIComponent(path)}` : ""}`),
  gitStage: (taskId: string, paths: string[]) => request<GitStatus>(`/tasks/${taskId}/git/stage`, json("POST", { paths })),
  gitUnstage: (taskId: string, paths: string[]) => request<GitStatus>(`/tasks/${taskId}/git/unstage`, json("POST", { paths })),
  gitDiscard: (taskId: string, paths: string[]) => request<GitStatus>(`/tasks/${taskId}/git/discard`, json("POST", { paths })),
  gitCommit: (taskId: string, message: string) => request<{ commit: string }>(`/tasks/${taskId}/git/commit`, json("POST", { message })),
  gitHistory: (taskId: string, limit = 100) => request<GitCommit[]>(`/tasks/${taskId}/git/history?limit=${limit}`),
  createTerminal: (taskId: string) => request<{ id: string }>(`/tasks/${taskId}/terminals`, json("POST")),
  };

  function webSocket(path: string) {
    const url = new URL(baseUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.pathname = `/api/v1${path}`;
    url.search = "";
    return url.toString();
  }

  return { ...client, webSocket, profileId: options.profile.id, baseUrl };
}

export type BoostedApiClient = ReturnType<typeof createBoostedApiClient>;

let cachedClient: BoostedApiClient | undefined;
let cachedKey = "";

export function getActiveApiClient() {
  const profile = activeMachine();
  if (!profile) throw new ApiError(0, "Add a Boosted machine to continue.");
  const key = `${profile.id}\0${profile.baseUrl}`;
  if (!cachedClient || cachedKey !== key) {
    const profileId = profile.id;
    cachedClient = createBoostedApiClient({
      profile,
      getToken: () => useMachineStore.getState().tokens[profileId],
      onUnauthorized: () => useMachineStore.getState().setToken(profileId),
    });
    cachedKey = key;
  }
  return cachedClient;
}

export const api = new Proxy({} as BoostedApiClient, {
  get: (_target, property: keyof BoostedApiClient) => {
    const value = getActiveApiClient()[property];
    if (typeof value !== "function") return value;
    return (...args: unknown[]) => {
      const current = getActiveApiClient()[property] as (...input: unknown[]) => unknown;
      return current(...args);
    };
  },
});

export function getToken() {
  return activeMachineToken();
}

export async function setToken(token?: string) {
  const state = useMachineStore.getState();
  if (state.activeId) await state.setToken(state.activeId, token);
}

export function apiWebSocket(path: string) {
  return getActiveApiClient().webSocket(path);
}
