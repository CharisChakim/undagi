import assert from "node:assert/strict";
import fs from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { RuntimeDetection } from "../runtimes/types.ts";
import type {
  RuntimeApprovalHandler,
  RuntimeEvent,
  RuntimeExecutor,
  RuntimeTurnRequest,
} from "../runtimes/execution/types.ts";

// db.ts reads this when it is first imported, so everything that touches the
// database is loaded dynamically, after the data directory is disposable.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "undagi-runtime-agent-test-"));
process.env.UNDAGI_DATA_DIR = dataDir;

const express = (await import("express")).default;
const { db, saveSession } = await import("../../db.ts");
// Windows will not delete a database file that is still open.
process.on("exit", () => {
  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});
const { listRuns, listRunEvidence } = await import("../runs/store.ts");
const { loadConversationNotes, loadMessages } = await import("../agent/conversations.ts");
const { createRuntimeAgentRouter } = await import("./runtime-agent.ts");

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

const done: RuntimeEvent = {
  type: "done",
  status: "completed",
  threadId: "thread_fixture",
  turnId: "turn_fixture",
  error: null,
};

/**
 * Stands in for the provider. Each started turn is counted, because a second
 * turn is exactly the duplicate tool execution these tests guard against.
 */
class ProviderFixture {
  readonly turns: RuntimeTurnRequest[] = [];
  /** The folder each provider process was started in. */
  readonly cwds: Array<string | undefined> = [];
  interrupts = 0;
  approvalHandler: RuntimeApprovalHandler | undefined;
  private release: () => void = () => {};
  private readonly released = new Promise<void>((resolve) => { this.release = resolve; });
  private started: () => void = () => {};
  readonly firstTurnStarted = new Promise<void>((resolve) => { this.started = resolve; });

  constructor(private readonly script: (fixture: ProviderFixture) => AsyncGenerator<RuntimeEvent>) {}

  finish(): void {
    this.release();
  }

  waitUntilReleased(): Promise<void> {
    return this.released;
  }

  executor(): RuntimeExecutor {
    const stream = (request: RuntimeTurnRequest): AsyncIterable<RuntimeEvent> => {
      this.turns.push(request);
      this.started();
      return this.script(this);
    };
    return {
      startTurn: stream,
      resumeTurn: stream,
      interrupt: async () => { this.interrupts += 1; this.finish(); },
      close: async () => {},
    };
  }
}

async function withServer(
  provider: ProviderFixture,
  body: (url: string) => Promise<void>,
  discovered: RuntimeDetection = detection,
): Promise<void> {
  const app = express();
  app.use(express.json());
  app.use(createRuntimeAgentRouter({
    discover: async () => discovered,
    runnerDependencies: {
      createCodexExecutor: (options) => {
        provider.approvalHandler = options.approvalHandler;
        provider.cwds.push(options.cwd);
        return provider.executor();
      },
    },
  }));
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  try {
    await body(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

let counter = 0;
function project(workspaceRoot = fs.mkdtempSync(path.join(dataDir, "workspace-"))): { sessionId: string; taskId: string; workspaceRoot: string } {
  counter += 1;
  const sessionId = `session-${counter}`;
  const taskId = `task-${counter}`;
  saveSession({ id: sessionId, title: sessionId, workspaceRoot, tasks: [{ id: taskId, title: "Fixture task" }] });
  return { sessionId, taskId, workspaceRoot };
}

type SseEvent = Record<string, unknown> & { type: string };

async function chat(url: string, body: Record<string, unknown>): Promise<SseEvent[]> {
  const res = await fetch(`${url}/api/runtime-agent/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ runtime: "codex", message: "Do the task.", ...body }),
  });
  const raw = await res.text();
  return raw.split("\n\n")
    .map((chunk) => chunk.split("\n").find((line) => line.startsWith("data: ")))
    .filter((line): line is string => Boolean(line))
    .map((line) => JSON.parse(line.slice(6)) as SseEvent);
}

test("a repeated request with the same idempotency key does not start a second provider turn", async () => {
  const provider = new ProviderFixture(async function* (fixture) {
    yield { type: "text", text: "working", threadId: "thread_fixture", turnId: "turn_fixture", itemId: null };
    await fixture.waitUntilReleased();
    yield done;
  });
  const { sessionId, taskId } = project();

  await withServer(provider, async (url) => {
    const request = { sessionId, taskId, idempotencyKey: "double-click-1" };
    const first = chat(url, request);
    await provider.firstTurnStarted;

    // The duplicate arrives while the first turn is still streaming, which is
    // what a double-click or a client that re-sends after a reconnect does.
    const whileRunning = chat(url, request);
    await new Promise((resolve) => setTimeout(resolve, 100));
    provider.finish();
    const [original, followed] = await Promise.all([first, whileRunning]);
    const afterFinish = await chat(url, request);

    assert.equal(provider.turns.length, 1);
    assert.equal(listRuns({ taskId }).length, 1);
    for (const events of [original, followed, afterFinish]) {
      assert.equal(events.filter((event) => event.type === "done").length, 1);
      assert.equal(events.at(-1)?.type, "done");
      assert.equal(events.at(-1)?.runStatus, "completed");
      assert.equal(events.filter((event) => event.type === "text").length, 1);
    }
    assert.equal(new Set([...original, ...followed, ...afterFinish].map((event) => event.runId)).size, 1);
  });
});

test("replaying a finished run returns every stored event, not the first page", async () => {
  const provider = new ProviderFixture(async function* () {
    for (let index = 0; index < 150; index += 1) {
      yield { type: "text", text: `${index} `, threadId: "thread_fixture", turnId: "turn_fixture", itemId: null };
    }
    yield done;
  });
  const { sessionId, taskId } = project();

  await withServer(provider, async (url) => {
    const request = { sessionId, taskId, idempotencyKey: "long-run" };
    const original = await chat(url, request);
    const replayed = await chat(url, request);

    assert.equal(provider.turns.length, 1);
    assert.equal(original.filter((event) => event.type === "text").length, 150);
    assert.equal(replayed.filter((event) => event.type === "text").length, 150);
    assert.equal(replayed.filter((event) => event.type === "done").length, 1);
  });
});

test("stopping from the chat interrupts the provider turn and ends the run as interrupted", async () => {
  const provider = new ProviderFixture(async function* (fixture) {
    yield { type: "text", text: "working", threadId: "thread_fixture", turnId: "turn_fixture", itemId: null };
    await fixture.waitUntilReleased();
    yield { ...done, status: "interrupted" } as RuntimeEvent;
  });
  const { sessionId, taskId } = project();

  await withServer(provider, async (url) => {
    // The chat's Stop button aborts the request, as useAgentRun does.
    const stop = new AbortController();
    const res = await fetch(`${url}/api/runtime-agent/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ runtime: "codex", message: "Do the task.", sessionId, taskId, idempotencyKey: "stop-me" }),
      signal: stop.signal,
    });
    const reader = res.body!.getReader();
    await reader.read();
    await provider.firstTurnStarted;
    stop.abort();
    await reader.read().catch(() => undefined);

    let run = listRuns({ taskId })[0];
    for (let i = 0; i < 50 && run?.status === "running"; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      run = listRuns({ taskId })[0];
    }
    assert.equal(provider.interrupts > 0, true);
    assert.equal(run?.status, "interrupted");
  });
});

test("a runtime session that is new to a chat is told what was said before it", async () => {
  let run = 0;
  const provider = new ProviderFixture(async function* () {
    run += 1;
    const threadId = `thread_${run}`;
    yield { type: "text", text: `answer ${run}`, threadId, turnId: `turn_${run}`, itemId: null };
    yield { ...done, threadId, turnId: `turn_${run}` };
  });
  const conversationId = "conversation-switch";

  await withServer(provider, async (url) => {
    // First runtime session, then a second one in the same chat (as when the
    // user switches runtime), then back to the first.
    const firstEvents = await chat(url, { conversationId, message: "Use Postgres for storage.", idempotencyKey: "switch-1" });
    const secondEvents = await chat(url, { conversationId, message: "Add a users table.", idempotencyKey: "switch-2" });
    const thirdEvents = await chat(url, { conversationId, message: "Now add indexes.", externalSessionId: "thread_1", idempotencyKey: "switch-3" });

    // The chat is told when, and how much, earlier conversation was handed over.
    const carried = (events: SseEvent[]) => events.find((event) => event.type === "context_carried");
    assert.equal(carried(firstEvents), undefined);
    assert.deepEqual([carried(secondEvents)?.included, carried(secondEvents)?.omitted, carried(secondEvents)?.resumed], [2, 0, false]);
    assert.deepEqual([carried(thirdEvents)?.included, carried(thirdEvents)?.resumed], [2, true]);

    const [first, second, third] = provider.turns.map((turn) => turn.prompt);
    assert.doesNotMatch(first!, /<conversation_context>/);
    assert.match(second!, /User: Use Postgres for storage\.\n\nAssistant: answer 1/);
    assert.match(second!, /<user_request>\nAdd a users table\.\n<\/user_request>$/);
    // Back in the first session: only what it missed, not its own turn again.
    assert.match(third!, /User: Add a users table\.\n\nAssistant: answer 2/);
    assert.doesNotMatch(third!, /Use Postgres/);

    // The notes are kept, each after the user message of its turn, so a
    // reload shows them where they were.
    const notes = loadConversationNotes(conversationId);
    assert.deepEqual(notes.map((item) => [item.afterMessage, item.note.included, item.note.resumed]), [[2, 2, false], [4, 2, true]]);
    assert.equal((loadMessages(conversationId)[2].content[0] as { text: string }).text, "Add a users table.");
  });
});

test("a run started from a task card is asked to report its status; a plain chat is not", async () => {
  const provider = new ProviderFixture(async function* () {
    yield { type: "text", text: "ok", threadId: "thread_card", turnId: "turn_card", itemId: null };
    yield { ...done, threadId: "thread_card", turnId: "turn_card" };
  });
  const { sessionId, taskId } = project();

  await withServer(provider, async (url) => {
    await chat(url, { sessionId, taskId, idempotencyKey: "card-run" });
    await chat(url, { sessionId, taskId, language: "id", idempotencyKey: "card-run-id" });
    await chat(url, { sessionId, idempotencyKey: "plain-chat" });

    const [fromCard, fromCardId, plain] = provider.turns.map((turn) => turn.prompt);
    assert.match(fromCard!, /TASK_STATUS: done/);
    assert.match(fromCard!, /TASK_STATUS: blocked/);
    // The note follows the UI language the client sent; English when it sent none.
    assert.match(fromCard!, /Write the note in English/);
    assert.match(fromCardId!, /Write the note in Indonesian/);
    assert.doesNotMatch(plain!, /TASK_STATUS|Write the note in/);
  });
});

test("a chosen model and effort reach the provider and are recorded on the run", async () => {
  const provider = new ProviderFixture(async function* () { yield done; });
  const catalogued: RuntimeDetection = {
    ...detection,
    catalog: {
      connectionId: "runtime:codex",
      runtime: "codex",
      source: "codex-app-server:model/list",
      discoveredAt: new Date(0).toISOString(),
      expiresAt: new Date(0).toISOString(),
      error: null,
      models: [{
        connectionId: "runtime:codex",
        modelId: "gpt-fixture",
        label: "GPT Fixture",
        source: "codex-app-server:model/list",
        discoveredAt: new Date(0).toISOString(),
        runtimeVersion: "fixture",
        authScope: null,
        availability: "listed",
        effortOptions: [{ value: "high", label: "High" }],
        defaultModel: null,
        defaultEffort: null,
        defaultSource: "unknown",
        capabilities: detection.capabilities,
      }],
    },
  };
  const { sessionId, taskId } = project();

  await withServer(provider, async (url) => {
    await chat(url, { sessionId, taskId, model: "gpt-fixture", effort: "high", idempotencyKey: "override" });
    const refused = await fetch(`${url}/api/runtime-agent/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ runtime: "codex", message: "x", sessionId, taskId, model: "not-listed", idempotencyKey: "unlisted" }),
    });
    const refusedEvents = (await refused.text()).split("\n\n").filter((chunk) => chunk.startsWith("data: ")).map((chunk) => JSON.parse(chunk.slice(6)));

    assert.equal(provider.turns.length, 1);
    assert.equal(provider.turns[0]?.model, "gpt-fixture");
    assert.equal(provider.turns[0]?.effort, "high");
    const run = listRuns({ taskId }).find((item) => item.snapshot.requestedModel === "gpt-fixture");
    assert.deepEqual(
      [run?.snapshot.effectiveModel, run?.snapshot.modelSource, run?.snapshot.effectiveEffort, run?.snapshot.effortSource],
      ["gpt-fixture", "user-override", "high", "user-override"],
    );
    // A model the runtime did not list never reaches it.
    assert.equal(refusedEvents.find((event) => event.type === "error")?.code, "MODEL_UNAVAILABLE");
  }, catalogued);
});

test("a task waits for the tasks it depends on before it can run", async () => {
  const provider = new ProviderFixture(async function* () { yield done; });
  const workspaceRoot = fs.mkdtempSync(path.join(dataDir, "workspace-"));
  const sessionId = "session-dependencies";
  const save = (firstStatus: string) => saveSession({
    id: sessionId,
    title: sessionId,
    workspaceRoot,
    tasks: [
      { id: "TASK-01", title: "Schema", status: firstStatus, dependencies: [] },
      { id: "TASK-02", title: "API", status: "todo", dependencies: ["TASK-01", "TASK-GONE"] },
    ],
  });

  await withServer(provider, async (url) => {
    save("in_progress");
    const refused = await fetch(`${url}/api/runtime-agent/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ runtime: "codex", message: "x", sessionId, taskId: "TASK-02", idempotencyKey: "blocked" }),
    });
    assert.equal(refused.status, 409);
    assert.match(String((await refused.json()).error), /waits on TASK-01, which is not done/);
    assert.equal(provider.turns.length, 0);

    // Once the dependency is done the task runs; an id naming no task does not hold it back.
    save("done");
    const events = await chat(url, { sessionId, taskId: "TASK-02", idempotencyKey: "unblocked" });
    assert.equal(events.at(-1)?.runStatus, "completed");
    assert.equal(provider.turns.length, 1);
  });
});

test("a chat keeps its conversation when it becomes a project", async () => {
  let turn = 0;
  const provider = new ProviderFixture(async function* () {
    turn += 1;
    yield { type: "text", text: `answer ${turn}`, threadId: `thread_p${turn}`, turnId: "turn_fixture", itemId: null };
    yield { ...done, threadId: `thread_p${turn}` };
  });
  const sessionId = "session-becomes-project";

  await withServer(provider, async (url) => {
    // The chat is not saved yet, as a new untitled chat is not.
    const first = await chat(url, { sessionId, message: "Plan a todo app." });
    const conversationId = String(first.find((event) => event.type === "conversation")?.conversationId);

    // Choosing a folder saves the session and makes the chat a project.
    saveSession({ id: sessionId, title: "todo", workspaceRoot: fs.mkdtempSync(path.join(dataDir, "workspace-")), tasks: [] });
    const second = await chat(url, { sessionId, conversationId, message: "Now add auth." });

    assert.equal(second.find((event) => event.type === "error"), undefined, JSON.stringify(second));
    assert.equal(second.find((event) => event.type === "conversation")?.conversationId, conversationId);
    assert.equal(second.at(-1)?.runStatus, "completed");
    const messages = loadMessages(conversationId).map((message) => (message.content[0] as { text: string }).text);
    assert.deepEqual(messages, ["Plan a todo app.", "answer 1", "Now add auth.", "answer 2"]);
  });
});

test("each chat without a folder runs in a folder of its own, not in the server's", async () => {
  const provider = new ProviderFixture(async function* () { yield done; });
  const withFolder = project();

  await withServer(provider, async (url) => {
    await chat(url, { conversationId: "no-folder-1" });
    await chat(url, { conversationId: "no-folder-2" });
    await chat(url, { sessionId: withFolder.sessionId });
  });

  const [first, second, projectCwd] = provider.cwds;
  assert.equal(first, path.join(dataDir, "chat-workspaces", "no-folder-1"));
  assert.equal(second, path.join(dataDir, "chat-workspaces", "no-folder-2"));
  assert.ok(fs.statSync(first!).isDirectory());
  assert.equal(projectCwd, withFolder.workspaceRoot);
});

test("files a chat made before it had a folder move into the folder once it has one", async () => {
  const provider = new ProviderFixture(async function* (fixture) {
    // The agent writes where it was started, as a real runtime would.
    fs.writeFileSync(path.join(fixture.cwds.at(-1)!, `turn-${fixture.turns.length}.md`), "made by the agent");
    yield done;
  });
  const sessionId = "session-gets-folder";

  await withServer(provider, async (url) => {
    const first = await chat(url, { sessionId, message: "Draft a plan." });
    const conversationId = String(first.find((event) => event.type === "conversation")?.conversationId);
    const workspaceRoot = fs.mkdtempSync(path.join(dataDir, "workspace-"));
    saveSession({ id: sessionId, title: "plan", workspaceRoot, tasks: [] });

    const second = await chat(url, { sessionId, conversationId, message: "Now build it." });

    const note = second.find((event) => event.type === "chat_files");
    assert.equal(note?.status, "moved", JSON.stringify(second));
    assert.equal(fs.readFileSync(path.join(workspaceRoot, "turn-1.md"), "utf8"), "made by the agent");
    assert.equal(fs.existsSync(path.join(workspaceRoot, "turn-2.md")), true);
    assert.equal(fs.existsSync(path.join(dataDir, "chat-workspaces", conversationId)), false);
  });
});

test("a second run on a workspace that is still being written fails without reaching the provider", async () => {
  const provider = new ProviderFixture(async function* (fixture) {
    await fixture.waitUntilReleased();
    yield done;
  });
  // Two projects on one folder: separate conversations, shared workspace.
  const one = project();
  const other = project(one.workspaceRoot);

  await withServer(provider, async (url) => {
    const first = chat(url, { sessionId: one.sessionId, taskId: one.taskId, idempotencyKey: "writer-1" });
    await provider.firstTurnStarted;

    const second = await chat(url, { sessionId: other.sessionId, taskId: other.taskId, idempotencyKey: "writer-2" });
    provider.finish();
    await first;

    assert.equal(provider.turns.length, 1);
    assert.equal(second.at(-1)?.runStatus, "failed");
    assert.match(String(second.find((event) => event.type === "error")?.message), /Workspace is already being written/);
    assert.equal(listRuns({ taskId: one.taskId })[0].status, "completed");
  });
});

test("a second run in a conversation without a workspace fails without reaching the provider", async () => {
  const provider = new ProviderFixture(async function* (fixture) {
    await fixture.waitUntilReleased();
    yield done;
  });
  const conversationId = "conversation-two-tabs";

  await withServer(provider, async (url) => {
    // Two tabs open on the same chat each send their own message.
    const first = chat(url, { conversationId, idempotencyKey: "tab-1" });
    await provider.firstTurnStarted;

    const second = await chat(url, { conversationId, idempotencyKey: "tab-2" });
    provider.finish();
    await first;

    assert.equal(provider.turns.length, 1);
    assert.equal(second.at(-1)?.runStatus, "failed");
    assert.match(String(second.find((event) => event.type === "error")?.message), /already has a run in progress/);
    const statuses = listRuns({ conversationId }).map((run) => run.status).sort();
    assert.deepEqual(statuses, ["completed", "failed"]);
  });
});

test("a tool's in-progress updates show one tool, not one per update", async () => {
  // Codex sends a status-less event for every chunk of command output, and
  // Antigravity repeats a step while it is active.
  const tool = (status: string | null, data: unknown): RuntimeEvent => ({
    type: "tool",
    tool: "commandExecution",
    status,
    threadId: "thread_fixture",
    turnId: "turn_fixture",
    itemId: "cmd_1",
    data,
  });
  const provider = new ProviderFixture(async function* () {
    yield tool("inProgress", { command: "npm test" });
    yield tool(null, "76 ");
    yield tool(null, "pass\n");
    yield tool("completed", { command: "npm test", exitCode: 0 });
    yield done;
  });
  const { sessionId, taskId } = project();

  await withServer(provider, async (url) => {
    const events = await chat(url, { sessionId, taskId, idempotencyKey: "streamed-output" });

    assert.equal(events.filter((event) => event.type === "tool_start").length, 1);
    assert.equal(events.filter((event) => event.type === "tool_done").length, 1);
  });
});

test("a run the provider ends as failed tells the user why, once", async () => {
  const provider = new ProviderFixture(async function* () {
    yield { type: "text", text: "partial", threadId: "thread_fixture", turnId: "turn_fixture", itemId: null };
    // An expired login or spent quota arrives only on the provider's result.
    yield { ...done, status: "failed", error: { code: "usageLimitExceeded", message: "You've hit your usage limit." } } as RuntimeEvent;
  });
  const { sessionId, taskId } = project();

  await withServer(provider, async (url) => {
    const events = await chat(url, { sessionId, taskId, idempotencyKey: "provider-failed" });

    const errors = events.filter((event) => event.type === "error");
    assert.equal(errors.length, 1);
    assert.equal(errors[0]?.message, "You've hit your usage limit.");
    assert.equal(events.at(-1)?.type, "done");
    assert.equal(events.at(-1)?.runStatus, "failed");
  });
});

test("a fatal runtime error is not reported a second time when the run ends", async () => {
  const provider = new ProviderFixture(async function* () {
    yield { type: "error", error: { code: "PROCESS_EXITED", message: "Codex app-server process exited." }, threadId: "thread_fixture", turnId: "turn_fixture", fatal: true };
  });
  const { sessionId, taskId } = project();

  await withServer(provider, async (url) => {
    const events = await chat(url, { sessionId, taskId, idempotencyKey: "fatal-once" });

    assert.equal(events.filter((event) => event.type === "error").length, 1);
    assert.equal(events.at(-1)?.runStatus, "failed");
  });
});

test("runtime progress is neither shown as a tool nor recorded as evidence", async () => {
  // What the runner hands over for Claude's system and rate-limit messages
  // and for Antigravity's step updates.
  const progress = (status: string): RuntimeEvent => ({
    type: "tool",
    tool: "progress",
    status,
    threadId: "thread_fixture",
    turnId: "turn_fixture",
    itemId: null,
    data: { sessionId: "thread_fixture" },
  });
  const provider = new ProviderFixture(async function* () {
    yield progress("system");
    yield { type: "text", text: "answer", threadId: "thread_fixture", turnId: "turn_fixture", itemId: null };
    yield progress("rate_limit_event");
    yield progress("completed");
    yield done;
  });
  const { sessionId, taskId } = project();

  await withServer(provider, async (url) => {
    const events = await chat(url, { sessionId, taskId, idempotencyKey: "progress-only" });

    assert.equal(events.some((event) => event.type === "tool_start" || event.type === "tool_done"), false);
    assert.equal(events.filter((event) => event.type === "text").length, 1);
    assert.equal(events.at(-1)?.runStatus, "completed");
    const [run] = listRuns({ taskId });
    assert.deepEqual(listRunEvidence(run.id).filter((evidence) => evidence.kind !== "summary"), []);
  });
});

test("a tool result the provider repeats is recorded as evidence once", async () => {
  const tool: RuntimeEvent = {
    type: "tool",
    tool: "commandExecution",
    status: "completed",
    threadId: "thread_fixture",
    turnId: "turn_fixture",
    itemId: "item_1",
    data: { command: "npm test", exitCode: 0 },
  };
  const provider = new ProviderFixture(async function* () {
    // A provider stream that reconnects can deliver a finished item again.
    yield tool;
    yield tool;
    yield done;
  });
  const { sessionId, taskId } = project();

  await withServer(provider, async (url) => {
    const events = await chat(url, { sessionId, taskId, idempotencyKey: "replayed-tool" });

    const [run] = listRuns({ taskId });
    const commands = listRunEvidence(run.id).filter((evidence) => evidence.kind === "command");
    assert.equal(commands.length, 1);
    assert.equal(events.filter((event) => event.type === "tool_done").length, 1);
  });
});

test("a second decision on the same approval is refused and does not reach the provider", async () => {
  const decisions: unknown[] = [];
  let approvalId = "";
  let approvalSeen: () => void = () => {};
  const approvalShown = new Promise<void>((resolve) => { approvalSeen = resolve; });
  const provider = new ProviderFixture(async function* (fixture) {
    const decision = fixture.approvalHandler!({
      requestId: "req_1",
      kind: "command",
      threadId: "thread_fixture",
      turnId: "turn_fixture",
      itemId: "item_1",
      command: "rm -rf build",
      cwd: null,
      reason: null,
      details: null,
    });
    decisions.push(await decision);
    yield done;
  });
  const { sessionId, taskId } = project();

  await withServer(provider, async (url) => {
    const res = await fetch(`${url}/api/runtime-agent/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ runtime: "codex", message: "Clean up.", sessionId, taskId }),
    });
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let runId = "";
    const drained = (async () => {
      while (true) {
        const { done: ended, value } = await reader.read();
        if (ended) return;
        buffer += decoder.decode(value, { stream: true });
        const match = /"type":"approval_request".*?"approvalId":"([^"]+)"|"approvalId":"([^"]+)".*?"type":"approval_request"/.exec(buffer);
        const run = /"runId":"([^"]+)"/.exec(buffer);
        if (match && run && !approvalId) {
          approvalId = match[1] ?? match[2];
          runId = run[1];
          approvalSeen();
        }
      }
    })();
    await approvalShown;

    const decide = (approved: boolean) => fetch(`${url}/api/runtime-agent/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ approvalId, runId, approved }),
    });
    const [first, second] = await Promise.all([decide(true), decide(false)]);
    await drained;

    assert.deepEqual([first.status, second.status].sort(), [200, 404]);
    assert.equal(decisions.length, 1);
    assert.equal(provider.turns.length, 1);
  });
});

test("a provider's own copy of an approval request is not shown as a second card", async () => {
  // Codex puts the request in its stream as well as asking the handler; the
  // handler's card is the one the chat can answer.
  const provider = new ProviderFixture(async function* () {
    yield {
      type: "approval",
      requestId: 0,
      kind: "command",
      threadId: "thread_fixture",
      turnId: "turn_fixture",
      itemId: "item_1",
      command: "printf ok > smoke.txt",
      cwd: null,
      reason: null,
      details: null,
    } as RuntimeEvent;
    yield done;
  });
  const conversationId = "conversation-one-card";

  await withServer(provider, async (url) => {
    const events = await chat(url, { conversationId });
    assert.equal(events.filter((event) => event.type === "approval_request").length, 0);
    assert.equal(events.at(-1)?.runStatus, "completed");
  });
});

test("text that resumes after a tool call starts a new paragraph in the stored reply", async () => {
  const provider = new ProviderFixture(async function* () {
    yield { type: "text", text: "Running the check", threadId: "thread_fixture", turnId: "turn_fixture", itemId: null };
    yield {
      type: "tool",
      tool: "shell",
      status: "completed",
      threadId: "thread_fixture",
      turnId: "turn_fixture",
      itemId: "item_1",
      data: { command: "cat smoke.txt" },
    } as RuntimeEvent;
    yield { type: "text", text: "pwd returned ", threadId: "thread_fixture", turnId: "turn_fixture", itemId: null };
    yield { type: "text", text: "/tmp.", threadId: "thread_fixture", turnId: "turn_fixture", itemId: null };
    yield done;
  });
  const conversationId = "conversation-paragraphs";

  await withServer(provider, async (url) => {
    const events = await chat(url, { conversationId });

    // Streamed live, the text events are untouched: no separator was invented.
    assert.deepEqual(
      events.filter((event) => event.type === "text").map((event) => event.text),
      ["Running the check", "pwd returned ", "/tmp."],
    );

    // Stored, the text that resumed after the tool call is its own paragraph,
    // and the two text events with no tool between them are not split.
    const messages = loadMessages(conversationId).map((message) => (message.content[0] as { text: string }).text);
    assert.deepEqual(messages, ["Do the task.", "Running the check\n\npwd returned /tmp."]);
  });
});

test("when the server cannot tell Stop from a dropped connection, the stored reason says so honestly", async () => {
  const provider = new ProviderFixture(async function* (fixture) {
    yield { type: "text", text: "working", threadId: "thread_fixture", turnId: "turn_fixture", itemId: null };
    await fixture.waitUntilReleased();
    // The provider is interrupted rather than sending its own "done" with
    // status interrupted, as a stream that is simply cut off would.
    yield { type: "text", text: " more", threadId: "thread_fixture", turnId: "turn_fixture", itemId: null };
  });
  const { sessionId, taskId } = project();

  await withServer(provider, async (url) => {
    const stop = new AbortController();
    const res = await fetch(`${url}/api/runtime-agent/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ runtime: "codex", message: "Do the task.", sessionId, taskId, idempotencyKey: "stop-honest" }),
      signal: stop.signal,
    });
    const reader = res.body!.getReader();
    await reader.read();
    await provider.firstTurnStarted;
    stop.abort();
    await reader.read().catch(() => undefined);

    let run = listRuns({ taskId })[0];
    for (let i = 0; i < 50 && run?.status === "running"; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      run = listRuns({ taskId })[0];
    }
    assert.equal(run?.status, "interrupted");
    // The chat's own Stop and a lost connection abort the request the same
    // way, so the reason names both instead of claiming a fault.
    assert.doesNotMatch(run?.error ?? "", /disconnected/i);
    assert.match(run?.error ?? "", /stopped this run|lost its connection/);
  });
});
