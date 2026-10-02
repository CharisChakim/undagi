export type LLMProvider = 'gemini' | 'ollama' | 'custom';

export interface LLMConfig {
  provider: LLMProvider;
  modelName: string;
  baseUrl?: string;
  apiKey?: string;
  // Bila false, API key hanya dipakai selama sesi browser ini dan tidak
  // dituliskan ke localStorage.
  saveApiKey?: boolean;
}

export type WireFormat = "anthropic" | "openai";
export type AgentRole = "agent" | "plan" | "prd" | "tasks";
/** Which approvals a chat run answers itself: none, file edits, or all. */
export type PermissionMode = "ask" | "auto" | "full";

export interface ConnectionCheck {
  ok: boolean;
  toolsSupported: boolean;
  at: string;
  message?: string;
}

export interface Connection {
  id: string;
  name: string;
  format: WireFormat;
  baseUrl: string;
  hasKey: boolean;
  apiKeyEnv?: string;
  headers?: Record<string, string>;
  models: string[];
  jsonMode: boolean;
  enabled: boolean;
  lastCheck?: ConnectionCheck;
}

/** Public runtime discovery contract returned by `/api/runtimes`. */
export const RUNTIME_IDS = ["codex", "claude", "antigravity"] as const;
export type RuntimeId = (typeof RUNTIME_IDS)[number];

export type RuntimeStatus =
  | "ready"
  | "needs_login"
  | "not_installed"
  | "unsupported_version"
  | "error";

export type RuntimeAuthStatus = "authenticated" | "unauthenticated" | "unknown";
export type CatalogAvailability = "listed" | "verified" | "unavailable" | "unknown";
export type CatalogSource =
  | "codex-app-server:model/list"
  | "claude-agent-sdk:supportedModels"
  | "antigravity-cli:agy models"
  | "manual"
  | "unknown";
export type DefaultSource =
  | "catalog"
  | "runtime-config"
  | "user-override"
  | "model-default"
  | "unknown";
export type CapabilitySupport = "supported" | "unsupported" | "unknown";

export interface RuntimeCapabilities {
  structuredOutput: CapabilitySupport;
  toolUse: CapabilitySupport;
  approval: CapabilitySupport;
  resume: CapabilitySupport;
  interrupt: CapabilitySupport;
  usage: CapabilitySupport;
  streaming: CapabilitySupport;
}

export interface RuntimeEffortOption {
  value: string;
  label: string;
}

export interface RuntimeModel {
  connectionId: string;
  modelId: string;
  label: string;
  source: CatalogSource;
  discoveredAt: string;
  runtimeVersion: string | null;
  authScope: string | null;
  availability: CatalogAvailability;
  effortOptions: RuntimeEffortOption[];
  defaultModel: string | null;
  defaultEffort: string | null;
  defaultSource: DefaultSource;
  capabilities: RuntimeCapabilities;
}

export interface RuntimeCatalog {
  connectionId: string;
  runtime: RuntimeId;
  source: CatalogSource;
  discoveredAt: string;
  expiresAt: string;
  models: RuntimeModel[];
  error: string | null;
  /** The last catalog read successfully, shown because the latest read failed. */
  stale?: boolean;
}

/** `binaryPath` is intentionally replaced by the server's public `binaryFound` flag. */
export interface RuntimeDetection {
  runtime: RuntimeId;
  status: RuntimeStatus;
  authStatus: RuntimeAuthStatus;
  binaryFound: boolean;
  /** Path yang diisi pengguna; null berarti deteksi menelusuri PATH. */
  binaryPathOverride: string | null;
  version: string | null;
  checkedAt: string;
  capabilities: RuntimeCapabilities;
  catalog: RuntimeCatalog | null;
  diagnostic: string | null;
}

export interface RuntimeDiscoveryReport {
  checkedAt: string;
  ttlMs: number;
  runtimes: RuntimeDetection[];
}

export type RuntimePreferenceValue = "inherit" | string;
export type RuntimePreferenceScope = "global" | "workspace" | "role";
export type RuntimePreferenceSource = "inherit" | "user-override";

export interface RuntimePreference {
  runtime: RuntimeId;
  connectionId: string;
  scope: RuntimePreferenceScope;
  scopeKey: string | null;
  requestedModel: RuntimePreferenceValue;
  requestedEffort: RuntimePreferenceValue;
  modelSource: RuntimePreferenceSource;
  effortSource: RuntimePreferenceSource;
  updatedAt: string | null;
}

export interface RuntimePreferenceInput {
  runtime: RuntimeId;
  connectionId: string;
  scope: "global";
  scopeKey: null;
  model: RuntimePreferenceValue;
  effort: RuntimePreferenceValue;
}

export interface RoleBinding {
  connectionId: string;
  model: string;
}

export interface McpServerConfig {
  id: string;
  name: string;
  enabled: boolean;
  transport: "stdio" | "http";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  status?: { ok: boolean; tools: number; message?: string };
}

export interface ProjectInput {
  title: string;
  description: string;
  targetAudience?: string;
  techStackPreference?: string;
  answersToFollowUp: Record<string, string>;
}

export interface FollowUpQuestion {
  id: string;
  category: 'technical' | 'scope' | 'user' | 'priority';
  question: string;
  explanation: string;
  suggestedAnswer: string;
  options?: string[];
  // Ronde klarifikasi ke berapa pertanyaan ini muncul.
  round?: number;
}

export interface FeatureSpec {
  name: string;
  description: string;
  priority: 'P0' | 'P1' | 'P2';
  // Pecahan fitur yang bisa dikerjakan terpisah. Mengisi kolom ketiga kanvas
  // struktur; opsional karena plan lama tidak memilikinya.
  subFeatures?: string[];
}

export interface TechStackSpec {
  layer: string;
  technology: string;
  rationale: string;
}

export interface FunctionalRequirement {
  id: string;
  title: string;
  description: string;
  priority: 'P0' | 'P1' | 'P2';
}

export interface NonFunctionalRequirement {
  category: string;
  description: string;
}

export interface DataEntity {
  name: string;
  description: string;
  fields: { name: string; type: string; constraints?: string }[];
}

export interface UserPersona {
  role: string;
  goal: string;
  painPoint: string;
}

export interface ArchitectureDraft {
  overview: string;
  components: { name: string; purpose: string; type: string }[];
  dataFlow: string;
  securityAndAuth: string;
  diagramMermaid?: string;
}

export interface RoadmapPhase {
  phase: string;
  title: string;
  duration: string;
  deliverables: string[];
}

// Bahasa-netral. Sesi lama menyimpan 'Rendah'/'Sedang'/... — dinormalkan oleh
// normalizeComplexity (src/lib/complexity.ts) saat dimuat.
export type ComplexityLevel = 'low' | 'medium' | 'high' | 'very_high';

export interface Estimation {
  totalTimeWeeks: string;
  complexityLevel: ComplexityLevel;
  requiredResources: string[];
  potentialRisks: { risk: string; mitigation: string }[];
}

export interface ProjectPlan {
  suggestedTitle?: string;
  summary: string;
  specs: {
    targetAudience: string;
    keyValueProposition: string;
    coreFeatures: FeatureSpec[];
    techStack: TechStackSpec[];
  };
  architectureDraft: ArchitectureDraft;
  roadmap: RoadmapPhase[];
  estimation: Estimation;
}

export interface PRDSectionCoreFeatures {
  phase1: string[];
  phase2: string[];
  phase3: string[];
  futurePhases?: string[];
}

// Poin PRD di luar 7 poin wajib, ditambahkan LLM bila analisis menuntutnya.
export interface PRDExtraSection {
  number: number;
  title: string;
  content: string;
}

export type PRDArtifactVersionStatus = "active" | "superseded";

/** Immutable PRD snapshots persisted inside the project session JSON. */
export interface PRDArtifactVersion {
  id: string;
  number: number;
  timestamp: string;
  contentHash: string;
  content: string;
  status: PRDArtifactVersionStatus;
}

// Poin 2, 6, dan 7 bisa berupa data terstruktur dari LLM ATAU teks bebas setelah
// pengguna mengeditnya di tab "Overview & Edit". Formatter di Step2PRD dan prompt
// Step 3 sudah menerima kedua bentuk; tipe ini membuatnya eksplisit.
export interface PRDRequirements {
  functional: FunctionalRequirement[];
  nonFunctional: NonFunctionalRequirement[];
}

export interface PRDData {
  projectTitle: string;
  overview: string; // Point 1
  requirements: PRDRequirements | string; // Point 2
  coreFeatures: PRDSectionCoreFeatures; // Point 3
  userFlow: string; // Point 4
  architecture: string; // Point 5
  databaseSchema: DataEntity[] | string; // Point 6
  techStack: TechStackSpec[] | string; // Point 7
  additionalSections?: PRDExtraSection[]; // Point 8+, opsional

  // Legacy / extra fields for compatibility
  artifactVersionId?: string;
  artifactVersionNumber?: number;
  artifactContentHash?: string;
  executiveSummary?: string;
  userPersonas?: UserPersona[];
  functionalRequirements?: FunctionalRequirement[];
  nonFunctionalRequirements?: NonFunctionalRequirement[];
  dataSchema?: DataEntity[];
  logicFlowMermaid: string;
  logicFlowExplanation: string;
  fullMarkdownText: string;
}

export interface AgentTask {
  id: string;
  phase: string;
  title: string;
  priority: 'High' | 'Medium' | 'Low';
  targetFiles: string[];
  dependencies: string[];
  promptInstructions: string;
  verificationSteps: string;
  /** Run by Undagi after the agent says done; the card is verified only when it exits 0. Empty: no such check. */
  verifyCommand?: string;
  acceptanceCriteria?: string;
  status?: 'todo' | 'in_progress' | 'done' | 'blocked' | 'failed';
  /** What the agent wrote at the end of its last run on this card: evidence, a blocker, or doubts. */
  agentNote?: string;
  /** The last run on this card was stopped before it finished. Cleared when the card moves or runs again. */
  runStopped?: boolean;
  /**
   * Set when a run moved the card to Done: true when its verify command passed,
   * false when only the agent's word stands. Unset when the user moved it.
   */
  verified?: boolean;
  handoffStatus?: 'handed_off';
  handedOffAt?: string;
  /** Snapshot of the PRD used to generate this task, when applicable. */
  sourcePrdVersionId?: string;
  sourcePrdVersionNumber?: number;
  sourcePrdContentHash?: string;
  /** Short aliases retained for consumers that use artifact fields directly. */
  prdVersionId?: string;
  prdVersionNumber?: number;
  prdContentHash?: string;
  syncStatus?: 'current' | 'needs_sync';
  needsSync?: boolean;
}

/**
 * A change to the open session: fields to merge, or a function that reads the
 * session as it is now and returns them (null for no change). A run that ends
 * minutes after it started needs the second form.
 */
export type SessionUpdate = Partial<ProjectSession> | ((current: ProjectSession) => Partial<ProjectSession> | null);

export interface ProjectSession {
  id: string;
  title: string;
  updatedAt: string;
  llmConfig: LLMConfig;
  input: ProjectInput;
  followUps: FollowUpQuestion[];
  plan?: ProjectPlan;
  prd?: PRDData;
  /** Version history is optional so sessions saved before V2-4 still load. */
  prdVersions?: PRDArtifactVersion[];
  tasks?: AgentTask[];
  currentStep: 1 | 2 | 3;
  // Hasil penilaian LLM pada ronde klarifikasi terakhir.
  clarificationRound?: number;
  clarificationComplete?: boolean;
  readinessNote?: string;
  // Pengguna sudah menyunting coreFeatures sendiri, tapi arsitektur, diagram,
  // roadmap, dan estimasi masih hasil generate sebelum suntingan itu. Dibersihkan
  // setelah plan diselaraskan ulang.
  planFeaturesEdited?: boolean;
  // Akar folder yang boleh disentuh tool file dan shell di chat. Kosong berarti
  // tool itu tidak ditawarkan sama sekali — disengaja, supaya tidak ada folder
  // bawaan yang ikut terjangkau tanpa pengguna memilihnya.
  workspaceRoot?: string;
  // Menjalankan perintah adalah kewenangan terpisah dari membaca dan menulis
  // berkas, jadi izinnya juga terpisah dan mati secara bawaan.
  allowShell?: boolean;
  /** Facts task runs left for later tasks (their MEMORY lines), oldest first. */
  projectMemory?: ProjectMemoryEntry[];
}

/** One fact a task run wrote for the tasks after it. */
export interface ProjectMemoryEntry {
  id: string;
  text: string;
  /** The card whose run wrote it. */
  taskId: string;
  createdAt: string;
}

// Baris riwayat dari SQLite — cukup untuk daftar, tanpa memuat payload penuh.
export interface SessionSummary {
  id: string;
  title: string;
  updatedAt: string;
  currentStep: number;
  // Folder tempat chat ini bekerja. Sidebar memakainya untuk mengelompokkan;
  // kosong berarti chat belum menunjuk folder mana pun.
  workspaceRoot?: string;
  // Hanya chat berencana yang punya Plan/PRD/Kanban di bawahnya, dan Kanban
  // ditandai kosong sampai task pertama ada.
  hasPlan?: boolean;
  taskCount?: number;
}
