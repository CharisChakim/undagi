import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { runMetadataCommand } from "./process.ts";
import type { RuntimeDetection, RuntimeDiscoveryReport, RuntimeId } from "./types.ts";

/**
 * Remaining plan usage of a connected runtime, as the runtime itself reports it.
 * Only runtimes with an official, non-prompt way to read it have a reader;
 * reading never sends a model prompt, so it never spends quota.
 */

export interface UsageWindow {
  /** Stable per-runtime id: "five_hour", "seven_day", "primary", "secondary". */
  id: string;
  /** Name to show instead of one made from the window length, when the runtime groups its limits by model. */
  label?: string;
  /** Length of the window, or null when the runtime does not say. */
  windowMinutes: number | null;
  /** 0–100, share of the window already used. */
  usedPercent: number;
  /** ISO 8601 time the window resets, or null. */
  resetsAt: string | null;
}

export interface ParsedUsage {
  plan: string | null;
  windows: UsageWindow[];
}

export interface RuntimeUsageEntry extends ParsedUsage {
  runtime: RuntimeId;
  label: string;
  /** Stable code when the read failed; `windows` is empty then. */
  error: string | null;
}

export interface RuntimeUsageReport {
  fetchedAt: string;
  entries: RuntimeUsageEntry[];
}

/** Returns null when the runtime has no plan limits to show (an API key, say). */
export type UsageReader = (detection: RuntimeDetection) => Promise<ParsedUsage | null>;

const USAGE_LABELS: Record<RuntimeId, string> = {
  codex: "Codex",
  claude: "Claude Code",
  antigravity: "Antigravity",
};

const READ_TIMEOUT_MS = 20_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function percent(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(100, Math.max(0, Math.round(value)))
    : null;
}

function isoFromString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

function isoFromUnixSeconds(value: unknown): string | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? new Date(value * 1000).toISOString()
    : null;
}

function plan(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

const CLAUDE_WINDOWS: ReadonlyArray<readonly [key: string, minutes: number]> = [
  ["five_hour", 300],
  ["seven_day", 10_080],
];

/**
 * The Claude Agent SDK's `get_usage` answer. `rate_limits_available: false`
 * (API key, Bedrock, Vertex) means there is no plan to show.
 */
export function parseClaudeUsage(response: unknown): ParsedUsage | null {
  if (!isRecord(response) || response.rate_limits_available !== true || !isRecord(response.rate_limits)) return null;
  const limits = response.rate_limits;
  const windows: UsageWindow[] = [];
  for (const [key, windowMinutes] of CLAUDE_WINDOWS) {
    const item = limits[key];
    const usedPercent = isRecord(item) ? percent(item.utilization) : null;
    if (usedPercent === null || !isRecord(item)) continue;
    windows.push({ id: key, windowMinutes, usedPercent, resetsAt: isoFromString(item.resets_at) });
  }
  return { plan: plan(response.subscription_type), windows };
}

/** The Codex app-server's `account/rateLimits/read` result. */
export function parseCodexRateLimits(result: unknown): ParsedUsage | null {
  const snapshot = isRecord(result) && isRecord(result.rateLimits) ? result.rateLimits : null;
  if (!snapshot) return null;
  const windows: UsageWindow[] = [];
  for (const key of ["primary", "secondary"] as const) {
    const item = snapshot[key];
    const usedPercent = isRecord(item) ? percent(item.usedPercent) : null;
    if (usedPercent === null || !isRecord(item)) continue;
    const minutes = item.windowDurationMins;
    windows.push({
      id: key,
      windowMinutes: typeof minutes === "number" && Number.isFinite(minutes) && minutes > 0 ? minutes : null,
      usedPercent,
      resetsAt: isoFromUnixSeconds(item.resetsAt),
    });
  }
  return { plan: plan(snapshot.planType), windows };
}

/**
 * Ask a `codex app-server` for the account's rate limits. Only the handshake and
 * the one read are sent; the answer's account id and credit details are dropped
 * by the parser.
 */
export function readCodexUsage(
  executable: string,
  options: { env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): Promise<ParsedUsage | null> {
  const timeoutMs = options.timeoutMs ?? READ_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    let settled = false;
    let buffer = "";
    const child = spawn(executable, ["app-server"], {
      env: { ...process.env, ...options.env, NO_COLOR: "1", TERM: "dumb" },
      shell: false,
      stdio: ["pipe", "pipe", "ignore"],
    });
    const finish = (done: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!child.killed) child.kill("SIGTERM");
      done();
    };
    const timer = setTimeout(() => finish(() => reject(new Error("USAGE_TIMEOUT"))), timeoutMs);
    const send = (message: Record<string, unknown>) => {
      child.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
    };

    child.stdin?.on("error", () => child.kill("SIGTERM"));
    child.once("error", () => finish(() => reject(new Error("USAGE_PROCESS_ERROR"))));
    child.once("close", () => finish(() => reject(new Error("USAGE_PROCESS_EXITED"))));
    child.stdout?.on("data", (chunk: Buffer | string) => {
      buffer += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk;
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
        if (!line) continue;
        let message: unknown;
        try { message = JSON.parse(line); } catch { continue; }
        if (!isRecord(message)) continue;
        if (message.id === 1) {
          send({ method: "initialized", params: {} });
          send({ id: 2, method: "account/rateLimits/read" });
        } else if (message.id === 2) {
          finish(() => (message as Record<string, unknown>).error === undefined
            ? resolve(parseCodexRateLimits((message as Record<string, unknown>).result))
            : reject(new Error("USAGE_REJECTED")));
        }
      }
    });
    send({
      id: 1,
      method: "initialize",
      params: { clientInfo: { name: "undagi-usage", version: "0.1.0" }, capabilities: {} },
    });
  });
}

// `agy` answers `-p "/usage"` itself only from this version on; an older one
// would send "/usage" to the model as a prompt and spend quota.
const ANTIGRAVITY_USAGE_MIN_VERSION: readonly [number, number, number] = [1, 1, 11];

function versionAtLeast(version: string | null, minimum: readonly [number, number, number]): boolean {
  const match = version?.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) return false;
  for (let index = 0; index < 3; index += 1) {
    const part = Number(match[index + 1]);
    if (part !== minimum[index]) return part > minimum[index];
  }
  return true;
}

// "Claude and GPT models" is too long for a row; "Claude & GPT" is the same group.
function groupLabel(name: string): string {
  return name.replace(/\s+models?$/i, "").replace(/\s+and\s+/gi, " & ").trim() || name;
}

/**
 * The `agy -p "/usage" --output-format json` answer: limits grouped by model
 * family. Each group shows the bucket with the least left, the one that
 * will stop the user first.
 */
export function parseAntigravityUsage(response: unknown): ParsedUsage | null {
  const command = isRecord(response) && isRecord(response.command) ? response.command : null;
  const data = command?.name === "usage" && isRecord(command.data) ? command.data : null;
  if (!data || !Array.isArray(data.groups)) return null;
  const windows: UsageWindow[] = [];
  for (const group of data.groups) {
    if (!isRecord(group) || typeof group.name !== "string" || !Array.isArray(group.buckets)) continue;
    let tightest: Record<string, unknown> | null = null;
    for (const bucket of group.buckets) {
      if (!isRecord(bucket) || typeof bucket.remaining_fraction !== "number" || !Number.isFinite(bucket.remaining_fraction)) continue;
      if (!tightest || bucket.remaining_fraction < (tightest.remaining_fraction as number)) tightest = bucket;
    }
    const usedPercent = tightest ? percent(100 - (tightest.remaining_fraction as number) * 100) : null;
    if (!tightest || usedPercent === null) continue;
    windows.push({
      id: typeof tightest.id === "string" && tightest.id ? tightest.id : group.name,
      label: groupLabel(group.name),
      windowMinutes: tightest.window === "weekly" ? 10_080 : null,
      usedPercent,
      resetsAt: isoFromString(tightest.reset_time),
    });
  }
  return { plan: null, windows };
}

/**
 * Read Antigravity's quota groups through its non-interactive `/usage`. The CLI
 * answers it without a turn, so it spends nothing; an older CLI is not asked.
 */
export async function readAntigravityUsage(
  executable: string,
  version: string | null,
  options: { timeoutMs?: number } = {},
): Promise<ParsedUsage | null> {
  if (!versionAtLeast(version, ANTIGRAVITY_USAGE_MIN_VERSION)) return null;
  const result = await runMetadataCommand(executable, ["-p", "/usage", "--output-format", "json"], {
    cwd: tmpdir(),
    timeoutMs: options.timeoutMs ?? READ_TIMEOUT_MS,
    stdin: "ignore",
  });
  if (!result.ok) throw new Error(result.timedOut ? "USAGE_TIMEOUT" : "USAGE_COMMAND_FAILED");
  let answer: unknown;
  try {
    answer = JSON.parse(result.stdout);
  } catch {
    throw new Error("USAGE_UNRECOGNIZED");
  }
  const parsed = parseAntigravityUsage(answer);
  if (!parsed) throw new Error("USAGE_UNRECOGNIZED");
  return parsed;
}

interface ClaudeUsageQuery {
  usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET?: (options?: { skipBehaviors?: boolean }) => Promise<unknown>;
  return?: () => Promise<unknown>;
}

type ClaudeQueryFunction = (request: { prompt: AsyncIterable<unknown>; options?: Record<string, unknown> }) => unknown;

/**
 * Read Claude's plan windows through the SDK's experimental usage request. The
 * input stays open without a user message, so nothing reaches the model.
 */
export async function readClaudeUsage(
  query: ClaudeQueryFunction,
  executablePath: string | null,
  timeoutMs = READ_TIMEOUT_MS,
): Promise<ParsedUsage | null> {
  const abortController = new AbortController();
  const input: AsyncIterable<never> = {
    [Symbol.asyncIterator]() {
      return {
        next: () => new Promise<IteratorResult<never>>((resolve) => {
          abortController.signal.addEventListener(
            "abort",
            () => resolve({ value: undefined as never, done: true }),
            { once: true },
          );
        }),
      };
    },
  };
  const session = query({
    prompt: input,
    options: { abortController, ...(executablePath ? { pathToClaudeCodeExecutable: executablePath } : {}) },
  }) as ClaudeUsageQuery;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const read = session.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET;
    if (typeof read !== "function") throw new Error("USAGE_UNSUPPORTED");
    const response = await Promise.race([
      read.call(session, { skipBehaviors: true }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("USAGE_TIMEOUT")), timeoutMs);
      }),
    ]);
    return parseClaudeUsage(response);
  } finally {
    clearTimeout(timer);
    abortController.abort();
    await session.return?.().catch(() => undefined);
  }
}

/**
 * Usage of every runtime that is connected (`ready`) and has a reader. A runtime
 * whose read fails stays listed with an error, so it does not look disconnected;
 * one with no plan limits is left out.
 */
export async function collectRuntimeUsage(
  report: RuntimeDiscoveryReport,
  readers: Partial<Record<RuntimeId, UsageReader>>,
  now: () => Date = () => new Date(),
): Promise<RuntimeUsageReport> {
  const settled = await Promise.all(report.runtimes.map(async (detection): Promise<RuntimeUsageEntry | null> => {
    const reader = readers[detection.runtime];
    if (detection.status !== "ready" || !reader) return null;
    const base = { runtime: detection.runtime, label: USAGE_LABELS[detection.runtime] };
    try {
      const usage = await reader(detection);
      return usage ? { ...base, ...usage, error: null } : null;
    } catch {
      return { ...base, plan: null, windows: [], error: "USAGE_UNAVAILABLE" };
    }
  }));
  return { fetchedAt: now().toISOString(), entries: settled.filter((entry): entry is RuntimeUsageEntry => entry !== null) };
}
