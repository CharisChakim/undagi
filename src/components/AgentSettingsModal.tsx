// Copyright (c) 2026 Charis Chakim - Undagi (https://github.com/CharisChakim/undagi)
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import React, { useEffect, useRef } from "react";
import { Settings2, X } from "lucide-react";
import type { AgentHarnessSettings } from "../lib/agentHarness";
import { useT } from "../lib/i18n";

interface AgentSettingsModalProps {
  isOpen: boolean;
  settings: AgentHarnessSettings;
  onChange: (settings: AgentHarnessSettings) => void;
  onClose: () => void;
}

interface ToggleProps {
  checked: boolean;
  title: string;
  description: string;
  onChange: (checked: boolean) => void;
}

// Checkbox aslinya tetap dipakai dan hanya disembunyikan secara visual: ia yang
// membawa peran, status, dan dukungan keyboard, sementara trek dan knob di
// sebelahnya murni tampilan.
const Toggle: React.FC<ToggleProps> = ({ checked, title, description, onChange }) => (
  <label className="switch-row">
    <span className="min-w-0 flex-1">
      <span className="block text-sm font-medium text-ink">{title}</span>
      <span className="mt-1 block text-xs leading-relaxed text-muted">{description}</span>
    </span>
    <input
      type="checkbox"
      role="switch"
      checked={checked}
      onChange={(event) => onChange(event.target.checked)}
      className="switch-input sr-only"
    />
    <span className="switch mt-0.5" aria-hidden>
      <span className="switch-knob" />
    </span>
  </label>
);

export const AgentSettingsModal: React.FC<AgentSettingsModalProps> = ({ isOpen, settings, onChange, onClose }) => {
  const { t } = useT();
  const closeButton = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!isOpen) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const frame = window.requestAnimationFrame(() => closeButton.current?.focus());
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

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-xs" onMouseDown={onClose}>
      <div role="dialog" aria-modal="true" aria-labelledby="agent-settings-title" className="card w-full max-w-lg overflow-hidden shadow-lg" onMouseDown={(event) => event.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-line px-5 py-4">
          <div className="flex items-center gap-2.5">
            <Settings2 className="h-4 w-4 text-accent-ink" aria-hidden />
            <h3 id="agent-settings-title" className="font-semibold text-ink">{t("Agent settings")}</h3>
          </div>
          <button ref={closeButton} type="button" onClick={onClose} aria-label={t("Close")} className="rounded-lg p-1.5 text-faint hover:bg-subtle hover:text-ink">
            <X className="h-4 w-4" aria-hidden />
          </button>
        </div>

        <div className="space-y-3 p-5">
          <p className="px-1 text-[11px] font-medium text-faint">{t("Efficiency stack")}</p>
          <p className="px-1 text-[11px] leading-relaxed text-faint">
            {t("For API connections only. Codex, Claude Code and Antigravity follow their own system prompt and your own setup for these.")}
          </p>
          <Toggle
            checked={settings.compactTerminal}
            title={t("RTK · Compact terminal")}
            description={t("Targeted commands, rg-first search, capped output, and summarized logs instead of raw dumps.")}
            onChange={(compactTerminal) => onChange({ ...settings, compactTerminal })}
          />
          <Toggle
            checked={settings.conciseAnswers}
            title={t("Caveman · Concise answers")}
            description={t("Answers only what was asked: no preambles, repetition, or unsolicited alternatives. Code, paths, numbers, and warnings stay verbatim.")}
            onChange={(conciseAnswers) => onChange({ ...settings, conciseAnswers })}
          />
          <Toggle
            checked={settings.minimalCode}
            title={t("Ponytail · Minimal code")}
            description={t("Implements the minimum correct change. No speculative abstractions, dependencies, or rewrites.")}
            onChange={(minimalCode) => onChange({ ...settings, minimalCode })}
          />
          <Toggle
            checked={settings.karpathyGuidelines}
            title={t("Karpathy Guidelines")}
            description={t("Requires explicit assumptions, surgical changes, simple solutions, and verification for coding work.")}
            onChange={(karpathyGuidelines) => onChange({ ...settings, karpathyGuidelines })}
          />
          <p className="px-1 text-[11px] leading-relaxed text-faint">
            {t("All are enabled by default. Switch off any layer on its own to drop just its prompt tokens. Lower runtime effort for larger token savings on simple work.")}
          </p>
          <p className="px-1 pt-2 text-[11px] font-medium text-faint">{t("Language")}</p>
          <Toggle
            checked={settings.agentInstructionsFollowUi}
            title={t("Write agent instructions in the interface language")}
            description={t("Off (recommended): task instructions and verification steps are written in English, which Codex and Claude Code follow best. Titles and descriptions still use your language.")}
            onChange={(agentInstructionsFollowUi) => onChange({ ...settings, agentInstructionsFollowUi })}
          />
        </div>
      </div>
    </div>
  );
};

export default AgentSettingsModal;
