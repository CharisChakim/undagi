import React, { useEffect, useState } from "react";
import { Check, Clock3, Terminal, X } from "lucide-react";
import { useT } from "../../lib/i18n";
import type { ApprovalAdvice } from "../../lib/jev";

const APPROVAL_TIMEOUT_SECONDS = 300;

type DecisionHandler = (approved: boolean) => void | Promise<void>;
type EntryDecisionHandler = (elicitId: string, approved: boolean) => void | Promise<void>;

interface ApprovalEntry {
  elicitId: string;
  command: string;
  cwd?: string;
  blockedPath?: string;
  decided: boolean;
  approved?: boolean;
  advice?: ApprovalAdvice;
}

export interface ApprovalCardProps {
  entry?: ApprovalEntry;
  command?: string;
  cwd?: string;
  blockedPath?: string;
  resolved?: boolean;
  decided?: boolean;
  approved?: boolean;
  onDecide?: DecisionHandler;
  onRespond?: EntryDecisionHandler;
  decide?: DecisionHandler;
}

// Neutral pill; only the dot and the word take the risk colour.
const RISK_TONE: Record<ApprovalAdvice["risk"], string> = {
  low: "text-ok-ink",
  medium: "text-warn-ink",
  high: "text-danger-ink",
};
const RISK_DOT: Record<ApprovalAdvice["risk"], string> = { low: "bg-ok", medium: "bg-warn", high: "bg-danger" };

const formatCountdown = (seconds: number): string => {
  const minutes = Math.floor(seconds / 60);
  const remainder = String(seconds % 60).padStart(2, "0");
  return `${minutes}:${remainder}`;
};

export const ApprovalCard: React.FC<ApprovalCardProps> = ({
  entry,
  command,
  cwd,
  blockedPath,
  resolved,
  decided = false,
  approved,
  onDecide,
  onRespond,
  decide,
}) => {
  const { t } = useT();
  const approvalCommand = command ?? entry?.command ?? "";
  const approvalCwd = cwd ?? entry?.cwd;
  const approvalBlockedPath = blockedPath ?? entry?.blockedPath;
  const isResolved = resolved ?? entry?.decided ?? decided;
  const approvalResult = approved ?? entry?.approved;
  const advice = entry?.advice;
  const advicePercent = advice ? Math.round(Math.min(1, Math.max(0, advice.confidence)) * 100) : 0;
  const [remaining, setRemaining] = useState(APPROVAL_TIMEOUT_SECONDS);
  const [deciding, setDeciding] = useState(false);

  useEffect(() => {
    if (isResolved) return undefined;
    const deadline = Date.now() + APPROVAL_TIMEOUT_SECONDS * 1000;
    const update = () => {
      setRemaining(Math.max(0, Math.ceil((deadline - Date.now()) / 1000)));
    };

    update();
    const timer = window.setInterval(update, 1000);
    return () => window.clearInterval(timer);
  }, [isResolved]);

  const expired = !isResolved && remaining === 0;
  const handleDecision = (nextApproved: boolean) => {
    if (isResolved || expired || deciding) return;
    const callback = entry && onRespond
      ? () => onRespond(entry.elicitId, nextApproved)
      : (onDecide ?? decide ? () => (onDecide ?? decide)!(nextApproved) : undefined);
    if (!callback) return;

    setDeciding(true);
    // Resolusi tetap datang dari server; kartu tidak ditutup optimistis setelah klik.
    void Promise.resolve()
      .then(callback)
      .catch(() => undefined)
      .finally(() => setDeciding(false));
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.repeat || isResolved || expired || deciding) return;
    const key = event.key.toLowerCase();
    if (key !== "y" && key !== "n") return;
    event.preventDefault();
    handleDecision(key === "y");
  };

  return (
    <div
      role="group"
      tabIndex={isResolved ? -1 : 0}
      aria-keyshortcuts="Y N"
      aria-label={t("Run this command?")}
      onKeyDown={handleKeyDown}
      className={`rounded-xl border px-3 py-2.5 space-y-2 focus:outline-hidden focus-visible:ring-2 focus-visible:ring-accent ${
        isResolved ? "border-line bg-subtle" : expired ? "border-danger/30 bg-danger-soft" : "border-warn/40 bg-warn-soft"
      }`}
    >
      <div className="flex items-center gap-2 text-xs font-medium text-warn-ink">
        <Terminal className="w-3.5 h-3.5 shrink-0" aria-hidden />
        <span>{t("Run this command?")}</span>
        {!isResolved && (
          <span className={`ml-auto inline-flex items-center gap-1 font-normal ${expired ? "text-danger-ink" : ""}`} title="300-second approval timeout">
            <Clock3 className="w-3.5 h-3.5" aria-hidden />
            {formatCountdown(remaining)}
          </span>
        )}
      </div>

      <pre className="text-xs font-mono text-ink whitespace-pre-wrap break-all bg-canvas rounded-lg px-2.5 py-2">
        {approvalCommand}
      </pre>

      {advice && !isResolved && (
        <div>
          <span
            title={t("Advisory only — you decide")}
            className="inline-flex items-center gap-1.5 rounded-full border border-line bg-canvas px-2 py-0.5 text-[11px]"
          >
            <span className={`h-1.5 w-1.5 rounded-full ${RISK_DOT[advice.risk]}`} aria-hidden />
            <span className={RISK_TONE[advice.risk]}>
              {advice.risk === "low"
                ? t("Jev: low risk · {percent}% sure", { percent: advicePercent })
                : advice.risk === "medium"
                  ? t("Jev: medium risk · {percent}% sure", { percent: advicePercent })
                  : t("Jev: high risk · {percent}% sure", { percent: advicePercent })}
            </span>
          </span>
        </div>
      )}

      {approvalCwd && (
        <div className="text-xs text-muted break-all">
          {t("Working folder")}: <code className="font-mono text-ink">{approvalCwd}</code>
        </div>
      )}

      {approvalBlockedPath && (
        <div className="text-xs text-muted break-all">
          {t("Blocked path")}: <code className="font-mono text-ink">{approvalBlockedPath}</code>
        </div>
      )}

      {isResolved ? (
        <p className="flex items-center gap-1.5 text-xs text-muted">
          {approvalResult ? <Check className="w-3.5 h-3.5 text-ok" aria-hidden /> : <X className="w-3.5 h-3.5 text-danger" aria-hidden />}
          {approvalResult ? t("Approved — it ran.") : t("Denied — nothing ran.")}
        </p>
      ) : expired ? (
        <p className="text-xs text-danger-ink">{t("Approval expired; waiting for server confirmation.")}</p>
      ) : (
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => handleDecision(true)}
            disabled={deciding}
            className="px-3 py-1.5 rounded-lg bg-accent text-accent-fg text-xs font-medium disabled:opacity-40"
          >
            {t("Run it")} <kbd className="ml-1 opacity-70">Y</kbd>
          </button>
          <button
            type="button"
            onClick={() => handleDecision(false)}
            disabled={deciding}
            className="px-3 py-1.5 rounded-lg border border-line text-xs font-medium text-ink disabled:opacity-40"
          >
            {t("Don't run")} <kbd className="ml-1 text-faint">N</kbd>
          </button>
        </div>
      )}
    </div>
  );
};

export default ApprovalCard;
