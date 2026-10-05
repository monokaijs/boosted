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
  kind: "run" | "schedule"
  instructions: string
  status: "waiting" | "ready" | "processing" | "completed" | "failed" | "cancelled"
  createdAt: string
  dueAt?: string
  intervalMinutes?: number
  chatId?: string
  runId?: string
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
  activity?: "thinking" | "working" | "responding" | null
  followUps?: AssistantFollowUp[]
  timeZone?: string
  accountId: string | null
  error: string | null
}

export type AssistantSummary = Pick<AssistantState, "id" | "profile" | "status" | "accountId" | "createdAt" | "updatedAt"> & { lastMessageAt?: string | null }
export type CreateAssistantRequest = Partial<Pick<AssistantProfile, "name" | "personality">>

export type AssistantMessageRequest = {
  content: string
  clientMessageId?: string
  accountId?: string
  attachments?: AssistantAttachment[]
  timeZone?: string
}
