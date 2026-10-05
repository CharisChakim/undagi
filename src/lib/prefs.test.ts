import assert from "node:assert/strict";
import test from "node:test";

import { flushPrefs, hydratePrefs, prefs } from "./prefs";

// Tests run without a DOM, so localStorage is a Map behind the Storage methods.
function installStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      get length() { return map.size; },
      key: (index: number) => [...map.keys()][index] ?? null,
      getItem: (key: string) => map.get(key) ?? null,
      setItem: (key: string, value: string) => { map.set(key, value); },
      removeItem: (key: string) => { map.delete(key); },
    },
  });
  return map;
}

function fakeServer(values: Record<string, string> | null) {
  const writes: Array<Record<string, string | null>> = [];
  const fetchImpl = (async (_input: unknown, init?: RequestInit) => {
    if (values === null) throw new TypeError("offline");
    if (init?.method === "PUT") {
      const body = JSON.parse(String(init.body)) as { values: Record<string, string | null> };
      writes.push(body.values);
      for (const [key, value] of Object.entries(body.values)) {
        if (value === null) delete values[key];
        else values[key] = value;
      }
      return new Response(null, { status: 204 });
    }
    return Response.json({ values });
  }) as typeof fetch;
  return { fetchImpl, writes, values };
}

test("before the server answers, preferences read and write localStorage", async () => {
  const local = installStorage({ ai_plan_architect_theme: "dark" });
  await hydratePrefs(fakeServer(null).fetchImpl);

  assert.equal(prefs.get("ai_plan_architect_theme"), "dark");
  prefs.set("ai_plan_architect_language", "id");
  assert.equal(local.get("ai_plan_architect_language"), "id");
});

test("the stored value wins over this browser's copy, and the copy follows it", async () => {
  const local = installStorage({ ai_plan_architect_theme: "dark" });
  const server = fakeServer({ undagi_prefs_imported_v1: "2026-10-04", ai_plan_architect_theme: "light" });
  await hydratePrefs(server.fetchImpl);

  assert.equal(prefs.get("ai_plan_architect_theme"), "light");
  assert.equal(local.get("ai_plan_architect_theme"), "light");
  assert.deepEqual(server.writes, [], "nothing is imported once the server has preferences from a browser");
});

test("the first load copies this browser's app keys to the server, not drafts, keys or other apps", async () => {
  installStorage({
    ai_plan_architect_language: "id",
    undagi_layout: "{\"mode\":\"board\"}",
    "ai_plan_architect_runtime_session_v1:s1:codex:c1": "thread-1",
    ai_plan_architect_theme: "dark",
    "ai_plan_architect_draft_v1:s1:chat": "half a sentence",
    ai_plan_architect_llm_config: "{\"apiKey\":\"secret\"}",
    other_app_token: "x",
  });
  const server = fakeServer({ ai_plan_architect_theme: "light" });
  await hydratePrefs(server.fetchImpl);

  assert.equal(server.writes.length, 1);
  const sent = server.writes[0];
  assert.deepEqual(Object.keys(sent).sort(), [
    "ai_plan_architect_language",
    "ai_plan_architect_runtime_session_v1:s1:codex:c1",
    "undagi_layout",
    "undagi_prefs_imported_v1",
  ]);
  assert.equal(prefs.get("ai_plan_architect_theme"), "light", "a value the server already had is kept");
  assert.equal(prefs.get("ai_plan_architect_language"), "id");
});

test("changes reach the server in one batch, in order, and a removal is sent as null", async () => {
  installStorage();
  const server = fakeServer({ undagi_prefs_imported_v1: "x" });
  await hydratePrefs(server.fetchImpl);

  prefs.set("ai_plan_architect_theme", "dark");
  prefs.set("ai_plan_architect_theme", "light");
  prefs.set("undagi_usage_prefs", "{}");
  prefs.remove("undagi_usage_prefs");
  prefs.set("ai_plan_architect_draft_v1:s1:chat", "typing");
  await flushPrefs();

  assert.deepEqual(server.writes, [{ ai_plan_architect_theme: "light", undagi_usage_prefs: null }]);
  assert.equal(server.values.ai_plan_architect_theme, "light");
  assert.equal(prefs.get("ai_plan_architect_draft_v1:s1:chat"), "typing", "a draft stays in this browser");
});
