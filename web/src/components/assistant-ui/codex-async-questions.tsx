import { createContext, useContext, type ReactNode } from "react";
import { useAuiState } from "@assistant-ui/react";
import { CodexQuestionForm } from "@/components/assistant-ui/codex-question-form";
import { codexQuestionItemId } from "@/lib/codex-message-format";
import type { CodexChatMessage } from "@/lib/types";

type Questions = NonNullable<CodexChatMessage["questions"]>;
type QuestionContext = {
  answered: Set<string>;
  reply: (messageId: string, questions: Questions, answers: Record<string, { answers: string[] }>) => Promise<void>;
};
const Context = createContext<QuestionContext | undefined>(undefined);

export function CodexAsyncQuestionProvider({ children, value }: { children: ReactNode; value: QuestionContext }) {
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function CodexAsyncQuestions() {
  const context = useContext(Context);
  const messageId = useAuiState((state) => state.message.id);
  const questions = useAuiState((state) => state.message.metadata.custom.questions as Questions | undefined);
  if (!context || !questions?.length) return null;
  if (questions.every((_, index) => context.answered.has(codexQuestionItemId(messageId, index)))) return null;
  return <div className="mt-3"><CodexQuestionForm questions={questions.map((question, index) => ({
    id: String(index), header: "Codex question", question: question.title,
    options: question.options?.map((label) => ({ label, description: "" })),
  }))} onSubmit={(answers) => context.reply(messageId, questions, answers)} /></div>;
}
