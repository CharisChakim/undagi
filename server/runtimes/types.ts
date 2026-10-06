// Copyright (c) 2026 Charis Chakim - Undagi (https://github.com/CharisChakim/undagi)
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

/**
 * Provider-neutral runtime discovery types.
 *
 * Runtime discovery is deliberately separate from the legacy model API
 * connection types. A runtime owns its agent loop and may expose a different
 * model/default/approval contract than an HTTP model provider.
 */

export const RUNTIME_IDS = ["codex", "claude", "antigravity"] as const;
export type RuntimeId = (typeof RUNTIME_IDS)[number];

export type RuntimeStatus =
  | "ready"
  | "needs_login"
  | "not_installed"
  | "unsupported_version"
  | "error";

export type RuntimeAuthStatus = "authenticated" | "unauthenticated" | "unknown";

export type CatalogAvailability = "listed" | "verified" | "unavailable" | "unknown";

export type CatalogSource =
  | "codex-app-server:model/list"
  | "claude-agent-sdk:supportedModels"
  | "antigravity-cli:agy models"
  | "manual"
  | "unknown";

export type DefaultSource =
  | "catalog"
  | "runtime-config"
  | "user-override"
  | "model-default"
  | "unknown";

export type CapabilitySupport = "supported" | "unsupported" | "unknown";

export interface RuntimeCapabilities {
  /** Structured output/schema-constrained responses. */
  structuredOutput: CapabilitySupport;
  /** Runtime-owned tool execution. */
  toolUse: CapabilitySupport;
  /** A first-class approval or permission decision can be translated. */
  approval: CapabilitySupport;
  /** Provider session/thread continuation. */
  resume: CapabilitySupport;
  /** Provider session interruption. */
  interrupt: CapabilitySupport;
  /** Usage/quota information is available through the runtime contract. */
  usage: CapabilitySupport;
  /** Provider event stream can be consumed without a model prompt during discovery. */
  streaming: CapabilitySupport;
}

export interface RuntimeEffortOption {
  /** Native value passed to the runtime, kept verbatim. */
  value: string;
  /** User-facing label supplied by the runtime or a documented native value. */
  label: string;
}

export interface RuntimeModel {
  /** Undagi connection identity; model IDs are only unique within a connection. */
  connectionId: string;
  modelId: string;
  label: string;
  source: CatalogSource;
  discoveredAt: string;
  runtimeVersion: string | null;
  /** Non-secret account/workspace scope supplied by an official metadata response. */
  authScope: string | null;
  availability: CatalogAvailability;
  effortOptions: RuntimeEffortOption[];
  defaultModel: string | null;
  defaultEffort: string | null;
  defaultSource: DefaultSource;
  capabilities: RuntimeCapabilities;
}

export interface RuntimeCatalog {
  connectionId: string;
  runtime: RuntimeId;
  source: CatalogSource;
  discoveredAt: string;
  expiresAt: string;
  models: RuntimeModel[];
  /** Present when metadata could not be read; never contains command output. */
  error: string | null;
  /**
   * The last catalog read successfully, kept because the latest read failed
   * for a reason that may pass (a timeout, the network). `discoveredAt` is
   * when that older read happened.
   */
  stale?: boolean;
}

export interface RuntimeDetection {
  runtime: RuntimeId;
  status: RuntimeStatus;
  authStatus: RuntimeAuthStatus;
  binaryPath: string | null;
  version: string | null;
  checkedAt: string;
  capabilities: RuntimeCapabilities;
  catalog: RuntimeCatalog | null;
  /** Stable, actionable diagnostic. Raw stdout/stderr is intentionally absent. */
  diagnostic: string | null;
}

export interface RuntimeDiscoveryReport {
  checkedAt: string;
  ttlMs: number;
  runtimes: RuntimeDetection[];
}

export function unknownCapabilities(): RuntimeCapabilities {
  return {
    structuredOutput: "unknown",
    toolUse: "unknown",
    approval: "unknown",
    resume: "unknown",
    interrupt: "unknown",
    usage: "unknown",
    streaming: "unknown",
  };
}

export function cloneCapabilities(value: RuntimeCapabilities): RuntimeCapabilities {
  return { ...value };
}
