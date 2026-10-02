import { spawn, type ChildProcess } from "node:child_process";
import type { Writable, Readable } from "node:stream";
import {
  asRecord,
  JsonlParser,
  type JsonRpcMessage,
  type JsonRpcNotification,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type MalformedJsonLine,
  type RpcId,
  rpcErrorCode,
  rpcErrorMessage,
} from "./protocol.ts";

export const DEFAULT_RPC_TIMEOUT_MS = 30_000;
export const DEFAULT_INITIALIZE_TIMEOUT_MS = 10_000;
export const DEFAULT_MAX_LINE_BYTES = 512 * 1024;

export class RuntimeTransportError extends Error {
  readonly code: string;

  constructor(code: string, message = code) {
    super(message);
    this.name = "RuntimeTransportError";
    this.code = code;
  }
}

export interface AppServerChild {
  stdin: Writable | null;
  stdout: Readable | null;
  stderr?: Readable | null;
  killed?: boolean;
  kill(signal?: NodeJS.Signals): boolean;
  once(event: "error", listener: (error: Error & { code?: string }) => void): this;
  once(event: "close", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
}

export type AppServerSpawn = (
  executable: string,
  args: readonly string[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    shell: false;
    stdio: ["pipe", "pipe", "pipe"];
  },
) => AppServerChild;

export interface AppServerTransportOptions {
  executable: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Override only for deterministic tests or a pinned binary invocation. */
  args?: readonly string[];
  rpcTimeoutMs?: number;
  initializeTimeoutMs?: number;
  maxLineBytes?: number;
  spawn?: AppServerSpawn;
  clientInfo?: { name: string; version: string; title?: string };
  capabilities?: Record<string, unknown>;
}

export interface AppServerTransport {
  connect(): Promise<void>;
  request(method: string, params: Record<string, unknown>, timeoutMs?: number): Promise<unknown>;
  notify(method: string, params: Record<string, unknown>): Promise<void>;
  /** Respond to one server-initiated request. Returns false for duplicates. */
  respond(requestId: RpcId, result: unknown): Promise<boolean>;
  onNotification(listener: (message: JsonRpcNotification) => void): () => void;
  onServerRequest(listener: (message: JsonRpcRequest) => void): () => void;
  onMalformed(listener: (error: MalformedJsonLine) => void): () => void;
  /** The app-server process went away without close() being called. */
  onExit(listener: (error: RuntimeTransportError) => void): () => void;
  close(): Promise<void>;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}

function defaultSpawn(executable: string, args: readonly string[], options: Parameters<typeof spawn>[2]): AppServerChild {
  return spawn(executable, [...args], options) as unknown as AppServerChild;
}

function isResponse(message: JsonRpcMessage): message is JsonRpcResponse {
  return "id" in message && !("method" in message);
}

function isNotification(message: JsonRpcMessage): message is JsonRpcNotification {
  return "method" in message && !("id" in message);
}

function isServerRequest(message: JsonRpcMessage): message is JsonRpcRequest {
  return "method" in message && "id" in message;
}

function isErrorResponse(message: JsonRpcResponse): boolean {
  return Object.prototype.hasOwnProperty.call(message, "error");
}

/**
 * One Codex app-server process over its documented stdio JSONL transport.
 * Writes are single-shot: a failed write rejects the operation and is never
 * retried, so a caller cannot accidentally replay a turn or approval.
 */
export class CodexAppServerTransport implements AppServerTransport {
  private child: AppServerChild | null = null;
  private readonly pending = new Map<RpcId, PendingRequest>();
  private readonly respondedServerRequests = new Set<RpcId>();
  private readonly notificationListeners = new Set<(message: JsonRpcNotification) => void>();
  private readonly serverRequestListeners = new Set<(message: JsonRpcRequest) => void>();
  private readonly malformedListeners = new Set<(error: MalformedJsonLine) => void>();
  private readonly exitListeners = new Set<(error: RuntimeTransportError) => void>();
  private readonly spawnProcess: AppServerSpawn;
  private readonly options: AppServerTransportOptions;
  private parser: JsonlParser | null = null;
  private nextRequestId = 1;
  private connected = false;
  private connecting: Promise<void> | null = null;
  private closed = false;
  private closePromise: Promise<void> | null = null;

  constructor(options: AppServerTransportOptions) {
    if (!options.executable.trim()) throw new Error("Codex executable is required");
    this.options = options;
    this.spawnProcess = options.spawn ?? defaultSpawn;
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    if (this.connecting) return this.connecting;
    if (this.closed) throw new RuntimeTransportError("TRANSPORT_CLOSED", "Transport is closed.");

    this.connecting = this.openAndInitialize();
    try {
      await this.connecting;
    } finally {
      this.connecting = null;
    }
  }

  request(method: string, params: Record<string, unknown>, timeoutMs = this.options.rpcTimeoutMs ?? DEFAULT_RPC_TIMEOUT_MS): Promise<unknown> {
    if (!this.connected) return Promise.reject(new RuntimeTransportError("NOT_INITIALIZED", "App-server is not initialized."));
    if (this.closed) return Promise.reject(new RuntimeTransportError("TRANSPORT_CLOSED", "Transport is closed."));
    const id = this.nextRequestId++;
    const timeout = Math.max(1, timeoutMs);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.delete(id)) return;
        reject(new RuntimeTransportError("RPC_TIMEOUT", `RPC request timed out: ${method}`));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      void this.write({ id, method, params }).catch((error) => {
        const current = this.pending.get(id);
        if (!current) return;
        this.pending.delete(id);
        clearTimeout(current.timer);
        reject(error);
      });
    });
  }

  notify(method: string, params: Record<string, unknown>): Promise<void> {
    if (!this.connected) return Promise.reject(new RuntimeTransportError("NOT_INITIALIZED", "App-server is not initialized."));
    if (this.closed) return Promise.reject(new RuntimeTransportError("TRANSPORT_CLOSED", "Transport is closed."));
    return this.write({ method, params });
  }

  async respond(requestId: RpcId, result: unknown): Promise<boolean> {
    if (this.respondedServerRequests.has(requestId)) return false;
    this.respondedServerRequests.add(requestId);
    if (this.closed || !this.child?.stdin) return false;
    await this.write({ id: requestId, result });
    return true;
  }

  onNotification(listener: (message: JsonRpcNotification) => void): () => void {
    this.notificationListeners.add(listener);
    return () => this.notificationListeners.delete(listener);
  }

  onServerRequest(listener: (message: JsonRpcRequest) => void): () => void {
    this.serverRequestListeners.add(listener);
    return () => this.serverRequestListeners.delete(listener);
  }

  onMalformed(listener: (error: MalformedJsonLine) => void): () => void {
    this.malformedListeners.add(listener);
    return () => this.malformedListeners.delete(listener);
  }

  onExit(listener: (error: RuntimeTransportError) => void): () => void {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    const child = this.child;
    if (!child) {
      this.rejectPending(new RuntimeTransportError("TRANSPORT_CLOSED", "Transport is closed."));
      return;
    }

    this.closePromise = new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        this.connected = false;
        this.rejectPending(new RuntimeTransportError("TRANSPORT_CLOSED", "Transport is closed."));
        resolve();
      };
      child.once("close", finish);
      try {
        if (!child.killed) child.kill("SIGTERM");
      } catch {
        finish();
      }
      setTimeout(() => {
        if (settled) return;
        try {
          child.kill("SIGKILL");
        } finally {
          finish();
        }
      }, 250);
    });
    return this.closePromise;
  }

  private async openAndInitialize(): Promise<void> {
    let child: AppServerChild;
    try {
      child = this.spawnProcess(this.options.executable, this.options.args ?? ["app-server"], {
        cwd: this.options.cwd,
        env: { ...process.env, ...this.options.env, NO_COLOR: "1", TERM: "dumb" },
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      throw new RuntimeTransportError(errorCode(error), "Unable to start Codex app-server.");
    }

    this.child = child;
    this.parser = new JsonlParser(this.options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES);
    child.stdout?.on("data", (chunk: Buffer | string) => {
      const results = this.parser?.push(chunk) ?? [];
      for (const result of results) {
        if (result.type === "malformed") {
          for (const listener of this.malformedListeners) listener(result.error);
        } else {
          this.dispatch(result.message);
        }
      }
    });
    child.stdout?.once("end", () => {
      const results = this.parser?.end() ?? [];
      for (const result of results) {
        if (result.type === "malformed") {
          for (const listener of this.malformedListeners) listener(result.error);
        } else {
          this.dispatch(result.message);
        }
      }
    });
    // stderr is diagnostic-only; drain it so provider logging cannot block the
    // JSONL protocol. Raw provider output never enters the runtime contract.
    child.stderr?.on("data", () => undefined);
    // A write to an app-server that closed its stdin also emits EPIPE here, and
    // unhandled that kills the whole server. write() already rejects through its
    // callback (WRITE_ERROR) and processClosed() reports an exit, so the
    // listener only has to exist.
    child.stdin?.on("error", () => undefined);
    child.once("error", (error) => this.processFailed(error));
    child.once("close", () => this.processClosed());

    let initializeResult: unknown;
    try {
      initializeResult = await this.requestBeforeInitialized(
        "initialize",
        {
          clientInfo: this.options.clientInfo ?? { name: "undagi", version: "0.1.0" },
          capabilities: this.options.capabilities ?? {},
        },
        this.options.initializeTimeoutMs ?? DEFAULT_INITIALIZE_TIMEOUT_MS,
      );
    } catch (error) {
      await this.close();
      throw error;
    }
    if (initializeResult === undefined && this.pending.size > 0) {
      throw new RuntimeTransportError("INITIALIZE_ERROR", "Codex app-server initialize returned no result.");
    }
    await this.write({ method: "initialized", params: {} });
    this.connected = true;
  }

  private requestBeforeInitialized(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
    if (this.closed) return Promise.reject(new RuntimeTransportError("TRANSPORT_CLOSED", "Transport is closed."));
    const id = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.delete(id)) return;
        reject(new RuntimeTransportError("RPC_TIMEOUT", `RPC request timed out: ${method}`));
        void this.close();
      }, Math.max(1, timeoutMs));
      this.pending.set(id, { resolve, reject, timer });
      void this.write({ id, method, params }).catch((error) => {
        const current = this.pending.get(id);
        if (!current) return;
        this.pending.delete(id);
        clearTimeout(current.timer);
        reject(error);
      });
    });
  }

  private dispatch(message: JsonRpcMessage): void {
    if (isResponse(message)) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (isErrorResponse(message)) {
        pending.reject(new RuntimeTransportError(rpcErrorCode(message.error), rpcErrorMessage(message.error)));
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (isServerRequest(message)) {
      for (const listener of this.serverRequestListeners) listener(message);
      return;
    }
    if (isNotification(message)) {
      for (const listener of this.notificationListeners) listener(message);
    }
  }

  private async write(message: Record<string, unknown>): Promise<void> {
    const stdin = this.child?.stdin;
    if (!stdin || this.closed || stdin.destroyed || stdin.writableEnded) {
      throw new RuntimeTransportError("TRANSPORT_CLOSED", "App-server stdin is closed.");
    }
    const line = `${JSON.stringify(message)}\n`;
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        if (error) reject(new RuntimeTransportError("WRITE_ERROR", error.message));
        else resolve();
      };
      try {
        const accepted = stdin.write(line, "utf8", (error?: Error | null) => finish(error ?? undefined));
        if (!accepted) stdin.once("drain", () => finish());
      } catch (error) {
        finish(error instanceof Error ? error : new Error("stdin write failed"));
      }
    });
  }

  private processFailed(error: Error & { code?: string }): void {
    this.rejectPending(new RuntimeTransportError(errorCode(error), "Codex app-server process failed."));
  }

  private processClosed(): void {
    this.connected = false;
    const unexpected = !this.closed;
    if (!this.closed) this.closed = true;
    const error = new RuntimeTransportError("PROCESS_EXITED", "Codex app-server process exited.");
    this.rejectPending(error);
    // A turn waits on notifications, not on a pending request, so it would
    // otherwise stay open until the turn timeout.
    if (unexpected) for (const listener of this.exitListeners) listener(error);
  }

  private rejectPending(error: RuntimeTransportError): void {
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      clearTimeout(pending.timer);
      pending.reject(error);
    }
  }
}

function errorCode(error: unknown): string {
  const record = asRecord(error);
  return typeof record?.code === "string" && /^[A-Za-z0-9_.-]+$/.test(record.code)
    ? record.code.toUpperCase()
    : "PROCESS_ERROR";
}
