import { parseJsonFromLlm } from "../llm/json.ts";
import type { Connection } from "../llm/types.ts";
import type { Lang } from "../messages.ts";
import { msg } from "../messages.ts";
import { EXAMPLE_VALUES_NOTE, languageDirective } from "./language.ts";
import { generateLlmText, type PipelineOptions } from "./llm.ts";

export interface PlanInput {
  title?: string;
  description?: string;
  targetAudience?: string;
  techStackPreference?: string;
  answers?: Record<string, unknown>;
}

const DIAGRAM_RULES = `Critical rules for Logic / Architecture Diagrams:
- Produce HORIZONTAL Mermaid.js syntax USING 'graph LR' OR 'flowchart LR' (left to right, not vertical).
- Make sure the Mermaid syntax is VALID with no illegal characters.
- Group nodes with 'subgraph' blocks per layer (e.g. Client, Backend, Data & External Services). A flat diagram without subgraphs makes the lines cross each other.
- MAXIMUM 12 nodes. Merge similar services into one node instead of splitting them one by one.
- Label only the edges that really need explaining. Plain edges are tidier than a repeated label such as "Query" on many lines.
- Node and edge labels are user-facing text, so write them in the user-facing language. Keep Mermaid keywords, node ids and syntax exactly as Mermaid requires.`;

const AI_RULES = `Rules for AI / LLM components:
- Include an AI/LLM layer, component, service, or cost ONLY if the app's core function genuinely requires it (e.g. chatbot, automatic summarization, smart recommendations, semantic search).
- If the need for AI is not evident from the user's description and clarification answers, do NOT add an "AI Engine", a model API key, or any AI service. CRUD apps, dashboards, point-of-sale, or data management apps usually do NOT need an LLM.
- Adding AI that is not needed is a serious mistake: it raises cost, complexity, and project risk for no reason.`;

const formatAnswers = (answers: PlanInput["answers"]): string =>
  answers && typeof answers === "object"
    ? Object.entries(answers).map(([q, a]) => `- ${q}: ${a}`).join("\n")
    : "No additional answers from the follow-up.";

export function buildPlanSystemPrompt(humanLang: Lang): string {
  return `You are a leading System Architect & Enterprise Product Planner.
${languageDirective({ humanLang })}
Your task is to write a comprehensive "Project Plan & Architecture Specification" document based on the app description and the user's clarifications.

${DIAGRAM_RULES}

${AI_RULES}

Critical rules for Sub Features:
- Every feature in "coreFeatures" MUST be broken down into 2 to 6 sub features in the "subFeatures" field.
- A sub feature is a concrete part that can be worked on as a separate unit, not a repetition of the feature name.
- Keep them brief (2-4 words) like a card title, e.g. "Candlestick View", "Change Timeframe", "Configure Sync".
- Do not write long sentences or explanations in sub features.

The user only gives a one-paragraph idea; the title, target users, and stack are NOT asked through a form.
- Infer the most suitable target users and stack yourself.
- Propose a short project name (2-4 words) in the "suggestedTitle" field. Do not use the idea sentence as the title.

Return the response EXACTLY in the following JSON format with no extra text. ${EXAMPLE_VALUES_NOTE}
{
  "suggestedTitle": "Short Project Name",
  "summary": "Executive summary of the project plan...",
  "specs": {
    "targetAudience": "Description of the specific target users...",
    "keyValueProposition": "The app's main selling point...",
    "coreFeatures": [
      {
        "name": "Feature Name",
        "description": "Detailed description and function of the feature...",
        "priority": "P0", // "P0" (Required MVP), "P1" (Important), or "P2" (Optional/Later Stage)
        "subFeatures": [
          "Concrete sub feature that can be worked on separately",
          "Second sub feature",
          "Third sub feature"
        ]
      }
    ],
    "techStack": [
      {
        "layer": "Frontend / Backend / Database / Deployment (add AI Engine ONLY if the project truly needs it)",
        "technology": "Technology Name (e.g. React + Tailwind, Node.js + Express, PostgreSQL)",
        "rationale": "Reason for choosing the technology..."
      }
    ]
  },
  "architectureDraft": {
    "overview": "Description of the overall system architecture...",
    "components": [
      {
        "name": "Component Name",
        "purpose": "Purpose of the component...",
        "type": "Client UI / REST API / Background Worker / Database / Service"
      }
    ],
    "dataFlow": "Explanation of the main data flow from the client to the server down to persistent storage...",
    "securityAndAuth": "Security, encryption, and authentication strategy...",
    "diagramMermaid": "graph LR\\n  subgraph Client\\n    UI[User Interface]\\n  end\\n  subgraph Backend\\n    API[Application Server]\\n    Worker[Background Worker]\\n  end\\n  subgraph Data\\n    DB[(Database)]\\n    Files[(Object Storage)]\\n  end\\n  UI -->|REST| API\\n  API --> Worker\\n  API --> DB\\n  Worker --> DB\\n  API --> Files"
  },
  "roadmap": [
    {
      "phase": "Phase 1",
      "title": "MVP Setup & Core Mechanics",
      "duration": "1-2 weeks",
      "deliverables": [
        "Repository initialization & configuration",
        "Initial database schema",
        "Basic UI implementation"
      ]
    }
  ],
  "estimation": {
    "totalTimeWeeks": "4-6 weeks",
    "complexityLevel": "medium", // exactly one of "low", "medium", "high", "very_high"
    "requiredResources": [
      "1 Frontend Developer",
      "1 Backend Engineer",
      "Hosting & domain"
    ],
    "potentialRisks": [
      {
        "risk": "Description of the technical/scope risk...",
        "mitigation": "Preventive step/solution..."
      }
    ]
  }
}`;
}

export function buildPlanPrompt(input: PlanInput): string {
  const { title, description, targetAudience, techStackPreference, answers } = input;
  return `The user's idea:
${description}
${title ? `\nTemporary name used by the system: ${title} (replace it with your own proposal in "suggestedTitle")` : ""}
${targetAudience ? `Target Users: ${targetAudience}` : ""}
${techStackPreference ? `Preferred Technology: ${techStackPreference}` : ""}

Additional Answers & Clarifications from the User:
${formatAnswers(answers)}

Create a mature, efficient Project Plan & Application Architecture that includes a HORIZONTAL diagram (graph LR).
Infer the target users and stack yourself if they are not mentioned above.
Every feature MUST have "subFeatures" containing 2-6 brief breakdowns. Answer in the JSON format according to the schema.`;
}

// Mode penyelarasan ulang. Meminta model menyalin ulang coreFeatures terbukti
// gagal: selama bidang itu ada di skema contoh, model kecil mengisinya dengan
// fitur karangannya sendiri lalu merancang arsitektur untuk fitur itu. Maka
// di sini coreFeatures dihapus dari skema — model hanya diminta menurunkan
// bagian lain, dan daftar fitur dipasang kembali oleh server.
export function buildPlanResyncSystemPrompt(lockedFeatures: unknown[], humanLang: Lang): string {
  return `You are a leading System Architect & Enterprise Product Planner.
${languageDirective({ humanLang })}
The feature list of this application is ALREADY FINAL and set by the user. You are NOT asked to compose, evaluate, add to, or change the feature list.
Your task is ONLY to derive the architecture, stack, roadmap, and estimation that serve EXACTLY the following features:

${JSON.stringify(lockedFeatures, null, 2)}

You are forbidden from designing components, roadmap phases, technologies, or costs for capabilities that are not in the feature list above.

${DIAGRAM_RULES}

${AI_RULES}

Return the response EXACTLY in the following JSON format with no extra text. Note: there is NO "coreFeatures" field in this schema. ${EXAMPLE_VALUES_NOTE}
{
  "suggestedTitle": "Short Project Name",
  "summary": "Executive summary of the project plan...",
  "specs": {
    "targetAudience": "Description of the specific target users...",
    "keyValueProposition": "The app's main selling point...",
    "techStack": [
      { "layer": "Frontend", "technology": "Technology Name", "rationale": "Reason for choosing..." }
    ]
  },
  "architectureDraft": {
    "overview": "Description of the overall system architecture...",
    "components": [
      { "name": "Component Name", "purpose": "Purpose of the component...", "type": "Client UI / REST API / Background Worker / Database / Service" }
    ],
    "dataFlow": "Explanation of the main data flow...",
    "securityAndAuth": "Security and authentication strategy...",
    "diagramMermaid": "graph LR\\n  subgraph Client\\n    UI[User Interface]\\n  end\\n  subgraph Backend\\n    API[Application Server]\\n  end\\n  subgraph Data\\n    DB[(Database)]\\n  end\\n  UI -->|REST| API\\n  API --> DB"
  },
  "roadmap": [
    { "phase": "Phase 1", "title": "Phase title", "duration": "1-2 weeks", "deliverables": ["..."] }
  ],
  "estimation": {
    "totalTimeWeeks": "4-6 weeks",
    "complexityLevel": "medium", // exactly one of "low", "medium", "high", "very_high"
    "requiredResources": ["1 Frontend Developer", "1 Backend Engineer"],
    "potentialRisks": [{ "risk": "...", "mitigation": "..." }]
  }
}`;
}

export function buildPlanResyncPrompt(input: PlanInput): string {
  const { description, targetAudience, techStackPreference, answers } = input;
  return `Context of the user's original idea:
${description}
${targetAudience ? `Target Users: ${targetAudience}` : ""}
${techStackPreference ? `Preferred Technology: ${techStackPreference}` : ""}

Additional Answers & Clarifications from the User:
${formatAnswers(answers)}

The feature list is final (it is in the system instructions). Compose the architecture, techStack, roadmap, and estimation that serve exactly those features.
Do not output the "coreFeatures" field. Answer in the JSON format according to the schema.`;
}

export async function generatePlan(
  input: PlanInput,
  conn: Connection,
  model: string,
  lang: Lang,
  lockedFeatures?: unknown[],
  options?: PipelineOptions,
): Promise<any> {
  const hasLock = Array.isArray(lockedFeatures) && lockedFeatures.length > 0;

  if (!conn.baseUrl) throw new Error(msg(lang, "baseUrlRequired"));
  const rawText = hasLock
    ? await generateLlmText({
        prompt: buildPlanResyncPrompt(input),
        system: buildPlanResyncSystemPrompt(lockedFeatures, lang),
        conn,
        model,
        lang,
        ...options,
      })
    : await generateLlmText({
        prompt: buildPlanPrompt(input),
        system: buildPlanSystemPrompt(lang),
        conn,
        model,
        lang,
        ...options,
      });
  const data = parseJsonFromLlm(rawText, lang);

  // Daftar fitur tidak pernah datang dari model saat mode terkunci.
  if (hasLock) {
    data.specs = { ...(data.specs || {}), coreFeatures: lockedFeatures };
  }

  // Sub fitur menopang kolom ketiga kanvas struktur, jadi bentuknya dipastikan
  // di sini: selalu array string non-kosong, apa pun yang dikirim LLM.
  if (Array.isArray(data?.specs?.coreFeatures)) {
    data.specs.coreFeatures = data.specs.coreFeatures.map((f: any) => ({
      ...f,
      subFeatures: (Array.isArray(f?.subFeatures) ? f.subFeatures : [])
        .map((s: any) => (typeof s === "string" ? s.trim() : String(s?.name ?? s ?? "").trim()))
        .filter((s: string) => s.length > 0),
    }));
  }

  return data;
}
