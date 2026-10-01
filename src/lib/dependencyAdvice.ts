import type { AgentTask } from "../types";
import type { DependencyAdvice } from "./jev";

/**
 * Jev's dependency advice, cut down to what is worth showing: both tasks still
 * exist, the pair is not already linked (either direction) and is not a task
 * with itself. One row per pair of tasks (the likelier direction wins),
 * likeliest first, ties in board order. Display only: nothing here edits a task.
 */
export function pendingDependencyAdvice(
  advice: readonly DependencyAdvice[] | null | undefined,
  tasks: readonly Pick<AgentTask, "id" | "dependencies">[],
): DependencyAdvice[] {
  if (!advice?.length) return [];
  const byId = new Map(tasks.map((task, index) => [task.id, { task, index }]));
  const linked = (a: string, b: string) =>
    (byId.get(a)?.task.dependencies ?? []).includes(b) || (byId.get(b)?.task.dependencies ?? []).includes(a);

  const bestPerPair = new Map<string, DependencyAdvice>();
  for (const item of advice) {
    if (!item || item.taskId === item.dependsOn) continue;
    if (!byId.has(item.taskId) || !byId.has(item.dependsOn)) continue;
    if (typeof item.probability !== "number" || !Number.isFinite(item.probability)) continue;
    if (linked(item.taskId, item.dependsOn)) continue;
    const key = [item.taskId, item.dependsOn].sort().join("\u0000");
    const seen = bestPerPair.get(key);
    if (!seen || item.probability > seen.probability) bestPerPair.set(key, item);
  }

  const position = (id: string) => byId.get(id)?.index ?? 0;
  return [...bestPerPair.values()].sort(
    (a, b) => b.probability - a.probability || position(a.taskId) - position(b.taskId) || position(a.dependsOn) - position(b.dependsOn),
  );
}
