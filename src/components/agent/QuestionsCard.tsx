// Copyright (c) 2026 Charis Chakim - Undagi (https://github.com/CharisChakim/undagi)
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import React, { useEffect, useState } from "react";
import { Check, Edit3, HelpCircle, LoaderCircle, Send, Zap } from "lucide-react";
import { useT } from "../../lib/i18n";

/** The local shape mirrors the payload produced by /api/followup-questions. */
export interface QuestionsCardQuestion {
  id: string;
  question: string;
  explanation: string;
  options?: string[];
  suggestedAnswer: string;
  round?: number;
  category?: string;
}

/** A local entry shape keeps this renderer independent from the transcript union. */
export interface QuestionsCardEntry {
  id?: string;
  elicitId: string;
  questions: QuestionsCardQuestion[];
  round: number;
  answered?: boolean;
}

export type QuestionsResponse = Record<string, string>;
export type QuestionsRespondHandler = (
  elicitId: string,
  answers: QuestionsResponse,
) => void | Promise<void>;

export interface QuestionsCardProps {
  entry?: QuestionsCardEntry;
  questions?: QuestionsCardQuestion[];
  elicitId?: string;
  round?: number;
  /** The parent flips this only after the server accepts the response. */
  answered?: boolean;
  /** Alias for parents that use the approval card's resolved terminology. */
  resolved?: boolean;
  onRespond?: QuestionsRespondHandler;
}

const answerFor = (question: QuestionsCardQuestion): string =>
  question.options?.[0] ?? question.suggestedAnswer;

const prefilledAnswers = (questions: QuestionsCardQuestion[]): QuestionsResponse =>
  Object.fromEntries(questions.map((question) => [question.id, answerFor(question)]));

export const QuestionsCard: React.FC<QuestionsCardProps> = ({
  entry,
  questions: suppliedQuestions,
  elicitId: suppliedElicitId,
  round: suppliedRound,
  answered: suppliedAnswered,
  resolved,
  onRespond,
}) => {
  const { t } = useT();
  const questions = entry?.questions ?? suppliedQuestions ?? [];
  const elicitId = entry?.elicitId ?? suppliedElicitId ?? "";
  const round = entry?.round ?? suppliedRound ?? 1;
  const answered = suppliedAnswered ?? resolved ?? entry?.answered ?? false;
  const [answers, setAnswers] = useState<QuestionsResponse>(() => prefilledAnswers(questions));
  const [customAnswerActive, setCustomAnswerActive] = useState<Record<string, boolean>>({});
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // A new elicitation gets fresh prefills. An answered update for the same
  // entry must not erase the choices while the parent waits for server state.
  const questionSignature = questions
    .map((question) => `${question.id}\u0000${question.question}\u0000${question.round ?? ""}`)
    .join("\u0001");
  useEffect(() => {
    setAnswers(prefilledAnswers(questions));
    setCustomAnswerActive({});
    setSubmitting(false);
    setSubmitError(null);
  }, [entry?.id, elicitId, questionSignature]);

  const selectOption = (questionId: string, option: string): void => {
    if (answered || submitting) return;
    setAnswers((current) => ({ ...current, [questionId]: option }));
    setCustomAnswerActive((current) => ({ ...current, [questionId]: false }));
    setSubmitError(null);
  };

  const activateCustomAnswer = (questionId: string): void => {
    if (answered || submitting) return;
    setCustomAnswerActive((current) => ({ ...current, [questionId]: true }));
    setSubmitError(null);
  };

  const fillAllSuggested = (): void => {
    if (answered || submitting) return;
    setAnswers(prefilledAnswers(questions));
    setCustomAnswerActive({});
    setSubmitError(null);
  };

  const submit = (): void => {
    if (answered || submitting || !onRespond) return;

    setSubmitting(true);
    setSubmitError(null);
    // The card remains rendered and disabled until the parent reports `answered`.
    void Promise.resolve()
      .then(() => onRespond(elicitId, answers))
      .catch(() => setSubmitError(t("Something went wrong talking to the LLM.")))
      .finally(() => setSubmitting(false));
  };

  return (
    <section
      className={`overflow-hidden rounded-xl border ${
        answered ? "border-line bg-subtle" : "border-accent/30 bg-surface"
      }`}
      aria-label={t("Clarification from the AI")}
    >
      <div className="flex items-center gap-2 border-b border-line px-3 py-2.5 text-xs font-medium text-accent-ink">
        <HelpCircle className="h-3.5 w-3.5 shrink-0" aria-hidden />
        <span>{t("Clarification from the AI")}</span>
        <span className="ml-auto rounded-full bg-accent-soft px-1.5 py-0.5 text-[10px] font-semibold">
          {t("Round {round}", { round })}
        </span>
        {answered && <Check className="h-3.5 w-3.5 text-ok" aria-label={t("Done")} />}
      </div>

      <div className="space-y-4 p-3">
        {questions.map((question) => {
          const options = question.options && question.options.length > 0
            ? question.options
            : [question.suggestedAnswer];
          const currentAnswer = answers[question.id] ?? "";
          const isCustom = customAnswerActive[question.id] ?? false;

          return (
            <article key={question.id} className="space-y-2.5 rounded-lg border border-line p-3">
              <div className="space-y-1.5">
                <div className="flex flex-wrap items-center gap-1.5">
                  {question.category && (
                    <span className="rounded bg-accent-soft px-1.5 py-0.5 text-[11px] font-semibold text-accent-ink">
                      {question.category}
                    </span>
                  )}
                  {question.round && question.round !== round && (
                    <span className="rounded bg-subtle px-1.5 py-0.5 text-[11px] font-semibold text-muted">
                      {t("Round {round}", { round: question.round })}
                    </span>
                  )}
                </div>
                <h4 className="text-sm font-semibold leading-relaxed text-ink">{question.question}</h4>
                {question.explanation && <p className="text-xs leading-relaxed text-faint">{question.explanation}</p>}
              </div>

              <div className="flex flex-wrap gap-2">
                {options.map((option) => {
                  const selected = !isCustom && currentAnswer === option;
                  return (
                    <button
                      key={option}
                      type="button"
                      onClick={() => selectOption(question.id, option)}
                      disabled={answered || submitting}
                      className={`lift inline-flex items-center gap-2 rounded-lg border px-3 py-1.5 text-left text-xs font-medium disabled:cursor-not-allowed disabled:opacity-60 ${
                        selected
                          ? "border-accent bg-accent text-accent-fg"
                          : "border-line bg-subtle text-muted hover:text-ink"
                      }`}
                    >
                      {selected ? (
                        <Check className="h-3.5 w-3.5 shrink-0" aria-hidden />
                      ) : (
                        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-strong" aria-hidden />
                      )}
                      <span>{option}</span>
                    </button>
                  );
                })}

                <button
                  type="button"
                  onClick={() => activateCustomAnswer(question.id)}
                  disabled={answered || submitting}
                  className={`lift inline-flex items-center gap-2 rounded-lg border px-3 py-1.5 text-left text-xs font-medium disabled:cursor-not-allowed disabled:opacity-60 ${
                    isCustom
                      ? "border-ink bg-ink text-canvas"
                      : "border-line bg-surface text-muted hover:text-ink"
                  }`}
                >
                  <Edit3 className="h-3.5 w-3.5 shrink-0" aria-hidden />
                  <span>{t("My own answer")}</span>
                </button>
              </div>

              {isCustom && (
                <input
                  type="text"
                  value={currentAnswer}
                  disabled={answered || submitting}
                  onChange={(event) => {
                    setAnswers((current) => ({ ...current, [question.id]: event.target.value }));
                    setSubmitError(null);
                  }}
                  placeholder={t("Type your own answer here...")}
                  className="field animate-in fade-in"
                />
              )}
            </article>
          );
        })}
      </div>

      <div className="flex flex-wrap items-center justify-end gap-2 border-t border-line px-3 py-2.5">
        {submitError && <p className="mr-auto text-xs text-danger-ink" role="alert">{submitError}</p>}
        {answered ? (
          <p className="flex items-center gap-1.5 text-xs text-ok-ink">
            <Check className="h-3.5 w-3.5" aria-hidden />
            {t("Done")}
          </p>
        ) : (
          <>
            <button
              type="button"
              onClick={fillAllSuggested}
              disabled={submitting || questions.length === 0}
              className="btn-outline text-xs"
            >
              <Zap className="h-3.5 w-3.5 text-faint" aria-hidden />
              {t("Use the AI recommendations")}
            </button>
            <button
              type="button"
              onClick={submit}
              disabled={submitting || questions.length === 0 || !onRespond}
              className="btn-primary text-xs"
            >
              {submitting ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <Send className="h-3.5 w-3.5" aria-hidden />}
              {submitting ? t("Working...") : t("Send")}
            </button>
          </>
        )}
      </div>
    </section>
  );
};

export default QuestionsCard;
