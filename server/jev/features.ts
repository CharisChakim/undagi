// Jev advice for the four optional features. Every function resolves to null
// (never throws) when Jev is off, unconfigured, slow or failing, so callers keep
// their existing behaviour. Nothing here logs the key or the text being judged.
import { safeString } from "../runs/store.ts";
import { createJevClient, type JevAnswer, type JevClient, type JevQuestion } from "./client.ts";
import { getJevSettings, readJevKey } from "./store.ts";
import type {
  ApprovalAdvice,
  ApprovalRisk,
  DependencyAdvice,
  IntakeAdvice,
  IntentAdvice,
  JevFeature,
  JevIntent,
  JevSettingsPublic,
  JevTaskInput,
} from "./types.ts";

/** Score below this is "low" risk (rubric: 0 harmless, 1 changes files, 2 destructive). */
const RISK_MEDIUM_FROM = 0.7;
/** Score from this up is "high" risk. */
const RISK_HIGH_FROM = 1.4;
/** A dependency is only suggested when Jev is at least this sure (false positives cost more than misses). */
const DEPENDENCY_MIN_PROBABILITY = 0.8;
/** Tasks beyond this are not considered for dependency checks. */
const MAX_DEPENDENCY_TASKS = 60;
/** Upper bound on questions in one dependency request (cost and latency). */
const MAX_DEPENDENCY_PAIRS = 40;
/** Chat message characters sent for intent routing. */
const MAX_INTENT_MESSAGE_CHARS = 2000;
/** Project description characters sent for the intake check. */
const MAX_INTAKE_DESCRIPTION_CHARS = 4000;
/** Earlier intake answers included as context. */
const MAX_INTAKE_ANSWERS = 20;
/** Characters kept per intake answer. */
const MAX_INTAKE_ANSWER_CHARS = 500;
/** Command characters sent for the approval risk check. */
const MAX_APPROVAL_COMMAND_CHARS = 1000;
/** Working folder characters sent for the approval risk check. */
const MAX_APPROVAL_CWD_CHARS = 500;
/** Tool kind characters sent for the approval risk check. */
const MAX_APPROVAL_KIND_CHARS = 100;
/** Runtime-provided reason characters sent for the approval risk check. */
const MAX_APPROVAL_REASON_CHARS = 500;
/** Text redacted before truncation looks at this many characters, so a long tail is never scanned. */
const REDACTION_WINDOW_CHARS = 5000;
/** Task title characters sent per dependency question. */
const MAX_TASK_TITLE_CHARS = 200;
/** Target files listed per task in a dependency question. */
const MAX_TASK_FILES = 10;
/** Characters kept per target file path. */
const MAX_TASK_FILE_CHARS = 200;
/** Shorter target paths are ignored when matching mentions, since "." or "a" would match any text. */
const MIN_MENTIONED_FILE_CHARS = 3;

const INTENTS: Record<JevIntent, string> = {
  plan_project: "The user describes a new project or asks to create or redo the project plan.",
  generate_prd: "The user asks to write or update the product requirements document (PRD).",
  generate_tasks: "The user asks to break the plan down into an implementation task list.",
  run_task: "The user asks to start, execute or continue building one or more tasks now.",
  chat: "A question, discussion or anything else that needs no pipeline step.",
};

export interface AdviseDeps {
  client?: JevClient;
  settings?: JevSettingsPublic;
}

function isActiveIn(settings: JevSettingsPublic, feature: JevFeature): boolean {
  return settings.enabled && settings.hasKey && settings.features[feature] === true;
}

export function isJevActive(feature: JevFeature): boolean {
  try {
    return isActiveIn(getJevSettings(), feature);
  } catch {
    return false;
  }
}

/** Returns the client only when the feature is on; this is the single gate before any outbound call. */
function resolveClient(feature: JevFeature, deps: AdviseDeps | undefined): JevClient | null {
  if (!isActiveIn(deps?.settings ?? getJevSettings(), feature)) return null;
  if (deps?.client) return deps.client;
  const apiKey = readJevKey();
  return apiKey ? createJevClient({ apiKey }) : null;
}

async function withJev<T>(
  feature: JevFeature,
  deps: AdviseDeps | undefined,
  run: (client: JevClient) => Promise<T | null>,
): Promise<T | null> {
  try {
    const client = resolveClient(feature, deps);
    return client ? await run(client) : null;
  } catch {
    // Advice is optional: any failure means "no advice", and the error is dropped
    // on purpose because even a wrapped message could carry request details.
    return null;
  }
}

function pick<T extends JevAnswer["type"]>(
  answers: Record<string, JevAnswer>,
  id: string,
  type: T,
): Extract<JevAnswer, { type: T }> | null {
  const answer = answers[id];
  return answer && answer.type === type ? answer as Extract<JevAnswer, { type: T }> : null;
}

function clip(value: unknown, max: number): string {
  return typeof value === "string" ? value.slice(0, max) : "";
}

// safeString only knows a few key names and `Authorization: <one word>`, so
// things like GITHUB_TOKEN=..., "Bearer ..." and https://user:pass@host would
// still reach a third party. These run first, safeString second.
const EXTRA_REDACTIONS: Array<[RegExp, string]> = [
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [redacted]"],
  [/\b(\w*(?:token|secret|passw(?:or)?d|api[-_]?key|credential|private[-_]?key)\w*\s*=\s*)("[^"]*"|'[^']*'|[^\s,;]+)/gi, "$1[redacted]"],
  [/(:\/\/)[^\s/:@]+:[^\s/@]+@/g, "$1[redacted]@"],
  [/\b(?:sk-|ghp_|gho_|ghs_|github_pat_|xox[abprs]-|AKIA)[A-Za-z0-9_-]{16,}/g, "[redacted]"],
];

function scrub(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  let text = value.slice(0, REDACTION_WINDOW_CHARS);
  for (const [pattern, replacement] of EXTRA_REDACTIONS) text = text.replace(pattern, replacement);
  return safeString(text).slice(0, max);
}

export async function adviseIntent(
  input: { message: string; hasPlan: boolean; hasPrd: boolean; hasTasks: boolean },
  deps?: AdviseDeps,
): Promise<IntentAdvice | null> {
  return withJev("intentRouting", deps, async (client) => {
    const message = clip(input?.message, MAX_INTENT_MESSAGE_CHARS);
    if (!message.trim()) return null;

    const state = {
      message,
      hasPlan: input.hasPlan === true,
      hasPrd: input.hasPrd === true,
      hasTasks: input.hasTasks === true,
    };
    const questions: Record<string, JevQuestion> = {
      intent: {
        type: "choice",
        instructions:
          "Decide what the user wants to do next in a project workbench. Read `message` (their latest message) " +
          "together with `hasPlan`, `hasPrd` and `hasTasks` (which artifacts the project already has).",
        criteria: INTENTS,
      },
    };

    const answer = pick(await client.evaluate(state, questions), "intent", "choice");
    if (!answer || !Object.hasOwn(INTENTS, answer.choice)) return null;
    return { intent: answer.choice as JevIntent, confidence: answer.confidence };
  });
}

export async function adviseIntake(
  input: { description: string; answers?: string[] },
  deps?: AdviseDeps,
): Promise<IntakeAdvice | null> {
  return withJev("intakeCheck", deps, async (client) => {
    const description = clip(input?.description, MAX_INTAKE_DESCRIPTION_CHARS);
    if (!description.trim()) return null;

    const answers = Array.isArray(input.answers)
      ? input.answers
          .filter((answer): answer is string => typeof answer === "string")
          .slice(0, MAX_INTAKE_ANSWERS)
          .map((answer) => clip(answer, MAX_INTAKE_ANSWER_CHARS))
      : [];
    const state = answers.length > 0 ? { description, answers } : { description };

    const questions: Record<string, JevQuestion> = {
      ready: {
        type: "noul",
        instructions:
          "Is this description specific enough to write a project plan without asking further questions? " +
          "Read the project idea in `description` and any clarifying `answers` already given.",
      },
      clarity: {
        type: "score",
        instructions: "How clear and complete is the project idea in `description` (with any `answers`)?",
        criteria: [
          "Vague: a topic or wish without concrete goals, users or scope.",
          "Workable: the goal is clear but some important details are missing.",
          "Detailed: goals, scope and key constraints are all stated.",
        ],
      },
    };

    const answered = await client.evaluate(state, questions);
    const ready = pick(answered, "ready", "noul");
    const clarity = pick(answered, "clarity", "score");
    return ready && clarity ? { ready: ready.noul, clarity: clarity.score } : null;
  });
}

function riskOf(score: number): ApprovalRisk {
  if (score < RISK_MEDIUM_FROM) return "low";
  if (score < RISK_HIGH_FROM) return "medium";
  return "high";
}

export async function adviseApproval(
  input: { command?: string; cwd?: string; kind?: string; reason?: string },
  deps?: AdviseDeps,
): Promise<ApprovalAdvice | null> {
  return withJev("permissionRisk", deps, async (client) => {
    // A third party sees this text, so secrets are stripped before anything else.
    const state = {
      command: scrub(input?.command, MAX_APPROVAL_COMMAND_CHARS),
      cwd: scrub(input?.cwd, MAX_APPROVAL_CWD_CHARS),
      kind: scrub(input?.kind, MAX_APPROVAL_KIND_CHARS),
      reason: scrub(input?.reason, MAX_APPROVAL_REASON_CHARS),
    };
    if (!state.command.trim() && !state.reason.trim()) return null;

    const questions: Record<string, JevQuestion> = {
      risk: {
        type: "score",
        instructions:
          "An autonomous coding agent asks permission to run an action. Rate how risky it is to allow, using " +
          "`command`, `cwd` (the agent's working folder), `kind` (the kind of action) and `reason`.",
        criteria: [
          "Read-only or clearly harmless: inspects, lists or checks things without changing anything.",
          "Changes files or installs packages inside the working folder.",
          "Destructive, network-exposing, credential-touching or reaches outside the working folder.",
        ],
      },
    };

    const answer = pick(await client.evaluate(state, questions), "risk", "score");
    return answer ? { risk: riskOf(answer.score), score: answer.score, confidence: answer.confidence } : null;
  });
}

function normalizePath(path: unknown): string {
  return typeof path === "string" ? path.trim().replace(/\\/g, "/").replace(/^(\.\/)+/, "") : "";
}

interface PairTask {
  task: JevTaskInput;
  files: string[];
  instructions: string;
}

/**
 * Only pairs with a plausible link are asked about, otherwise n tasks would cost
 * n² questions. `[a, b]` means "does a depend on b": a shares a file with an
 * earlier-listed b, or a's instructions name a file that b targets.
 */
function candidatePairs(tasks: JevTaskInput[]): Array<[JevTaskInput, JevTaskInput]> {
  const seen = new Set<string>();
  const list: PairTask[] = [];
  for (const task of tasks) {
    if (!task || typeof task.id !== "string" || !task.id || seen.has(task.id)) continue;
    seen.add(task.id);
    list.push({
      task,
      files: (Array.isArray(task.targetFiles) ? task.targetFiles : []).map(normalizePath).filter(Boolean),
      instructions: typeof task.promptInstructions === "string" ? task.promptInstructions : "",
    });
    if (list.length >= MAX_DEPENDENCY_TASKS) break;
  }

  const linked = (a: JevTaskInput, b: JevTaskInput) =>
    (Array.isArray(a.dependencies) && a.dependencies.includes(b.id)) ||
    (Array.isArray(b.dependencies) && b.dependencies.includes(a.id));

  // Mentions are stronger evidence than a shared file, so they win when the cap bites.
  const mentioned: Array<[JevTaskInput, JevTaskInput]> = [];
  const sharing: Array<[JevTaskInput, JevTaskInput]> = [];
  list.forEach((a, indexA) => {
    list.forEach((b, indexB) => {
      if (indexA === indexB || linked(a.task, b.task)) return;
      if (b.files.some((file) => file.length >= MIN_MENTIONED_FILE_CHARS && a.instructions.includes(file))) mentioned.push([a.task, b.task]);
      else if (indexA > indexB && a.files.some((file) => b.files.includes(file))) sharing.push([a.task, b.task]);
    });
  });
  return [...mentioned, ...sharing].slice(0, MAX_DEPENDENCY_PAIRS);
}

function briefOf(task: JevTaskInput) {
  return {
    id: task.id,
    title: clip(task.title, MAX_TASK_TITLE_CHARS),
    targetFiles: (Array.isArray(task.targetFiles) ? task.targetFiles : [])
      .filter((file): file is string => typeof file === "string")
      .slice(0, MAX_TASK_FILES)
      .map((file) => clip(file, MAX_TASK_FILE_CHARS)),
  };
}

export async function adviseDependencies(
  tasks: JevTaskInput[],
  deps?: AdviseDeps,
): Promise<DependencyAdvice[] | null> {
  return withJev("dependencyCheck", deps, async (client) => {
    if (!Array.isArray(tasks)) return null;
    const pairs = candidatePairs(tasks);
    if (pairs.length === 0) return [];

    const questions: Record<string, JevQuestion> = {};
    pairs.forEach(([a, b], index) => {
      questions[`p${index}`] = {
        type: "noul",
        instructions: {
          taskA: briefOf(a),
          taskB: briefOf(b),
          question: "Must `taskB` be finished before `taskA` can start?",
        },
        criteria: {
          true: "taskA needs something taskB creates or changes, so taskA cannot be done correctly before taskB.",
          false: "The two tasks are independent or can be done in either order.",
        },
      };
    });

    const answers = await client.evaluate({ context: "Ordering of tasks in a software project plan" }, questions);
    const found: DependencyAdvice[] = [];
    pairs.forEach(([a, b], index) => {
      const answer = pick(answers, `p${index}`, "noul");
      if (answer && answer.noul >= DEPENDENCY_MIN_PROBABILITY) {
        found.push({ taskId: a.id, dependsOn: b.id, probability: answer.noul });
      }
    });
    return found.sort((left, right) => right.probability - left.probability);
  });
}
