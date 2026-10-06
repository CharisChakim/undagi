// Copyright (c) 2026 Charis Chakim - Undagi (https://github.com/CharisChakim/undagi)
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";

const moduleUrl = new URL("./db.ts", import.meta.url).href;
const repoRoot = path.dirname(fileURLToPath(import.meta.url));

// db.ts opens its database when it is first imported and a module is only
// evaluated once per process, so every fixture loads it in a child process.
function loadDbWith(envVars: Record<string, string>): { dir: string; ids: string[] } {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.UNDAGI_DATA_DIR;
  delete env.ARCHITECH_DATA_DIR;
  Object.assign(env, envVars);
  const script = `
    const m = await import(${JSON.stringify(moduleUrl)});
    console.log(JSON.stringify({ dir: m.DB_DIR, ids: m.listSessions().map((row) => row.id) }));
  `;
  const result = spawnSync(process.execPath, ["--import", "tsx", "-e", script], {
    cwd: repoRoot,
    env,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, `loading db.ts failed:\n${result.stderr}`);
  return JSON.parse(result.stdout.trim().split("\n").pop() as string);
}

function freshDataDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "undagi-db-legacy-test-"));
  process.on("exit", () => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function seedSession(file: string, id: string): void {
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE sessions (
      id           TEXT PRIMARY KEY,
      title        TEXT NOT NULL DEFAULT '',
      updated_at   TEXT NOT NULL,
      current_step INTEGER NOT NULL DEFAULT 1,
      payload      TEXT NOT NULL
    );
  `);
  db.prepare("INSERT INTO sessions VALUES (?, ?, ?, ?, ?)")
    .run(id, "Seeded project", "2026-09-01T00:00:00.000Z", 1, JSON.stringify({ id }));
  db.close();
}

test("a lone architech.db is copied to undagi.db and the old file is left as it was", () => {
  const dataDir = freshDataDir();
  const legacy = path.join(dataDir, "architech.db");
  seedSession(legacy, "legacy-row");
  const before = fs.readFileSync(legacy);

  const loaded = loadDbWith({ UNDAGI_DATA_DIR: dataDir });

  assert.equal(loaded.dir, dataDir);
  assert.deepEqual(loaded.ids, ["legacy-row"]);
  assert.ok(fs.existsSync(path.join(dataDir, "undagi.db")), "the copy has to exist under the new name");
  assert.ok(fs.readFileSync(legacy).equals(before), "the legacy file must stay byte-for-byte unchanged");
  assert.deepEqual(
    fs.readdirSync(dataDir).filter((name) => name.includes(".tmp-")),
    [],
    "the temporary copy must be renamed away, not left behind",
  );
});

test("the legacy ARCHITECH_DATA_DIR still selects the directory when the new name is unset", () => {
  const dataDir = freshDataDir();
  seedSession(path.join(dataDir, "architech.db"), "legacy-row");

  const loaded = loadDbWith({ ARCHITECH_DATA_DIR: dataDir });

  assert.equal(loaded.dir, dataDir);
  assert.deepEqual(loaded.ids, ["legacy-row"]);
  assert.ok(fs.existsSync(path.join(dataDir, "undagi.db")));
});

test("when both files exist undagi.db wins and is not overwritten by the old one", () => {
  const dataDir = freshDataDir();
  const legacy = path.join(dataDir, "architech.db");
  seedSession(legacy, "legacy-row");
  seedSession(path.join(dataDir, "undagi.db"), "current-row");
  const before = fs.readFileSync(legacy);

  const loaded = loadDbWith({ UNDAGI_DATA_DIR: dataDir });

  assert.deepEqual(loaded.ids, ["current-row"]);
  assert.ok(fs.readFileSync(legacy).equals(before));
});

test("UNDAGI_DATA_DIR takes precedence over ARCHITECH_DATA_DIR", () => {
  const newDir = freshDataDir();
  const oldDir = freshDataDir();
  seedSession(path.join(newDir, "undagi.db"), "current-row");
  seedSession(path.join(oldDir, "undagi.db"), "other-row");

  const loaded = loadDbWith({ UNDAGI_DATA_DIR: newDir, ARCHITECH_DATA_DIR: oldDir });

  assert.equal(loaded.dir, newDir);
  assert.deepEqual(loaded.ids, ["current-row"]);
});

test("an empty UNDAGI_DATA_DIR does not hide a working ARCHITECH_DATA_DIR", () => {
  const dataDir = freshDataDir();
  seedSession(path.join(dataDir, "architech.db"), "legacy-row");

  const loaded = loadDbWith({ UNDAGI_DATA_DIR: "", ARCHITECH_DATA_DIR: dataDir });

  assert.equal(loaded.dir, dataDir);
  assert.deepEqual(loaded.ids, ["legacy-row"]);
});
