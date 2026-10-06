export type AssistantAction = {
  id: string
  tool: string
  arguments: Record<string, unknown>
  status: "running" | "completed" | "failed"
  result?: string
  chatId?: string
  workingDirectory?: string
}

export type AssistantMessage = {
  id: string
  role: "user" | "assistant"
  content: string
  createdAt: string
  readAt?: string
  actions?: AssistantAction[]
  assistantName?: string
  attachments?: AssistantAttachment[]
  delivery?: "queued" | "processing" | "handled" | "cancelled"
  requestedAccountId?: string
  inReplyTo?: string[]
  followUpIds?: string[]
}

export type AssistantFollowUp = {
  id: string
  kind: "run" | "schedule" | "task-plan"
  instructions: string
  status: "waiting" | "ready" | "processing" | "completed" | "failed" | "cancelled"
  createdAt: string
  dueAt?: string
  intervalMinutes?: number
  chatId?: string
  runId?: string
  taskId?: string
  projectId?: string
  title?: string
  result?: { status: string; error?: string | null; title?: string; messages?: string[] }
  error?: string | null
  lastDeliveredAt?: string
  sourceMessageIds?: string[]
}

export type AssistantFollowUpRequest = { instructions: string; dueAt: string; intervalMinutes?: number }

export type AssistantAttachment = {
  id: string
  kind: "image" | "file"
  name: string
  mimeType: string
  size: number
  dataUrl: string
}

export const assistantAttachmentLimits = { count: 10, fileBytes: 5 * 1024 * 1024, totalBytes: 10 * 1024 * 1024 }

export type AssistantProfile = {
  name: string
  personality: string
  avatar?: string
}

export type AssistantState = {
  id: string
  createdAt: string
  updatedAt: string
  profile: AssistantProfile
  messages: AssistantMessage[]
  status: "idle" | "running"
  activeGroupId?: string | null
  activeExternalSession?: { id: string; provider: "slack" | "telegram"; chatName: string } | null
  activity?: "thinking" | "working" | "responding" | null
  followUps?: AssistantFollowUp[]
  timeZone?: string
  accountId: string | null
  error: string | null
}

export type AssistantSummary = Pick<AssistantState, "id" | "profile" | "status" | "accountId" | "activeExternalSession" | "createdAt" | "updatedAt"> & { lastMessageAt?: string | null }
export type CreateAssistantRequest = Partial<Pick<AssistantProfile, "name" | "personality">>

export type AssistantMessageRequest = {
  content: string
  clientMessageId?: string
  accountId?: string
  attachments?: AssistantAttachment[]
  timeZone?: string
}

export type AgentIntegrationProvider = "slack" | "telegram"
export type AgentIntegrationChat = {
  id: string
  integrationId: string
  externalId: string
  name: string
  kind: string
  status: "pending" | "approved" | "revoked"
  approvedAt?: string | null
  lastSeenAt: string
  createdAt: string
}
export type AgentIntegration = {
  id: string
  agentId: string
  provider: AgentIntegrationProvider
  name: string
  enabled: boolean
  bot: { id?: string | number; name?: string; username?: string }
  workspace?: string | null
  status: "starting" | "connected" | "reconnecting" | "error" | "disabled"
  lastConnectedAt?: string | null
  lastActivityAt?: string | null
  lastError?: string | null
  hasBotToken: boolean
  hasAppToken: boolean
  slackManifest?: string | null
  chats: AgentIntegrationChat[]
  createdAt: string
  updatedAt: string
}
export type AgentIntegrationCreate = {
  provider: AgentIntegrationProvider
  name: string
  botToken: string
  appToken?: string
  enabled?: boolean
}
export type AgentIntegrationUpdate = Partial<Omit<AgentIntegrationCreate, "provider">> & {
  reconnect?: boolean
}
