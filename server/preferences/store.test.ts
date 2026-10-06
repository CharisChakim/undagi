// Copyright (c) 2026 Charis Chakim - Undagi (https://github.com/CharisChakim/undagi)
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// db.ts reads the data directory when it is first imported, so the store loads
// after the variable points at a fresh folder.
process.env.UNDAGI_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "undagi-prefs-test-"));
const { bootScript, listPreferences, parsePreferenceWrite, PreferenceInputError, writePreferences } = await import("./store.ts");

test("preferences are written, replaced and removed in one go", () => {
  writePreferences({ ai_plan_architect_theme: "dark", "undagi_layout": "{\"mode\":\"board\"}" });
  writePreferences({ ai_plan_architect_theme: "light", "ai_plan_architect_runtime_selection_v1:session_1": "{}" });
  writePreferences({ undagi_layout: null });

  assert.deepEqual(listPreferences(), {
    ai_plan_architect_theme: "light",
    "ai_plan_architect_runtime_selection_v1:session_1": "{}",
  });
});

test("only the app's own keys and string values up to 64 KB are accepted", () => {
  const code = (body: unknown) => {
    try {
      parsePreferenceWrite(body);
      return "ok";
    } catch (error) {
      return error instanceof PreferenceInputError ? error.code : "other";
    }
  };

  assert.equal(code({ values: { "ai_plan_architect_agent_conversation_v1:session%201": "c1" } }), "ok");
  assert.equal(code({ values: { architech_layout: null } }), "ok");
  assert.equal(code({ values: { other_app_token: "x" } }), "PREFERENCE_KEY_INVALID");
  assert.equal(code({ values: { "undagi_x/../y": "x" } }), "PREFERENCE_KEY_INVALID");
  assert.equal(code({ values: { undagi_layout: 3 } }), "PREFERENCE_VALUE_INVALID");
  assert.equal(code({ values: { undagi_layout: "x".repeat(64 * 1024 + 1) } }), "PREFERENCE_VALUE_INVALID");
  assert.equal(code({ values: [] }), "PREFERENCES_INVALID");
  assert.equal(code(null), "PREFERENCES_INVALID");
  const many = Object.fromEntries(Array.from({ length: 501 }, (_, index) => [`undagi_k${index}`, "v"]));
  assert.equal(code({ values: many }), "PREFERENCES_TOO_MANY");
});

// Runs the generated script against a stand-in for <html>, as a page would.
function runBoot(script: string) {
  const classes = new Set<string>();
  const root = { dataset: {} as Record<string, string>, classList: { add: (name: string) => classes.add(name) } };
  new Function("document", script)({ documentElement: root });
  return { classes: [...classes], dataset: root.dataset };
}

test("the boot script puts the saved theme and accent on the page before it is drawn", () => {
  assert.deepEqual(runBoot(bootScript({ ai_plan_architect_theme: "dark", ai_plan_architect_accent: "blue" })), {
    classes: ["dark"],
    dataset: { prefsTheme: "dark", accent: "blue" },
  });
  assert.deepEqual(runBoot(bootScript({ ai_plan_architect_theme: "light" })), { classes: [], dataset: { prefsTheme: "light" } });
});

test("the boot script leaves what it does not know to the page's fallback and never runs injected text", () => {
  assert.deepEqual(runBoot(bootScript({})), { classes: [], dataset: {} });
  assert.deepEqual(runBoot(bootScript({ ai_plan_architect_theme: "sepia" })), { classes: [], dataset: {} });
  const hostile = bootScript({ ai_plan_architect_theme: "dark\"+alert(1)+\"", ai_plan_architect_accent: "teal\";alert(1);//" });
  assert.equal(hostile.includes("alert"), false);
  assert.deepEqual(runBoot(hostile), { classes: [], dataset: {} });
});
