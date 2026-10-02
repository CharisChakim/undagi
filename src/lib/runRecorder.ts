import type { TFunction } from "./i18n";
import type { RunReport } from "./runRetry";
import { agentNoteFrom, memoryFactsFrom, runFailedAtDone, taskOutcomeFor } from "./taskOutcome";

/**
 * Follows one run's stream and says, once it has ended, what it amounted to for
 * the task card it was started from. useAgentRun tells it what arrived; the chat
 * entries are not its business.
 */
export class RunRecorder {
  // Only the words after the last tool call: the narration before is neither the
  // card's note nor its verdict.
  private finalText = "";
  private failed = false;
  private interrupted = false;
  private ended = false;
  private error: string | null = null;
  private errorCode: string | null = null;

  constructor(private readonly t: TFunction) {}

  /** The server ended the run with its done event, however the run went. */
  get sawDone(): boolean {
    return this.ended;
  }

  addText(chunk: string): void {
    this.finalText += chunk;
  }

  toolStarted(): void {
    this.finalText = "";
  }

  /** An error event, or the stream itself breaking. */
  fail(message: string, code: string | null = null): void {
    this.failed = true;
    this.error = message;
    this.errorCode = code;
  }

  done(event: { runStatus?: unknown; stop?: unknown }): void {
    this.ended = true;
    this.failed = runFailedAtDone(this.failed, event);
    if (event.stop === "max_tokens") this.error ??= this.t("The model's answer was cut off.");
    if (event.runStatus === "interrupted") this.interrupted = true;
  }

  /** Where the card goes, the agent's note, and why the run failed if it did. */
  report(aborted: boolean): RunReport {
    const stopped = aborted || this.interrupted;
    const failed = this.failed || !this.ended;
    const failure = failed && !stopped;
    return {
      outcome: taskOutcomeFor({ aborted: stopped, failed, text: this.finalText }),
      note: agentNoteFrom(this.finalText),
      memory: memoryFactsFrom(this.finalText),
      error: failure ? (this.error ?? this.t("The run ended with an error.")) : null,
      errorCode: failure ? this.errorCode : null,
    };
  }
}
