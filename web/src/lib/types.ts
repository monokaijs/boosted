export type Role = "admin" | "member";

export interface User {
  id: string;
  username: string;
  role: Role;
  mustChangePassword: boolean;
  disabled: boolean;
  createdAt: string;
}

export interface Session {
  token: string;
  user: User;
}

export interface GlobalSettings {
  webPort: number;
  webUiEnabled: boolean;
  allowedIps: string[];
  updatedAt?: string;
}

export type RemoteViewerCodec = "auto" | "h264" | "vp8";
export type RemoteViewerResolution = "720p" | "1080p" | "1440p" | "native";

export interface RemoteViewerSettings {
  enabled: boolean;
  controlEnabled: boolean;
  audioEnabled: boolean;
  preferredCodec: RemoteViewerCodec;
  defaultFps: number;
  maxFps: number;
  defaultResolution: RemoteViewerResolution;
  maxResolution: RemoteViewerResolution;
  maxBitrateKbps: number;
  maxConcurrentStreams: number;
}

export interface RemoteViewerCapabilities {
  platform: "macos" | "windows" | "unsupported";
  captureAvailable: boolean;
  controlAvailable: boolean;
  capturePermission: "granted" | "denied" | "prompt" | "unavailable";
  controlPermission: "granted" | "denied" | "prompt" | "unavailable";
  codecs: Array<"h264" | "vp8">;
}

export interface CaptureSource {
  id: string;
  kind: "window" | "display";
  name: string;
  appName?: string;
  width: number;
  height: number;
  scale: number;
}

export interface ViewerSessionRequest {
  sourceId: string;
  fps?: number;
  resolution?: RemoteViewerResolution;
  supportedCodecs?: Array<"h264" | "vp8">;
}

export interface ViewerSession {
  id: string;
  source: CaptureSource;
  effectiveCodec: "h264" | "vp8";
  effectiveFps: number;
  width: number;
  height: number;
  audioEnabled: boolean;
}

export interface SetupState {
  needsSetup: boolean;
  codex: {
    available: boolean;
    authenticated: boolean;
    version?: string;
    error?: string;
  };
}

export interface CodexLogin {
  type: "chatgptDeviceCode";
  loginId: string;
  verificationUrl: string;
  userCode: string;
}

export interface CodexChat {
  id: string;
  title: string;
  preview: string;
  cwd: string;
  source: string;
  model?: string;
  updatedAt: string;
  isPinned: boolean;
  status: string;
}

export interface CodexChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  kind: "message" | "reasoning" | "plan" | "tool" | "system";
  createdAt?: string;
}

export interface CodexChatThread {
  chat: CodexChat;
  messages: CodexChatMessage[];
}

export interface CodexTurnStart {
  turnId: string;
  threadId: string;
  forkedFromThreadId?: string;
}

export interface CodexAttachment {
  id: string;
  name: string;
  mimeType: string;
}

export interface CodexReasoningEffortOption {
  id: string;
  description: string;
}

export interface CodexModelOption {
  id: string;
  model: string;
  displayName: string;
  description: string;
  defaultReasoningEffort: string;
  supportedReasoningEfforts: CodexReasoningEffortOption[];
  inputModalities: string[];
  isDefault: boolean;
}

export interface CodexAccessOption {
  id: "fullAccess" | "workspaceWrite" | "readOnly";
  label: string;
  description: string;
}

export interface CodexOptions {
  models: CodexModelOption[];
  accessModes: CodexAccessOption[];
  defaultModel: string;
  defaultAccessMode: CodexAccessOption["id"];
}

export interface CodexLiveEvent {
  threadId: string;
  turnId: string;
  method: string;
  clientMessageId?: string;
  itemId?: string;
  delta?: string;
  message?: CodexChatMessage;
  status?: string;
  error?: unknown;
}

export interface Project {
  id: string;
  name: string;
  repoPath: string;
  defaultBranch: string;
  createdAt: string;
}

export interface FolderBrowseEntry {
  name: string;
  path: string;
  isGitRepository: boolean;
}

export interface FolderBrowseResponse {
  path: string;
  parent?: string;
  roots: string[];
  entries: FolderBrowseEntry[];
  isGitRepository: boolean;
}

export type TaskStatus =
  | "queued"
  | "planning"
  | "ready"
  | "running"
  | "needs_input"
  | "review"
  | "done"
  | "failed";

export interface PlanStep {
  step: string;
  status: "pending" | "in_progress" | "completed";
}

export interface TaskPlan {
  revision: number;
  explanation?: string;
  markdown?: string;
  steps: PlanStep[];
  approvedAt?: string;
  approvedBy?: string;
}

export interface Task {
  id: string;
  projectId: string;
  title: string;
  description: string;
  status: TaskStatus;
  branchName: string;
  worktreePath: string;
  baseBranch: string;
  model?: string;
  reasoningEffort?: string;
  accessMode: CodexAccessOption["id"];
  providerThreadId?: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  additions: number;
  deletions: number;
  plan?: TaskPlan;
  activeTurnId?: string;
  error?: string;
  attachments: TaskAttachment[];
  source?: TaskSource;
}

export interface TaskAttachment {
  id: string;
  name: string;
  mimeType: string;
  size: number;
}

export interface TaskSource {
  provider: "gitlab" | "huly" | string;
  externalId: string;
  externalUrl?: string;
}

export interface Integration {
  id: string;
  projectId: string;
  provider: "gitlab" | "huly";
  name: string;
  config: Record<string, unknown>;
  enabled: boolean;
  syncIntervalMinutes?: number;
  lastSyncedAt?: string;
  lastSyncStatus?: "running" | "success" | "partial" | "failed";
  lastSyncError?: string;
  createdAt: string;
  updatedAt: string;
}

export interface IntegrationSyncResult {
  imported: number;
  skipped: number;
  failed: number;
  message: string;
}

export interface IntegrationDiscoveryTarget {
  kind: "project" | "group";
  identifier: string;
  name: string;
  fullPath?: string;
  workspace?: string;
  workspaceName?: string;
  webUrl?: string;
}

export interface IntegrationDiscoveryResult {
  targets: IntegrationDiscoveryTarget[];
}

export interface CodexUsageSummary {
  lifetimeTokens?: number | null;
  peakDailyTokens?: number | null;
  longestRunningTurnSec?: number | null;
  currentStreakDays?: number | null;
  longestStreakDays?: number | null;
}

export interface CodexDailyUsageBucket {
  startDate: string;
  tokens: number;
}

export interface CodexUsage {
  summary?: CodexUsageSummary | null;
  dailyUsageBuckets?: CodexDailyUsageBucket[] | null;
}

export interface CodexRateLimitWindow {
  usedPercent?: number | null;
  windowDurationMins?: number | null;
  resetsAt?: number | null;
}

export interface CodexRateLimitBucket {
  limitId: string;
  limitName?: string | null;
  primary?: CodexRateLimitWindow | null;
  secondary?: CodexRateLimitWindow | null;
  rateLimitReachedType?: string | null;
  planType?: string | null;
}

export interface CodexRateLimitResetCredit {
  id: string;
  resetType: string;
  status: string;
  grantedAt: number;
  expiresAt?: number | null;
  title?: string | null;
  description?: string | null;
}

export interface CodexRateLimitResetCredits {
  availableCount: number;
  credits?: CodexRateLimitResetCredit[] | null;
}

export interface CodexRateLimits {
  rateLimits?: CodexRateLimitBucket | null;
  rateLimitsByLimitId?: Record<string, CodexRateLimitBucket> | null;
  rateLimitResetCredits?: CodexRateLimitResetCredits | null;
}

export interface WorkspaceCodexSettings {
  info: SetupState["codex"];
  instructions: string;
  account?: Record<string, unknown>;
  rateLimits?: CodexRateLimits | null;
  usage?: CodexUsage | null;
  mcps?: Record<string, unknown>;
  config?: Record<string, unknown>;
}

export type EventKind =
  | "user_message"
  | "agent_message"
  | "reasoning"
  | "command"
  | "command_output"
  | "file_change"
  | "plan_updated"
  | "status_changed"
  | "system"
  | "error";

export interface TaskEvent {
  id: number;
  taskId: string;
  kind: EventKind;
  actorId?: string;
  actorName?: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface FileEntry {
  name: string;
  path: string;
  kind: "file" | "directory" | "symlink";
  size: number;
  modifiedAt?: string;
}

export interface FileContent {
  path: string;
  content: string;
  language: string;
  revision: string;
  binary: boolean;
}

export interface GitChange {
  path: string;
  indexStatus: string;
  worktreeStatus: string;
  additions: number;
  deletions: number;
}

export interface GitStatus {
  branch: string;
  ahead: number;
  behind: number;
  changes: GitChange[];
}

export interface GitCommit {
  id: string;
  parents: string[];
  author: string;
  email: string;
  subject: string;
  body: string;
  authoredAt: string;
  refs: string[];
}

export interface Health {
  ok: boolean;
  version: string;
  codexAvailable: boolean;
}

export interface LiveEvent {
  sequence: number;
  topic: string;
  data: unknown;
}
