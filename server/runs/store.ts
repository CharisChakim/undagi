import { randomUUID } from "node:crypto";

import { db } from "../../db.ts";
import {
  APPROVAL_STATUSES,
  EVIDENCE_KINDS,
  RUN_SETTING_SOURCES,
  RUN_STATUSES,
  TERMINAL_RUN_STATUSES,
  type ApprovalStatus,
  type EvidenceKind,
  type Run,
  type RunApproval,
  type RunEvent,
  type RunEvidence,
  type RunPreferenceValue,
  type RunSettingSource,
  type RunSnapshot,
  type RunStatus,
} from "./types.ts";

const ACTIVE_WRITER_STATUSES: readonly RunStatus[] = [
  "running",
  "waiting_for_input",
  "waiting_for_approval",
];
const MAX_SAFE_DEPTH = 8;
const MAX_SAFE_ARRAY_ITEMS = 200;
const MAX_SAFE_STRING_LENGTH = 50_000;

// Run menyimpan snapshot resolusi saat mulai. Tidak ada kolom credential dan
// payload provider dibersihkan sebelum masuk database maupun response browser.
db.exec(`
  CREATE TABLE IF NOT EXISTS runs (
    id                    TEXT PRIMARY KEY,
    idempotency_key       TEXT NOT NULL UNIQUE,
    conversation_id       TEXT,
    task_id               TEXT,
    status                TEXT NOT NULL,
    runtime               TEXT NOT NULL,
    connection_id         TEXT,
    requested_model       TEXT NOT NULL,
    effective_model       TEXT,
    model_source          TEXT NOT NULL,
    requested_effort      TEXT NOT NULL,
    effective_effort      TEXT,
    effort_source         TEXT NOT NULL,
    runtime_version       TEXT,
    workspace             TEXT,
    external_session_id   TEXT,
    result_json           TEXT NOT NULL DEFAULT 'null',
    error                 TEXT,
    created_at            TEXT NOT NULL,
    started_at            TEXT,
    finished_at           TEXT,
    updated_at            TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_runs_status_workspace
    ON runs (workspace, status, updated_at DESC);
  CREATE INDEX IF NOT EXISTS idx_runs_conversation
    ON runs (conversation_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_runs_task
    ON runs (task_id, created_at DESC);

  CREATE TABLE IF NOT EXISTS run_events (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id              TEXT NOT NULL,
    sequence            INTEGER NOT NULL,
    type                TEXT NOT NULL,
    payload_json        TEXT NOT NULL DEFAULT 'null',
    provider_event_id   TEXT,
    created_at          TEXT NOT NULL,
    UNIQUE (run_id, sequence)
  );
  CREATE INDEX IF NOT EXISTS idx_run_events_run_sequence
    ON run_events (run_id, sequence);

  CREATE TABLE IF NOT EXISTS run_approvals (
    id                  TEXT PRIMARY KEY,
    run_id              TEXT NOT NULL,
    tool_call_id        TEXT,
    status              TEXT NOT NULL,
    request_json        TEXT NOT NULL DEFAULT '{}',
    decision_json       TEXT,
    created_at          TEXT NOT NULL,
    decided_at          TEXT,
    UNIQUE (run_id, id)
  );
  CREATE INDEX IF NOT EXISTS idx_run_approvals_run
    ON run_approvals (run_id, created_at ASC);

  CREATE TABLE IF NOT EXISTS run_evidence (
    id                  TEXT PRIMARY KEY,
    run_id              TEXT NOT NULL,
    kind                TEXT NOT NULL,
    summary             TEXT,
    payload_json        TEXT NOT NULL DEFAULT 'null',
    command             TEXT,
    exit_code           INTEGER,
    created_at          TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_run_evidence_run
    ON run_evidence (run_id, created_at ASC);
`);

function reconcileStaleRuns(): void {
  const now = new Date().toISOString();
  let transactionStarted = false;
  try {
    db.exec("BEGIN IMMEDIATE");
    transactionStarted = true;
    const staleRunIds = (
      db.prepare(`
        SELECT id FROM runs
         WHERE status IN ('queued', 'running', 'waiting_for_input', 'waiting_for_approval')
      `).all() as { id: string }[]
    ).map((row) => row.id);
    db.prepare(`
      UPDATE runs
         SET status = 'interrupted',
             error = COALESCE(error, ?),
             finished_at = COALESCE(finished_at, ?),
             updated_at = ?
       WHERE status IN ('queued', 'running', 'waiting_for_input', 'waiting_for_approval')
    `).run("Run interrupted because the server restarted before it completed.", now, now);
    // A run interrupted mid-restart leaves nobody to ever decide its pending
    // approvals; expire them so they stop showing as awaiting a decision.
    if (staleRunIds.length > 0) {
      const placeholders = staleRunIds.map(() => "?").join(", ");
      db.prepare(`
        UPDATE run_approvals
           SET status = 'expired',
               decided_at = ?
         WHERE status = 'pending'
           AND run_id IN (${placeholders})
      `).run(now, ...staleRunIds);
    }
    db.exec("COMMIT");
  } catch (error) {
    if (transactionStarted) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // Error asli lebih berguna daripada error rollback sekunder.
      }
    }
    throw error;
  }
}

// Provider workers do not survive a server restart. Treat their persisted
// non-terminal states as interrupted before exposing the store to callers.
reconcileStaleRuns();

const getRunStmt = db.prepare(`
  SELECT id, idempotency_key, conversation_id, task_id, status,
         runtime, connection_id, requested_model, effective_model, model_source,
         requested_effort, effective_effort, effort_source, runtime_version,
         workspace, external_session_id, result_json, error,
         created_at, started_at, finished_at, updated_at
    FROM runs
   WHERE id = ?
`);
const getRunByIdempotencyStmt = db.prepare(`
  SELECT id, idempotency_key, conversation_id, task_id, status,
         runtime, connection_id, requested_model, effective_model, model_source,
         requested_effort, effective_effort, effort_source, runtime_version,
         workspace, external_session_id, result_json, error,
         created_at, started_at, finished_at, updated_at
    FROM runs
   WHERE idempotency_key = ?
`);
const getRunByExternalSessionStmt = db.prepare(`
  SELECT id, idempotency_key, conversation_id, task_id, status,
         runtime, connection_id, requested_model, effective_model, model_source,
         requested_effort, effective_effort, effort_source, runtime_version,
         workspace, external_session_id, result_json, error,
         created_at, started_at, finished_at, updated_at
    FROM runs
   WHERE runtime = ? AND external_session_id = ?
   ORDER BY updated_at DESC, id DESC
   LIMIT 1
`);
const insertRunStmt = db.prepare(`
  INSERT INTO runs (
    id, idempotency_key, conversation_id, task_id, status,
    runtime, connection_id, requested_model, effective_model, model_source,
    requested_effort, effective_effort, effort_source, runtime_version,
    workspace, external_session_id, result_json, error,
    created_at, started_at, finished_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const updateRunStmt = db.prepare(`
  UPDATE runs SET
    status = ?, effective_model = ?, model_source = ?,
    effective_effort = ?, effort_source = ?, runtime_version = ?,
    workspace = ?, external_session_id = ?, result_json = ?, error = ?,
    started_at = ?, finished_at = ?, updated_at = ?
  WHERE id = ?
`);
const activeWorkspaceStmt = db.prepare(`
  SELECT id FROM runs
   WHERE workspace = ?
     AND status IN ('running', 'waiting_for_input', 'waiting_for_approval')
     AND id <> ?
   ORDER BY updated_at ASC, id ASC
   LIMIT 1
`);
const activeConversationStmt = db.prepare(`
  SELECT id FROM runs
   WHERE conversation_id = ?
     AND status IN ('running', 'waiting_for_input', 'waiting_for_approval')
     AND id <> ?
   ORDER BY updated_at ASC, id ASC
   LIMIT 1
`);
const maxEventSequenceStmt = db.prepare(
  `SELECT COALESCE(MAX(sequence), 0) AS sequence FROM run_events WHERE run_id = ?`
);
const insertEventStmt = db.prepare(`
  INSERT INTO run_events
    (run_id, sequence, type, payload_json, provider_event_id, created_at)
  VALUES (?, ?, ?, ?, ?, ?)
`);
const touchRunStmt = db.prepare(`UPDATE runs SET updated_at = ? WHERE id = ?`);
const getApprovalStmt = db.prepare(`
  SELECT id, run_id, tool_call_id, status, request_json, decision_json,
         created_at, decided_at
    FROM run_approvals WHERE id = ?
`);
const insertApprovalStmt = db.prepare(`
  INSERT INTO run_approvals
    (id, run_id, tool_call_id, status, request_json, decision_json, created_at, decided_at)
  VALUES (?, ?, ?, 'pending', ?, NULL, ?, NULL)
`);
const resolveApprovalStmt = db.prepare(`
  UPDATE run_approvals
     SET status = ?, decision_json = ?, decided_at = ?
   WHERE id = ? AND status = 'pending'
`);
const getEvidenceStmt = db.prepare(`
  SELECT id, run_id, kind, summary, payload_json, command, exit_code, created_at
    FROM run_evidence WHERE id = ?
`);
const insertEvidenceStmt = db.prepare(`
  INSERT INTO run_evidence
    (id, run_id, kind, summary, payload_json, command, exit_code, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);

interface RunRow {
  id: string;
  idempotency_key: string;
  conversation_id: string | null;
  task_id: string | null;
  status: string;
  runtime: string;
  connection_id: string | null;
  requested_model: string;
  effective_model: string | null;
  model_source: string;
  requested_effort: string;
  effective_effort: string | null;
  effort_source: string;
  runtime_version: string | null;
  workspace: string | null;
  external_session_id: string | null;
  result_json: string;
  error: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  updated_at: string;
}

interface ApprovalRow {
  id: string;
  run_id: string;
  tool_call_id: string | null;
  status: string;
  request_json: string;
  decision_json: string | null;
  created_at: string;
  decided_at: string | null;
}

interface EvidenceRow {
  id: string;
  run_id: string;
  kind: string;
  summary: string | null;
  payload_json: string;
  command: string | null;
  exit_code: number | null;
  created_at: string;
}

export interface RunCreateInput {
  id?: string;
  idempotencyKey: string;
  conversationId?: string | null;
  taskId?: string | null;
  runtime: string;
  connectionId?: string | null;
  requestedModel: RunPreferenceValue;
  effectiveModel?: string | null;
  modelSource?: RunSettingSource;
  requestedEffort: RunPreferenceValue;
  effectiveEffort?: string | null;
  effortSource?: RunSettingSource;
  runtimeVersion?: string | null;
  workspace?: string | null;
  externalSessionId?: string | null;
}

export interface RunStatusUpdateInput {
  status: RunStatus;
  result?: unknown;
  error?: string | null;
  externalSessionId?: string | null;
}

export interface RunEventInput {
  type: string;
  payload?: unknown;
  providerEventId?: string | null;
}

export interface RunApprovalInput {
  runId: string;
  toolCallId?: string | null;
  request?: unknown;
}

export interface RunEvidenceInput {
  runId: string;
  kind: EvidenceKind;
  summary?: string | null;
  payload?: unknown;
  command?: string | null;
  exitCode?: number | null;
}

export interface RunListFilter {
  status?: RunStatus;
  workspace?: string | null;
  conversationId?: string | null;
  taskId?: string | null;
  limit?: number;
}

export interface RunEventListOptions {
  afterSequence?: number;
  limit?: number;
}

export interface CreatedRun {
  run: Run;
  created: boolean;
}

export class RunConflictError extends Error {
  readonly statusCode = 409;

  constructor(readonly activeRunId: string, message: string) {
    super(message);
    this.name = "RunConflictError";
  }
}

export class IdempotencyConflictError extends Error {
  readonly statusCode = 409;

  constructor(readonly idempotencyKey: string) {
    super(`Idempotency key already belongs to a different run request: ${idempotencyKey}`);
    this.name = "IdempotencyConflictError";
  }
}

export class ApprovalConflictError extends Error {
  readonly statusCode = 409;

  constructor(readonly approvalId: string, status: string) {
    super(`Approval ${approvalId} is already ${status}`);
    this.name = "ApprovalConflictError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required`);
  return value.trim();
}

function optionalText(value: unknown, field: string): string | null {
  if (value === undefined || value === null || value === "") return null;
  return requiredText(value, field);
}

function settingValue(value: unknown, field: string): RunPreferenceValue {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${field} must be a non-empty string or inherit`);
  }
  // Nilai model/effort native disimpan tanpa mengubah casing atau tanda baca.
  return value === "inherit" ? "inherit" : value;
}

function settingSource(value: unknown, field: string): RunSettingSource {
  if (!RUN_SETTING_SOURCES.includes(value as RunSettingSource)) {
    throw new Error(`${field} is not a supported run setting source`);
  }
  return value as RunSettingSource;
}

function runtimeStatus(value: unknown): RunStatus {
  if (!RUN_STATUSES.includes(value as RunStatus)) throw new Error(`Unknown run status: ${String(value)}`);
  return value as RunStatus;
}

function approvalStatus(value: unknown): ApprovalStatus {
  if (!APPROVAL_STATUSES.includes(value as ApprovalStatus)) throw new Error(`Unknown approval status: ${String(value)}`);
  return value as ApprovalStatus;
}

function evidenceKind(value: unknown): EvidenceKind {
  if (!EVIDENCE_KINDS.includes(value as EvidenceKind)) throw new Error(`Unknown evidence kind: ${String(value)}`);
  return value as EvidenceKind;
}

function safeString(value: string): string {
  const redacted = value
    .replace(/((?:api[-_]?key|access[-_]?token|refresh[-_]?token|authorization|password|secret|credential|cookie)\s*[:=]\s*)([^\s,;]+)/gi, "$1[redacted]")
    .replace(/((?:--?)(?:api[-_]?key|access[-_]?token|password|secret|token)\s+)([^\s]+)/gi, "$1[redacted]");
  return redacted.length > MAX_SAFE_STRING_LENGTH
    ? `${redacted.slice(0, MAX_SAFE_STRING_LENGTH)}…`
    : redacted;
}

const SECRET_FIELD = /(?:api[-_]?key|access[-_]?token|refresh[-_]?token|authorization|password|secret|credential|cookie|private[-_]?key)/i;

function browserSafe(value: unknown, depth = 0, fieldName = ""): unknown {
  if (SECRET_FIELD.test(fieldName)) return "[redacted]";
  if (depth > MAX_SAFE_DEPTH) return "[truncated]";
  if (typeof value === "string") return safeString(value);
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.slice(0, MAX_SAFE_ARRAY_ITEMS).map((item) => browserSafe(item, depth + 1));
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).slice(0, MAX_SAFE_ARRAY_ITEMS).map(([key, item]) => [key, browserSafe(item, depth + 1, key)]),
    );
  }
  return String(value);
}

function safeJson(value: unknown, fallback: unknown = null): string {
  try {
    const serialized = JSON.stringify(browserSafe(value));
    return serialized === undefined ? JSON.stringify(fallback) : serialized;
  } catch {
    return JSON.stringify(fallback);
  }
}

function parseJson(value: string | null | undefined, fallback: unknown = null): unknown {
  if (!value) return fallback;
  try {
    return browserSafe(JSON.parse(value));
  } catch {
    return fallback;
  }
}

function normalizeRunInput(input: RunCreateInput): Required<Omit<RunCreateInput, "id">> & { id: string | null } {
  const requestedModel = settingValue(input.requestedModel, "requestedModel");
  const requestedEffort = settingValue(input.requestedEffort, "requestedEffort");
  const normalizedModelSource = input.modelSource === undefined
    ? (requestedModel === "inherit" ? "inherit" : "user-override")
    : settingSource(input.modelSource, "modelSource");
  const normalizedEffortSource = input.effortSource === undefined
    ? (requestedEffort === "inherit" ? "inherit" : "user-override")
    : settingSource(input.effortSource, "effortSource");

  return {
    id: input.id === undefined || input.id === null ? null : requiredText(input.id, "id"),
    idempotencyKey: requiredText(input.idempotencyKey, "idempotencyKey"),
    conversationId: optionalText(input.conversationId, "conversationId"),
    taskId: optionalText(input.taskId, "taskId"),
    runtime: requiredText(input.runtime, "runtime"),
    connectionId: optionalText(input.connectionId, "connectionId"),
    requestedModel,
    effectiveModel: optionalText(input.effectiveModel, "effectiveModel"),
    modelSource: normalizedModelSource,
    requestedEffort,
    effectiveEffort: optionalText(input.effectiveEffort, "effectiveEffort"),
    effortSource: normalizedEffortSource,
    runtimeVersion: optionalText(input.runtimeVersion, "runtimeVersion"),
    workspace: optionalText(input.workspace, "workspace"),
    externalSessionId: optionalText(input.externalSessionId, "externalSessionId"),
  };
}

function runFromRow(row: RunRow): Run {
  const status = runtimeStatus(row.status);
  return {
    id: row.id,
    conversationId: row.conversation_id,
    taskId: row.task_id,
    status,
    snapshot: {
      runtime: row.runtime,
      connectionId: row.connection_id,
      requestedModel: row.requested_model,
      effectiveModel: row.effective_model,
      modelSource: settingSource(row.model_source, "modelSource"),
      requestedEffort: row.requested_effort,
      effectiveEffort: row.effective_effort,
      effortSource: settingSource(row.effort_source, "effortSource"),
      runtimeVersion: row.runtime_version,
      workspace: row.workspace,
      externalSessionId: row.external_session_id,
    },
    result: parseJson(row.result_json),
    error: row.error === null ? null : safeString(row.error),
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    updatedAt: row.updated_at,
  };
}

function requireRun(runId: string): RunRow {
  const id = requiredText(runId, "runId");
  const row = getRunStmt.get(id) as unknown as RunRow | undefined;
  if (!row) throw new Error(`Run ${id} not found`);
  return row;
}

function findRunByIdempotency(key: string): RunRow | undefined {
  return getRunByIdempotencyStmt.get(key) as unknown as RunRow | undefined;
}

function sameCreateRequest(row: RunRow, input: ReturnType<typeof normalizeRunInput>): boolean {
  if (input.id !== null && input.id !== row.id) return false;
  return row.conversation_id === input.conversationId
    && row.task_id === input.taskId
    && row.runtime === input.runtime
    && row.connection_id === input.connectionId
    && row.requested_model === input.requestedModel
    && row.effective_model === input.effectiveModel
    && row.model_source === input.modelSource
    && row.requested_effort === input.requestedEffort
    && row.effective_effort === input.effectiveEffort
    && row.effort_source === input.effortSource
    && row.runtime_version === input.runtimeVersion
    && row.workspace === input.workspace
    // A run records the provider's session id once the provider reports it, so
    // a repeat of a request that started a new session no longer matches here.
    && (input.externalSessionId === null || row.external_session_id === input.externalSessionId);
}

export function createRun(input: RunCreateInput): CreatedRun {
  const normalized = normalizeRunInput(input);
  const existing = findRunByIdempotency(normalized.idempotencyKey);
  if (existing) {
    if (!sameCreateRequest(existing, normalized)) throw new IdempotencyConflictError(normalized.idempotencyKey);
    return { run: runFromRow(existing), created: false };
  }

  const id = normalized.id ?? `run_${randomUUID()}`;
  const now = new Date().toISOString();
  insertRunStmt.run(
    id,
    normalized.idempotencyKey,
    normalized.conversationId,
    normalized.taskId,
    "queued",
    normalized.runtime,
    normalized.connectionId,
    normalized.requestedModel,
    normalized.effectiveModel,
    normalized.modelSource,
    normalized.requestedEffort,
    normalized.effectiveEffort,
    normalized.effortSource,
    normalized.runtimeVersion,
    normalized.workspace,
    normalized.externalSessionId,
    safeJson(null),
    null,
    now,
    null,
    null,
    now,
  );
  return { run: runFromRow(requireRun(id)), created: true };
}

export function getRun(runId: string): Run | null {
  const id = requiredText(runId, "runId");
  const row = getRunStmt.get(id) as unknown as RunRow | undefined;
  return row ? runFromRow(row) : null;
}

export function getRunByExternalSession(runtime: string, externalSessionId: string): Run | null {
  const row = getRunByExternalSessionStmt.get(
    requiredText(runtime, "runtime"),
    requiredText(externalSessionId, "externalSessionId"),
  ) as unknown as RunRow | undefined;
  return row ? runFromRow(row) : null;
}

export function listRuns(filter: RunListFilter = {}): Run[] {
  const where: string[] = [];
  const values: (string | null | number)[] = [];
  if (filter.status !== undefined) {
    where.push("status = ?");
    values.push(runtimeStatus(filter.status));
  }
  if (filter.workspace !== undefined) {
    if (filter.workspace === null || filter.workspace === "") where.push("workspace IS NULL");
    else {
      where.push("workspace = ?");
      values.push(requiredText(filter.workspace, "workspace"));
    }
  }
  if (filter.conversationId !== undefined) {
    if (filter.conversationId === null || filter.conversationId === "") where.push("conversation_id IS NULL");
    else {
      where.push("conversation_id = ?");
      values.push(requiredText(filter.conversationId, "conversationId"));
    }
  }
  if (filter.taskId !== undefined) {
    if (filter.taskId === null || filter.taskId === "") where.push("task_id IS NULL");
    else {
      where.push("task_id = ?");
      values.push(requiredText(filter.taskId, "taskId"));
    }
  }
  const requestedLimit = filter.limit === undefined ? 50 : Number(filter.limit);
  if (!Number.isFinite(requestedLimit) || requestedLimit < 1) throw new Error("limit must be a positive number");
  const limit = Math.min(100, Math.floor(requestedLimit));
  const query = `
    SELECT id, idempotency_key, conversation_id, task_id, status,
           runtime, connection_id, requested_model, effective_model, model_source,
           requested_effort, effective_effort, effort_source, runtime_version,
           workspace, external_session_id, result_json, error,
           created_at, started_at, finished_at, updated_at
      FROM runs
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
     ORDER BY created_at DESC, id DESC
     LIMIT ?
  `;
  values.push(limit);
  return (db.prepare(query).all(...values) as unknown as RunRow[]).map(runFromRow);
}

const TRANSITIONS: Record<RunStatus, readonly RunStatus[]> = {
  queued: ["running", "cancelled", "failed", "interrupted"],
  running: ["waiting_for_input", "waiting_for_approval", "completed", "failed", "cancelled", "interrupted"],
  waiting_for_input: ["running", "completed", "failed", "cancelled", "interrupted"],
  waiting_for_approval: ["running", "completed", "failed", "cancelled", "interrupted"],
  completed: [],
  failed: [],
  cancelled: [],
  interrupted: [],
};

export function canTransition(from: RunStatus, to: RunStatus): boolean {
  return from === to || TRANSITIONS[from]?.includes(to) === true;
}

export function assertTransition(from: RunStatus, to: RunStatus): void {
  if (!canTransition(from, to)) throw new Error(`Invalid run transition: ${from} -> ${to}`);
}

function isTerminal(status: RunStatus): status is (typeof TERMINAL_RUN_STATUSES)[number] {
  return TERMINAL_RUN_STATUSES.includes(status as (typeof TERMINAL_RUN_STATUSES)[number]);
}

/** Whether a run is working in this conversation or this workspace right now. */
/** Whether a run is still going in this conversation, wherever its workspace is. */
export function hasActiveConversationRun(conversationId: string): boolean {
  return Boolean(activeConversationStmt.get(conversationId, ""));
}

export function hasActiveRun(conversationId: string, workspace: string): boolean {
  return Boolean(activeConversationStmt.get(conversationId, "") || activeWorkspaceStmt.get(workspace, ""));
}

export function updateRunStatus(runId: string, input: RunStatusUpdateInput): Run {
  const current = requireRun(runId);
  const from = runtimeStatus(current.status);
  const to = runtimeStatus(input.status);
  assertTransition(from, to);

  const workspace = current.workspace;
  if (to === "running" && workspace) {
    const active = activeWorkspaceStmt.get(workspace, current.id) as { id?: string } | undefined;
    if (active?.id) throw new RunConflictError(active.id, `Workspace is already being written by run ${active.id}: ${workspace}`);
  }
  // Two tabs on one conversation would otherwise run two turns against the
  // same transcript, with or without a workspace.
  if (to === "running" && current.conversation_id) {
    const active = activeConversationStmt.get(current.conversation_id, current.id) as { id?: string } | undefined;
    if (active?.id) throw new RunConflictError(active.id, `This conversation already has a run in progress: ${active.id}`);
  }

  const now = new Date().toISOString();
  const resultJson = input.result === undefined ? current.result_json : safeJson(input.result);
  const error = input.error === undefined
    ? current.error
    : (input.error === null || input.error === "" ? null : safeString(requiredText(input.error, "error")));
  const externalSessionId = input.externalSessionId === undefined
    ? current.external_session_id
    : optionalText(input.externalSessionId, "externalSessionId");
  const startedAt = current.started_at ?? (to === "running" ? now : null);
  const finishedAt = isTerminal(to) ? (current.finished_at ?? now) : current.finished_at;

  updateRunStmt.run(
    to,
    current.effective_model,
    current.model_source,
    current.effective_effort,
    current.effort_source,
    current.runtime_version,
    workspace,
    externalSessionId,
    resultJson,
    error,
    startedAt,
    finishedAt,
    now,
    current.id,
  );
  return runFromRow(requireRun(current.id));
}

export function startRun(runId: string): Run {
  return updateRunStatus(runId, { status: "running" });
}

export function appendRunEvent(runId: string, input: RunEventInput): RunEvent {
  const run = requireRun(runId);
  const type = requiredText(input.type, "type");
  const providerEventId = input.providerEventId === undefined
    ? null
    : optionalText(input.providerEventId, "providerEventId");
  const now = new Date().toISOString();
  db.exec("BEGIN IMMEDIATE");
  try {
    const max = maxEventSequenceStmt.get(run.id) as { sequence?: number } | undefined;
    const sequence = Number(max?.sequence ?? 0) + 1;
    insertEventStmt.run(run.id, sequence, type, safeJson(input.payload), providerEventId, now);
    touchRunStmt.run(now, run.id);
    db.exec("COMMIT");
    return {
      id: Number((db.prepare("SELECT last_insert_rowid() AS id").get() as { id?: number }).id),
      runId: run.id,
      sequence,
      type,
      payload: browserSafe(input.payload),
      providerEventId,
      createdAt: now,
    };
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Error asli lebih berguna daripada error rollback sekunder.
    }
    throw error;
  }
}

export function listRunEvents(runId: string, options: RunEventListOptions = {}): RunEvent[] {
  const run = requireRun(runId);
  const afterSequence = options.afterSequence === undefined ? 0 : Number(options.afterSequence);
  if (!Number.isInteger(afterSequence) || afterSequence < 0) throw new Error("afterSequence must be a non-negative integer");
  const requestedLimit = options.limit === undefined ? 100 : Number(options.limit);
  if (!Number.isFinite(requestedLimit) || requestedLimit < 1) throw new Error("limit must be a positive number");
  const limit = Math.min(500, Math.floor(requestedLimit));
  const rows = db.prepare(`
    SELECT id, run_id, sequence, type, payload_json, provider_event_id, created_at
      FROM run_events
     WHERE run_id = ? AND sequence > ?
     ORDER BY sequence ASC
     LIMIT ?
  `).all(run.id, afterSequence, limit) as Array<{
    id: number;
    run_id: string;
    sequence: number;
    type: string;
    payload_json: string;
    provider_event_id: string | null;
    created_at: string;
  }>;
  return rows.map((row) => ({
    id: Number(row.id),
    runId: row.run_id,
    sequence: Number(row.sequence),
    type: row.type,
    payload: parseJson(row.payload_json),
    providerEventId: row.provider_event_id,
    createdAt: row.created_at,
  }));
}

function approvalFromRow(row: ApprovalRow): RunApproval {
  const status = approvalStatus(row.status);
  return {
    id: row.id,
    runId: row.run_id,
    toolCallId: row.tool_call_id,
    status,
    request: parseJson(row.request_json, {}),
    decision: parseJson(row.decision_json),
    createdAt: row.created_at,
    decidedAt: row.decided_at,
  };
}

function requireApproval(approvalId: string): ApprovalRow {
  const id = requiredText(approvalId, "approvalId");
  const row = getApprovalStmt.get(id) as unknown as ApprovalRow | undefined;
  if (!row) throw new Error(`Approval ${id} not found`);
  return row;
}

export function createRunApproval(input: RunApprovalInput): RunApproval {
  const run = requireRun(input.runId);
  const id = `approval_${randomUUID()}`;
  const toolCallId = optionalText(input.toolCallId, "toolCallId");
  const now = new Date().toISOString();
  insertApprovalStmt.run(id, run.id, toolCallId, safeJson(input.request, {}), now);
  return approvalFromRow(requireApproval(id));
}

export function getRunApproval(approvalId: string): RunApproval | null {
  const id = requiredText(approvalId, "approvalId");
  const row = getApprovalStmt.get(id) as unknown as ApprovalRow | undefined;
  return row ? approvalFromRow(row) : null;
}

export function listRunApprovals(runId: string): RunApproval[] {
  const run = requireRun(runId);
  const rows = db.prepare(`
    SELECT id, run_id, tool_call_id, status, request_json, decision_json,
           created_at, decided_at
      FROM run_approvals WHERE run_id = ? ORDER BY created_at ASC, id ASC
  `).all(run.id) as unknown as ApprovalRow[];
  return rows.map(approvalFromRow);
}

export function resolveRunApproval(
  approvalId: string,
  status: Exclude<ApprovalStatus, "pending">,
  decision?: unknown,
): RunApproval {
  const approval = requireApproval(approvalId);
  if (approval.status !== "pending") throw new ApprovalConflictError(approval.id, approval.status);
  const resolvedStatus = approvalStatus(status);
  if (resolvedStatus === "pending") throw new Error("Approval resolution must be final");
  const decidedAt = new Date().toISOString();
  const result = resolveApprovalStmt.run(
    resolvedStatus,
    safeJson(decision, {}),
    decidedAt,
    approval.id,
  );
  if (Number(result.changes) !== 1) throw new ApprovalConflictError(approval.id, "resolved");
  return approvalFromRow(requireApproval(approval.id));
}

function evidenceFromRow(row: EvidenceRow): RunEvidence {
  return {
    id: row.id,
    runId: row.run_id,
    kind: evidenceKind(row.kind),
    summary: row.summary === null ? null : safeString(row.summary),
    payload: parseJson(row.payload_json),
    command: row.command === null ? null : safeString(row.command),
    exitCode: row.exit_code === null ? null : Number(row.exit_code),
    createdAt: row.created_at,
  };
}

function requireEvidence(evidenceId: string): EvidenceRow {
  const id = requiredText(evidenceId, "evidenceId");
  const row = getEvidenceStmt.get(id) as unknown as EvidenceRow | undefined;
  if (!row) throw new Error(`Evidence ${id} not found`);
  return row;
}

export function addRunEvidence(input: RunEvidenceInput): RunEvidence {
  const run = requireRun(input.runId);
  const kind = evidenceKind(input.kind);
  const summary = input.summary === undefined || input.summary === null || input.summary === ""
    ? null
    : safeString(requiredText(input.summary, "summary"));
  const command = input.command === undefined || input.command === null || input.command === ""
    ? null
    : safeString(requiredText(input.command, "command"));
  const exitCode = input.exitCode === undefined || input.exitCode === null
    ? null
    : Number(input.exitCode);
  if (exitCode !== null && (!Number.isInteger(exitCode) || !Number.isFinite(exitCode))) {
    throw new Error("exitCode must be an integer");
  }
  const id = `evidence_${randomUUID()}`;
  const now = new Date().toISOString();
  insertEvidenceStmt.run(id, run.id, kind, summary, safeJson(input.payload), command, exitCode, now);
  return evidenceFromRow(requireEvidence(id));
}

export function getRunEvidence(evidenceId: string): RunEvidence | null {
  const id = requiredText(evidenceId, "evidenceId");
  const row = getEvidenceStmt.get(id) as unknown as EvidenceRow | undefined;
  return row ? evidenceFromRow(row) : null;
}

export function listRunEvidence(runId: string): RunEvidence[] {
  const run = requireRun(runId);
  const rows = db.prepare(`
    SELECT id, run_id, kind, summary, payload_json, command, exit_code, created_at
      FROM run_evidence WHERE run_id = ? ORDER BY created_at ASC, id ASC
  `).all(run.id) as unknown as EvidenceRow[];
  return rows.map(evidenceFromRow);
}

export function parseRunCreateInput(value: unknown): RunCreateInput {
  if (!isRecord(value)) throw new Error("A run object is required");
  return {
    ...(value.id !== undefined ? { id: value.id as string } : {}),
    idempotencyKey: value.idempotencyKey as string,
    conversationId: value.conversationId as string | null | undefined,
    taskId: value.taskId as string | null | undefined,
    runtime: value.runtime as string,
    connectionId: value.connectionId as string | null | undefined,
    requestedModel: value.requestedModel as RunPreferenceValue,
    effectiveModel: value.effectiveModel as string | null | undefined,
    modelSource: value.modelSource as RunSettingSource | undefined,
    requestedEffort: value.requestedEffort as RunPreferenceValue,
    effectiveEffort: value.effectiveEffort as string | null | undefined,
    effortSource: value.effortSource as RunSettingSource | undefined,
    runtimeVersion: value.runtimeVersion as string | null | undefined,
    workspace: value.workspace as string | null | undefined,
    externalSessionId: value.externalSessionId as string | null | undefined,
  };
}

export function parseRunStatusUpdate(value: unknown): RunStatusUpdateInput {
  if (!isRecord(value)) throw new Error("A run status object is required");
  return {
    status: runtimeStatus(value.status),
    ...(value.result !== undefined ? { result: value.result } : {}),
    ...(value.error !== undefined ? { error: value.error as string | null } : {}),
    ...(value.externalSessionId !== undefined ? { externalSessionId: value.externalSessionId as string | null } : {}),
  };
}

export function parseRunEventInput(value: unknown): RunEventInput {
  if (!isRecord(value)) throw new Error("A run event object is required");
  return {
    type: value.type as string,
    ...(value.payload !== undefined ? { payload: value.payload } : {}),
    ...(value.providerEventId !== undefined ? { providerEventId: value.providerEventId as string | null } : {}),
  };
}

export function parseRunApprovalInput(runId: string, value: unknown): RunApprovalInput {
  if (!isRecord(value)) throw new Error("An approval object is required");
  return {
    runId,
    toolCallId: value.toolCallId as string | null | undefined,
    request: value.request ?? {
      ...(value.command !== undefined ? { command: value.command } : {}),
      ...(value.cwd !== undefined ? { cwd: value.cwd } : {}),
      ...(value.input !== undefined ? { input: value.input } : {}),
    },
  };
}

export function parseRunEvidenceInput(runId: string, value: unknown): RunEvidenceInput {
  if (!isRecord(value)) throw new Error("An evidence object is required");
  return {
    runId,
    kind: value.kind as EvidenceKind,
    summary: value.summary as string | null | undefined,
    payload: value.payload,
    command: value.command as string | null | undefined,
    exitCode: value.exitCode as number | null | undefined,
  };
}
