import type { Lang } from "../messages.ts";

export interface AgentHarnessSettings {
  compactTerminal: boolean;
  conciseAnswers: boolean;
  minimalCode: boolean;
  karpathyGuidelines: boolean;
}

export const DEFAULT_AGENT_HARNESS_SETTINGS: AgentHarnessSettings = {
  compactTerminal: true,
  conciseAnswers: true,
  minimalCode: true,
  karpathyGuidelines: true,
};

export function parseAgentHarnessSettings(value: unknown): AgentHarnessSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) return DEFAULT_AGENT_HARNESS_SETTINGS;
  const settings = value as Record<string, unknown>;
  return {
    compactTerminal: settings.compactTerminal !== false,
    conciseAnswers: settings.conciseAnswers !== false,
    minimalCode: settings.minimalCode !== false,
    karpathyGuidelines: settings.karpathyGuidelines !== false,
  };
}

export interface AgentHarnessOptions {
  /** The run belongs to a task card on the board. */
  task?: boolean;
  /** The UI language; the card's note is written in it. Missing means no instruction. */
  noteLang?: Lang;
}

const LANGUAGE_NAME: Record<Lang, string> = { en: "English", id: "Indonesian" };

// Not a setting: the board moves the card on this line, so it joins the harness
// block exactly when a card is attached, whichever layers are switched off.
// Keep the marker in sync with src/lib/taskOutcome.ts, which reads it.
// The note is read in the UI, so it follows the UI language, whatever language the
// runtime's own configuration (the user's CLAUDE.md, say) asks for in a chat.
function taskReport(noteLang?: Lang): string {
  const language = noteLang
    ? ` Write the note in ${LANGUAGE_NAME[noteLang]}; the TASK_STATUS line stays exactly as written.`
    : "";
  return `Task report:
- This run works on one task card. End your final message with one line: \`TASK_STATUS: done\` if the task is complete and its verification steps passed, or \`TASK_STATUS: blocked\` if you could not finish it.
- Above that line, write a short note for the card: the evidence that it works, what blocked you, or anything you are not sure about.${language}`;
}

export function agentHarnessPrompt(settings: AgentHarnessSettings, options: AgentHarnessOptions = {}): string {
  const sections: string[] = [];
  // Ketiga lapis efisiensi dinyalakan terpisah, jadi judulnya ditulis sekali
  // dan hanya bullet yang aktif menyusul. Menyalakan satu lapis tidak boleh
  // membawa instruksi dua lapis lainnya.
  const efficiency: string[] = [];
  if (settings.compactTerminal) {
    efficiency.push(
      "- Terminal: use targeted commands, search with rg first, filter or cap long output, and summarize logs instead of dumping them."
    );
  }
  if (settings.conciseAnswers) {
    efficiency.push(
      "- Answers: address only the request; omit preambles, repetition, and unsolicited alternatives. Preserve exact code, commands, paths, numbers, negation, uncertainty, and safety warnings."
    );
  }
  if (settings.minimalCode) {
    efficiency.push(
      "- Code: implement the minimum correct change. Avoid speculative abstractions, dependencies, files, and rewrites."
    );
  }
  if (efficiency.length) {
    sections.push(`Efficiency stack:\n${efficiency.join("\n")}`);
  }
  if (settings.karpathyGuidelines) {
    sections.push(`Karpathy coding guidelines:
- Before non-trivial coding, state brief Assumptions, Scope, and Done when criteria.
- Ask when harmful ambiguity remains. Prefer the simplest solution and a surgical diff.
- Do not reformat or clean unrelated code. Verify the requested outcome and report concrete evidence.`);
  }
  if (options.task) sections.push(taskReport(options.noteLang));
  return sections.join("\n\n");
}

export function applyAgentHarness(message: string, settings: AgentHarnessSettings, options: AgentHarnessOptions = {}): string {
  const prompt = agentHarnessPrompt(settings, options);
  if (!prompt) return message;
  return `<agent_harness>\n${prompt}\n</agent_harness>\n\n<user_request>\n${message}\n</user_request>`;
}
