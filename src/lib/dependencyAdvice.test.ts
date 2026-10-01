import assert from "node:assert/strict";
import test from "node:test";

import { pendingDependencyAdvice } from "./dependencyAdvice";

const board = [
  { id: "T1", dependencies: [] as string[] },
  { id: "T2", dependencies: ["T1"] },
  { id: "T3", dependencies: [] as string[] },
  { id: "T4", dependencies: [] as string[] },
];
const pair = (taskId: string, dependsOn: string, probability: number) => ({ taskId, dependsOn, probability });

test("empty, missing and unusable advice give nothing", () => {
  assert.deepEqual(pendingDependencyAdvice([], board), []);
  assert.deepEqual(pendingDependencyAdvice(null, board), []);
  assert.deepEqual(pendingDependencyAdvice(undefined, board), []);
  assert.deepEqual(pendingDependencyAdvice([pair("T4", "T3", 0.9)], []), []);
  assert.deepEqual(pendingDependencyAdvice([pair("T4", "T3", Number.NaN)], board), []);
});

test("pairs already linked in either direction are dropped", () => {
  const advice = [pair("T2", "T1", 0.95), pair("T1", "T2", 0.8), pair("T4", "T3", 0.7)];
  assert.deepEqual(pendingDependencyAdvice(advice, board), [pair("T4", "T3", 0.7)]);
});

test("unknown ids and self-pairs are dropped", () => {
  const advice = [pair("T9", "T1", 0.9), pair("T3", "T9", 0.9), pair("T3", "T3", 0.99), pair("T4", "T3", 0.5)];
  assert.deepEqual(pendingDependencyAdvice(advice, board), [pair("T4", "T3", 0.5)]);
});

test("a task with missing dependencies still works", () => {
  const sparse = [{ id: "A" }, { id: "B", dependencies: ["A"] }] as unknown as typeof board;
  assert.deepEqual(pendingDependencyAdvice([pair("A", "B", 0.9)], sparse), []);
  assert.deepEqual(pendingDependencyAdvice([pair("B", "A", 0.9)], sparse), []);
});

test("likeliest first, ties in board order", () => {
  const advice = [pair("T4", "T1", 0.6), pair("T3", "T1", 0.91), pair("T4", "T3", 0.6), pair("T3", "T4", 0.2)];
  assert.deepEqual(pendingDependencyAdvice(advice, board), [pair("T3", "T1", 0.91), pair("T4", "T1", 0.6), pair("T4", "T3", 0.6)]);
});

test("one row per pair of tasks: the likelier direction wins, exact repeats collapse", () => {
  const advice = [pair("T3", "T4", 0.4), pair("T4", "T3", 0.8), pair("T4", "T3", 0.8)];
  assert.deepEqual(pendingDependencyAdvice(advice, board), [pair("T4", "T3", 0.8)]);
});

test("does not modify the advice or the tasks", () => {
  const advice = [pair("T4", "T3", 0.5), pair("T3", "T1", 0.9)];
  const snapshot = JSON.stringify([advice, board]);
  pendingDependencyAdvice(advice, board);
  assert.equal(JSON.stringify([advice, board]), snapshot);
});
