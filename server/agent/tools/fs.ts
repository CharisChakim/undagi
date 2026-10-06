// Copyright (c) 2026 Charis Chakim - Undagi (https://github.com/CharisChakim/undagi)
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import fs from "node:fs/promises";
import path from "node:path";
import { resolveInsideRoot } from "../sandbox.ts";
import type { ToolContext, ToolSpec } from "../registry.ts";

function sessionRoot(ctx: ToolContext): string | undefined {
  return ctx.root || ctx.session?.workspaceRoot?.trim() || undefined;
}

async function realRoot(ctx: ToolContext): Promise<string> {
  const root = sessionRoot(ctx);
  if (!root) throw new Error("The working folder is not set, so file and command tools are unavailable.");
  // Root juga dilewatkan ke sandbox agar hasil relatif tidak bergantung pada symlink
  // yang mungkin dipakai pengguna sebagai nama folder kerja.
  return resolveInsideRoot(root, ".");
}

function displayPath(root: string, file: string): string {
  return path.relative(root, file) || ".";
}

async function requireWriteApproval(ctx: ToolContext, command: string, cwd: string): Promise<boolean> {
  if (ctx.session?.agentAutoMode === true) return true;
  return Boolean(await ctx.elicit({ kind: "approval", command, cwd, action: "edit" }));
}

const EXCLUDED_GLOB_PATHS = /(^|[\/\\])(node_modules|\.git|dist|build|coverage|\.next|\.venv)([\/\\]|$)/;

async function collectGlobMatches(
  root: string,
  cwd: string,
  pattern: string,
  onlyFiles: boolean
): Promise<Array<{ file: string; mtimeMs: number }>> {
  const matches: Array<{ file: string; mtimeMs: number }> = [];
  const seen = new Set<string>();

  for await (const raw of fs.glob(pattern, {
    cwd,
    exclude: (p) => EXCLUDED_GLOB_PATHS.test(String(p)),
  })) {
    const rawPath = String(raw);
    const candidate = path.isAbsolute(rawPath) ? rawPath : path.resolve(cwd, rawPath);
    let file: string;
    try {
      // Setiap hasil glob dinormalisasi ulang supaya symlink atau pola ../ tidak
      // dapat lolos hanya karena glob sendiri menganggapnya sebagai hasil sah.
      file = await resolveInsideRoot(root, path.relative(root, candidate));
      const stat = await fs.stat(file);
      if (onlyFiles && !stat.isFile()) continue;
      if (seen.has(file)) continue;
      seen.add(file);
      matches.push({ file, mtimeMs: stat.mtimeMs });
    } catch {
      // Hasil yang sudah keluar lewat symlink tidak pernah dikembalikan ke model.
    }
  }

  return matches;
}

const listFiles: ToolSpec = {
  def: {
    name: "list_files",
    description:
      "List the contents of one folder inside the working folder. Use it to find files before reading them; do not guess file names. NOT recursive: one level only, and each entry is marked file or dir — to go deeper, call it again with that dir's path.",
    parameters: {
      type: "object",
      properties: {
        dir: { type: "string", description: "Path relative to the working folder. Leave empty for the root." },
      },
      required: [],
    },
  },
  available: (session) => Boolean(session?.workspaceRoot?.trim()),
  run: async (input: any, ctx) => {
    const root = await realRoot(ctx);
    const dir = await resolveInsideRoot(root, String(input?.dir ?? "."));
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return {
      dir: path.relative(root, dir) || ".",
      entries: entries.map((entry) => ({ name: entry.name, type: entry.isDirectory() ? "dir" : "file" })),
    };
  },
};

const readFile: ToolSpec = {
  def: {
    name: "read_file",
    description:
      "Read the contents of one text file inside the working folder. Text files only — binary files come back as garbled characters. Content over 60,000 characters is cut and the result includes truncated: true; when that happens, do not rewrite the file from the content you received, because the cut part would be lost. startLine and endLine are optional, 1-based and inclusive.",
    parameters: {
      type: "object",
      properties: {
        file: { type: "string", description: "Path relative to the working folder." },
        startLine: { type: "integer", minimum: 1, description: "Start line, 1-based and inclusive." },
        endLine: { type: "integer", minimum: 1, description: "End line, 1-based and inclusive." },
      },
      required: ["file"],
    },
  },
  available: (session) => Boolean(session?.workspaceRoot?.trim()),
  run: async (input: any, ctx) => {
    const root = await realRoot(ctx);
    const file = await resolveInsideRoot(root, String(input?.file ?? ""));
    const text = await fs.readFile(file, "utf8");
    const hasStart = input?.startLine !== undefined && input?.startLine !== null;
    const hasEnd = input?.endLine !== undefined && input?.endLine !== null;
    let content = text;

    if (hasStart || hasEnd) {
      const startLine = hasStart ? Number(input.startLine) : 1;
      const endLine = hasEnd ? Number(input.endLine) : undefined;
      if (
        !Number.isInteger(startLine) ||
        startLine < 1 ||
        (endLine !== undefined && (!Number.isInteger(endLine) || endLine < startLine))
      ) {
        throw new Error("Invalid line range. Use 1-based, inclusive startLine/endLine.");
      }
      const lines = text.split("\n");
      content = lines.slice(startLine - 1, endLine ?? lines.length).join("\n");
    }

    const maxReadChars = ctx.limits.maxReadChars;
    return {
      file: displayPath(root, file),
      truncated: content.length > maxReadChars,
      content: content.slice(0, maxReadChars),
    };
  },
};

const writeFile: ToolSpec = {
  def: {
    name: "write_file",
    description:
      "Write a file inside the working folder, for a new file or a deliberate full rewrite; use edit_file to change an existing file. Missing parent folders are created automatically.",
    parameters: {
      type: "object",
      properties: {
        file: { type: "string", description: "Path relative to the working folder." },
        content: { type: "string", description: "The complete file content after the change." },
      },
      required: ["file", "content"],
    },
  },
  available: (session) => Boolean(session?.workspaceRoot?.trim()),
  run: async (input: any, ctx) => {
    const root = await realRoot(ctx);
    const file = await resolveInsideRoot(root, String(input?.file ?? ""));
    const content = String(input?.content ?? "");
    const relative = displayPath(root, file);
    const approved = await requireWriteApproval(ctx, `write_file ${relative}`, root);
    if (!approved) {
      return { error: "The user declined this file write.", file: relative, written: false };
    }
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content, "utf8");
    return { ok: true, file: relative, bytes: Buffer.byteLength(content, "utf8") };
  },
};

const globTool: ToolSpec = {
  def: {
    name: "glob",
    description:
      "Find files or folders recursively inside the working folder with a glob pattern. node_modules, .git, dist, build, coverage, .next, and .venv are pruned during traversal; results are sorted by newest mtime.",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Glob pattern, for example **/*.ts or **/*.{ts,tsx}." },
        dir: { type: "string", description: "Starting folder relative to the working folder. Leave empty for the root." },
        limit: { type: "integer", minimum: 1, maximum: 200, description: "Maximum number of results, default 200." },
      },
      required: ["pattern"],
    },
  },
  available: (session) => Boolean(session?.workspaceRoot?.trim()),
  run: async (input: any, ctx) => {
    const root = await realRoot(ctx);
    const pattern = String(input?.pattern ?? "");
    if (!pattern) throw new Error("The glob pattern is empty.");
    const dir = await resolveInsideRoot(root, String(input?.dir ?? "."));
    const requestedLimit = input?.limit === undefined || input?.limit === null ? 200 : Number(input.limit);
    if (!Number.isInteger(requestedLimit) || requestedLimit < 1) throw new Error("limit must be a positive integer.");
    const limit = Math.min(requestedLimit, 200);
    const matches = await collectGlobMatches(root, dir, pattern, false);
    matches.sort((a, b) => b.mtimeMs - a.mtimeMs || a.file.localeCompare(b.file));
    return {
      dir: displayPath(root, dir),
      pattern,
      matches: matches.slice(0, limit).map(({ file }) => displayPath(root, file)),
      truncated: matches.length > limit,
    };
  },
};

function numberOption(value: unknown, fallback: number, max: number): number {
  if (value === undefined || value === null) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error("The option value must be a non-negative integer.");
  return Math.min(parsed, max);
}

function lineText(value: string): string {
  return value.slice(0, 300);
}

async function isBinary(file: string): Promise<boolean> {
  const handle = await fs.open(file, "r");
  try {
    const sample = Buffer.alloc(8192);
    const { bytesRead } = await handle.read(sample, 0, sample.length, 0);
    return sample.subarray(0, bytesRead).includes(0);
  } finally {
    await handle.close();
  }
}

const GREP_MAX_FILE_BYTES = 2 * 1024 * 1024;
const GREP_MAX_TOTAL_MATCHES = 200;
const GREP_MAX_MATCHES_PER_FILE = 20;
const GREP_WALL_CLOCK_MS = 2_000;

const grepTool: ToolSpec = {
  def: {
    name: "grep",
    description:
      "Search text files in the working folder for a regex pattern, without a shell. Binary files and files over 2 MB are skipped; results are capped so they do not flood the context.",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Regular expression pattern." },
        path: { type: "string", description: "Starting file or folder relative to the working folder." },
        glob: { type: "string", description: "Glob pattern when path points to a folder, default **/*." },
        ignoreCase: { type: "boolean", description: "Ignore upper/lower case differences." },
        maxMatches: { type: "integer", minimum: 1, maximum: 200, description: "Maximum number of matches, default 200." },
        contextLines: { type: "integer", minimum: 0, maximum: 10, description: "Number of context lines before and after a match." },
      },
      required: ["pattern"],
    },
  },
  available: (session) => Boolean(session?.workspaceRoot?.trim()),
  run: async (input: any, ctx) => {
    const root = await realRoot(ctx);
    const pattern = String(input?.pattern ?? "");
    let expression: RegExp;
    try {
      expression = new RegExp(pattern, input?.ignoreCase ? "i" : "");
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }

    const maxMatches = numberOption(input?.maxMatches, GREP_MAX_TOTAL_MATCHES, GREP_MAX_TOTAL_MATCHES);
    const contextLines = numberOption(input?.contextLines, 0, 10);
    const scope = await resolveInsideRoot(root, String(input?.path ?? "."));
    const scopeStat = await fs.stat(scope);
    const candidates = scopeStat.isFile()
      ? [{ file: scope, mtimeMs: scopeStat.mtimeMs }]
      : await collectGlobMatches(root, scope, String(input?.glob ?? "**/*"), true);
    const startedAt = Date.now();
    const matches: Array<{ file: string; line: number; text: string; context?: Array<{ line: number; text: string }> }> = [];
    let filesScanned = 0;
    let truncated = false;

    for (const candidate of candidates) {
      if (filesScanned > 0 && filesScanned % 500 === 0 && Date.now() - startedAt >= GREP_WALL_CLOCK_MS) {
        truncated = true;
        break;
      }
      filesScanned += 1;
      try {
        const stat = await fs.stat(candidate.file);
        if (stat.size > GREP_MAX_FILE_BYTES || (await isBinary(candidate.file))) continue;
        const text = await fs.readFile(candidate.file, "utf8");
        const lines = text.split(/\r?\n/);
        let fileMatches = 0;
        for (let index = 0; index < lines.length; index += 1) {
          if (!expression.test(lines[index])) continue;
          const result: { file: string; line: number; text: string; context?: Array<{ line: number; text: string }> } = {
            file: displayPath(root, candidate.file),
            line: index + 1,
            text: lineText(lines[index]),
          };
          if (contextLines > 0) {
            const from = Math.max(0, index - contextLines);
            const to = Math.min(lines.length, index + contextLines + 1);
            result.context = lines.slice(from, to).map((value, contextIndex) => ({
              line: from + contextIndex + 1,
              text: lineText(value),
            }));
          }
          matches.push(result);
          fileMatches += 1;
          if (matches.length >= maxMatches || fileMatches >= GREP_MAX_MATCHES_PER_FILE) {
            truncated = true;
            break;
          }
        }
      } catch {
        // Berkas yang hilang atau tidak bisa dibaca dilewati; satu path rusak
        // tidak boleh mematikan pencarian di seluruh folder kerja.
      }
      if (matches.length >= maxMatches) break;
    }

    // Risiko yang diterima: catastrophic backtracking dapat memblokir event loop,
    // dan budget ini tidak bisa menginterupsi satu panggilan RegExp.test().
    // Worker thread sengaja tidak dibangun untuk aplikasi localhost satu pengguna.
    return { matches, truncated, filesScanned };
  },
};

interface SpliceRecord {
  before: string;
  start: number;
  oldText: string;
  newText: string;
  originalStart: number;
  originalEnd: number;
}

function findOccurrences(text: string, needle: string): number[] {
  const positions: number[] = [];
  for (let offset = text.indexOf(needle); offset !== -1; ) {
    positions.push(offset);
    offset = text.indexOf(needle, offset + needle.length);
  }
  return positions;
}

function lineNumberAt(text: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset; index += 1) {
    if (text[index] === "\n") line += 1;
  }
  return line;
}

function lineStart(text: string, offset: number): number {
  const index = text.lastIndexOf("\n", Math.max(0, offset - 1));
  return index === -1 ? 0 : index + 1;
}

function lineEnd(text: string, offset: number): number {
  const index = text.indexOf("\n", offset);
  return index === -1 ? text.length : index + 1;
}

function lineStartFor(text: string, line: number): number {
  if (line <= 1) return 0;
  let cursor = 0;
  for (let current = 1; current < line; current += 1) {
    const newline = text.indexOf("\n", cursor);
    if (newline === -1) return text.length;
    cursor = newline + 1;
  }
  return cursor;
}

function lineEndFor(text: string, line: number): number {
  return lineEnd(text, lineStartFor(text, line));
}

function patchLines(text: string): string[] {
  const normalized = text.endsWith("\n") ? text.slice(0, -1) : text;
  return normalized ? normalized.split("\n") : [];
}

function lineCount(text: string): number {
  return text.split("\n").length;
}

function originalOffsetAt(offset: number, records: SpliceRecord[], bias: "start" | "end"): number {
  let original = offset;
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index];
    const afterEnd = record.start + record.newText.length;
    if (original < record.start) continue;
    if (original > afterEnd || (original === afterEnd && bias === "end")) {
      original -= record.newText.length - record.oldText.length;
      continue;
    }
    original = record.start + (bias === "end" ? record.oldText.length : 0);
  }
  return original;
}

function mapOriginalToFinal(offset: number, records: SpliceRecord[], bias: "start" | "end"): number {
  let delta = 0;
  const ordered = [...records].sort((a, b) => a.originalStart - b.originalStart || a.originalEnd - b.originalEnd);
  for (const record of ordered) {
    if (offset < record.originalStart || (offset === record.originalStart && bias === "start")) continue;
    if (offset > record.originalEnd || (offset === record.originalEnd && bias === "end")) {
      delta += record.newText.length - record.oldText.length;
      continue;
    }
    return record.originalStart + delta + (bias === "end" ? record.newText.length : 0);
  }
  return offset + delta;
}

interface PatchChange {
  record: SpliceRecord;
  start: number;
  end: number;
  startLine: number;
  endLine: number;
}

function patchChange(original: string, record: SpliceRecord): PatchChange {
  const startLine = lineNumberAt(original, record.originalStart);
  const endLine = lineNumberAt(original, Math.max(record.originalStart, record.originalEnd - 1));
  return {
    record,
    start: lineStartFor(original, startLine),
    end: lineEndFor(original, endLine),
    startLine,
    endLine,
  };
}

function applyPatchChanges(original: string, start: number, end: number, changes: PatchChange[]): string | undefined {
  let result = original.slice(start, end);
  const ordered = [...changes].sort((a, b) => b.record.originalStart - a.record.originalStart);
  for (const change of ordered) {
    const localStart = change.record.originalStart - start;
    const localEnd = change.record.originalEnd - start;
    if (localStart < 0 || localEnd < localStart || localEnd > result.length) return undefined;
    result = result.slice(0, localStart) + change.record.newText + result.slice(localEnd);
  }
  return result;
}

function buildUnifiedPatch(file: string, original: string, final: string, records: SpliceRecord[]): string {
  if (records.length === 0) return `--- ${file}\n+++ ${file}`;
  const changes = records.map((record) => patchChange(original, record)).sort((a, b) => a.start - b.start || a.end - b.end);
  const groups: Array<{ startLine: number; endLine: number; changes: PatchChange[] }> = [];
  for (const change of changes) {
    const startLine = Math.max(1, change.startLine - 3);
    const endLine = Math.min(lineCount(original), change.endLine + 3);
    const previous = groups[groups.length - 1];
    if (previous && startLine <= previous.endLine) {
      previous.endLine = Math.max(previous.endLine, endLine);
      previous.changes.push(change);
    } else {
      groups.push({ startLine, endLine, changes: [change] });
    }
  }

  const hunks = groups.map((group) => {
    const contextStart = lineStartFor(original, group.startLine);
    const contextEnd = lineEndFor(original, group.endLine);
    const diffLines: string[] = [];
    const appendContext = (value: string) => {
      diffLines.push(...patchLines(value).map((line) => ` ${line}`));
    };
    const appendChange = (change: PatchChange) => {
      const oldAffected = original.slice(change.start, change.end);
      const newAffected = applyPatchChanges(original, change.start, change.end, [change]);
      diffLines.push(...patchLines(oldAffected).map((line) => `-${line}`));
      diffLines.push(...patchLines(newAffected ?? final.slice(mapOriginalToFinal(change.start, records, "start"), mapOriginalToFinal(change.end, records, "end"))).map((line) => `+${line}`));
    };

    let cursor = contextStart;
    let index = 0;
    while (index < group.changes.length) {
      const first = group.changes[index];
      let current = first;
      const sameLine: PatchChange[] = [first];
      let nextIndex = index + 1;
      while (nextIndex < group.changes.length && group.changes[nextIndex].start <= current.end) {
        current = group.changes[nextIndex];
        sameLine.push(current);
        nextIndex += 1;
      }
      appendContext(original.slice(cursor, first.start));
      if (sameLine.length === 1) {
        appendChange(first);
      } else {
        const oldAffected = original.slice(first.start, current.end);
        const newAffected = applyPatchChanges(original, first.start, current.end, sameLine);
        diffLines.push(...patchLines(oldAffected).map((line) => `-${line}`));
        diffLines.push(...patchLines(newAffected ?? final.slice(mapOriginalToFinal(first.start, records, "start"), mapOriginalToFinal(current.end, records, "end"))).map((line) => `+${line}`));
      }
      cursor = current.end;
      index = nextIndex;
    }
    appendContext(original.slice(cursor, contextEnd));
    const newStart = lineNumberAt(final, mapOriginalToFinal(contextStart, records, "start"));
    const oldStart = lineNumberAt(original, contextStart);
    const oldCount = diffLines.filter((line) => !line.startsWith("+")).length;
    const newCount = diffLines.filter((line) => !line.startsWith("-")).length;
    return [
      `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`,
      ...diffLines,
    ].join("\n");
  });
  return [`--- ${file}`, `+++ ${file}`, ...hunks].join("\n");
}

const editFile: ToolSpec = {
  def: {
    name: "edit_file",
    description:
      "Change a text file with sequential exact-match replacements. Read the file first; every oldText must be copied exactly, including whitespace and indentation. A rejection or a declined approval writes nothing.",
    parameters: {
      type: "object",
      properties: {
        file: { type: "string", description: "Path relative to the working folder." },
        edits: {
          type: "array",
          items: {
            type: "object",
            properties: {
              oldText: { type: "string", description: "The old text, which must appear exactly." },
              newText: { type: "string", description: "The replacement text." },
              replaceAll: { type: "boolean", description: "Replace all occurrences if true." },
            },
            required: ["oldText", "newText"],
          },
        },
      },
      required: ["file", "edits"],
    },
  },
  available: (session) => Boolean(session?.workspaceRoot?.trim()),
  run: async (input: any, ctx) => {
    const root = await realRoot(ctx);
    const file = await resolveInsideRoot(root, String(input?.file ?? ""));
    const relative = displayPath(root, file);
    const original = await fs.readFile(file, "utf8");
    const edits = Array.isArray(input?.edits) ? input.edits : [];
    if (edits.length === 0) throw new Error("The edits list is empty.");

    let working = original;
    const records: SpliceRecord[] = [];
    for (const edit of edits) {
      const oldText = String(edit?.oldText ?? "");
      const newText = String(edit?.newText ?? "");
      if (oldText === "") return { error: `The text to find must not be empty in ${relative}.` };
      const occurrences = findOccurrences(working, oldText);
      if (occurrences.length === 0) {
        return {
          error: `The text to find was not found in ${relative}.`,
          hint: "Copy it again exactly from read_file, including whitespace and indentation.",
        };
      }
      if (occurrences.length > 1 && edit?.replaceAll !== true) {
        return {
          error: `That text appears ${occurrences.length} times in ${relative}.`,
          occurrences: occurrences.length,
          atLines: occurrences.map((offset) => lineNumberAt(working, offset)),
        };
      }

      // Dari kanan ke kiri agar offset hasil pencarian tetap berlaku saat
      // replaceAll mengubah panjang buffer. Semua perubahan masih di memori.
      const positions = edit?.replaceAll === true ? [...occurrences].reverse() : occurrences;
      for (const start of positions) {
        const before = working;
        const originalStart = originalOffsetAt(start, records, "start");
        const originalEnd = originalOffsetAt(start + oldText.length, records, "end");
        working = before.slice(0, start) + newText + before.slice(start + oldText.length);
        records.push({ before, start, oldText, newText, originalStart, originalEnd });
      }
    }

    const approved = await requireWriteApproval(ctx, `edit_file ${relative}`, root);
    if (!approved) {
      return { error: "The user declined this file change.", file: relative, written: false };
    }
    await fs.writeFile(file, working, "utf8");
    return {
      ok: true,
      file: relative,
      editsApplied: edits.length,
      bytes: Buffer.byteLength(working, "utf8"),
      patch: buildUnifiedPatch(relative, original, working, records),
    };
  },
};

const readFiles: ToolSpec = {
  def: {
    name: "read_files",
    description:
      "Read several text files at once. At most 10 files; a broken path is reported per entry without failing the other files.",
    parameters: {
      type: "object",
      properties: {
        files: { type: "array", items: { type: "string" }, description: "List of at most 10 relative paths." },
        maxChars: { type: "integer", minimum: 1, description: "Total character budget, split evenly across the files." },
      },
      required: ["files"],
    },
  },
  available: (session) => Boolean(session?.workspaceRoot?.trim()),
  run: async (input: any, ctx) => {
    const root = await realRoot(ctx);
    const files = Array.isArray(input?.files) ? input.files : [];
    if (files.length > 10) throw new Error("At most 10 files per read_files call.");
    if (files.length === 0) return { files: [] };
    const requestedBudget = input?.maxChars === undefined || input?.maxChars === null ? ctx.limits.maxReadChars : Number(input.maxChars);
    if (!Number.isInteger(requestedBudget) || requestedBudget < 1) throw new Error("maxChars must be a positive integer.");
    const budget = Math.min(requestedBudget, ctx.limits.maxReadChars);
    const perFile = Math.max(1, Math.floor(budget / files.length));
    const results: Array<{ file: string; content: string; truncated: boolean; error?: string }> = [];

    for (const requested of files) {
      const inputFile = String(requested ?? "");
      try {
        const file = await resolveInsideRoot(root, inputFile);
        const text = await fs.readFile(file, "utf8");
        results.push({
          file: displayPath(root, file),
          content: text.slice(0, perFile),
          truncated: text.length > perFile,
        });
      } catch (error) {
        results.push({
          file: inputFile,
          content: "",
          truncated: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return { files: results };
  },
};

// Array ini menjadi satu unit supaya registry dapat menyaring semua tool berkas
// dengan izin folder yang sama tanpa mengubah schema provider.
export const fsTools: ToolSpec[] = [listFiles, readFile, writeFile, globTool, grepTool, editFile, readFiles];
