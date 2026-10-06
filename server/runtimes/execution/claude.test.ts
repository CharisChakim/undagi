// Copyright (c) 2026 Charis Chakim - Undagi (https://github.com/CharisChakim/undagi)
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  ClaudeExecutionAdapter,
  buildClaudeSdkOptions,
  carriedClaudeSettings,
  normalizeClaudeSdkMessage,
  type ClaudeSdkQuery,
  type ClaudeSdkQueryOptions,
} from "./claude.ts";
import {
  CLAUDE_ASSISTANT_TOOL_FIXTURE,
  CLAUDE_MALFORMED_FIXTURE,
  CLAUDE_RESULT_FIXTURE,
  CLAUDE_STREAM_TEXT_FIXTURE,
  CLAUDE_TOOL_PROGRESS_FIXTURE,
} from "./claude-fixtures.ts";

class FixtureQuery implements ClaudeSdkQuery {
  interrupted = false;
  closed = false;

  constructor(private readonly messages: readonly unknown[]) {}

  async *[Symbol.asyncIterator](): AsyncGenerator<unknown> {
    for (const message of this.messages) yield message;
  }

  async interrupt(): Promise<void> {
    this.interrupted = true;
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

function collect<T>(values: AsyncIterable<T>): Promise<T[]> {
  return (async () => {
    const output: T[] = [];
    for await (const value of values) output.push(value);
    return output;
  })();
}

test("Claude SDK options omit inherited settings and keep permissions enabled", () => {
  const inherited = buildClaudeSdkOptions({ cwd: "", model: "inherit", effort: undefined, resumeSessionId: null });
  assert.equal(inherited.cwd, undefined);
  assert.equal(inherited.model, undefined);
  assert.equal(inherited.effort, undefined);
  assert.equal(inherited.resume, undefined);
  assert.equal(inherited.includePartialMessages, true);
  assert.equal("permissionMode" in inherited, false);
  assert.equal("allowDangerouslySkipPermissions" in inherited, false);

  const selected = buildClaudeSdkOptions({
    cwd: "/workspace/fixture",
    model: "claude-sonnet",
    effort: "high",
    resumeSessionId: "session_fixture_1",
  });
  assert.equal(selected.cwd, "/workspace/fixture");
  assert.equal(selected.model, "claude-sonnet");
  assert.equal(selected.effort, "high");
  assert.equal(selected.resume, "session_fixture_1");
});

test("isolated Claude options read no settings file but keep the user's sign-in and model", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "undagi-claude-config-"));
  writeFileSync(path.join(dir, "settings.json"), JSON.stringify({
    apiKeyHelper: "/fixture/key-helper",
    env: { ANTHROPIC_BASE_URL: "https://gateway.example" },
    model: "claude-fixture",
    language: "Indonesian",
    hooks: { PreToolUse: [] },
  }));
  const previous = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = dir;
  try {
    const isolated = buildClaudeSdkOptions({ isolateSettings: true });
    assert.deepEqual(isolated.settingSources, []);
    assert.deepEqual(isolated.settings, {
      apiKeyHelper: "/fixture/key-helper",
      env: { ANTHROPIC_BASE_URL: "https://gateway.example" },
      model: "claude-fixture",
    });
    const shared = buildClaudeSdkOptions({});
    assert.equal("settingSources" in shared, false);
    assert.equal("settings" in shared, false);
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  }
  assert.equal(carriedClaudeSettings(path.join(dir, "missing")), undefined);
});

test("normalizes assistant, tool progress, result, and malformed messages", () => {
  const text = normalizeClaudeSdkMessage(CLAUDE_STREAM_TEXT_FIXTURE);
  assert.deepEqual(text, [{
    type: "assistant",
    messageId: null,
    sessionId: null,
    delta: "hello",
  }]);

  const assistant = normalizeClaudeSdkMessage(CLAUDE_ASSISTANT_TOOL_FIXTURE);
  assert.equal(assistant[0]?.type, "assistant");
  assert.equal(assistant[0]?.type === "assistant" ? assistant[0].sessionId : null, "session_fixture_1");
  assert.deepEqual(normalizeClaudeSdkMessage(CLAUDE_TOOL_PROGRESS_FIXTURE), [{
    type: "progress",
    phase: "tool",
    toolUseId: "tool_fixture_1",
    toolName: "Read",
    elapsedTimeSeconds: 0.25,
    data: { bytes: 42 },
  }]);
  assert.equal(normalizeClaudeSdkMessage(CLAUDE_RESULT_FIXTURE)[0]?.type, "result");
  assert.equal(normalizeClaudeSdkMessage(CLAUDE_MALFORMED_FIXTURE)[0]?.type, "error");
});

test("starts and streams a fixture session, exposing its native session ID", async () => {
  let receivedPrompt = "";
  let receivedOptions: ClaudeSdkQueryOptions | undefined;
  const query = new FixtureQuery([
    CLAUDE_STREAM_TEXT_FIXTURE,
    CLAUDE_ASSISTANT_TOOL_FIXTURE,
    CLAUDE_TOOL_PROGRESS_FIXTURE,
    CLAUDE_RESULT_FIXTURE,
  ]);
  const adapter = new ClaudeExecutionAdapter(({ prompt, options }) => {
    receivedPrompt = prompt;
    receivedOptions = options;
    return query;
  });
  const events = await collect(adapter.start({ prompt: "Read the fixture", cwd: "/workspace/fixture" }));

  assert.equal(receivedPrompt, "Read the fixture");
  assert.equal(receivedOptions?.cwd, "/workspace/fixture");
  assert.equal(receivedOptions?.model, undefined);
  assert.equal(events.filter((event) => event.type === "assistant").length, 2);
  assert.equal(events.some((event) => event.type === "tool"), true);
  assert.equal(events.some((event) => event.type === "progress"), true);
  assert.equal(events.some((event) => event.type === "result"), true);
  assert.equal(events[events.length - 1]?.type, "result");
});

test("resume forwards only the explicit native session ID", async () => {
  let options: ClaudeSdkQueryOptions | undefined;
  const adapter = new ClaudeExecutionAdapter(({ options: received }) => {
    options = received;
    return new FixtureQuery([CLAUDE_RESULT_FIXTURE]);
  });
  await collect(adapter.resume("session_fixture_1", { prompt: "Continue" }));
  assert.equal(options?.resume, "session_fixture_1");
  assert.equal(options?.cwd, undefined);
  assert.equal(options?.model, undefined);
  assert.equal(options?.effort, undefined);
});

test("approval and input callbacks decide native tool permission", async () => {
  const seen: string[] = [];
  const options = buildClaudeSdkOptions({}, {
    onApproval: async (request) => {
      seen.push(`approval:${request.toolName}`);
      return true;
    },
    onInput: async (request) => {
      seen.push(`input:${request.toolName}`);
      return { answers: { confirmed: true } };
    },
  });
  assert.deepEqual(await options.canUseTool("Read", { file_path: "README.md" }, { toolUseID: "tool_1" }), {
    behavior: "allow",
    updatedInput: { file_path: "README.md" },
  });
  assert.deepEqual(await options.canUseTool("AskUserQuestion", { questions: [] }, { toolUseID: "tool_2" }), {
    behavior: "allow",
    updatedInput: { confirmed: true },
  });
  assert.deepEqual(await options.canUseTool("Bash", { command: "rm -rf /" }, { toolUseID: "tool_3" }), {
    behavior: "allow",
    updatedInput: { command: "rm -rf /" },
  });
  assert.deepEqual(seen, ["approval:Read", "input:AskUserQuestion", "approval:Bash"]);

  const safeDefault = buildClaudeSdkOptions({});
  assert.deepEqual(await safeDefault.canUseTool("Bash", { command: "echo unsafe" }, {}), {
    behavior: "deny",
    message: "Permission denied by Undagi.",
  });
});

test("interrupt and close delegate to the SDK query", async () => {
  const query = new FixtureQuery([]);
  const adapter = new ClaudeExecutionAdapter(() => query);
  const run = adapter.start({ prompt: "stop" });
  await run.interrupt();
  await run.close();
  assert.equal(query.interrupted, true);
  assert.equal(query.closed, true);
});

test("factory and prompt failures are structured stream errors", async () => {
  const factoryRun = await collect(new ClaudeExecutionAdapter(() => {
    throw new Error("provider exploded");
  }).start({ prompt: "hello" }));
  assert.equal(factoryRun[0]?.type, "error");
  assert.equal(factoryRun[0]?.type === "error" ? factoryRun[0].error.code : null, "SDK_ERROR");

  const invalidRun = await collect(new ClaudeExecutionAdapter(() => new FixtureQuery([])).start({ prompt: "  " }));
  assert.equal(invalidRun[0]?.type, "error");
  assert.equal(invalidRun[0]?.type === "error" ? invalidRun[0].error.code : null, "INVALID_REQUEST");
});

test("drives the discovered binary instead of the SDK's vendored copy", async () => {
  let withPath: ClaudeSdkQueryOptions | undefined;
  let withoutPath: ClaudeSdkQueryOptions | undefined;

  const configured = new ClaudeExecutionAdapter({
    factory: ({ options }) => { withPath = options; return new FixtureQuery([CLAUDE_RESULT_FIXTURE]); },
    executablePath: "/usr/local/bin/claude",
  });
  await collect(configured.start({ prompt: "hi" }));

  // No discovered path must not become an empty string: the SDK treats that as
  // an explicit executable and would fail rather than fall back.
  const bare = new ClaudeExecutionAdapter({
    factory: ({ options }) => { withoutPath = options; return new FixtureQuery([CLAUDE_RESULT_FIXTURE]); },
    executablePath: null,
  });
  await collect(bare.start({ prompt: "hi" }));

  assert.equal(withPath?.pathToClaudeCodeExecutable, "/usr/local/bin/claude");
  assert.equal("pathToClaudeCodeExecutable" in (withoutPath ?? {}), false);
});

test("Claude runs without background tasks, which would outlive the turn's process", () => {
  // A killed background command's notice opened the next turn and closed the
  // permission channel before its first tool (seen in the live smoke run).
  const options = buildClaudeSdkOptions({ cwd: "/workspace", model: "inherit", effort: undefined, resumeSessionId: null });
  assert.equal(options.env?.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS, "1");
  assert.equal(options.env?.PATH, process.env.PATH);
});
