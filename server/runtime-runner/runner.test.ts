import { strict as assert } from "node:assert";
import test from "node:test";

import type { RuntimeDetection } from "../runtimes/types.ts";
import type {
  RuntimeEvent,
  RuntimeExecutor,
  RuntimeTurnRequest,
} from "../runtimes/execution/types.ts";
import type { AntigravityEvent, AntigravityExecutionHandle } from "../runtimes/execution/antigravity.ts";
import type { ClaudeSdkQuery, ClaudeSdkQueryOptions } from "../runtimes/execution/claude.ts";
import { createRuntimeRunner, createRuntimeRunnerAsync, type ClaudeSdkModule } from "./index.ts";

const detection: RuntimeDetection = {
  runtime: "codex",
  status: "ready",
  authStatus: "authenticated",
  binaryPath: "/fixture/codex",
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

class FixtureExecutor implements RuntimeExecutor {
  readonly requests: RuntimeTurnRequest[] = [];
  readonly events: RuntimeEvent[] = [{
    type: "done",
    status: "completed",
    threadId: "thread_fixture",
    turnId: "turn_fixture",
    error: null,
  }];

  startTurn(request: RuntimeTurnRequest): AsyncIterable<RuntimeEvent> {
    this.requests.push(request);
    return this.stream();
  }

  resumeTurn(request: RuntimeTurnRequest & { threadId: string }): AsyncIterable<RuntimeEvent> {
    this.requests.push(request);
    return this.stream();
  }

  private async *stream(): AsyncIterable<RuntimeEvent> {
    yield* this.events;
  }

  async interrupt(): Promise<void> {}
  async close(): Promise<void> {}
}

function detectionFor(runtime: "claude" | "antigravity"): RuntimeDetection {
  return { ...detection, runtime, binaryPath: `/fixture/${runtime}` };
}

class ClaudeQueryFixture implements ClaudeSdkQuery {
  readonly options: ClaudeSdkQueryOptions;
  interrupted = false;
  closed = false;

  constructor(options: ClaudeSdkQueryOptions) {
    this.options = options;
  }

  async *[Symbol.asyncIterator](): AsyncIterator<unknown> {
    yield {
      type: "stream_event",
      event: { type: "content_block_delta", delta: { type: "text_delta", text: "hello" } },
    };
    yield { type: "result", subtype: "success", session_id: "claude_session_fixture", result: "hello" };
  }

  async interrupt(): Promise<void> { this.interrupted = true; }
  async close(): Promise<void> { this.closed = true; }
}

class AntigravityFixture implements AntigravityExecutionHandle {
  readonly args: readonly string[] = [];
  readonly result = Promise.resolve({
    type: "result" as const,
    conversationId: "agy_session_fixture",
    status: "completed" as const,
    providerStatus: "SUCCESS",
    response: "",
  });
  readonly options: Record<string, unknown>;

  constructor(options: Record<string, unknown>) {
    this.options = options;
  }

  async *[Symbol.asyncIterator](): AsyncIterator<AntigravityEvent> {
    yield { type: "session_started", conversationId: "agy_session_fixture", cwd: "/fixture", model: null, permissionMode: null };
    yield { type: "tool_done", id: "tool_fixture", conversationId: "agy_session_fixture", stepIndex: 1, tool: "Bash", result: "denied", isError: true, denied: true };
    yield { type: "result", conversationId: "agy_session_fixture", status: "completed", providerStatus: "SUCCESS", response: "", error: undefined };
  }

  async interrupt(): Promise<void> {}
  async close(): Promise<void> {}
  sendPrompt(_prompt: string): void {}
}

test("runtime runner injects Codex and omits inherited overrides", async () => {
  const executor = new FixtureExecutor();
  const result = createRuntimeRunner({
    runtime: "codex",
    prompt: "fixture prompt",
    model: "inherit",
    effort: "inherit",
    cwd: "/fixture/workspace",
    detection,
    signal: new AbortController().signal,
    dependencies: {
      createCodexExecutor: (options) => {
        assert.equal(options.executable, "/fixture/codex");
        assert.equal(options.cwd, "/fixture/workspace");
        return executor;
      },
    },
  });

  const events: RuntimeEvent[] = [];
  for await (const event of result.events) events.push(event);
  assert.equal(events[0]?.type, "done");
  assert.equal(executor.requests[0]?.prompt, "fixture prompt");
  assert.equal(executor.requests[0]?.model, undefined);
  assert.equal(executor.requests[0]?.effort, undefined);
});

test("runtime runner resumes a supplied external Codex thread", () => {
  const executor = new FixtureExecutor();
  createRuntimeRunner({
    runtime: "codex",
    prompt: "follow-up",
    externalSessionId: "thread_existing",
    detection,
    signal: new AbortController().signal,
    dependencies: { createCodexExecutor: () => executor },
  });
  assert.equal(executor.requests[0]?.threadId, "thread_existing");
});

test("runtime runner loads Claude through an injected SDK and omits inherited selections", async () => {
  let query: ClaudeQueryFixture | null = null;
  const sdk: ClaudeSdkModule = {
    query: ({ options }) => {
      query = new ClaudeQueryFixture(options as ClaudeSdkQueryOptions);
      return query;
    },
  };
  const result = await createRuntimeRunnerAsync({
    runtime: "claude",
    prompt: "hello Claude",
    model: "inherit",
    effort: "inherit",
    detection: detectionFor("claude"),
    signal: new AbortController().signal,
    dependencies: { createCodexExecutor: () => new FixtureExecutor(), loadClaudeSdk: () => sdk },
  });
  const events: RuntimeEvent[] = [];
  for await (const event of result.events) events.push(event);
  assert.equal(events.some((event) => event.type === "text" && event.text === "hello"), true);
  assert.equal(events.find((event) => event.type === "done")?.status, "completed");
  assert.equal(query?.options.model, undefined);
  assert.equal(query?.options.effort, undefined);
});

test("runtime runner maps AGY soft permission denial to a failed completion", async () => {
  let fixture: AntigravityFixture | null = null;
  const result = createRuntimeRunner({
    runtime: "antigravity",
    prompt: "run fixture",
    model: "inherit",
    effort: "inherit",
    detection: detectionFor("antigravity"),
    signal: new AbortController().signal,
    dependencies: {
      createCodexExecutor: () => new FixtureExecutor(),
      createAntigravityExecution: (options) => {
        fixture = new AntigravityFixture(options as Record<string, unknown>);
        return fixture;
      },
    },
  });
  const events: RuntimeEvent[] = [];
  for await (const event of result.events) events.push(event);
  assert.equal(events.find((event) => event.type === "done")?.status, "failed");
  assert.equal((fixture?.options).model, undefined);
  assert.equal((fixture?.options).effort, undefined);
});

test("runtime runner passes a chosen Claude model and effort to the SDK", async () => {
  let query: ClaudeQueryFixture | null = null;
  const sdk: ClaudeSdkModule = {
    query: ({ options }) => {
      query = new ClaudeQueryFixture(options as ClaudeSdkQueryOptions);
      return query;
    },
  };
  const result = await createRuntimeRunnerAsync({
    runtime: "claude",
    prompt: "hello Claude",
    model: "claude-fixture",
    effort: "high",
    detection: detectionFor("claude"),
    signal: new AbortController().signal,
    dependencies: { createCodexExecutor: () => new FixtureExecutor(), loadClaudeSdk: () => sdk },
  });
  for await (const _event of result.events) { /* drain */ }
  assert.equal(query?.options.model, "claude-fixture");
  assert.equal(query?.options.effort, "high");
});

test("runtime runner isolates Claude from the user's settings only when asked", async () => {
  const queries: ClaudeQueryFixture[] = [];
  const sdk: ClaudeSdkModule = {
    query: ({ options }) => {
      const query = new ClaudeQueryFixture(options as ClaudeSdkQueryOptions);
      queries.push(query);
      return query;
    },
  };
  for (const isolateSettings of [true, false]) {
    const result = await createRuntimeRunnerAsync({
      runtime: "claude",
      prompt: "hello Claude",
      detection: detectionFor("claude"),
      signal: new AbortController().signal,
      dependencies: { createCodexExecutor: () => new FixtureExecutor(), loadClaudeSdk: () => sdk },
      isolateSettings,
    });
    for await (const _event of result.events) { /* drain */ }
  }
  assert.deepEqual(queries[0]?.options.settingSources, []);
  assert.equal(queries[1]?.options.settingSources, undefined);
});

test("runtime runner passes a chosen Antigravity model and effort to the CLI", async () => {
  let fixture: AntigravityFixture | null = null;
  const result = createRuntimeRunner({
    runtime: "antigravity",
    prompt: "run fixture",
    model: "gemini-fixture",
    effort: "low",
    detection: detectionFor("antigravity"),
    signal: new AbortController().signal,
    dependencies: {
      createCodexExecutor: () => new FixtureExecutor(),
      createAntigravityExecution: (options) => {
        fixture = new AntigravityFixture(options as Record<string, unknown>);
        return fixture;
      },
    },
  });
  for await (const _event of result.events) { /* drain */ }
  assert.equal((fixture?.options).model, "gemini-fixture");
  assert.equal((fixture?.options).effort, "low");
});
