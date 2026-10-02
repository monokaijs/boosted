import { useState } from "react";
import { Button } from "@/components/ui/button";
import type { CodexQuestion } from "@/lib/types";

export function CodexQuestionForm({ questions, onSubmit }: {
  questions: CodexQuestion[];
  onSubmit: (answers: Record<string, { answers: string[] }>) => Promise<void>;
}) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string>();
  if (submitted) return <div className="text-xs text-muted-foreground">Answers sent to Codex.</div>;
  return <form className="space-y-3 rounded-md border border-border bg-secondary/30 p-3 text-xs" onSubmit={async (event) => {
    event.preventDefault();
    if (submitting || questions.some((question) => !answers[question.id]?.trim())) return;
    setSubmitting(true);
    setError(undefined);
    try {
      await onSubmit(Object.fromEntries(questions.map(({ id }) => [id, { answers: [answers[id].trim()] }])));
      setSubmitted(true);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not send answers."); }
    finally { setSubmitting(false); }
  }}>
    {questions.map((question) => <fieldset key={question.id} disabled={submitting} className="space-y-2">
      <legend className="mb-2 whitespace-pre-wrap font-medium">{question.question}</legend>
      {question.options?.map((option, index) => <label key={index} className="flex cursor-pointer items-start gap-2 rounded-md border border-border px-2 py-1.5">
        <input type="radio" name={question.id} aria-label={option.label} aria-description={option.description || undefined} value={option.label} checked={answers[question.id] === option.label} onChange={() => setAnswers((current) => ({ ...current, [question.id]: option.label }))} />
        <span><span className="block">{option.label}</span>{option.description && <span className="mt-0.5 block text-muted-foreground">{option.description}</span>}</span>
      </label>)}
      {question.isSecret
        ? <input className="w-full rounded-md border border-border bg-background px-2 py-1.5 outline-none focus:border-ring" aria-label={`Answer: ${question.question}`} type="password" autoComplete="off" value={answers[question.id] ?? ""} onChange={(event) => setAnswers((current) => ({ ...current, [question.id]: event.target.value }))} />
        : <textarea className="min-h-14 w-full resize-y rounded-md border border-border bg-background px-2 py-1.5 outline-none focus:border-ring" aria-label={`Answer: ${question.question}`} placeholder={question.options?.length ? "Or enter your own answer…" : "Your answer…"} value={answers[question.id] ?? ""} onChange={(event) => setAnswers((current) => ({ ...current, [question.id]: event.target.value }))} />}
    </fieldset>)}
    {error && <p role="alert" className="text-destructive">{error}</p>}
    <div className="flex justify-end"><Button size="sm" type="submit" disabled={submitting || !questions.length || questions.some((question) => !answers[question.id]?.trim())}>{submitting ? "Sending…" : "Send answers"}</Button></div>
  </form>;
}
