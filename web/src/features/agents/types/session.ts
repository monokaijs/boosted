import type { ChatAttachmentRequest, ChatMessageResponse } from "@/features/agents/lib/api-client"

export type FileNode = {
  children?: FileNode[]
  content?: string
  icon?: "docker" | "env" | "git" | "info" | "js" | "json" | "make" | "rust" | "shell" | "text"
  id: string
  language?: string
  name: string
  path?: string
  type: "folder" | "file"
}

export type MainMode = "chat" | "dialog" | "editor" | "schedule"

export type ManagementView = "instructions" | "mcpServers" | "providers"

export type MobileDrawer = "sessions" | null

export type NavigationView = "home" | "tasks" | "scheduled" | "projects" | "usage" | "settings"

export type Workspace = {
  branch: string
  fileTree: FileNode[]
  id: string
  name: string
  path: string
  selectedFileId: string
}

export type FileSelectOptions = {
  column?: number
  lineNumber?: number
}

export type FileRevealTarget = FileSelectOptions & {
  fileId: string
  nonce: number
}

export type ChatFileLinkTarget = FileSelectOptions & {
  path: string
}

export type ChatComposerAccessMode = "askForApproval" | "fullAccess"

// Effort values come from the live provider catalog, including future capabilities.
export type ChatComposerReasoningEffort = string

export type ChatComposerServiceTier = "fast" | "standard"

export type ChatComposerAttachment = ChatAttachmentRequest & {
  id: string
}

export type ChatComposerSubmit = {
  attachments: ChatAttachmentRequest[]
  collaborationMode: string | null
  content: string
  delivery?: "queue" | "steer"
  goalObjective: string | null
  model: string | null
  permissionMode: ChatComposerAccessMode
  reasoningEffort: string | null
  serviceTier: string | null
}

export type UserInputQuestion = {
  defaultValues?: string[]
  header: string
  id: string
  inputType?: "date" | "datetime-local" | "email" | "number" | "text" | "url"
  isSecret: boolean
  maximum?: number | null
  maximumLength?: number | null
  maximumSelections?: number | null
  minimum?: number | null
  minimumLength?: number | null
  minimumSelections?: number | null
  multiple?: boolean
  options: { description: string; label: string; value?: string }[]
  pattern?: string | null
  question: string
  required?: boolean
}

export type VisibleTreeItem = {
  level: number
  node: FileNode
  parentId?: string
}

export type ChatRenderEntry =
  | { type: "fileChange"; id: string; messages: ChatMessageResponse[] }
  | { type: "message"; message: ChatMessageResponse }
  | { type: "work"; completedAt?: string | null; finished: boolean; id: string; messages: ChatMessageResponse[]; startedAt?: string | null }

export type ParsedFileChange = {
  additions: number
  deletions: number
  path: string
}

export type WorkRenderEntry =
  | { type: "actionGroup"; id: string; messages: ChatMessageResponse[] }
  | { type: "message"; message: ChatMessageResponse }

export type SessionRouteTarget = {
  chatId: string | null
  workspaceId: string | null
}

export type ProviderClientEvent = {
  payload: unknown
  threadId?: string
  type: string
}
