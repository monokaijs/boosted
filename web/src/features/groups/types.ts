import type { AssistantAction, AssistantAttachment, AssistantProfile } from '@/features/agents/types/assistant';

export type GroupRole = 'coordinator' | 'developer' | 'reviewer' | 'researcher' | 'designer';
export interface GroupMemberRole {
  role: GroupRole;
  roles?: GroupRole[];
  responsibilities: string;
}

export interface GroupSummary {
  id: string;
  name: string;
  memberIds: string[];
  memberRoles: Record<string, GroupMemberRole>;
  projectId: string | null;
  workingDirectory: string | null;
  stopped: boolean;
  stopReason: 'user' | 'restart' | null;
  version: number;
  createdAt: string;
  updatedAt: string;
  lastMessageAt?: string | null;
  createdBy: string;
  initialGitState: unknown;
}
export interface GroupMessage {
  id: string;
  groupId: string;
  rootId: string;
  sequence: number;
  senderType: 'user' | 'agent';
  senderId: string;
  senderName: string;
  content: string;
  recipientIds: string[];
  kind: 'message' | 'request' | 'roles';
  createdAt: string;
  taskId?: string | null;
  inReplyTo?: string | null;
  timeZone?: string | null;
  attention?: boolean;
  attachments?: AssistantAttachment[] | null;
}
export interface GroupDelivery {
  id: string;
  groupId: string;
  createdAt: string;
  agentId: string;
  rootId: string;
  messageId?: string | null;
  taskRevision?: number | null;
  taskId?: string | null;
  purpose: 'message' | 'execute' | 'review';
  status: 'queued' | 'processing' | 'handled' | 'failed' | 'cancelled';
  recovery?: boolean;
}
export type GroupTaskStatus = 'queued' | 'running' | 'awaiting_review' | 'completed' | 'blocked' | 'failed' | 'interrupted' | 'cancelled';
export interface GroupTask {
  id: string;
  groupId: string;
  rootId: string;
  title: string;
  instructions: string;
  expectedResult: string;
  ownerId: string | null;
  reviewerId: string | null;
  dependencyIds: string[];
  workingDirectory: string | null;
  fileResponsibilities: string[];
  status: GroupTaskStatus;
  revision: number;
  result: string | null;
  verification: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  fingerprints: Record<string, string>;
  recovery: boolean;
}
export interface GroupReview {
  id: string;
  groupId: string;
  fingerprints: Record<string, string>;
  taskId: string;
  reviewerId: string;
  revision: number;
  decision: 'approve' | 'request_changes';
  evidence: string;
  createdAt: string;
}
export interface GroupExecution {
  id: string;
  agentId: string;
  rootId: string;
  taskId: string | null;
  purpose: 'message' | 'execute' | 'review';
  status: 'running' | 'waiting' | 'completed' | 'failed' | 'interrupted';
  activity: 'thinking' | 'working' | 'responding' | null;
  error?: string | null;
  chatId?: string;
}
export interface GroupReceipt extends AssistantAction {
  groupId: string;
  taskId: string | null;
  agentId: string;
  executionId: string;
}
export interface GroupState extends GroupSummary {
  members: { id: string; profile: AssistantProfile; accountId: string | null }[];
  messageCount: number;
  messages: GroupMessage[];
  deliveries: GroupDelivery[];
  tasks: GroupTask[];
  reviews: GroupReview[];
  executions: GroupExecution[];
  receipts: GroupReceipt[];
  requests: { id: string; turnCount: number; limited: boolean; completed: boolean }[];
}
export interface GroupSendRequest {
  content: string;
  clientMessageId: string;
  recipientIds: string[];
  timeZone: string;
  attachments?: AssistantAttachment[];
}
export interface GroupTaskCreate {
  rootId?: string;
  title: string;
  instructions: string;
  expectedResult: string;
  ownerId?: string;
  dependencyIds?: string[];
  workingDirectory?: string;
  fileResponsibilities?: string[];
}
export interface GroupPendingMessage {
  id: string;
  request: GroupSendRequest;
  createdAt: string;
  status: 'sending' | 'failed';
  error?: string;
}
