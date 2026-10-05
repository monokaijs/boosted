import { useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import type { CodexQuestion } from "@/lib/types";
import "./codex-question-form.css";

type QuestionFormProps = {
  requestId: string;
  questions: CodexQuestion[];
  onSubmit: (answers: Record<string, { answers: string[] }>) => Promise<void>;
};

export function CodexQuestionForm(props: QuestionFormProps) {
  // Polling can produce new arrays for the same payload. Reset only for a different
  // request or changed questions, never carry answers/submitted state between them.
  return <QuestionWizard key={JSON.stringify([props.requestId, props.questions])} {...props} />;
}

function QuestionWizard({ questions, onSubmit }: QuestionFormProps) {
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState(0);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string>();
  const inFlight = useRef(false);
  const completed = useRef(false);
  const mounted = useRef(true);
  const heading = useRef<HTMLLegendElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const receipt = useRef<HTMLParagraphElement>(null);
  const id = useId();
  const question = questions[step];
  const multiple = questions.length > 1;
  const last = step === questions.length - 1;
  const valid = (index: number) => Boolean(answers[questions[index].id]?.trim());

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => {
    if (open) {
      if (body.current) body.current.scrollTop = 0;
      heading.current?.focus({ preventScroll: true });
    }
  }, [open, step]);

  async function submit() {
    if (!questions.length || inFlight.current || completed.current) return;
    if (!valid(step)) return;
    if (!last) { setStep(step + 1); return; }
    const missing = questions.findIndex((_, index) => !valid(index));
    if (missing >= 0) { setStep(missing); return; }
    // A ref closes the gap before React commits disabled buttons, including repeated
    // keyboard/form events. A failed request unlocks retry with the same answers.
    inFlight.current = true;
    setSubmitting(true);
    setError(undefined);
    try {
      await onSubmit(Object.fromEntries(questions.map(({ id }) => [id, { answers: [answers[id].trim()] }])));
      completed.current = true;
      if (mounted.current) { setSubmitted(true); setOpen(false); }
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : "Could not send answers.");
    } finally {
      inFlight.current = false;
      if (mounted.current) setSubmitting(false);
    }
  }

  return <Dialog open={open} onOpenChange={setOpen}>
    <div className="question-request">
      {submitted
        ? <p ref={receipt} role="status" tabIndex={-1}>Answers sent to Codex.</p>
        : <>
          <p id={`${id}-summary`}><strong>{questions[0]?.header || "Codex needs your input"}</strong><span>{questions.length} {multiple ? "questions" : "question"}</span></p>
          <DialogTrigger asChild><Button type="button" size="sm" variant="secondary" disabled={!questions.length} aria-describedby={`${id}-summary`}>{Object.keys(answers).length ? "Continue answers" : multiple ? "Answer questions" : "Answer question"}</Button></DialogTrigger>
        </>}
    </div>
    {question && <DialogContent className="question-wizard-dialog" aria-describedby={`${id}-instructions`}
      onOpenAutoFocus={(event) => { event.preventDefault(); heading.current?.focus({ preventScroll: true }); }}
      onCloseAutoFocus={(event) => {
        if (completed.current) { event.preventDefault(); receipt.current?.focus({ preventScroll: true }); }
      }}>
      <form className="question-wizard-form" aria-label="Codex question answers" aria-busy={submitting} onSubmit={(event) => { event.preventDefault(); void submit(); }}>
        <header className="question-wizard-header">
          <DialogTitle>{multiple ? "Codex questions" : "Codex question"}</DialogTitle>
          <DialogDescription id={`${id}-instructions`} className="sr-only">{multiple ? "Answer one question at a time. Answers are sent together after the last question." : "Choose an option or enter your own answer, then send it to Codex."}</DialogDescription>
          {multiple && <div className="question-wizard-progress"><p role="status" aria-live="polite">Question {step + 1}/{questions.length}</p><progress aria-label="Question progress" value={step + 1} max={questions.length} /></div>}
        </header>
        <div ref={body} className="question-wizard-body">
          <fieldset key={question.id} disabled={submitting} className="question-wizard-fields">
            <legend ref={heading} tabIndex={-1} className="question-wizard-question">{question.header && <span>{question.header}</span>}{question.question}</legend>
            {question.options?.map((option, index) => <label key={index} className="question-wizard-option">
              <input type="radio" name={`${id}-${question.id}`} aria-label={option.label} aria-describedby={option.description ? `${id}-option-${index}` : undefined} value={option.label} checked={answers[question.id] === option.label} onChange={() => setAnswers((current) => ({ ...current, [question.id]: option.label }))} />
              <span><span>{option.label}</span>{option.description && <span id={`${id}-option-${index}`} className="question-wizard-option-description">{option.description}</span>}</span>
            </label>)}
            <label className="question-wizard-answer-label" htmlFor={`${id}-answer`}>{question.options?.length ? "Selected answer or your own response" : "Your answer"}</label>
            {question.isSecret
              ? <input id={`${id}-answer`} className="question-wizard-answer" aria-label={`Answer: ${question.question}`} type="password" autoComplete="off" value={answers[question.id] ?? ""} onChange={(event) => setAnswers((current) => ({ ...current, [question.id]: event.target.value }))} />
              : <textarea id={`${id}-answer`} className="question-wizard-answer" aria-label={`Answer: ${question.question}`} placeholder={question.options?.length ? "Or enter your own answer…" : "Your answer…"} value={answers[question.id] ?? ""} onChange={(event) => setAnswers((current) => ({ ...current, [question.id]: event.target.value }))} />}
          </fieldset>
        </div>
        <footer className="question-wizard-footer">
          {error && <p role="alert" className="question-wizard-error">{error}</p>}
          <div className="question-wizard-navigation">
            {multiple && <Button type="button" variant="outline" disabled={submitting || step === 0} onClick={() => setStep(Math.max(0, step - 1))}>Back</Button>}
            <Button type="submit" disabled={submitting || !valid(step)}>{submitting ? "Sending…" : last ? "Send answers" : "Next"}</Button>
          </div>
        </footer>
      </form>
    </DialogContent>}
  </Dialog>;
}
