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

const isTauri = "__TAURI_INTERNALS__" in window;
const configuredBase = import.meta.env.VITE_BOOSTED_API_URL?.replace(/\/$/, "") ?? (isTauri ? "http://127.0.0.1:4782" : "");
const TOKEN_KEY = "boosted.session";

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token?: string) {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("Accept", "application/json");
  if (init.body && !(init.body instanceof FormData) && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  const token = getToken();
  if (token) headers.set("Authorization", `Bearer ${token}`);
  const response = await fetch(`${configuredBase}/api/v1${path}`, { ...init, headers });
  if (response.status === 204) return undefined as T;
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401) setToken();
    throw new ApiError(response.status, body.error ?? body.message ?? `Request failed (${response.status})`);
  }
  return body as T;
}

function json(method: string, body?: unknown): RequestInit {
  return { method, body: body === undefined ? undefined : JSON.stringify(body) };
}

export const api = {
  health: () => request<Health>("/health"),
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
    const token = getToken();
    if (token) headers.set("Authorization", `Bearer ${token}`);
    const response = await fetch(`${configuredBase}/api/v1/tasks/${encodeURIComponent(taskId)}/attachments/${encodeURIComponent(attachment.id)}`, { headers });
    if (!response.ok) throw new ApiError(response.status, "Unable to download attachment");
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

export function apiWebSocket(path: string) {
  const explicit = configuredBase || window.location.origin;
  const url = new URL(explicit);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = `/api/v1${path}`;
  url.search = "";
  return url.toString();
}
