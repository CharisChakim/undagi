import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
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
const { chatLanguages, router } = await import("./agent.ts");

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

test("the chat body's language and agentLanguage pick the model-facing languages", () => {
  assert.deepEqual(chatLanguages({}), { humanLang: "en", agentLang: "en" });
  assert.deepEqual(chatLanguages({ language: "id" }), { humanLang: "id", agentLang: "en" });
  assert.deepEqual(chatLanguages({ language: "id", agentLanguage: "ui" }), { humanLang: "id", agentLang: "id" });
  assert.deepEqual(chatLanguages({ language: "en", agentLanguage: "ui" }), { humanLang: "en", agentLang: "en" });
  assert.deepEqual(chatLanguages({ language: "id", agentLanguage: "en" }), { humanLang: "id", agentLang: "en" });
  // Unknown values fall back to English rather than reaching the prompts.
  assert.deepEqual(chatLanguages({ language: "fr", agentLanguage: "id" }), { humanLang: "en", agentLang: "en" });
});

test("a Legacy API turn started from a task card is asked to report its status; a plain one is not", async () => {
  const systems: string[] = [];
  const model = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      systems.push(JSON.parse(raw).system);
      res.writeHead(500).end("stand-in endpoint");
    });
  });
  model.listen(0);
  await new Promise<void>((resolve) => model.once("listening", resolve));
  const modelUrl = `http://127.0.0.1:${(model.address() as AddressInfo).port}`;

  const app = express();
  app.use(express.json());
  app.use(router);
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const chatUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/agent/chat`;
  const send = async (extra: Record<string, unknown>): Promise<void> => {
    const res = await fetch(chatUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Do the task.", agentConfig: { baseUrl: modelUrl, model: "fixture" }, ...extra }),
    });
    await res.text();
  };
  try {
    await send({ taskId: "TASK-01" });
    await send({});
    assert.equal(systems.length, 2);
    assert.match(systems[0], /TASK_STATUS: blocked/);
    assert.doesNotMatch(systems[1], /TASK_STATUS/);
  } finally {
    server.closeAllConnections();
    model.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await new Promise<void>((resolve) => model.close(() => resolve()));
  }
});

test("a standalone chat names the planning card in the UI language the client sent", async () => {
  const systems: string[] = [];
  // A stand-in model endpoint that records the system prompt and then fails,
  // so the turn ends without a real model call.
  const model = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      systems.push(JSON.parse(raw).system);
      res.writeHead(500).end("stand-in endpoint");
    });
  });
  model.listen(0);
  await new Promise<void>((resolve) => model.once("listening", resolve));
  const modelUrl = `http://127.0.0.1:${(model.address() as AddressInfo).port}`;

  const app = express();
  app.use(express.json());
  app.use(router);
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const chatUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/agent/chat`;
  const send = async (extra: Record<string, unknown>): Promise<void> => {
    const res = await fetch(chatUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "Help me plan an app.",
        agentConfig: { baseUrl: modelUrl, model: "fixture" },
        ...extra,
      }),
    });
    await res.text();
  };
  try {
    await send({ language: "id" });
    await send({ language: "en" });
    await send({});
    assert.equal(systems.length, 3);
    assert.ok(systems[0].includes('"Susun plan proyek" card'));
    assert.ok(systems[1].includes('"Plan a project" card'));
    assert.ok(systems[2].includes('"Plan a project" card'));
    assert.ok(systems.every((system) => system.includes("Answer in the language the user uses.")));
  } finally {
    server.closeAllConnections();
    model.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await new Promise<void>((resolve) => model.close(() => resolve()));
  }
});
