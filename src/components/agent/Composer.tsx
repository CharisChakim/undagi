// Copyright (c) 2026 Charis Chakim - Undagi (https://github.com/CharisChakim/undagi)
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import React from "react";
import { LoaderCircle, RotateCcw, Send, Square } from "lucide-react";
import { useDraft } from "../../lib/draftStore";
import { useT } from "../../lib/i18n";
import type { PermissionMode } from "../../types";

type SendHandler = (text: string) => void | Promise<void | boolean>;
type ActionHandler = () => void | Promise<void>;

const PERMISSION_HINTS: Record<PermissionMode, string> = {
  ask: "Every file edit and command waits for your approval.",
  auto: "File edits in the working folder go ahead; commands still ask.",
  full: "Edits and commands run without asking.",
};

export interface ComposerProps {
  send?: SendHandler;
  onSend?: SendHandler;
  busy?: boolean;
  stop?: ActionHandler;
  onStop?: ActionHandler;
  retry?: ActionHandler;
  onRetry?: ActionHandler;
  disabled?: boolean;
  placeholder?: string;
  sessionId?: string;
  conversationId?: string;
  permissionMode?: PermissionMode;
  onPermissionModeChange?: (mode: PermissionMode) => void;
  contextControls?: React.ReactNode;
  controls?: React.ReactNode;
  secondaryControls?: React.ReactNode;
  variant?: "default" | "hero";
}

export const Composer: React.FC<ComposerProps> = ({
  send,
  onSend,
  busy = false,
  stop,
  onStop,
  retry,
  onRetry,
  disabled = false,
  placeholder,
  sessionId,
  conversationId,
  permissionMode = "ask",
  onPermissionModeChange,
  contextControls,
  controls,
  secondaryControls,
  variant = "default",
}) => {
  const { t } = useT();
  const [draft, setDraft, clearDraft] = useDraft(
    { sessionId, conversationId, name: "agent-composer" },
    "",
  );
  const sendHandler = onSend ?? send;
  const stopHandler = onStop ?? stop;
  const retryHandler = onRetry ?? retry;

  const submit = async () => {
    const message = draft.trim();
    if (!message || busy || disabled || !sendHandler) return;
    try {
      const result = await sendHandler(message);
      if (result !== false) clearDraft("");
    } catch {
      // The owner renders the action error. Keeping the draft allows retry.
    }
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    void submit();
  };

  return (
    <form
      className={variant === "hero" ? "mt-6 w-full" : "bg-surface px-3 pb-3 pt-2"}
      onSubmit={(event) => { event.preventDefault(); void submit(); }}
    >
      <div className="overflow-visible rounded-2xl border border-line bg-surface shadow-elev-3 focus-within:border-accent focus-within:ring-2 focus-within:ring-accent/15">
        {contextControls && (
          <div className="flex min-h-10 min-w-0 flex-wrap items-center gap-x-3 gap-y-1 rounded-t-2xl border-b border-line bg-subtle/60 px-3 py-2 text-[11px] text-muted">
            {contextControls}
          </div>
        )}
        <textarea
          rows={variant === "hero" ? 3 : 2}
          value={draft}
          disabled={disabled || busy}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder ?? t("Ask for a change...")}
          aria-label={placeholder ?? t("Ask for a change...")}
          aria-describedby="agent-composer-hint"
          className={`block w-full resize-none border-0 bg-transparent px-4 py-3 text-ink outline-hidden placeholder:text-faint disabled:opacity-60 ${contextControls ? "" : "rounded-t-2xl"} ${variant === "hero" ? "min-h-24" : "min-h-16"}`}
        />

        <div className="flex min-w-0 items-end gap-2 px-2 py-2">
          {/* Semua pilihan untuk giliran ini berkumpul di kiri, tombol kirim
              sendiri di kanan; kalau tidak muat, pilihanlah yang turun baris. */}
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
            {controls}
            <label className="sr-only" htmlFor="agent-composer-permission">{t("Permission mode")}</label>
            <select
              id="agent-composer-permission"
              value={permissionMode}
              onChange={(event) => onPermissionModeChange?.(event.target.value as PermissionMode)}
              disabled={disabled || busy || !onPermissionModeChange}
              title={t(PERMISSION_HINTS[permissionMode])}
              className={`h-8 rounded-lg border-0 bg-transparent px-2 text-[11px] font-medium outline-hidden hover:bg-subtle focus:bg-subtle ${permissionMode === "full" ? "text-warn-ink" : "text-ink"}`}
            >
              <option value="ask">{t("Ask for permission")}</option>
              <option value="auto">{t("Auto mode")}</option>
              <option value="full">{t("Full access")}</option>
            </select>
            {secondaryControls && <span className="mx-0.5 h-4 w-px shrink-0 bg-line" aria-hidden />}
            {secondaryControls}
          </div>

          <div className="flex shrink-0 items-center gap-1">
            {retryHandler && !busy && (
              <button type="button" onClick={() => void retryHandler()} disabled={disabled} aria-label={t("Retry")} title={t("Retry")} className="shrink-0 rounded-lg border border-line p-2 text-muted hover:bg-subtle hover:text-ink disabled:opacity-40">
                <RotateCcw className="h-4 w-4" aria-hidden />
              </button>
            )}

            {/* Separate keys: reusing one node let the Stop click finish as a
                click on Send once the turn ended, which sent the message again. */}
            {busy && stopHandler ? (
              <button key="stop" type="button" onClick={() => void stopHandler()} aria-label={t("Stop")} title={t("Stop")} className="shrink-0 rounded-lg border border-danger/30 p-2 text-danger-ink hover:bg-danger-soft">
                <Square className="h-4 w-4" aria-hidden />
              </button>
            ) : (
              <button key="send" type="submit" disabled={busy || disabled || !draft.trim() || !sendHandler} aria-label={t("Send")} className="shrink-0 rounded-lg bg-accent p-2 text-accent-fg disabled:bg-subtle disabled:text-faint">
                {busy ? <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden /> : <Send className="h-4 w-4" aria-hidden />}
              </button>
            )}
          </div>
        </div>

      </div>
      <p id="agent-composer-hint" className="mt-1.5 px-1 text-[11px] text-faint">{t("Press Enter to send · Shift+Enter for a new line")}</p>
    </form>
  );
};

export default Composer;
