import React, { useEffect, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import { useT } from "../lib/i18n";

interface GenerationProgressProps {
  active: boolean;
  label: string;
  chars: number;
  onCancel?: () => void;
}

// A runtime takes this long to start before it can answer at all.
const STARTING_SECONDS = 15;

const elapsedLabel = (ms: number): string => {
  const totalSeconds = Math.floor(ms / 1000);
  return `${Math.floor(totalSeconds / 60)}:${String(totalSeconds % 60).padStart(2, "0")}`;
};

export const GenerationProgress: React.FC<GenerationProgressProps> = ({ active, label, chars, onCancel }) => {
  const { t, lang } = useT();
  const [elapsed, setElapsed] = useState(0);
  const startedAt = useRef(0);

  useEffect(() => {
    if (!active) {
      setElapsed(0);
      return;
    }
    startedAt.current = Date.now();
    setElapsed(0);
    const timer = window.setInterval(() => setElapsed(Date.now() - startedAt.current), 200);
    return () => window.clearInterval(timer);
  }, [active]);

  if (!active) return null;

  // With no characters yet the app cannot tell "starting" from "the model is
  // thinking", so the wait is told apart by how long it has been.
  const phase = chars > 0
    ? t("Writing the answer.")
    : elapsed < STARTING_SECONDS * 1000
      ? t("Starting the model.")
      : t("The model is thinking before it writes. At a high effort level this can take a few minutes.");

  return (
    <div className="card flex flex-wrap items-center gap-3 px-3 py-2.5" role="status" aria-live="polite">
      <RefreshCw className="h-4 w-4 shrink-0 animate-spin text-accent-ink" aria-hidden />
      <span className="min-w-0 flex-1 text-sm text-ink">{label}</span>
      <span className="shrink-0 text-xs tabular-nums text-faint">
        {t("{chars} chars · {time}", {
          chars: new Intl.NumberFormat(lang === "id" ? "id-ID" : "en-US").format(Math.max(0, chars)),
          time: elapsedLabel(elapsed),
        })}
      </span>
      {onCancel && (
        <button type="button" onClick={onCancel} className="btn-outline !px-2.5 !py-1 text-xs">
          {t("Cancel")}
        </button>
      )}
      <div className="h-1 w-full overflow-hidden rounded-full bg-subtle" aria-hidden>
        <div className="progress-sweep h-full w-1/3 rounded-full bg-accent" />
      </div>
      <p className="w-full text-xs text-faint">{phase}</p>
    </div>
  );
};

export default GenerationProgress;
