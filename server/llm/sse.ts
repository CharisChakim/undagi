// Copyright (c) 2026 Charis Chakim - Undagi (https://github.com/CharisChakim/undagi)
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

export interface SseFrame { event?: string; data: string }

function parseFrame(raw: string): SseFrame | undefined {
  let event: string | undefined;
  const data: string[] = [];
  let hasEvent = false;

  for (const line of raw.split(/\r?\n/)) {
    if (line.startsWith(":")) continue;
    if (line.startsWith("event:")) {
      event = line.slice(6).startsWith(" ") ? line.slice(7) : line.slice(6);
      hasEvent = true;
    } else if (line.startsWith("data:")) {
      data.push(line.slice(5).startsWith(" ") ? line.slice(6) : line.slice(5));
    }
  }

  // Komentar heartbeat tidak punya data maupun event, sehingga tidak boleh
  // sampai ke adapter dan dianggap sebagai respons model kosong.
  if (!hasEvent && data.length === 0) return undefined;
  return { ...(event === undefined ? {} : { event }), data: data.join("\n") };
}

export async function* sseFrames(body: ReadableStream<Uint8Array>): AsyncGenerator<SseFrame> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      while (true) {
        const boundary = buffer.match(/\r?\n\r?\n/);
        if (!boundary || boundary.index === undefined) break;
        const raw = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary[0].length);
        const frame = parseFrame(raw);
        if (frame) yield frame;
      }
    }

    buffer += decoder.decode();
    const frame = parseFrame(buffer);
    if (frame) yield frame;
  } finally {
    reader.releaseLock();
  }
}
