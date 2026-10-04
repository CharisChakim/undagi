import express from "express";
import {
  listRuntimeBinaryPaths,
  parseRuntimeBinaryPathInput,
  saveRuntimeBinaryPath,
  RuntimeBinaryPathError,
} from "../runtimes/binary-paths.ts";
import { discoverRuntimes, hasTransientFailure, withLastKnownCatalogs } from "../runtimes/discovery.ts";
import type { RuntimeDetection, RuntimeDiscoveryReport, RuntimeId } from "../runtimes/types.ts";
import {
  collectRuntimeUsage,
  readAntigravityUsage,
  readClaudeUsage,
  readCodexUsage,
  type RuntimeUsageReport,
  type UsageReader,
} from "../runtimes/usage.ts";
import { loadClaudeSdkModule } from "../runtime-runner/index.ts";

const router = express.Router();

/**
 * Remove discovered executable paths before returning discovery to a browser.
 * An override is echoed back because the user typed it themselves; the path
 * discovery found on its own stays hidden.
 */
function publicRuntime(
  runtime: RuntimeDetection,
  overrides: Partial<Record<RuntimeId, string>>,
): Omit<RuntimeDetection, "binaryPath"> & { binaryFound: boolean; binaryPathOverride: string | null } {
  const { binaryPath, ...safe } = runtime;
  return {
    ...safe,
    binaryFound: Boolean(binaryPath),
    binaryPathOverride: overrides[runtime.runtime] ?? null,
  };
}

let cachedReport: RuntimeDiscoveryReport | null = null;
let inFlight: Promise<RuntimeDiscoveryReport> | null = null;
const lastKnownCatalogs = new Map<RuntimeId, RuntimeDetection>();

// A runtime that failed for a passing reason, such as a slow start, is asked
// again on the next read after this, instead of showing as unavailable for the
// whole catalog lifetime.
const TRANSIENT_FAILURE_TTL_MS = 30_000;

function cacheFresh(report: RuntimeDiscoveryReport): boolean {
  const checkedAt = Date.parse(report.checkedAt);
  const ttlMs = hasTransientFailure(report) ? Math.min(report.ttlMs, TRANSIENT_FAILURE_TTL_MS) : report.ttlMs;
  return Number.isFinite(checkedAt) && Date.now() < checkedAt + ttlMs;
}

async function reportFor(force: boolean): Promise<RuntimeDiscoveryReport> {
  if (!force && cachedReport && cacheFresh(cachedReport)) return cachedReport;
  if (inFlight) return inFlight;
  inFlight = (async () => {
    const claudeSdk = await loadClaudeSdkModule().catch(() => null);
    return discoverRuntimes({
      binaryPaths: listRuntimeBinaryPaths(),
      ...(claudeSdk?.supportedModels
        ? { claudeSdk: { supportedModels: claudeSdk.supportedModels } }
        : {}),
    });
  })().then((report) => {
    cachedReport = withLastKnownCatalogs(report, lastKnownCatalogs);
    return cachedReport;
  }).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

function respondWithReport(report: RuntimeDiscoveryReport, res: express.Response): void {
  const overrides = listRuntimeBinaryPaths();
  res.json({
    ...report,
    runtimes: report.runtimes.map((runtime) => publicRuntime(runtime, overrides)),
  });
}

async function discover(req: express.Request, res: express.Response): Promise<void> {
  try {
    respondWithReport(await reportFor(req.method === "POST"), res);
  } catch {
    // Do not echo command/provider output: it can contain environment-specific
    // paths or authentication diagnostics.
    res.status(500).json({ error: "RUNTIME_DISCOVERY_FAILED" });
  }
}

/**
 * Saving an override changes what discovery would resolve, so the cached report
 * is dropped and the answer is a freshly detected one rather than a stale card.
 */
async function saveBinaryPath(req: express.Request, res: express.Response): Promise<void> {
  let input;
  try {
    input = parseRuntimeBinaryPathInput(req.body);
  } catch (error) {
    const code = error instanceof RuntimeBinaryPathError ? error.code : "PATH_INVALID";
    res.status(400).json({ error: code });
    return;
  }
  try {
    saveRuntimeBinaryPath(input);
    cachedReport = null;
    cachedUsage = null;
    respondWithReport(await reportFor(true), res);
  } catch {
    res.status(500).json({ error: "RUNTIME_DISCOVERY_FAILED" });
  }
}

/**
 * Detect the runtimes before anyone asks. A first detection spawns each CLI and
 * takes several seconds, which the user otherwise watches as "Detecting..." the
 * moment the window opens. A request that arrives meanwhile shares this one.
 */
export function warmRuntimeDiscovery(): void {
  void reportFor(false).catch(() => undefined);
}

// Reading usage spawns the runtime's CLI, so an answer is reused for a minute.
// A runtime with no entry here has no official way to read its usage.
const USAGE_TTL_MS = 60_000;
let cachedUsage: { report: RuntimeUsageReport; at: number } | null = null;
let usageInFlight: Promise<RuntimeUsageReport> | null = null;

async function usageFor(force: boolean): Promise<RuntimeUsageReport> {
  if (!force && cachedUsage && Date.now() < cachedUsage.at + USAGE_TTL_MS) return cachedUsage.report;
  if (usageInFlight) return usageInFlight;
  usageInFlight = (async () => {
    const [discovery, claudeSdk] = await Promise.all([
      reportFor(false),
      loadClaudeSdkModule().catch(() => null),
    ]);
    const readers: Partial<Record<RuntimeId, UsageReader>> = {
      codex: (detection) => readCodexUsage(detection.binaryPath ?? "codex"),
      antigravity: (detection) => readAntigravityUsage(detection.binaryPath ?? "agy", detection.version),
    };
    if (claudeSdk) readers.claude = (detection) => readClaudeUsage(claudeSdk.query, detection.binaryPath);
    return collectRuntimeUsage(discovery, readers);
  })().then((report) => {
    cachedUsage = { report, at: Date.now() };
    return report;
  }).finally(() => {
    usageInFlight = null;
  });
  return usageInFlight;
}

async function usage(req: express.Request, res: express.Response): Promise<void> {
  try {
    res.json(await usageFor(req.method === "POST"));
  } catch {
    res.status(500).json({ error: "RUNTIME_USAGE_FAILED" });
  }
}

router.get("/api/runtimes", discover);
router.post("/api/runtimes/discover", discover);
router.put("/api/runtimes/binary-path", saveBinaryPath);
router.get("/api/runtimes/usage", usage);
router.post("/api/runtimes/usage", usage);

export { router };
export default router;
