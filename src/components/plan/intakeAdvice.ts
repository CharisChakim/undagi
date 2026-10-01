import type { IntakeAdvice } from "../../lib/jev";

/** Fewest characters (trimmed) a description needs before Jev is asked on blur. */
export const INTAKE_MIN_CHARS = 20;
/** Readiness (in percent, as shown) from which the note reads "clear enough". */
export const INTAKE_CLEAR_ENOUGH_PERCENT = 75;

export interface IntakeNote {
  percent: number;
  clearEnough: boolean;
}

/**
 * The quiet "Jev: about N% ready" note. Null when there is nothing usable to
 * show. Wording follows the rounded figure so "75%" never reads "needs more detail".
 */
export function intakeNote(advice: Pick<IntakeAdvice, "ready"> | null | undefined): IntakeNote | null {
  if (!advice || typeof advice.ready !== "number" || !Number.isFinite(advice.ready)) return null;
  const percent = Math.round(Math.min(1, Math.max(0, advice.ready)) * 100);
  return { percent, clearEnough: percent >= INTAKE_CLEAR_ENOUGH_PERCENT };
}

/** On blur: long enough, and not the text Jev was last asked about. */
export function shouldAskIntakeOnBlur(description: string, lastAsked: string | null): boolean {
  const text = description.trim();
  return text.length >= INTAKE_MIN_CHARS && text !== lastAsked;
}

/** Answered follow-up questions as "question: answer" lines for the intake request. */
export function intakeAnswerLines(answers: Readonly<Record<string, string>>): string[] {
  return Object.entries(answers)
    .map(([question, answer]) => [question.trim(), String(answer ?? "").trim()] as const)
    .filter(([, answer]) => answer)
    .map(([question, answer]) => (question ? `${question}: ${answer}` : answer));
}
