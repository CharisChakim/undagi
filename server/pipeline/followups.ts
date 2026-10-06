// Copyright (c) 2026 Charis Chakim - Undagi (https://github.com/CharisChakim/undagi)
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { parseJsonFromLlm } from "../llm/json.ts";
import type { Connection } from "../llm/types.ts";
import type { Lang } from "../messages.ts";
import { msg } from "../messages.ts";
import { EXAMPLE_VALUES_NOTE, languageDirective, newAppTitle } from "./language.ts";
import { generateLlmText, type PipelineOptions } from "./llm.ts";

export interface FollowupInput {
  title?: string;
  description?: string;
  targetAudience?: string;
  techStackPreference?: string;
  previousAnswers?: Record<string, unknown>;
  round?: number;
}

// Round 1 forces this option verbatim, so it has to be in the user's language.
export const NO_AI_OPTION: Record<Lang, string> = {
  id: "Tidak perlu AI, cukup logika biasa",
  en: "No AI needed, plain logic is enough",
};

export function buildFollowupsSystemPrompt(humanLang: Lang, currentRound: number): string {
  return `You are a Lead Software Architect & Senior Product Manager.
Your task is to clarify the user's app idea/description until you are truly confident you can compose the architecture and project plan without guessing.
${languageDirective({ humanLang })}

QUESTION COUNT RULES:
- There is NO limit on the number of questions. Ask as many as you genuinely need, no more.
- This process is staged (multi-round). You will be called again along with the user's previous answers.
- If, after reading the existing answers, there is STILL a material doubt (something that would make you guess when composing the architecture, data schema, or feature priority), ask follow-up questions in this round.
- If the information is already SUFFICIENT to compose a mature plan, return "questions": [] and "needsMoreInfo": false.
- DO NOT repeat questions that have already been answered, and do not ask about things whose answer is already implied in the description.
- Do not ask just to fill a quota. One sharp question is better than five filler questions.
${
  currentRound === 1
    ? `
MANDATORY IN THIS ROUND 1:
- Include one question with the category "technical" that confirms whether this app truly needs an AI/LLM component, UNLESS the user's description already explicitly names AI as a core function.
- That question MUST have the option "${NO_AI_OPTION[humanLang]}" as one of its options.
- Do not assume the project needs AI just because this planning is AI-assisted. Many apps are better without an LLM.`
    : ""
}

${
  currentRound >= 3
    ? `
THIS IS ROUND ${currentRound}. The user has already answered several rounds. Ask again only about a gap that would make the plan wrong, not one that would only make it less detailed. If there is no such gap, return "questions": [] and "needsMoreInfo": false.
`
    : ""
}
YOU MUST INCLUDE 3 to 4 structured answer choices (options) for every question so the user can just pick with 1 click or fill in a custom answer.

Return the response EXACTLY in the following JSON format with no extra text outside the JSON. ${EXAMPLE_VALUES_NOTE}
{
  "needsMoreInfo": true,
  "readinessNote": "Short explanation: what is still missing, or why the information is already sufficient.",
  "questions": [
    {
      "id": "r${currentRound}q1",
      "category": "scope",
      "question": "Targeted question...",
      "explanation": "Reason why this question matters for development...",
      "suggestedAnswer": "Recommended answer",
      "options": [
        "Option A: Simple & Fast",
        "Option B: Comprehensive with Auth & Database",
        "Option C: Enterprise with Analytics & Multi-tenant"
      ]
    }
  ]
}

Use the prefix "r${currentRound}q" on every id so ids stay unique across rounds.`;
}

export function buildFollowupsPrompt(input: FollowupInput, humanLang: Lang): string {
  const { title, description, targetAudience, techStackPreference, previousAnswers, round } = input;
  const currentRound = Number(round) || 1;
  const priorQa =
    previousAnswers && typeof previousAnswers === "object" && Object.keys(previousAnswers).length > 0
      ? Object.entries(previousAnswers)
          .map(([q, a]) => `- ${q}\n  Answer: ${a}`)
          .join("\n")
      : "";

  return `Project Information:
Project Title: ${title || newAppTitle(humanLang)}
Project Description:
${description}
Target Users (If Any): ${targetAudience || "Not specified yet"}
Expected Tech Stack (If Any): ${techStackPreference || "Open / AI recommendation"}

This is CLARIFICATION ROUND ${currentRound}.
${
  priorQa
    ? `Questions the user ALREADY answered in previous rounds:\n${priorQa}\n\nAssess whether the answers above are sufficient. If there is still material doubt, ask follow-up questions that have NOT been asked before. If sufficient, return empty questions with needsMoreInfo: false.`
    : `There are no previous answers yet. Ask as many initial clarifying questions as you need.`
}

Answer in the JSON format that has been specified. Include the "options" field with at least 3 brief choices for every question.`;
}

export async function generateFollowups(
  input: FollowupInput,
  conn: Connection,
  model: string,
  lang: Lang,
  options?: PipelineOptions,
): Promise<any> {
  const currentRound = Number(input.round) || 1;

  if (!conn.baseUrl) throw new Error(msg(lang, "baseUrlRequired"));
  const rawText = await generateLlmText({
    prompt: buildFollowupsPrompt(input, lang),
    system: buildFollowupsSystemPrompt(lang, currentRound),
    conn,
    model,
    lang,
    ...options,
  });
  const data = parseJsonFromLlm(rawText, lang);

  const questions = (data.questions || []).map((q: any) => ({
    ...q,
    round: currentRound,
  }));

  return {
    questions,
    // Kalau LLM tidak menyebut needsMoreInfo, turunkan dari ada/tidaknya pertanyaan.
    needsMoreInfo: typeof data.needsMoreInfo === "boolean" ? data.needsMoreInfo : questions.length > 0,
    readinessNote: data.readinessNote || "",
    round: currentRound,
  };
}
