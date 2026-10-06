// Copyright (c) 2026 Charis Chakim - Undagi (https://github.com/CharisChakim/undagi)
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import assert from "node:assert/strict";
import test, { afterEach, beforeEach } from "node:test";

import { loadLayout, saveLayout } from "./layout.ts";

const NEW_KEY = "undagi_layout";
const OLD_KEY = "architech_layout";

// Tes jalan tanpa DOM, jadi localStorage diganti Map sederhana.
let store: Map<string, string>;
const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");

beforeEach(() => {
  store = new Map();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
    },
  });
});

afterEach(() => {
  if (original) Object.defineProperty(globalThis, "localStorage", original);
  else delete (globalThis as { localStorage?: unknown }).localStorage;
});

test("loads the old key when the new one is absent", () => {
  store.set(OLD_KEY, JSON.stringify({ mode: "board", ratio: 0.6 }));
  assert.deepEqual(loadLayout(), { mode: "board", ratio: 0.6 });
});

test("prefers the new key over the old one", () => {
  store.set(OLD_KEY, JSON.stringify({ mode: "board", ratio: 0.6 }));
  store.set(NEW_KEY, JSON.stringify({ mode: "agent", ratio: 0.3 }));
  assert.deepEqual(loadLayout(), { mode: "agent", ratio: 0.3 });
});

test("saves to the new key only and leaves the old key untouched", () => {
  const legacy = JSON.stringify({ mode: "board", ratio: 0.6 });
  store.set(OLD_KEY, legacy);

  saveLayout({ mode: "agent", ratio: 0.5 });

  assert.equal(store.get(OLD_KEY), legacy);
  assert.deepEqual(JSON.parse(store.get(NEW_KEY) ?? "null"), { mode: "agent", ratio: 0.5, lastMode: "agent" });
});

test("keeps lastMode from the old key when saving split for the first time", () => {
  store.set(OLD_KEY, JSON.stringify({ mode: "board", ratio: 0.6 }));

  saveLayout({ mode: "split", ratio: 0.5 });

  assert.deepEqual(JSON.parse(store.get(NEW_KEY) ?? "null"), { mode: "split", ratio: 0.5, lastMode: "board" });
});

test("falls back to defaults when storage throws", () => {
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: () => {
        throw new Error("unavailable");
      },
      setItem: () => {
        throw new Error("unavailable");
      },
    },
  });
  const warn = console.warn;
  console.warn = () => {};
  try {
    assert.deepEqual(loadLayout(), { mode: "agent", ratio: 0.42 });
    assert.doesNotThrow(() => saveLayout({ mode: "agent", ratio: 0.5 }));
  } finally {
    console.warn = warn;
  }
});
