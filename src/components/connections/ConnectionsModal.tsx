// Copyright (c) 2026 Charis Chakim - Undagi (https://github.com/CharisChakim/undagi)
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import React, { useEffect, useRef, useState } from "react";
import { AlertCircle, Cpu, Plus, RefreshCw, Save, Trash2, X } from "lucide-react";
import type { RuntimeId, RuntimeStatus, WireFormat } from "../../types";
import { useConnections } from "../../lib/connections";
import type { ConnectionDraft, ConnectionTestResult } from "../../lib/connections";
import { useT } from "../../lib/i18n";
import { getProviderPreset, PROVIDER_PRESETS as CONNECTION_PRESETS, createProviderDraft } from "../../lib/providerPresets";
import type { ProviderPreset } from "../../lib/providerPresets";
import { useRuntimeDiscovery } from "../../lib/runtimes";
import { McpPanel } from "./McpPanel";
import { RuntimeCard } from "./RuntimeCard";

export interface ConnectionsModalProps {
  isOpen: boolean;
  onClose: () => void;
  initialTab?: ConnectionsModalEntry;
}

type Tab = "connections" | "mcp";

/**
 * Runtimes are no longer a tab of their own, but they are still an entry point:
 * opening from Agents should land on a runtime rather than an endpoint form.
 */
export type ConnectionsModalEntry = Tab | "runtimes";

const RUNTIME_LABELS: Record<RuntimeId, string> = {
  codex: "Codex",
  claude: "Claude Code",
  antigravity: "Antigravity",
};

const RUNTIME_STATUS_DOTS: Record<RuntimeStatus, string> = {
  ready: "bg-ok",
  needs_login: "bg-warn",
  unsupported_version: "bg-warn",
  error: "bg-danger",
  not_installed: "bg-faint",
};
const CUSTOM_CONNECTION_PRESET = getProviderPreset("custom");

const inputClass = "field";
const labelClass = "field-label";

function testSummary(result: ConnectionTestResult, t: (key: string) => string): string {
  return result.probes.map((probe) => `${probe.name} ${probe.ok ? "✓" : "✗"} ${probe.ms}ms${probe.detail ? ` · ${probe.detail}` : ""}`).join("\n") || t("No probe result");
}

export const ConnectionsModal: React.FC<ConnectionsModalProps> = ({ isOpen, onClose, initialTab = "connections" }) => {
  const { t } = useT();
  const { connections, loading, error, createConnection, updateConnection, deleteConnection, testConnection, refresh } = useConnections();
  const runtimeDiscovery = useRuntimeDiscovery(isOpen);
  const [tab, setTab] = useState<Tab>("connections");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Null berarti panel kanan menampilkan form endpoint; berisi runtime berarti
  // ia menampilkan kartu runtime. Satu daftar di kiri memilih keduanya.
  const [selectedRuntime, setSelectedRuntime] = useState<RuntimeId | null>(null);
  const [showPresets, setShowPresets] = useState(false);
  const [name, setName] = useState("");
  const [format, setFormat] = useState<WireFormat>("openai");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKeyEnv, setApiKeyEnv] = useState("");
  const [models, setModels] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [jsonMode, setJsonMode] = useState(true);
  const [testResult, setTestResult] = useState<ConnectionTestResult | null>(null);
  const [testError, setTestError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const apiKeyRef = useRef<HTMLInputElement>(null);
  const modalRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const active = selectedId ? connections.find((connection) => connection.id === selectedId) || null : null;

  const runtimes = runtimeDiscovery.report?.runtimes ?? [];
  const selectedRuntimeDetection = selectedRuntime
    ? runtimes.find((detection) => detection.runtime === selectedRuntime) ?? null
    : null;

  useEffect(() => {
    if (!isOpen) return;
    setTab(initialTab === "runtimes" ? "connections" : initialTab);
    setShowPresets(false);
    setSelectedId((current) => current && connections.some((connection) => connection.id === current) ? current : connections[0]?.id || null);
  }, [isOpen, connections, initialTab]);

  // Entri runtime hanya bisa dipilih setelah deteksi selesai, jadi pilihan awal
  // untuk pintu masuk Agents menunggu laporannya dan mendarat di runtime yang
  // benar-benar siap kalau ada.
  useEffect(() => {
    if (!isOpen || initialTab !== "runtimes") return;
    setSelectedRuntime((current) => current ?? (
      runtimes.find((detection) => detection.status === "ready")?.runtime ?? runtimes[0]?.runtime ?? null
    ));
  }, [isOpen, initialTab, runtimes]);

  useEffect(() => {
    if (isOpen) return;
    setSelectedRuntime(null);
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    if (!active) {
      if (connections.length === 0) {
        setName("");
        setFormat("openai");
        setBaseUrl("");
        setApiKeyEnv("");
        setModels("");
        setEnabled(true);
        setJsonMode(true);
      }
      return;
    }
    setName(active?.name || "");
    setFormat(active?.format || "openai");
    setBaseUrl(active?.baseUrl || "");
    setApiKeyEnv(active?.apiKeyEnv || "");
    setModels(active?.models.join(", ") || "");
    setEnabled(active?.enabled ?? true);
    setJsonMode(active?.jsonMode ?? true);
    setTestResult(null);
    setTestError(null);
  }, [active?.id, connections.length, isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const frame = window.requestAnimationFrame(() => closeButtonRef.current?.focus());
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab" || !modalRef.current) return;
      const focusable = Array.from(modalRef.current.querySelectorAll<HTMLElement>(
        "button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex=\"-1\"])",
      ));
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener("keydown", onKeyDown);
      previousFocusRef.current?.focus();
      previousFocusRef.current = null;
    };
  }, [isOpen]);

  if (!isOpen) return null;

  const choosePreset = async (preset: ProviderPreset) => {
    const draft = createProviderDraft(preset);
    setSelectedId(null);
    setSelectedRuntime(null);
    setName(draft.name);
    setFormat(draft.format || "openai");
    setBaseUrl(draft.baseUrl);
    setApiKeyEnv(draft.apiKeyEnv || "");
    setModels(preset.defaultModel || draft.models?.join(", ") || "");
    setEnabled(true);
    setJsonMode(true);
    setTestResult(null);
    setTestError(null);
    setShowPresets(false);

    if (!draft.baseUrl) return;
    setTesting(true);
    try {
      const result = await testConnection({
        ...draft,
        format: draft.format || "openai",
        model: preset.defaultModel || draft.models[0] || "default",
      });
      setTestResult(result);
      if (result.models.length) setModels(result.models.join(", "));
    } catch (cause) {
      setTestError(cause instanceof Error ? cause.message : t("Could not reach the LLM."));
    } finally {
      setTesting(false);
    }
  };

  const formPatch = (): ConnectionDraft => ({
    name: name.trim(),
    format,
    baseUrl: baseUrl.trim(),
    // Null explicitly clears a previously saved environment-variable name.
    apiKeyEnv: apiKeyEnv.trim() || null,
    models: models.split(",").map((model) => model.trim()).filter(Boolean),
    jsonMode,
    enabled,
  });

  const handleSave = async () => {
    setSaving(true);
    setTestError(null);
    try {
      const patch = formPatch();
      const newKey = apiKeyRef.current?.value.trim() || "";
      const saved = selectedId
        ? await updateConnection(selectedId, newKey ? { ...patch, apiKey: newKey } : patch)
        : await createConnection(newKey ? { ...patch, apiKey: newKey } : patch);
      setSelectedId(saved.id);
    } catch (cause) {
      setTestError(cause instanceof Error ? cause.message : t("Failed to save connection."));
    } finally {
      setSaving(false);
    }
  };

  const handleClearKey = async () => {
    if (!selectedId || !active) return;
    setSaving(true);
    try {
      await updateConnection(selectedId, { ...formPatch(), apiKey: "" });
      if (apiKeyRef.current) apiKeyRef.current.value = "";
    } catch (cause) {
      setTestError(cause instanceof Error ? cause.message : t("Failed to remove API key."));
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async () => {
    setTesting(true);
    setTestResult(null);
    setTestError(null);
    try {
      const draft = formPatch();
      const result = await testConnection({
        ...draft,
        model: models.split(",").map((model) => model.trim()).filter(Boolean)[0] || "default",
        ...(apiKeyRef.current?.value.trim() ? { apiKey: apiKeyRef.current.value.trim() } : {}),
      });
      setTestResult(result);
      if (result.models.length) setModels(result.models.join(", "));
    } catch (cause) {
      setTestError(cause instanceof Error ? cause.message : t("Could not reach the LLM."));
    } finally {
      setTesting(false);
    }
  };

  const handleDelete = async () => {
    if (!selectedId) return;
    setDeleting(true);
    try {
      await deleteConnection(selectedId);
      setSelectedId(null);
    } catch (cause) {
      setTestError(cause instanceof Error ? cause.message : t("Failed to delete connection."));
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-black/50 p-4 backdrop-blur-xs">
      <div ref={modalRef} role="dialog" aria-modal="true" aria-labelledby="connections-modal-title" className="card flex min-w-0 max-h-[min(760px,calc(100vh-2rem))] w-full max-w-4xl flex-col overflow-hidden shadow-elev-3">
        <div className="flex items-center justify-between border-b border-line px-5 py-4">
          <div className="flex min-w-0 items-center gap-2.5"><Cpu className="h-4 w-4 shrink-0 text-accent-ink" /><h3 id="connections-modal-title" className="truncate font-semibold text-ink">{t("Connections")}</h3></div>
          <button ref={closeButtonRef} type="button" onClick={onClose} aria-label={t("Close")} className="shrink-0 rounded-lg p-1.5 text-faint hover:bg-subtle hover:text-ink"><X className="h-4 w-4" aria-hidden /></button>
        </div>

        <div className="flex min-h-0 min-w-0 flex-1 flex-col sm:flex-row">
          <nav role="tablist" aria-label={t("Connection settings")} className="flex shrink-0 gap-1 overflow-x-auto border-b border-line bg-subtle/50 p-2 sm:w-44 sm:flex-col sm:border-b-0 sm:border-r">
            {(["connections", "mcp"] as Tab[]).map((item, index, all) => (
              <button
                key={item}
                type="button"
                role="tab"
                aria-selected={tab === item}
                aria-controls={`${item}-tabpanel`}
                id={`tab-${item}`}
                tabIndex={tab === item ? 0 : -1}
                onKeyDown={(event) => {
                  if (event.key !== "ArrowRight" && event.key !== "ArrowDown" && event.key !== "ArrowLeft" && event.key !== "ArrowUp") return;
                  event.preventDefault();
                  const delta = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : -1;
                  const next = all[(index + delta + all.length) % all.length];
                  setTab(next);
                  (event.currentTarget.parentElement?.querySelector(`[data-tab=\"${next}\"]`) as HTMLButtonElement | null)?.focus();
                }}
                data-tab={item}
                onClick={() => setTab(item)}
                className={`shrink-0 whitespace-nowrap rounded-lg px-3 py-2 text-left text-xs font-medium ${tab === item ? "bg-surface text-accent-ink shadow-elev-1" : "text-muted hover:text-ink"}`}
              >
                {item === "connections" ? t("Connections") : t("MCP")}
              </button>
            ))}
          </nav>

          {tab === "connections" && (
            <div id="connections-tabpanel" role="tabpanel" aria-labelledby="tab-connections" className="flex min-h-0 min-w-0 flex-1 flex-col sm:flex-row">
              <div className="flex max-h-64 shrink-0 flex-col gap-4 overflow-y-auto border-b border-line p-3 sm:max-h-none sm:w-56 sm:border-b-0 sm:border-r">
                {/* Runtime lokal dan endpoint HTTP hidup di satu daftar karena
                    keduanya sama-sama sumber model; yang membedakan cuma apa
                    yang harus disiapkan, dan itu dijelaskan per entri. */}
                <div>
                  <span className="text-xs font-semibold text-ink">{t("Agent runtimes")}</span>
                  <div className="mt-2 space-y-1">
                    {runtimes.map((detection) => (
                      <button
                        key={detection.runtime}
                        type="button"
                        aria-pressed={selectedRuntime === detection.runtime}
                        onClick={() => { setSelectedRuntime(detection.runtime); setShowPresets(false); }}
                        className={`flex w-full min-w-0 items-center gap-2 rounded-lg px-2.5 py-2 text-left ${selectedRuntime === detection.runtime ? "bg-accent-soft text-accent-ink" : "text-muted hover:bg-subtle hover:text-ink"}`}
                      >
                        <span className={`h-2 w-2 shrink-0 rounded-full ${RUNTIME_STATUS_DOTS[detection.status]}`} aria-hidden />
                        <span className="min-w-0 flex-1 truncate text-xs font-medium">{RUNTIME_LABELS[detection.runtime]}</span>
                        <span className="shrink-0 text-[10px] text-faint">{t("CLI")}</span>
                      </button>
                    ))}
                    {!runtimes.length && (
                      <p className="px-2 py-2 text-[11px] leading-relaxed text-faint">
                        {runtimeDiscovery.loading ? t("Detecting...") : t("No runtime detection result.")}
                      </p>
                    )}
                  </div>
                </div>

                <div className="min-h-0">
                <div className="mb-2 flex items-center justify-between"><span className="text-xs font-semibold text-ink">{t("Custom endpoints")}</span><button type="button" onClick={() => { setShowPresets((value) => !value); setSelectedRuntime(null); }} aria-expanded={showPresets} aria-controls="connection-preset-list" title={t("Add connection")} aria-label={t("Add connection")} className="rounded-md p-1 text-accent-ink hover:bg-accent-soft"><Plus className="h-4 w-4" aria-hidden /></button></div>
                {showPresets ? (
                  <div id="connection-preset-list" className="min-h-0 space-y-1 overflow-y-auto">
                    {CUSTOM_CONNECTION_PRESET && <button type="button" onClick={() => void choosePreset(CUSTOM_CONNECTION_PRESET)} className="lift mb-1 flex w-full items-center gap-2 rounded-lg border border-dashed border-line px-2.5 py-2 text-left text-xs text-muted hover:border-accent hover:text-ink"><Plus className="h-3.5 w-3.5" />{t("Custom connection")}</button>}
                    {CONNECTION_PRESETS.filter((preset) => preset.id !== "custom").map((preset) => <button key={preset.id} type="button" onClick={() => void choosePreset(preset)} className="lift block w-full rounded-lg border border-line px-2.5 py-2 text-left hover:bg-subtle"><span className="block text-xs font-medium text-ink">{preset.name}</span><span className="mt-0.5 block break-all text-[11px] text-faint">{preset.baseUrl}</span></button>)}
                  </div>
                ) : (
                  <div className="min-h-0 space-y-1 overflow-y-auto">
                    {connections.map((connection) => <button key={connection.id} type="button" aria-pressed={!selectedRuntime && selectedId === connection.id} onClick={() => { setSelectedId(connection.id); setSelectedRuntime(null); }} className={`flex w-full min-w-0 items-center gap-2 rounded-lg px-2.5 py-2 text-left ${!selectedRuntime && selectedId === connection.id ? "bg-accent-soft text-accent-ink" : "text-muted hover:bg-subtle hover:text-ink"}`}><span className={`h-2 w-2 shrink-0 rounded-full ${connection.lastCheck?.ok ? "bg-ok" : connection.lastCheck ? "bg-warn" : "bg-faint"}`} aria-hidden /><span className="min-w-0 flex-1 truncate text-xs font-medium">{connection.name}</span>{connection.hasKey && <span className="shrink-0 text-[10px] text-faint">key</span>}</button>)}
                    {!connections.length && <p className="px-2 py-3 text-xs leading-relaxed text-faint">{t("No connections yet. Choose a preset to get started.")}</p>}
                  </div>
                )}
                </div>
              </div>

              <div className="min-h-0 min-w-0 flex-1 overflow-y-auto p-4 sm:p-5">
                {selectedRuntimeDetection ? (
                  <div className="max-w-md space-y-3">
                    <p className="text-xs leading-relaxed text-faint">
                      {t("Detected on this machine. A runtime needs its CLI installed and signed in, not an API key.")}
                    </p>
                    {runtimeDiscovery.error && (
                      <div className="flex items-start gap-2 rounded-lg border border-danger/30 bg-danger-soft p-3 text-xs text-danger-ink" role="alert">
                        <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
                        <span>{runtimeDiscovery.error}</span>
                      </div>
                    )}
                    <RuntimeCard
                      detection={selectedRuntimeDetection}
                      preference={runtimeDiscovery.preferences.find((item) => (
                        item.runtime === selectedRuntimeDetection.runtime
                        && item.connectionId === selectedRuntimeDetection.catalog?.connectionId
                        && item.scope === "global"
                        && item.scopeKey === null
                      ))}
                      onRefresh={async () => { await runtimeDiscovery.refresh(); }}
                      onSavePreference={runtimeDiscovery.savePreference}
                      onSaveBinaryPath={runtimeDiscovery.saveBinaryPath}
                      refreshing={runtimeDiscovery.loading}
                    />
                  </div>
                ) : showPresets ? <div className="flex h-full items-center justify-center text-center text-xs text-faint">{t("Choose a preset on the left.")}</div> : (
                  <div className="space-y-5">
                    <div className="flex flex-wrap items-start justify-between gap-3"><div className="min-w-0"><h4 className="text-sm font-semibold text-ink">{active?.name || name || t("New connection")}</h4><p className="mt-1 text-xs text-faint">{active?.hasKey ? t("API key is stored securely on the server.") : t("API key is optional for this connection.")}</p></div>{active && <button type="button" onClick={() => void handleDelete()} disabled={deleting} className="btn-ghost shrink-0 text-danger-ink"><Trash2 className="h-3.5 w-3.5" />{deleting ? t("Deleting...") : t("Delete")}</button>}</div>
                    <div><label htmlFor="connection-name" className={labelClass}>{t("Connection name")}</label><input id="connection-name" className={inputClass} value={name} onChange={(event) => setName(event.target.value)} placeholder="Ollama" /></div>
                    <div><span id="wire-format-label" className={labelClass}>{t("Wire format")}</span><div className="grid grid-cols-2 gap-2" role="group" aria-labelledby="wire-format-label">{(["openai", "anthropic"] as WireFormat[]).map((item) => <button key={item} type="button" aria-pressed={format === item} onClick={() => setFormat(item)} className={`rounded-lg border px-3 py-2 text-left text-xs ${format === item ? "border-accent bg-accent-soft text-accent-ink" : "border-line text-muted hover:bg-subtle"}`}>{item === "openai" ? "OpenAI compatible" : "Anthropic Messages"}</button>)}</div></div>
                    <div><label htmlFor="connection-base-url" className={labelClass}>{t("Base URL")}</label><input id="connection-base-url" className={`${inputClass} font-mono text-xs`} value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder="http://localhost:11434" /></div>
                    <div><label htmlFor="connection-api-key" className={labelClass}>{t("API key")}</label><input id="connection-api-key" key={`${selectedId || "new"}-${active?.hasKey ? "stored" : "empty"}`} ref={apiKeyRef} type="password" defaultValue="" placeholder={active?.hasKey ? t("(stored on server)") : t("Optional") } autoComplete="new-password" className={`${inputClass} font-mono text-xs`} /><div className="mt-1.5 flex flex-wrap items-center justify-between gap-3"><p className="field-hint mt-0">{t("Blank keeps an existing key. Use Remove key to delete it.")}</p>{active?.hasKey && <button type="button" onClick={() => void handleClearKey()} disabled={saving} className="text-xs font-medium text-danger-ink hover:underline">{t("Remove key")}</button>}</div></div>
                    <div><label htmlFor="connection-api-key-env" className={labelClass}>{t("API key environment variable")}</label><input id="connection-api-key-env" className={`${inputClass} font-mono text-xs`} value={apiKeyEnv} onChange={(event) => setApiKeyEnv(event.target.value)} placeholder="OPENROUTER_API_KEY" /></div>
                    <div><label htmlFor="connection-models" className={labelClass}>{t("Models")}</label><input id="connection-models" className={`${inputClass} font-mono text-xs`} value={models} onChange={(event) => setModels(event.target.value)} placeholder="llama3, qwen2.5-coder" /><p className="field-hint">{t("Separate model names with commas. Test can discover them automatically.")}</p></div>
                    <div className="flex flex-wrap gap-4"><label className="flex items-center gap-2 text-xs text-muted"><input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />{t("Enabled")}</label><label className="flex items-center gap-2 text-xs text-muted"><input type="checkbox" checked={jsonMode} onChange={(event) => setJsonMode(event.target.checked)} />{t("JSON mode")}</label></div>

                    {(testResult || testError) && <div className={`break-words rounded-lg border p-3 text-xs ${testError || !testResult?.ok ? "border-warn/30 bg-warn-soft text-warn-ink" : "border-ok/30 bg-ok-soft text-ok-ink"}`}>{testError ? <div className="flex gap-2"><AlertCircle className="h-4 w-4 shrink-0" aria-hidden />{testError}</div> : <pre className="whitespace-pre-wrap break-words font-sans">{testSummary(testResult!, t)}</pre>}{testResult && !testResult.toolsSupported && <p className="mt-2">{t("Tools are unavailable; this connection is still suitable for plan, PRD, or tasks.")}</p>}</div>}

                    <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line pt-4"><button type="button" onClick={() => void handleTest()} disabled={testing || !name.trim() || !baseUrl.trim()} className="btn-ghost"><RefreshCw className={`h-4 w-4 ${testing ? "animate-spin" : ""}`} />{testing ? t("Testing...") : t("Test connection")}</button><div className="flex gap-2"><button type="button" onClick={onClose} className="btn-ghost">{t("Cancel")}</button><button type="button" onClick={() => void handleSave()} disabled={saving || !name.trim() || !baseUrl.trim()} className="btn-primary"><Save className="h-4 w-4" />{saving ? t("Saving...") : t("Save")}</button></div></div>
                  </div>
                )}
              </div>
            </div>
          )}



          {tab === "mcp" && (
            <div id="mcp-tabpanel" role="tabpanel" aria-labelledby="tab-mcp" className="flex min-h-0 min-w-0 flex-1"><McpPanel /></div>
          )}
        </div>

        {(loading || error) && <div className="flex min-w-0 items-center gap-2 border-t border-line px-5 py-2 text-xs text-faint">{loading && <RefreshCw className="h-3.5 w-3.5 shrink-0 animate-spin" aria-hidden />}{error ? <span className="min-w-0 break-words">{error}</span> : <span>{t("Loading connections...")}</span>} {!loading && <button type="button" onClick={() => void refresh()} className="ml-auto shrink-0 font-medium text-accent-ink hover:underline">{t("Retry")}</button>}</div>}
      </div>
    </div>
  );
};

export default ConnectionsModal;
