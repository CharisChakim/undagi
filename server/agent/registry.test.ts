import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// registry.ts reaches db.ts, which reads this when it is first imported, so
// everything that touches the database is loaded after the directory exists.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "undagi-agent-registry-test-"));
process.env.UNDAGI_DATA_DIR = dataDir;

const { db } = await import("../../db.ts");
// Windows will not delete a database file that is still open.
process.on("exit", () => {
  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});
const { DEFAULT_LIMITS, dispatch, toolsFor } = await import("./registry.ts");
const { languageFor } = await import("./tools/pipeline.ts");
type ToolContext = import("./registry.ts").ToolContext;
type ToolSpec = import("./registry.ts").ToolSpec;

const INDONESIAN_WORDS = /\b(yang|dan|untuk|dengan|tidak|atau|pada|dari|berkas|jangan|harus|belum|sudah|pengguna|perintah)\b/i;

function context(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    sessionId: null,
    session: { workspaceRoot: dataDir, allowShell: true },
    limits: DEFAULT_LIMITS,
    elicit: async () => false,
    signal: new AbortController().signal,
    ...overrides,
  };
}

function descriptions(value: unknown, found: string[] = []): string[] {
  if (Array.isArray(value)) {
    value.forEach((item) => descriptions(item, found));
  } else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if (key === "description" && typeof item === "string") found.push(item);
      else descriptions(item, found);
    }
  }
  return found;
}

test("every built-in tool and parameter description is English", () => {
  // A project session with a folder and the shell unlocks every built-in tool.
  const specs = toolsFor({ id: "session-1", workspaceRoot: dataDir, allowShell: true });
  const names = specs.map((spec) => spec.def.name);
  for (const expected of ["get_project", "read_file", "run_command", "generate_plan", "ask_followups"]) {
    assert.ok(names.includes(expected), `${expected} is offered`);
  }

  for (const spec of specs) {
    for (const text of [spec.def.description, ...descriptions(spec.def.parameters)]) {
      assert.ok(text && !INDONESIAN_WORDS.test(text), `${spec.def.name}: ${text}`);
    }
  }
});

test("a tool run receives the request's languages", async () => {
  let seen: Pick<ToolContext, "lang" | "agentLang"> | undefined;
  const probe: ToolSpec = {
    def: { name: "probe", description: "Records its context.", parameters: { type: "object", properties: {} } },
    available: () => true,
    run: async (_input, ctx) => {
      seen = { lang: ctx.lang, agentLang: ctx.agentLang };
      return { ok: true };
    },
  };

  await dispatch("probe", {}, context({ lang: "id", agentLang: "en" }), [probe]);
  assert.deepEqual(seen, { lang: "id", agentLang: "en" });

  await dispatch("probe", {}, context(), [probe]);
  assert.deepEqual(seen, { lang: undefined, agentLang: undefined });
});

test("chat tools write in the UI language and default to English", () => {
  assert.equal(languageFor({ lang: "id" }), "id");
  assert.equal(languageFor({ lang: "en" }), "en");
  assert.equal(languageFor({}), "en");
  assert.equal(languageFor({ lang: "fr" as any }), "en");
});

test("errors handed back to the model are English", async () => {
  const [runCommand] = toolsFor({ workspaceRoot: dataDir, allowShell: true }).filter(
    (spec) => spec.def.name === "run_command",
  );
  const readFile = toolsFor({ workspaceRoot: dataDir }).find((spec) => spec.def.name === "read_file")!;
  const specs = [runCommand, readFile];

  assert.deepEqual(await dispatch("run_command", { command: "  " }, context(), specs), {
    error: "The command is empty.",
  });
  assert.deepEqual(await dispatch("read_file", { file: "../outside.txt" }, context(), specs), {
    error: "Path ../outside.txt is outside the working folder.",
  });
  assert.deepEqual(await dispatch("no_such_tool", {}, context(), specs), {
    error: "Tool no_such_tool is not recognized.",
  });
  assert.deepEqual(
    await dispatch("run_command", { command: "echo hi" }, context({ session: { workspaceRoot: dataDir } }), specs),
    { error: "Running commands is not allowed for this project yet." },
  );
  assert.deepEqual(await dispatch("run_command", {}, context({ session: null }), specs), {
    error: "The conversation context is not available.",
  });

  const aborted = new AbortController();
  aborted.abort();
  assert.deepEqual(await dispatch("read_file", { file: "a.txt" }, context({ signal: aborted.signal }), specs), {
    error: "The request was cancelled.",
  });
});
