// Copyright (c) 2026 Charis Chakim - Undagi (https://github.com/CharisChakim/undagi)
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { RuntimeBinaryPathError } from "./binary-paths.ts";

// db.ts reads this when it is first imported, so the module is loaded after
// the data directory is pointed somewhere disposable.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "undagi-binary-paths-test-"));
process.env.UNDAGI_DATA_DIR = dataDir;

const { parseRuntimeBinaryPathInput } = await import("./binary-paths.ts");
const { db } = await import("../../db.ts");
// Windows will not delete a database file that is still open.
process.on("exit", () => {
  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("an empty path clears the override instead of failing", () => {
  assert.deepEqual(parseRuntimeBinaryPathInput({ runtime: "claude", path: "" }), {
    runtime: "claude",
    path: null,
  });
  assert.deepEqual(parseRuntimeBinaryPathInput({ runtime: "claude", path: "   " }), {
    runtime: "claude",
    path: null,
  });
  assert.deepEqual(parseRuntimeBinaryPathInput({ runtime: "claude" }), {
    runtime: "claude",
    path: null,
  });
});

test("an unknown runtime is rejected", () => {
  assert.throws(
    () => parseRuntimeBinaryPathInput({ runtime: "gemini", path: "/bin/sh" }),
    (error: RuntimeBinaryPathError) => error.code === "RUNTIME_INVALID",
  );
  assert.throws(
    () => parseRuntimeBinaryPathInput(null),
    (error: RuntimeBinaryPathError) => error.code === "RUNTIME_INVALID",
  );
});

test("a relative path is rejected because cwd is not where the user is looking", () => {
  assert.throws(
    () => parseRuntimeBinaryPathInput({ runtime: "codex", path: "bin/codex" }),
    (error: RuntimeBinaryPathError) => error.code === "PATH_NOT_ABSOLUTE",
  );
});

test("a path with nothing executable behind it is rejected", () => {
  assert.throws(
    () => parseRuntimeBinaryPathInput({ runtime: "codex", path: "/nonexistent/codex" }),
    (error: RuntimeBinaryPathError) => error.code === "PATH_NOT_EXECUTABLE",
  );
  // A directory resolves on the filesystem but can never be spawned.
  assert.throws(
    () => parseRuntimeBinaryPathInput({ runtime: "codex", path: path.dirname(process.execPath) }),
    (error: RuntimeBinaryPathError) => error.code === "PATH_NOT_EXECUTABLE",
  );
});

test("an absolute path to a real executable is accepted verbatim", () => {
  // The Node binary running this test exists on every platform; /bin/sh does not on Windows.
  assert.deepEqual(parseRuntimeBinaryPathInput({ runtime: "antigravity", path: `  ${process.execPath}  ` }), {
    runtime: "antigravity",
    path: process.execPath,
  });
});
