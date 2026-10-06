// Copyright (c) 2026 Charis Chakim - Undagi (https://github.com/CharisChakim/undagi)
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

/** Synthetic Claude Agent SDK messages used by the adapter contract tests. */

export const CLAUDE_STREAM_TEXT_FIXTURE = {
  type: "stream_event",
  event: {
    type: "content_block_delta",
    index: 0,
    delta: { type: "text_delta", text: "hello" },
  },
} as const;

export const CLAUDE_ASSISTANT_TOOL_FIXTURE = {
  type: "assistant",
  session_id: "session_fixture_1",
  message: {
    id: "message_fixture_1",
    role: "assistant",
    content: [{ type: "tool_use", id: "tool_fixture_1", name: "Read", input: { file_path: "README.md" } }],
  },
} as const;

export const CLAUDE_TOOL_PROGRESS_FIXTURE = {
  type: "tool_progress",
  tool_use_id: "tool_fixture_1",
  tool_name: "Read",
  elapsed_time_seconds: 0.25,
  output: { bytes: 42 },
} as const;

export const CLAUDE_RESULT_FIXTURE = {
  type: "result",
  subtype: "success",
  session_id: "session_fixture_1",
  result: "done",
  usage: { input_tokens: 3, output_tokens: 2 },
} as const;

export const CLAUDE_MALFORMED_FIXTURE = { event: "missing type" } as const;
