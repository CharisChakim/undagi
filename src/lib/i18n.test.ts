import assert from "node:assert/strict";
import test from "node:test";

import { makeT } from "./i18n";

test("the task-sync banner reads in both languages, with the count filled in", () => {
  const en = makeT("en");
  const id = makeT("id");

  assert.equal(en("{count} task needs sync.", { count: 1 }), "1 task needs sync.");
  assert.equal(en("{count} tasks need sync.", { count: 3 }), "3 tasks need sync.");
  assert.equal(id("{count} task needs sync.", { count: 1 }), "1 task perlu disinkronkan.");
  assert.equal(id("{count} tasks need sync.", { count: 3 }), "3 task perlu disinkronkan.");
  assert.equal(
    id("Review the task board and explicitly sync generated tasks to PRD v{version}.", { version: 2 }),
    "Tinjau papan task dan sinkronkan task hasil generate ke PRD v2 secara eksplisit.",
  );
  for (const key of ["Sync tasks", "Review task sync", "Needs sync"]) assert.notEqual(id(key), key);
});

test("the sync confirmation reads in Indonesian with both counts filled in", () => {
  const key = "Sync rebuilds the task board from the current PRD.\nReplaced (not started): {replaced}\nKept as they are (added by you or already worked on): {kept}\nContinue?";

  const text = makeT("id")(key, { replaced: 4, kept: 2 });

  assert.match(text, /Diganti \(belum dimulai\): 4/);
  assert.match(text, /Dipertahankan \(ditambahkan Anda atau sudah dikerjakan\): 2/);
});
