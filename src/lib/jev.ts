import type {
  DependencyAdvice,
  IntakeAdvice,
  IntentAdvice,
  JevSettingsPatch,
  JevSettingsPublic,
  JevTaskInput,
} from "../../server/jev/types";

export type { ApprovalAdviceEvent, JevFeature, JevSettingsPatch, JevSettingsPublic } from "../../server/jev/types";
export type { ApprovalAdvice, DependencyAdvice, IntakeAdvice, IntentAdvice, JevTaskInput } from "../../server/jev/types";

export const JEV_OFF: JevSettingsPublic = {
  enabled: false,
  hasKey: false,
  features: { intentRouting: false, intakeCheck: false, permissionRisk: false, dependencyCheck: false },
};

/** True when Jev is switched on, has a key, and this feature is ticked. */
export function jevWants(settings: JevSettingsPublic | null | undefined, feature: keyof JevSettingsPublic["features"]): boolean {
  return Boolean(settings?.enabled && settings.hasKey && settings.features[feature]);
}

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  if (!response.ok) throw new Error(`Jev request failed (${response.status})`);
  return (await response.json()) as T;
}

export const fetchJevSettings = () => json<JevSettingsPublic>("/api/jev/settings");

/** Fired after a successful save so every useJevSettings() consumer refreshes. */
export const JEV_SETTINGS_EVENT = "undagi:jev-settings";

export async function saveJevSettings(patch: JevSettingsPatch): Promise<JevSettingsPublic> {
  const saved = await json<JevSettingsPublic>("/api/jev/settings", { method: "PUT", body: JSON.stringify(patch) });
  if (typeof window !== "undefined") window.dispatchEvent(new Event(JEV_SETTINGS_EVENT));
  return saved;
}

export const testJev = () => json<{ ok: boolean; latencyMs?: number; error?: string }>("/api/jev/test", { method: "POST", body: "{}" });

/** Advice endpoints resolve to null on any failure: callers just show nothing. */
async function advice<T>(url: string, body: unknown): Promise<T | null> {
  try {
    const data = await json<{ advice: T | null }>(url, { method: "POST", body: JSON.stringify(body) });
    return data.advice ?? null;
  } catch {
    return null;
  }
}

export const requestIntentAdvice = (body: { message: string; hasPlan: boolean; hasPrd: boolean; hasTasks: boolean }) =>
  advice<IntentAdvice>("/api/jev/intent", body);

export const requestIntakeAdvice = (body: { description: string; answers?: string[] }) =>
  advice<IntakeAdvice>("/api/jev/intake", body);

export const requestDependencyAdvice = (tasks: JevTaskInput[]) =>
  advice<DependencyAdvice[]>("/api/jev/dependencies", { tasks });
