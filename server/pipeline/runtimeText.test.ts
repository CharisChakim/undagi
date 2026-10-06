// Copyright (c) 2026 Charis Chakim - Undagi (https://github.com/CharisChakim/undagi)
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import assert from "node:assert/strict";
import test from "node:test";

import type { ClaudeSdkQuery, ClaudeSdkQueryOptions } from "../runtimes/execution/claude.ts";
import type { RuntimeDetection } from "../runtimes/types.ts";
import { generateRuntimeText, pipelineWorkspace } from "./runtimeText.ts";

const claude: RuntimeDetection = {
  runtime: "claude",
  status: "ready",
  authStatus: "authenticated",
  binaryPath: "/fixture/claude",
  version: "fixture",
  checkedAt: new Date(0).toISOString(),
  capabilities: {
    structuredOutput: "unknown",
    toolUse: "supported",
    approval: "supported",
    resume: "supported",
    interrupt: "supported",
    usage: "unknown",
    streaming: "supported",
  },
  catalog: null,
  diagnostic: null,
};

test("a Claude pipeline step runs without the user's own settings", async () => {
  let options: ClaudeSdkQueryOptions | undefined;
  const reply: ClaudeSdkQuery = {
    async *[Symbol.asyncIterator]() {
      yield { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "plan" } } };
      yield { type: "result", subtype: "success", session_id: "claude_session_fixture", result: "plan" };
    },
  };
  const text = await generateRuntimeText({
    target: { runtime: "claude", model: "inherit", effort: "inherit" },
    prompt: "Plan it.",
    system: "You write plans.",
    signal: new AbortController().signal,
    discover: async () => claude,
    dependencies: {
      createCodexExecutor: () => { throw new Error("Codex is not used here."); },
      loadClaudeSdk: () => ({
        query: (request) => {
          options = request.options as ClaudeSdkQueryOptions;
          return reply;
        },
      }),
    },
  });
  assert.equal(text, "plan");
  assert.deepEqual(options?.settingSources, []);
});

test("every pipeline step runs in the same empty folder, so Codex records one project, not one per step", async () => {
  const folders: Array<string | undefined> = [];
  const run = () => generateRuntimeText({
    target: { runtime: "claude", model: "inherit", effort: "inherit" },
    prompt: "Plan it.",
    system: "You write plans.",
    signal: new AbortController().signal,
    discover: async () => claude,
    dependencies: {
      createCodexExecutor: () => { throw new Error("Codex is not used here."); },
      loadClaudeSdk: () => ({
        query: (request) => {
          folders.push((request.options as ClaudeSdkQueryOptions).cwd);
          return {
            async *[Symbol.asyncIterator]() {
              yield { type: "result", subtype: "success", session_id: "s", result: "ok" };
            },
          } as ClaudeSdkQuery;
        },
      }),
    },
  });

  await run();
  await run();

  assert.equal(folders.length, 2);
  assert.equal(folders[0], pipelineWorkspace());
  assert.equal(folders[1], folders[0]);
});
