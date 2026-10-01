import React, { useEffect, useRef, useState } from "react";
import { AlertCircle, RefreshCw, Save, Settings2, X } from "lucide-react";
import type { AgentHarnessSettings } from "../lib/agentHarness";
import { useT } from "../lib/i18n";
import { saveJevSettings, testJev, type JevFeature, type JevSettingsPatch, type JevSettingsPublic } from "../lib/jev";
import { useJevSettings } from "../lib/useJevSettings";
import { jevFeaturesEditable, jevOrOff, jevTestOutcome, type JevTestOutcome } from "./agentSettingsJev";

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
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}

// Checkbox aslinya tetap dipakai dan hanya disembunyikan secara visual: ia yang
// membawa peran, status, dan dukungan keyboard, sementara trek dan knob di
// sebelahnya murni tampilan.
const Toggle: React.FC<ToggleProps> = ({ checked, title, description, disabled = false, onChange }) => (
  <label className={disabled ? "switch-row pointer-events-none opacity-60" : "switch-row"}>
    <span className="min-w-0 flex-1">
      <span className="block text-sm font-medium text-ink">{title}</span>
      <span className="mt-1 block text-xs leading-relaxed text-muted">{description}</span>
    </span>
    <input
      type="checkbox"
      role="switch"
      checked={checked}
      disabled={disabled}
      aria-disabled={disabled || undefined}
      onChange={(event) => onChange(event.target.checked)}
      className="switch-input sr-only"
    />
    <span className="switch mt-0.5" aria-hidden>
      <span className="switch-knob" />
    </span>
  </label>
);

// Jev adalah layanan opsional yang dihosting; pengaturannya hidup di server,
// jadi seksi ini hanya dipasang saat modal terbuka dan selalu membaca ulang.
const JevSection: React.FC = () => {
  const { t } = useT();
  const { settings } = useJevSettings();
  // Hasil simpan dipakai sampai hook selesai memuat ulang, agar sakelar tidak
  // sempat melompat balik ke nilai lama.
  const [saved, setSaved] = useState<{ base: JevSettingsPublic; value: JevSettingsPublic } | null>(null);
  const [keyDraft, setKeyDraft] = useState("");
  const [keyBusy, setKeyBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [testOutcome, setTestOutcome] = useState<JevTestOutcome | null>(null);

  const view = jevOrOff(saved && saved.base === settings ? saved.value : settings);
  const editable = jevFeaturesEditable(view);

  const apply = async (patch: JevSettingsPatch): Promise<boolean> => {
    setError(null);
    try {
      setSaved({ base: settings, value: await saveJevSettings(patch) });
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("Could not save Jev settings."));
      return false;
    }
  };

  const changeKey = async (apiKey: string) => {
    if (keyBusy) return;
    setKeyBusy(true);
    const ok = await apply({ apiKey });
    setKeyBusy(false);
    if (!ok) return;
    setKeyDraft("");
    setTestOutcome(null);
  };

  const runTest = async () => {
    setTesting(true);
    setTestOutcome(null);
    setError(null);
    try {
      setTestOutcome(jevTestOutcome(await testJev(), t));
    } catch (cause) {
      setTestOutcome({ ok: false, text: cause instanceof Error ? cause.message : t("Connection failed.") });
    } finally {
      setTesting(false);
    }
  };

  const features: { feature: JevFeature; title: string; description: string }[] = [
    { feature: "intentRouting", title: t("Understand chat requests"), description: t("Suggests opening the Plan, PRD, or Tasks panel when a message asks for it.") },
    { feature: "intakeCheck", title: t("Check if an idea is clear enough"), description: t("Judges whether a project description has enough detail to plan.") },
    { feature: "permissionRisk", title: t("Rate risk on permission requests"), description: t("Shows a low, medium, or high badge on the approval card. Advisory only.") },
    { feature: "dependencyCheck", title: t("Suggest task dependencies"), description: t("Lists likely dependencies between tasks once they are generated. Advisory only.") },
  ];

  return (
    <section aria-labelledby="jev-settings-title" className="space-y-3 border-t border-line pt-4">
      <h4 id="jev-settings-title" className="px-1 text-[11px] font-medium text-faint">{t("Jev decisions (optional)")}</h4>
      <Toggle
        checked={view.enabled}
        title={t("Enable Jev")}
        description={t("A hosted service that returns typed yes/no, choice, and score decisions with a confidence. It never writes text or code.")}
        onChange={(enabled) => void apply({ enabled })}
      />

      <form
        className="rounded-xl border border-line bg-surface p-4"
        style={{ boxShadow: "var(--elev-1)" }}
        onSubmit={(event) => {
          event.preventDefault();
          const apiKey = keyDraft.trim();
          if (apiKey) void changeKey(apiKey);
        }}
      >
        <div className="flex items-center justify-between gap-3">
          <label htmlFor="jev-api-key" className="field-label mb-0">{t("Jev API key")}</label>
          <span aria-live="polite" className={`text-xs font-medium ${view.hasKey ? "text-ok-ink" : "text-faint"}`}>
            {view.hasKey ? t("Key saved") : t("No key yet")}
          </span>
        </div>
        <div className="mt-2 flex gap-2">
          <input
            id="jev-api-key"
            type="password"
            value={keyDraft}
            onChange={(event) => setKeyDraft(event.target.value)}
            autoComplete="new-password"
            autoCapitalize="off"
            spellCheck={false}
            placeholder={view.hasKey ? t("(stored on server)") : t("Paste your Jev key")}
            aria-describedby="jev-api-key-hint"
            className="field min-w-0 font-mono text-xs"
          />
          <button type="submit" disabled={keyBusy || !keyDraft.trim()} className="btn-primary shrink-0">
            <Save className="h-4 w-4" aria-hidden />
            {keyBusy ? t("Saving...") : t("Save key")}
          </button>
        </div>
        <div className="mt-1.5 flex flex-wrap items-center justify-between gap-3">
          <p id="jev-api-key-hint" className="field-hint mt-0">{t("Blank keeps an existing key. Use Remove key to delete it.")}</p>
          {view.hasKey && (
            <button type="button" onClick={() => void changeKey("")} disabled={keyBusy} className="text-xs font-medium text-danger-ink hover:underline disabled:opacity-40">
              {t("Remove key")}
            </button>
          )}
        </div>
      </form>

      <div className="space-y-3" role="group" aria-label={t("Jev features")}>
        {features.map(({ feature, title, description }) => (
          <Toggle
            key={feature}
            checked={Boolean(view.features[feature])}
            title={title}
            description={description}
            disabled={!editable}
            onChange={(checked) => void apply({ features: { [feature]: checked } })}
          />
        ))}
        {!editable && <p className="px-1 text-[11px] leading-relaxed text-faint">{t("Turn on Jev and save a key to use these.")}</p>}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <button type="button" onClick={() => void runTest()} disabled={testing || !view.hasKey} className="btn-outline">
          <RefreshCw className={`h-4 w-4 ${testing ? "animate-spin" : ""}`} aria-hidden />
          {testing ? t("Testing...") : t("Test connection")}
        </button>
        <p role="status" className={`min-w-0 break-words text-xs ${testOutcome?.ok ? "text-ok-ink" : "text-warn-ink"}`}>{testOutcome?.text}</p>
      </div>

      {error && (
        <div role="alert" className="flex gap-2 break-words rounded-lg border border-warn/30 bg-warn-soft p-3 text-xs text-warn-ink">
          <AlertCircle className="h-4 w-4 shrink-0" aria-hidden />
          <span className="min-w-0">{error}</span>
        </div>
      )}

      <div className="space-y-1.5 px-1 text-[11px] leading-relaxed text-faint">
        <p>{t("Jev runs as a hosted service at TypeSafe (api.typesafe.ai). While a feature is on, the text it judges — your chat message, the plan description, task titles and files, or a permission request's command — is sent there. Undagi otherwise stays local.")}</p>
        <p>
          {t("Jev only advises: it never approves, blocks or changes anything. Your key is stored in this app's local database. Jev is in early access.")}{" "}
          {t("Get a key at")}{" "}
          <a href="https://docs.typesafe.ai" target="_blank" rel="noopener noreferrer" className="font-medium text-accent-ink underline">docs.typesafe.ai</a>.
        </p>
      </div>
    </section>
  );
};

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
      <div role="dialog" aria-modal="true" aria-labelledby="agent-settings-title" className="card flex max-h-[calc(100dvh-2rem)] w-full max-w-lg flex-col overflow-hidden shadow-lg" onMouseDown={(event) => event.stopPropagation()}>
        <div className="flex shrink-0 items-center justify-between border-b border-line px-5 py-4">
          <div className="flex items-center gap-2.5">
            <Settings2 className="h-4 w-4 text-accent-ink" aria-hidden />
            <h3 id="agent-settings-title" className="font-semibold text-ink">{t("Agent settings")}</h3>
          </div>
          <button ref={closeButton} type="button" onClick={onClose} aria-label={t("Close")} className="rounded-lg p-1.5 text-faint hover:bg-subtle hover:text-ink">
            <X className="h-4 w-4" aria-hidden />
          </button>
        </div>

        <div className="space-y-3 overflow-y-auto p-5">
          <p className="px-1 text-[11px] font-medium text-faint">{t("Efficiency stack")}</p>
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
          <JevSection />
        </div>
      </div>
    </div>
  );
};

export default AgentSettingsModal;
