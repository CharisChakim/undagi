import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { createJevClient, JevError, type JevQuestion } from "./client.ts";
import { answersReply, choiceAnswer, noulAnswer, scoreAnswer, startFakeJev, type FakeJev } from "./fixtures.ts";

const apiKey = `test-${randomUUID()}`;

const questions: Record<string, JevQuestion> = {
  yes: { type: "noul", instructions: "Is it?" },
  pick: { type: "choice", instructions: { thing: 1, question: "Which?" }, criteria: { a: "first", b: null } },
  rate: { type: "score", instructions: "How much?", criteria: ["low", "mid", "high"] },
};
const goodAnswers = {
  yes: noulAnswer(0.25),
  pick: choiceAnswer("b", 0.7, { a: 0.3, b: 0.7 }),
  rate: scoreAnswer(1.5, 0.6),
};

async function withFake(fn: (fake: FakeJev) => Promise<void>): Promise<void> {
  const fake = await startFakeJev(() => answersReply(goodAnswers));
  try {
    await fn(fake);
  } finally {
    await fake.close();
  }
}

async function rejection(promise: Promise<unknown>): Promise<JevError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof JevError, `expected JevError, got ${String(error)}`);
    return error;
  }
  assert.fail("expected the call to reject");
}

test("evaluate posts state, model and questions with a bearer key", async () => {
  await withFake(async (fake) => {
    const client = createJevClient({ apiKey: `  ${apiKey}  `, baseUrl: `${fake.url}/` });
    const answers = await client.evaluate({ hello: "world" }, questions);

    assert.equal(fake.requests.length, 1);
    const [request] = fake.requests;
    assert.equal(request.method, "POST");
    assert.equal(request.url, "/v1/systemone");
    assert.equal(request.headers.authorization, `Bearer ${apiKey}`);
    assert.match(String(request.headers["content-type"]), /application\/json/);
    assert.deepEqual(request.body, { state: { hello: "world" }, model: "jev-latest", questions });
    assert.deepEqual(answers, {
      yes: { type: "noul", noul: 0.25 },
      pick: { type: "choice", choice: "b", probabilities: { a: 0.3, b: 0.7 }, confidence: 0.7 },
      rate: { type: "score", score: 1.5, probabilities: {}, confidence: 0.6 },
    });
  });
});

test("evaluate tolerates float noise at the edges and clamps it", async () => {
  const fake = await startFakeJev(() =>
    answersReply({ yes: noulAnswer(1.0000001), rate: scoreAnswer(2.0000001, 1.0000001) }));
  try {
    const client = createJevClient({ apiKey, baseUrl: fake.url });
    const answers = await client.evaluate("x", { yes: questions.yes, rate: questions.rate });
    assert.deepEqual(answers.yes, { type: "noul", noul: 1 });
    assert.equal((answers.rate as { score: number }).score, 2);
    assert.equal((answers.rate as { confidence: number }).confidence, 1);
  } finally {
    await fake.close();
  }
});

test("evaluate without a key or questions never sends a request", async () => {
  await withFake(async (fake) => {
    await rejection(createJevClient({ apiKey: "   ", baseUrl: fake.url }).evaluate("x", questions));
    await rejection(createJevClient({ apiKey, baseUrl: fake.url }).evaluate("x", {}));
    assert.equal(fake.requests.length, 0);
  });
});

test("HTTP errors become JevError with the status and a safe message", async () => {
  const bodyMarker = `body-${randomUUID()}`;
  const fake = await startFakeJev();
  try {
    const client = createJevClient({ apiKey, baseUrl: fake.url });
    for (const status of [401, 422, 429, 529, 500]) {
      // The upstream body echoes both the key and a marker: neither may surface.
      fake.reply(() => ({ status, json: { error: `${bodyMarker} ${apiKey}` } }));
      const error = await rejection(client.evaluate({ secret: "state text" }, questions));
      assert.equal(error.status, status);
      assert.ok(error.message.includes(String(status)));
      for (const forbidden of [apiKey, bodyMarker, "state text"]) {
        assert.ok(!error.message.includes(forbidden), `message leaks ${forbidden}`);
      }
    }
  } finally {
    await fake.close();
  }
});

test("a slow upstream ends in a timeout error", async () => {
  const fake = await startFakeJev(() => ({ hang: true }));
  try {
    const started = Date.now();
    const error = await rejection(createJevClient({ apiKey, baseUrl: fake.url, timeoutMs: 150 }).evaluate("x", questions));
    assert.match(error.message, /timed out/);
    assert.equal(error.status, undefined);
    assert.ok(Date.now() - started < 3000);
  } finally {
    await fake.close();
  }
});

test("an unreachable host gives a generic message without the key", async () => {
  const error = await rejection(createJevClient({ apiKey, baseUrl: "http://127.0.0.1:1" }).evaluate("x", questions));
  assert.equal(error.message, "Could not reach Jev");
});

test("injected fetch is used instead of the global one", async () => {
  let seen = "";
  const fetchImpl = (async (url: string | URL | Request) => {
    seen = String(url);
    return new Response(JSON.stringify({ answers: { yes: noulAnswer(0.5) } }), { status: 200 });
  }) as typeof fetch;
  const answers = await createJevClient({ apiKey, fetchImpl }).evaluate("x", { yes: questions.yes });
  assert.equal(seen, "https://api.typesafe.ai/v1/systemone");
  assert.deepEqual(answers.yes, { type: "noul", noul: 0.5 });
});

test("malformed responses are rejected", async () => {
  const cases: Array<[string, () => { status?: number; json?: unknown; text?: string }]> = [
    ["not json", () => ({ text: "<html>gateway</html>" })],
    ["json without answers", () => ({ json: { model: "jev-1.13.0" } })],
    ["answers is an array", () => ({ json: { answers: [] } })],
    ["missing answer id", () => ({ json: { answers: { yes: noulAnswer(0.5), pick: goodAnswers.pick } } })],
    ["wrong answer type", () => ({ json: { answers: { ...goodAnswers, yes: scoreAnswer(0.5) } } })],
    ["noul as a string", () => ({ json: { answers: { ...goodAnswers, yes: { type: "noul", noul: "0.5" } } } })],
    ["noul above 1", () => ({ json: { answers: { ...goodAnswers, yes: noulAnswer(1.2) } } })],
    ["noul below 0", () => ({ json: { answers: { ...goodAnswers, yes: noulAnswer(-0.2) } } })],
    ["choice outside the options", () => ({ json: { answers: { ...goodAnswers, pick: choiceAnswer("zzz") } } })],
    ["choice without confidence", () => ({ json: { answers: { ...goodAnswers, pick: { type: "choice", choice: "a" } } } })],
    ["choice probability out of range", () => ({ json: { answers: { ...goodAnswers, pick: choiceAnswer("a", 0.5, { a: 3 }) } } })],
    ["score above the last level", () => ({ json: { answers: { ...goodAnswers, rate: scoreAnswer(2.5) } } })],
    ["score below 0", () => ({ json: { answers: { ...goodAnswers, rate: scoreAnswer(-0.5) } } })],
    ["confidence above 1", () => ({ json: { answers: { ...goodAnswers, rate: scoreAnswer(1, 1.5) } } })],
  ];
  const fake = await startFakeJev();
  try {
    const client = createJevClient({ apiKey, baseUrl: fake.url });
    for (const [label, reply] of cases) {
      fake.reply(reply);
      const error = await rejection(client.evaluate("x", questions));
      assert.equal(error.name, "JevError", label);
      assert.ok(!error.message.includes(apiKey), label);
    }
  } finally {
    await fake.close();
  }
});
