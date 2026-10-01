import { parseJsonFromLlm } from "../llm/json.ts";
import type { Connection } from "../llm/types.ts";
import type { Lang } from "../messages.ts";
import { additionalPointTitle, EXAMPLE_VALUES_NOTE, languageDirective } from "./language.ts";
import { generateLlmText, type PipelineOptions } from "./llm.ts";

export function buildPrdSystemPrompt(humanLang: Lang): string {
  return `You are an experienced Technical Product Manager & Software Architect.
${languageDirective({ humanLang })}
Your task is to produce a detailed, structured Product Requirement Document (PRD) that MUST cover the following 7 MAIN POINTS:

PRD - Project Requirements Document
1. Overview
2. Requirements (Functional Requirements & Non-Functional Requirements)
3. Core Features (MUST be divided per phase: Phase 1, Phase 2, Phase 3, and Later Phases if any)
4. User Flow
5. Architecture (Including an explanation of the architecture)
6. Database Schema
7. Tech Stack

ADDITIONAL POINTS (OPTIONAL, BEYOND THE 7 MANDATORY POINTS):
- The seven points above are a minimum floor, not a ceiling.
- If, after analyzing this project, you judge there is an important aspect not covered by those 7 points, ADD it as point 8, 9, and so on through the "additionalSections" field.
- Examples of additional points that are often relevant: Third-Party Integrations, Data Migration Strategy, Observability & Monitoring, Compliance & Regulation, Testing Plan, Deployment & Rollback Strategy, User Permission/Role Model.
- Only add points the project truly needs. Do not add points just to make the document look complete. If the 7 points are sufficient, return "additionalSections": [].
- Every additional point MUST also be written in "fullMarkdownText" with the same sequence number.

Special rules for the Mermaid.js Logic Diagram:
- Use a HORIZONTAL DIAGRAM with 'graph LR' or 'flowchart LR' syntax (left to right).
- Make sure the Mermaid syntax is VALID with no illegal characters.
- Node and edge labels are user-facing text, so write them in the user-facing language. Keep Mermaid keywords, node ids and syntax exactly as Mermaid requires.

Return the response EXACTLY in the following JSON format. ${EXAMPLE_VALUES_NOTE}
{
  "projectTitle": "Project Title",
  "overview": "General explanation of the background, vision, and main goals of the project...",
  "requirements": {
    "functional": [
      {
        "id": "FR-01",
        "category": "Authentication",
        "description": "Users can log in using OAuth or email",
        "acceptanceCriteria": ["Active email validation", "Redirect to Dashboard"]
      }
    ],
    "nonFunctional": [
      {
        "category": "Performance",
        "specification": "API response time < 300ms for 95% of requests"
      }
    ]
  },
  "coreFeatures": {
    "phase1": ["MVP Feature 1", "MVP Feature 2"],
    "phase2": ["Advanced Feature 1", "Advanced Feature 2"],
    "phase3": ["Integration & Analytics Features"],
    "futurePhases": ["Mobile App", "Multi-language Support"]
  },
  "userFlow": "User interaction steps from Landing Page -> Auth -> Dashboard -> Main -> Output...",
  "architecture": "Explanation of the client-server architecture structure, API proxy, and state management...",
  "databaseSchema": [
    {
      "entity": "Users",
      "fields": [
        { "name": "id", "type": "UUID", "description": "Primary key" },
        { "name": "email", "type": "VARCHAR(255)", "description": "Unique user email" }
      ]
    }
  ],
  "techStack": [
    {
      "layer": "Frontend",
      "technology": "React + Vite + Tailwind CSS",
      "rationale": "Fast, modern, and responsive UI"
    }
  ],
  "additionalSections": [
    {
      "number": 8,
      "title": "Third-Party Integrations",
      "content": "Content of the additional point in text/markdown. Leave this array empty if the 7 points are sufficient."
    }
  ],
  "logicFlowMermaid": "graph LR\\n  A[User] -->|1. Open App| B[Landing Page]\\n  B -->|2. Enter Idea| C[Plan Generator]\\n  C -->|3. Confirm| D[PRD & Diagram Review]\\n  D -->|4. Build| E[AI Agent Tasks]",
  "logicFlowExplanation": "Explanation of the horizontal diagram flow from left to right...",
  "fullMarkdownText": "# PRD - Project Requirements Document\\n\\n## 1. Overview\\n...\\n\\n## 2. Requirements\\n...\\n\\n## 3. Core Features\\n- **Phase 1**:\\n  - ...\\n- **Phase 2**:\\n  - ...\\n- **Phase 3**:\\n  - ...\\n\\n## 4. User Flow\\n...\\n\\n## 5. Architecture\\n...\\n\\n## 6. Database Schema\\n...\\n\\n## 7. Tech Stack\\n...\\n\\n## 8. (Additional point, if any)\\n..."
}`;
}

export function buildPrdPrompt(title: string, plan: any, description = ""): string {
  return `Approved Project Plan data:
Title: ${title}
Description / product brief: ${description || "Not available yet"}
Plan Summary: ${plan?.summary || ""}
Core Features: ${JSON.stringify(plan?.specs?.coreFeatures || [])}
Tech Stack: ${JSON.stringify(plan?.specs?.techStack || [])}
Architecture: ${JSON.stringify(plan?.architectureDraft || {})}

Compose a PRD document that MUST fully cover the 7 standard points, along with a horizontal diagram (graph LR), in the requested JSON format.
After composing the 7 mandatory points, assess whether this project needs additional points (8, 9, etc.). Add them through "additionalSections" only if truly necessary, and make sure they are also written in "fullMarkdownText".`;
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

  // Poin tambahan: buang yang kosong dan beri nomor urut lanjutan dari 7.
  data.additionalSections = (Array.isArray(data.additionalSections) ? data.additionalSections : [])
    .filter((s: any) => s && (s.title || s.content))
    .map((s: any, idx: number) => ({
      number: Number(s.number) > 7 ? Number(s.number) : 8 + idx,
      title: s.title || additionalPointTitle(lang, 8 + idx),
      content: typeof s.content === "string" ? s.content : String(s.content ?? ""),
    }));

  return data;
}
