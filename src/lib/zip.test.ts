import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { buildZip } from "./zip";

test("a zip of two documents unpacks to the same names and text", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "zip-"));
  const file = join(dir, "bundle.zip");
  const entries = [
    { name: "PRD_app.md", content: "# PRD\nIsi dokumen — dengan karakter non-ASCII é" },
    { name: "AGENTS.md", content: "" },
  ];
  writeFileSync(file, buildZip(entries));

  try {
    execFileSync("unzip", ["-tq", file]);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return t.skip("unzip is not installed");
    throw error;
  }
  execFileSync("unzip", ["-qo", file, "-d", dir]);

  for (const entry of entries) assert.equal(readFileSync(join(dir, entry.name), "utf8"), entry.content);
});
