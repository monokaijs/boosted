import { useCallback, useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useAppStore } from '@/lib/store';
import { useBoostedApiClient } from '@/lib/api-context';
import { AssistantPage } from './components/session/assistant-page';
import { CreateAgentDialog } from './components/session/create-agent-dialog';
import { apiClient } from './lib/api-client';
import type { AssistantState } from './types/assistant';
import type { SessionShellState } from './components/session/session-shell';
import { assistantSummary, shouldAcceptAssistantState } from './lib/assistant-state';
import { openProvidersEvent } from './events';
import './agents.css';

export function AgentsPanel({ selectedId, selectAgent, createAgentOpen, onCreateAgentOpenChange }: { selectedId: string; selectAgent(id: string): void; createAgentOpen: boolean; onCreateAgentOpenChange(open: boolean): void }) {
  const { profileId } = useBoostedApiClient();
  const queryClient = useQueryClient();
  const agents = useQuery({ queryKey: ['agents'], queryFn: apiClient.assistant.list, refetchInterval: 5000 });
  const accounts = useQuery({ queryKey: ['provider-accounts'], queryFn: apiClient.providerAccounts.list, staleTime: 30_000 });
  const projects = useQuery({ queryKey: ['projects'], queryFn: api.projects });
  const chats = useQuery({ queryKey: ['codex-chats', 'agents'], queryFn: () => api.codexChats(''), staleTime: 10_000 });
  const selected = agents.data?.find((a) => a.id === selectedId) ?? agents.data?.[0];
  const updateAgent = useCallback((agent: AssistantState) => queryClient.setQueryData(['agents'], (old: typeof agents.data) => old?.map((a) => a.id === agent.id && shouldAcceptAssistantState(a, agent, agent.id) ? assistantSummary(agent) : a)), [queryClient]);
  const shell = useMemo<SessionShellState>(() => ({
    agents: agents.data ?? [], chatAccounts: accounts.data ?? [],
    chats: chats.data?.map((chat) => ({ id: chat.id, title: chat.title, workingDirectory: chat.cwd, status: chat.status === 'active' ? 'RUNNING' : 'IDLE' })) ?? [],
    recentWorkspaces: projects.data?.map((p) => ({ id: p.id, name: p.name, path: p.repoPath })) ?? [],
    updateAgent,
    selectAgent,
    openCreateAgent: () => onCreateAgentOpenChange(true),
    createAgent: async (input) => { const agent = await apiClient.assistant.create(input); await queryClient.invalidateQueries({ queryKey: ['agents'] }); selectAgent(agent.id); },
    selectManagementView: () => window.dispatchEvent(new Event(openProvidersEvent)),
    selectNavigationView: () => window.dispatchEvent(new Event('boosted:open-project')),
    openSidebarChat: async (chat) => {
      const loaded = await api.codexChat(chat.id);
      const project = projects.data?.find((p) => p.repoPath === loaded.chat.cwd);
      if (project) useAppStore.getState().selectProject(project);
      // Selecting a project remounts the docking workspace; dispatch after that render.
      window.setTimeout(() => window.dispatchEvent(new CustomEvent('boosted:open-codex-chat', { detail: { threadId: chat.id, title: chat.title } })), 100);
    },
  }), [agents.data, accounts.data, chats.data, projects.data, profileId, queryClient, updateAgent, selectAgent, onCreateAgentOpenChange]);
  return <section className="flex h-full min-h-0 flex-col" aria-label="Agents">
    {agents.error ? <p role="alert" className="p-4 text-xs text-destructive">{agents.error.message}</p> : selected ? <div className="min-h-0 flex-1"><AssistantPage key={`${profileId}:${selected.id}`} shell={shell} agentId={selected.id} /></div> : <p className="p-4 text-xs text-muted-foreground">Loading agents…</p>}
    <CreateAgentDialog shell={shell} open={createAgentOpen} onOpenChange={onCreateAgentOpenChange} />
  </section>;
}
