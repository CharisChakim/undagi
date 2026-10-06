// Copyright (c) 2026 Charis Chakim - Undagi (https://github.com/CharisChakim/undagi)
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { JsonRpcPeer, type JsonRpcRequestOptions } from "./jsonrpc.ts";

export interface StdioConfig {
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd?: string;
  onStderr?: (line: string) => void;
  onExit?: (error: Error) => void;
  onNotification?: (method: string, params: unknown) => void;
}

export interface StdioTransport {
  peer: JsonRpcPeer;
  close(): Promise<void>;
}

export function createStdioTransport(config: StdioConfig): StdioTransport {
  const child = spawn(config.command, config.args, {
    env: { ...process.env, ...config.env },
    cwd: config.cwd,
    stdio: ["pipe", "pipe", "pipe"],
  }) as ChildProcessWithoutNullStreams;
  let closing = false;
  let stdoutBuffer = "";
  let stderrBuffer = "";
  let peer: JsonRpcPeer;

  const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
    if (closing) return;
    const suffix = signal ? ` (${signal})` : "";
    const detail = code === 0 ? "MCP server exited." : `MCP server exited with code ${code ?? "unknown"}${suffix}.`;
    const error = new Error(`${detail}${stderrBuffer ? ` ${stderrBuffer.trim().split(/\r?\n/).slice(-1)[0]}` : ""}`);
    config.onExit?.(error);
    peer.close(error);
  };

  peer = new JsonRpcPeer(
    (line) => {
      if (closing || child.stdin.destroyed) throw new Error("MCP server stdin is closed.");
      child.stdin.write(line);
    },
    config.onNotification,
  );

  child.stdout.on("data", (chunk: Buffer | string) => {
    stdoutBuffer += chunk.toString();
    while (true) {
      const newline = stdoutBuffer.indexOf("\n");
      if (newline === -1) break;
      const line = stdoutBuffer.slice(0, newline).replace(/\r$/, "");
      stdoutBuffer = stdoutBuffer.slice(newline + 1);
      peer.receive(line);
    }
  });
  child.stdout.on("error", (error) => peer.close(error));
  // Menulis ke server yang sudah menutup stdin-nya (misalnya perintah yang
  // langsung keluar) memancarkan EPIPE di sini; tanpa listener, error itu tidak
  // tertangani dan mematikan seluruh proses Undagi.
  child.stdin.on("error", (error) => {
    const failure = new Error(`Could not write to the MCP server: ${error.message}`);
    if (!closing) config.onExit?.(failure);
    peer.close(failure);
  });
  child.stderr.on("data", (chunk: Buffer | string) => {
    const text = chunk.toString();
    stderrBuffer = `${stderrBuffer}${text}`.split(/\r?\n/).slice(-2).join("\n");
    for (const line of text.split(/\r?\n/).filter(Boolean)) config.onStderr?.(line);
  });
  child.on("error", (error) => {
    if (!closing) config.onExit?.(error);
    peer.close(error);
  });
  child.on("exit", onExit);

  return {
    peer,
    async close(): Promise<void> {
      if (closing) return;
      closing = true;
      peer.close();
      if (child.exitCode !== null || child.signalCode !== null) return;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 1000);
        child.once("close", () => {
          clearTimeout(timer);
          resolve();
        });
        child.kill();
      });
    },
  };
}

export type StdioRequestOptions = JsonRpcRequestOptions;
