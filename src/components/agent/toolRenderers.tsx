import React, { useState } from "react";
import {
  Bot,
  Check,
  ClipboardList,
  Code2,
  FileCode2,
  FilePlus2,
  Files,
  FolderOpen,
  ListChecks,
  ListTree,
  Pencil,
  PlugZap,
  Search,
  Terminal,
  Wrench,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { makeT, useT, type TFunction } from "../../lib/i18n";

export type ToolNavigationTarget = "plan" | "prd" | "tasks";

export interface ToolRendererContext {
  onNavigate?: (target: ToolNavigationTarget) => void;
}

export interface ToolRenderer {
  icon: LucideIcon;
  title: (input: unknown, result?: unknown, t?: TFunction) => string;
  body?: (input: unknown, result: unknown, context?: ToolRendererContext) => React.ReactNode;
}

interface DataProps {
  value?: unknown;
  className?: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function text(value: unknown, fallback = ""): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
  return fallback;
}

function number(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function field(value: unknown, key: string): unknown {
  return asRecord(value)?.[key];
}

function firstText(value: unknown, keys: string[], fallback = ""): string {
  for (const key of keys) {
    const candidate = text(field(value, key));
    if (candidate) return candidate;
  }
  return fallback;
}

function shortText(value: unknown, limit = 240): string {
  const normalized = text(value).replace(/\s+/g, " ").trim();
  return normalized.length > limit ? `${normalized.slice(0, limit - 1)}…` : normalized;
}

const ENGLISH = makeT("en");

// Tool results are English because they are written for the model, and this
// view shows some of them as they are. These are the ones with a value spliced
// in that a card can display (file tools' errors are not shown); each is also a
// key in the dictionary, with the same {name} placeholders.
export const RESULT_TEMPLATES = [
  "Session {id} not found.",
  "Reached the limit of {count} tool rounds without a final answer.",
  "Tool {name} is not available for this session.",
  "Tool {name} is not recognized.",
  "Stopped after {seconds} seconds.",
  "Task {id} does not exist. Call get_project to see the available ids.",
  'Status "{status}" is not recognized. Use one of: {allowed}.',
  "There is no active LLM connection for the {role} stage.",
  "{count} tasks generated.",
  "{count} follow-up answers saved.",
  "MCP server '{name}' could not be reached: {detail}",
];

const RESULT_PATTERNS = RESULT_TEMPLATES.map((template) => {
  const names: string[] = [];
  const source = template
    .split(/(\{\w+\})/)
    .map((part) => {
      const placeholder = /^\{(\w+)\}$/.exec(part);
      if (!placeholder) return part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      names.push(placeholder[1]);
      return "([\\s\\S]+?)";
    })
    .join("");
  return { template, names, regex: new RegExp(`^${source}$`) };
});

/**
 * Translates a server message for display: an exact dictionary hit, or one of
 * the templates above with its values carried over. Anything else (the
 * provider's own words, a plan's text) comes back unchanged.
 */
export function localizeToolText(t: TFunction, value: string): string {
  const exact = t(value);
  if (exact !== value) return exact;
  for (const { template, names, regex } of RESULT_PATTERNS) {
    const match = regex.exec(value);
    if (match) return t(template, Object.fromEntries(names.map((name, index) => [name, match[index + 1]])));
  }
  return value;
}

const MESSAGE_FIELDS = ["error", "summary", "message", "note", "hint"];

function localizeResult(t: TFunction, result: unknown): unknown {
  const data = asRecord(result);
  if (!data) return result;
  const localized: Record<string, unknown> = { ...data };
  for (const key of MESSAGE_FIELDS) {
    if (typeof localized[key] === "string") localized[key] = localizeToolText(t, localized[key] as string);
  }
  return localized;
}

function pathFrom(input: unknown, result?: unknown): string {
  return firstText(input, ["file", "path", "dir"], firstText(result, ["file", "path", "dir"], "file"));
}

function bytesFor(value: string): number {
  try {
    return new TextEncoder().encode(value).length;
  } catch {
    return value.length;
  }
}

function formatBytes(value: unknown, fallbackText = "0 B"): string {
  const bytes = number(value, -1);
  if (bytes < 0) return fallbackText;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function safeJson(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  try {
    const result = JSON.stringify(value, null, 2);
    return result === undefined ? String(value) : result;
  } catch (error) {
    return `Unable to display value: ${error instanceof Error ? error.message : String(error)}`;
  }
}

function CodeBlock({ value, className = "" }: DataProps): React.ReactElement {
  return (
    <pre className={`max-w-full overflow-x-auto whitespace-pre-wrap break-words rounded-lg bg-code p-3 font-mono text-xs text-code-ink ${className}`}>
      {text(value)}
    </pre>
  );
}

function EmptyState({ label = "No result" }: { label?: string }): React.ReactElement {
  return <span className="text-xs text-faint">{label}</span>;
}

export interface JsonViewProps extends DataProps {
  maxChars?: number;
}

export const JsonView: React.FC<JsonViewProps> = ({ value, className = "", maxChars = 20_000 }) => {
  const serialized = safeJson(value);
  const clipped = serialized.length > maxChars ? `${serialized.slice(0, maxChars)}\n…` : serialized;
  return <CodeBlock value={clipped} className={className} />;
};

type DiffKind = "added" | "removed" | "hunk" | "context";

interface DiffLine {
  kind: DiffKind;
  value: string;
}

function classifyDiffLine(value: string): DiffKind {
  if (value.startsWith("@@")) return "hunk";
  if (value.startsWith("+")) return "added";
  if (value.startsWith("-")) return "removed";
  return "context";
}

function foldContext(lines: DiffLine[], t: TFunction): DiffLine[] {
  const folded: DiffLine[] = [];
  let index = 0;
  while (index < lines.length) {
    if (lines[index].kind !== "context") {
      folded.push(lines[index]);
      index += 1;
      continue;
    }
    const start = index;
    while (index < lines.length && lines[index].kind === "context") index += 1;
    const count = index - start;
    if (count <= 6) {
      folded.push(...lines.slice(start, index));
    } else {
      folded.push(...lines.slice(start, start + 3));
      folded.push({ kind: "context", value: t("… {count} lines unchanged", { count: count - 6 }) });
      folded.push(...lines.slice(index - 3, index));
    }
  }
  return folded;
}

function diffCounts(patch: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of patch.split(/\r?\n/)) {
    if (line.startsWith("+") && !line.startsWith("+++")) added += 1;
    if (line.startsWith("-") && !line.startsWith("---")) removed += 1;
  }
  return { added, removed };
}

export interface DiffViewProps {
  patch?: unknown;
  path?: unknown;
  content?: unknown;
  className?: string;
}

export const DiffView: React.FC<DiffViewProps> = ({ patch, path, content, className = "" }) => {
  const { t } = useT();
  const patchText = text(patch);
  if (!patchText.trim()) {
    const fileContent = text(content);
    const lineCount = fileContent ? fileContent.split(/\r?\n/).length : 0;
    return (
      <div className={`rounded-lg border border-line bg-subtle px-3 py-2 font-mono text-xs text-muted ${className}`}>
        {t("Writing {count} lines to {path}", { count: lineCount, path: text(path, "file") })}
      </div>
    );
  }

  const lines = foldContext(
    patchText.split(/\r?\n/).map((value): DiffLine => ({ kind: classifyDiffLine(value), value })),
    t,
  );
  const styles: Record<DiffKind, string> = {
    added: "bg-ok-soft text-ok-ink",
    removed: "bg-danger-soft text-danger-ink",
    hunk: "bg-accent-soft text-accent-ink",
    context: "bg-subtle text-muted",
  };

  return (
    <pre className={`max-w-full overflow-x-auto rounded-lg font-mono text-xs ${className}`}>
      {lines.map((line, index) => (
        <div key={`${index}-${line.value}`} className={`min-h-5 whitespace-pre-wrap break-words px-3 py-0.5 ${styles[line.kind]}`}>
          {line.value || " "}
        </div>
      ))}
    </pre>
  );
};

export interface TerminalViewProps {
  result?: unknown;
  command?: unknown;
  stdout?: unknown;
  stderr?: unknown;
  exitCode?: unknown;
  maxLines?: number;
}

// Only these lines come from the server rather than from the command itself.
// Everything else a command printed (for example a file that says "Settings")
// must reach the screen untouched, even if the dictionary has that word.
const SERVER_TERMINAL_NOTE = /^(\.\.\.\[truncated\]|Stopped after \d+ seconds\.)$/;
export const isServerTerminalNote = (value: string): boolean => SERVER_TERMINAL_NOTE.test(value);

interface TerminalLine {
  value: string;
  kind: "command" | "stdout" | "stderr";
  /** Text the server wrote itself (not command output). */
  server?: boolean;
}

export const TerminalView: React.FC<TerminalViewProps> = ({
  result,
  command,
  stdout,
  stderr,
  exitCode,
  maxLines = 400,
}) => {
  const { t } = useT();
  const data = asRecord(result);
  const commandText = text(command ?? data?.command);
  const stdoutText = text(stdout ?? data?.stdout);
  const stderrText = text(stderr ?? data?.stderr);
  const actualExitCode = exitCode ?? data?.exitCode;
  const errorText = text(data?.error);
  const lines: TerminalLine[] = [
    { kind: "command", value: `$ ${commandText || "(command unavailable)"}` },
    ...(stdoutText ? stdoutText.split(/\r?\n/).map((value) => ({ kind: "stdout" as const, value })) : []),
    ...(stderrText ? stderrText.split(/\r?\n/).map((value) => ({ kind: "stderr" as const, value })) : []),
    ...(!stdoutText && !stderrText && errorText ? [{ kind: "stderr" as const, value: errorText, server: true }] : []),
  ];
  const [showAll, setShowAll] = useState(false);
  // The server's own notes (a truncation marker, a timeout, a declined command)
  // are English; anything else a command printed passes through unchanged.
  const visibleLines = (showAll ? lines : lines.slice(0, maxLines)).map((line) =>
    line.server || isServerTerminalNote(line.value) ? { ...line, value: localizeToolText(t, line.value) } : line);
  const truncated = lines.length > maxLines;

  return (
    <div className="overflow-hidden rounded-lg bg-code text-code-ink">
      <pre className="max-h-[32rem] overflow-auto p-3 font-mono text-xs leading-relaxed">
        {visibleLines.map((line, index) => (
          <div key={`${index}-${line.value}`} className={line.kind === "stderr" ? "text-danger-ink" : undefined}>
            {line.value || " "}
          </div>
        ))}
      </pre>
      <div className="flex items-center justify-between gap-2 border-t border-white/10 px-3 py-2 text-[11px]">
        {truncated ? (
          <button type="button" onClick={() => setShowAll((value) => !value)} className="text-code-ink underline decoration-white/30 underline-offset-2">
            {showAll ? t("Show less") : t("Show all")}
          </button>
        ) : <span />}
        <ExitChip value={actualExitCode} />
      </div>
    </div>
  );
};

function ExitChip({ value }: { value: unknown }): React.ReactElement {
  const known = typeof value === "number" || typeof value === "string";
  const ok = known && Number(value) === 0;
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-mono ${ok ? "bg-ok-soft text-ok-ink" : "bg-danger-soft text-danger-ink"}`}>
      {ok && <Check className="h-3 w-3" />}
      exit {known ? text(value) : "—"}
    </span>
  );
}

function ReadFileBody({ input, result }: { input: unknown; result: unknown }): React.ReactElement {
  const { t } = useT();
  const content = text(field(result, "content"), text(field(input, "content")));
  const lines = content ? content.split(/\r?\n/) : [];
  const visible = lines.slice(0, 30);
  const remaining = Math.max(0, lines.length - visible.length);
  return (
    <div className="space-y-2">
      <CodeBlock value={visible.join("\n")} />
      {remaining > 0 && <p className="text-xs text-faint">{t("+{count} more lines", { count: remaining })}</p>}
    </div>
  );
}

function ReadFilesBody({ input, result }: { input: unknown; result: unknown }): React.ReactElement {
  const requested = asArray(field(input, "files"));
  const files = asArray(field(result, "files"));
  const entries = files.length ? files : requested;
  if (!entries.length) return <EmptyState />;
  return (
    <div className="space-y-1.5">
      {entries.map((entry, index) => {
        const item = asRecord(entry);
        const name = text(item?.file ?? item?.path ?? entry, "file");
        const content = text(item?.content);
        const size = item?.bytes ?? (content ? bytesFor(content) : undefined);
        return (
          <div key={`${name}-${index}`} className="flex items-center justify-between gap-3 rounded-md bg-subtle px-2.5 py-1.5 text-xs">
            <code className="min-w-0 truncate font-mono text-ink">{name}</code>
            <span className="shrink-0 text-faint">{formatBytes(size, "—")}</span>
          </div>
        );
      })}
    </div>
  );
}

function ListFilesBody({ result }: { result: unknown }): React.ReactElement {
  const entries = asArray(field(result, "entries"));
  if (!entries.length) return <EmptyState />;
  return (
    <div className="grid grid-cols-2 gap-1.5">
      {entries.map((entry, index) => {
        const item = asRecord(entry);
        return (
          <div key={`${text(item?.name, "entry")}-${index}`} className="flex min-w-0 items-center justify-between gap-2 rounded-md bg-subtle px-2.5 py-1.5 text-xs">
            <code className="truncate font-mono text-ink">{text(item?.name, "entry")}</code>
            <span className="shrink-0 text-faint">{text(item?.type, "unknown")}</span>
          </div>
        );
      })}
    </div>
  );
}

function GlobBody({ result }: { result: unknown }): React.ReactElement {
  const matches = asArray(field(result, "matches"));
  if (!matches.length) return <EmptyState />;
  return (
    <div className="space-y-1">
      {matches.map((match, index) => (
        <code key={`${text(match, "path")}-${index}`} className="block truncate rounded-md bg-subtle px-2.5 py-1.5 text-xs font-mono text-ink">
          {text(match, "path")}
        </code>
      ))}
    </div>
  );
}

function GrepBody({ result }: { result: unknown }): React.ReactElement {
  const matches = asArray(field(result, "matches"));
  if (!matches.length) return <EmptyState />;
  return (
    <div className="space-y-1.5">
      {matches.map((match, index) => {
        const item = asRecord(match);
        const location = `${text(item?.file, "file")}:${number(item?.line, 0)}`;
        return (
          <div key={`${location}-${index}`} className="rounded-md bg-subtle px-2.5 py-1.5 text-xs">
            <code className="font-mono text-accent-ink">{location}</code>
            <span className="ml-2 break-words font-mono text-muted">{shortText(item?.text, 300)}</span>
          </div>
        );
      })}
    </div>
  );
}

function EditBody({ input, result }: { input: unknown; result: unknown }): React.ReactElement {
  const data = asRecord(result);
  const patch = text(data?.patch);
  const counts = diffCounts(patch);
  const content = data?.content ?? field(input, "content");
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-1.5 text-xs">
        <span className="rounded-full bg-ok-soft px-2 py-0.5 font-mono text-ok-ink">+{counts.added}</span>
        <span className="rounded-full bg-danger-soft px-2 py-0.5 font-mono text-danger-ink">−{counts.removed}</span>
      </div>
      <DiffView patch={patch} path={pathFrom(input, result)} content={content} />
    </div>
  );
}

function WriteBody({ input, result }: { input: unknown; result: unknown }): React.ReactElement {
  const { t } = useT();
  const data = asRecord(result);
  const content = text(field(input, "content"));
  const bytes = data?.bytes ?? (content ? bytesFor(content) : 0);
  return <p className="text-xs text-muted">{t("Writing {size} to", { size: formatBytes(bytes) })} <code className="font-mono text-ink">{pathFrom(input, result)}</code></p>;
}

function SummaryBody({ input, result, kind }: { input: unknown; result: unknown; kind: string }): React.ReactElement {
  const data = asRecord(result);
  const { t } = useT();
  const error = text(data?.error);
  if (error) return <p className="text-xs text-danger-ink">{localizeToolText(t, error)}</p>;

  if (kind === "get_project") {
    const features = asArray(data?.features).length;
    const tasks = asArray(data?.tasks);
    const done = tasks.filter((task) => field(task, "status") === "done").length;
    return <p className="text-xs text-muted">{shortText(data?.title || data?.summary || "Project loaded")} · {features} features · {done}/{tasks.length} tasks done.</p>;
  }
  if (kind === "get_plan") return <p className="text-xs text-muted">{shortText(data?.summary || "Plan loaded.")}</p>;
  if (kind === "get_prd") return <p className="text-xs text-muted">{shortText(data?.overview || data?.summary || "PRD loaded.")}</p>;
  if (kind === "get_tasks") {
    const tasks = asArray(data?.tasks);
    return <p className="text-xs text-muted">{tasks.length} tasks loaded{tasks.length ? ` · ${tasks.filter((task) => field(task, "status") === "done").length} ${t("Done").toLowerCase()}` : ""}.</p>;
  }
  return <p className="text-xs text-muted">{shortText(data?.summary || field(input, "summary") || "Completed.")}</p>;
}

function featureNames(value: unknown): string[] {
  return asArray(value).map((entry) => text(asRecord(entry)?.name ?? entry)).filter(Boolean);
}

function FeatureList({ label, values }: { label: string; values: string[] }): React.ReactElement {
  return (
    <div className="min-w-0">
      <p className="mb-1 text-[11px] font-medium text-faint">{label}</p>
      <ul className="space-y-0.5 text-xs text-muted">
        {values.length ? values.map((value) => <li key={value} className="truncate">{value}</li>) : <li>—</li>}
      </ul>
    </div>
  );
}

function UpdateFeaturesBody({ input, result, context }: { input: unknown; result: unknown; context?: ToolRendererContext }): React.ReactElement {
  const { t } = useT();
  const data = asRecord(result);
  const before = featureNames(data?.beforeFeatures ?? data?.previousFeatures ?? field(input, "beforeFeatures"));
  const after = featureNames(data?.afterFeatures ?? data?.features ?? field(input, "features"));
  return (
    <div className="space-y-3">
      <div className={`grid gap-3 ${before.length ? "grid-cols-2" : "grid-cols-1"}`}>
        {before.length > 0 && <FeatureList label="Before" values={before} />}
        <FeatureList label={before.length ? "After" : "Features"} values={after} />
      </div>
      <PipelineLink label={t("Open Plan →")} onClick={() => context?.onNavigate?.("plan")} />
    </div>
  );
}

function PipelineLink({ label, onClick }: { label: string; onClick: () => void }): React.ReactElement {
  return <button type="button" onClick={onClick} className="text-xs font-medium text-accent-ink hover:underline">{label}</button>;
}

function GeneratePrdBody({ result, context }: { result: unknown; context?: ToolRendererContext }): React.ReactElement {
  const { t } = useT();
  const data = asRecord(result);
  const summary = shortText(localizeToolText(t, text(data?.summary || data?.overview || "PRD generated.")));
  const points = number(data?.pointCount ?? data?.sections, 7 + number(data?.additionalSections));
  return (
    <div className="space-y-2">
      <p className="text-xs text-muted">{points} points · {summary}</p>
      <PipelineLink label={t("Open PRD →")} onClick={() => context?.onNavigate?.("prd")} />
    </div>
  );
}

function SetTaskStatusBody({ input, result, context }: { input: unknown; result: unknown; context?: ToolRendererContext }): React.ReactElement {
  const { t } = useT();
  const data = asRecord(result);
  return (
    <div className="space-y-2">
      {text(data?.error) && <p className="text-xs text-danger-ink">{localizeToolText(t, text(data?.error))}</p>}
      <PipelineLink label={t("Open Board →")} onClick={() => context?.onNavigate?.("tasks")} />
    </div>
  );
}

function McpBody({ name, input, result }: { name: string; input: unknown; result: unknown }): React.ReactElement {
  const { t } = useT();
  const match = /^mcp__([^_]+)__(.+)$/.exec(name);
  const service = match?.[1] || "mcp";
  const tool = match?.[2] || name;
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="rounded-full bg-accent-soft px-2 py-0.5 font-medium text-accent-ink">{service}</span>
        <code className="font-mono text-muted">{tool}</code>
      </div>
      <JsonView value={{ input, result: localizeResult(t, result) }} />
    </div>
  );
}

function GenericBody({ input, result }: { input: unknown; result: unknown }): React.ReactElement {
  const { t } = useT();
  return <JsonView value={{ input, result: localizeResult(t, result) }} />;
}

const readFileRenderer: ToolRenderer = {
  icon: FileCode2,
  title: (input, result) => `Read ${pathFrom(input, result)}`,
  body: (input, result) => <ReadFileBody input={input} result={result} />,
};

const readFilesRenderer: ToolRenderer = {
  icon: Files,
  title: (input, result) => {
    const count = asArray(field(input, "files")).length || asArray(field(result, "files")).length;
    return `Read ${count} files`;
  },
  body: (input, result) => <ReadFilesBody input={input} result={result} />,
};

const listFilesRenderer: ToolRenderer = {
  icon: FolderOpen,
  title: (input, result) => `List ${firstText(input, ["dir"], firstText(result, ["dir"], "."))}`,
  body: (_input, result) => <ListFilesBody result={result} />,
};

const globRenderer: ToolRenderer = {
  icon: Search,
  title: (input, result) => `Glob ${firstText(input, ["pattern"], "*")} (${asArray(field(result, "matches")).length})`,
  body: (_input, result) => <GlobBody result={result} />,
};

const grepRenderer: ToolRenderer = {
  icon: Search,
  title: (input, result) => `Grep "${firstText(input, ["pattern"], "")}" (${asArray(field(result, "matches")).length})`,
  body: (_input, result) => <GrepBody result={result} />,
};

const editRenderer: ToolRenderer = {
  icon: Pencil,
  title: (input, result) => `Edit ${pathFrom(input, result)}`,
  body: (input, result) => <EditBody input={input} result={result} />,
};

const writeRenderer: ToolRenderer = {
  icon: FilePlus2,
  title: (input, result) => `Write ${pathFrom(input, result)}`,
  body: (input, result) => <WriteBody input={input} result={result} />,
};

const commandRenderer: ToolRenderer = {
  icon: Terminal,
  title: (input, result) => `$ ${firstText(input, ["command"], firstText(result, ["command"], "command"))}`,
  body: (_input, result) => <TerminalView result={result} />,
};

const projectRenderer: ToolRenderer = {
  icon: Bot,
  title: (_input, _result, t = ENGLISH) => t("Read project"),
  body: (input, result) => <SummaryBody input={input} result={result} kind="get_project" />,
};

const planRenderer: ToolRenderer = {
  icon: ClipboardList,
  title: (_input, _result, t = ENGLISH) => t("Read plan"),
  body: (input, result) => <SummaryBody input={input} result={result} kind="get_plan" />,
};

const prdRenderer: ToolRenderer = {
  icon: Code2,
  title: (_input, _result, t = ENGLISH) => t("Read PRD"),
  body: (input, result) => <SummaryBody input={input} result={result} kind="get_prd" />,
};

const tasksRenderer: ToolRenderer = {
  icon: ListChecks,
  title: (_input, _result, t = ENGLISH) => t("Read tasks"),
  body: (input, result) => <SummaryBody input={input} result={result} kind="get_tasks" />,
};

const updateFeaturesRenderer: ToolRenderer = {
  icon: ListTree,
  title: (input, result, t = ENGLISH) => t("Update {count} features", { count: asArray(field(input, "features")).length || number(field(result, "featureCount")) }),
  body: (input, result, context) => <UpdateFeaturesBody input={input} result={result} context={context} />,
};

const setTaskStatusRenderer: ToolRenderer = {
  icon: Check,
  title: (input) => `${firstText(input, ["taskId"], "TASK")} → ${firstText(input, ["status"], "unknown")}`,
  body: (input, result, context) => <SetTaskStatusBody input={input} result={result} context={context} />,
};

const generatePrdRenderer: ToolRenderer = {
  icon: ClipboardList,
  title: (_input, _result, t = ENGLISH) => t("Generate PRD"),
  body: (_input, result, context) => <GeneratePrdBody result={result} context={context} />,
};

export const GENERIC: ToolRenderer = {
  icon: Wrench,
  title: () => "Tool",
  body: (input, result) => <GenericBody input={input} result={result} />,
};

const RENDERERS: Record<string, ToolRenderer> = {
  read_file: readFileRenderer,
  read_files: readFilesRenderer,
  list_files: listFilesRenderer,
  glob: globRenderer,
  grep: grepRenderer,
  edit_file: editRenderer,
  write_file: writeRenderer,
  run_command: commandRenderer,
  get_project: projectRenderer,
  get_plan: planRenderer,
  get_prd: prdRenderer,
  get_tasks: tasksRenderer,
  update_features: updateFeaturesRenderer,
  set_task_status: setTaskStatusRenderer,
  generate_prd: generatePrdRenderer,
};

export function rendererFor(name: string): ToolRenderer {
  const toolName = typeof name === "string" ? name : String(name ?? "");
  const renderer = RENDERERS[toolName];
  if (renderer) return renderer;

  if (/^mcp__.+?__.+$/.test(toolName)) {
    const mcpName = toolName;
    const toolLabel = mcpName.replace(/^mcp__.+?__/, "");
    return {
      icon: PlugZap,
      title: () => toolLabel,
      body: (input, result) => <McpBody name={mcpName} input={input} result={result} />,
    };
  }

  return {
    ...GENERIC,
    title: () => toolName || "Tool",
  };
}
