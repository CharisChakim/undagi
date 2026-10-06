// Copyright (c) 2026 Charis Chakim - Undagi (https://github.com/CharisChakim/undagi)
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import type { Request, Response } from "express";

export interface StreamRequestOptions {
  signal: AbortSignal;
  onProgress: (chars: number) => void;
}

type Generate = (options: StreamRequestOptions) => Promise<unknown>;

const PROGRESS_INTERVAL_MS = 250;

export function acceptsEventStream(req: Request): boolean {
  return (req.get("accept") ?? "")
    .split(",")
    .some((part) => part.split(";", 1)[0].trim().toLowerCase() === "text/event-stream");
}

function writeHeaders(res: Response): void {
  res.status(200).set({
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders();
}

function writeEvent(res: Response, event: string, payload: unknown): boolean {
  if (res.writableEnded || res.writableFinished) return false;
  try {
    res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
    return true;
  } catch {
    return false;
  }
}

function progressWriter(send: (event: string, payload: unknown) => boolean) {
  let lastSentAt = 0;
  let pendingChars: number | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;

  const flush = (): void => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    if (closed || pendingChars === undefined) return;
    const chars = pendingChars;
    pendingChars = undefined;
    lastSentAt = Date.now();
    send("progress", { chars });
  };

  return {
    report(chars: number): void {
      if (closed) return;
      pendingChars = chars;
      const wait = lastSentAt === 0 ? 0 : PROGRESS_INTERVAL_MS - (Date.now() - lastSentAt);
      if (wait <= 0) flush();
      else if (timer === undefined) timer = setTimeout(flush, wait);
    },
    flush,
    close(): void {
      closed = true;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      pendingChars = undefined;
    },
  };
}

export async function streamGeneration(req: Request, res: Response, generate: Generate): Promise<void> {
  const ac = new AbortController();
  const abortForRequestDisconnect = (): void => {
    // close juga terjadi setelah body POST selesai dibaca; req.complete
    // membedakan itu dari putus di tengah request.
    if (!req.complete && !ac.signal.aborted) ac.abort(new Error("client disconnected"));
  };
  const abortForResponseDisconnect = (): void => {
    if (!res.writableEnded && !res.writableFinished && !ac.signal.aborted) {
      ac.abort(new Error("client disconnected"));
    }
  };

  req.on("aborted", abortForRequestDisconnect);
  req.on("close", abortForRequestDisconnect);
  res.on("close", abortForResponseDisconnect);
  writeHeaders(res);

  const send = (event: string, payload: unknown): boolean => {
    const sent = writeEvent(res, event, payload);
    if (!sent && !ac.signal.aborted) ac.abort(new Error("client disconnected"));
    return sent;
  };
  const progress = progressWriter(send);

  try {
    const result = await generate({ signal: ac.signal, onProgress: progress.report });
    progress.flush();
    send("result", result);
  } catch (error: any) {
    if (!ac.signal.aborted) send("error", { message: error?.message || String(error) });
  } finally {
    progress.close();
    req.off("aborted", abortForRequestDisconnect);
    req.off("close", abortForRequestDisconnect);
    res.off("close", abortForResponseDisconnect);
    if (!res.writableEnded) res.end();
  }
}
