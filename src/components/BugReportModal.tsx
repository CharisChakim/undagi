// Copyright (c) 2026 Charis Chakim - Undagi (https://github.com/CharisChakim/undagi)
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import React, { useEffect, useRef, useState } from "react";
import { Bug, X } from "lucide-react";
import { useT } from "../lib/i18n";
import { BUG_DESCRIPTION_MAX, BUG_TITLE_MAX, bugReportUrl, isBugReportComplete } from "../lib/bugReport";

interface BugReportModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const BugReportModal: React.FC<BugReportModalProps> = ({ isOpen, onClose }) => {
  const { t } = useT();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const titleInput = useRef<HTMLInputElement>(null);

  // Same as the other dialogs: focus goes in, Escape closes, focus goes back.
  useEffect(() => {
    if (!isOpen) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const frame = window.requestAnimationFrame(() => titleInput.current?.focus());
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener("keydown", closeOnEscape);
      previousFocus?.focus();
    };
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const complete = isBugReportComplete({ title, description });

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!complete) return;
    window.open(bugReportUrl({ title, description }, __APP_VERSION__), "_blank", "noopener,noreferrer");
    setTitle("");
    setDescription("");
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-black/50 p-4 backdrop-blur-xs">
      <form
        role="dialog"
        aria-modal="true"
        aria-labelledby="bug-report-title"
        onSubmit={submit}
        className="card shadow-elev-3 w-full max-w-lg overflow-hidden animate-in fade-in zoom-in-95 duration-200"
      >
        <div className="flex items-center justify-between border-b border-line px-6 py-4">
          <div className="flex items-center gap-2.5">
            <Bug className="h-4 w-4 text-faint" aria-hidden />
            <h3 id="bug-report-title" className="font-semibold text-ink">{t("Report a bug")}</h3>
          </div>
          <button type="button" onClick={onClose} className="rounded-lg p-1.5 text-faint transition-colors hover:bg-subtle hover:text-ink" aria-label={t("Close")}>
            <X className="h-4 w-4" aria-hidden />
          </button>
        </div>

        <div className="space-y-4 p-6">
          <div>
            <label className="field-label" htmlFor="bug-report-title-input">{t("Title")} <span className="text-danger">*</span></label>
            <input
              id="bug-report-title-input"
              ref={titleInput}
              className="field"
              value={title}
              maxLength={BUG_TITLE_MAX}
              onChange={(event) => setTitle(event.target.value)}
              placeholder={t("What went wrong, in a few words")}
            />
          </div>
          <div>
            <label className="field-label" htmlFor="bug-report-description">{t("Description")} <span className="text-danger">*</span></label>
            <textarea
              id="bug-report-description"
              rows={6}
              className="field resize-y leading-relaxed"
              value={description}
              maxLength={BUG_DESCRIPTION_MAX}
              onChange={(event) => setDescription(event.target.value)}
              placeholder={t("What you did, what you expected, and what happened instead...")}
            />
          </div>
          <p className="text-xs leading-relaxed text-faint">
            {t("This opens a prefilled issue on GitHub. You review it there and submit it with your own account; Undagi sends nothing itself.")}
          </p>
        </div>

        <div className="flex justify-end gap-2 border-t border-line px-6 py-4">
          <button type="button" onClick={onClose} className="btn-outline">{t("Cancel")}</button>
          <button type="submit" disabled={!complete} className="btn-primary disabled:opacity-50">{t("Continue to GitHub Issues")}</button>
        </div>
      </form>
    </div>
  );
};

export default BugReportModal;
