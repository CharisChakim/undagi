import type { Lang } from "../messages.ts";

export type { Lang };

const LANGUAGE_NAME: Record<Lang, string> = { en: "English", id: "Indonesian" };

// The request body picks who reads the agent-facing text: "ui" follows the
// interface language, anything else (missing, invalid) stays English because
// coding agents work best from English instructions.
export const agentLangOf = (req: any, humanLang: Lang): Lang =>
  req.body?.agentLanguage === "ui" ? humanLang : "en";

export interface LanguageDirectiveOptions {
  humanLang: Lang;
  agentLang?: Lang;
  /** JSON keys whose values a coding agent reads. Without any, the agent sentence is left out. */
  agentFields?: string[];
}

// The one block that tells the model which language each kind of value uses.
// Prompt scaffolding stays English; only this block names the output language.
export function languageDirective({ humanLang, agentLang = "en", agentFields }: LanguageDirectiveOptions): string {
  const sentences = [
    `Write user-facing text values (names, titles, summaries, descriptions, questions, rationale…) in ${LANGUAGE_NAME[humanLang]}.`,
  ];
  if (agentFields?.length) {
    sentences.push(`Write coding-agent-facing values (${agentFields.join(", ")}) in ${LANGUAGE_NAME[agentLang]}.`);
  }
  sentences.push("Keep JSON keys, enum values, identifiers, file paths, code and commands exactly as specified, never translated.");
  return sentences.join(" ");
}

// The JSON examples in the prompts are written in English, so say outright that
// they only show the shape and are not the language to answer in.
export const EXAMPLE_VALUES_NOTE =
  "The example text values in the JSON below only illustrate the shape; write your own values in the language assigned to each field above.";

// Fallbacks written into saved data follow the interface language, not the model's.
export const newAppTitle = (lang: Lang): string => (lang === "id" ? "Aplikasi Baru" : "New App");

export const additionalPointTitle = (lang: Lang, number: number): string =>
  `${lang === "id" ? "Poin Tambahan" : "Additional point"} ${number}`;
