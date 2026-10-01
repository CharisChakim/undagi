// Thin client for Jev (TypeSafe AI) POST /v1/systemone. Jev is advisory here, so
// there are no retries: a slow or failing call must cost the caller one short
// timeout and then fall back to its existing behaviour.

export const JEV_BASE_URL = "https://api.typesafe.ai";
export const JEV_MODEL = "jev-latest";
/** Advisory calls sit on the user's critical path (chat send), so keep them short. */
export const JEV_DEFAULT_TIMEOUT_MS = 4000;

/** Float noise from the API (1.0000001) is tolerated, then clamped. */
const RANGE_EPSILON = 1e-6;

// Sesuai docs: instructions boleh string atau objek data yang punya field `question`.
type JevInstructions = string | Record<string, unknown> | unknown[];

export interface NoulQuestion {
  type: "noul";
  instructions: JevInstructions;
  criteria?: { true: string; false: string };
}

export interface ChoiceQuestion {
  type: "choice";
  instructions: JevInstructions;
  criteria: Record<string, string | null>;
}

export interface ScoreQuestion {
  type: "score";
  instructions: JevInstructions;
  /** One description per level, 2..10 levels; the score runs 0..levels-1. */
  criteria: string[];
}

export type JevQuestion = NoulQuestion | ChoiceQuestion | ScoreQuestion;

export interface NoulAnswer {
  type: "noul";
  /** Probability (0..1) of "yes". */
  noul: number;
}

export interface ChoiceAnswer {
  type: "choice";
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
}

export interface ScoreAnswer {
  type: "score";
  /** Probability-weighted, so it can fall between two levels. */
  score: number;
  probabilities: Record<string, number>;
  confidence: number;
}

export type JevAnswer = NoulAnswer | ChoiceAnswer | ScoreAnswer;

export interface JevClient {
  evaluate(state: unknown, questions: Record<string, JevQuestion>): Promise<Record<string, JevAnswer>>;
}

export interface JevClientOptions {
  apiKey: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/**
 * The message is written by this file only: never the key, the request body or
 * the response text, so it is safe to log and to show in the settings UI.
 */
export class JevError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "JevError";
  }
}

function statusMessage(status: number): string {
  switch (status) {
    case 401: return "Jev rejected the API key (401)";
    case 422: return "Jev rejected the request (422)";
    case 429: return "Jev rate limit reached (429)";
    case 529: return "Jev is overloaded (529)";
    default: return `Jev returned HTTP ${status}`;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function inUnit(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= -RANGE_EPSILON && value <= 1 + RANGE_EPSILON;
}

const clamp = (value: number, max = 1) => Math.min(max, Math.max(0, value));

function malformed(): JevError {
  return new JevError("Jev returned an unexpected answer");
}

function probabilitiesOf(value: unknown): Record<string, number> {
  if (!isRecord(value)) throw malformed();
  const result: Record<string, number> = {};
  for (const [key, probability] of Object.entries(value)) {
    if (!inUnit(probability)) throw malformed();
    result[key] = clamp(probability);
  }
  return result;
}

function parseAnswer(raw: unknown, question: JevQuestion): JevAnswer {
  if (!isRecord(raw) || raw.type !== question.type) throw malformed();

  if (question.type === "noul") {
    if (!inUnit(raw.noul)) throw malformed();
    return { type: "noul", noul: clamp(raw.noul) };
  }

  if (!inUnit(raw.confidence)) throw malformed();
  const confidence = clamp(raw.confidence);
  // `probabilities` is descriptive; it is optional so that a missing one does not
  // cost us an otherwise valid decision.
  const probabilities = raw.probabilities === undefined ? {} : probabilitiesOf(raw.probabilities);

  if (question.type === "choice") {
    if (typeof raw.choice !== "string" || !Object.hasOwn(question.criteria, raw.choice)) throw malformed();
    return { type: "choice", choice: raw.choice, probabilities, confidence };
  }

  const maxScore = question.criteria.length - 1;
  if (
    typeof raw.score !== "number" || !Number.isFinite(raw.score) ||
    raw.score < -RANGE_EPSILON || raw.score > maxScore + RANGE_EPSILON
  ) throw malformed();
  return { type: "score", score: clamp(raw.score, maxScore), probabilities, confidence };
}

export function createJevClient(options: JevClientOptions): JevClient {
  const apiKey = typeof options.apiKey === "string" ? options.apiKey.trim() : "";
  const baseUrl = (options.baseUrl ?? JEV_BASE_URL).replace(/\/+$/, "");
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? JEV_DEFAULT_TIMEOUT_MS;

  return {
    async evaluate(state, questions) {
      if (!apiKey) throw new JevError("No Jev API key configured");
      const ids = Object.keys(questions);
      if (ids.length === 0) throw new JevError("No questions to evaluate");

      let response: Response;
      let text: string;
      try {
        response = await fetchImpl(`${baseUrl}/v1/systemone`, {
          method: "POST",
          headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({ state, model: JEV_MODEL, questions }),
          signal: AbortSignal.timeout(timeoutMs),
          // Authorization must not follow a redirect to somewhere unexpected.
          redirect: "error",
        });
        // The same signal also covers reading the body.
        text = await response.text();
      } catch (error) {
        const name = error instanceof Error ? error.name : "";
        // Deliberately not error.message: undici puts URLs and causes in there.
        if (name === "TimeoutError" || name === "AbortError") throw new JevError("Jev request timed out");
        throw new JevError("Could not reach Jev");
      }

      if (!response.ok) throw new JevError(statusMessage(response.status), response.status);

      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        throw new JevError("Jev returned an unreadable response", response.status);
      }
      if (!isRecord(body) || !isRecord(body.answers)) throw malformed();

      const answers: Record<string, JevAnswer> = {};
      for (const id of ids) {
        if (!Object.hasOwn(body.answers, id)) throw malformed();
        answers[id] = parseAnswer(body.answers[id], questions[id]);
      }
      return answers;
    },
  };
}
