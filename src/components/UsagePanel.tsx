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

// Every height is fixed, so "three rows, then scroll" is an exact box instead of
// a guess. A row holds one unit per window: a line of text, then its bar.
const TEXT_PX = 11;
const BAR_PX = 3;
const UNIT_PX = TEXT_PX + 5 + BAR_PX;
const UNIT_GAP_PX = 6;
const ROW_PAD_PX = 13;
const EDIT_ROW_PX = 28;
const GAP_PX = 2;
const MAX_ROWS = 3;

/** Height of a row with `units` windows; a row that shows no bar still takes one unit. */
const rowHeight = (units: number) => {
  const count = Math.max(1, units);
  return ROW_PAD_PX + count * UNIT_PX + (count - 1) * UNIT_GAP_PX;
};

/** The first three rows exactly; anything below them scrolls. */
const listHeight = (heights: number[]) => {
  const first = heights.slice(0, MAX_ROWS);
  return first.reduce((sum, height) => sum + height, 0) + Math.max(0, first.length - 1) * GAP_PX;
};

const shownWindows = (entry: RuntimeUsage) => (entry.error ? [] : entry.windows);

// A scrollbar that only appears past three rows must not eat the row's width.
const LIST_CLASS = "flex flex-col gap-0.5 overflow-y-auto overflow-x-hidden [scrollbar-width:thin] [scrollbar-color:var(--app-line)_transparent]";

function windowLabel(window: UsageWindow, t: TFunction): string {
  if (window.label) return window.label;
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

function windowDetail(window: UsageWindow, t: TFunction): string {
  const remaining = t("{label}: {percent}% left", { label: windowLabel(window, t), percent: remainingPercent(window) });
  const reset = resetText(window, t);
  return reset ? `${remaining} · ${reset}` : remaining;
}

// One unit per window, stacked: "label percent" on the right, the bar under it.
// The runtime's name sits on the left of the first unit.
const UsageRow: React.FC<{ entry: RuntimeUsage }> = ({ entry }) => {
  const { t } = useT();
  const windows = shownWindows(entry);
  const details = windows.length ? windows.map((window) => windowDetail(window, t)) : [t("Usage unavailable")];
  const minutesAgo = entry.readAt ? Math.max(1, Math.round((Date.now() - Date.parse(entry.readAt)) / 60_000)) : null;
  const staleNote = entry.stale && minutesAgo !== null ? t("Not refreshed: last read {count} min ago", { count: minutesAgo }) : null;
  const tooltip = [entry.plan ? `${entry.label} · ${entry.plan}` : entry.label, ...details, ...(staleNote ? [staleNote] : [])].join("\n");
  const name = <span className="min-w-0 flex-1 truncate text-[11px] text-muted">{entry.label}</span>;
  return (
    <li
      title={tooltip}
      style={{ height: rowHeight(windows.length), gap: UNIT_GAP_PX }}
      className="flex shrink-0 flex-col justify-center rounded-md px-2 hover:bg-subtle"
    >
      {windows.length === 0 ? (
        <div className="flex items-baseline gap-2 leading-none">
          {name}
          <span className="shrink-0 text-[10px] text-faint">{t("Usage unavailable")}</span>
        </div>
      ) : windows.map((window, index) => {
        const remaining = remainingPercent(window);
        return (
          <div key={window.id} style={{ height: UNIT_PX }} className="flex flex-col justify-between">
            <div className="flex items-baseline gap-2 leading-none">
              {index === 0 ? name : <span className="flex-1" aria-hidden />}
              <span className="min-w-0 truncate text-[10px] text-faint">{windowLabel(window, t)}</span>
              <span className={`shrink-0 text-[11px] tabular-nums ${entry.stale ? "text-faint" : "text-ink"}`}>{remaining}%</span>
            </div>
            <div
              role="meter"
              aria-label={[entry.label, windowDetail(window, t), staleNote].filter(Boolean).join(", ")}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={remaining}
              style={{ height: BAR_PX }}
              className="overflow-hidden rounded-full bg-subtle"
            >
              <div className={`h-full rounded-full ${fillClass(remaining)}`} style={{ width: `${remaining}%` }} />
            </div>
          </div>
        );
      })}
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
        <ul style={{ maxHeight: listHeight(arranged.map(() => EDIT_ROW_PX)) }} className={LIST_CLASS}>
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
        <ul style={{ maxHeight: listHeight(shown.map((entry) => rowHeight(shownWindows(entry).length))) }} className={LIST_CLASS}>
          {shown.map((entry) => <UsageRow key={entry.runtime} entry={entry} />)}
        </ul>
      )}
    </section>
  );
};

export default UsagePanel;
