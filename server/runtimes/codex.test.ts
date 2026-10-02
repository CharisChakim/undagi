import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { queryCodexAppServer } from "./codex.ts";

// Answers initialize after closing its stdin, so the next request gets EPIPE.
const CLOSES_STDIN = `#!/usr/bin/env node
require("fs").closeSync(0);
process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }) + "\\n");
setTimeout(() => {}, 5000);
`;

test("discovery reports an app-server that stopped reading its stdin instead of crashing", { skip: process.platform === "win32" }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "undagi-codex-"));
  const executable = path.join(dir, "codex");
  writeFileSync(executable, CLOSES_STDIN);
  chmodSync(executable, 0o755);
  try {
    const result = await queryCodexAppServer(executable, { timeoutMs: 5_000 });
    assert.equal(result.ok, false);
    assert.equal(result.diagnostic, "PROCESS_EXITED");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
