import React, { useEffect, useMemo, useState } from "react";
import { AlertCircle, Check, Plus, RefreshCw, Save, Trash2, X } from "lucide-react";
import type { McpServerConfig } from "../../types";
import { createMcpServer, fetchMcpServers, removeMcpServer, testMcpServer, updateMcpServer, type McpServerDraft, type McpTestResult } from "../../lib/mcp";
import { useT } from "../../lib/i18n";

const inputClass = "field";

function parseObject(text: string, field: string): Record<string, string> {
  if (!text.trim()) return {};
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.values(value).some((item) => typeof item !== "string")) {
    throw new Error(`${field} must be a JSON object with string values.`);
  }
  return value as Record<string, string>;
}

export const McpPanel: React.FC = () => {
  const { t } = useT();
  const [servers, setServers] = useState<McpServerConfig[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [transport, setTransport] = useState<"stdio" | "http">("stdio");
  const [command, setCommand] = useState("");
  const [args, setArgs] = useState("");
  const [env, setEnv] = useState("{}");
  const [url, setUrl] = useState("");
  const [headers, setHeaders] = useState("{}");
  const [enabled, setEnabled] = useState(true);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<McpTestResult | null>(null);

  const active = useMemo(() => servers.find((server) => server.id === selectedId) || null, [servers, selectedId]);

  const refresh = async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const next = await fetchMcpServers();
      setServers(next);
      setSelectedId((current) => current && next.some((server) => server.id === current) ? current : next[0]?.id || null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void refresh(); }, []);

  useEffect(() => {
    setName(active?.name || "");
    setTransport(active?.transport || "stdio");
    setCommand(active?.command || "");
    setArgs(active?.args?.join("\n") || "");
    setEnv(JSON.stringify(active?.env || {}, null, 2));
    setUrl(active?.url || "");
    setHeaders(JSON.stringify(active?.headers || {}, null, 2));
    setEnabled(active?.enabled ?? true);
    setTestResult(null);
    setError(null);
  }, [active?.id]);

  const draft = (): McpServerDraft => {
    const parsedEnv = parseObject(env, t("Environment"));
    const parsedHeaders = parseObject(headers, t("Headers"));
    return {
      name: name.trim(),
      transport,
      enabled,
      ...(transport === "stdio" ? {
        command: command.trim(),
        args: args.split(/\r?\n/).map((item) => item.trim()).filter(Boolean),
        env: parsedEnv,
      } : {
        url: url.trim(),
        headers: parsedHeaders,
      }),
    };
  };

  const handleSave = async (): Promise<void> => {
    setSaving(true);
    setError(null);
    try {
      const value = draft();
      if (selectedId) await updateMcpServer(selectedId, value);
      else await createMcpServer(value);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async (): Promise<void> => {
    setTesting(true);
    setError(null);
    setTestResult(null);
    try {
      setTestResult(await testMcpServer(draft()));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setTesting(false);
    }
  };

  const handleDelete = async (): Promise<void> => {
    if (!selectedId) return;
    setDeleting(true);
    try {
      await removeMcpServer(selectedId);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setDeleting(false);
    }
  };

  const newServer = (): void => {
    setSelectedId(null);
    setName("");
    setTransport("stdio");
    setCommand("");
    setArgs("");
    setEnv("{}");
    setUrl("");
    setHeaders("{}");
    setEnabled(true);
    setTestResult(null);
    setError(null);
  };

  return (
    <div className="relative flex min-h-0 flex-1 flex-col sm:flex-row">
      <div className="flex max-h-48 shrink-0 flex-col border-b border-line p-3 sm:max-h-none sm:w-56 sm:border-b-0 sm:border-r">
        <div className="mb-2 flex items-center justify-between gap-2">
          <span className="text-xs font-semibold text-ink">{t("MCP servers")}</span>
          <button type="button" onClick={newServer} title={t("Add MCP server")} className="rounded-md p-1 text-accent-ink hover:bg-accent-soft"><Plus className="h-4 w-4" /></button>
        </div>
        <div className="min-h-0 space-y-1 overflow-y-auto">
          {servers.map((server) => (
            <button key={server.id} type="button" onClick={() => setSelectedId(server.id)} className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left ${selectedId === server.id ? "bg-accent-soft text-accent-ink" : "text-muted hover:bg-subtle hover:text-ink"}`}>
              <span className={`h-2 w-2 shrink-0 rounded-full ${server.enabled ? "bg-ok" : "bg-faint"}`} />
              <span className="min-w-0 flex-1 truncate text-xs font-medium">{server.name}</span>
              <span className="text-[10px] text-faint">{server.transport}</span>
            </button>
          ))}
          {!servers.length && !loading && <p className="px-2 py-3 text-xs leading-relaxed text-faint">{t("No MCP servers yet.")}</p>}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-5">
        <div className="max-w-xl space-y-4">
          <div className="flex items-start justify-between gap-3">
            <div><h4 className="text-sm font-semibold text-ink">{active?.name || name || t("New MCP server")}</h4><p className="mt-1 text-xs text-faint">{t("MCP connects external tools to the agent on demand.")}</p></div>
            {active && <button type="button" onClick={() => void handleDelete()} disabled={deleting} className="btn-ghost text-danger-ink"><Trash2 className="h-3.5 w-3.5" />{t("Delete")}</button>}
          </div>

          <div><label className="field-label">{t("Server name")}</label><input className={inputClass} value={name} onChange={(event) => setName(event.target.value)} placeholder="filesystem" /></div>
          <div><label className="field-label">{t("Transport")}</label><div className="grid grid-cols-2 gap-2">{(["stdio", "http"] as const).map((item) => <button key={item} type="button" onClick={() => setTransport(item)} className={`rounded-lg border px-3 py-2 text-left text-xs ${transport === item ? "border-accent bg-accent-soft text-accent-ink" : "border-line text-muted hover:bg-subtle"}`}>{item === "stdio" ? t("Command (stdio)") : t("Streamable HTTP")}</button>)}</div></div>

          {transport === "stdio" ? (
            <>
              <div><label className="field-label">{t("Command")}</label><input className={`${inputClass} font-mono text-xs`} value={command} onChange={(event) => setCommand(event.target.value)} placeholder="npx" /></div>
              <div><label className="field-label">{t("Arguments")}</label><textarea className={`${inputClass} min-h-24 font-mono text-xs`} value={args} onChange={(event) => setArgs(event.target.value)} placeholder="-y\n@modelcontextprotocol/server-filesystem\n/tmp" /><p className="field-hint">{t("One argument per line.")}</p></div>
              <div><label className="field-label">{t("Environment (JSON)")}</label><textarea className={`${inputClass} min-h-24 font-mono text-xs`} value={env} onChange={(event) => setEnv(event.target.value)} spellCheck={false} /></div>
            </>
          ) : (
            <>
              <div><label className="field-label">{t("Server URL")}</label><input className={`${inputClass} font-mono text-xs`} value={url} onChange={(event) => setUrl(event.target.value)} placeholder="http://localhost:3001/mcp" /></div>
              <div><label className="field-label">{t("Headers (JSON)")}</label><textarea className={`${inputClass} min-h-24 font-mono text-xs`} value={headers} onChange={(event) => setHeaders(event.target.value)} spellCheck={false} /></div>
            </>
          )}

          <label className="flex items-center gap-2 text-xs text-muted"><input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />{t("Enabled")}</label>

          {error && <div className="flex gap-2 rounded-lg border border-warn/30 bg-warn-soft p-3 text-xs text-warn-ink"><AlertCircle className="h-4 w-4 shrink-0" /><span className="whitespace-pre-wrap">{error}</span></div>}
          {testResult && <div className={`rounded-lg border p-3 text-xs ${testResult.ok ? "border-ok/30 bg-ok-soft text-ok-ink" : "border-warn/30 bg-warn-soft text-warn-ink"}`}><div className="flex items-center gap-2 font-medium">{testResult.ok ? <Check className="h-4 w-4" /> : <AlertCircle className="h-4 w-4" />}{testResult.ok ? t("MCP connection works") : testResult.error || t("MCP connection failed")}</div>{testResult.ok && <p className="mt-1">{t("Tools discovered: {count}", { count: testResult.tools.length })}</p>}{testResult.tools.length > 0 && <p className="mt-1 font-mono text-[11px]">{testResult.tools.map((tool) => tool.name).join(", ")}</p>}</div>}

          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line pt-4"><button type="button" onClick={() => void handleTest()} disabled={testing || !name.trim()} className="btn-ghost"><RefreshCw className={`h-4 w-4 ${testing ? "animate-spin" : ""}`} />{testing ? t("Testing...") : t("Test server")}</button><div className="flex gap-2"><button type="button" onClick={newServer} className="btn-ghost"><X className="h-4 w-4" />{t("Clear")}</button><button type="button" onClick={() => void handleSave()} disabled={saving || !name.trim()} className="btn-primary"><Save className="h-4 w-4" />{saving ? t("Saving...") : t("Save")}</button></div></div>
        </div>
      </div>
      {loading && <div className="absolute inset-0 grid place-items-center bg-surface/70"><RefreshCw className="h-4 w-4 animate-spin text-accent-ink" /></div>}
    </div>
  );
};
