// Copyright (c) 2026 Charis Chakim - Undagi (https://github.com/CharisChakim/undagi)
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { isAbsolute } from "node:path";

import { db } from "../../db.ts";
import { resolveExecutable } from "./process.ts";
import { RUNTIME_IDS, type RuntimeId } from "./types.ts";

// Path executable adalah fakta per-mesin: ia tidak bergantung pada koneksi,
// scope, atau role, jadi ia tidak ikut tabel runtime_preferences yang berkunci
// empat kolom itu.
db.exec(`
  CREATE TABLE IF NOT EXISTS runtime_binary_paths (
    runtime    TEXT PRIMARY KEY,
    path       TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK (length(trim(path)) > 0)
  );
`);

const listStmt = db.prepare(`SELECT runtime, path FROM runtime_binary_paths`);
const upsertStmt = db.prepare(`
  INSERT INTO runtime_binary_paths (runtime, path, updated_at)
  VALUES (?, ?, ?)
  ON CONFLICT(runtime) DO UPDATE SET
    path = excluded.path,
    updated_at = excluded.updated_at
`);
const deleteStmt = db.prepare(`DELETE FROM runtime_binary_paths WHERE runtime = ?`);

export interface RuntimeBinaryPathInput {
  runtime: RuntimeId;
  /** Null menghapus override sehingga deteksi kembali menelusuri PATH. */
  path: string | null;
}

export class RuntimeBinaryPathError extends Error {
  constructor(readonly code: "RUNTIME_INVALID" | "PATH_NOT_ABSOLUTE" | "PATH_NOT_EXECUTABLE") {
    super(code);
    this.name = "RuntimeBinaryPathError";
  }
}

export function listRuntimeBinaryPaths(): Partial<Record<RuntimeId, string>> {
  const rows = listStmt.all() as unknown as Array<{ runtime: string; path: string }>;
  const paths: Partial<Record<RuntimeId, string>> = {};
  for (const row of rows) {
    if (RUNTIME_IDS.includes(row.runtime as RuntimeId)) paths[row.runtime as RuntimeId] = row.path;
  }
  return paths;
}

export function saveRuntimeBinaryPath({ runtime, path }: RuntimeBinaryPathInput): void {
  if (path === null) {
    deleteStmt.run(runtime);
    return;
  }
  upsertStmt.run(runtime, path, new Date().toISOString());
}

/**
 * Validate an override before it is stored, because a stored path that resolves
 * to nothing would leave the card reporting a runtime that cannot start.
 */
export function parseRuntimeBinaryPathInput(value: unknown): RuntimeBinaryPathInput {
  const input = typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
  if (!RUNTIME_IDS.includes(input.runtime as RuntimeId)) throw new RuntimeBinaryPathError("RUNTIME_INVALID");
  const runtime = input.runtime as RuntimeId;

  const raw = typeof input.path === "string" ? input.path.trim() : "";
  if (!raw) return { runtime, path: null };

  // Di aplikasi desktop cwd dipindah ke folder data pengguna, jadi path relatif
  // akan menunjuk tempat yang tidak diduga siapa pun yang mengisinya.
  if (!isAbsolute(raw)) throw new RuntimeBinaryPathError("PATH_NOT_ABSOLUTE");
  if (!resolveExecutable(raw)) throw new RuntimeBinaryPathError("PATH_NOT_EXECUTABLE");
  return { runtime, path: raw };
}
