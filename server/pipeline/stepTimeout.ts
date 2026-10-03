import { msg, type Lang } from "../messages.ts";

export type StepTimeoutKind = "start" | "stall" | "max";

/**
 * Why a pipeline step was given up on. Named TimeoutError so code that already
 * recognises a timed-out request treats it the same way.
 */
export class StepTimeoutError extends Error {
  constructor(readonly kind: StepTimeoutKind, readonly ms: number) {
    super(`The step timed out (${kind}) after ${ms} ms.`);
    this.name = "TimeoutError";
  }
}

export interface StepTimeoutLimits {
  /** The longest wait for the first output. A model on high effort can think for minutes before it writes. */
  startMs: number;
  /** Once output has started, the longest silence before the step counts as stalled. */
  stallMs: number;
  /** A ceiling on the whole step, so a trickle that never ends still stops. */
  maxMs: number;
}

// A fixed 5-minute limit on the whole request cut off a PRD that was still
// writing: a real run took ~100 s to its first character and then wrote for
// minutes. What marks a stuck step is silence, not total time.
export const STEP_LIMITS: StepTimeoutLimits = { startMs: 15 * 60_000, stallMs: 3 * 60_000, maxMs: 30 * 60_000 };

export interface StepDeadline {
  signal: AbortSignal;
  /** Output arrived: restart the silence timer. */
  touch(): void;
  dispose(): void;
}

/** An abort signal that follows `parent` and also fires when the step goes quiet for too long. */
export function stepDeadline(parent?: AbortSignal, limits: StepTimeoutLimits = STEP_LIMITS): StepDeadline {
  const controller = new AbortController();
  let started = false;
  let silence: ReturnType<typeof setTimeout> | undefined;

  const fire = (kind: StepTimeoutKind, ms: number): void => {
    if (!controller.signal.aborted) controller.abort(new StepTimeoutError(kind, ms));
  };
  const arm = (): void => {
    clearTimeout(silence);
    const ms = started ? limits.stallMs : limits.startMs;
    silence = setTimeout(() => fire(started ? "stall" : "start", ms), ms);
    silence.unref?.();
  };
  const ceiling = setTimeout(() => fire("max", limits.maxMs), limits.maxMs);
  ceiling.unref?.();

  const followParent = (): void => controller.abort(parent?.reason);
  if (parent?.aborted) controller.abort(parent.reason);
  else parent?.addEventListener("abort", followParent, { once: true });
  arm();

  return {
    signal: controller.signal,
    touch() {
      if (controller.signal.aborted) return;
      started = true;
      arm();
    },
    dispose() {
      clearTimeout(silence);
      clearTimeout(ceiling);
      parent?.removeEventListener("abort", followParent);
    },
  };
}

/** The timeout that stopped `signal`, if it was one of ours. */
export function stepTimeoutOf(signal: AbortSignal): StepTimeoutError | null {
  return signal.aborted && signal.reason instanceof StepTimeoutError ? signal.reason : null;
}

/** What the user is told when a step times out. */
export function stepTimeoutMessage(error: StepTimeoutError, lang: Lang): string {
  const key = error.kind === "start" ? "stepNoStart" : error.kind === "stall" ? "stepStalled" : "stepTooLong";
  return msg(lang, key, { minutes: Math.max(1, Math.round(error.ms / 60_000)) });
}
