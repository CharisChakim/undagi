// Copyright (c) 2026 Charis Chakim - Undagi (https://github.com/CharisChakim/undagi)
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { discoverRuntime } from "./discovery.ts";

// The installers ship without the SDK's own Claude binary, so the SDK can only
// list models through the `claude` that discovery found.
test("Claude models are asked for through the claude binary discovery found", { skip: process.platform === "win32" }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "undagi-claude-"));
  const executable = path.join(dir, "claude");
  writeFileSync(executable, "#!/bin/sh\necho '2.1.0 (Claude Code)'\n");
  chmodSync(executable, 0o755);
  const asked: Array<string | undefined> = [];
  try {
    const detection = await discoverRuntime("claude", {
      binaryPaths: { claude: executable },
      claudeSdk: {
        supportedModels: (executablePath) => {
          asked.push(executablePath);
          return [{ value: "sonnet", displayName: "Sonnet" }];
        },
      },
    });
    assert.deepEqual(asked, [executable]);
    assert.equal(detection.status, "ready");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
