import { isChatActionVisible } from '@/features/agents/lib/assistant-actions';
import type { GroupState } from './types';

// Execution chat IDs record watched child runs; other tool chat IDs may only
// reference an existing conversation. Only creation receipts add child chats.
export function groupChildChats(group: Pick<GroupState, 'executions' | 'receipts'>) {
  const chats = group.executions.flatMap((execution) => execution.chatId?.trim() ? [{
    id: execution.id, chatId: execution.chatId, agentId: execution.agentId, rootId: execution.rootId, taskId: execution.taskId,
  }] : []);
  for (const receipt of group.receipts.filter(isChatActionVisible)) {
    const execution = group.executions.find((item) => item.id === receipt.executionId);
    chats.push({ id: receipt.id, chatId: receipt.chatId!, agentId: receipt.agentId, rootId: execution?.rootId ?? '', taskId: receipt.taskId });
  }
  return chats.filter((chat, index) => chats.findIndex((other) => other.chatId === chat.chatId) === index);
}
