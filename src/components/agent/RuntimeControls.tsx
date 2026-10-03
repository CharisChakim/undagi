import React, { useEffect, useMemo } from "react";
import { LoaderCircle } from "lucide-react";
import type { AgentRole, RuntimeDetection, RuntimePreference, RuntimeModel, RuntimeDiscoveryReport } from "../../types";
import type { RuntimeChatSelection } from "../../lib/runtimeChat";
import { useConnections } from "../../lib/connections";
import { useT } from "../../lib/i18n";

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

export interface RuntimeControlsProps {
  sessionId: string;
  selection: RuntimeChatSelection;
  report: RuntimeDiscoveryReport | null;
  preferences: RuntimePreference[];
  loading?: boolean;
  /** Show that discovery is running instead of a pick that is about to change. */
  detecting?: boolean;
  onChange: (selection: RuntimeChatSelection) => void;
  onOpenConnections?: () => void;
  disabled?: boolean;
  compact?: boolean;
  /** Keeps element ids apart when the chat and the pipeline both show one. */
  idPrefix?: string;
  /** The roles a Legacy API pick is bound to; the first one's binding is shown. */
  legacyRoles?: AgentRole[];
}

function preferredValue(
  detection: RuntimeDetection,
  preferences: RuntimePreference[],
  key: "requestedModel" | "requestedEffort",
): string {
  const connectionId = detection.catalog?.connectionId ?? `runtime:${detection.runtime}`;
  return preferences.find((item) => item.runtime === detection.runtime && item.connectionId === connectionId)?.[key] ?? "inherit";
}

// "inherit" is whatever the runtime itself defaults to. When the runtime did
// not report that default, no listed model may stand in for it: the first
// model's name and effort options would claim something the run won't use.
function selectedModel(models: RuntimeModel[], model: string): RuntimeModel | null {
  if (model !== "inherit") return models.find((item) => item.modelId === model) ?? null;
  const defaultModel = models[0]?.defaultModel;
  return defaultModel ? models.find((item) => item.modelId === defaultModel) ?? null : null;
}

function effortLabel(value: string): string {
  const known: Record<string, string> = {
    none: "None",
    minimal: "Minimal",
    low: "Low",
    medium: "Medium",
    high: "High",
    xhigh: "XHigh",
    max: "Max",
    ultra: "Ultra",
  };
  return known[value.toLowerCase()] ?? (value.charAt(0).toUpperCase() + value.slice(1));
}

function defaultEffortLabel(defaultEffort: string | null | undefined, fallback: string, defaultLabel: string): string {
  return defaultEffort ? `${defaultLabel} · ${effortLabel(defaultEffort)}` : fallback;
}

export const RuntimeControls: React.FC<RuntimeControlsProps> = ({
  selection,
  report,
  preferences,
  loading = false,
  detecting = false,
  onChange,
  onOpenConnections,
  disabled = false,
  compact = false,
  idPrefix = "agent",
  legacyRoles = ["agent"],
}) => {
  const { t } = useT();
  const { connections, roles, bindRole } = useConnections();
  const detection = selection.runtime === "legacy"
    ? undefined
    : report?.runtimes.find((item) => item.runtime === selection.runtime);
  const models = detection?.catalog?.models ?? [];
  const activeModel = useMemo(() => selectedModel(models, selection.runtime === "legacy" ? "inherit" : selection.model), [models, selection]);
  const effortOptions = activeModel?.effortOptions ?? [];
  const selectedRuntimeUnavailable = selection.runtime !== "legacy" && (
    report
      ? !detection || detection.status !== "ready"
        || Boolean(detection.catalog?.connectionId && detection.catalog.connectionId !== selection.connectionId)
      : !loading
  );
  const selectedRuntimeStatus = !report && loading
    ? t("Checking...")
    : detection && !selectedRuntimeUnavailable
      ? t("Ready")
      : t("Unavailable");
  const selectedRuntimeChecking = selection.runtime !== "legacy" && !report && loading;
  const selectedRuntimeDisplayStatus = detection && selectedRuntimeUnavailable
    ? detection.status === "ready" ? t("Connection unavailable") : t(STATUS_LABELS[detection.status])
    : selectedRuntimeStatus;

  useEffect(() => {
    if (selection.runtime === "legacy" || selectedRuntimeUnavailable || !models.length) return;
    const nextModel = selection.model === "inherit" || models.some((model) => model.modelId === selection.model)
      ? selection.model
      : "inherit";
    const nextDetails = selectedModel(models, nextModel);
    const nextEffort = selection.effort === "inherit"
      || nextDetails?.effortOptions.some((option) => option.value === selection.effort)
      ? selection.effort
      : "inherit";
    if (nextModel !== selection.model || nextEffort !== selection.effort) {
      onChange({ ...selection, model: nextModel, effort: nextEffort });
    }
  }, [models, onChange, selectedRuntimeUnavailable, selection]);

  const changeRuntime = (value: string) => {
    if (value === "legacy") {
      onChange({ runtime: "legacy", model: "inherit", effort: "inherit" });
      return;
    }
    const next = report?.runtimes.find((item) => item.runtime === value);
    if (!next || next.status !== "ready") return;
    const connectionId = next.catalog?.connectionId ?? `runtime:${next.runtime}`;
    const nextModels = next.catalog?.models ?? [];
    const requestedModel = preferredValue(next, preferences, "requestedModel");
    const model = requestedModel === "inherit" || nextModels.some((item) => item.modelId === requestedModel)
      ? requestedModel
      : "inherit";
    const active = selectedModel(nextModels, model);
    const requestedEffort = preferredValue(next, preferences, "requestedEffort");
    const effort = requestedEffort === "inherit" || active?.effortOptions.some((item) => item.value === requestedEffort)
      ? requestedEffort
      : "inherit";
    onChange({
      runtime: next.runtime,
      connectionId,
      model,
      effort,
    });
  };

  const changeModel = (model: string) => {
    if (selection.runtime === "legacy") return;
    const nextModel = selectedModel(models, model);
    const effort = selection.effort === "inherit" || nextModel?.effortOptions.some((item) => item.value === selection.effort)
      ? selection.effort
      : "inherit";
    onChange({ ...selection, model, effort });
  };

  // Legacy API memilih koneksi dan modelnya di sini. Pilihannya disimpan sebagai
  // binding role `agent` — sumber yang sama yang sudah dibaca server, jadi
  // memindahkan kendalinya ke composer tidak mengubah jalur request.
  //
  // Satu select membawa koneksi dan model sekaligus karena di bar yang sempit dua
  // dropdown untuk satu pilihan hanya menambah langkah. Nilainya indeks, sebab id
  // koneksi dan nama model bisa memuat karakter apa pun.
  const legacyChoices = useMemo(() => connections
    .filter((connection) => connection.enabled)
    .flatMap((connection) => connection.models.map((model) => ({
      connectionId: connection.id,
      model,
      label: `${connection.name} · ${model}`,
    }))), [connections]);
  const legacyBinding = roles[legacyRoles[0]];
  const legacyValue = String(legacyChoices.findIndex((choice) => (
    choice.connectionId === legacyBinding?.connectionId && choice.model === legacyBinding?.model
  )));

  const changeLegacyModel = (value: string) => {
    const choice = legacyChoices[Number(value)];
    if (!choice) return;
    for (const role of legacyRoles) void bindRole(role, choice.connectionId, choice.model).catch(() => undefined);
  };

  const legacyModelSelect = (
    <>
      <label htmlFor={`${idPrefix}-legacy-model`} className="sr-only">{t("Model")}</label>
      <select
        id={`${idPrefix}-legacy-model`}
        className="h-8 max-w-44 rounded-lg border-0 bg-transparent px-2 text-[11px] text-ink outline-hidden hover:bg-subtle focus:bg-subtle"
        value={legacyValue}
        onChange={(event) => changeLegacyModel(event.target.value)}
        disabled={disabled || !legacyChoices.length}
        title={t("Model")}
      >
        <option value="-1">
          {legacyChoices.length ? t("Choose a model") : t("No endpoint with a model yet")}
        </option>
        {legacyChoices.map((choice, index) => <option key={choice.label} value={index}>{choice.label}</option>)}
      </select>
    </>
  );

  const runtimeOptions = (
    <>
      <option value="legacy">{t("Legacy API")}</option>
      {selection.runtime !== "legacy" && !report?.runtimes.some((item) => item.runtime === selection.runtime) && (
        <option value={selection.runtime} disabled>
          {RUNTIME_NAMES[selection.runtime]} · {selectedRuntimeStatus}
        </option>
      )}
      {report?.runtimes.map((item) => (
        <option key={item.runtime} value={item.runtime} disabled={item.status !== "ready"}>
          {RUNTIME_NAMES[item.runtime]} · {item.catalog?.stale ? t("Cached") : t(STATUS_LABELS[item.status])}
        </option>
      ))}
    </>
  );

  if (compact && detecting) {
    return (
      <span className="inline-flex h-8 items-center gap-1.5 px-2 text-[11px] text-muted" role="status" aria-live="polite">
        <LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden />
        {t("Detecting...")}
      </span>
    );
  }

  if (compact) {
    return (
      <div className="flex min-w-0 max-w-full flex-wrap items-center gap-1" aria-label={t("Agent runtime controls")}>
        <label htmlFor={`${idPrefix}-runtime`} className="sr-only">{t("Runtime")}</label>
        <select
          id={`${idPrefix}-runtime`}
          className="h-8 max-w-36 rounded-lg border-0 bg-transparent px-2 text-[11px] font-medium text-ink outline-hidden hover:bg-subtle focus:bg-subtle"
          value={selection.runtime}
          onChange={(event) => changeRuntime(event.target.value)}
          disabled={disabled}
          title={t("Runtime")}
        >
          {runtimeOptions}
        </select>
        {selection.runtime === "legacy" && legacyModelSelect}
        {selection.runtime !== "legacy" && (
          <>
            <label htmlFor={`${idPrefix}-runtime-model`} className="sr-only">{t("Model")}</label>
            <select
              id={`${idPrefix}-runtime-model`}
              className="h-8 max-w-40 rounded-lg border-0 bg-transparent px-2 text-[11px] text-ink outline-hidden hover:bg-subtle focus:bg-subtle"
              value={selection.model}
              onChange={(event) => changeModel(event.target.value)}
              disabled={disabled || selectedRuntimeUnavailable || !models.length}
              title={t("Model")}
            >
              <option value="inherit">{activeModel?.label || t("Use runtime default")}</option>
              {models.map((model) => <option key={model.modelId} value={model.modelId}>{model.label}</option>)}
            </select>
            {effortOptions.length > 0 && (
              <>
                <label htmlFor={`${idPrefix}-runtime-effort`} className="sr-only">{t("Effort")}</label>
                {/* Select ini tidak punya label yang terlihat, jadi tiap opsinya
                    menyebut "Effort" sendiri; kalau tidak, pilihan bawaan hanya
                    terbaca "Bawaan". Yang terpanjang ("Effort · Medium
                    (default)") butuh ~150px. */}
                <select
                  id={`${idPrefix}-runtime-effort`}
                  className="h-8 max-w-44 rounded-lg border-0 bg-transparent px-2 text-[11px] text-ink outline-hidden hover:bg-subtle focus:bg-subtle"
                  value={selection.effort}
                  onChange={(event) => onChange({ ...selection, effort: event.target.value })}
                  disabled={disabled || selectedRuntimeUnavailable}
                  title={t("Effort")}
                >
                  <option value="inherit">
                    {activeModel?.defaultEffort
                      ? t("Effort · {level} (default)", { level: effortLabel(activeModel.defaultEffort) })
                      : t("Effort · runtime default")}
                  </option>
                  {effortOptions.map((option) => (
                    <option key={option.value} value={option.value}>{t("Effort · {level}", { level: effortLabel(option.label) })}</option>
                  ))}
                </select>
              </>
            )}
          </>
        )}
        {selectedRuntimeUnavailable && onOpenConnections && (
          <button type="button" className="rounded-lg px-2 py-1.5 text-[11px] text-accent-ink hover:bg-subtle" onClick={onOpenConnections}>
            {t("Connections")}
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="min-w-0 flex-1" aria-label={t("Agent runtime controls")}>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <label htmlFor={`${idPrefix}-runtime`} className="text-[11px] font-medium text-muted">{t("Runtime")}</label>
        <select
          id={`${idPrefix}-runtime`}
          className="field min-w-36 flex-1 py-1 text-[11px] sm:max-w-56 sm:flex-none"
          value={selection.runtime}
          onChange={(event) => changeRuntime(event.target.value)}
          disabled={disabled}
        >
          {runtimeOptions}
        </select>
        {loading && <span className="text-[11px] text-faint" role="status" aria-live="polite">{t("Detecting...")}</span>}
        {selection.runtime !== "legacy" && (
          <span className={`rounded-full border px-2 py-0.5 text-[10px] ${selectedRuntimeChecking ? "border-line bg-subtle text-muted" : selectedRuntimeUnavailable ? "border-warn/30 bg-warn-soft text-warn-ink" : "border-ok/30 bg-ok-soft text-ok-ink"}`} role="status" aria-live="polite">
            {selectedRuntimeDisplayStatus}
          </span>
        )}
        {selectedRuntimeUnavailable && (
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[11px]">
            {onOpenConnections && <button type="button" className="text-accent-ink hover:underline" onClick={onOpenConnections}>{t("Manage connections")}</button>}
            <button type="button" className="text-accent-ink hover:underline" onClick={() => onChange({ runtime: "legacy", model: "inherit", effort: "inherit" })} disabled={disabled}>
              {t("Use Legacy API")}
            </button>
          </div>
        )}
      </div>

      {selection.runtime === "legacy" && (
        <div className="mt-2 flex min-w-0 flex-wrap items-center gap-2">
          <label htmlFor={`${idPrefix}-legacy-model`} className="text-[11px] font-medium text-muted">{t("Model")}</label>
          <select
            id={`${idPrefix}-legacy-model`}
            className="field min-w-44 flex-1 py-1 text-[11px] sm:max-w-72 sm:flex-none"
            value={legacyValue}
            onChange={(event) => changeLegacyModel(event.target.value)}
            disabled={disabled || !legacyChoices.length}
          >
            <option value="-1">
              {legacyChoices.length ? t("Choose a model") : t("No endpoint with a model yet")}
            </option>
            {legacyChoices.map((choice, index) => <option key={choice.label} value={index}>{choice.label}</option>)}
          </select>
          {!legacyChoices.length && onOpenConnections && (
            <button type="button" className="text-[11px] text-accent-ink hover:underline" onClick={onOpenConnections}>
              {t("Add an endpoint")}
            </button>
          )}
        </div>
      )}

      {selection.runtime !== "legacy" && (
        <div className="mt-2 flex min-w-0 flex-wrap items-center gap-2">
          <label htmlFor={`${idPrefix}-runtime-model`} className="text-[11px] font-medium text-muted">{t("Model")}</label>
          <select
            id={`${idPrefix}-runtime-model`}
            className="field min-w-36 flex-1 py-1 text-[11px] sm:max-w-56 sm:flex-none"
            value={selection.model}
            onChange={(event) => changeModel(event.target.value)}
            disabled={disabled || selectedRuntimeUnavailable || !models.length}
          >
            <option value="inherit">{t("Use runtime default")}</option>
            {models.map((model) => <option key={model.modelId} value={model.modelId}>{model.label}</option>)}
          </select>
          {effortOptions.length > 0 && (
            <>
              <label htmlFor={`${idPrefix}-runtime-effort`} className="text-[11px] font-medium text-muted">{t("Effort")}</label>
              <select
                id={`${idPrefix}-runtime-effort`}
                className="field min-w-28 flex-1 py-1 text-[11px] sm:max-w-40 sm:flex-none"
                value={selection.effort}
                onChange={(event) => onChange({ ...selection, effort: event.target.value })}
                disabled={disabled || selectedRuntimeUnavailable}
              >
                <option value="inherit">{defaultEffortLabel(activeModel?.defaultEffort, t("Use runtime default"), t("Default"))}</option>
                {effortOptions.map((option) => <option key={option.value} value={option.value}>{effortLabel(option.label)}</option>)}
              </select>
            </>
          )}
          {!models.length && <span className="text-[11px] text-faint">{t("No model catalog available")}</span>}
        </div>
      )}
    </div>
  );
};

export default RuntimeControls;
