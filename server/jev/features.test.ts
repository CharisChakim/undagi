import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createJevClient } from "./client.ts";
import {
  answersReply,
  choiceAnswer,
  noulAnswer,
  scoreAnswer,
  startFakeJev,
  type FakeHandler,
  type FakeJev,
} from "./fixtures.ts";
import type { JevFeature, JevSettingsPublic, JevTaskInput } from "./types.ts";

// db.ts reads this on first import, so everything touching it is loaded afterwards.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "undagi-jev-features-test-"));
process.env.UNDAGI_DATA_DIR = dataDir;

const { db } = await import("../../db.ts");
process.on("exit", () => {
  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});
const { adviseApproval, adviseDependencies, adviseIntake, adviseIntent, isJevActive } = await import("./features.ts");
const { updateJevSettings } = await import("./store.ts");

const apiKey = `test-${randomUUID()}`;
const ON: JevSettingsPublic = {
  enabled: true,
  hasKey: true,
  features: { intentRouting: true, intakeCheck: true, permissionRisk: true, dependencyCheck: true },
};

async function withFake<T>(
  handler: FakeHandler,
  fn: (fake: FakeJev, deps: { client: ReturnType<typeof createJevClient>; settings: JevSettingsPublic }) => Promise<T>,
  timeoutMs = 2000,
): Promise<T> {
  const fake = await startFakeJev(handler);
  try {
    return await fn(fake, { client: createJevClient({ apiKey, baseUrl: fake.url, timeoutMs }), settings: ON });
  } finally {
    await fake.close();
  }
}

const task = (id: string, extra: Partial<JevTaskInput> = {}): JevTaskInput =>
  ({ id, title: `Task ${id}`, dependencies: [], ...extra });

// Task list with three candidate pairs: (t2, t1) and (t2, t3) by mention, (t3, t1) by shared file.
function sampleTasks(): JevTaskInput[] {
  return [
    task("t1", { targetFiles: ["src/db.ts"] }),
    task("t2", { targetFiles: ["src/api.ts"], promptInstructions: "Read the tables from src/db.ts" }),
    task("t3", { targetFiles: ["./src/db.ts"] }),
    task("t4", { targetFiles: ["README.md"] }),
  ];
}

test("isJevActive needs enabled, a key and the feature ticked", async () => {
  const features: JevFeature[] = ["intentRouting", "intakeCheck", "permissionRisk", "dependencyCheck"];
  assert.deepEqual(features.map((name) => isJevActive(name)), [false, false, false, false]);

  updateJevSettings({ apiKey, features: { intentRouting: true, permissionRisk: true } });
  assert.equal(isJevActive("intentRouting"), false, "still disabled");

  updateJevSettings({ enabled: true });
  assert.deepEqual(features.map((name) => isJevActive(name)), [true, false, true, false]);

  updateJevSettings({ apiKey: "" });
  assert.equal(isJevActive("intentRouting"), false, "no key");

  updateJevSettings({ enabled: false, features: { intentRouting: false, permissionRisk: false } });
});

test("adviseIntent sends one choice question and maps the answer", async () => {
  await withFake(() => answersReply({ intent: choiceAnswer("run_task", 0.83) }), async (fake, deps) => {
    const advice = await adviseIntent(
      { message: "y".repeat(3000), hasPlan: true, hasPrd: false, hasTasks: true },
      deps,
    );
    assert.deepEqual(advice, { intent: "run_task", confidence: 0.83 });

    assert.equal(fake.requests.length, 1);
    const { headers, body } = fake.requests[0];
    assert.equal(headers.authorization, `Bearer ${apiKey}`);
    assert.equal(body.model, "jev-latest");
    assert.deepEqual(body.state, { message: "y".repeat(2000), hasPlan: true, hasPrd: false, hasTasks: true });
    assert.deepEqual(Object.keys(body.questions), ["intent"]);
    const question = body.questions.intent;
    assert.equal(question.type, "choice");
    assert.equal(typeof question.instructions, "string");
    assert.deepEqual(Object.keys(question.criteria), ["plan_project", "generate_prd", "generate_tasks", "run_task", "chat"]);
    for (const description of Object.values(question.criteria)) {
      assert.ok(typeof description === "string" && description.length > 0);
    }
  });
});

test("adviseIntent skips empty messages without calling out", async () => {
  await withFake(() => answersReply({ intent: choiceAnswer("chat") }), async (fake, deps) => {
    assert.equal(await adviseIntent({ message: "  \n", hasPlan: false, hasPrd: false, hasTasks: false }, deps), null);
    assert.equal(fake.requests.length, 0);
  });
});

test("adviseIntake asks a noul and a 3-level score in one request", async () => {
  await withFake(() => answersReply({ ready: noulAnswer(0.62), clarity: scoreAnswer(1.4) }), async (fake, deps) => {
    const advice = await adviseIntake({ description: "d".repeat(5000), answers: ["a1", "a2"] }, deps);
    assert.deepEqual(advice, { ready: 0.62, clarity: 1.4 });

    assert.equal(fake.requests.length, 1);
    const { body } = fake.requests[0];
    assert.deepEqual(body.state, { description: "d".repeat(4000), answers: ["a1", "a2"] });
    assert.equal(body.questions.ready.type, "noul");
    assert.match(body.questions.ready.instructions, /specific enough to write a project plan without asking further questions/);
    assert.equal(body.questions.clarity.type, "score");
    assert.equal(body.questions.clarity.criteria.length, 3);
    assert.match(body.questions.clarity.criteria[0], /^Vague/);
    assert.match(body.questions.clarity.criteria[1], /^Workable/);
    assert.match(body.questions.clarity.criteria[2], /^Detailed/);
  });
});

test("adviseIntake leaves answers out of the state when there are none", async () => {
  await withFake(() => answersReply({ ready: noulAnswer(0.1), clarity: scoreAnswer(0) }), async (fake, deps) => {
    assert.deepEqual(await adviseIntake({ description: "todo app" }, deps), { ready: 0.1, clarity: 0 });
    assert.deepEqual(fake.requests[0].body.state, { description: "todo app" });
    assert.equal(await adviseIntake({ description: "   " }, deps), null);
    assert.equal(fake.requests.length, 1);
  });
});

test("adviseApproval maps the score to a risk band at the thresholds", async () => {
  let score = 0;
  await withFake(() => answersReply({ risk: scoreAnswer(score, 0.7) }), async (fake, deps) => {
    const cases: Array<[number, string]> = [
      [0, "low"], [0.69, "low"], [0.7, "medium"], [1, "medium"], [1.39, "medium"], [1.4, "high"], [2, "high"],
    ];
    for (const [value, risk] of cases) {
      score = value;
      const advice = await adviseApproval({ command: "ls -la", cwd: "/work", kind: "command", reason: "list" }, deps);
      assert.deepEqual(advice, { risk, score: value, confidence: 0.7 }, `score ${value}`);
    }

    const { body } = fake.requests[0];
    assert.deepEqual(body.state, { command: "ls -la", cwd: "/work", kind: "command", reason: "list" });
    assert.deepEqual(Object.keys(body.questions), ["risk"]);
    assert.equal(body.questions.risk.type, "score");
    assert.equal(body.questions.risk.criteria.length, 3);
  });
});

test("adviseApproval redacts secrets before the command leaves the machine", async () => {
  await withFake(() => answersReply({ risk: scoreAnswer(1) }), async (fake, deps) => {
    // Probes are assembled at runtime so no secret-shaped literal sits in the source.
    const secrets = Array.from({ length: 7 }, () => randomUUID());
    const tokenName = ["GITHUB", "TOKEN"].join("_");
    const commands = [
      `${tokenName}=${secrets[0]} npm publish`,
      `curl -H "Authorization: Bearer ${secrets[1]}" https://example.com/api`,
      `git clone https://user:${secrets[2]}@example.com/repo.git`,
      `tool --api-key ${secrets[3]} --verbose`,
      `deploy --token ${secrets[4]}`,
      `${["PASS", "WORD"].join("")}="${secrets[5]}" ./run.sh`,
    ];
    for (const command of commands) {
      await adviseApproval({ command, cwd: "/work", kind: "command", reason: `password: ${secrets[6]}` }, deps);
    }

    assert.equal(fake.requests.length, commands.length);
    for (const request of fake.requests) {
      for (const secret of secrets) assert.ok(!request.raw.includes(secret), "secret reached the upstream");
    }
    const sent = fake.requests.map((request) => request.body.state.command as string);
    assert.match(sent[0], /^GITHUB_TOKEN=\[redacted\] npm publish$/);
    assert.ok(sent.every((command) => command.includes("[redacted]")));
    assert.ok(sent[1].includes("https://example.com/api"), "non-secret parts survive");
    assert.ok(sent[2].includes("@example.com/repo.git"));
    assert.equal(fake.requests[0].body.state.reason, "password: [redacted]");
  });
});

test("adviseApproval truncates the command and needs something to judge", async () => {
  await withFake(() => answersReply({ risk: scoreAnswer(0.5) }), async (fake, deps) => {
    await adviseApproval({ command: "a".repeat(5000), cwd: "/work" }, deps);
    assert.equal(fake.requests[0].body.state.command.length, 1000);

    assert.equal(await adviseApproval({ cwd: "/work", kind: "command" }, deps), null);
    assert.equal(await adviseApproval({ command: "  ", reason: "" }, deps), null);
    assert.equal(fake.requests.length, 1);
  });
});

test("adviseDependencies asks only about candidate pairs and keeps the confident ones", async () => {
  const handler: FakeHandler = () => answersReply({ p0: noulAnswer(0.95), p1: noulAnswer(0.79), p2: noulAnswer(0.8) });
  await withFake(handler, async (fake, deps) => {
    const advice = await adviseDependencies(sampleTasks(), deps);

    assert.equal(fake.requests.length, 1, "one request for all pairs");
    const { questions } = fake.requests[0].body;
    assert.deepEqual(Object.keys(questions), ["p0", "p1", "p2"]);
    assert.deepEqual(
      Object.values(questions).map((q: any) => [q.instructions.taskA.id, q.instructions.taskB.id]),
      [["t2", "t1"], ["t2", "t3"], ["t3", "t1"]],
    );
    const first = questions.p0;
    assert.equal(first.type, "noul");
    assert.deepEqual(first.instructions.taskA, { id: "t2", title: "Task t2", targetFiles: ["src/api.ts"] });
    assert.deepEqual(first.instructions.taskB, { id: "t1", title: "Task t1", targetFiles: ["src/db.ts"] });
    assert.equal(first.instructions.question, "Must `taskB` be finished before `taskA` can start?");

    // 0.79 is dropped, 0.8 is kept, and the result is sorted high to low.
    assert.deepEqual(advice, [
      { taskId: "t2", dependsOn: "t1", probability: 0.95 },
      { taskId: "t3", dependsOn: "t1", probability: 0.8 },
    ]);
  });
});

test("adviseDependencies returns [] when nothing reaches the threshold", async () => {
  await withFake(() => answersReply({ p0: noulAnswer(0.5), p1: noulAnswer(0.1), p2: noulAnswer(0.799) }), async (_fake, deps) => {
    assert.deepEqual(await adviseDependencies(sampleTasks(), deps), []);
  });
});

test("adviseDependencies skips pairs already linked in either direction", async () => {
  await withFake(() => answersReply({ p0: noulAnswer(0.9) }), async (fake, deps) => {
    const tasks = sampleTasks();
    tasks[2].dependencies = ["t1"]; // (t3, t1) linked forwards
    tasks[0].dependencies = ["t2"]; // (t2, t1) linked backwards
    const advice = await adviseDependencies(tasks, deps);

    const questions = Object.values(fake.requests[0].body.questions) as any[];
    assert.deepEqual(questions.map((q) => [q.instructions.taskA.id, q.instructions.taskB.id]), [["t2", "t3"]]);
    assert.deepEqual(advice, [{ taskId: "t2", dependsOn: "t3", probability: 0.9 }]);
  });
});

test("adviseDependencies makes no call when no pair looks related", async () => {
  await withFake(() => answersReply({}), async (fake, deps) => {
    const tasks = [task("a", { targetFiles: ["a.ts"] }), task("b", { targetFiles: ["b.ts"] }), task("c")];
    assert.deepEqual(await adviseDependencies(tasks, deps), []);
    assert.deepEqual(await adviseDependencies([], deps), []);
    assert.equal(await adviseDependencies("nope" as never, deps), null);
    assert.equal(fake.requests.length, 0);
  });
});

test("adviseDependencies caps the pairs at 40 and the tasks at 60", async () => {
  await withFake(() => ({ json: { answers: {} } }), async (fake, deps) => {
    // 12 tasks on one file make 66 pairs; only 40 may be asked.
    const crowded = Array.from({ length: 12 }, (_, i) => task(`c${i}`, { targetFiles: ["shared.ts"] }));
    await adviseDependencies(crowded, deps);
    assert.equal(Object.keys(fake.requests[0].body.questions).length, 40);

    // The only related tasks are 61st and later, so they are never looked at.
    const late = [
      ...Array.from({ length: 60 }, (_, i) => task(`u${i}`, { targetFiles: [`unique-${i}.ts`] })),
      ...Array.from({ length: 5 }, (_, i) => task(`late${i}`, { targetFiles: ["late.ts"] })),
    ];
    assert.deepEqual(await adviseDependencies(late, deps), []);
    assert.equal(fake.requests.length, 1);
  });
});

const failures: Array<[string, FakeHandler]> = [
  ["401", () => ({ status: 401, json: { error: "bad key" } })],
  ["422", () => ({ status: 422, json: { error: "invalid" } })],
  ["429", () => ({ status: 429, json: { error: "slow down" } })],
  ["529", () => ({ status: 529, json: { error: "overloaded" } })],
  ["malformed JSON", () => ({ text: "{not json" })],
  ["no answers object", () => ({ json: { model: "jev-1.13.0" } })],
  ["wrong answer type", () => ({ json: { answers: { intent: noulAnswer(0.5), ready: choiceAnswer("a"), clarity: noulAnswer(0.2), risk: noulAnswer(0.1), p0: scoreAnswer(1), p1: scoreAnswer(1), p2: scoreAnswer(1) } } })],
  ["timeout", () => ({ hang: true })],
];

for (const [label, handler] of failures) {
  test(`every advise function resolves to null on ${label}`, async () => {
    await withFake(handler, async (fake, deps) => {
      assert.equal(await adviseIntent({ message: "build it", hasPlan: false, hasPrd: false, hasTasks: false }, deps), null);
      assert.equal(await adviseIntake({ description: "a todo app" }, deps), null);
      assert.equal(await adviseApproval({ command: "rm -rf build" }, deps), null);
      assert.equal(await adviseDependencies(sampleTasks(), deps), null);
      assert.equal(fake.requests.length, 4);
    }, 150);
  });
}

test("an unreachable upstream also resolves to null", async () => {
  const deps = { client: createJevClient({ apiKey, baseUrl: "http://127.0.0.1:1" }), settings: ON };
  assert.equal(await adviseIntent({ message: "hi", hasPlan: false, hasPrd: false, hasTasks: false }, deps), null);
});

test("inactive settings never reach the upstream", async () => {
  await withFake(() => answersReply({}), async (fake, deps) => {
    const variants: JevSettingsPublic[] = [
      { ...ON, enabled: false },
      { ...ON, hasKey: false },
      { ...ON, features: { intentRouting: false, intakeCheck: false, permissionRisk: false, dependencyCheck: false } },
    ];
    for (const settings of variants) {
      const inactive = { ...deps, settings };
      assert.equal(await adviseIntent({ message: "build it", hasPlan: false, hasPrd: false, hasTasks: false }, inactive), null);
      assert.equal(await adviseIntake({ description: "a todo app" }, inactive), null);
      assert.equal(await adviseApproval({ command: "rm -rf build" }, inactive), null);
      assert.equal(await adviseDependencies(sampleTasks(), inactive), null);
    }
    // No settings passed: the (default-off) database settings apply, even with a client injected.
    const { settings: _settings, ...clientOnly } = deps;
    assert.equal(await adviseIntent({ message: "build it", hasPlan: false, hasPrd: false, hasTasks: false }, clientOnly), null);
    assert.equal(fake.requests.length, 0);
  });
});

test("one feature off does not block the others", async () => {
  await withFake(() => answersReply({ risk: scoreAnswer(2) }), async (fake, deps) => {
    const settings = { ...ON, features: { ...ON.features, intentRouting: false } };
    assert.equal(await adviseIntent({ message: "hi", hasPlan: false, hasPrd: false, hasTasks: false }, { ...deps, settings }), null);
    assert.equal((await adviseApproval({ command: "rm -rf /" }, { ...deps, settings }))?.risk, "high");
    assert.equal(fake.requests.length, 1);
  });
});

test("without an injected client the saved key and the default endpoint are used", async () => {
  const realFetch = globalThis.fetch;
  const calls: Array<{ url: string; authorization: string | null }> = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), authorization: new Headers(init?.headers).get("authorization") });
    return new Response(JSON.stringify({ answers: { intent: choiceAnswer("chat", 0.6) } }), { status: 200 });
  }) as typeof fetch;
  try {
    const message = { message: "hello", hasPlan: false, hasPrd: false, hasTasks: false };
    assert.equal(await adviseIntent(message), null, "off by default");
    assert.equal(calls.length, 0);

    updateJevSettings({ enabled: true, apiKey, features: { intentRouting: true } });
    assert.deepEqual(await adviseIntent(message), { intent: "chat", confidence: 0.6 });
    assert.deepEqual(calls, [{ url: "https://api.typesafe.ai/v1/systemone", authorization: `Bearer ${apiKey}` }]);

    updateJevSettings({ apiKey: "" });
    assert.equal(await adviseIntent(message), null, "no key, no call");
    assert.equal(calls.length, 1);
  } finally {
    globalThis.fetch = realFetch;
    updateJevSettings({ enabled: false, apiKey: "", features: { intentRouting: false } });
  }
});

test("a failing call logs neither the key nor the judged text", async () => {
  const judged = `judged-${randomUUID()}`;
  const sink: string[] = [];
  const methods = ["log", "info", "warn", "error", "debug"] as const;
  const originals = methods.map((name) => console[name]);
  for (const name of methods) console[name] = (...args: unknown[]) => void sink.push(args.map(String).join(" "));
  try {
    await withFake(() => ({ status: 401, json: { error: `${apiKey} ${judged}` } }), async (_fake, deps) => {
      assert.equal(await adviseIntent({ message: judged, hasPlan: false, hasPrd: false, hasTasks: false }, deps), null);
      assert.equal(await adviseApproval({ command: judged }, deps), null);
    });
  } finally {
    methods.forEach((name, index) => { console[name] = originals[index]; });
  }
  const output = sink.join("\n");
  assert.ok(!output.includes(apiKey) && !output.includes(judged));
});
