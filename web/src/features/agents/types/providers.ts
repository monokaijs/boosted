import type { JsonObject, JsonSerializable } from "./json"

export type ProviderAccountStatus = "DISCONNECTED" | "AUTHENTICATING" | "CONNECTED" | "INVALIDATED" | "ERROR"
export type AccountAuthMode = "device"
export type RunStatus = "QUEUED" | "RUNNING" | "COMPLETED" | "FAILED" | "CANCELLED"
export type ChatStatus = "IDLE" | "RUNNING" | "ARCHIVED"
export type MessageScheduleStatus = "ACTIVE" | "PAUSED" | "COMPLETED" | "ARCHIVED"
export type MessageScheduleRunStatus = "QUEUED" | "RUNNING" | "COMPLETED" | "FAILED" | "CANCELLED"
export type MessageRole = "USER" | "ASSISTANT" | "SYSTEM" | "TOOL"
export type MessageStatus = "PENDING" | "STREAMING" | "COMPLETED" | "FAILED"
export type MessageKind =
  | "CHAT"
  | "THINKING"
  | "TOOL_ACTIVITY"
  | "COMMAND_EXECUTION"
  | "FILE_CHANGE"
  | "PLAN"
  | "APPROVAL"
  | "USER_INPUT_PROMPT"
  | "REVIEW"
  | "WARNING"
  | "COMPACTION"
  | "SUBAGENT_ACTIVITY"
  | "SESSION_UPDATE"
  | "ERROR"

export type MessageContentAnnotations = {
  audience?: ("assistant" | "user")[] | null
  lastModified?: string | null
  priority?: number | null
}

export type MessageContentBlock =
  | { annotations?: MessageContentAnnotations | null; meta?: JsonSerializable | null; text: string; type: "text" }
  | { annotations?: MessageContentAnnotations | null; data: string; meta?: JsonSerializable | null; mimeType: string; type: "image"; uri?: string | null }
  | { annotations?: MessageContentAnnotations | null; data: string; meta?: JsonSerializable | null; mimeType: string; type: "audio" }
  | {
      annotations?: MessageContentAnnotations | null
      description?: string | null
      meta?: JsonSerializable | null
      mimeType?: string | null
      name: string
      size?: number | null
      title?: string | null
      type: "resource_link"
      uri: string
    }
  | {
      annotations?: MessageContentAnnotations | null
      meta?: JsonSerializable | null
      resource:
        | { meta?: JsonSerializable | null; mimeType?: string | null; text: string; type: "text"; uri: string }
        | { blob: string; meta?: JsonSerializable | null; mimeType?: string | null; type: "blob"; uri: string }
      type: "resource"
    }

export type MessageToolCallContent =
  | { content: MessageContentBlock; meta?: JsonSerializable | null; type: "content" }
  | { meta?: JsonSerializable | null; newText: string; oldText?: string | null; path: string; type: "diff" }
  | { meta?: JsonSerializable | null; terminalId: string; type: "terminal" }

export type MessageToolCall = {
  content: MessageToolCallContent[]
  kind?: string | null
  locations: { line?: number | null; meta?: JsonSerializable | null; path: string }[]
  meta?: JsonSerializable | null
  name?: string | null
  rawInput?: JsonSerializable | null
  rawOutput?: JsonSerializable | null
  status?: string | null
  title: string
  toolCallId: string
}

export type ProviderCapability =
  | "auth"
  | "chat"
  | "history"
  | "limits"
  | "models"
  | "accountSwitchHooks"
  | "localRuntime"
  | "threadLifecycle"
  | "fork"
  | "archive"
  | "review"
  | "compact"
  | "usage"
  | "skills"
  | "hooks"
  | "plugins"
  | "mcp"
  | "mcpOauth"
  | "config"
  | "commandExec"
  | "shellCommand"
  | "providerSwitch"

export type ProviderComposerFeature =
  | "accessMode"
  | "fileAttachment"
  | "folderAttachment"
  | "goal"
  | "imageAttachment"
  | "planMode"

export type ProviderFieldDefinition = {
  description?: string
  key: string
  label: string
  options?: { description?: string; label: string; value: string }[]
  placeholder?: string
  required?: boolean
  secret?: boolean
  type: "boolean" | "json" | "path" | "string" | "stringArray"
}

export type ProviderAuthModeDefinition = {
  description?: string
  label: string
  mode: AccountAuthMode
}

export type ProviderDefinitionResponse = {
  accountFields: ProviderFieldDefinition[]
  authModes?: ProviderAuthModeDefinition[]
  capabilities: ProviderCapability[]
  composerFeatures: ProviderComposerFeature[]
  defaultSettings: JsonObject
  icon: string
  id: string
  label: string
  runtimeFields: ProviderFieldDefinition[]
  settingsFields: ProviderFieldDefinition[]
}

export type ProviderSettingsResponse = {
  provider: ProviderDefinitionResponse
  settings: JsonObject
}

export type ProviderAccountResponse = {
  authState?: JsonObject | null
  createdAt: string
  displayName: string
  id: string
  lastAuthLoginId?: string | null
  lastAuthMode?: AccountAuthMode | null
  lastAuthUrl?: string | null
  lastAuthUserCode?: string | null
  lastError?: string | null
  providerId: string
  runtimeDefaults: JsonObject
  settings: JsonObject
  status: ProviderAccountStatus
  updatedAt: string
}

export type CreateProviderAccountRequest = {
  displayName?: string
  providerId: string
  runtimeDefaults?: JsonObject
  settings?: JsonObject
}

export type UpdateProviderAccountRequest = Partial<Omit<CreateProviderAccountRequest, "providerId">>

export type UpdateProviderSettingsRequest = {
  settings: JsonObject
}

export type AuthenticateProviderAccountRequest = {
  mode?: AccountAuthMode
}

export type AuthenticateProviderAccountResponse = {
  accountId: string
  authMode?: AccountAuthMode | null
  authState?: JsonObject
  authUrl?: string | null
  loginId?: string | null
  message?: string
  status: Extract<ProviderAccountStatus, "AUTHENTICATING" | "CONNECTED" | "ERROR">
  userCode?: string | null
  verificationUrl?: string | null
}

export type CodexInstructionsResponse = {
  instructions: string
  paths: string[]
}

export type UpdateCodexInstructionsRequest = {
  instructions: string
}

export type ProviderInstructionsResponse = CodexInstructionsResponse

export type UpdateProviderInstructionsRequest = UpdateCodexInstructionsRequest

export type ProviderModelOption = {
  defaultServiceTier?: string | null
  defaultReasoningEffort?: string | null
  displayName: string
  hidden?: boolean
  id: string
  inputModalities?: string[]
  isDefault?: boolean
  model: string
  serviceTiers?: { description?: string; id: string; name?: string }[]
  supportsPersonality?: boolean
  supportedReasoningEfforts?: { description?: string; reasoningEffort: string }[]
  upgradeInfo?: JsonSerializable | null
}

export type ProviderModelListResponse = {
  data: ProviderModelOption[]
  nextCursor?: string | null
}

export type ProviderLimitWindow = {
  resetsAt?: number | null
  usedPercent: number
  windowDurationMins?: number | null
}

export type ProviderLimitSnapshot = {
  credits?: { balance?: string | null; hasCredits: boolean; unlimited: boolean } | null
  limitId?: string | null
  limitName?: string | null
  planType?: string | null
  primary?: ProviderLimitWindow | null
  rateLimitReachedType?: string | null
  secondary?: ProviderLimitWindow | null
}

export type ProviderLimitsResponse = {
  rateLimits?: ProviderLimitSnapshot
  raw?: JsonSerializable
}

export type ProviderAccountLimitsResponse = {
  data: Record<string, ProviderLimitsResponse>
  errors?: Record<string, string>
  invalidatedAccountIds?: string[]
}

export type WorkspaceHistoryResponse = {
  createdAt: string
  id: string
  isOpen: boolean
  lastOpenedAt: string
  name: string
  path: string
  updatedAt: string
}

export type MessageScheduleRecurrenceFrequency = "none" | "daily" | "weekly" | "monthly"

export type MessageScheduleRecurrence = {
  anchorDay?: number | null
  endAt?: string | null
  frequency: MessageScheduleRecurrenceFrequency
  interval: number
  maxRuns?: number | null
}

export type MessageScheduleRuntimeSettings = {
  collaborationMode?: string | null
  goalObjective?: string | null
  model?: string | null
  permissionMode?: string | null
  reasoningEffort?: string | null
  serviceTier?: string | null
}

export type MessageScheduleResponse = MessageScheduleRuntimeSettings & {
  accountId?: string | null
  chatId?: string | null
  createdAt: string
  id: string
  lastRunAt?: string | null
  lastRunStatus?: MessageScheduleRunStatus | null
  message: string
  nextRunAt?: string | null
  providerId: string
  recurrence: MessageScheduleRecurrence
  status: MessageScheduleStatus
  title: string
  updatedAt: string
  workingDirectory: string
}

export type MessageScheduleRunResponse = {
  chatId?: string | null
  chatRunId?: string | null
  createdAt: string
  endedAt?: string | null
  error?: string | null
  id: string
  scheduleId: string
  scheduledFor: string
  startedAt?: string | null
  status: MessageScheduleRunStatus
  updatedAt: string
}

export type CreateMessageScheduleRequest = MessageScheduleRuntimeSettings & {
  accountId: string
  firstRunAt: string
  message: string
  recurrence?: Partial<MessageScheduleRecurrence>
  status?: Extract<MessageScheduleStatus, "ACTIVE" | "PAUSED">
  title?: string
  workingDirectory: string
}

export type UpdateMessageScheduleRequest = MessageScheduleRuntimeSettings & {
  accountId?: string | null
  firstRunAt?: string | null
  message?: string
  recurrence?: Partial<MessageScheduleRecurrence>
  status?: MessageScheduleStatus
  title?: string
}

export type CreateChatRequest = {
  accountId: string
  autoRotateAccount?: boolean
  collaborationMode?: string | null
  model?: string | null
  permissionMode?: string | null
  providerId?: string
  reasoningEffort?: string | null
  serviceTier?: string | null
  title?: string
  workingDirectory: string
}

export type UpdateChatRequest = {
  accountId?: string | null
  autoRotateAccount?: boolean
  collaborationMode?: string | null
  model?: string | null
  permissionMode?: string | null
  reasoningEffort?: string | null
  serviceTier?: string | null
  title?: string
  workingDirectory?: string
}

export type ChatResponse = {
  accountId?: string | null
  autoRotateAccount: boolean
  collaborationMode: string
  createdAt: string
  externalThreadId?: string | null
  id: string
  lastActivityAt: string
  model?: string | null
  permissionMode: string
  providerId: string
  reasoningEffort?: string | null
  serviceTier?: string | null
  stats?: ChatStatsResponse | null
  status: ChatStatus
  title: string
  updatedAt: string
  workingDirectory?: string | null
}

export type ChatPageResponse = {
  data: ChatResponse[]
  nextCursor: string | null
}

export type ChatStatsResponse = {
  additions: number
  deletions: number
}

export type ChatMessageResponse = {
  blocks?: MessageContentBlock[] | null
  chatId: string
  completedAt?: string | null
  content: string
  createdAt: string
  id: string
  itemId?: string | null
  kind: MessageKind
  metadata?: JsonSerializable | null
  rawPayload?: JsonSerializable | null
  requestId?: string | null
  role: MessageRole
  runId?: string | null
  sequence: number
  status: MessageStatus
  turnId?: string | null
  toolCall?: MessageToolCall | null
}

export type MessagePageResponse = {
  data: ChatMessageResponse[]
  hasMoreBefore?: boolean
  nextCursor?: number | null
  previousCursor?: number | null
}

export type ChatAttachmentKind = "file" | "folder" | "image"

export type ChatAttachmentRequest = {
  dataUrl?: string
  kind: ChatAttachmentKind
  mimeType?: string
  name: string
  path?: string
  size?: number
}

export type ExecuteChatRequest = {
  accountId?: string
  attachments?: ChatAttachmentRequest[]
  content: string
  collaborationMode?: string | null
  delivery?: "queue" | "steer"
  goalObjective?: string | null
  metadata?: JsonObject
  permissionMode?: string | null
}

export type ExecuteChatResponse = {
  assistantMessage?: ChatMessageResponse | null
  message: ChatMessageResponse
  runId?: string | null
  status: Extract<RunStatus, "QUEUED" | "RUNNING">
}

export type UpdateQueuedChatRunRequest = {
  content: string
}

export type ReorderQueuedChatRunsRequest = {
  runIds: string[]
}

export type ReorderQueuedChatRunsResponse = {
  chatId: string
  runIds: string[]
}

export type QueuedChatRunResponse = {
  chatId: string
  message?: ChatMessageResponse | null
  runId: string
  status: Extract<RunStatus, "QUEUED" | "RUNNING" | "COMPLETED" | "CANCELLED">
}

export type ForkChatRequest = {
  lastTurnId?: string | null
}

export type CompactChatRequest = {}

export type ReviewChatRequest = {
  baseBranch?: string | null
  commitSha?: string | null
  commitTitle?: string | null
  delivery?: "inline" | "detached" | null
  instructions?: string | null
  target?: "uncommittedChanges" | "baseBranch" | "commit" | "custom" | null
}

export type RefreshChatResponse = {
  chat: ChatResponse
  messages: MessagePageResponse
}

export type ChatAccountSwitchPhase = "preparing" | "syncingSource" | "hydratingTarget" | "refreshingMessages" | "completed" | "failed"

export type ChatAccountSwitchEvent = {
  chatId: string
  error?: string | null
  fromAccountId?: string | null
  phase: ChatAccountSwitchPhase
  toAccountId: string
}

export type InterruptChatRunResponse = {
  chatId: string
  message: string
  runId: string | null
  status: Extract<RunStatus, "QUEUED" | "RUNNING" | "CANCELLED">
}

export type ChatContextResponse = {
  usage?: {
    remainingPercent: number
    tokenLimit: number
    tokensRemaining: number
    tokensUsed: number
    usedPercent: number
  } | null
}

export type ServerRequestResponseRequest = {
  decision?: JsonSerializable
  kind: "approval" | "permissions" | "userInput"
  result?: JsonSerializable
}
