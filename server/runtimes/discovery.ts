// Copyright (c) 2026 Charis Chakim - Undagi (https://github.com/CharisChakim/undagi)
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { queryClaudeSdk, queryAntigravityCli, type ClaudeSdkMetadataProvider } from "./adapters.ts";
import { queryCodexAppServer } from "./codex.ts";
import { findExecutable, parseRuntimeVersion, runMetadataCommand, type MetadataCommandResult } from "./process.ts";
import { cloneCapabilities, type CatalogSource, type RuntimeCatalog, type RuntimeDetection, type RuntimeDiscoveryReport, type RuntimeId, type RuntimeModel, type RuntimeStatus, RUNTIME_IDS, unknownCapabilities } from "./types.ts";

export const DEFAULT_CATALOG_TTL_MS = 15 * 60 * 1_000;

// Antigravity is driven through the `agy` CLI protocol, and that CLI ships as a
// binary named `agy`. A binary named `antigravity` is the desktop IDE, which can
// never answer `agy models` — matching it only turns a missing CLI into an
// "unsupported version" dead end that hides the install guidance.
const BINARY_CANDIDATES: Record<RuntimeId, readonly string[]> = {
  codex: ["codex", "codex-cli"],
  claude: ["claude"],
  antigravity: ["agy"],
};

// `agy models` menanyakan katalog ke layanan Antigravity, bukan membaca berkas
// lokal seperti dua runtime lain, jadi ia diukur 2,6–4,6 detik pada koneksi yang
// sehat. Anggaran 5 detik yang cukup untuk metadata lokal membuat runtime ini
// gagal sebagai timeout setiap kali jaringan sedang lambat.
// `codex app-server` harus menyala dulu sebelum menjawab `model/list`: diukur
// 3,2 detik saat dingin dan 0,2–0,5 detik saat hangat pada mesin yang diam
// (2026-10-02), dan lewat 5 detik saat server dev sedang compile atau generate
// lain berjalan. Setiap run dan generate menemukan ulang runtime-nya, jadi
// timeout di sini menggagalkan run yang sebenarnya bisa jalan.
const METADATA_TIMEOUT_OVERRIDES: Partial<Record<RuntimeId, number>> = {
  codex: 20_000,
  antigravity: 20_000,
};

const CATALOG_SOURCES: Record<RuntimeId, CatalogSource> = {
  codex: "codex-app-server:model/list",
  claude: "claude-agent-sdk:supportedModels",
  antigravity: "antigravity-cli:agy models",
};

export interface RuntimeDiscoveryOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  ttlMs?: number;
  now?: () => Date;
  binaryPaths?: Partial<Record<RuntimeId, string>>;
  /** Optional dependency boundary for the pinned Claude Agent SDK. */
  claudeSdk?: ClaudeSdkMetadataProvider;
  runtimes?: readonly RuntimeId[];
}

interface AdapterResult {
  models: Array<{
    modelId: string;
    label: string;
    effortOptions: RuntimeModel["effortOptions"];
    defaultEffort: string | null;
    capabilities: Partial<RuntimeModel["capabilities"]>;
    authScope: string | null;
  }>;
  defaultModel: string | null;
  defaultEffort: string | null;
  authScope: string | null;
  authRequired: boolean;
  diagnostic: string | null;
}

function stableDiagnostic(value: string | null | undefined): string | null {
  if (!value) return null;
  return /^[A-Z0-9_.-]+$/.test(value) ? value : "METADATA_ERROR";
}

function statusFromMetadata(metadata: AdapterResult): RuntimeStatus {
  if (metadata.authRequired) return "needs_login";
  return metadata.models.length > 0 ? "ready" : "error";
}

function makeCatalog(
  runtime: RuntimeId,
  version: string,
  metadata: AdapterResult,
  connectionId: string,
  now: Date,
  ttlMs: number,
): RuntimeCatalog {
  const discoveredAt = now.toISOString();
  const defaultSource = metadata.defaultModel || metadata.defaultEffort ? "runtime-config" : "unknown";
  const models: RuntimeModel[] = metadata.models.map((model) => ({
    connectionId,
    modelId: model.modelId,
    label: model.label,
    source: CATALOG_SOURCES[runtime],
    discoveredAt,
    runtimeVersion: version,
    authScope: model.authScope ?? metadata.authScope,
    availability: "listed",
    effortOptions: model.effortOptions,
    defaultModel: metadata.defaultModel,
    defaultEffort: metadata.defaultEffort ?? model.defaultEffort,
    defaultSource: metadata.defaultModel || metadata.defaultEffort
      ? defaultSource
      : (model.defaultEffort ? "model-default" : "unknown"),
    capabilities: { ...unknownCapabilities(), ...model.capabilities },
  }));
  return {
    connectionId,
    runtime,
    source: CATALOG_SOURCES[runtime],
    discoveredAt,
    expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
    models,
    error: stableDiagnostic(metadata.diagnostic),
  };
}

function baseDetection(
  runtime: RuntimeId,
  checkedAt: string,
  binaryPath: string | null,
): RuntimeDetection {
  return {
    runtime,
    status: binaryPath ? "error" : "not_installed",
    authStatus: "unknown",
    binaryPath,
    version: null,
    checkedAt,
    capabilities: unknownCapabilities(),
    catalog: null,
    diagnostic: binaryPath ? null : "NOT_INSTALLED",
  };
}

function versionDiagnostic(result: MetadataCommandResult): string {
  if (result.timedOut) return "VERSION_TIMEOUT";
  if (result.errorCode) return result.errorCode;
  return result.exitCode === null ? "VERSION_PROCESS_ERROR" : "VERSION_UNREADABLE";
}

async function discoverOne(
  runtime: RuntimeId,
  options: RuntimeDiscoveryOptions,
  checkedAt: string,
  now: Date,
  ttlMs: number,
): Promise<RuntimeDetection> {
  const binaryPath = findExecutable(
    BINARY_CANDIDATES[runtime],
    options.binaryPaths?.[runtime],
    { cwd: options.cwd, env: options.env },
  );
  const detection = baseDetection(runtime, checkedAt, binaryPath);
  if (!binaryPath) return detection;

  const versionResult = await runMetadataCommand(binaryPath, ["--version"], {
    cwd: options.cwd,
    env: options.env,
    timeoutMs: options.timeoutMs,
    stdin: "ignore",
  });
  const version = parseRuntimeVersion(versionResult.stdout || versionResult.stderr);
  detection.version = version;
  if (!versionResult.ok || !version) {
    detection.status = "unsupported_version";
    detection.diagnostic = versionDiagnostic(versionResult);
    return detection;
  }

  let metadata: AdapterResult;
  try {
    if (runtime === "codex") {
      metadata = await queryCodexAppServer(binaryPath, {
        cwd: options.cwd,
        env: options.env,
        timeoutMs: options.timeoutMs ?? METADATA_TIMEOUT_OVERRIDES.codex,
      });
    } else if (runtime === "claude") {
      metadata = await queryClaudeSdk(options.claudeSdk, binaryPath);
    } else {
      metadata = await queryAntigravityCli(binaryPath, {
        cwd: options.cwd,
        env: options.env,
        timeoutMs: options.timeoutMs ?? METADATA_TIMEOUT_OVERRIDES.antigravity,
      });
    }
  } catch {
    metadata = {
      models: [],
      defaultModel: null,
      defaultEffort: null,
      authScope: null,
      authRequired: false,
      diagnostic: "METADATA_ERROR",
    };
  }

  detection.status = statusFromMetadata(metadata);
  detection.authStatus = metadata.authRequired ? "unauthenticated" : "unknown";
  detection.diagnostic = stableDiagnostic(metadata.diagnostic);
  detection.catalog = makeCatalog(runtime, version, metadata, `runtime:${runtime}`, now, ttlMs);
  // Capabilities come only from explicit metadata. Version detection alone is
  // intentionally insufficient evidence for a capability claim.
  detection.capabilities = cloneCapabilities(
    metadata.models.reduce((merged, model) => ({ ...merged, ...model.capabilities }), unknownCapabilities()),
  );
  return detection;
}

// A failed read that says nothing about the account or its entitlement.
const TRANSIENT_DIAGNOSTICS = new Set(["METADATA_TIMEOUT", "METADATA_ERROR", "PROCESS_ERROR"]);

/**
 * Keep showing a runtime's last good catalog when a refresh fails for a
 * transient reason, marked stale, instead of an empty model list. A login
 * problem, an empty list, or a different runtime version is not transient
 * and replaces it. `lastKnown` is updated with every good read.
 */
export function withLastKnownCatalogs(
  report: RuntimeDiscoveryReport,
  lastKnown: Map<RuntimeId, RuntimeDetection>,
): RuntimeDiscoveryReport {
  const runtimes = report.runtimes.map((detection) => {
    if (detection.status === "ready" && detection.catalog?.models.length) {
      lastKnown.set(detection.runtime, detection);
      return detection;
    }
    const previous = lastKnown.get(detection.runtime);
    if (
      detection.status !== "error"
      || !detection.diagnostic
      || !TRANSIENT_DIAGNOSTICS.has(detection.diagnostic)
      || !previous?.catalog
      || previous.version !== detection.version
    ) {
      lastKnown.delete(detection.runtime);
      return detection;
    }
    return {
      ...detection,
      status: previous.status,
      capabilities: cloneCapabilities(previous.capabilities),
      catalog: { ...previous.catalog, error: detection.diagnostic, stale: true },
    };
  });
  return { ...report, runtimes };
}

/**
 * Whether a runtime in the report failed for a passing reason and has no last
 * good catalog to fall back on, so it shows as unavailable although the next
 * read would likely work.
 */
export function hasTransientFailure(report: RuntimeDiscoveryReport): boolean {
  return report.runtimes.some((detection) =>
    detection.status === "error" && TRANSIENT_DIAGNOSTICS.has(detection.diagnostic ?? ""));
}

/** Detect configured runtime binaries and perform metadata-only discovery. */
export async function discoverRuntimes(options: RuntimeDiscoveryOptions = {}): Promise<RuntimeDiscoveryReport> {
  const now = options.now?.() ?? new Date();
  const checkedAt = now.toISOString();
  const ttlMs = Math.max(1, options.ttlMs ?? DEFAULT_CATALOG_TTL_MS);
  const runtimes = options.runtimes ?? RUNTIME_IDS;
  const results = await Promise.all(runtimes.map((runtime) => discoverOne(runtime, options, checkedAt, now, ttlMs)));
  return { checkedAt, ttlMs, runtimes: results };
}

/** Singular convenience wrapper for callers refreshing one runtime card. */
export async function discoverRuntime(
  runtime: RuntimeId,
  options: Omit<RuntimeDiscoveryOptions, "runtimes"> = {},
): Promise<RuntimeDetection> {
  const report = await discoverRuntimes({ ...options, runtimes: [runtime] });
  return report.runtimes[0];
}
