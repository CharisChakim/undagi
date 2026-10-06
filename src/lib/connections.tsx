// Copyright (c) 2026 Charis Chakim - Undagi (https://github.com/CharisChakim/undagi)
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PropsWithChildren,
  type ReactNode,
} from 'react';
import type { AgentRole, Connection, RoleBinding, WireFormat } from '../types';
import { migrateLegacyLLMConfig } from './legacyConnectionMigration';

export type RoleBindings = Partial<Record<AgentRole, RoleBinding>>;

const ROLES: readonly AgentRole[] = ['agent', 'plan', 'prd', 'tasks'];

export interface ConnectionsSnapshot {
  connections: Connection[];
  roles: RoleBindings;
}

export interface ConnectionDraft {
  name: string;
  format: WireFormat;
  baseUrl: string;
  apiKey?: string | null;
  apiKeyEnv?: string | null;
  headers?: Record<string, string>;
  models?: string[];
  jsonMode?: boolean;
  enabled?: boolean;
}

export type ConnectionPatch = Partial<ConnectionDraft> & { id?: string };

export interface ConnectionProbe {
  name: 'models' | 'chat' | 'tools';
  ok: boolean;
  ms: number;
  detail?: string;
}

export interface ConnectionTestResult {
  ok: boolean;
  toolsSupported: boolean;
  models: string[];
  probes: ConnectionProbe[];
}

export interface ModelDiscoveryResult {
  models: string[];
  source: 'remote' | 'manual';
  error?: string;
}

export type ConnectionTestInput = Partial<ConnectionDraft> & {
  model?: string;
};

export class ConnectionsApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'ConnectionsApiError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function stringMap(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const entries = Object.entries(value).filter(
    (entry): entry is [string, string] => typeof entry[1] === 'string',
  );
  return entries.length > 0 ? Object.fromEntries(entries) : {};
}

// Explicit field selection prevents an accidentally returned apiKey from entering client state.
function publicConnection(value: unknown): Connection {
  if (!isRecord(value)) throw new Error('Invalid connection response.');

  const format: WireFormat = value.format === 'anthropic' ? 'anthropic' : 'openai';
  const connection: Connection = {
    id: stringValue(value.id),
    name: stringValue(value.name),
    format,
    baseUrl: stringValue(value.baseUrl),
    hasKey: value.hasKey === true,
    models: stringList(value.models),
    jsonMode: value.jsonMode !== false,
    enabled: value.enabled !== false,
  };

  const apiKeyEnv = stringValue(value.apiKeyEnv).trim();
  if (apiKeyEnv) connection.apiKeyEnv = apiKeyEnv;

  const headers = stringMap(value.headers);
  if (headers) connection.headers = headers;

  if (isRecord(value.lastCheck) && typeof value.lastCheck.ok === 'boolean') {
    connection.lastCheck = {
      ok: value.lastCheck.ok,
      toolsSupported: value.lastCheck.toolsSupported === true,
      at: stringValue(value.lastCheck.at),
      ...(typeof value.lastCheck.message === 'string' ? { message: value.lastCheck.message } : {}),
    };
  }

  return connection;
}

function roleBindings(value: unknown): RoleBindings {
  if (!isRecord(value)) return {};
  const roles: RoleBindings = {};
  for (const role of ROLES) {
    const binding = value[role];
    if (!isRecord(binding)) continue;
    const connectionId = stringValue(binding.connectionId).trim();
    const model = stringValue(binding.model).trim();
    if (connectionId && model) roles[role] = { connectionId, model };
  }
  return roles;
}

async function responseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function responseError(body: unknown, fallback: string): string {
  return isRecord(body) && typeof body.error === 'string' ? body.error : fallback;
}

async function requestJson<T>(url: string, init: RequestInit, fallback: string): Promise<T> {
  const response = await fetch(url, init);
  const body = await responseBody(response);
  if (!response.ok) throw new ConnectionsApiError(responseError(body, fallback), response.status);
  return body as T;
}

function jsonInit(method: string, body: unknown): RequestInit {
  return {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

export async function fetchConnections(): Promise<ConnectionsSnapshot> {
  const body = await requestJson<unknown>('/api/connections', {}, 'Failed to load connections.');
  if (!isRecord(body)) throw new Error('Invalid connections response.');
  const connections = Array.isArray(body.connections) ? body.connections.map(publicConnection) : [];
  return { connections, roles: roleBindings(body.roles) };
}

export async function createConnection(input: ConnectionDraft): Promise<Connection> {
  const body = await requestJson<unknown>(
    '/api/connections',
    jsonInit('POST', input),
    'Failed to create connection.',
  );
  return publicConnection(body);
}

export async function updateConnection(id: string, patch: ConnectionPatch): Promise<Connection> {
  const body = await requestJson<unknown>(
    `/api/connections/${encodeURIComponent(id)}`,
    jsonInit('PUT', patch),
    'Failed to update connection.',
  );
  return publicConnection(body);
}

export async function saveConnection(input: ConnectionPatch): Promise<Connection> {
  const { id, ...patch } = input;
  if (id) return updateConnection(id, patch);
  if (!patch.name || !patch.format || !patch.baseUrl) {
    throw new Error('name, format, and baseUrl are required.');
  }
  return createConnection({
    name: patch.name,
    format: patch.format,
    baseUrl: patch.baseUrl,
    ...patch,
  });
}

export async function deleteConnection(id: string): Promise<void> {
  await requestJson<unknown>(
    `/api/connections/${encodeURIComponent(id)}`,
    { method: 'DELETE' },
    'Failed to delete connection.',
  );
}

export async function discoverModels(id: string): Promise<ModelDiscoveryResult> {
  const body = await requestJson<unknown>(
    `/api/connections/${encodeURIComponent(id)}/models`,
    jsonInit('POST', {}),
    'Failed to discover models.',
  );
  if (!isRecord(body)) throw new Error('Invalid model discovery response.');
  const source = body.source === 'remote' ? 'remote' : 'manual';
  return {
    models: stringList(body.models),
    source,
    ...(typeof body.error === 'string' ? { error: body.error } : {}),
  };
}

function testResult(value: unknown): ConnectionTestResult {
  if (!isRecord(value)) throw new Error('Invalid connection test response.');
  const probes = Array.isArray(value.probes)
    ? value.probes.flatMap((probe): ConnectionProbe[] => {
        if (!isRecord(probe)) return [];
        if (probe.name !== 'models' && probe.name !== 'chat' && probe.name !== 'tools') return [];
        return [{
          name: probe.name,
          ok: probe.ok === true,
          ms: typeof probe.ms === 'number' ? probe.ms : 0,
          ...(typeof probe.detail === 'string' ? { detail: probe.detail } : {}),
        }];
      })
    : [];
  return {
    ok: value.ok === true,
    toolsSupported: value.toolsSupported === true,
    models: stringList(value.models),
    probes,
  };
}

export async function testConnection(input: ConnectionTestInput): Promise<ConnectionTestResult> {
  const body = await requestJson<unknown>(
    '/api/connections/test',
    jsonInit('POST', input),
    'Failed to test connection.',
  );
  return testResult(body);
}

export async function testStoredConnection(id: string, model?: string): Promise<ConnectionTestResult> {
  const body = await requestJson<unknown>(
    `/api/connections/${encodeURIComponent(id)}/test`,
    jsonInit('POST', model ? { model } : {}),
    'Failed to test connection.',
  );
  return testResult(body);
}

export async function bindRole(role: AgentRole, connectionId: string, model: string): Promise<void>;
export async function bindRole(role: AgentRole, binding: RoleBinding): Promise<void>;
export async function bindRole(
  role: AgentRole,
  connectionOrBinding: string | RoleBinding,
  model?: string,
): Promise<void> {
  const connectionId = typeof connectionOrBinding === 'string' ? connectionOrBinding : connectionOrBinding.connectionId;
  const selectedModel = typeof connectionOrBinding === 'string' ? model : connectionOrBinding.model;
  if (!connectionId || !selectedModel) throw new Error('connectionId and model are required.');
  await requestJson<unknown>(
    '/api/roles',
    jsonInit('PUT', { role, connectionId, model: selectedModel }),
    'Failed to bind model role.',
  );
}

export interface ResolvedRoleConnection {
  connection: Connection;
  model: string;
  fallback: boolean;
}

// Binding yang menunjuk koneksi mati tidak boleh membuat pemanggil kehilangan model.
export function resolveRoleConnection(
  role: AgentRole,
  connections: readonly Connection[],
  roles: RoleBindings,
): ResolvedRoleConnection | undefined {
  const binding = roles[role];
  if (binding) {
    const connection = connections.find((item) => item.id === binding.connectionId && item.enabled);
    if (connection) return { connection, model: binding.model, fallback: false };
  }

  const fallback = connections.find((item) => item.enabled);
  return fallback
    ? { connection: fallback, model: fallback.models[0] ?? '', fallback: true }
    : undefined;
}

export interface ConnectionsContextValue extends ConnectionsSnapshot {
  loading: boolean;
  error: string | null;
  refresh: () => Promise<ConnectionsSnapshot>;
  createConnection: (input: ConnectionDraft) => Promise<Connection>;
  updateConnection: (id: string, patch: ConnectionPatch) => Promise<Connection>;
  saveConnection: (input: ConnectionPatch) => Promise<Connection>;
  deleteConnection: (id: string) => Promise<void>;
  discoverModels: (id: string) => Promise<ModelDiscoveryResult>;
  testConnection: (input: ConnectionTestInput) => Promise<ConnectionTestResult>;
  testStoredConnection: (id: string, model?: string) => Promise<ConnectionTestResult>;
  bindRole: (role: AgentRole, connectionOrBinding: string | RoleBinding, model?: string) => Promise<void>;
  getConnection: (id: string) => Connection | undefined;
  getRoleBinding: (role: AgentRole) => RoleBinding | undefined;
  resolveRole: (role: AgentRole) => ResolvedRoleConnection | undefined;
}

const ConnectionsContext = createContext<ConnectionsContextValue | null>(null);

export function ConnectionsProvider({ children }: PropsWithChildren): ReactNode {
  const [snapshot, setSnapshot] = useState<ConnectionsSnapshot>({ connections: [], roles: {} });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const bootstrapPromise = useRef<Promise<ConnectionsSnapshot> | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const next = await fetchConnections();
      setSnapshot(next);
      return next;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      throw cause;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let active = true;
    if (!bootstrapPromise.current) {
      bootstrapPromise.current = (async () => {
        let next = await fetchConnections();
        if (next.connections.length === 0) {
          await migrateLegacyLLMConfig({ connections: next.connections });
          next = await fetchConnections();
        }
        return next;
      })();
    }

    bootstrapPromise.current.then(
      (next) => {
        if (!active) return;
        setSnapshot(next);
        setError(null);
        setLoading(false);
      },
      (cause) => {
        if (!active) return;
        setError(cause instanceof Error ? cause.message : String(cause));
        setLoading(false);
      },
    );

    return () => {
      active = false;
    };
  }, []);

  const add = useCallback(async (input: ConnectionDraft) => {
    const connection = await createConnection(input);
    setSnapshot((current) => ({ ...current, connections: [...current.connections, connection] }));
    return connection;
  }, []);

  const update = useCallback(async (id: string, patch: ConnectionPatch) => {
    const connection = await updateConnection(id, patch);
    setSnapshot((current) => ({
      ...current,
      connections: current.connections.map((item) => (item.id === id ? connection : item)),
    }));
    return connection;
  }, []);

  const save = useCallback(async (input: ConnectionPatch) => {
    const connection = await saveConnection(input);
    setSnapshot((current) => {
      const exists = current.connections.some((item) => item.id === connection.id);
      return {
        ...current,
        connections: exists
          ? current.connections.map((item) => (item.id === connection.id ? connection : item))
          : [...current.connections, connection],
      };
    });
    return connection;
  }, []);

  const remove = useCallback(async (id: string) => {
    await deleteConnection(id);
    setSnapshot((current) => {
      const roles = Object.fromEntries(
        Object.entries(current.roles).filter(([, binding]) => binding?.connectionId !== id),
      ) as RoleBindings;
      return { connections: current.connections.filter((item) => item.id !== id), roles };
    });
  }, []);

  const discover = useCallback(async (id: string) => {
    const result = await discoverModels(id);
    setSnapshot((current) => ({
      ...current,
      connections: current.connections.map((item) =>
        item.id === id ? { ...item, models: result.models } : item,
      ),
    }));
    return result;
  }, []);

  const bind = useCallback(async (
    role: AgentRole,
    connectionOrBinding: string | RoleBinding,
    model?: string,
  ) => {
    const connectionId = typeof connectionOrBinding === 'string'
      ? connectionOrBinding
      : connectionOrBinding.connectionId;
    const selectedModel = typeof connectionOrBinding === 'string' ? model : connectionOrBinding.model;
    await bindRole(role, connectionId, selectedModel || '');
    setSnapshot((current) => ({
      ...current,
      roles: { ...current.roles, [role]: { connectionId, model: selectedModel || '' } },
    }));
  }, []);

  const testStored = useCallback(async (id: string, model?: string) => {
    const result = await testStoredConnection(id, model);
    setSnapshot((current) => ({
      ...current,
      connections: current.connections.map((connection) => (
        connection.id === id
          ? {
              ...connection,
              lastCheck: {
                ok: result.ok,
                toolsSupported: result.toolsSupported,
                at: new Date().toISOString(),
                ...(result.probes.find((probe) => !probe.ok)?.detail
                  ? { message: result.probes.find((probe) => !probe.ok)?.detail }
                  : {}),
              },
            }
          : connection
      )),
    }));
    return result;
  }, []);

  const getConnection = useCallback(
    (id: string) => snapshot.connections.find((connection) => connection.id === id),
    [snapshot.connections],
  );
  const getRoleBinding = useCallback((role: AgentRole) => snapshot.roles[role], [snapshot.roles]);
  const resolveRole = useCallback(
    (role: AgentRole) => resolveRoleConnection(role, snapshot.connections, snapshot.roles),
    [snapshot.connections, snapshot.roles],
  );

  const value = useMemo<ConnectionsContextValue>(() => ({
    ...snapshot,
    loading,
    error,
    refresh,
    createConnection: add,
    updateConnection: update,
    saveConnection: save,
    deleteConnection: remove,
    discoverModels: discover,
    testConnection,
    testStoredConnection: testStored,
    bindRole: bind,
    getConnection,
    getRoleBinding,
    resolveRole,
  }), [snapshot, loading, error, refresh, add, update, remove, discover, testStored, bind, getConnection, getRoleBinding, resolveRole]);

  return <ConnectionsContext.Provider value={value}>{children}</ConnectionsContext.Provider>;
}

export function useConnections(): ConnectionsContextValue {
  const context = useContext(ConnectionsContext);
  if (!context) throw new Error('useConnections must be used within ConnectionsProvider.');
  return context;
}
