// Copyright (c) 2026 Charis Chakim - Undagi (https://github.com/CharisChakim/undagi)
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import express, { type Request, type Response } from "express";

import {
  getRuntimePreferenceOrDefault,
  listRuntimePreferences,
  parseRuntimePreferenceInput,
  saveRuntimePreference,
  type RuntimePreferenceFilter,
  type RuntimePreferenceKey,
} from "../runtimes/preferences.ts";

const router = express.Router();

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sendError(res: Response, error: unknown): void {
  if (!res.headersSent) res.status(400).json({ error: errorMessage(error) });
}

function queryString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`${field} must be a single query value`);
  return value;
}

router.get("/api/runtime-preferences", (req: Request, res: Response) => {
  try {
    const query = req.query;
    const runtimeQuery = queryString(query.runtime, "runtime");
    const connectionQuery = queryString(query.connectionId, "connectionId");

    if (runtimeQuery && connectionQuery) {
      const key: RuntimePreferenceKey = {
        runtime: runtimeQuery as RuntimePreferenceKey["runtime"],
        connectionId: connectionQuery,
        ...(query.scope !== undefined ? { scope: queryString(query.scope, "scope") as RuntimePreferenceKey["scope"] } : {}),
        ...(query.scopeKey !== undefined ? { scopeKey: queryString(query.scopeKey, "scopeKey") ?? null } : {}),
      };
      // Kunci yang belum pernah disimpan tetap mengembalikan inherit secara
      // eksplisit agar klien tidak mengira default runtime adalah override.
      res.json({ preference: getRuntimePreferenceOrDefault(key) });
      return;
    }

    const filter: RuntimePreferenceFilter = {
      ...(query.runtime !== undefined ? { runtime: runtimeQuery as RuntimePreferenceFilter["runtime"] } : {}),
      ...(query.connectionId !== undefined ? { connectionId: connectionQuery } : {}),
      ...(query.scope !== undefined ? { scope: queryString(query.scope, "scope") as RuntimePreferenceFilter["scope"] } : {}),
      ...(query.scopeKey !== undefined ? { scopeKey: queryString(query.scopeKey, "scopeKey") ?? null } : {}),
    };
    res.json({ preferences: listRuntimePreferences(filter) });
  } catch (error) {
    sendError(res, error);
  }
});

router.put("/api/runtime-preferences", (req: Request, res: Response) => {
  try {
    const preference = saveRuntimePreference(parseRuntimePreferenceInput(req.body));
    // Store tidak pernah menyimpan credential provider, dan response hanya
    // berisi pilihan model/effort beserta sumber permintaannya.
    res.json({ preference });
  } catch (error) {
    sendError(res, error);
  }
});

export { router };
export default router;
