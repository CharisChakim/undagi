// Shared by the server module and the browser client (imported with `import type`,
// so nothing here may pull in Node or DOM APIs).

export const JEV_FEATURES = ["intentRouting", "intakeCheck", "permissionRisk", "dependencyCheck"] as const;
export type JevFeature = (typeof JEV_FEATURES)[number];

/** What the browser may know: never the key itself. */
export interface JevSettingsPublic {
  enabled: boolean;
  hasKey: boolean;
  features: Record<JevFeature, boolean>;
}

/** Patch for PUT /api/jev/settings. `apiKey`: omitted/null keeps it, "" removes it, a string replaces it. */
export interface JevSettingsPatch {
  enabled?: boolean;
  apiKey?: string | null;
  features?: Partial<Record<JevFeature, boolean>>;
}

export type JevIntent = "plan_project" | "generate_prd" | "generate_tasks" | "run_task" | "chat";

export interface IntentAdvice {
  intent: JevIntent;
  /** 0..1, from the model's probability distribution. */
  confidence: number;
}

export interface IntakeAdvice {
  /** Probability (0..1) that the description already holds enough to write a plan. */
  ready: number;
  /** 0 = vague, 1 = workable, 2 = detailed. Can land between levels. */
  clarity: number;
}

export type ApprovalRisk = "low" | "medium" | "high";

export interface ApprovalAdvice {
  risk: ApprovalRisk;
  /** 0..2 rubric value the risk band was derived from. */
  score: number;
  /** 0..1 */
  confidence: number;
}

/** `taskId` probably needs `dependsOn` to be finished first. Advisory only. */
export interface DependencyAdvice {
  taskId: string;
  dependsOn: string;
  probability: number;
}

export interface JevTaskInput {
  id: string;
  title: string;
  targetFiles?: string[];
  dependencies: string[];
  promptInstructions?: string;
}

/** SSE event sent after `approval_request`, keyed by the same approvalId. */
export interface ApprovalAdviceEvent extends ApprovalAdvice {
  approvalId: string;
  elicitId?: string;
}
