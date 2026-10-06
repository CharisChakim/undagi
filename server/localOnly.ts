// Copyright (c) 2026 Charis Chakim - Undagi (https://github.com/CharisChakim/undagi)
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import type { NextFunction, Request, RequestHandler, Response } from "express";

/**
 * Lets through only requests made by a page this server served.
 *
 * Listening on 127.0.0.1 keeps other machines out, but not other websites. A
 * page on another site can point its own hostname at 127.0.0.1 (DNS
 * rebinding) and then call this API as its own origin, from this machine.
 * That request still names the attacker's hostname in Host. A plain
 * cross-site request names the other site in Origin.
 */
export function localOnly(bindHost: string): RequestHandler {
  // A server opened to the network (HOST=0.0.0.0) is reached under names this
  // process cannot know, so only the Origin check applies there.
  const loopbackOnly = isLoopbackHostname(bindHost);
  return (req: Request, res: Response, next: NextFunction) => {
    const refusal = refusalOf(req.headers.host, req.headers.origin, loopbackOnly);
    if (refusal === null) {
      next();
      return;
    }
    res.status(403).json({ error: `Refused: ${refusal}.` });
  };
}

/** Why a request is refused, or null to let it through. */
export function refusalOf(host: string | undefined, origin: string | undefined, loopbackOnly: boolean): string | null {
  const served = parsedUrl(host === undefined ? undefined : `http://${host}`);
  if (!served) return "the Host header is missing or invalid";
  if (loopbackOnly && !isLoopbackHostname(served.hostname)) return `Host ${host} is not this machine`;
  if (origin !== undefined && parsedUrl(origin)?.host !== served.host) return `Origin ${origin} is not this server`;
  return null;
}

/** localhost, *.localhost, 127.0.0.0/8 and ::1, with or without IPv6 brackets. */
export function isLoopbackHostname(hostname: string): boolean {
  const name = hostname.toLowerCase().replace(/^\[(.*)\]$/, "$1");
  return name === "localhost" || name.endsWith(".localhost") || name === "::1" || /^127(\.\d{1,3}){3}$/.test(name);
}

function parsedUrl(value: string | undefined): URL | null {
  if (value === undefined) return null;
  try {
    return new URL(value);
  } catch {
    return null;
  }
}
