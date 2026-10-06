// Copyright (c) 2026 Charis Chakim - Undagi (https://github.com/CharisChakim/undagi)
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import assert from "node:assert/strict";
import test from "node:test";

import { BUG_DESCRIPTION_MAX, BUG_REPORT_REPOSITORY, BUG_TITLE_MAX, bugReportUrl, isBugReportComplete } from "./bugReport";

function parse(url: string) {
  const parsed = new URL(url);
  return { origin: parsed.origin, path: parsed.pathname, params: parsed.searchParams };
}

test("a report opens the new-issue page of the project with the title and description filled in", () => {
  const { origin, path, params } = parse(bugReportUrl({ title: "  Board is empty  ", description: "Steps:\n1. Open it & wait" }, "1.0.3-beta"));

  assert.equal(origin, "https://github.com");
  assert.equal(path, `/${BUG_REPORT_REPOSITORY}/issues/new`);
  assert.equal(params.get("title"), "Board is empty");
  assert.equal(params.get("body"), "Steps:\n1. Open it & wait\n\n---\nUndagi 1.0.3-beta");
  assert.equal(params.get("labels"), "bug");
});

test("a report needs both a title and a description", () => {
  assert.equal(isBugReportComplete({ title: "x", description: "y" }), true);
  assert.equal(isBugReportComplete({ title: "  ", description: "y" }), false);
  assert.equal(isBugReportComplete({ title: "x", description: "\n " }), false);
});

test("an over-long report is cut to the limits and the link stays within what GitHub accepts", () => {
  const long = bugReportUrl({ title: "t".repeat(500), description: "d".repeat(9_000) }, "1.0.3-beta");
  const { params } = parse(long);

  assert.equal(params.get("title")!.length, BUG_TITLE_MAX);
  assert.ok(params.get("body")!.length <= BUG_DESCRIPTION_MAX + 40);

  const heavy = bugReportUrl({ title: "bug", description: "é&\n".repeat(900) }, "1.0.3-beta");
  assert.ok(heavy.length <= 7_000, `url is ${heavy.length} long`);
  assert.ok(parse(heavy).params.get("body")!.endsWith("---\nUndagi 1.0.3-beta"), "the version line is kept");
});
