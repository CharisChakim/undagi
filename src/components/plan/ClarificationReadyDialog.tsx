// Copyright (c) 2026 Charis Chakim - Undagi (https://github.com/CharisChakim/undagi)
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import React, { useEffect, useRef } from "react";
import { CheckCircle2, Sparkles } from "lucide-react";
import { useT } from "../../lib/i18n";

interface ClarificationReadyDialogProps {
  /** The AI's own note on why it has enough; may be empty. */
  note: string;
  onGenerate: () => void;
  onClose: () => void;
}

// Shown when a clarification round ends with "nothing more to ask", so the user
// is told and offered the next step instead of having to notice a small banner.
export const ClarificationReadyDialog: React.FC<ClarificationReadyDialogProps> = ({ note, onGenerate, onClose }) => {
  const { t } = useT();
  const primary = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const frame = window.requestAnimationFrame(() => primary.current?.focus());
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener("keydown", closeOnEscape);
      previousFocus?.focus();
    };
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-xs" onMouseDown={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="clarification-ready-title"
        className="card w-full max-w-md space-y-4 p-5 shadow-elev-3"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="flex items-start gap-3">
          <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-ok" aria-hidden />
          <div className="space-y-1.5">
            <h2 id="clarification-ready-title" className="text-sm font-semibold text-ink">{t("The AI has what it needs")}</h2>
            {note && <p className="text-xs leading-relaxed text-muted">{note}</p>}
            <p className="text-xs leading-relaxed text-muted">{t("Generate the project plan now, or go back and change an answer first.")}</p>
          </div>
        </div>
        <div className="flex flex-wrap justify-end gap-2">
          <button type="button" onClick={onClose} className="btn-outline">{t("Not yet")}</button>
          <button ref={primary} type="button" onClick={onGenerate} className="btn-primary">
            <Sparkles className="h-4 w-4" aria-hidden /> {t("Generate project plan")}
          </button>
        </div>
      </div>
    </div>
  );
};

export default ClarificationReadyDialog;
