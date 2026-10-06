// Copyright (c) 2026 Charis Chakim - Undagi (https://github.com/CharisChakim/undagi)
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import express, { type Request, type Response } from "express";

import { getSession } from "../../db.ts";
import { resolveInsideRoot } from "../agent/sandbox.ts";
import { runCommand } from "../agent/tools/shell.ts";

// The generator asks for a check of about two minutes; this leaves room for a
// slow first build without letting a hung command hold the card for long.
const VERIFY_TIMEOUT_MS = 5 * 60_000;
// The end of the output is where a test runner says what failed.
const OUTPUT_TAIL_CHARS = 8_000;

const router = express.Router();

function tail(text: string, limit: number): string {
  return text.length > limit ? `…${text.slice(-limit)}` : text;
}

/**
 * Runs a task's verify command in its project's working folder and says
 * whether it passed. The command is read from the saved task, never from the
 * request, so a client can only run what the board shows. The client asks the
 * user first, following the chat's permission mode.
 */
async function verify(req: Request, res: Response): Promise<void> {
  const sessionId = typeof req.body?.sessionId === "string" ? req.body.sessionId : "";
  const taskId = typeof req.body?.taskId === "string" ? req.body.taskId : "";
  const session = sessionId ? getSession(sessionId) : null;
  const task = Array.isArray(session?.tasks) ? session.tasks.find((item: any) => item?.id === taskId) : null;
  if (!task) {
    res.status(404).json({ error: "Task not found in this project." });
    return;
  }
  const command = typeof task.verifyCommand === "string" ? task.verifyCommand.trim() : "";
  if (!command) {
    res.status(409).json({ error: "This task has no verify command." });
    return;
  }
  const root = typeof session.workspaceRoot === "string" ? session.workspaceRoot.trim() : "";
  let cwd: string;
  try {
    if (!root) throw new Error("no root");
    cwd = await resolveInsideRoot(root, ".");
  } catch {
    res.status(409).json({ error: "This project has no working folder to run the command in." });
    return;
  }

  // Closing the request (Stop, or the page going away) stops the command.
  const stop = new AbortController();
  res.on("close", () => {
    if (!res.writableEnded) stop.abort();
  });
  const startedAt = Date.now();
  const result = await runCommand(command, cwd, VERIFY_TIMEOUT_MS, 1_000_000, stop.signal);
  const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
  res.json({
    command,
    exitCode: result.exitCode,
    passed: result.exitCode === 0,
    output: tail(output, OUTPUT_TAIL_CHARS),
    durationMs: Date.now() - startedAt,
  });
}

router.post("/api/tasks/verify", (req, res) => {
  void verify(req, res);
});

export default router;
