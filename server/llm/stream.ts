// Copyright (c) 2026 Charis Chakim - Undagi (https://github.com/CharisChakim/undagi)
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { LlmError, msg } from "../messages.ts";
import { getAdapter } from "./adapters/index.ts";
import { sseFrames } from "./sse.ts";
import type { Connection, LlmRequest, StreamEvent } from "./types.ts";

export async function* streamLlm(conn: Connection, req: LlmRequest): AsyncGenerator<StreamEvent> {
  const adapter = getAdapter(conn.format);
  const request = adapter.buildRequest(conn, req, true);
  const response = await fetch(request.url, request.init);

  if (!response.ok) {
    const detail = await response.text();
    throw new LlmError(
      msg("en", "customEndpointError", {
        status: response.status,
        detail,
      }),
    );
  }
  if (!response.body) {
    throw new LlmError("LLM endpoint returned an empty streaming body.");
  }

  for await (const event of adapter.streamEvents(sseFrames(response.body))) {
    yield event;
  }
}
