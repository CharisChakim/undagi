// Copyright (c) 2026 Charis Chakim - Undagi (https://github.com/CharisChakim/undagi)
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import express, { type Request, type Response } from "express";

import {
  appendRunEvent,
  addRunEvidence,
  createRun,
  createRunApproval,
  getRun,
  getRunApproval,
  getRunEvidence,
  listRunApprovals,
  listRunEvidence,
  listRunEvents,
  listRuns,
  parseRunApprovalInput,
  parseRunCreateInput,
  parseRunEventInput,
  parseRunEvidenceInput,
  parseRunStatusUpdate,
  resolveRunApproval,
  updateRunStatus,
  type RunListFilter,
} from "../runs/store.ts";
import type { RunStatus } from "../runs/types.ts";

const router = express.Router();

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function statusCode(error: unknown): number {
  if (error && typeof error === "object" && "statusCode" in error && typeof error.statusCode === "number") {
    return error.statusCode;
  }
  return 400;
}

function sendError(res: Response, error: unknown): void {
  if (!res.headersSent) res.status(statusCode(error)).json({ error: errorMessage(error) });
}

function queryString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`${field} must be a single query value`);
  return value;
}

function queryNumber(value: unknown, field: string): number | undefined {
  const text = queryString(value, field);
  if (text === undefined || text === "") return undefined;
  const parsed = Number(text);
  if (!Number.isFinite(parsed)) throw new Error(`${field} must be a number`);
  return parsed;
}

function runId(req: Request): string {
  if (typeof req.params.runId !== "string" || !req.params.runId.trim()) throw new Error("runId is required");
  return req.params.runId.trim();
}

function getRequiredRun(runIdValue: string, res: Response) {
  const run = getRun(runIdValue);
  if (!run) {
    res.status(404).json({ error: `Run ${runIdValue} not found` });
    return null;
  }
  return run;
}

router.post("/api/runs", (req: Request, res: Response) => {
  try {
    const result = createRun(parseRunCreateInput(req.body));
    res.status(result.created ? 201 : 200).json({ run: result.run, created: result.created });
  } catch (error) {
    sendError(res, error);
  }
});

router.get("/api/runs", (req: Request, res: Response) => {
  try {
    const status = queryString(req.query.status, "status");
    const filter: RunListFilter = {
      ...(status !== undefined ? { status: status as RunStatus } : {}),
      ...(req.query.workspace !== undefined ? { workspace: queryString(req.query.workspace, "workspace") ?? null } : {}),
      ...(req.query.conversationId !== undefined ? { conversationId: queryString(req.query.conversationId, "conversationId") ?? null } : {}),
      ...(req.query.taskId !== undefined ? { taskId: queryString(req.query.taskId, "taskId") ?? null } : {}),
      ...(req.query.limit !== undefined ? { limit: queryNumber(req.query.limit, "limit") } : {}),
    };
    res.json({ runs: listRuns(filter) });
  } catch (error) {
    sendError(res, error);
  }
});

router.get("/api/runs/:runId", (req: Request, res: Response) => {
  try {
    const run = getRequiredRun(runId(req), res);
    if (run) res.json({ run });
  } catch (error) {
    sendError(res, error);
  }
});

router.put("/api/runs/:runId/status", (req: Request, res: Response) => {
  try {
    res.json({ run: updateRunStatus(runId(req), parseRunStatusUpdate(req.body)) });
  } catch (error) {
    sendError(res, error);
  }
});

router.post("/api/runs/:runId/events", (req: Request, res: Response) => {
  try {
    res.status(201).json({ event: appendRunEvent(runId(req), parseRunEventInput(req.body)) });
  } catch (error) {
    sendError(res, error);
  }
});

router.get("/api/runs/:runId/events", (req: Request, res: Response) => {
  try {
    const run = getRequiredRun(runId(req), res);
    if (!run) return;
    res.json({
      events: listRunEvents(run.id, {
        ...(req.query.afterSequence !== undefined ? { afterSequence: queryNumber(req.query.afterSequence, "afterSequence") } : {}),
        ...(req.query.limit !== undefined ? { limit: queryNumber(req.query.limit, "limit") } : {}),
      }),
    });
  } catch (error) {
    sendError(res, error);
  }
});

router.post("/api/runs/:runId/approvals", (req: Request, res: Response) => {
  try {
    res.status(201).json({ approval: createRunApproval(parseRunApprovalInput(runId(req), req.body)) });
  } catch (error) {
    sendError(res, error);
  }
});

router.get("/api/runs/:runId/approvals", (req: Request, res: Response) => {
  try {
    const run = getRequiredRun(runId(req), res);
    if (run) res.json({ approvals: listRunApprovals(run.id) });
  } catch (error) {
    sendError(res, error);
  }
});

router.get("/api/runs/:runId/approvals/:approvalId", (req: Request, res: Response) => {
  try {
    const approval = getRunApproval(req.params.approvalId);
    if (!approval || approval.runId !== runId(req)) {
      res.status(404).json({ error: "Approval not found" });
      return;
    }
    res.json({ approval });
  } catch (error) {
    sendError(res, error);
  }
});

router.patch("/api/runs/:runId/approvals/:approvalId", (req: Request, res: Response) => {
  try {
    const id = req.params.approvalId;
    const approval = getRunApproval(id);
    if (!approval || approval.runId !== runId(req)) {
      res.status(404).json({ error: "Approval not found" });
      return;
    }
    const body = req.body && typeof req.body === "object" ? req.body as Record<string, unknown> : {};
    const decision = body.status ?? body.decision;
    const status = decision === "approved" || decision === "rejected" || decision === "expired"
      ? decision
      : undefined;
    if (!status) throw new Error("Approval status must be approved, rejected, or expired");
    res.json({ approval: resolveRunApproval(id, status, body.result ?? body.decisionData) });
  } catch (error) {
    sendError(res, error);
  }
});

router.post("/api/runs/:runId/evidence", (req: Request, res: Response) => {
  try {
    res.status(201).json({ evidence: addEvidence(runId(req), req.body) });
  } catch (error) {
    sendError(res, error);
  }
});

router.get("/api/runs/:runId/evidence", (req: Request, res: Response) => {
  try {
    const run = getRequiredRun(runId(req), res);
    if (run) res.json({ evidence: listRunEvidence(run.id) });
  } catch (error) {
    sendError(res, error);
  }
});

router.get("/api/runs/:runId/evidence/:evidenceId", (req: Request, res: Response) => {
  try {
    const evidence = getRunEvidence(req.params.evidenceId);
    if (!evidence || evidence.runId !== runId(req)) {
      res.status(404).json({ error: "Evidence not found" });
      return;
    }
    res.json({ evidence });
  } catch (error) {
    sendError(res, error);
  }
});

function addEvidence(runIdValue: string, body: unknown) {
  return addRunEvidence(parseRunEvidenceInput(runIdValue, body));
}

export { router };
export default router;
