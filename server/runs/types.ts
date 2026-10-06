// Copyright (c) 2026 Charis Chakim - Undagi (https://github.com/CharisChakim/undagi)
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

export const RUN_STATUSES = [
  "queued",
  "running",
  "waiting_for_input",
  "waiting_for_approval",
  "completed",
  "failed",
  "cancelled",
  "interrupted",
] as const;

export type RunStatus = (typeof RUN_STATUSES)[number];

export const TERMINAL_RUN_STATUSES = [
  "completed",
  "failed",
  "cancelled",
  "interrupted",
] as const satisfies readonly RunStatus[];

export type TerminalRunStatus = (typeof TERMINAL_RUN_STATUSES)[number];

export const RUN_SETTING_SOURCES = [
  "inherit",
  "user-override",
  "connection-default",
  "runtime-config",
  "catalog",
  "model-default",
  "unknown",
] as const;

export type RunSettingSource = (typeof RUN_SETTING_SOURCES)[number];
export type RunPreferenceValue = "inherit" | (string & {});

export const APPROVAL_STATUSES = ["pending", "approved", "rejected", "expired"] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

export const EVIDENCE_KINDS = ["diff", "command", "verification", "artifact", "summary"] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

export interface RunSnapshot {
  runtime: string;
  connectionId: string | null;
  requestedModel: RunPreferenceValue;
  effectiveModel: string | null;
  modelSource: RunSettingSource;
  requestedEffort: RunPreferenceValue;
  effectiveEffort: string | null;
  effortSource: RunSettingSource;
  runtimeVersion: string | null;
  workspace: string | null;
  externalSessionId: string | null;
}

export interface Run {
  id: string;
  conversationId: string | null;
  taskId: string | null;
  status: RunStatus;
  snapshot: RunSnapshot;
  result: unknown;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  updatedAt: string;
}

export interface RunEvent {
  id: number;
  runId: string;
  sequence: number;
  type: string;
  payload: unknown;
  providerEventId: string | null;
  createdAt: string;
}

export interface RunApproval {
  id: string;
  runId: string;
  toolCallId: string | null;
  status: ApprovalStatus;
  request: unknown;
  decision: unknown;
  createdAt: string;
  decidedAt: string | null;
}

export interface RunEvidence {
  id: string;
  runId: string;
  kind: EvidenceKind;
  summary: string | null;
  payload: unknown;
  command: string | null;
  exitCode: number | null;
  createdAt: string;
}
