// Copyright (c) 2026 Charis Chakim - Undagi (https://github.com/CharisChakim/undagi)
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { strict as assert } from "node:assert";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import { JsonlParser, parseJsonRpcLine } from "./protocol.ts";
import {
  CodexAppServerTransport,
  RuntimeTransportError,
  type AppServerChild,
  type AppServerSpawn,
} from "./transport.ts";
import {
  INITIALIZE_RESPONSE_FIXTURE,
  THREAD_START_RESPONSE_FIXTURE,
  TURN_START_RESPONSE_FIXTURE,
} from "./fixtures.ts";

class FixtureChild extends EventEmitter implements AppServerChild {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  killed = false;

  kill(): boolean {
    if (this.killed) return false;
    this.killed = true;
    this.emit("close", null, "SIGTERM");
    return true;
  }
}

function fixtureSpawn(onRequest: (message: Record<string, unknown>, child: FixtureChild) => void): {
  spawn: AppServerSpawn;
  child: FixtureChild;
  options: { shell: boolean | null };
} {
  const child = new FixtureChild();
  const options = { shell: null as boolean | null };
  child.stdin.on("data", (chunk: Buffer) => {
    for (const line of chunk.toString("utf8").split("\n")) {
      if (!line.trim()) continue;
      onRequest(JSON.parse(line) as Record<string, unknown>, child);
    }
  });
  return {
    child,
    options,
    spawn: ((_, __, spawnOptions) => {
      options.shell = spawnOptions.shell;
      return child;
    }) as AppServerSpawn,
  };
}

function emitLine(child: FixtureChild, line: string): void {
  child.stdout.write(`${line}\n`);
}

test("JSONL parser separates messages, malformed lines, and split chunks", () => {
  const parser = new JsonlParser(64);
  const parsed = parser.push(`${JSON.stringify({ id: 7, result: { ok: true }})}\nnot-json\n`);
  assert.equal(parsed[0]?.type, "message");
  assert.equal(parsed[1]?.type, "malformed");
  const split = new JsonlParser();
  assert.equal(split.push(Buffer.from("{\"id\":8,"))[0], undefined);
  const splitResult = split.push(Buffer.from("\"result\":{}}\n"))[0];
  assert.deepEqual(splitResult, { type: "message", message: { id: 8, result: {} } });
  assert.equal(parseJsonRpcLine("[]").type, "malformed");
});

test("transport spawns without a shell and survives a malformed line during a request", async () => {
  const fixture = fixtureSpawn((message, child) => {
    const id = message.id;
    if (message.method === "initialize") emitLine(child, INITIALIZE_RESPONSE_FIXTURE);
    if (message.method === "thread/start") {
      emitLine(child, "malformed fixture line");
      emitLine(child, THREAD_START_RESPONSE_FIXTURE);
    }
    if (message.method === "turn/start") emitLine(child, TURN_START_RESPONSE_FIXTURE);
  });
  const malformed: string[] = [];
  const transport = new CodexAppServerTransport({
    executable: "codex",
    spawn: fixture.spawn,
    rpcTimeoutMs: 100,
  });
  transport.onMalformed((error) => malformed.push(error.code));
  await transport.connect();
  assert.equal(fixture.options?.shell, false);
  const thread = await transport.request("thread/start", { cwd: "/workspace/fixture" });
  assert.deepEqual((thread as { thread: { id: string }}).thread.id, "thread_fixture");
  assert.deepEqual(malformed, ["MALFORMED_JSON"]);
  const turn = await transport.request("turn/start", { threadId: "thread_fixture", input: [] });
  assert.deepEqual((turn as { turn: { id: string }}).turn.id, "turn_fixture");
  await transport.close();
});

test("transport rejects connect, without crashing, when app-server stops reading its stdin", async () => {
  const transport = new CodexAppServerTransport({
    executable: process.execPath,
    // Answers initialize after closing its stdin, so the `initialized` write gets EPIPE.
    args: ["-e", "require('fs').closeSync(0); process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }) + '\\n'); setTimeout(() => {}, 5000)"],
  });
  try {
    await assert.rejects(transport.connect(), (error: unknown) =>
      error instanceof RuntimeTransportError && error.code === "WRITE_ERROR");
  } finally {
    await transport.close();
  }
});

test("transport rejects connect when initialize never answers", async () => {
  const timeoutFixture = fixtureSpawn(() => undefined);
  const timeoutTransport = new CodexAppServerTransport({
    executable: "codex",
    spawn: timeoutFixture.spawn,
    initializeTimeoutMs: 10,
  });
  await assert.rejects(timeoutTransport.connect(), (error: unknown) =>
    error instanceof RuntimeTransportError && error.code === "RPC_TIMEOUT");
});
