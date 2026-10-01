import assert from "node:assert/strict";
import fs from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// db.ts reads this when it is first imported, so everything that touches the
// database is loaded dynamically, after the data directory is disposable.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "undagi-agent-route-test-"));
process.env.UNDAGI_DATA_DIR = dataDir;

const express = (await import("express")).default;
const { db, saveSession } = await import("../../db.ts");
// Windows will not delete a database file that is still open.
process.on("exit", () => {
  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});
const { createConversation, getConversation, linkConversationToProject } = await import("../agent/conversations.ts");
const { makeElicit, router } = await import("./agent.ts");

test("a Legacy API chat keeps its conversation when it becomes a project", async () => {
  // The chat ran before its session was saved, so its conversation stands alone.
  const conversation = createConversation({});
  saveSession({ id: "session-legacy-project", title: "todo", workspaceRoot: "", tasks: [] });

  const app = express();
  app.use(express.json());
  app.use(router);
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  try {
    const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/agent/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // An endpoint on a closed local port: the request gets past connection
      // resolution to the conversation, and the model call fails locally.
      body: JSON.stringify({
        sessionId: "session-legacy-project",
        conversationId: conversation.id,
        message: "Now add auth.",
        agentConfig: { baseUrl: "http://127.0.0.1:1", model: "fixture" },
      }),
    });
    const body = await res.text();
    assert.doesNotMatch(body, /does not belong/);
    assert.equal(getConversation(conversation.id)?.projectId, "session-legacy-project");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("a project's conversations can be found without a saved conversation id", async () => {
  saveSession({ id: "session-history", title: "history", workspaceRoot: "", tasks: [] });
  const linked = createConversation({});
  linkConversationToProject(linked.id, "session-history");
  createConversation({ sessionId: "other-session", projectId: "other-session" });

  const app = express();
  app.use(router);
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  try {
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/agent/conversations`;
    const res = await fetch(`${base}?projectId=session-history`);
    assert.equal(res.status, 200);
    const body = await res.json() as { conversations: Array<{ id: string }> };
    assert.deepEqual(body.conversations.map((conversation) => conversation.id), [linked.id]);
    assert.equal((await fetch(base)).status, 400);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

const lowRisk = { risk: "low" as const, score: 0.4, confidence: 0.81 };
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test("a Legacy API approval card is followed by risk advice when Jev is on, and the advice decides nothing", async () => {
  const sent: Array<Record<string, unknown>> = [];
  const asked: unknown[] = [];
  const ac = new AbortController();
  let release: () => void = () => {};
  const advised = new Promise<void>((resolve) => { release = resolve; });
  const elicit = makeElicit("conversation-advice", ac, (event) => { sent.push(event as Record<string, unknown>); return true; }, new Set(), {
    isActive: (feature) => feature === "permissionRisk",
    advise: async (input) => { asked.push(input); await advised; return lowRisk; },
  });

  const answer = elicit({ kind: "approval", command: "rm -rf build", cwd: "/work/app", action: "edit" });
  // The card went out before the advisor answered, and the question is still open.
  assert.deepEqual(sent.map((event) => event.type), ["approval_request"]);
  assert.deepEqual(asked, [{ command: "rm -rf build", cwd: "/work/app", kind: "file_change" }]);

  release();
  await tick();
  const [request, advice] = sent;
  assert.deepEqual(advice, { type: "approval_advice", approvalId: request.approvalId, elicitId: request.elicitId, ...lowRisk });

  ac.abort();
  assert.equal(await answer, false);
  assert.deepEqual(sent.map((event) => event.type), ["approval_request", "approval_advice", "approval_resolved"]);
});

test("Legacy API risk advice is dropped once the approval is answered, and never asked for while Jev is off", async () => {
  const sent: Array<Record<string, unknown>> = [];
  const send = (event: unknown) => { sent.push(event as Record<string, unknown>); return true; };
  let release: () => void = () => {};
  const advised = new Promise<void>((resolve) => { release = resolve; });

  const late = new AbortController();
  const lateAnswer = makeElicit("conversation-late", late, send, new Set(), {
    isActive: () => true,
    advise: async () => { await advised; return lowRisk; },
  })({ kind: "approval", command: "npm test", action: "command" });
  late.abort();
  assert.equal(await lateAnswer, false);
  release();
  await tick();

  let asked = 0;
  const off = new AbortController();
  const offAnswer = makeElicit("conversation-off", off, send, new Set(), {
    isActive: () => false,
    advise: async () => { asked += 1; return lowRisk; },
  })({ kind: "approval", command: "npm test", action: "command" });
  const questions = makeElicit("conversation-questions", off, send, new Set(), {
    isActive: () => true,
    advise: async () => { asked += 1; return lowRisk; },
  })({ kind: "questions", questions: [], round: 1 });
  await tick();
  off.abort();
  await offAnswer;
  await questions;

  assert.equal(sent.some((event) => event.type === "approval_advice"), false);
  assert.equal(asked, 0);
});
