import assert from "node:assert/strict";
import test from "node:test";

import { createStdioTransport } from "./stdio.ts";

test("a server that closed its stdin fails the request instead of crashing Undagi", async () => {
  let ready!: () => void;
  const started = new Promise<void>((resolve) => { ready = resolve; });
  const failures: string[] = [];
  const transport = createStdioTransport({
    command: process.execPath,
    // Closes its end of the pipe and stays alive, so the next write gets EPIPE.
    args: ["-e", "require('fs').closeSync(0); process.stderr.write('ready\\n'); setTimeout(() => {}, 5000)"],
    env: {},
    onStderr: () => ready(),
    onExit: (error) => failures.push(error.message),
  });
  try {
    await started;
    await assert.rejects(
      transport.peer.request("initialize", {}, { timeoutMs: 5_000 }),
      /Could not write to the MCP server: .*EPIPE/,
    );
    assert.match(failures[0] ?? "", /EPIPE/);
  } finally {
    await transport.close();
  }
});
