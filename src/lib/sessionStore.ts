import { ProjectSession, SessionSummary, LLMConfig, type ProjectPlan } from "../types";
import { normalizeComplexity } from "./complexity";
import { loadLanguage, makeT } from "./i18n";

// Riwayat proyek disimpan server-side di SQLite. llmConfig tidak ikut disimpan:
// itu preferensi per-device (dan bisa memuat API key), jadi tetap di localStorage.
export function stripLocalOnlyFields(session: ProjectSession) {
  const { llmConfig, ...persisted } = session;
  return persisted;
}

// Bahasa dibaca dari localStorage, bukan diterima sebagai argumen: sumbernya
// sama dengan yang dipakai provider, dan menyalurkan `t` lewat setiap pemanggil
// hanya menambah derau di App.
const lang = () => loadLanguage();

// Server memilih bahasa pesan errornya dari parameter ini.
const withLang = (url: string) => `${url}${url.includes("?") ? "&" : "?"}lang=${lang()}`;

export function normalizeStoredPlan(value: unknown): ProjectPlan | undefined {
  if (!value || typeof value !== "object") return undefined;
  const plan = value as Partial<ProjectPlan>;
  const specs = plan.specs && typeof plan.specs === "object" ? plan.specs : {} as ProjectPlan["specs"];
  const architecture = plan.architectureDraft && typeof plan.architectureDraft === "object"
    ? plan.architectureDraft
    : {} as ProjectPlan["architectureDraft"];
  const estimation = plan.estimation && typeof plan.estimation === "object"
    ? plan.estimation
    : {} as ProjectPlan["estimation"];

  return {
    ...plan,
    summary: typeof plan.summary === "string" ? plan.summary : "",
    specs: {
      ...specs,
      targetAudience: typeof specs.targetAudience === "string" ? specs.targetAudience : "",
      keyValueProposition: typeof specs.keyValueProposition === "string" ? specs.keyValueProposition : "",
      coreFeatures: Array.isArray(specs.coreFeatures) ? specs.coreFeatures : [],
      techStack: Array.isArray(specs.techStack) ? specs.techStack : [],
    },
    architectureDraft: {
      ...architecture,
      overview: typeof architecture.overview === "string" ? architecture.overview : "",
      components: Array.isArray(architecture.components) ? architecture.components : [],
      dataFlow: typeof architecture.dataFlow === "string" ? architecture.dataFlow : "",
      securityAndAuth: typeof architecture.securityAndAuth === "string" ? architecture.securityAndAuth : "",
    },
    roadmap: Array.isArray(plan.roadmap) ? plan.roadmap : [],
    estimation: {
      ...estimation,
      totalTimeWeeks: typeof estimation.totalTimeWeeks === "string" ? estimation.totalTimeWeeks : "",
      complexityLevel: normalizeComplexity(estimation.complexityLevel),
      requiredResources: Array.isArray(estimation.requiredResources) ? estimation.requiredResources : [],
      potentialRisks: Array.isArray(estimation.potentialRisks) ? estimation.potentialRisks : [],
    },
  };
}

async function readError(res: Response, fallbackKey: string): Promise<string> {
  const fallback = makeT(lang())(fallbackKey);
  try {
    const data = await res.json();
    return data.error || fallback;
  } catch {
    return fallback;
  }
}

export async function fetchSessionList(): Promise<SessionSummary[]> {
  const res = await fetch(withLang("/api/sessions"));
  if (!res.ok) throw new Error(await readError(res, "Failed to load project history."));
  const data = await res.json();
  return data.sessions || [];
}

export async function fetchSession(id: string, llmConfig: LLMConfig): Promise<ProjectSession | null> {
  const res = await fetch(withLang(`/api/sessions/${encodeURIComponent(id)}`));
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(await readError(res, "Failed to open the project session."));
  const stored = await res.json();
  return {
    ...stored,
    // Sessions created before follow-up questions were persisted have no
    // field at all. Normalize at the storage boundary so every view gets the
    // current ProjectSession shape.
    followUps: Array.isArray(stored.followUps) ? stored.followUps : [],
    plan: normalizeStoredPlan(stored.plan),
    llmConfig,
  } as ProjectSession;
}

export async function persistSession(session: ProjectSession): Promise<void> {
  const res = await fetch(withLang(`/api/sessions/${encodeURIComponent(session.id)}`), {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(stripLocalOnlyFields(session)),
  });
  if (!res.ok) throw new Error(await readError(res, "Failed to save the project session."));
}

export async function removeSession(id: string): Promise<void> {
  const res = await fetch(withLang(`/api/sessions/${encodeURIComponent(id)}`), { method: "DELETE" });
  if (!res.ok) throw new Error(await readError(res, "Failed to delete the project session."));
}

/** Removes one chat of a project; the project itself stays. */
export async function removeChat(conversationId: string): Promise<void> {
  const res = await fetch(withLang(`/api/agent/conversations/${encodeURIComponent(conversationId)}`), { method: "DELETE" });
  if (!res.ok) throw new Error(await readError(res, "Failed to delete the chat."));
}
