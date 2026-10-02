import assert from "node:assert/strict";
import test from "node:test";

import { makeT, type TFunction } from "../../lib/i18n.tsx";
import { isServerTerminalNote, localizeToolText, RESULT_TEMPLATES, rendererFor } from "./toolRenderers.tsx";
import { RESULT_MESSAGES, resultMessage, type ResultMessage } from "../../../shared/resultMessages.ts";

// The real dictionary lives in i18n.tsx; this one only needs the shapes the
// helper has to handle: a plain key and keys with {name} placeholders.
const DICTIONARY: Record<string, string> = {
  "The request was cancelled.": "Permintaan dibatalkan.",
  "Session {id} not found.": "Sesi {id} tidak ditemukan.",
  "Reached the limit of {count} tool rounds without a final answer.": "Batas {count} putaran tool tercapai tanpa jawaban akhir.",
  "Status \"{status}\" is not recognized. Use one of: {allowed}.": "Status \"{status}\" tidak dikenal. Pakai salah satu dari: {allowed}.",
  "MCP server '{name}' could not be reached: {detail}": "Server MCP '{name}' tidak bisa dihubungi: {detail}",
  "Read project": "Baca proyek",
};
const t: TFunction = (key, vars) =>
  (DICTIONARY[key] ?? key).replace(/\{(\w+)\}/g, (whole, name) => (vars && name in vars ? String(vars[name]) : whole));

test("a server message with no values translates by its exact text", () => {
  assert.equal(localizeToolText(t, "The request was cancelled."), "Permintaan dibatalkan.");
});

test("a server message with values translates through its template", () => {
  assert.equal(localizeToolText(t, "Session abc-123 not found."), "Sesi abc-123 tidak ditemukan.");
  assert.equal(
    localizeToolText(t, "Reached the limit of 12 tool rounds without a final answer."),
    "Batas 12 putaran tool tercapai tanpa jawaban akhir.",
  );
  assert.equal(
    localizeToolText(t, 'Status "blocked" is not recognized. Use one of: todo, in_progress, done.'),
    'Status "blocked" tidak dikenal. Pakai salah satu dari: todo, in_progress, done.',
  );
  assert.equal(
    localizeToolText(t, "MCP server 'files' could not be reached: connection refused\nsecond line"),
    "Server MCP 'files' tidak bisa dihubungi: connection refused\nsecond line",
  );
});

test("text the dictionary does not know passes through unchanged", () => {
  assert.equal(localizeToolText(t, "ENOENT: no such file or directory"), "ENOENT: no such file or directory");
  assert.equal(localizeToolText(t, "Session abc-123 not found. Try later."), "Session abc-123 not found. Try later.");
});

test("a tool card title takes the translator and defaults to English", () => {
  assert.equal(rendererFor("get_project").title({}, undefined, t), "Baca proyek");
  assert.equal(rendererFor("get_project").title({}), "Read project");
});

test("every server message template has an Indonesian entry in the real dictionary", () => {
  const id = makeT("id");
  const missing = RESULT_TEMPLATES.filter((template) => id(template) === template);
  assert.deepEqual(missing, []);
});

test("every message the server builds from the catalog is translated, values kept", () => {
  const id = makeT("id");
  const values = { id: "TASK-07", count: 12, name: "github", seconds: 120, status: "doing", allowed: "todo, done", role: "prd", detail: "ECONNREFUSED" };
  for (const key of Object.keys(RESULT_MESSAGES) as ResultMessage[]) {
    const message = resultMessage(key, values);
    const shown = localizeToolText(id, message);
    assert.notEqual(shown, message, key);
    for (const name of RESULT_MESSAGES[key].match(/\{(\w+)\}/g) ?? []) {
      const value = String(values[name.slice(1, -1) as keyof typeof values]);
      assert.ok(shown.includes(value), `${key} lost ${name}: ${shown}`);
    }
  }
});

test("the MCP tool-limit notice has an Indonesian translation", () => {
  const message = "Tool limit of 100 reached; some MCP tools were dropped from this turn.";
  assert.notEqual(localizeToolText(makeT("id"), message), message);
});

test("only the server's own terminal notes are eligible for translation", () => {
  assert.equal(isServerTerminalNote("...[truncated]"), true);
  assert.equal(isServerTerminalNote("Stopped after 30 seconds."), true);
  // Real command output must never be rewritten, even when it equals a UI word.
  for (const line of ["Settings", "Name", "Save", "Session 42 not found.", "Build 12 tasks generated."]) {
    assert.equal(isServerTerminalNote(line), false);
  }
});
