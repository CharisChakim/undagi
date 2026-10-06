// Copyright (c) 2026 Charis Chakim - Undagi (https://github.com/CharisChakim/undagi)
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import React, { useEffect, useMemo, useState } from "react";
import { Check, CircleAlert, CircleHelp, Copy, ExternalLink, RefreshCw } from "lucide-react";
import type {
  RuntimeDetection,
  RuntimeEffortOption,
  RuntimeModel,
  RuntimePreference,
  RuntimePreferenceInput,
} from "../../types";
import { useT } from "../../lib/i18n";

const INHERIT = "inherit";

const RUNTIME_NAMES: Record<RuntimeDetection["runtime"], string> = {
  codex: "Codex",
  claude: "Claude Code",
  antigravity: "Antigravity",
};

const STATUS_LABELS: Record<RuntimeDetection["status"], string> = {
  ready: "Ready",
  needs_login: "Needs login",
  not_installed: "Not installed",
  unsupported_version: "Unsupported version",
  error: "Unavailable",
};

// Discovery reports machine codes. Rendering them raw leaves the user staring
// at NOT_INSTALLED with nothing to act on, so each one gets a sentence.
const DIAGNOSTIC_HINTS: Record<string, string> = {
  NOT_INSTALLED: "This runtime is not installed on this machine.",
  AUTH_REQUIRED: "The runtime is installed but not signed in. Authenticate it in its own CLI, then re-check.",
  MODEL_CATALOG_EMPTY: "The runtime answered, but listed no models. That is usually a sign-in that has lapsed.",
  PROCESS_ERROR: "The runtime binary was found but did not respond. Try running it once in a terminal.",
  SDK_METADATA_ERROR: "The runtime failed to report its models. Re-check after updating it.",
  CLAUDE_SDK_NOT_CONFIGURED: "Claude Code is installed but the agent SDK could not read it.",
  METADATA_TIMEOUT: "The runtime did not finish listing its models in time. A slow network or a runtime still starting up will do this.",
  METADATA_ERROR: "The runtime replied with something this app could not read.",
  COMMAND_FAILED: "The command that lists models exited with an error.",
  PROCESS_EXITED: "The runtime stopped before it answered.",
  PROTOCOL_ERROR: "The runtime replied in a format this app does not understand. It may be a newer version than this release supports.",
  PROTOCOL_LINE_TOO_LARGE: "The runtime sent a reply too large to read safely.",
  SIGKILL: "The runtime was killed before it answered.",
  SIGTERM: "The runtime was stopped before it answered.",
  VERSION_TIMEOUT: "The runtime did not report its version in time.",
  VERSION_PROCESS_ERROR: "The runtime binary was found but could not be started.",
  VERSION_UNREADABLE: "The binary answered, but not with a version this app recognises. It may be a different program with the same name.",
  PATH_NOT_EXECUTABLE: "The path set below does not point at something this machine can run.",
};

// Antigravity CLI ships as a vendor install script rather than an npm package,
// and the script differs per OS — handing a Windows user the curl line is the
// same dead end as showing no command at all.
const windows = /windows/i.test(navigator.userAgent);

// Shown when the binary is missing, so "not installed" comes with the one
// command that fixes it rather than a dead end. `note` covers the case where
// "not installed" contradicts what the user can see on their own machine.
// `checkCommand` adalah perintah yang dipakai discovery untuk memuat daftar
// model. Ketika discovery gagal karena alasan selain binary yang hilang, pesan
// asli runtime hanya terlihat dengan menjalankannya sendiri — itu yang membuat
// "Unavailable" bisa ditindaklanjuti, bukan sekadar diketahui.
const SETUP_GUIDE: Record<
  RuntimeDetection["runtime"],
  { command: string | null; checkCommand: string; docsUrl: string; note?: string }
> = {
  claude: {
    command: "npm install -g @anthropic-ai/claude-code",
    checkCommand: "claude --version",
    docsUrl: "https://docs.claude.com/en/docs/claude-code",
  },
  codex: {
    command: "npm install -g @openai/codex",
    checkCommand: "codex --version",
    docsUrl: "https://github.com/openai/codex",
  },
  antigravity: {
    command: windows
      ? "irm https://antigravity.google/cli/install.ps1 | iex"
      : "curl -fsSL https://antigravity.google/cli/install.sh | bash",
    checkCommand: "agy models",
    docsUrl: "https://antigravity.google/docs/cli/install/",
    note: "This looks for the agy CLI. The Antigravity desktop app does not include it, so having the app installed is not enough.",
  },
};

const PATH_ERRORS: Record<string, string> = {
  PATH_NOT_ABSOLUTE: "Enter a full path, starting from the root of the filesystem.",
  PATH_NOT_EXECUTABLE: "Nothing executable was found at that path.",
  RUNTIME_INVALID: "That runtime is not recognised.",
};

const STATUS_STYLES: Record<RuntimeDetection["status"], string> = {
  ready: "border-ok/30 bg-ok-soft text-ok-ink",
  needs_login: "border-warn/30 bg-warn-soft text-warn-ink",
  not_installed: "border-line bg-subtle text-muted",
  unsupported_version: "border-warn/30 bg-warn-soft text-warn-ink",
  error: "border-danger/30 bg-danger-soft text-danger-ink",
};

export interface RuntimeCardProps {
  detection: RuntimeDetection;
  preference?: RuntimePreference;
  onRefresh: () => Promise<void>;
  onSavePreference: (input: RuntimePreferenceInput) => Promise<RuntimePreference>;
  onSaveBinaryPath: (runtime: RuntimeDetection["runtime"], path: string | null) => Promise<unknown>;
  refreshing?: boolean;
}

// See RuntimeControls: an unreported default is shown as unknown, not as
// the first listed model.
function selectedModel(models: readonly RuntimeModel[], modelId: string): RuntimeModel | null {
  if (modelId !== INHERIT) return models.find((model) => model.modelId === modelId) ?? null;
  const defaultModel = models[0]?.defaultModel;
  return defaultModel ? models.find((model) => model.modelId === defaultModel) ?? null : null;
}

function effortLabel(option: RuntimeEffortOption): string {
  return option.label || option.value;
}

function checkedLabel(value: string, unknownLabel: string): string {
  if (!value) return unknownLabel;
  try {
    return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
  } catch {
    return value;
  }
}

export const RuntimeCard: React.FC<RuntimeCardProps> = ({ detection, preference, onRefresh, onSavePreference, onSaveBinaryPath, refreshing = false }) => {
  const { t } = useT();
  const [modelId, setModelId] = useState(INHERIT);
  const [effort, setEffort] = useState(INHERIT);
  const [saving, setSaving] = useState<"model" | "effort" | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [pathDraft, setPathDraft] = useState(detection.binaryPathOverride ?? "");
  const [pathSaving, setPathSaving] = useState(false);
  const [pathError, setPathError] = useState<string | null>(null);
  const setup = SETUP_GUIDE[detection.runtime];

  const submitPath = async (next: string | null) => {
    setPathSaving(true);
    setPathError(null);
    try {
      await onSaveBinaryPath(detection.runtime, next);
      setPathDraft(next ?? "");
    } catch (cause) {
      const code = cause instanceof Error ? cause.message : String(cause);
      setPathError(t(PATH_ERRORS[code] ?? code));
    } finally {
      setPathSaving(false);
    }
  };

  const copyCommand = async (command: string) => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      // Clipboard can be refused; the command stays selectable either way.
    }
  };
  // "Binary tidak ditemukan" dan "binary ada tapi gagal" butuh saran berbeda,
  // dan status not_installed saja tidak cukup: path override yang salah juga
  // membuat binary tidak terpakai.
  const missingBinary = detection.status === "not_installed" || !detection.binaryFound;
  // Dengan path override, menyuruh pengguna menjalankan nama di PATH akan
  // menguji binary yang berbeda dari yang dipakai discovery — dan justru
  // menyembunyikan bahwa override itu penyebabnya.
  const checkCommand = detection.binaryPathOverride
    ? `${detection.binaryPathOverride} ${setup.checkCommand.split(" ").slice(1).join(" ")}`.trim()
    : setup.checkCommand;
  const shownCommand = missingBinary ? (setup.command ?? checkCommand) : checkCommand;
  const models = detection.catalog?.models ?? [];
  const activeModel = useMemo(() => selectedModel(models, modelId), [models, modelId]);
  const effortOptions = activeModel?.effortOptions ?? [];
  const connectionId = detection.catalog?.connectionId ?? `runtime:${detection.runtime}`;
  const requestedModel = preference?.requestedModel ?? INHERIT;
  const requestedEffort = preference?.requestedEffort ?? INHERIT;
  const modelOverrideInvalid = requestedModel !== INHERIT && !models.some((model) => model.modelId === requestedModel);
  const effortOverrideInvalid = requestedEffort !== INHERIT
    && !effortOptions.some((option) => option.value === requestedEffort);

  useEffect(() => {
    const nextModel = requestedModel === INHERIT || models.some((model) => model.modelId === requestedModel)
      ? requestedModel
      : INHERIT;
    const nextModelDetails = selectedModel(models, nextModel);
    const nextEffort = requestedEffort === INHERIT
      || nextModelDetails?.effortOptions.some((option) => option.value === requestedEffort)
      ? requestedEffort
      : INHERIT;
    setModelId(nextModel);
    setEffort(nextEffort);
    setSaveError(null);
  }, [detection.runtime, detection.checkedAt, models, requestedModel, requestedEffort, preference?.updatedAt]);

  useEffect(() => {
    if (effort !== INHERIT && !effortOptions.some((option) => option.value === effort)) setEffort(INHERIT);
  }, [effort, effortOptions]);

  const persist = async (kind: "model" | "effort", nextValue: string) => {
    // Keep a stale server override intact while the UI asks the user to replace
    // it; changing effort must not silently clear an unavailable model choice.
    const nextModel = kind === "model" ? nextValue : (modelId !== INHERIT ? modelId : requestedModel);
    const nextModelDetails = selectedModel(models, nextModel);
    const nextEffort = kind === "effort"
      ? nextValue
      : requestedEffort === INHERIT || nextModelDetails?.effortOptions.some((option) => option.value === requestedEffort)
        ? requestedEffort
        : INHERIT;
    setSaving(kind);
    setSaveError(null);
    try {
      await onSavePreference({
        runtime: detection.runtime,
        connectionId,
        scope: "global",
        scopeKey: null,
        model: nextModel,
        effort: nextEffort,
      });
    } catch (cause) {
      setSaveError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(null);
    }
  };

  const handleModelChange = (nextModel: string) => {
    setModelId(nextModel);
    const nextModelDetails = selectedModel(models, nextModel);
    if (effort !== INHERIT && !nextModelDetails?.effortOptions.some((option) => option.value === effort)) {
      setEffort(INHERIT);
    }
    void persist("model", nextModel);
  };

  const handleEffortChange = (nextEffort: string) => {
    setEffort(nextEffort);
    void persist("effort", nextEffort);
  };

  return (
    <article className="card min-w-0 p-4" aria-labelledby={`runtime-${detection.runtime}-title`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h5 id={`runtime-${detection.runtime}-title`} className="text-sm font-semibold text-ink">
            {RUNTIME_NAMES[detection.runtime]}
          </h5>
          <div className={`mt-2 inline-flex items-center gap-1.5 rounded-full border px-2 py-1 text-[11px] font-medium ${STATUS_STYLES[detection.status]}`} role="status">
            {detection.status === "ready" ? <Check className="h-3 w-3" aria-hidden /> : <CircleAlert className="h-3 w-3" aria-hidden />}
            {t(STATUS_LABELS[detection.status])}
          </div>
        </div>
        <button
          type="button"
          onClick={() => void onRefresh().catch(() => undefined)}
          disabled={refreshing}
          className="btn-ghost shrink-0 px-2 py-1.5 text-xs"
          aria-label={t("Refresh {runtime} runtime", { runtime: RUNTIME_NAMES[detection.runtime] })}
        >
          <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? "animate-spin" : ""}`} aria-hidden />
          {t("Refresh")}
        </button>
      </div>

      <dl className="mt-4 grid grid-cols-2 gap-x-3 gap-y-2 text-xs">
        <div><dt className="text-faint">{t("Version")}</dt><dd className="mt-0.5 font-mono text-muted">{detection.version ?? "—"}</dd></div>
        <div><dt className="text-faint">{t("Binary")}</dt><dd className="mt-0.5 text-muted">{detection.binaryFound ? t("Found") : t("Not found")}</dd></div>
        <div><dt className="text-faint">{t("Auth")}</dt><dd className="mt-0.5 text-muted">{detection.authStatus === "unknown" ? t("Unknown") : detection.authStatus === "authenticated" ? t("Authenticated") : t("Unauthenticated")}</dd></div>
        <div><dt className="text-faint">{t("Checked")}</dt><dd className="mt-0.5 truncate text-muted" title={detection.checkedAt}>{checkedLabel(detection.checkedAt, t("Unknown"))}</dd></div>
      </dl>

      {detection.diagnostic && (
        <div className="mt-3 rounded-lg border border-line bg-subtle px-2.5 py-2 text-[11px] text-muted">
          <p className="flex items-start gap-1.5">
            <CircleHelp className="mt-0.5 h-3.5 w-3.5 shrink-0 text-faint" aria-hidden />
            <span>{t(DIAGNOSTIC_HINTS[detection.diagnostic] ?? detection.diagnostic)}</span>
          </p>

          {/* Binary yang hilang perlu perintah pasang; kegagalan lain berarti
              runtime-nya ada tapi tidak menjawab, dan yang menolong di situ
              adalah menjalankan perintahnya sendiri untuk melihat pesan asli. */}
          {detection.status !== "ready" && (
            <div className="mt-2 space-y-2 pl-5">
              {missingBinary && setup.note && <p className="text-muted">{t(setup.note)}</p>}
              <p className="text-muted">
                {missingBinary ? t("Install it with:") : t("Run this in a terminal to see what the runtime itself reports:")}
              </p>
              {/* Full width and wrapping at word boundaries: these cards sit in a
                  narrow three-column grid, and "npm install …" is not guidance. */}
              <code className="block break-words rounded-md border border-line bg-surface px-2 py-1 font-mono text-[11px] leading-relaxed text-ink">
                {shownCommand}
              </code>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <a
                  href={setup.docsUrl}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="inline-flex items-center gap-1 text-accent-ink hover:underline"
                >
                  {missingBinary ? t("Installation guide") : t("Runtime documentation")}
                  <ExternalLink className="h-3 w-3" aria-hidden />
                </a>
                <button
                  type="button"
                  onClick={() => copyCommand(shownCommand)}
                  className="inline-flex items-center gap-1 text-muted hover:text-ink"
                >
                  {copied
                    ? <><Check className="h-3 w-3 text-ok" aria-hidden />{t("Copied")}</>
                    : <><Copy className="h-3 w-3" aria-hidden />{t("Copy command")}</>}
                </button>
              </div>
              <p className="text-faint">
                {missingBinary
                  ? t("Once it is installed, re-check to pick it up.")
                  : t("Fix what that command reports, then re-check.")}
              </p>
            </div>
          )}
        </div>
      )}

      {/* Shown for every status, not just a missing binary: a runtime can be
          detected on PATH and still be the wrong copy to run. */}
      <div className="mt-3 border-t border-line pt-3">
        <label htmlFor={`runtime-${detection.runtime}-path`} className="block text-[11px] font-medium text-muted">
          {t("Executable path")}
        </label>
        <p className="mt-0.5 text-[11px] leading-relaxed text-faint">
          {detection.binaryPathOverride
            ? t("Discovery uses this path instead of searching PATH.")
            : t("Leave empty to search PATH. Set a path when the CLI lives somewhere else.")}
        </p>
        <input
          id={`runtime-${detection.runtime}-path`}
          className="field mt-1.5 font-mono text-[11px]"
          value={pathDraft}
          onChange={(event) => setPathDraft(event.target.value)}
          disabled={pathSaving}
          placeholder="/usr/local/bin/agy"
          spellCheck={false}
        />
        <div className="mt-1.5 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => void submitPath(pathDraft.trim() || null)}
            disabled={pathSaving || pathDraft.trim() === (detection.binaryPathOverride ?? "")}
            className="btn-outline px-2 py-1 text-[11px]"
          >
            {pathSaving ? t("Saving...") : t("Use this path")}
          </button>
          {detection.binaryPathOverride && (
            <button
              type="button"
              onClick={() => void submitPath(null)}
              disabled={pathSaving}
              className="btn-ghost px-2 py-1 text-[11px]"
            >
              {t("Clear")}
            </button>
          )}
        </div>
        {pathError && (
          <p className="mt-1.5 rounded-lg border border-danger/30 bg-danger-soft px-2 py-1.5 text-[11px] text-danger-ink" role="alert">
            {pathError}
          </p>
        )}
      </div>

      <div className="mt-4 border-t border-line pt-4">
        <div className="flex items-center justify-between gap-2">
          <h6 className="text-xs font-semibold text-ink">{t("Detected models")}</h6>
          <span className="text-[11px] text-faint">{models.length}</span>
        </div>
        {models.length > 0 ? (
          <ul className="mt-2 flex flex-wrap gap-1.5" aria-label={t("{runtime} detected models", { runtime: RUNTIME_NAMES[detection.runtime] })}>
            {models.map((model) => <li key={model.modelId} className="max-w-full truncate rounded-md bg-subtle px-2 py-1 font-mono text-[11px] text-muted" title={model.label}>{model.label}</li>)}
          </ul>
        ) : (
          <p className="mt-2 text-xs text-faint">{t("No model catalog available.")}</p>
        )}
      </div>

      <div className="mt-4 space-y-3">
        <div>
          <label htmlFor={`runtime-${detection.runtime}-model`} className="field-label">{t("Model")}</label>
          <select id={`runtime-${detection.runtime}-model`} className="field text-xs" value={modelId} onChange={(event) => handleModelChange(event.target.value)} disabled={!models.length || saving !== null}>
            <option value={INHERIT}>{t("Use runtime default")}</option>
            {models.map((model) => <option key={model.modelId} value={model.modelId}>{model.label} · {model.modelId}</option>)}
          </select>
          <p className="field-hint">{activeModel ? t("Effective model: {model}", { model: activeModel.label }) : t("Uses runtime connection default.")}</p>
        </div>

        {effortOptions.length > 0 && (
          <div>
            <label htmlFor={`runtime-${detection.runtime}-effort`} className="field-label">{t("Effort")}</label>
            <select id={`runtime-${detection.runtime}-effort`} className="field text-xs" value={effort} onChange={(event) => handleEffortChange(event.target.value)} disabled={saving !== null}>
              <option value={INHERIT}>{t("Use runtime default")}</option>
              {effortOptions.map((option) => <option key={option.value} value={option.value}>{effortLabel(option)}</option>)}
            </select>
            <p className="field-hint">{effort === INHERIT && activeModel?.defaultEffort ? t("Effective effort: {effort}", { effort: activeModel.defaultEffort }) : t("Runtime reported effort options.")}</p>
          </div>
        )}
      </div>

      {saving && <p className="mt-3 text-xs text-muted" role="status" aria-live="polite">{t("Saving {preference} preference...", { preference: saving })}</p>}
      {(saveError || modelOverrideInvalid || effortOverrideInvalid) && (
        <p className="mt-3 break-words rounded-lg border border-warn/30 bg-warn-soft px-2.5 py-2 text-xs text-warn-ink" role="alert">
          {saveError ?? (modelOverrideInvalid
            ? t("Saved model override \u201c{model}\u201d is unavailable in the current catalog. Choose a model to replace it.", { model: requestedModel })
            : t("Saved effort override \u201c{effort}\u201d is unavailable for the current model. Choose an effort to replace it.", { effort: requestedEffort }))}
        </p>
      )}

      {detection.catalog?.stale && (
        <p className="mt-4 rounded-lg border border-warn/30 bg-warn-soft px-2.5 py-2 text-xs text-warn-ink" role="status">
          {t("Could not refresh the model list. Showing the one read {date}.", { date: checkedLabel(detection.catalog.discoveredAt, t("Unknown")) })}
        </p>
      )}
      {detection.catalog && (
        <p className="mt-4 text-[10px] leading-relaxed text-faint">
          {t("Source: {source} · refreshed {date}", { source: detection.catalog.source, date: checkedLabel(detection.catalog.discoveredAt, t("Unknown")) })}
        </p>
      )}
    </article>
  );
};

export default RuntimeCard;
