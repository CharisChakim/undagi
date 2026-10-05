import { prefs } from "./prefs";

export interface AgentHarnessSettings {
  compactTerminal: boolean;
  conciseAnswers: boolean;
  minimalCode: boolean;
  karpathyGuidelines: boolean;
  // Bahasa teks yang ditulis untuk agen koding (promptInstructions,
  // verificationSteps). Mati = Inggris; hanya terkirim ke server sebagai
  // `agentLanguage`, tidak dipakai oleh server/agent/harness.ts.
  agentInstructionsFollowUi: boolean;
}

const STORAGE_KEY = "ai_plan_architect_agent_harness_v1";

export const DEFAULT_AGENT_HARNESS_SETTINGS: AgentHarnessSettings = {
  compactTerminal: true,
  conciseAnswers: true,
  minimalCode: true,
  karpathyGuidelines: true,
  agentInstructionsFollowUi: false,
};

export type AgentLanguage = "ui" | "en";

export function agentLanguageFor(settings: Pick<AgentHarnessSettings, "agentInstructionsFollowUi">): AgentLanguage {
  return settings.agentInstructionsFollowUi ? "ui" : "en";
}

export function loadAgentHarnessSettings(): AgentHarnessSettings {
  try {
    const saved = JSON.parse(prefs.get(STORAGE_KEY) || "null");
    // Versi sebelumnya menyimpan satu tombol `efficiencyStack` untuk ketiga
    // lapis sekaligus. Kalau pengguna sengaja mematikannya, pilihan itu
    // dihormati — tanpa ini token yang sudah ia tolak diam-diam menyala lagi.
    const legacyOff = saved?.efficiencyStack === false;
    const layer = (value: unknown) => (value === undefined ? !legacyOff : value !== false);
    return {
      compactTerminal: layer(saved?.compactTerminal),
      conciseAnswers: layer(saved?.conciseAnswers),
      minimalCode: layer(saved?.minimalCode),
      karpathyGuidelines: saved?.karpathyGuidelines !== false,
      // Kebalikan dari tombol lain: default mati, jadi hanya `true` yang menyalakan.
      agentInstructionsFollowUi: saved?.agentInstructionsFollowUi === true,
    };
  } catch (error) {
    console.warn("Failed to load agent harness settings:", error);
    return DEFAULT_AGENT_HARNESS_SETTINGS;
  }
}

export function saveAgentHarnessSettings(settings: AgentHarnessSettings): void {
  try {
    prefs.set(STORAGE_KEY, JSON.stringify(settings));
  } catch (error) {
    console.warn("Failed to save agent harness settings:", error);
  }
}
