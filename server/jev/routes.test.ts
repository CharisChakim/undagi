import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createJevClient } from "./client.ts";
import { answersReply, choiceAnswer, noulAnswer, scoreAnswer, startFakeJev, type FakeJev } from "./fixtures.ts";

// db.ts reads this on first import, so everything touching it is loaded afterwards.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "undagi-jev-routes-test-"));
process.env.UNDAGI_DATA_DIR = dataDir;

const express = (await import("express")).default;
const { db } = await import("../../db.ts");
process.on("exit", () => {
  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});
const { createJevRouter, jevRouter } = await import("./routes.ts");
const { readJevKey } = await import("./store.ts");

const apiKey = `test-${randomUUID()}`;

interface Harness {
  fake: FakeJev;
  call(method: string, route: string, body?: unknown): Promise<{ status: number; text: string; json: any }>;
}

async function withRoutes(fn: (harness: Harness) => Promise<void>): Promise<void> {
  const fake = await startFakeJev(() => answersReply({}));
  const app = express();
  app.use(express.json());
  app.use(createJevRouter({ createClient: (key) => createJevClient({ apiKey: key, baseUrl: fake.url, timeoutMs: 300 }) }));
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    await fn({
      fake,
      async call(method, route, body) {
        const response = await fetch(`${base}${route}`, {
          method,
          headers: { "Content-Type": "application/json" },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        const text = await response.text();
        let json: any;
        try {
          json = JSON.parse(text);
        } catch {
          json = undefined;
        }
        return { status: response.status, text, json };
      },
    });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fake.close();
  }
}

const NO_FEATURES = { intentRouting: false, intakeCheck: false, permissionRisk: false, dependencyCheck: false };
const ALL_FEATURES = { intentRouting: true, intakeCheck: true, permissionRisk: true, dependencyCheck: true };

test("the module exports a ready-made router", () => {
  assert.equal(typeof jevRouter, "function");
});

test("settings: defaults, key semantics and no key in any response", async () => {
  await withRoutes(async ({ call }) => {
    let res = await call("GET", "/api/jev/settings");
    assert.equal(res.status, 200);
    assert.deepEqual(res.json, { enabled: false, hasKey: false, features: NO_FEATURES });

    res = await call("PUT", "/api/jev/settings", { apiKey: `  ${apiKey}  `, enabled: true, features: { intakeCheck: true } });
    assert.equal(res.status, 200);
    assert.deepEqual(res.json, { enabled: true, hasKey: true, features: { ...NO_FEATURES, intakeCheck: true } });
    assert.equal(readJevKey(), apiKey);
    assert.ok(!res.text.includes(apiKey));
    assert.ok(!(await call("GET", "/api/jev/settings")).text.includes(apiKey));

    // Omitted and null keep the key, "" removes it.
    assert.equal((await call("PUT", "/api/jev/settings", { enabled: false })).json.hasKey, true);
    assert.equal((await call("PUT", "/api/jev/settings", { apiKey: null })).json.hasKey, true);
    assert.equal(readJevKey(), apiKey);
    res = await call("PUT", "/api/jev/settings", { apiKey: "" });
    assert.equal(res.json.hasKey, false);
    assert.equal(readJevKey(), null);

    // Extra fields (e.g. a whole public object echoed back) and unknown feature names are ignored.
    res = await call("PUT", "/api/jev/settings", { enabled: true, hasKey: true, extra: 1, features: { nonsense: true } });
    assert.equal(res.status, 200);
    assert.deepEqual(res.json, { enabled: true, hasKey: false, features: { ...NO_FEATURES, intakeCheck: true } });
  });
});

test("settings: invalid bodies are rejected with 400 and change nothing", async () => {
  await withRoutes(async ({ call }) => {
    await call("PUT", "/api/jev/settings", { apiKey, enabled: false, features: NO_FEATURES });
    const bad: unknown[] = [
      [],
      { enabled: "yes" },
      { apiKey: 42 },
      { apiKey: "has a space" },
      { apiKey: "line\nbreak" },
      { apiKey: "k".repeat(600) },
      { features: [] },
      { features: { intentRouting: "on" } },
      { enabled: true, features: { intakeCheck: 1 } },
    ];
    for (const body of bad) {
      const res = await call("PUT", "/api/jev/settings", body);
      assert.equal(res.status, 400, JSON.stringify(body));
      assert.equal(typeof res.json.error, "string");
      assert.ok(!res.text.includes("has a space") && !res.text.includes("line"), "error must not echo the key");
    }
    assert.deepEqual((await call("GET", "/api/jev/settings")).json, { enabled: false, hasKey: true, features: NO_FEATURES });
    assert.equal(readJevKey(), apiKey);
  });
});

test("test: needs a saved key and makes no call without one", async () => {
  await withRoutes(async ({ call, fake }) => {
    await call("PUT", "/api/jev/settings", { apiKey: "" });
    const res = await call("POST", "/api/jev/test", {});
    assert.equal(res.status, 200);
    assert.deepEqual(res.json, { ok: false, error: "No API key saved" });
    assert.equal(fake.requests.length, 0);
  });
});

test("test: one trivial noul question with the saved key, works while Jev is switched off", async () => {
  await withRoutes(async ({ call, fake }) => {
    await call("PUT", "/api/jev/settings", { apiKey, enabled: false });
    fake.reply(() => answersReply({ ping: noulAnswer(0.9) }));

    const res = await call("POST", "/api/jev/test", {});
    assert.equal(res.status, 200);
    assert.equal(res.json.ok, true);
    assert.equal(typeof res.json.latencyMs, "number");
    assert.ok(res.json.latencyMs >= 0);
    assert.ok(!res.text.includes(apiKey));

    assert.equal(fake.requests.length, 1);
    const [request] = fake.requests;
    assert.equal(request.headers.authorization, `Bearer ${apiKey}`);
    assert.deepEqual(Object.keys(request.body.questions), ["ping"]);
    assert.equal(request.body.questions.ping.type, "noul");
    assert.equal(request.body.model, "jev-latest");
  });
});

test("test: upstream failures come back as a safe message", async () => {
  await withRoutes(async ({ call, fake }) => {
    await call("PUT", "/api/jev/settings", { apiKey });
    const expected: Array<[number, string]> = [
      [401, "Jev rejected the API key (401)"],
      [422, "Jev rejected the request (422)"],
      [429, "Jev rate limit reached (429)"],
      [529, "Jev is overloaded (529)"],
    ];
    for (const [status, error] of expected) {
      fake.reply(() => ({ status, json: { error: `upstream said ${apiKey}` } }));
      const res = await call("POST", "/api/jev/test", {});
      assert.equal(res.status, 200);
      assert.deepEqual(res.json, { ok: false, error });
      assert.ok(!res.text.includes(apiKey));
    }

    fake.reply(() => ({ text: "not json" }));
    assert.equal((await call("POST", "/api/jev/test", {})).json.ok, false);

    fake.reply(() => ({ hang: true }));
    const timedOut = await call("POST", "/api/jev/test", {});
    assert.deepEqual(timedOut.json, { ok: false, error: "Jev request timed out" });
  });
});

test("advice routes answer null without any outbound call while inactive", async () => {
  await withRoutes(async ({ call, fake }) => {
    const bodies: Array<[string, unknown]> = [
      ["/api/jev/intent", { message: "build it", hasPlan: false, hasPrd: false, hasTasks: false }],
      ["/api/jev/intake", { description: "a todo app", answers: ["web"] }],
      ["/api/jev/dependencies", { tasks: [{ id: "a", title: "A", dependencies: [], targetFiles: ["x.ts"] }] }],
    ];
    const states = [
      { apiKey, enabled: false, features: ALL_FEATURES },
      { apiKey, enabled: true, features: NO_FEATURES },
      { apiKey: "", enabled: true, features: ALL_FEATURES },
    ];
    for (const state of states) {
      await call("PUT", "/api/jev/settings", state);
      for (const [route, body] of bodies) {
        const res = await call("POST", route, body);
        assert.equal(res.status, 200, route);
        assert.deepEqual(res.json, { advice: null }, route);
      }
    }
    assert.equal(fake.requests.length, 0);
  });
});

test("advice routes return Jev's advice once active", async () => {
  await withRoutes(async ({ call, fake }) => {
    await call("PUT", "/api/jev/settings", { apiKey, enabled: true, features: ALL_FEATURES });

    fake.reply(() => answersReply({ intent: choiceAnswer("generate_prd", 0.77) }));
    let res = await call("POST", "/api/jev/intent", { message: "write the prd", hasPlan: true });
    assert.deepEqual(res.json, { advice: { intent: "generate_prd", confidence: 0.77 } });
    assert.deepEqual(fake.requests[0].body.state, { message: "write the prd", hasPlan: true, hasPrd: false, hasTasks: false });

    fake.reply(() => answersReply({ ready: noulAnswer(0.4), clarity: scoreAnswer(0.8) }));
    res = await call("POST", "/api/jev/intake", { description: "a todo app", answers: ["web only"] });
    assert.deepEqual(res.json, { advice: { ready: 0.4, clarity: 0.8 } });
    assert.deepEqual(fake.requests[1].body.state, { description: "a todo app", answers: ["web only"] });

    fake.reply(() => answersReply({ p0: noulAnswer(0.9) }));
    res = await call("POST", "/api/jev/dependencies", {
      tasks: [
        { id: "a", title: "Schema", targetFiles: ["db.ts"], dependencies: [] },
        { id: "b", title: "API", targetFiles: ["db.ts"] },
      ],
    });
    assert.deepEqual(res.json, { advice: [{ taskId: "b", dependsOn: "a", probability: 0.9 }] });

    assert.ok(![res.text, ...fake.requests.map((request) => request.raw)].some((text) => text.includes(apiKey)));
  });
});

test("advice routes turn upstream failures into a 200 with null advice", async () => {
  await withRoutes(async ({ call, fake }) => {
    await call("PUT", "/api/jev/settings", { apiKey, enabled: true, features: ALL_FEATURES });
    for (const reply of [{ status: 401 }, { status: 529 }, { text: "{bad" }, { hang: true }]) {
      fake.reply(() => reply);
      const res = await call("POST", "/api/jev/intent", { message: "hello" });
      assert.equal(res.status, 200);
      assert.deepEqual(res.json, { advice: null });
    }
  });
});

test("advice routes validate their input", async () => {
  await withRoutes(async ({ call, fake }) => {
    await call("PUT", "/api/jev/settings", { apiKey, enabled: true, features: ALL_FEATURES });
    const goodTask = { id: "a", title: "A", dependencies: [] };
    const cases: Array<[string, unknown]> = [
      ["/api/jev/intent", []],
      ["/api/jev/intent", {}],
      ["/api/jev/intent", { message: 5 }],
      ["/api/jev/intent", { message: "m".repeat(4001) }],
      ["/api/jev/intent", { message: "ok", hasPlan: "yes" }],
      ["/api/jev/intent", { message: "ok", hasTasks: 1 }],
      ["/api/jev/intake", {}],
      ["/api/jev/intake", { description: ["not a string"] }],
      ["/api/jev/intake", { description: "d".repeat(8001) }],
      ["/api/jev/intake", { description: "ok", answers: "nope" }],
      ["/api/jev/intake", { description: "ok", answers: [1] }],
      ["/api/jev/intake", { description: "ok", answers: Array.from({ length: 51 }, () => "a") }],
      ["/api/jev/dependencies", {}],
      ["/api/jev/dependencies", { tasks: "nope" }],
      ["/api/jev/dependencies", { tasks: Array.from({ length: 61 }, (_, i) => ({ ...goodTask, id: `t${i}` })) }],
      ["/api/jev/dependencies", { tasks: [null] }],
      ["/api/jev/dependencies", { tasks: [{ title: "no id" }] }],
      ["/api/jev/dependencies", { tasks: [{ id: 7, title: "numeric id" }] }],
      ["/api/jev/dependencies", { tasks: [{ id: "a" }] }],
      ["/api/jev/dependencies", { tasks: [{ ...goodTask, targetFiles: "x.ts" }] }],
      ["/api/jev/dependencies", { tasks: [{ ...goodTask, targetFiles: [1] }] }],
      ["/api/jev/dependencies", { tasks: [{ ...goodTask, dependencies: "b" }] }],
      ["/api/jev/dependencies", { tasks: [{ ...goodTask, promptInstructions: 3 }] }],
    ];
    for (const [route, body] of cases) {
      const res = await call("POST", route, body);
      assert.equal(res.status, 400, `${route} ${JSON.stringify(body).slice(0, 80)}`);
      assert.equal(typeof res.json.error, "string");
    }
    assert.equal(fake.requests.length, 0);

    // The cap itself is fine.
    const atCap = Array.from({ length: 60 }, (_, i) => ({ ...goodTask, id: `t${i}` }));
    assert.equal((await call("POST", "/api/jev/dependencies", { tasks: atCap })).status, 200);
  });
});
