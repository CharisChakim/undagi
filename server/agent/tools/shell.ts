import { execFile } from "node:child_process";
import { resolveInsideRoot } from "../sandbox.ts";
import type { ToolContext, ToolSpec } from "../registry.ts";

const SHELL_NOTE =
  process.platform === "win32"
    ? "The shell is Windows PowerShell 5.1, not bash. The '&&' and '||' operators do NOT exist and cause parser errors; use ';' to run commands in sequence, or '; if ($?) { ... }' to run one only when the previous command succeeded. There is no head, tail, which, or touch — use Select-Object -First/-Last, Get-Command, and New-Item."
    : "The shell is /bin/sh.";

function sessionRoot(ctx: ToolContext): string | undefined {
  return ctx.root || ctx.session?.workspaceRoot?.trim() || undefined;
}

function runCommand(
  command: string,
  cwd: string,
  timeoutMs: number,
  maxOutputChars: number,
  signal: AbortSignal
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    // Shell dipilih berdasarkan platform karena model perlu sintaks yang benar,
    // sementara signal tetap diteruskan agar child mati saat klien terputus.
    const shell = process.platform === "win32" ? "powershell.exe" : "/bin/sh";
    const args = process.platform === "win32" ? ["-NoProfile", "-Command", command] : ["-c", command];

    execFile(
      shell,
      args,
      {
        cwd,
        timeout: timeoutMs,
        maxBuffer: 10 * 1024 * 1024,
        windowsHide: true,
        signal,
      },
      (err: any, stdout, stderr) => {
        const cut = (value: string) =>
          value.length > maxOutputChars ? value.slice(0, maxOutputChars) + "\n...[truncated]" : value;
        resolve({
          stdout: cut(stdout || ""),
          stderr: cut(stderr || (err?.killed ? `Stopped after ${timeoutMs / 1000} seconds.` : "")),
          exitCode: typeof err?.code === "number" ? err.code : err ? 1 : 0,
        });
      }
    );
  });
}

const runCommandTool: ToolSpec = {
  def: {
    name: "run_command",
    description:
      `Run one shell command with the working folder as the current directory. Returns stdout, stderr, and the exit code. ${SHELL_NOTE} ` +
      "A command that runs longer than two minutes is stopped, and output over 20,000 characters is cut. " +
      "Commands run unattended: nobody can answer an interactive prompt, so use non-interactive flags. " +
      "Explain a command that deletes or overwrites something first, and do not run it unless the user asked for it.",
    parameters: {
      type: "object",
      properties: { command: { type: "string", description: "The full command; pipes and operators are allowed." } },
      required: ["command"],
    },
  },
  available: (session) => Boolean(session?.workspaceRoot?.trim()) && Boolean(session?.allowShell),
  run: async (input: any, ctx) => {
    const root = sessionRoot(ctx);
    if (!root) return { error: "The working folder is not set, so file and command tools are unavailable." };
    if (!ctx.session?.allowShell) return { error: "Running commands is not allowed for this project yet." };

    const command = String(input?.command ?? "").trim();
    if (!command) return { error: "The command is empty." };

    // Persetujuan datang sebelum child dibuat, sehingga penolakan tidak pernah
    // menimbulkan efek samping dan tetap menjadi hasil tool biasa.
    const cwd = await resolveInsideRoot(root, ".");
    const approved = Boolean(await ctx.elicit({ kind: "approval", command, cwd, action: "command" }));
    if (!approved) {
      return { error: "The user declined to run this command.", command, ranAnything: false };
    }

    const result = await runCommand(
      command,
      cwd,
      ctx.limits.commandTimeoutMs,
      ctx.limits.maxOutputChars,
      ctx.signal
    );
    return { command, ...result };
  },
};

export const shellTool: ToolSpec = runCommandTool;
export const shellTools: ToolSpec[] = [runCommandTool];

