import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import {
  AntigravityStreamParser,
  buildAntigravityArgs,
  parseAntigravityJsonLine,
  startAntigravityExecution,
  type AntigravityChild,
} from "./antigravity.ts";

test("builds stream args and omits inherited model/effort", () => {
  assert.deepEqual(buildAntigravityArgs({ model: "inherit", effort: null }), [
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
  ]);
  assert.deepEqual(buildAntigravityArgs({
    model: "gemini-2.5-pro",
    effort: "high",
    conversationId: "resume-1",
  }), [
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--model",
    "gemini-2.5-pro",
    "--effort",
    "high",
    "--conversation",
    "resume-1",
  ]);
});

test("normalizes documented init, assistant, tool, and result events", async () => {
  const fixture = await readFile(new URL("./antigravity-stream.fixture.jsonl", import.meta.url), "utf8");
  const parser = new AntigravityStreamParser();
  const events = parser.push(fixture.slice(0, 97)).concat(parser.push(fixture.slice(97))).concat(parser.end());
  assert.equal(events.find((event) => event.type === "session_started")?.conversationId, "agy-conversation-1");
  assert.equal(events.find((event) => event.type === "assistant")?.type, "assistant");
  const toolStart = events.find((event) => event.type === "tool_start");
  assert.equal(toolStart?.type, "tool_start");
  if (toolStart?.type === "tool_start") assert.equal(toolStart.tool, "run_command");
  const toolDone = events.find((event) => event.type === "tool_done");
  assert.equal(toolDone?.type, "tool_done");
  if (toolDone?.type === "tool_done") assert.equal(toolDone.isError, false);
  const result = events.find((event) => event.type === "result");
  assert.equal(result?.type, "result");
  if (result?.type === "result") {
    assert.equal(result.status, "completed");
    assert.equal(result.response, "Done.\n");
    assert.equal(result.usage?.totalTokens, 16);
  }
});

test("reports invalid JSON and output limits without echoing provider output", () => {
  const invalid = parseAntigravityJsonLine("{not-json}");
  assert.equal(invalid[0]?.type, "error");
  if (invalid[0]?.type === "error") {
    assert.equal(invalid[0].error.code, "AGY_PROTOCOL_ERROR");
    assert.equal(invalid[0].error.message.includes("not-json"), false);
  }
  const limited = new AntigravityStreamParser({ maxLineBytes: 8 });
  const events = limited.push("{\"event\":\"init\"}");
  assert.equal(events[0]?.type, "error");
  if (events[0]?.type === "error") assert.equal(events[0].error.code, "AGY_OUTPUT_LIMIT");
});

test("spawns safely, sends stream prompt, and resolves a normalized result", async () => {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const writes: string[] = [];
  let killed: string | undefined;
  let closeListener: ((code: number | null, signal: NodeJS.Signals | null) => void) | undefined;
  const child = {
    stdin: {
      write(data: string) { writes.push(data); return true; },
      end() { return undefined; },
      on() { return this; },
    },
    stdout,
    stderr,
    once(event: "error" | "close", listener: (...args: any[]) => void) {
      if (event === "close") closeListener = listener;
      return this;
    },
    kill(signal?: NodeJS.Signals) { killed = signal; return true; },
  };
  const run = startAntigravityExecution({
    prompt: "Reply with one word.",
    cwd: "/workspace/project",
    model: "inherit",
    effort: "inherit",
    spawn(command, args, options) {
      assert.equal(command, "agy");
      assert.equal(options.shell, false);
      assert.deepEqual(args, ["--input-format", "stream-json", "--output-format", "stream-json"]);
      return child;
    },
  });
  assert.deepEqual(JSON.parse(writes[0]), {
    event: "user",
    message: { content: "Reply with one word." },
  });
  const streamed: string[] = [];
  const streamFinished = (async () => {
    for await (const event of run) streamed.push(event.type);
  })();
  stdout.write("{\"event\":\"result\",\"result\":{\"conversation_id\":\"c1\",\"status\":\"SUCCESS\",\"response\":\"ok\"}}\n");
  const result = await run.result;
  assert.equal(result.status, "completed");
  assert.equal(result.response, "ok");
  await Promise.race([
    streamFinished,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("result did not close event stream")), 100)),
  ]);
  assert.deepEqual(streamed, ["result"]);
  const closing = run.close();
  closeListener?.(0, null);
  await closing;
  assert.equal(killed, "SIGTERM");
});

test("a CLI that stopped reading its stdin fails the run instead of crashing Undagi", async () => {
  let child: ChildProcess | undefined;
  const run = startAntigravityExecution({
    spawn(_command, _args, options) {
      // Closes its stdin, says it is ready, and stays alive, so the prompt write gets EPIPE.
      child = spawn(process.execPath, ["-e", "require('fs').closeSync(0); process.stderr.write('ready'); setTimeout(() => {}, 5000)"], options);
      return child as unknown as AntigravityChild;
    },
  });
  await new Promise((resolve) => child?.stderr?.once("data", resolve));
  run.sendPrompt("Reply with one word.");
  const result = await run.result;
  assert.equal(result.status, "failed");
  assert.equal(result.error?.code, "AGY_PROCESS_EXITED");
  await run.close();
});

test("a failed result names the fix when the cause is known and keeps AGY's words otherwise", () => {
  const failed = (message: string) => {
    const [event] = parseAntigravityJsonLine(JSON.stringify({
      event: "result",
      result: { conversation_id: "agy-conversation-1", status: "FAILED", error: { message } },
    }));
    assert.equal(event?.type, "result");
    return event?.type === "result" ? event.error : undefined;
  };

  const signedOut = failed("User is not logged in.");
  assert.equal(signedOut?.code, "AGY_AUTH_REQUIRED");
  assert.match(signedOut?.message ?? "", /Run `agy` in a terminal and sign in/);

  const other = failed("Workspace is busy.");
  assert.equal(other?.code, "AGY_PROCESS_ERROR");
  assert.equal(other?.message, "Workspace is busy.");
});
