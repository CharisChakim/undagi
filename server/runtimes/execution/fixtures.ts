// Copyright (c) 2026 Charis Chakim - Undagi (https://github.com/CharisChakim/undagi)
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

/** Non-secret app-server JSONL fixtures. They never contain a model prompt. */

export const INITIALIZE_RESPONSE_FIXTURE = JSON.stringify({ id: 1, result: {} });

export const THREAD_START_RESPONSE_FIXTURE = JSON.stringify({
  id: 2,
  result: { thread: { id: "thread_fixture" } },
});

export const TURN_START_RESPONSE_FIXTURE = JSON.stringify({
  id: 3,
  result: { turn: { id: "turn_fixture" } },
});

export const TURN_EVENT_FIXTURES = [
  JSON.stringify({ method: "item/agentMessage/delta", params: { threadId: "thread_fixture", turnId: "turn_fixture", itemId: "item_fixture", delta: "fixture text" } }),
  JSON.stringify({ method: "item/started", params: { threadId: "thread_fixture", turnId: "turn_fixture", item: { id: "tool_fixture", type: "commandExecution", status: "inProgress", command: "fixture" } } }),
  JSON.stringify({ method: "turn/completed", params: { threadId: "thread_fixture", turn: { id: "turn_fixture", status: "completed" } } }),
];

export const APPROVAL_REQUEST_FIXTURE = JSON.stringify({
  id: 99,
  method: "item/commandExecution/requestApproval",
  params: {
    threadId: "thread_fixture",
    turnId: "turn_fixture",
    itemId: "tool_fixture",
    command: "fixture",
    cwd: "/workspace/fixture",
    reason: "fixture approval",
  },
});
