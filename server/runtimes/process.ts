// Copyright (c) 2026 Charis Chakim - Undagi (https://github.com/CharisChakim/undagi)
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { accessSync, constants as fsConstants, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { spawn } from "node:child_process";

export const DEFAULT_METADATA_TIMEOUT_MS = 5_000;
const MAX_METADATA_OUTPUT_BYTES = 1_024 * 1_024;

export interface MetadataCommandOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  /** Metadata commands do not accept interactive input. */
  stdin?: "ignore";
}

export interface MetadataCommandResult {
  ok: boolean;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  /** Stable process error code, such as ENOENT; never the full error message. */
  errorCode: string | null;
}

function executableFile(path: string): boolean {
  try {
    const stat = statSync(path);
    if (!stat.isFile()) return false;
    accessSync(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Resolve a configured absolute/relative executable or a command on PATH. */
export function resolveExecutable(
  command: string,
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): string | null {
  const value = command.trim();
  if (!value) return null;

  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  if (value.includes("/") || value.includes("\\")) {
    const candidate = isAbsolute(value) ? value : join(cwd, value);
    return executableFile(candidate) ? candidate : null;
  }

  const pathEntries = (env.PATH ?? "").split(process.platform === "win32" ? ";" : ":");
  for (const entry of pathEntries) {
    const candidate = join(entry || ".", value);
    if (executableFile(candidate)) return candidate;
  }
  return null;
}

/** Resolve the first configured/candidate command without invoking a shell. */
export function findExecutable(
  candidates: readonly string[],
  configured: string | undefined,
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): string | null {
  if (configured) {
    const configuredPath = resolveExecutable(configured, options);
    if (configuredPath) return configuredPath;
  }
  for (const candidate of candidates) {
    const resolved = resolveExecutable(candidate, options);
    if (resolved) return resolved;
  }
  return null;
}

function appendLimited(target: { value: string; bytes: number }, chunk: Buffer | string): void {
  if (target.bytes >= MAX_METADATA_OUTPUT_BYTES) return;
  const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk;
  const remaining = MAX_METADATA_OUTPUT_BYTES - target.bytes;
  const clipped = Buffer.byteLength(text, "utf8") <= remaining
    ? text
    : Buffer.from(text, "utf8").subarray(0, remaining).toString("utf8");
  target.value += clipped;
  target.bytes += Buffer.byteLength(clipped, "utf8");
}

/**
 * Run a provider metadata command with no shell, no stdin, bounded output, and
 * a deadline. Callers must parse only documented metadata fields.
 */
export function runMetadataCommand(
  executable: string,
  args: readonly string[],
  options: MetadataCommandOptions = {},
): Promise<MetadataCommandResult> {
  const timeoutMs = Math.max(1, options.timeoutMs ?? DEFAULT_METADATA_TIMEOUT_MS);
  const stdout = { value: "", bytes: 0 };
  const stderr = { value: "", bytes: 0 };

  return new Promise((resolve) => {
    let settled = false;
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let child: ReturnType<typeof spawn>;

    const finish = (result: MetadataCommandResult) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      resolve(result);
    };

    try {
      child = spawn(executable, [...args], {
        cwd: options.cwd,
        env: { ...process.env, ...options.env },
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      finish({
        ok: false,
        exitCode: null,
        signal: null,
        timedOut: false,
        stdout: "",
        stderr: "",
        errorCode: errorCode(error),
      });
      return;
    }

    child.stdout?.on("data", (chunk: Buffer | string) => appendLimited(stdout, chunk));
    child.stderr?.on("data", (chunk: Buffer | string) => appendLimited(stderr, chunk));
    child.once("error", (error) => {
      finish({
        ok: false,
        exitCode: null,
        signal: null,
        timedOut,
        stdout: stdout.value,
        stderr: stderr.value,
        errorCode: errorCode(error),
      });
    });
    child.once("close", (exitCode, signal) => {
      finish({
        ok: exitCode === 0 && !timedOut,
        exitCode,
        signal,
        timedOut,
        stdout: stdout.value,
        stderr: stderr.value,
        errorCode: null,
      });
    });

    timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      // A metadata probe must not leave a provider process behind if it ignores
      // SIGTERM. This short grace period is independent of the caller deadline.
      setTimeout(() => {
        if (!settled) child.kill("SIGKILL");
      }, 100);
    }, timeoutMs);
  });
}

function errorCode(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && /^[A-Z0-9_]+$/.test(code)) return code;
  }
  return "PROCESS_ERROR";
}

/** Parse a semver-like version without retaining provider diagnostics. */
export function parseRuntimeVersion(text: string): string | null {
  const match = text.match(/\b\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?\b/);
  return match?.[0] ?? null;
}
