// Test-only: a fake Jev upstream on a local port, so tests exercise the real
// client and routes over HTTP without ever reaching api.typesafe.ai.
import http from "node:http";
import type { AddressInfo } from "node:net";

export interface RecordedRequest {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  raw: string;
  /** Parsed request body, or undefined when it was not JSON. */
  body: any;
}

export interface FakeReply {
  status?: number;
  json?: unknown;
  text?: string;
  /** Never answer, to exercise the client timeout. */
  hang?: boolean;
}

export type FakeHandler = (request: RecordedRequest) => FakeReply;

export interface FakeJev {
  url: string;
  requests: RecordedRequest[];
  reply(handler: FakeHandler): void;
  close(): Promise<void>;
}

export async function startFakeJev(handler: FakeHandler = () => ({ status: 500 })): Promise<FakeJev> {
  let current = handler;
  const requests: RecordedRequest[] = [];

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      let body: unknown;
      try {
        body = JSON.parse(raw);
      } catch {
        body = undefined;
      }
      const recorded: RecordedRequest = { method: req.method ?? "", url: req.url ?? "", headers: req.headers, raw, body };
      requests.push(recorded);

      const reply = current(recorded);
      if (reply.hang) return;
      res.statusCode = reply.status ?? 200;
      if (reply.text !== undefined) {
        res.setHeader("Content-Type", "text/plain");
        res.end(reply.text);
      } else {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(reply.json ?? {}));
      }
    });
  });
  server.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));

  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    requests,
    reply(next) {
      current = next;
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** Wraps answers the way the real API does. */
export function answersReply(answers: Record<string, unknown>): FakeReply {
  return { json: { model: "jev-1.13.0", answers, usage: { input_tokens: 10, output_tokens: 2 } } };
}

export const noulAnswer = (noul: number) => ({ type: "noul", noul });

export const choiceAnswer = (choice: string, confidence = 0.9, probabilities: Record<string, number> = { [choice]: confidence }) =>
  ({ type: "choice", choice, probabilities, confidence });

export const scoreAnswer = (score: number, confidence = 0.8) =>
  ({ type: "score", score, legend: {}, probabilities: {}, confidence });
