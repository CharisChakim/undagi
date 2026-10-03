import { strict as assert } from "node:assert";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";

import { CodexRuntimeExecutor } from "./codex.ts";
import { CodexAppServerTransport, type AppServerChild, type AppServerSpawn } from "./transport.ts";
import type { RuntimeApprovalRequest, RuntimeEvent } from "./types.ts";

// These drive the real transport and executor with bytes on a fake app-server
// stdout, so a broken stream is exercised where it would actually arrive.

class FixtureChild extends EventEmitter implements AppServerChild {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  killed = false;

  kill(): boolean {
    if (this.killed) return false;
    this.killed = true;
    this.exit();
    return true;
  }

  /** The process going away on its own, as a crash or an OOM kill does. */
  exit(): void {
    // Like a real child, close follows the end of its output streams.
    this.stdout.once("end", () => this.emit("close", 1, null));
    this.stdout.end();
  }

  write(raw: string): void {
    this.stdout.write(raw);
  }

  send(message: Record<string, unknown>): void {
    this.write(`${JSON.stringify(message)}\n`);
  }
}

const THREAD = "thread_fixture";
const TURN = "turn_fixture";

function notification(method: string, params: Record<string, unknown>): Record<string, unknown> {
  return { method, params: { threadId: THREAD, turnId: TURN, ...params } };
}

const textDelta = (delta: string) => notification("item/agentMessage/delta", { itemId: "msg_1", delta });
const turnCompleted = notification("turn/completed", { turn: { id: TURN, status: "completed" } });

/** An app-server that answers the start handshake, then lets the test speak. */
function appServer(): { child: FixtureChild; spawn: AppServerSpawn; requests: Record<string, unknown>[] } {
  const child = new FixtureChild();
  const requests: Record<string, unknown>[] = [];
  child.stdin.on("data", (chunk: Buffer) => {
    for (const line of chunk.toString("utf8").split("\n")) {
      if (!line.trim()) continue;
      const message = JSON.parse(line) as Record<string, unknown>;
      requests.push(message);
      if (message.method === "initialize") child.send({ id: message.id, result: {} });
      if (message.method === "thread/start") child.send({ id: message.id, result: { thread: { id: THREAD } } });
      if (message.method === "turn/start") child.send({ id: message.id, result: { turn: { id: TURN } } });
      if (message.method === "turn/interrupt") child.send({ id: message.id, result: {} });
    }
  });
  return { child, requests, spawn: (() => child) as AppServerSpawn };
}

function executorFor(
  spawn: AppServerSpawn,
  approvalHandler?: (request: RuntimeApprovalRequest) => "accept" | "decline",
): CodexRuntimeExecutor {
  return new CodexRuntimeExecutor({
    executable: "codex",
    transport: new CodexAppServerTransport({ executable: "codex", spawn }),
    approvalHandler,
    // Long enough that a test only passes when the stream ends for its own reason.
    turnTimeoutMs: 10_000,
  });
}

/** Collect a turn, failing instead of waiting out the turn timeout. */
async function collect(stream: AsyncIterable<RuntimeEvent>, withinMs = 2_000): Promise<RuntimeEvent[]> {
  const events: RuntimeEvent[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`turn still open after ${withinMs}ms: ${JSON.stringify(events)}`)), withinMs);
  });
  const drain = (async () => {
    for await (const event of stream) events.push(event);
    return events;
  })();
  try {
    return await Promise.race([drain, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/** Start a turn and wait until the app-server has been asked for it. */
async function startedTurn(
  server: ReturnType<typeof appServer>,
  executor: CodexRuntimeExecutor,
): Promise<{ events: Promise<RuntimeEvent[]> }> {
  // Wrapped, because an async function returning a promise would wait for it.
  const events = collect(executor.startTurn({ prompt: "fixture" }));
  while (!server.requests.some((request) => request.method === "turn/start")) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  await new Promise((resolve) => setImmediate(resolve));
  return { events };
}

test("codex: a process that exits mid-turn ends the turn with a fatal error", async () => {
  const server = appServer();
  const executor = executorFor(server.spawn);
  const { events } = await startedTurn(server, executor);

  server.child.send(textDelta("partial"));
  server.child.exit();

  const received = await events;
  assert.equal(received[0]?.type, "text");
  const last = received.at(-1);
  assert.equal(last?.type, "error");
  assert.equal(last?.type === "error" && last.fatal, true);
  assert.equal(last?.type === "error" && last.error.code, "PROCESS_EXITED");
  await executor.close();
});

test("codex: a line cut off by the exit is reported, not parsed", async () => {
  const server = appServer();
  const executor = executorFor(server.spawn);
  const { events } = await startedTurn(server, executor);

  server.child.write(JSON.stringify(textDelta("never finished")).slice(0, 30));
  server.child.exit();

  const received = await events;
  assert.equal(received.some((event) => event.type === "text"), false);
  assert.equal(received.some((event) => event.type === "error" && event.error.code === "PROTOCOL_INCOMPLETE_LINE"), true);
  assert.equal(received.at(-1)?.type === "error" && (received.at(-1) as { fatal: boolean }).fatal, true);
  await executor.close();
});

test("codex: a malformed line mid-turn is a non-fatal error and the turn continues", async () => {
  const server = appServer();
  const executor = executorFor(server.spawn);
  const { events } = await startedTurn(server, executor);

  server.child.write("{not json\n");
  server.child.send(textDelta("after"));
  server.child.send(turnCompleted);

  const received = await events;
  assert.deepEqual(received.map((event) => event.type), ["error", "text", "done"]);
  assert.equal(received[0]?.type === "error" && received[0].fatal, false);
  assert.equal(received[0]?.type === "error" && received[0].error.code, "PROTOCOL_MALFORMED_JSON");
  // The provider's bytes are never echoed back into the error.
  assert.doesNotMatch(JSON.stringify(received[0]), /not json/);
  await executor.close();
});

test("codex: unknown notifications and unknown item types are ignored", async () => {
  const server = appServer();
  const executor = executorFor(server.spawn);
  const { events } = await startedTurn(server, executor);

  server.child.send(notification("thread/tokenUsage/updated", { usage: { total: 12 } }));
  server.child.send(notification("item/started", { item: { id: "item_x", type: "somethingNew", status: "inProgress" } }));
  server.child.send({ method: "item/agentMessage/delta" });
  server.child.send(textDelta("kept"));
  server.child.send(turnCompleted);

  const received = await events;
  assert.deepEqual(received.map((event) => event.type), ["text", "done"]);
  await executor.close();
});

test("codex: a repeated turn completion and repeated approval request each take effect once", async () => {
  const server = appServer();
  const approvals: RuntimeApprovalRequest[] = [];
  const executor = executorFor(server.spawn, (request) => {
    approvals.push(request);
    return "accept";
  });
  const { events } = await startedTurn(server, executor);

  const approval = {
    id: 99,
    method: "item/commandExecution/requestApproval",
    params: { threadId: THREAD, turnId: TURN, itemId: "cmd_1", command: "npm test", cwd: "/workspace/fixture" },
  };
  server.child.send(approval);
  server.child.send(approval);
  await new Promise((resolve) => setTimeout(resolve, 20));
  server.child.send(turnCompleted);
  server.child.send(turnCompleted);

  const received = await events;
  assert.equal(approvals.length, 1);
  assert.equal(received.filter((event) => event.type === "approval").length, 1);
  assert.equal(received.filter((event) => event.type === "done").length, 1);
  const responses = server.requests.filter((request) => request.id === 99);
  assert.equal(responses.length, 1);
  assert.deepEqual(responses[0]?.result, { decision: "accept" });
  await executor.close();
});

test("codex: a file change's approval names the files the change touches", async () => {
  // The approval request carries only the item id; without the item announced
  // before it, the card asked to approve an empty command (seen live).
  const server = appServer();
  const approvals: RuntimeApprovalRequest[] = [];
  const executor = executorFor(server.spawn, (request) => {
    approvals.push(request);
    return "accept";
  });
  const { events } = await startedTurn(server, executor);

  // The shapes Codex sent in the 2026-10-02 live run.
  server.child.send(notification("item/started", {
    item: {
      type: "fileChange",
      id: "exec_1",
      status: "inProgress",
      changes: [
        { path: "/workspace/hello.txt", kind: { type: "add" }, diff: "hello\n" },
        { path: "/workspace/README.md", kind: { type: "update", move_path: null }, diff: "@@ -1 +1,2 @@\n # App\n+Files: hello.txt\n" },
        { path: "/workspace/old.md", kind: { type: "update", move_path: "/workspace/new.md" }, diff: "" },
      ],
    },
  }));
  server.child.send({
    id: 7,
    method: "item/fileChange/requestApproval",
    params: { threadId: THREAD, turnId: TURN, itemId: "exec_1", reason: null, grantRoot: null },
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  server.child.send(turnCompleted);
  await events;

  assert.equal(approvals.length, 1);
  assert.equal(approvals[0]?.kind, "file_change");
  assert.deepEqual(approvals[0]?.files, [
    { path: "/workspace/hello.txt", kind: "add", diff: "hello\n" },
    { path: "/workspace/README.md", kind: "update", diff: "@@ -1 +1,2 @@\n # App\n+Files: hello.txt\n" },
    { path: "/workspace/old.md", kind: "update", movePath: "/workspace/new.md", diff: "" },
  ]);
  await executor.close();
});

test("codex: a file change approval without a known item has no file list, and a command approval never has one", async () => {
  const server = appServer();
  const approvals: RuntimeApprovalRequest[] = [];
  const executor = executorFor(server.spawn, (request) => {
    approvals.push(request);
    return "accept";
  });
  const { events } = await startedTurn(server, executor);

  server.child.send({
    id: 8,
    method: "item/fileChange/requestApproval",
    params: { threadId: THREAD, turnId: TURN, itemId: "exec_unknown" },
  });
  server.child.send({
    id: 9,
    method: "item/commandExecution/requestApproval",
    params: { threadId: THREAD, turnId: TURN, itemId: "cmd_1", command: "npm test" },
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  server.child.send(turnCompleted);
  await events;

  assert.deepEqual(approvals.map((approval) => [approval.kind, approval.files]), [["file_change", undefined], ["command", undefined]]);
  await executor.close();
});

test("codex: a thread in a workspace may write there and asks before commands, whatever the user's config", async () => {
  // Without these, a folder Codex does not trust started read-only: edits
  // failed and nothing was asked (seen in the live smoke run).
  const server = appServer();
  const executor = executorFor(server.spawn);
  const events = collect(executor.startTurn({ prompt: "fixture", cwd: "/workspace" }));
  while (!server.requests.some((request) => request.method === "turn/start")) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  server.child.send(turnCompleted);
  await events;

  const start = server.requests.find((request) => request.method === "thread/start");
  assert.deepEqual(start?.params, { sandbox: "workspace-write", approvalPolicy: "untrusted", cwd: "/workspace" });
  await executor.close();
});

/** An executor with short silence limits, so a timeout is reached in a test. */
function impatientExecutor(
  server: ReturnType<typeof appServer>,
  limits: { turnTimeoutMs: number; startTimeoutMs: number },
  approvalHandler?: (request: RuntimeApprovalRequest) => Promise<"accept" | "decline">,
): CodexRuntimeExecutor {
  return new CodexRuntimeExecutor({
    executable: "codex",
    transport: new CodexAppServerTransport({ executable: "codex", spawn: server.spawn }),
    approvalHandler,
    ...limits,
  });
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("codex: a turn that keeps producing output outlives the silence limit", async () => {
  const server = appServer();
  const executor = impatientExecutor(server, { turnTimeoutMs: 120, startTimeoutMs: 120 });
  const { events } = await startedTurn(server, executor);

  // Seven chunks 50 ms apart run for ~350 ms, three times the limit.
  for (let i = 0; i < 7; i += 1) {
    server.child.send(textDelta(`part ${i} `));
    await pause(50);
  }
  server.child.send(turnCompleted);

  const received = await events;
  assert.equal(received.some((event) => event.type === "error"), false);
  const last = received.at(-1);
  assert.equal(last?.type === "done" && last.status, "completed");
  await executor.close();
});

test("codex: a turn that goes quiet after it started is stopped, and says it was silence", async () => {
  const server = appServer();
  const executor = impatientExecutor(server, { turnTimeoutMs: 80, startTimeoutMs: 5_000 });
  const { events } = await startedTurn(server, executor);

  server.child.send(textDelta("partial"));

  const received = await events;
  const error = received.find((event) => event.type === "error");
  assert.equal(error?.type === "error" && error.error.code, "TURN_TIMEOUT");
  assert.match(error?.type === "error" ? error.error.message : "", /turn timed out: nothing came back/);
  await executor.close();
});

test("codex: a turn with no output yet gets the longer start limit", async () => {
  const server = appServer();
  const executor = impatientExecutor(server, { turnTimeoutMs: 60, startTimeoutMs: 400 });
  const { events } = await startedTurn(server, executor);

  // Longer than the silence limit, shorter than the start limit: the model is still thinking.
  await pause(200);
  server.child.send(textDelta("late answer"));
  server.child.send(turnCompleted);

  const received = await events;
  assert.equal(received.some((event) => event.type === "error"), false);
  await executor.close();
});

test("codex: a turn with no output at all times out as a failed start", async () => {
  const server = appServer();
  const executor = impatientExecutor(server, { turnTimeoutMs: 5_000, startTimeoutMs: 80 });
  const { events } = await startedTurn(server, executor);

  const received = await events;
  const error = received.find((event) => event.type === "error");
  assert.match(error?.type === "error" ? error.error.message : "", /turn timed out: no first answer/);
  await executor.close();
});

test("codex: waiting for the user's approval does not count as silence", async () => {
  const server = appServer();
  const executor = impatientExecutor(server, { turnTimeoutMs: 80, startTimeoutMs: 5_000 }, async () => {
    await pause(250);
    return "accept";
  });
  const { events } = await startedTurn(server, executor);

  server.child.send(textDelta("working"));
  server.child.send({
    id: 41,
    method: "item/commandExecution/requestApproval",
    params: { threadId: THREAD, turnId: TURN, itemId: "cmd_1", command: "npm test", cwd: "/workspace/fixture" },
  });
  await pause(320);
  server.child.send(turnCompleted);

  const received = await events;
  assert.equal(received.some((event) => event.type === "error"), false);
  assert.deepEqual(server.requests.find((request) => request.id === 41)?.result, { decision: "accept" });
  await executor.close();
});
