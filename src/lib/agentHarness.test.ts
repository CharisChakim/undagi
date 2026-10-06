// Copyright (c) 2026 Charis Chakim - Undagi (https://github.com/CharisChakim/undagi)
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import assert from "node:assert/strict";
import test, { afterEach, beforeEach } from "node:test";

import {
  agentLanguageFor,
  DEFAULT_AGENT_HARNESS_SETTINGS,
  loadAgentHarnessSettings,
  saveAgentHarnessSettings,
} from "./agentHarness.ts";

const KEY = "ai_plan_architect_agent_harness_v1";

// Tes jalan tanpa DOM, jadi localStorage diganti Map sederhana.
let store: Map<string, string>;
const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
const originalWarn = console.warn;

beforeEach(() => {
  store = new Map();
  console.warn = () => {};
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
    },
  });
});

afterEach(() => {
  console.warn = originalWarn;
  if (original) Object.defineProperty(globalThis, "localStorage", original);
  else delete (globalThis as { localStorage?: unknown }).localStorage;
});

test("defaults: efficiency layers on, agent instructions not following the UI", () => {
  assert.deepEqual(loadAgentHarnessSettings(), {
    compactTerminal: true,
    conciseAnswers: true,
    minimalCode: true,
    karpathyGuidelines: true,
    agentInstructionsFollowUi: false,
  });
  assert.equal(DEFAULT_AGENT_HARNESS_SETTINGS.agentInstructionsFollowUi, false);
});

test("an old stored object without the key loads with it false", () => {
  store.set(KEY, JSON.stringify({ compactTerminal: false, conciseAnswers: true, minimalCode: true, karpathyGuidelines: true }));
  const settings = loadAgentHarnessSettings();
  assert.equal(settings.agentInstructionsFollowUi, false);
  assert.equal(settings.compactTerminal, false);
});

test("only a literal true turns the setting on", () => {
  for (const value of ["true", 1, null, "yes"]) {
    store.set(KEY, JSON.stringify({ agentInstructionsFollowUi: value }));
    assert.equal(loadAgentHarnessSettings().agentInstructionsFollowUi, false);
  }
});

test("round trip keeps agentInstructionsFollowUi true", () => {
  saveAgentHarnessSettings({ ...DEFAULT_AGENT_HARNESS_SETTINGS, agentInstructionsFollowUi: true });
  assert.equal(loadAgentHarnessSettings().agentInstructionsFollowUi, true);
  saveAgentHarnessSettings({ ...DEFAULT_AGENT_HARNESS_SETTINGS, agentInstructionsFollowUi: false });
  assert.equal(loadAgentHarnessSettings().agentInstructionsFollowUi, false);
});

test("malformed JSON falls back to the defaults", () => {
  store.set(KEY, "{not json");
  assert.deepEqual(loadAgentHarnessSettings(), DEFAULT_AGENT_HARNESS_SETTINGS);
});

test("agentLanguageFor maps the toggle to the wire value", () => {
  assert.equal(agentLanguageFor({ agentInstructionsFollowUi: true }), "ui");
  assert.equal(agentLanguageFor({ agentInstructionsFollowUi: false }), "en");
  assert.equal(agentLanguageFor(DEFAULT_AGENT_HARNESS_SETTINGS), "en");
});
