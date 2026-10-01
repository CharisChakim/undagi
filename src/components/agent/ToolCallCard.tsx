import React, { useEffect, useState } from "react";
import { ChevronDown, CircleAlert, LoaderCircle } from "lucide-react";
import type { Entry } from "../../lib/agentEvents";
import { useT } from "../../lib/i18n";
import { rendererFor, type ToolNavigationTarget } from "./toolRenderers";

export interface ToolCallCardProps {
  entry: Extract<Entry, { kind: "tool" }>;
  onNavigatePipeline?: (step: 1 | 2 | 3) => void;
}

const targetStep: Record<ToolNavigationTarget, 1 | 2 | 3> = {
  plan: 1,
  prd: 2,
  tasks: 3,
};

const duration = (startedAt: number, endedAt?: number): string => {
  const elapsed = Math.max(0, (endedAt ?? Date.now()) - startedAt);
  return elapsed < 1000 ? `${elapsed}ms` : `${(elapsed / 1000).toFixed(1)}s`;
};

export const ToolCallCard: React.FC<ToolCallCardProps> = ({ entry, onNavigatePipeline }) => {
  const { t } = useT();
  const renderer = rendererFor(entry.name);
  const [expanded, setExpanded] = useState(entry.state === "running" || entry.state === "error");

  useEffect(() => {
    setExpanded(entry.state === "running" || entry.state === "error");
  }, [entry.id, entry.state]);

  // A long command shows how long it has been running. Claude's tool_progress
  // carries only this elapsed time, so counting from the start says the same
  // for every runtime.
  const running = entry.state === "running" && entry.startedAt > 0;
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => setTick((value) => value + 1), 1000);
    return () => window.clearInterval(timer);
  }, [running]);

  const navigate = (target: ToolNavigationTarget) => onNavigatePipeline?.(targetStep[target]);
  const title = renderer.title(entry.input, entry.result, t);

  return (
    <section className="overflow-hidden rounded-xl border border-line bg-surface" aria-label={title}>
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs hover:bg-subtle"
      >
        {entry.state === "running" ? (
          <LoaderCircle className="h-3.5 w-3.5 shrink-0 animate-spin text-accent-ink" aria-hidden />
        ) : entry.state === "error" ? (
          <CircleAlert className="h-3.5 w-3.5 shrink-0 text-danger-ink" aria-hidden />
        ) : (
          <renderer.icon className="h-3.5 w-3.5 shrink-0 text-muted" aria-hidden />
        )}
        <code className="min-w-0 flex-1 truncate font-mono text-ink">{title}</code>
        {(entry.state !== "running" || (running && Date.now() - entry.startedAt >= 1000)) && (
          <span className="shrink-0 tabular-nums text-faint">{duration(entry.startedAt, entry.state === "running" ? undefined : entry.endedAt)}</span>
        )}
        <span
          className={`shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium ${
            entry.state === "error" ? "bg-danger-soft text-danger-ink" : entry.state === "ok" ? "bg-ok-soft text-ok-ink" : entry.state === "stopped" ? "bg-subtle text-muted" : "bg-accent-soft text-accent-ink"
          }`}
        >
          {entry.state === "running" ? t("Working...") : entry.state === "error" ? t("Error") : entry.state === "stopped" ? t("Stopped") : t("Done")}
        </span>
        <ChevronDown className={`h-3.5 w-3.5 shrink-0 text-faint transition-transform ${expanded ? "rotate-180" : ""}`} aria-hidden />
      </button>

      {expanded && (
        <div className="space-y-2 border-t border-line px-3 py-3">
          {entry.state === "running" && !entry.result ? (
            <p className="text-xs text-muted">{t("Running tool...")}</p>
          ) : entry.state === "stopped" && !entry.result ? (
            <p className="text-xs text-muted">{t("The turn ended before this tool reported a result.")}</p>
          ) : renderer.body ? (
            renderer.body(entry.input, entry.result, { onNavigate: navigate })
          ) : null}
        </div>
      )}
    </section>
  );
};

export default ToolCallCard;
