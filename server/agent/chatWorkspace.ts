// Copyright (c) 2026 Charis Chakim - Undagi (https://github.com/CharisChakim/undagi)
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import fs from "node:fs";
import path from "node:path";

import { DB_DIR } from "../../db.ts";

/**
 * A chat without a folder still runs somewhere: each conversation gets an
 * empty folder of its own under the data directory. Without it the runtime
 * inherited this server's own directory, shared by every such chat.
 */
export function chatWorkspaceDirectory(conversationId: string): string {
  return path.join(DB_DIR, "chat-workspaces", conversationId.replace(/[^A-Za-z0-9_-]/g, "_"));
}

export function ensureChatWorkspace(conversationId: string): string {
  const directory = chatWorkspaceDirectory(conversationId);
  fs.mkdirSync(directory, { recursive: true });
  return directory;
}

export type ChatWorkspaceAdoption =
  | { status: "none" }
  | { status: "moved"; from: string; to: string }
  | { status: "conflict"; from: string; to: string; conflicts: string[] }
  | { status: "failed"; from: string; to: string; message: string };

function lstatOrNull(target: string): fs.Stats | null {
  try {
    return fs.lstatSync(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** Paths, relative to the chat folder, that already exist in the project. */
function findConflicts(source: string, target: string, relative: string, conflicts: string[]): void {
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const name = path.join(relative, entry.name);
    const existing = lstatOrNull(path.join(target, entry.name));
    if (!existing) continue;
    if (entry.isDirectory() && existing.isDirectory()) {
      findConflicts(path.join(source, entry.name), path.join(target, entry.name), name, conflicts);
    } else {
      conflicts.push(name);
    }
  }
}

// Every step fails with EEXIST instead of replacing what is there, so a file
// that appears in the project after the conflict check is never overwritten.
function moveFile(from: string, to: string): void {
  const stats = fs.lstatSync(from);
  if (stats.isSymbolicLink()) {
    fs.symlinkSync(fs.readlinkSync(from), to);
  } else {
    try {
      fs.linkSync(from, to);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // Another disk, or a filesystem without hard links.
      if (code !== "EXDEV" && code !== "EPERM" && code !== "ENOTSUP") throw error;
      fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL);
      fs.chmodSync(to, stats.mode);
    }
  }
  fs.unlinkSync(from);
}

function moveInto(source: string, target: string): void {
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.join(target, entry.name);
    if (entry.isDirectory()) {
      if (!lstatOrNull(to)) fs.mkdirSync(to);
      moveInto(from, to);
      fs.rmdirSync(from);
    } else {
      moveFile(from, to);
    }
  }
}

/**
 * Once a chat has a project folder, the files it made before then belong in
 * that folder. Nothing is moved when any of them would replace a file already
 * there: the chat folder stays as it is and the caller tells the user.
 */
export function adoptChatWorkspace(conversationId: string, workspaceRoot: string): ChatWorkspaceAdoption {
  const from = chatWorkspaceDirectory(conversationId);
  const to = workspaceRoot;
  try {
    if (!lstatOrNull(from)) return { status: "none" };
    if (fs.readdirSync(from).length === 0) {
      fs.rmdirSync(from);
      return { status: "none" };
    }
    const conflicts: string[] = [];
    findConflicts(from, to, "", conflicts);
    if (conflicts.length) return { status: "conflict", from, to, conflicts };
    moveInto(from, to);
    fs.rmdirSync(from);
    return { status: "moved", from, to };
  } catch (error) {
    // Files moved before the failure stay in the project; the rest stay here.
    return { status: "failed", from, to, message: error instanceof Error ? error.message : String(error) };
  }
}

/** Removing a project from history also removes what is left of its chat folders. */
export function removeChatWorkspaces(conversationIds: string[]): void {
  for (const id of conversationIds) fs.rmSync(chatWorkspaceDirectory(id), { recursive: true, force: true });
}

/** The event the chat shows for an adoption, or null when there is nothing to say. */
export function chatWorkspaceEvent(adoption: ChatWorkspaceAdoption): ({ type: "chat_files" } & Record<string, unknown>) | null {
  if (adoption.status === "none") return null;
  return {
    type: "chat_files",
    status: adoption.status,
    from: adoption.from,
    to: adoption.to,
    ...(adoption.status === "conflict" ? { conflicts: adoption.conflicts.slice(0, 5), conflictCount: adoption.conflicts.length } : {}),
    ...(adoption.status === "failed" ? { message: adoption.message } : {}),
  };
}

/**
 * Whether a project's folder is gone, moved or renamed. A runtime started in a
 * missing folder fails with a bare ENOENT that reads as if the runtime were broken.
 */
export function workspaceFolderMissing(root: string): boolean {
  try {
    return !fs.statSync(root).isDirectory();
  } catch {
    return true;
  }
}
