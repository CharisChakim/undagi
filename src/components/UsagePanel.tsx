import React, { useState } from "react";
import { ArrowDown, ArrowUp, Check, Eye, EyeOff, RefreshCw, SlidersHorizontal } from "lucide-react";
import { useT, type TFunction } from "../lib/i18n";
import { remainingPercent, timeUntil, useRuntimeUsage, type RuntimeUsage, type UsageWindow } from "../lib/usage";
import {
  loadUsagePrefs,
  moveUsage,
  orderUsage,
  saveUsagePrefs,
  toggleUsageHidden,
  visibleUsage,
  type UsagePrefs,
} from "../lib/usagePrefs";

// Fixed row heights make "three rows, then scroll" an exact box instead of a guess.
const ROW_PX = 34;
const EDIT_ROW_PX = 28;
const GAP_PX = 2;
const MAX_ROWS = 3;
const listHeight = (row: number) => MAX_ROWS * row + (MAX_ROWS - 1) * GAP_PX;

// Two windows fit beside the name; a runtime that reports more still has all of
// them in the row's tooltip.
const SHOWN_WINDOWS = 2;

// A scrollbar that only appears past three rows must not eat the row's width.
const LIST_CLASS = "flex flex-col gap-0.5 overflow-y-auto overflow-x-hidden [scrollbar-width:thin] [scrollbar-color:var(--app-line)_transparent]";

function windowLabel(window: UsageWindow, t: TFunction): string {
  const minutes = window.windowMinutes;
  if (minutes && minutes < 1_440 && minutes % 60 === 0) return t("{count}h", { count: minutes / 60 });
  if (minutes && minutes % 1_440 === 0) return t("{count}d", { count: minutes / 1_440 });
  return window.id;
}

function resetText(window: UsageWindow, t: TFunction): string {
  const left = timeUntil(window.resetsAt, Date.now());
  if (!left) return "";
  const parts = [
    left.days && t("{count}d", { count: left.days }),
    left.hours && t("{count}h", { count: left.hours }),
    left.minutes && t("{count}m", { count: left.minutes }),
  ].filter(Boolean);
  return t("Resets in {time}", { time: parts.join(" ") });
}

function fillClass(remaining: number): string {
  if (remaining <= 10) return "bg-danger";
  if (remaining <= 25) return "bg-warn";
  return "bg-accent";
}

function windowDetail(entry: RuntimeUsage, window: UsageWindow, t: TFunction): string {
  const remaining = t("{label}: {percent}% left", { label: windowLabel(window, t), percent: remainingPercent(window) });
  const reset = resetText(window, t);
  return reset ? `${remaining} · ${reset}` : remaining;
}

const WindowMeter: React.FC<{ entry: RuntimeUsage; window: UsageWindow }> = ({ entry, window }) => {
  const { t } = useT();
  const remaining = remainingPercent(window);
  const label = windowLabel(window, t);
  return (
    <div
      role="meter"
      aria-label={`${entry.label} ${windowDetail(entry, window, t)}`}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={remaining}
      className="min-w-0"
    >
      <div className="flex items-baseline justify-between gap-1 text-[10px] leading-none">
        <span className="truncate text-faint">{label}</span>
        <span className="shrink-0 tabular-nums text-ink">{remaining}%</span>
      </div>
      <div className="mt-1 h-1 overflow-hidden rounded-full bg-subtle" aria-hidden>
        <div className={`h-full rounded-full ${fillClass(remaining)}`} style={{ width: `${remaining}%` }} />
      </div>
    </div>
  );
};

const UsageRow: React.FC<{ entry: RuntimeUsage }> = ({ entry }) => {
  const { t } = useT();
  const unavailable = Boolean(entry.error) || entry.windows.length === 0;
  const tooltip = [
    entry.plan ? `${entry.label} · ${entry.plan}` : entry.label,
    ...(unavailable ? [t("Usage unavailable")] : entry.windows.map((window) => windowDetail(entry, window, t))),
  ].join("\n");
  return (
    <li
      title={tooltip}
      style={{ height: ROW_PX }}
      className="grid shrink-0 grid-cols-[4.75rem_1fr_1fr] items-center gap-x-2 rounded-md px-2 hover:bg-subtle"
    >
      <span className="truncate text-[11px] font-semibold text-ink">{entry.label}</span>
      {unavailable ? (
        <span className="col-span-2 truncate text-[10px] text-faint">{t("Usage unavailable")}</span>
      ) : (
        entry.windows.slice(0, SHOWN_WINDOWS).map((window) => <WindowMeter key={window.id} entry={entry} window={window} />)
      )}
    </li>
  );
};

const EditRow: React.FC<{
  entry: RuntimeUsage;
  hidden: boolean;
  first: boolean;
  last: boolean;
  onToggle: () => void;
  onMove: (direction: -1 | 1) => void;
}> = ({ entry, hidden, first, last, onToggle, onMove }) => {
  const { t } = useT();
  const button = "rounded p-1 text-faint hover:bg-subtle hover:text-ink disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-faint";
  return (
    <li style={{ height: EDIT_ROW_PX }} className="flex shrink-0 items-center gap-1 rounded-md px-1">
      <button
        type="button"
        onClick={onToggle}
        aria-pressed={!hidden}
        aria-label={`${hidden ? t("Show") : t("Hide")} ${entry.label}`}
        title={hidden ? t("Show") : t("Hide")}
        className={button}
      >
        {hidden ? <EyeOff className="h-3.5 w-3.5" aria-hidden /> : <Eye className="h-3.5 w-3.5" aria-hidden />}
      </button>
      <span className={`min-w-0 flex-1 truncate text-[11px] ${hidden ? "text-faint line-through" : "text-ink"}`}>{entry.label}</span>
      <button type="button" onClick={() => onMove(-1)} disabled={first} aria-label={`${t("Move up")} ${entry.label}`} title={t("Move up")} className={button}>
        <ArrowUp className="h-3.5 w-3.5" aria-hidden />
      </button>
      <button type="button" onClick={() => onMove(1)} disabled={last} aria-label={`${t("Move down")} ${entry.label}`} title={t("Move down")} className={button}>
        <ArrowDown className="h-3.5 w-3.5" aria-hidden />
      </button>
    </li>
  );
};

/**
 * Remaining plan usage of each connected runtime, at the bottom of the sidebar.
 * Nothing is drawn until a connected runtime reports its usage.
 */
export const UsagePanel: React.FC = () => {
  const { t } = useT();
  const { report, refreshing, refresh } = useRuntimeUsage();
  const [prefs, setPrefs] = useState<UsagePrefs>(loadUsagePrefs);
  const [editing, setEditing] = useState(false);

  if (!report || report.entries.length === 0) return null;

  const update = (next: UsagePrefs) => {
    setPrefs(next);
    saveUsagePrefs(next);
  };
  const arranged = orderUsage(report.entries, prefs);
  const shown = visibleUsage(report.entries, prefs);
  const iconButton = "rounded p-1 text-faint hover:bg-subtle hover:text-ink";

  return (
    <section aria-label={t("Usage remaining")} className="mt-2 shrink-0 border-t border-line pt-2">
      <div className="flex items-center gap-1 px-2 pb-1">
        <h2 className="flex-1 text-[11px] font-semibold text-faint">{t("Usage remaining")}</h2>
        {!editing && (
          <button type="button" onClick={() => void refresh()} disabled={refreshing} aria-label={t("Refresh usage")} title={t("Refresh usage")} className={iconButton}>
            <RefreshCw className={`h-3 w-3 ${refreshing ? "animate-spin" : ""}`} aria-hidden />
          </button>
        )}
        <button
          type="button"
          onClick={() => setEditing((open) => !open)}
          aria-pressed={editing}
          aria-label={editing ? t("Finish arranging") : t("Arrange usage")}
          title={editing ? t("Finish arranging") : t("Arrange usage")}
          className={iconButton}
        >
          {editing ? <Check className="h-3 w-3" aria-hidden /> : <SlidersHorizontal className="h-3 w-3" aria-hidden />}
        </button>
      </div>

      {editing ? (
        <ul style={{ maxHeight: listHeight(EDIT_ROW_PX) }} className={LIST_CLASS}>
          {arranged.map((entry, index) => (
            <EditRow
              key={entry.runtime}
              entry={entry}
              hidden={prefs.hidden.includes(entry.runtime)}
              first={index === 0}
              last={index === arranged.length - 1}
              onToggle={() => update(toggleUsageHidden(prefs, entry.runtime))}
              onMove={(direction) => update(moveUsage(prefs, arranged.map((item) => item.runtime), entry.runtime, direction))}
            />
          ))}
        </ul>
      ) : shown.length === 0 ? (
        <p className="px-2 text-[10px] text-faint">{t("All usage rows are hidden.")}</p>
      ) : (
        <ul style={{ maxHeight: listHeight(ROW_PX) }} className={LIST_CLASS}>
          {shown.map((entry) => <UsageRow key={entry.runtime} entry={entry} />)}
        </ul>
      )}
    </section>
  );
};

export default UsagePanel;
