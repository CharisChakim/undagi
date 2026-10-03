import { parseJsonFromLlm } from "../llm/json.ts";
import type { Connection } from "../llm/types.ts";
import type { Lang } from "../messages.ts";
import { additionalPointTitle, EXAMPLE_VALUES_NOTE, languageDirective } from "./language.ts";
import { prdSections, renderPrdMarkdown } from "../../shared/prdMarkdown.ts";
import { generateLlmText, type PipelineOptions } from "./llm.ts";

export function buildPrdSystemPrompt(humanLang: Lang): string {
  return `You are an experienced product manager who writes lean, MVP-first PRDs, working with a software architect on the technical part.
${languageDirective({ humanLang })}
Your task is to write a Product Requirements Document (PRD) with these sections:

Product part (what to build and why):
1. Overview: the problem (who has it, how often, what it costs them today) and the proposed solution.
2. Goals & success metrics: what the first release must achieve, each goal with a metric and a target.
3. Target users: who uses it and what they need from it.
4. Scope & release plan: features per phase (Phase 1 is the MVP) and an explicit out-of-scope list (non-goals).
5. Requirements: functional requirements as user stories with acceptance criteria, and non-functional requirements.
6. User flow: the main path through the app, with a diagram.
7. Assumptions, risks & open questions.

Technical part (how to build it, read by the coding agent):
8. Architecture
9. Data model
10. Tech stack

Size and scope rules:
- Scale the document to the project. A personal tool, a research prototype or a small internal app gets a short PRD; only a large multi-team product needs a long one. Never pad a section to look complete.
- Phase 1 is the smallest release that is useful on its own. Write functional requirements for Phase 1 only; later phases stay one line per feature in "coreFeatures" and get their requirements when they are planned.
- One functional requirement per user-visible capability, usually 4 to 10. Each has 2 to 4 acceptance criteria that a test or a person can check.
- "nonGoals" names what this release deliberately does not do, so nobody builds it by accident. Usually 3 to 8 items.
- Goals: 1 to 4. Target users: 1 to 3. Non-functional requirements: only those that constrain the build, usually 2 to 6. Assumptions and risks: the 2 to 5 that matter most each. Open questions: only real unknowns the user must decide; leave the list empty when there are none.
- The data model holds only the entities Phase 1 needs, with a short description per field.
- Write requirements, metrics and criteria for this project; avoid generic filler such as "the app must be user-friendly".

Extra sections (optional):
- Add a section through "additionalSections" only for something this project truly needs that the sections above do not cover, such as Third-Party Integrations, Data Migration, Compliance & Regulation, or a Permission/Role Model. At most 3. Usually none: return "additionalSections": [].

Special rules for the Mermaid.js Logic Diagram:
- Use a HORIZONTAL DIAGRAM with 'graph LR' or 'flowchart LR' syntax (left to right).
- Make sure the Mermaid syntax is VALID with no illegal characters.
- Node and edge labels are user-facing text, so write them in the user-facing language. Keep Mermaid keywords, node ids and syntax exactly as Mermaid requires.

Return the response EXACTLY in the following JSON format. ${EXAMPLE_VALUES_NOTE}
{
  "projectTitle": "Project Title",
  "overview": "Shop owners lose track of stock because they count it on paper once a week... The app lets them...",
  "goals": [
    { "goal": "The owner knows what to reorder", "metric": "Low-stock items noticed before they run out", "target": "9 out of 10 within the first month" }
  ],
  "targetUsers": [
    { "name": "Shop owner", "description": "Runs one small shop alone and records stock on a phone between customers." }
  ],
  "nonGoals": ["Online payments", "More than one shop per account"],
  "coreFeatures": {
    "phase1": ["MVP feature 1", "MVP feature 2"],
    "phase2": ["Next feature"],
    "phase3": [],
    "futurePhases": []
  },
  "requirements": {
    "functional": [
      {
        "id": "FR-01",
        "title": "Record a delivery",
        "userStory": "As a shop owner, I want to record a delivery in a few taps so that the stock count stays right.",
        "priority": "Must", // "Must", "Should", or "Could"
        "acceptanceCriteria": ["Saving a delivery of 10 units raises the item's stock by 10", "A quantity of zero or less is rejected with a message"]
      }
    ],
    "nonFunctional": [
      { "category": "Performance", "specification": "The stock list opens in under 2 seconds with 1,000 items" }
    ]
  },
  "userFlow": "Main path: open the app -> ... -> ...",
  "logicFlowMermaid": "graph LR\\n  A[Owner] -->|1. Open app| B[Stock list]\\n  B -->|2. Record delivery| C[Delivery form]\\n  C -->|3. Save| B",
  "logicFlowExplanation": "Explanation of the horizontal diagram flow from left to right...",
  "assumptions": ["The owner has a phone with a browser"],
  "risks": [{ "risk": "Counts drift when sales are not recorded", "mitigation": "A weekly stock check screen" }],
  "openQuestions": [],
  "architecture": "Explanation of the architecture for Phase 1: parts, how they talk, where data lives...",
  "databaseSchema": [
    {
      "entity": "Products",
      "fields": [
        { "name": "id", "type": "UUID", "description": "Primary key" },
        { "name": "stock", "type": "INTEGER", "description": "Units on hand" }
      ]
    }
  ],
  "techStack": [
    { "layer": "Frontend", "technology": "React + Vite", "rationale": "Short reason for this project" }
  ],
  "additionalSections": [
    { "number": 11, "title": "Third-Party Integrations", "content": "Content in text/markdown. Leave this array empty unless the project truly needs it." }
  ]
}`;
}

export function buildPrdPrompt(title: string, plan: any, description = ""): string {
  return `Approved Project Plan data:
Title: ${title}
Description / product brief: ${description || "Not available yet"}
Plan Summary: ${plan?.summary || ""}
Target Users: ${plan?.specs?.targetAudience || ""}
Value Proposition: ${plan?.specs?.keyValueProposition || ""}
Core Features: ${JSON.stringify(plan?.specs?.coreFeatures || [])}
Tech Stack: ${JSON.stringify(plan?.specs?.techStack || [])}
Architecture: ${JSON.stringify(plan?.architectureDraft || {})}
Known Risks: ${JSON.stringify(plan?.estimation?.potentialRisks || [])}

Write the PRD with every section, sized to this project, along with a horizontal diagram (graph LR), in the requested JSON format.
Phase 1 is the MVP: only it gets functional requirements. Add "additionalSections" only if truly necessary. Do not write the document a second time as Markdown: the JSON fields are the whole answer.`;
}

export async function generatePrd(
  title: string,
  plan: any,
  conn: Connection,
  model: string,
  lang: Lang,
  options?: PipelineOptions,
  description = "",
): Promise<any> {
  const rawText = await generateLlmText({
    prompt: buildPrdPrompt(title, plan, description),
    system: buildPrdSystemPrompt(lang),
    conn,
    model,
    lang,
    ...options,
  });
  const data = parseJsonFromLlm(rawText, lang);

  // Ensure fallback properties for legacy component support if needed
  data.executiveSummary = data.executiveSummary || data.overview;
  data.functionalRequirements = data.functionalRequirements || data.requirements?.functional || [];
  data.nonFunctionalRequirements = data.nonFunctionalRequirements || data.requirements?.nonFunctional || [];
  data.dataSchema = data.dataSchema || data.databaseSchema || [];

  // Extra sections: drop empty ones and number them on from the standard sections.
  const first = prdSections(data).length + 1;
  data.additionalSections = (Array.isArray(data.additionalSections) ? data.additionalSections : [])
    .filter((s: any) => s && (s.title || s.content))
    .map((s: any, idx: number) => ({
      number: first + idx,
      title: s.title || additionalPointTitle(lang, first + idx),
      content: typeof s.content === "string" ? s.content : String(s.content ?? ""),
    }));

  // Written here from the fields, not by the model: asking for it too doubled
  // the length of every PRD. It overwrites one the model sends anyway, so the
  // document always matches the fields.
  data.fullMarkdownText = renderPrdMarkdown(data, lang);

  return data;
}
