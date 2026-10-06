// Copyright (c) 2026 Charis Chakim - Undagi (https://github.com/CharisChakim/undagi)
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import express, { type Request, type Response } from "express";

import { registerApprovedWorkspaceRoot, validateTransientWorkspaceRoot } from "./agent.ts";

const router = express.Router();

type PickerCommand = {
  executable: string;
  args: string[];
};

type PickerResult =
  | { kind: "selected"; path: string }
  | { kind: "cancelled" }
  | { kind: "unavailable" };

class FolderPickerUnavailableError extends Error {
  constructor() {
    super("NATIVE_FOLDER_PICKER_UNAVAILABLE");
  }
}

const WINDOWS_PICKER_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "Add-Type -AssemblyName System.Windows.Forms",
  "$dialog = New-Object System.Windows.Forms.FolderBrowserDialog",
  "$dialog.Description = 'Select working folder'",
  "$dialog.UseDescriptionForTitle = $true",
  "if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($dialog.SelectedPath) }",
].join("; ");

function pickerCommands(): PickerCommand[] {
  if (process.platform === "darwin") {
    return [{
      executable: "osascript",
      args: ["-e", "POSIX path of (choose folder with prompt \"Select working folder\")"],
    }];
  }

  if (process.platform === "win32") {
    return ["powershell.exe", "pwsh"].map((executable) => ({
      executable,
      args: ["-NoProfile", "-NonInteractive", "-STA", "-Command", WINDOWS_PICKER_SCRIPT],
    }));
  }

  if (process.platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) return [];
  if (process.platform !== "linux") return [];

  return [
    { executable: "zenity", args: ["--file-selection", "--directory", "--title=Select working folder"] },
    { executable: "kdialog", args: ["--getexistingdirectory", "", "--title", "Select working folder"] },
    { executable: "yad", args: ["--file-selection", "--directory", "--title=Select working folder"] },
  ];
}

function runPickerCommand(command: PickerCommand): Promise<PickerResult> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let settled = false;
    const finish = (result: PickerResult): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    let child;
    try {
      // Arguments and executable are constants. No user input is passed to a shell.
      child = spawn(command.executable, command.args, {
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
      });
    } catch (error) {
      reject(error);
      return;
    }

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT" || error.code === "EACCES" || error.code === "EPERM") finish({ kind: "unavailable" });
      else reject(error);
    });
    child.once("close", (code) => {
      const selectedPath = stdout.trim();
      if (selectedPath) {
        finish({ kind: "selected", path: selectedPath });
        return;
      }
      // Native dialogs use a non-zero exit code for both cancel and a closed
      // dialog. With no output, there is no path to process or expose.
      finish({ kind: "cancelled" });
    });
  });
}

async function pickFolder(): Promise<string | null> {
  const commands = pickerCommands();
  if (commands.length === 0) throw new FolderPickerUnavailableError();

  for (const command of commands) {
    const result = await runPickerCommand(command);
    if (result.kind === "unavailable") continue;
    if (result.kind === "cancelled") return null;
    return result.path;
  }
  throw new FolderPickerUnavailableError();
}

function isLoopbackRequest(req: Request): boolean {
  const address = req.socket.remoteAddress;
  return !address || address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

function validatedFolderPath(value: string): string {
  const selected = path.resolve(value.trim());
  if (!fs.statSync(selected).isDirectory()) throw new Error("Selected path is not a folder.");
  const canonical = fs.realpathSync(selected);
  registerApprovedWorkspaceRoot(canonical);
  validateTransientWorkspaceRoot(canonical);
  return canonical;
}

let pickerInFlight = false;

function gitValue(root: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile("git", ["-C", root, ...args], { timeout: 2_000, maxBuffer: 16_384, encoding: "utf8" }, (error, stdout) => {
      if (error) {
        resolve(null);
        return;
      }
      const value = stdout.trim();
      resolve(value || null);
    });
  });
}

router.get("/api/agent/workspace-context", async (req, res: Response): Promise<void> => {
  if (!isLoopbackRequest(req)) {
    res.status(403).json({ error: "Workspace context is available only from the local harness." });
    return;
  }
  const requested = typeof req.query.path === "string" ? req.query.path.trim() : "";
  if (!requested) {
    res.status(400).json({ error: "A workspace path is required." });
    return;
  }
  try {
    const validated = validateTransientWorkspaceRoot(requested);
    const root = fs.realpathSync(path.resolve(validated));
    const branch = await gitValue(root, ["branch", "--show-current"])
      ?? await gitValue(root, ["rev-parse", "--short", "HEAD"]);
    res.json({ environment: "local", branch });
  } catch {
    res.status(400).json({ error: "Workspace path must be inside a trusted workspace root." });
  }
});

router.post("/api/agent/folder-picker", async (req, res: Response): Promise<void> => {
  if (!isLoopbackRequest(req)) {
    res.status(403).json({ error: "Folder picker is available only from the local harness." });
    return;
  }
  if (pickerInFlight) {
    res.status(409).json({ error: "A folder picker is already open." });
    return;
  }

  pickerInFlight = true;
  try {
    const selected = await pickFolder();
    if (!selected) {
      res.status(204).end();
      return;
    }
    res.json({ path: validatedFolderPath(selected) });
  } catch (error) {
    if (error instanceof FolderPickerUnavailableError) {
      res.status(501).json({ error: error.message });
      return;
    }
    // Do not return command output or host details to the browser.
    res.status(400).json({ error: "Selected folder must be inside a trusted workspace root." });
  } finally {
    pickerInFlight = false;
  }
});

export { pickerCommands, router };
export default router;
