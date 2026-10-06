// Copyright (c) 2026 Charis Chakim - Undagi (https://github.com/CharisChakim/undagi)
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import assert from "node:assert/strict";
import test from "node:test";

import type { AgentTask, PRDData } from "../types";
import {
  attachPrdVersionToTasks,
  hasProgress,
  markTasksNeedsSync,
  mergeGeneratedTasks,
  recordPrdVersion,
  syncImpact,
  taskNeedsPrdSync,
} from "./artifactVersions";

function prd(markdown: string): PRDData {
  return {
    projectTitle: "Harness",
    overview: "Overview",
    fullMarkdownText: markdown,
  } as PRDData;
}

function task(id: string): AgentTask {
  return {
    id,
    title: id,
    phase: "Build",
    priority: "Medium",
    dependencies: [],
    targetFiles: [],
    promptInstructions: "",
    verificationSteps: "",
  };
}

test("PRD versions are immutable, sequential, and deduplicated by content", () => {
  const first = recordPrdVersion(prd("# One"), [], new Date("2026-09-15T00:00:00Z"));
  const duplicate = recordPrdVersion(prd("# One"), first.versions, new Date("2026-09-15T01:00:00Z"));
  const second = recordPrdVersion(prd("# Two"), duplicate.versions, new Date("2026-09-15T02:00:00Z"));

  assert.equal(first.created, true);
  assert.equal(duplicate.created, false);
  assert.equal(duplicate.versions.length, 1);
  assert.equal(duplicate.version.id, first.version.id);
  assert.equal(second.version.number, 2);
  assert.deepEqual(second.versions.map((version) => version.status), ["superseded", "active"]);
  assert.equal(first.version.status, "active");
});

test("manual tasks survive generated ID collisions and dependencies follow renamed IDs", () => {
  const manual = task("api");
  const generatedApi = { ...task("api"), sourcePrdVersionId: "prd-1" };
  const generatedUi = { ...task("ui"), sourcePrdVersionId: "prd-1", dependencies: ["api"] };
  const merged = mergeGeneratedTasks([manual], [generatedApi, generatedUi]);

  assert.equal(merged[0], manual);
  assert.equal(merged[1]!.id, "api-generated-2");
  assert.deepEqual(merged[2]!.dependencies, ["api-generated-2"]);
});

test("generated tasks retain their PRD source and stale tasks require explicit sync", () => {
  const first = recordPrdVersion(prd("# One"));
  const generated = attachPrdVersionToTasks([task("generated")], first.version);
  const second = recordPrdVersion(prd("# Two"), first.versions);
  const marked = markTasksNeedsSync([...generated, task("manual")], second.version);

  assert.equal(taskNeedsPrdSync(marked[0]!, second.version), true);
  assert.equal(marked[0]!.syncStatus, "needs_sync");
  assert.equal(taskNeedsPrdSync(marked[1]!, second.version), false);
  assert.equal(marked[1]!.syncStatus, undefined);
});

test("a sync replaces unstarted generated cards but keeps worked-on and manual ones", () => {
  const first = recordPrdVersion(prd("# One"));
  const second = recordPrdVersion(prd("# Two"), first.versions);
  const generated = attachPrdVersionToTasks(
    [
      { ...task("done"), status: "done" as const, agentNote: "all green", verified: true },
      { ...task("busy"), status: "in_progress" as const },
      { ...task("fresh"), status: "todo" as const },
      { ...task("unset") },
    ],
    first.version,
  );
  const manual = { ...task("mine"), status: "todo" as const };
  const board = markTasksNeedsSync([...generated, manual], second.version);

  assert.deepEqual(syncImpact(board), { replaced: 2, kept: 3 });
  assert.equal(hasProgress(board[0]!), true);
  assert.equal(hasProgress(board[2]!), false);
  assert.equal(hasProgress(board[3]!), false);

  const rebuilt = attachPrdVersionToTasks([{ ...task("next"), status: "todo" as const }], second.version);
  const merged = mergeGeneratedTasks(board, rebuilt, second.version);

  assert.deepEqual(merged.map((item) => item.id), ["done", "busy", "mine", "next"]);
  // The kept card keeps what the run left on it and is no longer stale.
  assert.equal(merged[0]!.agentNote, "all green");
  assert.equal(merged[0]!.verified, true);
  assert.equal(merged[0]!.sourcePrdContentHash, second.version.contentHash);
  assert.equal(taskNeedsPrdSync(merged[0]!, second.version), false);
  assert.equal(merged[2], manual);
});

test("without a version a kept generated card keeps its old source", () => {
  const first = recordPrdVersion(prd("# One"));
  const [done] = attachPrdVersionToTasks([{ ...task("done"), status: "done" as const }], first.version);

  assert.equal(mergeGeneratedTasks([done!], [])[0], done);
});
