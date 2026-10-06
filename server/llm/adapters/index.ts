// Copyright (c) 2026 Charis Chakim - Undagi (https://github.com/CharisChakim/undagi)
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import type { Connection, LlmFormat, LlmRequest, LlmAdapter } from "../types.ts";
import { anthropicAdapter } from "./anthropic.ts";
import { openaiAdapter } from "./openai.ts";

type LegacyRequest = {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
};

function normalizeAdapter(adapter: any): LlmAdapter {
  return {
    format: adapter.format,
    buildRequest(conn: Connection, req: LlmRequest, stream: boolean) {
      const request = adapter.buildRequest(conn, req, stream) as
        | ReturnType<LlmAdapter["buildRequest"]>
        | LegacyRequest;
      if ("init" in request) return request;
      return {
        url: request.url,
        init: {
          method: "POST",
          headers: request.headers,
          body: JSON.stringify(request.body),
          signal: req.signal,
        },
      };
    },
    parseResponse: adapter.parseResponse,
    streamEvents: adapter.streamEvents,
  };
}

export function getAdapter(format: LlmFormat): LlmAdapter {
  // Format tidak dikenal tidak boleh diam-diam jatuh ke provider lain karena
  // body dan header yang salah bisa terlihat seperti kredensial atau endpoint rusak.
  if (format === "anthropic") return normalizeAdapter(anthropicAdapter);
  if (format === "openai") return normalizeAdapter(openaiAdapter);
  throw new Error(`Unsupported LLM format: ${format}`);
}
