import assert from "node:assert/strict";
import test from "node:test";

import { makeT } from "../lib/i18n.tsx";
import { JEV_OFF } from "../lib/jev.ts";
import { jevFeaturesEditable, jevOrOff, jevTestOutcome } from "./agentSettingsJev.ts";

const t = makeT("en");

test("feature switches need Jev on and a saved key", () => {
  assert.equal(jevFeaturesEditable({ enabled: false, hasKey: false }), false);
  assert.equal(jevFeaturesEditable({ enabled: true, hasKey: false }), false);
  assert.equal(jevFeaturesEditable({ enabled: false, hasKey: true }), false);
  assert.equal(jevFeaturesEditable({ enabled: true, hasKey: true }), true);
});

test("jevOrOff keeps valid settings and falls back to off otherwise", () => {
  const on = { enabled: true, hasKey: true, features: { intentRouting: true, intakeCheck: false, permissionRisk: false, dependencyCheck: false } };
  assert.equal(jevOrOff(on), on);
  for (const bad of [null, undefined, {}, "x", { enabled: true, hasKey: true }, { enabled: true, hasKey: true, features: null }]) {
    assert.equal(jevOrOff(bad), JEV_OFF);
  }
});

test("jevTestOutcome formats success, failure and odd responses", () => {
  assert.deepEqual(jevTestOutcome({ ok: true, latencyMs: 182.4 }, t), { ok: true, text: "Connected · 182 ms" });
  assert.deepEqual(jevTestOutcome({ ok: true }, t), { ok: true, text: "Connected" });
  assert.deepEqual(jevTestOutcome({ ok: false, error: "Invalid key" }, t), { ok: false, text: "Invalid key" });
  assert.deepEqual(jevTestOutcome({ ok: false, error: "  " }, t), { ok: false, text: "Connection failed." });
  assert.deepEqual(jevTestOutcome(null, t), { ok: false, text: "Connection failed." });
});
