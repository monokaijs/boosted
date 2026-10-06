import { api } from '@/lib/api';
import type { AgentIntegration, AgentIntegrationCreate, AgentIntegrationUpdate, AgentIntegrationChat, AssistantState, AssistantSummary, AssistantMessageRequest, CreateAssistantRequest } from '../types/assistant';
import type { AgentUsage } from './usage';
import type { ProviderModelPresets } from '../types/providers';
import type { ProviderDefinitionResponse, ProviderAccountResponse, CreateProviderAccountRequest, UpdateProviderAccountRequest, AuthenticateProviderAccountResponse, ProviderModelListResponse, ProviderAccountLimitsResponse } from '../types/providers';
export type * from '../types/providers';
const encode = encodeURIComponent;
function request<T>(path: string, method = 'GET', body?: unknown) {
  return api.featureRequest<T>(path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
export const apiClient = {
  assistant: {
    usage: (days: number) => request<AgentUsage>(`/agents/usage?days=${days}`),
    list: () => request<AssistantSummary[]>('/agents'),
    create: (body: CreateAssistantRequest) => request<AssistantState>('/agents', 'POST', body),
    read: (id: string, signal?: AbortSignal) => api.featureRequest<AssistantState>(`/agents/${encode(id)}`, { signal }),
    send: (id: string, body: AssistantMessageRequest) => request<AssistantState>(`/agents/${encode(id)}/messages`, 'POST', body),
    stop: (id: string) => request<AssistantState>(`/agents/${encode(id)}/stop`, 'POST'),
    updateAvatar: (id: string, avatar: string) => request<AssistantState>(`/agents/${encode(id)}/avatar`, 'PUT', { avatar }),
    cancelFollowUp: (id: string, followUpId: string) => request<AssistantState>(`/agents/${encode(id)}/follow-ups/${encode(followUpId)}`, 'DELETE'),
    integrations: (id: string) => request<AgentIntegration[]>(`/agents/${encode(id)}/integrations`),
    createIntegration: (id: string, body: AgentIntegrationCreate) => request<AgentIntegration>(`/agents/${encode(id)}/integrations`, 'POST', body),
    updateIntegration: (id: string, integrationId: string, body: AgentIntegrationUpdate) => request<AgentIntegration>(`/agents/${encode(id)}/integrations/${encode(integrationId)}`, 'PATCH', body),
    deleteIntegration: (id: string, integrationId: string) => request<void>(`/agents/${encode(id)}/integrations/${encode(integrationId)}`, 'DELETE'),
    testIntegration: (id: string, integrationId: string) => request<{ ok: true }>(`/agents/${encode(id)}/integrations/${encode(integrationId)}/test`, 'POST'),
    integrationChats: (id: string, integrationId: string) => request<AgentIntegrationChat[]>(`/agents/${encode(id)}/integrations/${encode(integrationId)}/chats`),
    setIntegrationChatApproval: (id: string, integrationId: string, chatId: string, approved: boolean) => request<AgentIntegrationChat>(`/agents/${encode(id)}/integrations/${encode(integrationId)}/chats/${encode(chatId)}/${approved ? 'approve' : 'revoke'}`, 'POST'),
  },
  providers: { list: () => request<ProviderDefinitionResponse[]>('/providers') },
  modelPresets: {
    read: () => request<ProviderModelPresets>('/provider-model-presets'),
    update: (body: ProviderModelPresets) => request<ProviderModelPresets>('/provider-model-presets', 'PUT', body),
  },
  providerAccounts: {
    list: () => request<ProviderAccountResponse[]>('/provider-accounts'),
    create: (body: CreateProviderAccountRequest) => request<ProviderAccountResponse>('/provider-accounts', 'POST', body),
    get: (id: string) => request<ProviderAccountResponse>(`/provider-accounts/${encode(id)}`),
    update: (id: string, body: UpdateProviderAccountRequest) => request<ProviderAccountResponse>(`/provider-accounts/${encode(id)}`, 'PATCH', body),
    delete: (id: string) => request<void>(`/provider-accounts/${encode(id)}`, 'DELETE'),
    authenticate: (id: string) => request<AuthenticateProviderAccountResponse>(`/provider-accounts/${encode(id)}/authenticate`, 'POST'),
    models: (id: string) => request<ProviderModelListResponse>(`/provider-accounts/${encode(id)}/models`),
    limits: () => request<ProviderAccountLimitsResponse>('/provider-accounts/limits'),
  },
};
