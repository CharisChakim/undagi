// Copyright (c) 2026 Charis Chakim - Undagi (https://github.com/CharisChakim/undagi)
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { strict as assert } from "node:assert";
import { PassThrough } from "node:stream";
import test from "node:test";

import type { RuntimeDetection } from "../runtimes/types.ts";
import type { RuntimeEvent, RuntimeExecutor } from "../runtimes/execution/types.ts";
import type { ClaudeSdkQuery, ClaudeSdkQueryOptions } from "../runtimes/execution/claude.ts";
import { startAntigravityExecution } from "../runtimes/execution/antigravity.ts";
import { createRuntimeRunner, createRuntimeRunnerAsync, type ClaudeSdkModule } from "./index.ts";

// Contract tests for broken provider streams: cut off, repeated, malformed,
// and unknown events, as the runner hands them to the chat route.

function detectionFor(runtime: "claude" | "antigravity"): RuntimeDetection {
  return {
    runtime,
    status: "ready",
    authStatus: "authenticated",
    binaryPath: `/fixture/${runtime}`,
    version: "fixture",
    checkedAt: new Date(0).toISOString(),
    capabilities: {
      structuredOutput: "unknown",
      toolUse: "supported",
      approval: "supported",
      resume: "supported",
      interrupt: "supported",
      usage: "unknown",
      streaming: "supported",
    },
    catalog: null,
    diagnostic: null,
  };
}

const unusedCodex = (): RuntimeExecutor => { throw new Error("Codex is not part of these tests."); };

async function collect(events: AsyncIterable<RuntimeEvent>, withinMs = 2_000): Promise<RuntimeEvent[]> {
  const received: RuntimeEvent[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`stream still open after ${withinMs}ms: ${JSON.stringify(received)}`)), withinMs);
  });
  try {
    return await Promise.race([
      (async () => {
        for await (const event of events) received.push(event);
        return received;
      })(),
      deadline,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

const fatal = (event: RuntimeEvent | undefined) => event?.type === "error" && event.fatal;
const code = (event: RuntimeEvent | undefined) => event?.type === "error" ? event.error.code : event?.type === "done" ? event.error?.code : undefined;

// --- Claude ------------------------------------------------------------------

const SESSION = "claude_session_fixture";
const delta = (text: string) => ({
  type: "stream_event",
  session_id: SESSION,
  event: { type: "content_block_delta", delta: { type: "text_delta", text } },
});
const success = { type: "result", subtype: "success", session_id: SESSION, result: "ok" };

async function claudeTurn(script: () => AsyncGenerator<unknown>, signal = new AbortController().signal): Promise<RuntimeEvent[]> {
  const sdk: ClaudeSdkModule = {
    query: () => {
      const query: ClaudeSdkQuery = {
        [Symbol.asyncIterator]: script,
        interrupt: async () => {},
        close: async () => {},
      };
      return query;
    },
  };
  const runner = await createRuntimeRunnerAsync({
    runtime: "claude",
    prompt: "fixture",
    detection: detectionFor("claude"),
    signal,
    dependencies: { createCodexExecutor: unusedCodex, loadClaudeSdk: () => sdk },
  });
  return collect(runner.events);
}

test("claude: a stream that ends before its result is a fatal error, not a silent end", async () => {
  const events = await claudeTurn(async function* () {
    yield delta("partial");
  });

  assert.equal(events[0]?.type, "text");
  assert.equal(events.some((event) => event.type === "done"), false);
  assert.equal(fatal(events.at(-1)), true);
  assert.equal(code(events.at(-1)), "CLAUDE_RESULT_MISSING");
});

test("claude: a stream that ends because the run was stopped is not reported as missing a result", async () => {
  const stop = new AbortController();
  const events = await claudeTurn(async function* () {
    yield delta("partial");
    stop.abort();
  }, stop.signal);

  assert.equal(events.some((event) => code(event) === "CLAUDE_RESULT_MISSING"), false);
});

test("claude: an SDK that throws mid-stream keeps what arrived and ends with a fatal error", async () => {
  const events = await claudeTurn(async function* () {
    yield delta("before");
    throw new Error("socket hang up");
  });

  assert.equal(events[0]?.type, "text");
  assert.equal(fatal(events.at(-1)), true);
  assert.equal(code(events.at(-1)), "SDK_ERROR");
});

test("claude: malformed messages are non-fatal and the turn still completes", async () => {
  const events = await claudeTurn(async function* () {
    yield null;
    yield { no: "type" };
    yield { type: "stream_event", session_id: SESSION };
    yield delta("after");
    yield success;
  });

  const errors = events.filter((event) => event.type === "error");
  assert.equal(errors.length, 3);
  assert.equal(errors.every((event) => !fatal(event) && code(event) === "MALFORMED_EVENT"), true);
  assert.equal(events.find((event) => event.type === "done")?.type === "done"
    && (events.find((event) => event.type === "done") as { status: string }).status, "completed");
});

test("claude: unknown message types are ignored", async () => {
  const events = await claudeTurn(async function* () {
    yield { type: "ping" };
    yield { type: "something_the_sdk_adds_later", payload: { any: true } };
    yield delta("kept");
    yield success;
  });

  assert.deepEqual(events.map((event) => event.type), ["text", "done"]);
});

test("claude: a repeated result produces one done", async () => {
  const events = await claudeTurn(async function* () {
    yield delta("once");
    yield success;
    yield success;
  });

  assert.equal(events.filter((event) => event.type === "done").length, 1);
  assert.equal(events.filter((event) => event.type === "text").length, 1);
});

test("claude: one tool call is one start and one result, whatever the SDK repeats", async () => {
  const stream = (event: unknown) => ({ type: "stream_event", session_id: SESSION, event });
  const toolUse = { type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "npm test" } };
  const events = await claudeTurn(async function* () {
    // The order the SDK sends with partial messages on: the streamed block,
    // its input deltas, the complete message, progress, then the result in
    // the next user message.
    yield stream({ type: "content_block_start", index: 1, content_block: { ...toolUse, input: {} } });
    yield stream({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "{\"command\":" } });
    yield stream({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "\"npm test\"}" } });
    yield { type: "assistant", session_id: SESSION, message: { id: "msg_1", content: [toolUse] } };
    yield { type: "tool_progress", tool_use_id: "toolu_1", tool_name: "Bash", elapsed_time_seconds: 3, session_id: SESSION };
    yield { type: "user", session_id: SESSION, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "76 pass", is_error: false }] } };
    yield success;
  });

  const tools = events.filter((event): event is Extract<RuntimeEvent, { type: "tool" }> => event.type === "tool" && event.tool !== "progress");
  assert.deepEqual(tools.map((event) => [event.tool, event.status, event.itemId]), [
    ["Bash", "start", "toolu_1"],
    ["Bash", "completed", "toolu_1"],
  ]);
  assert.deepEqual(tools[0]?.data, { command: "npm test" });
  // Evidence reads the command from the result, which alone does not name it.
  // A Bash result without an "Exit code" line succeeded.
  assert.deepEqual(tools[1]?.data, { input: { command: "npm test" }, output: "76 pass", exitCode: 0 });
});

test("claude: a failed tool result is reported as failed", async () => {
  const events = await claudeTurn(async function* () {
    yield { type: "assistant", session_id: SESSION, message: { id: "msg_1", content: [{ type: "tool_use", id: "toolu_2", name: "Bash", input: { command: "false" } }] } };
    yield { type: "user", session_id: SESSION, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_2", content: "exit 1", is_error: true }] } };
    yield success;
  });

  const result = events.find((event) => event.type === "tool" && event.status !== "start");
  assert.equal(result?.type === "tool" && result.status, "failed");
});

const claudeDone = (events: RuntimeEvent[]) => events.find((event) => event.type === "done") as Extract<RuntimeEvent, { type: "done" }> | undefined;

test("claude: an expired login fails the run and says how to sign in again", async () => {
  const sdkText = "Invalid API key · Please run /login";
  const events = await claudeTurn(async function* () {
    // What the SDK sends for a failed API call: an assistant message carrying
    // the error, then a result that is subtype "success" but is_error.
    yield { type: "assistant", session_id: SESSION, error: "authentication_failed", message: { id: "msg_1", content: [{ type: "text", text: sdkText }] } };
    yield { type: "result", subtype: "success", is_error: true, api_error_status: 401, session_id: SESSION, result: sdkText };
  });

  assert.equal(claudeDone(events)?.status, "failed");
  assert.equal(claudeDone(events)?.error?.code, "CLAUDE_AUTH_REQUIRED");
  assert.match(claudeDone(events)?.error?.message ?? "", /\/login/);
  // The SDK's error text is not shown as if Claude had replied with it.
  assert.equal(events.some((event) => event.type === "text"), false);
});

test("claude: a result that is_error is never a completed run", async () => {
  const events = await claudeTurn(async function* () {
    yield { type: "result", subtype: "success", is_error: true, api_error_status: 429, session_id: SESSION, result: "Rate limited" };
  });

  assert.equal(claudeDone(events)?.status, "failed");
  assert.equal(claudeDone(events)?.error?.code, "CLAUDE_RATE_LIMITED");
});

test("claude: a run stopped by its turn limit says so", async () => {
  const events = await claudeTurn(async function* () {
    yield delta("working");
    yield { type: "result", subtype: "error_max_turns", is_error: true, errors: [], session_id: SESSION };
  });

  assert.equal(claudeDone(events)?.error?.code, "CLAUDE_MAX_TURNS");
});

test("claude: an unrecognised failure passes on the SDK's own reason", async () => {
  const events = await claudeTurn(async function* () {
    yield { type: "result", subtype: "error_during_execution", is_error: true, errors: ["Hook failed: pre-commit exited 1"], session_id: SESSION };
  });

  assert.equal(claudeDone(events)?.error?.code, "CLAUDE_RESULT_ERROR");
  assert.equal(claudeDone(events)?.error?.message, "Hook failed: pre-commit exited 1");
});

// --- Antigravity ---------------------------------------------------------------

class AgyChild {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly signals: (NodeJS.Signals | undefined)[] = [];
  readonly stdin = { write: () => true, end: () => undefined, on: () => undefined };
  private closeListener: ((code: number | null, signal: NodeJS.Signals | null) => void) | undefined;

  once(event: "error" | "close", listener: (...args: any[]) => void): this {
    if (event === "close") this.closeListener = listener;
    return this;
  }

  kill(signal?: NodeJS.Signals): boolean {
    this.signals.push(signal);
    this.exit(null, signal ?? "SIGTERM");
    return true;
  }

  line(value: unknown): void {
    this.stdout.write(`${typeof value === "string" ? value : JSON.stringify(value)}\n`);
  }

  exit(code: number | null, signal: NodeJS.Signals | null = null): void {
    const listener = this.closeListener;
    this.closeListener = undefined;
    // Like a real child, close follows the end of its output streams.
    setImmediate(() => listener?.(code, signal));
  }
}

const init = { event: "init", conversation_id: "agy_c1", init: { cwd: "/workspace", model: "fixture" } };
const agyResult = { event: "result", result: { conversation_id: "agy_c1", status: "SUCCESS", response: "ok" } };

async function agyTurn(script: (child: AgyChild) => void): Promise<{ events: RuntimeEvent[]; child: AgyChild }> {
  const child = new AgyChild();
  const runner = createRuntimeRunner({
    runtime: "antigravity",
    prompt: "fixture",
    detection: detectionFor("antigravity"),
    signal: new AbortController().signal,
    dependencies: {
      createCodexExecutor: unusedCodex,
      createAntigravityExecution: (options) => startAntigravityExecution({ ...options, spawn: () => child }),
    },
  });
  const events = collect(runner.events);
  script(child);
  const received = await events;
  await runner.executor.close();
  return { events: received, child };
}

const doneOf = (events: RuntimeEvent[]) => events.find((event) => event.type === "done") as Extract<RuntimeEvent, { type: "done" }> | undefined;

test("antigravity: a CLI that exits mid-run without a result fails the run", async () => {
  const { events } = await agyTurn((child) => {
    child.line(init);
    child.exit(1);
  });

  assert.equal(doneOf(events)?.status, "failed");
  assert.equal(doneOf(events)?.error?.code, "AGY_PROCESS_EXITED");
});

test("antigravity: a CLI that exits cleanly without a result is not treated as done", async () => {
  const { events } = await agyTurn((child) => {
    child.line(init);
    child.exit(0);
  });

  assert.equal(doneOf(events)?.status, "failed");
  assert.equal(doneOf(events)?.error?.code, "AGY_RESULT_MISSING");
});

test("antigravity: a last line cut off by the exit fails the run instead of being guessed at", async () => {
  const { events } = await agyTurn((child) => {
    child.line(init);
    child.stdout.write(JSON.stringify(agyResult).slice(0, 25));
    child.exit(0);
  });

  assert.equal(doneOf(events)?.status, "failed");
  assert.equal(doneOf(events)?.error?.code, "AGY_PROTOCOL_ERROR");
});

test("antigravity: a malformed line stops the CLI and fails the run", async () => {
  // Unlike the Codex and Claude streams, AGY fails closed on a line it cannot
  // read: its stream-json output has no framing to resynchronise on.
  const { events, child } = await agyTurn((agy) => {
    agy.line(init);
    agy.line("{not json");
  });

  assert.equal(fatal(events.find((event) => event.type === "error")), true);
  assert.equal(doneOf(events)?.status, "failed");
  assert.equal(doneOf(events)?.error?.code, "AGY_PROTOCOL_ERROR");
  assert.equal(child.signals[0], "SIGTERM");
  assert.doesNotMatch(JSON.stringify(events), /not json/);
});

test("antigravity: an unknown event does not stop the run", async () => {
  const { events } = await agyTurn((child) => {
    child.line(init);
    child.line({ event: "something_new", something_new: { any: true } });
    child.line(agyResult);
  });

  assert.equal(events.some((event) => event.type === "error"), false);
  assert.equal(doneOf(events)?.status, "completed");
});

test("antigravity: a repeated result produces one done", async () => {
  const { events } = await agyTurn((child) => {
    child.line(init);
    child.line(agyResult);
    child.line(agyResult);
  });

  assert.equal(events.filter((event) => event.type === "done").length, 1);
  assert.equal(doneOf(events)?.status, "completed");
});

test("antigravity: a finished tool step keeps the command it started with", async () => {
  const step = (state: string, info: Record<string, unknown>) => ({
    event: "step_update",
    step_update: { conversation_id: "agy_c1", step_index: 2, state, step_type: "tool", tool_name: "run_command", tool_info: { name: "run_command", ...info } },
  });
  const { events } = await agyTurn((child) => {
    child.line(init);
    child.line(step("ACTIVE", { parameters: { CommandLine: "pwd" } }));
    child.line(step("DONE", { output: "/workspace\n" }));
    child.line(agyResult);
  });

  const finished = events.find((event) => event.type === "tool" && event.tool === "run_command" && event.status === "completed");
  assert.deepEqual(finished?.type === "tool" && finished.data, { input: { CommandLine: "pwd" }, output: "/workspace\n", command: "pwd" });
});

// Shapes below were seen in the live smoke run of September 2026.

test("antigravity: a tool headless mode refused fails the run as a permission denial", async () => {
  const step = (state: string, info: Record<string, unknown>) => ({
    event: "step_update",
    step_update: { conversation_id: "agy_c1", step_index: 2, state, step_type: "tool", tool_name: "run_command", tool_info: { name: "run_command", ...info } },
  });
  const { events } = await agyTurn((child) => {
    child.line(init);
    child.line(step("ACTIVE", { parameters: { CommandLine: "pwd" } }));
    // The refused step ends as ERROR, never DONE, and the result says SUCCESS.
    child.line(step("ERROR", {
      parameters: { CommandLine: "pwd" },
      error: { type: "TOOL_ERROR", message: "permission check failed for unsandboxed \"pwd\": user denied permission to run command" },
    }));
    child.line({ event: "result", result: { conversation_id: "agy_c1", status: "SUCCESS", response: "", denied_actions: [{ action: "command", display_name: "RunCommand" }] } });
  });

  const statuses = events.filter((event) => event.type === "tool" && event.tool === "run_command").map((event) => event.type === "tool" ? event.status : null);
  assert.deepEqual(statuses, ["started", "failed"]);
  assert.equal(doneOf(events)?.status, "failed");
  assert.equal(doneOf(events)?.error?.code, "AGY_PERMISSION_DENIED");
  assert.match(doneOf(events)?.error?.message ?? "", /permissions\.allow/);
});

test("antigravity: a result that lists denied actions is a denial even without a tool step", async () => {
  const { events } = await agyTurn((child) => {
    child.line(init);
    child.line({ event: "result", result: { conversation_id: "agy_c1", status: "SUCCESS", response: "", denied_actions: [{ action: "command" }] } });
  });

  assert.equal(doneOf(events)?.error?.code, "AGY_PERMISSION_DENIED");
});

test("claude: a Bash result carries the exit code its output starts with, and 0 when it succeeded", async () => {
  const events = await claudeTurn(async function* () {
    yield { type: "assistant", session_id: SESSION, message: { id: "msg_1", content: [
      { type: "tool_use", id: "toolu_ok", name: "Bash", input: { command: "ls" } },
      { type: "tool_use", id: "toolu_bad", name: "Bash", input: { command: "ls missing-dir" } },
      { type: "tool_use", id: "toolu_denied", name: "Bash", input: { command: "touch x" } },
    ] } };
    yield { type: "user", session_id: SESSION, message: { role: "user", content: [
      { type: "tool_result", tool_use_id: "toolu_ok", content: "README.md" },
      { type: "tool_result", tool_use_id: "toolu_bad", content: "Exit code 2\n/usr/bin/ls: cannot access 'missing-dir': No such file or directory", is_error: true },
      { type: "tool_result", tool_use_id: "toolu_denied", content: "Permission denied by Undagi.", is_error: true },
    ] } };
    yield success;
  });

  const exitCodes = events
    .filter((event) => event.type === "tool" && event.status !== "start")
    .map((event) => event.type === "tool" ? [event.itemId, (event.data as { exitCode?: number }).exitCode ?? null] : null);
  assert.deepEqual(exitCodes, [["toolu_ok", 0], ["toolu_bad", 2], ["toolu_denied", null]]);
});

test("claude: an approval card names the command or the file the tool acts on", async () => {
  const commands: Array<string | null> = [];
  const sdk: ClaudeSdkModule = {
    query: ({ options }) => {
      const { canUseTool } = options as ClaudeSdkQueryOptions;
      const query: ClaudeSdkQuery = {
        [Symbol.asyncIterator]: async function* () {
          await canUseTool("Bash", { command: "touch declined.txt" }, { toolUseID: "toolu_a" });
          await canUseTool("Write", { file_path: "/workspace/smoke.txt", content: "ok" }, { toolUseID: "toolu_b" });
          yield success;
        },
        interrupt: async () => {},
        close: async () => {},
      };
      return query;
    },
  };
  const runner = await createRuntimeRunnerAsync({
    runtime: "claude",
    prompt: "fixture",
    detection: detectionFor("claude"),
    signal: new AbortController().signal,
    approvalHandler: async (request) => {
      commands.push(request.command);
      return "accept" as const;
    },
    dependencies: { createCodexExecutor: unusedCodex, loadClaudeSdk: () => sdk },
  });
  await collect(runner.events);

  assert.deepEqual(commands, ["touch declined.txt", "Write /workspace/smoke.txt"]);
});

test("claude: an approval's working folder is the turn's cwd, never the SDK's blocked path", async () => {
  const requests: Array<{ cwd: string | null; blockedPath: unknown }> = [];
  const sdk: ClaudeSdkModule = {
    query: ({ options }) => {
      const { canUseTool } = options as ClaudeSdkQueryOptions;
      const query: ClaudeSdkQuery = {
        [Symbol.asyncIterator]: async function* () {
          // Claude reports the file its permission rule blocked, not a folder
          // (seen live as .../claude/declined.txt).
          await canUseTool("Bash", { command: "touch declined.txt" }, {
            toolUseID: "toolu_a",
            blockedPath: "/workspace/.claude/declined.txt",
          });
          yield success;
        },
        interrupt: async () => {},
        close: async () => {},
      };
      return query;
    },
  };
  const runner = await createRuntimeRunnerAsync({
    runtime: "claude",
    prompt: "fixture",
    cwd: "/workspace",
    detection: detectionFor("claude"),
    signal: new AbortController().signal,
    approvalHandler: async (request) => {
      requests.push({ cwd: request.cwd, blockedPath: (request.details as { blockedPath?: unknown } | undefined)?.blockedPath });
      return "accept" as const;
    },
    dependencies: { createCodexExecutor: unusedCodex, loadClaudeSdk: () => sdk },
  });
  await collect(runner.events);

  assert.deepEqual(requests, [{ cwd: "/workspace", blockedPath: "/workspace/.claude/declined.txt" }]);
});
