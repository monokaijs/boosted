import type { AssistantState, AssistantSummary, CreateAssistantRequest } from '../../types/assistant';
import type { ProviderAccountResponse } from '../../types/providers';
export interface SessionShellState {
  agents: AssistantSummary[];
  chatAccounts: ProviderAccountResponse[];
  chats: { id: string; title: string; workingDirectory?: string; status: string }[];
  recentWorkspaces: { id: string; name: string; path: string }[];
  updateAgent(agent: AssistantState): void;
  selectAgent(id: string): void;
  openCreateAgent(): void;
  createAgent(input: CreateAssistantRequest): Promise<void>;
  selectManagementView(view: 'providers'): void;
  selectNavigationView(view: 'projects'): void;
  openSidebarChat(chat: { id: string; title: string }): Promise<void>;
}
