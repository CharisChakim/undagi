import { spawn } from "node:child_process";
import type { RuntimeEffortOption } from "./types.ts";
import { parseCodexConfig, parseCodexModelList, type ParsedRuntimeModel } from "./parse.ts";

const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_LINE_BYTES = 512 * 1024;

export interface CodexAppServerOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

export interface CodexAppServerResult {
  ok: boolean;
  models: ParsedRuntimeModel[];
  defaultModel: string | null;
  defaultEffort: string | null;
  authScope: string | null;
  authRequired: boolean;
  /** Stable diagnostic code; no provider output is returned. */
  diagnostic: string | null;
}

interface JsonRpcResponse {
  id?: unknown;
  result?: unknown;
  error?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stableErrorCode(value: unknown): string {
  if (!isRecord(value)) return "PROTOCOL_ERROR";
  const code = value.code;
  if (typeof code === "string" && /^[A-Z0-9_.-]+$/i.test(code)) return code.toUpperCase();
  if (typeof code === "number") return `RPC_${code}`;
  return "PROTOCOL_ERROR";
}

function looksAuthRelated(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const code = String(value.code ?? "").toLowerCase();
  return /auth|login|credential|unauthori|forbidden|token/.test(code);
}

function effortDefaults(models: ParsedRuntimeModel[], defaultEffort: string | null): string | null {
  if (defaultEffort) return defaultEffort;
  const options: RuntimeEffortOption[] = models[0]?.effortOptions ?? [];
  return options.length === 0 ? null : models[0].defaultEffort;
}

/**
 * Read Codex's documented app-server metadata over stdio. The process receives
 * only protocol metadata requests and never a user/model prompt.
 */
export function queryCodexAppServer(
  executable: string,
  options: CodexAppServerOptions = {},
): Promise<CodexAppServerResult> {
  const timeoutMs = Math.max(1, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let buffer = "";
    const responses: JsonRpcResponse[] = [];
    let sawModelResponse = false;
    let sawConfigResponse = false;
    let initialized = false;
    let authRequired = false;
    let diagnostic: string | null = null;

    const finish = (result: CodexAppServerResult) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      if (!child.killed) child.kill("SIGTERM");
      resolve(result);
    };

    const complete = () => {
      if (!sawModelResponse || !sawConfigResponse) return;
      const modelResponse = responses.find((response) => response.id === 2);
      const configResponse = responses.find((response) => response.id === 3);
      const models = parseCodexModelList(modelResponse?.result);
      const defaults = parseCodexConfig(configResponse?.result);
      finish({
        ok: models.length > 0 && !authRequired,
        models,
        defaultModel: defaults.defaultModel,
        defaultEffort: effortDefaults(models, defaults.defaultEffort),
        authScope: defaults.authScope,
        authRequired,
        diagnostic: authRequired ? "AUTH_REQUIRED" : (models.length > 0 ? null : "MODEL_CATALOG_EMPTY"),
      });
    };

    const onMessage = (message: JsonRpcResponse) => {
      if (message.id === 1 && !initialized) {
        initialized = true;
        child.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", method: "initialized", params: {} })}\n`);
        send(2, "model/list", {});
        send(3, "config/read", {});
        return;
      }
      if (message.id !== 2 && message.id !== 3) return;
      responses.push(message);
      if (message.id === 2) sawModelResponse = true;
      if (message.id === 3) sawConfigResponse = true;
      if (message.error !== undefined) {
        if (looksAuthRelated(message.error)) authRequired = true;
        diagnostic ??= stableErrorCode(message.error);
      }
      complete();
    };

    try {
      // stdio adalah transport bawaan. Beberapa versi tidak mengenal flag
      // lama `--stdio`, jadi jangan kirim flag yang membuat proses langsung mati.
      child = spawn(executable, ["app-server"], {
        cwd: options.cwd,
        env: { ...process.env, ...options.env, NO_COLOR: "1", TERM: "dumb" },
        shell: false,
        stdio: ["pipe", "pipe", "ignore"],
      });
    } catch {
      resolve({
        ok: false,
        models: [],
        defaultModel: null,
        defaultEffort: null,
        authScope: null,
        authRequired: false,
        diagnostic: "PROCESS_ERROR",
      });
      return;
    }

    child.stdout?.on("data", (chunk: Buffer | string) => {
      buffer += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk;
      if (Buffer.byteLength(buffer, "utf8") > MAX_LINE_BYTES) {
        diagnostic ??= "PROTOCOL_LINE_TOO_LARGE";
        child.kill("SIGTERM");
        return;
      }
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) {
          try {
            const parsed = JSON.parse(line) as JsonRpcResponse;
            if (isRecord(parsed)) onMessage(parsed);
          } catch {
            // Human-readable diagnostics are ignored; they are never returned.
          }
        }
        newline = buffer.indexOf("\n");
      }
    });
    // Menulis ke app-server yang sudah menutup stdin-nya memancarkan EPIPE di
    // sini; tanpa listener, error itu mematikan seluruh server. Proses yang tak
    // bisa lagi ditulisi tidak akan menyelesaikan handshake, jadi hentikan dan
    // biarkan "close" yang melaporkannya.
    child.stdin?.on("error", () => child.kill("SIGTERM"));
    child.once("error", () => {
      finish({
        ok: false,
        models: [],
        defaultModel: null,
        defaultEffort: null,
        authScope: null,
        authRequired: false,
        diagnostic: "PROCESS_ERROR",
      });
    });
    child.once("close", () => {
      if (settled) return;
      finish({
        ok: false,
        models: [],
        defaultModel: null,
        defaultEffort: null,
        authScope: null,
        authRequired,
        diagnostic: diagnostic ?? "PROCESS_EXITED",
      });
    });

    const send = (id: number, method: string, params: Record<string, unknown>) => {
      child.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    };
    // The initialize clientInfo is identifying metadata only; no credentials or
    // workspace contents are sent during discovery.
    send(1, "initialize", {
      clientInfo: { name: "undagi-runtime-discovery", version: "0.1.0" },
      capabilities: {},
    });
    timer = setTimeout(() => {
      finish({
        ok: false,
        models: [],
        defaultModel: null,
        defaultEffort: null,
        authScope: null,
        authRequired,
        diagnostic: "METADATA_TIMEOUT",
      });
    }, timeoutMs);
  });
}
