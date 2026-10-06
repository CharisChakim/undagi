// Copyright (c) 2026 Charis Chakim - Undagi (https://github.com/CharisChakim/undagi)
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRuntimeRunnerAsync, loadClaudeSdkModule, type RuntimeRunnerDependencies } from "../runtime-runner/index.ts";
import { discoverRuntime } from "../runtimes/discovery.ts";
import type { RuntimeId } from "../runtimes/types.ts";

/** The runtime and model the user picked for a pipeline step, as in the chat. */
export interface RuntimeTextTarget {
  runtime: RuntimeId;
  model: string;
  effort: string;
}

/** The empty folder pipeline steps run in. */
export const pipelineWorkspace = (): string => path.join(os.tmpdir(), "undagi-pipeline");

const text = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value.trim() : null;

export function parseRuntimeTarget(value: unknown): RuntimeTextTarget | null {
  if (!value || typeof value !== "object") return null;
  const target = value as Record<string, unknown>;
  if (target.runtime !== "codex" && target.runtime !== "claude" && target.runtime !== "antigravity") return null;
  return { runtime: target.runtime, model: text(target.model) ?? "inherit", effort: text(target.effort) ?? "inherit" };
}

export interface RuntimeTextOptions {
  target: RuntimeTextTarget;
  prompt: string;
  system: string;
  signal: AbortSignal;
  onProgress?: (chars: number) => void;
  discover?: typeof discoverRuntime;
  dependencies?: RuntimeRunnerDependencies;
}

/**
 * One runtime turn that only writes text. It runs in an empty folder and
 * every approval is declined, so the runtime cannot touch a project while it
 * drafts a plan, PRD, or task list. On Claude it also reads none of the
 * user's own settings: the plan is a document for this app, and a personal
 * CLAUDE.md once turned an English plan summary Indonesian.
 */
export async function generateRuntimeText(options: RuntimeTextOptions): Promise<string> {
  const { target } = options;
  // Claude is only "ready" once discovery can ask its SDK for the models,
  // as the chat route does.
  const claudeSdk = target.runtime === "claude"
    ? await (options.dependencies?.loadClaudeSdk ?? loadClaudeSdkModule)()
    : undefined;
  const detection = await (options.discover ?? discoverRuntime)(target.runtime, claudeSdk?.supportedModels
    ? { claudeSdk: { supportedModels: claudeSdk.supportedModels.bind(claudeSdk) } }
    : {});
  // One folder for every step, not a new one each time: Codex records each folder
  // it runs in as a trusted project in the user's own ~/.codex/config.toml, so a
  // new folder per step left a permanent entry there per plan, PRD and task run.
  // The step uses no tools and no files, so sharing an empty folder is safe.
  const cwd = pipelineWorkspace();
  await fs.mkdir(cwd, { recursive: true });
  let close: (() => Promise<void>) | null = null;
  try {
    const runner = await createRuntimeRunnerAsync({
      runtime: target.runtime,
      prompt: `${options.system}\n\nDo not use tools or read files. Reply with the requested output only.\n\n${options.prompt}`,
      model: target.model,
      effort: target.effort,
      cwd,
      detection,
      signal: options.signal,
      dependencies: options.dependencies,
      claudeSdk,
      approvalHandler: async () => "decline" as const,
      isolateSettings: true,
    });
    close = () => runner.executor.close();
    let output = "";
    for await (const event of runner.events) {
      if (options.signal.aborted) throw options.signal.reason ?? new Error("aborted");
      if (event.type === "text") {
        output += event.text;
        options.onProgress?.(output.length);
      } else if (event.type === "error" && event.fatal) {
        throw new Error(event.error.message);
      } else if (event.type === "done") {
        if (event.status !== "completed") throw new Error(event.error?.message ?? `${target.runtime} did not finish the step.`);
        break;
      }
    }
    return output;
  } finally {
    await close?.().catch(() => undefined);
  }
}
