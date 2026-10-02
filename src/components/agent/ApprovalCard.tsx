import React, { useEffect, useState } from "react";
import { Check, Clock3, FilePen, Terminal, X } from "lucide-react";
import type { ApprovalFile } from "../../lib/agentEvents";
import { useT } from "../../lib/i18n";
import { DiffView } from "./toolRenderers";

const APPROVAL_TIMEOUT_SECONDS = 300;

type DecisionHandler = (approved: boolean) => void | Promise<void>;
type EntryDecisionHandler = (elicitId: string, approved: boolean) => void | Promise<void>;

interface ApprovalEntry {
  elicitId: string;
  command: string;
  cwd?: string;
  blockedPath?: string;
  files?: ApprovalFile[];
  decided: boolean;
  approved?: boolean;
}

export interface ApprovalCardProps {
  entry?: ApprovalEntry;
  command?: string;
  cwd?: string;
  blockedPath?: string;
  /** Set for a file-change approval, which has files to show instead of a command. */
  files?: ApprovalFile[];
  resolved?: boolean;
  decided?: boolean;
  approved?: boolean;
  onDecide?: DecisionHandler;
  onRespond?: EntryDecisionHandler;
  decide?: DecisionHandler;
}

const FILE_KIND_LABEL: Record<ApprovalFile["kind"], string> = {
  add: "New file",
  update: "Modified",
  delete: "Deleted",
  other: "Change",
};

// An added file arrives as its content, not as a diff; shown as added lines.
const addedLines = (content: string): string =>
  content.replace(/\r?\n$/, "").split(/\r?\n/).map((line) => `+${line}`).join("\n");

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
  files,
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
  const approvalFiles = files ?? entry?.files;
  const fileChange = approvalFiles !== undefined;
  const title = fileChange ? t("Apply these file changes?") : t("Run this command?");
  const isResolved = resolved ?? entry?.decided ?? decided;
  const approvalResult = approved ?? entry?.approved;
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
      aria-label={title}
      onKeyDown={handleKeyDown}
      className={`rounded-xl border px-3 py-2.5 space-y-2 focus:outline-hidden focus-visible:ring-2 focus-visible:ring-accent ${
        isResolved ? "border-line bg-subtle" : expired ? "border-danger/30 bg-danger-soft" : "border-warn/40 bg-warn-soft"
      }`}
    >
      <div className="flex items-center gap-2 text-xs font-medium text-warn-ink">
        {fileChange
          ? <FilePen className="w-3.5 h-3.5 shrink-0" aria-hidden />
          : <Terminal className="w-3.5 h-3.5 shrink-0" aria-hidden />}
        <span>{title}</span>
        {!isResolved && (
          <span className={`ml-auto inline-flex items-center gap-1 font-normal ${expired ? "text-danger-ink" : ""}`} title="300-second approval timeout">
            <Clock3 className="w-3.5 h-3.5" aria-hidden />
            {formatCountdown(remaining)}
          </span>
        )}
      </div>

      {fileChange ? (
        approvalFiles.length ? (
          <ul className="space-y-2">
            {approvalFiles.map((file) => (
              <li key={file.path} className="space-y-1">
                <div className="flex items-baseline gap-2 text-xs">
                  <span className="shrink-0 rounded bg-canvas px-1.5 py-0.5 text-[10px] font-medium text-muted">{t(FILE_KIND_LABEL[file.kind])}</span>
                  <code className="min-w-0 break-all font-mono text-ink">{file.path}</code>
                </div>
                {file.movePath && (
                  <div className="text-xs text-muted break-all">{t("Moves to {path}", { path: file.movePath })}</div>
                )}
                {file.diff && <DiffView patch={file.kind === "add" ? addedLines(file.diff) : file.diff} className="max-h-64 overflow-y-auto" />}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-muted">{t("The runtime did not say which files this changes.")}</p>
        )
      ) : (
        <pre className="text-xs font-mono text-ink whitespace-pre-wrap break-all bg-canvas rounded-lg px-2.5 py-2">
          {approvalCommand}
        </pre>
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
          {fileChange
            ? (approvalResult ? t("Approved — the change went ahead.") : t("Denied — nothing changed."))
            : (approvalResult ? t("Approved — it ran.") : t("Denied — nothing ran."))}
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
            {fileChange ? t("Apply") : t("Run it")} <kbd className="ml-1 opacity-70">Y</kbd>
          </button>
          <button
            type="button"
            onClick={() => handleDecision(false)}
            disabled={deciding}
            className="px-3 py-1.5 rounded-lg border border-line text-xs font-medium text-ink disabled:opacity-40"
          >
            {fileChange ? t("Don't apply") : t("Don't run")} <kbd className="ml-1 text-faint">N</kbd>
          </button>
        </div>
      )}
    </div>
  );
};

export default ApprovalCard;
