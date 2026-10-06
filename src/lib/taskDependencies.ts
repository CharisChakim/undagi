// Copyright (c) 2026 Charis Chakim - Undagi (https://github.com/CharisChakim/undagi)
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import type { AgentTask } from "../types";

/**
 * Dependencies of a task that are still open: tasks in the same project that
 * are not done. An id that names no task cannot be satisfied and is ignored.
 */
export function openDependencies(task: Pick<AgentTask, "dependencies">, tasks: Pick<AgentTask, "id" | "status">[]): string[] {
  return (task.dependencies ?? []).filter((id) => tasks.some((other) => other.id === id && other.status !== "done"));
}
