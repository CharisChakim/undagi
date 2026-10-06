// Copyright (c) 2026 Charis Chakim - Undagi (https://github.com/CharisChakim/undagi)
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import type {
  CapabilitySupport,
  RuntimeCapabilities,
  RuntimeEffortOption,
} from "./types.ts";
import { unknownCapabilities } from "./types.ts";

export interface ParsedRuntimeModel {
  modelId: string;
  label: string;
  effortOptions: RuntimeEffortOption[];
  defaultEffort: string | null;
  capabilities: Partial<RuntimeCapabilities>;
  authScope: string | null;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function jsonDocuments(input: unknown): unknown[] {
  if (typeof input !== "string") return [input];
  const text = input.trim();
  if (!text) return [];
  try {
    return [JSON.parse(text)];
  } catch {
    // App-server/CLI output may contain one JSON object per line alongside
    // human-readable diagnostics. Ignore lines that are not JSON metadata.
    return text.split(/\r?\n/).flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
  }
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const direct = stringValue(entry);
    if (direct) return [direct];
    const item = record(entry);
    const nested = item && (item.reasoningEffort ?? item.value ?? item.id ?? item.name ?? item.level);
    const nestedString = stringValue(nested);
    return nestedString ? [nestedString] : [];
  });
}

function effortOptions(value: Record<string, unknown>): RuntimeEffortOption[] {
  const raw = value.supportedReasoningEfforts
    ?? value.supportedEffortLevels
    ?? value.supportedEfforts
    ?? value.reasoningEfforts
    ?? value.effortOptions
    ?? value.efforts;
  if (!Array.isArray(raw)) return [];

  const seen = new Set<string>();
  const result: RuntimeEffortOption[] = [];
  for (const entry of raw) {
    const direct = stringValue(entry);
    const item = record(entry);
    const native = direct ?? (item ? stringValue(item.reasoningEffort ?? item.value ?? item.id ?? item.name ?? item.level) : null);
    if (!native || seen.has(native)) continue;
    seen.add(native);
    const label = item ? stringValue(item.label ?? item.displayName ?? item.title) : null;
    result.push({ value: native, label: label ?? native });
  }
  return result;
}

function support(value: unknown): CapabilitySupport | undefined {
  if (value === true) return "supported";
  if (value === false) return "unsupported";
  if (value === "supported" || value === "unsupported" || value === "unknown") return value;
  return undefined;
}

function parsedCapabilities(value: Record<string, unknown>): Partial<RuntimeCapabilities> {
  const aliases: Record<keyof RuntimeCapabilities, readonly string[]> = {
    structuredOutput: ["structuredOutput", "structured_output", "structured-output"],
    toolUse: ["toolUse", "tool_use", "tools", "toolExecution", "tool_execution"],
    approval: ["approval", "approvals", "permission", "permissions"],
    resume: ["resume", "resumable"],
    interrupt: ["interrupt", "interruptible"],
    usage: ["usage", "usageMetadata", "usage_metadata"],
    streaming: ["streaming", "stream"],
  };
  const output: Partial<RuntimeCapabilities> = {};
  for (const key of Object.keys(aliases) as (keyof RuntimeCapabilities)[]) {
    for (const alias of aliases[key]) {
      const parsed = support(value[alias]);
      if (parsed) {
        output[key] = parsed;
        break;
      }
    }
  }
  return output;
}

function modelId(value: Record<string, unknown>): string | null {
  const direct = [value.modelId, value.id, value.value, value.slug, value.name].map(stringValue).find(Boolean);
  if (direct) return direct;
  const model = record(value.model);
  return model ? modelId(model) : null;
}

function parseModel(value: unknown): ParsedRuntimeModel | null {
  const item = record(value);
  if (!item) {
    const id = stringValue(value);
    return id
      ? { modelId: id, label: id, effortOptions: [], defaultEffort: null, capabilities: {}, authScope: null }
      : null;
  }
  const id = modelId(item);
  if (!id) return null;
  const label = stringValue(item.label ?? item.displayName ?? item.title ?? item.name) ?? id;
  const defaultEffort = stringValue(
    item.defaultReasoningEffort ?? item.default_reasoning_effort ?? item.defaultEffort ?? item.default_effort,
  );
  const authScope = stringValue(item.authScope ?? item.auth_scope ?? item.accountScope ?? item.workspace);
  return {
    modelId: id,
    label,
    effortOptions: effortOptions(item),
    defaultEffort,
    capabilities: parsedCapabilities(item.capabilities && record(item.capabilities) ? record(item.capabilities)! : item),
    authScope,
  };
}

function arraysAtKeys(value: unknown, keys: readonly string[]): unknown[][] {
  const result: unknown[][] = [];
  const visit = (current: unknown, depth: number) => {
    if (depth > 5) return;
    if (Array.isArray(current)) {
      result.push(current);
      return;
    }
    const item = record(current);
    if (!item) return;
    for (const key of keys) {
      if (key in item) visit(item[key], depth + 1);
    }
  };
  for (const document of jsonDocuments(value)) visit(document, 0);
  return result;
}

function deduplicateModels(values: unknown[]): ParsedRuntimeModel[] {
  const seen = new Set<string>();
  const result: ParsedRuntimeModel[] = [];
  for (const value of values) {
    const parsed = parseModel(value);
    if (!parsed || seen.has(parsed.modelId)) continue;
    seen.add(parsed.modelId);
    result.push(parsed);
  }
  return result;
}

/** Parse the documented Codex app-server `model/list` result. */
export function parseCodexModelList(input: unknown): ParsedRuntimeModel[] {
  const arrays = arraysAtKeys(input, ["models", "data", "items", "result"]);
  return deduplicateModels(arrays.flat());
}

/** Parse the Claude Agent SDK `supportedModels()` result. */
export function parseClaudeSupportedModels(input: unknown): ParsedRuntimeModel[] {
  const arrays = arraysAtKeys(input, ["models", "supportedModels", "data", "items", "result"]);
  if (arrays.length === 0 && Array.isArray(input)) return deduplicateModels(input);
  return deduplicateModels(arrays.flat());
}

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
}

/** Parse AGY's documented `agy models` metadata in JSON or simple table form. */
export function parseAntigravityModels(input: unknown): ParsedRuntimeModel[] {
  const parsed = arraysAtKeys(input, ["models", "data", "items", "result"]);
  const fromJson = deduplicateModels(parsed.flat());
  if (fromJson.length > 0) return fromJson;
  if (typeof input !== "string") return [];

  const rows: ParsedRuntimeModel[] = [];
  const seen = new Set<string>();
  for (const sourceLine of stripAnsi(input).split(/\r?\n/)) {
    const line = sourceLine.replace(/^\s*[|│•✓✔]\s*/, "").trim();
    if (!line || /^[-=+|]+$/.test(line)) continue;
    if (/^(model|model id|id|name)(\s|\||$)/i.test(line)) continue;
    // `agy models` 1.2.8 memisahkan id dan label dengan satu TAB, jadi satu
    // karakter pemisah harus diterima — bukan hanya dua spasi atau pipa.
    const match = line.match(/^([A-Za-z0-9][A-Za-z0-9._:/@-]*)(?:\t+|\s{2,}|\s*\|\s*|$)(.*)$/);
    if (!match) continue;
    const id = match[1];
    if (seen.has(id)) continue;
    seen.add(id);
    const label = match[2].replace(/\s*\|\s*.*$/, "").trim() || id;
    rows.push({ modelId: id, label, effortOptions: [], defaultEffort: null, capabilities: {}, authScope: null });
  }
  return rows;
}

/** Extract documented Codex `config/read` defaults without retaining raw config. */
export function parseCodexConfig(input: unknown): {
  defaultModel: string | null;
  defaultEffort: string | null;
  authScope: string | null;
} {
  const documents = jsonDocuments(input);
  let config: Record<string, unknown> | null = null;
  const visit = (value: unknown, depth: number) => {
    if (depth > 5 || config) return;
    const item = record(value);
    if (!item) return;
    if (record(item.config)) {
      config = record(item.config);
      return;
    }
    if ("model" in item || "defaultModel" in item || "defaultEffort" in item) {
      config = item;
      return;
    }
    for (const nested of Object.values(item)) visit(nested, depth + 1);
  };
  documents.forEach((document) => visit(document, 0));
  const value = config ?? {};
  return {
    defaultModel: stringValue(value.defaultModel ?? value.model),
    defaultEffort: stringValue(
      value.model_reasoning_effort
        ?? value.defaultReasoningEffort
        ?? value.default_reasoning_effort
        ?? value.defaultEffort
        ?? value.reasoningEffort
        ?? value.reasoning_effort,
    ),
    authScope: stringValue(value.authScope ?? value.accountScope ?? value.workspace),
  };
}

export function mergeCapabilities(
  base: RuntimeCapabilities,
  override: Partial<RuntimeCapabilities>,
): RuntimeCapabilities {
  return { ...unknownCapabilities(), ...base, ...override };
}
