// Copyright (c) 2026 Charis Chakim - Undagi (https://github.com/CharisChakim/undagi)
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

// The PRD's Markdown document, written from its structured fields. The model used
// to be asked for this as well as the fields, so every PRD was written twice and
// took twice as long. Server and client share this one writer: the server
// fills `fullMarkdownText` after parsing, and the client refills it after an edit.

export type PrdLang = "en" | "id";

// Sections in document order. The product part says what to build and why; the
// technical part says how, for the coding agent. Industry PRDs keep the second
// part in a separate design doc; here it travels along because the task
// generator needs it.
export const PRD_SECTIONS = [
  "overview",
  "goals",
  "users",
  "scope",
  "requirements",
  "userFlow",
  "risks",
  "architecture",
  "dataModel",
  "techStack",
] as const;

export type PrdSectionKey = (typeof PRD_SECTIONS)[number];

export const TECHNICAL_SECTIONS: readonly PrdSectionKey[] = ["architecture", "dataModel", "techStack"];

const HEADINGS: Record<PrdLang, Record<string, string>> = {
  en: {
    document: "PRD - Project Requirements Document",
    overview: "Overview",
    goals: "Goals & Success Metrics",
    users: "Target Users",
    scope: "Scope & Release Plan",
    requirements: "Requirements",
    userFlow: "User Flow",
    risks: "Assumptions, Risks & Open Questions",
    architecture: "Architecture",
    dataModel: "Data Model",
    techStack: "Tech Stack",
    functional: "Functional requirements",
    nonFunctional: "Non-functional requirements",
    acceptance: "Acceptance criteria",
    phase1: "Phase 1 (MVP)",
    phase2: "Phase 2",
    phase3: "Phase 3",
    later: "Later phases",
    outOfScope: "Out of scope (non-goals)",
    assumptions: "Assumptions",
    riskList: "Risks",
    openQuestions: "Open questions",
    goal: "Goal",
    metric: "Metric",
    target: "Target",
    risk: "Risk",
    mitigation: "Mitigation",
    field: "Field",
    type: "Type",
    description: "Description",
    layer: "Layer",
    technology: "Technology",
    rationale: "Rationale",
  },
  id: {
    document: "PRD - Dokumen Kebutuhan Proyek",
    overview: "Gambaran Umum",
    goals: "Tujuan & Metrik Keberhasilan",
    users: "Target Pengguna",
    scope: "Lingkup & Rencana Rilis",
    requirements: "Kebutuhan",
    userFlow: "Alur Pengguna",
    risks: "Asumsi, Risiko & Pertanyaan Terbuka",
    architecture: "Arsitektur",
    dataModel: "Model Data",
    techStack: "Tech Stack",
    functional: "Kebutuhan fungsional",
    nonFunctional: "Kebutuhan non-fungsional",
    acceptance: "Kriteria penerimaan",
    phase1: "Fase 1 (MVP)",
    phase2: "Fase 2",
    phase3: "Fase 3",
    later: "Fase lanjutan",
    outOfScope: "Di luar lingkup (non-goals)",
    assumptions: "Asumsi",
    riskList: "Risiko",
    openQuestions: "Pertanyaan terbuka",
    goal: "Tujuan",
    metric: "Metrik",
    target: "Target",
    risk: "Risiko",
    mitigation: "Mitigasi",
    field: "Bidang",
    type: "Tipe",
    description: "Keterangan",
    layer: "Lapisan",
    technology: "Teknologi",
    rationale: "Alasan",
  },
};

/** The section headings in `lang`, for views that show the PRD without its Markdown. */
export const prdHeadings = (lang: PrdLang): Record<string, string> => HEADINGS[lang] ?? HEADINGS.en;

type Loose = Record<string, unknown>;

const record = (value: unknown): Loose | null =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Loose : null;

const text = (value: unknown): string => {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number") return String(value);
  return "";
};

const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

/** The first of `keys` that holds text. */
const pick = (item: Loose, ...keys: string[]): string => {
  for (const key of keys) {
    const value = text(item[key]);
    if (value) return value;
  }
  return "";
};

const filled = (value: unknown): boolean =>
  typeof value === "string" ? value.trim() !== "" : list(value).length > 0;

// PRDs written before these sections existed do not have them. They are left
// out of such a PRD instead of shown empty.
const NEWER_SECTIONS: Partial<Record<PrdSectionKey, (prd: Loose) => boolean>> = {
  goals: (prd) => filled(prd.goals),
  users: (prd) => filled(prd.targetUsers),
  risks: (prd) => filled(prd.assumptions) || filled(prd.risks) || filled(prd.openQuestions),
};

/** The sections this PRD shows, in order. */
export function prdSections(prd: unknown): PrdSectionKey[] {
  const source = record(prd) ?? {};
  return PRD_SECTIONS.filter((key) => NEWER_SECTIONS[key]?.(source) ?? true);
}

const cell = (value: unknown): string => text(value).replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " ");

function table(header: string[], rows: string[][]): string[] {
  if (rows.length === 0) return [];
  return [
    `| ${header.join(" | ")} |`,
    `| ${header.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.join(" | ")} |`),
    "",
  ];
}

/** A list the user may have edited into plain text, which then passes through. */
function bullets(value: unknown, item: (entry: Loose) => string = (entry) => pick(entry, "text", "title")): string[] {
  if (typeof value === "string") return value.trim() ? [value.trim(), ""] : [];
  const lines = list(value).flatMap((entry) => {
    const line = record(entry) ? item(entry as Loose) : text(entry);
    return line ? [`- ${line}`] : [];
  });
  return lines.length > 0 ? [...lines, ""] : [];
}

function goalsBlock(value: unknown, h: Record<string, string>): string[] {
  if (typeof value === "string") return [value.trim(), ""];
  const rows: string[][] = [];
  const plain: string[] = [];
  for (const item of list(value)) {
    const entry = record(item);
    if (entry) rows.push([cell(entry.goal), cell(entry.metric), cell(entry.target)]);
    else if (text(item)) plain.push(`- ${text(item)}`);
  }
  const lines = table([h.goal, h.metric, h.target], rows);
  if (plain.length > 0) lines.push(...plain, "");
  return lines;
}

const userLine = (entry: Loose): string => {
  const name = pick(entry, "name", "role");
  const description = pick(entry, "description", "needs", "goal");
  return [name && `**${name}**${description ? ":" : ""}`, description].filter(Boolean).join(" ");
};

function requirementsBlock(value: unknown, h: Record<string, string>): string[] {
  // After the user edits the requirements they are free text; before, a pair of lists.
  if (typeof value === "string") return [value.trim(), ""];
  const source = record(value);
  const functional = list(source ? source.functional : value);
  const nonFunctional = list(source?.nonFunctional);
  const lines: string[] = [];

  if (functional.length > 0) {
    lines.push(`### ${h.functional}`, "");
    for (const item of functional) {
      const entry = record(item);
      if (!entry) {
        const plain = text(item);
        if (plain) lines.push(`- ${plain}`);
        continue;
      }
      const id = pick(entry, "id");
      const label = pick(entry, "title", "category");
      const description = pick(entry, "userStory", "description");
      const priority = pick(entry, "priority");
      const head = [id && `**${id}**`, label && (description ? `${label}:` : label)].filter(Boolean).join(" ");
      lines.push(`- ${[head, description, priority && `(${priority})`].filter(Boolean).join(" ")}`);
      const criteria = list(entry.acceptanceCriteria).map(text).filter(Boolean);
      if (criteria.length > 0) {
        lines.push(`  - ${h.acceptance}:`, ...criteria.map((criterion) => `    - ${criterion}`));
      }
    }
    lines.push("");
  }

  if (nonFunctional.length > 0) {
    lines.push(`### ${h.nonFunctional}`, "");
    for (const item of nonFunctional) {
      const entry = record(item);
      if (!entry) {
        const plain = text(item);
        if (plain) lines.push(`- ${plain}`);
        continue;
      }
      const category = pick(entry, "category");
      const detail = pick(entry, "specification", "description");
      lines.push(`- ${[category && `**${category}**:`, detail].filter(Boolean).join(" ")}`);
    }
    lines.push("");
  }
  return lines;
}

function scopeBlock(features: unknown, nonGoals: unknown, h: Record<string, string>): string[] {
  const phases = record(features) ?? {};
  // Older sessions named the phases in Indonesian.
  const groups: Array<[string, unknown[]]> = [
    [h.phase1, list(phases.phase1 ?? phases.fase1)],
    [h.phase2, list(phases.phase2 ?? phases.fase2)],
    [h.phase3, list(phases.phase3 ?? phases.fase3Plus)],
    [h.later, list(phases.futurePhases)],
  ];
  const lines: string[] = [];
  for (const [label, items] of groups) {
    const entries = items.map(text).filter(Boolean);
    if (entries.length === 0) continue;
    lines.push(`### ${label}`, ...entries.map((entry) => `- ${entry}`), "");
  }
  const excluded = bullets(nonGoals);
  if (excluded.length > 0) lines.push(`### ${h.outOfScope}`, ...excluded);
  return lines;
}

function risksBlock(prd: Loose, h: Record<string, string>): string[] {
  const lines: string[] = [];
  const assumptions = bullets(prd.assumptions);
  if (assumptions.length > 0) lines.push(`### ${h.assumptions}`, ...assumptions);

  if (typeof prd.risks === "string") {
    if (prd.risks.trim()) lines.push(`### ${h.riskList}`, prd.risks.trim(), "");
  } else {
    const rows: string[][] = [];
    const plain: string[] = [];
    for (const item of list(prd.risks)) {
      const entry = record(item);
      if (entry) rows.push([cell(entry.risk), cell(entry.mitigation)]);
      else if (text(item)) plain.push(`- ${text(item)}`);
    }
    if (rows.length > 0 || plain.length > 0) {
      lines.push(`### ${h.riskList}`, "", ...table([h.risk, h.mitigation], rows));
      if (plain.length > 0) lines.push(...plain, "");
    }
  }

  const questions = bullets(prd.openQuestions);
  if (questions.length > 0) lines.push(`### ${h.openQuestions}`, ...questions);
  return lines;
}

function dataModelBlock(value: unknown, h: Record<string, string>): string[] {
  if (typeof value === "string") return [value.trim(), ""];
  const lines: string[] = [];
  for (const item of list(value)) {
    const entity = record(item);
    if (!entity) {
      const plain = text(item);
      if (plain) lines.push(plain, "");
      continue;
    }
    const name = pick(entity, "entity", "name");
    const description = pick(entity, "description");
    if (name) lines.push(`### ${name}`, "");
    if (description) lines.push(description, "");
    const rows = list(entity.fields).flatMap((field): string[][] => {
      const row = record(field);
      return row ? [[cell(row.name), cell(row.type), cell(pick(row, "description", "constraints"))]] : [];
    });
    lines.push(...table([h.field, h.type, h.description], rows));
  }
  return lines;
}

function techStackBlock(value: unknown, h: Record<string, string>): string[] {
  if (typeof value === "string") return [value.trim(), ""];
  const rows: string[][] = [];
  const plain: string[] = [];
  for (const item of list(value)) {
    const entry = record(item);
    if (entry) rows.push([cell(entry.layer), cell(pick(entry, "technology", "tech")), cell(entry.rationale)]);
    else if (text(item)) plain.push(`- ${text(item)}`);
  }
  const lines = table([h.layer, h.technology, h.rationale], rows);
  if (plain.length > 0) lines.push(...plain, "");
  return lines;
}

function sectionBody(key: PrdSectionKey, prd: Loose, h: Record<string, string>): string[] {
  switch (key) {
    case "overview":
      return [text(prd.overview), ""];
    case "goals":
      return goalsBlock(prd.goals, h);
    case "users":
      return bullets(prd.targetUsers, userLine);
    case "scope":
      return scopeBlock(prd.coreFeatures, prd.nonGoals, h);
    case "requirements":
      return requirementsBlock(prd.requirements, h);
    case "userFlow": {
      const flow: string[] = [text(prd.userFlow), ""];
      const diagram = text(prd.logicFlowMermaid);
      if (diagram) flow.push("```mermaid", diagram, "```", "");
      const explanation = text(prd.logicFlowExplanation);
      if (explanation) flow.push(explanation, "");
      return flow;
    }
    case "risks":
      return risksBlock(prd, h);
    case "architecture":
      return [text(prd.architecture), ""];
    case "dataModel":
      return dataModelBlock(prd.databaseSchema, h);
    case "techStack":
      return techStackBlock(prd.techStack, h);
  }
}

/** The PRD as a Markdown document, headings in `lang`. Missing parts are skipped, never printed as "undefined". */
export function renderPrdMarkdown(prd: unknown, lang: PrdLang = "en"): string {
  const h = prdHeadings(lang);
  const source = record(prd) ?? {};
  const title = text(source.projectTitle);
  const lines: string[] = [`# ${title ? `PRD - ${title}` : h.document}`, ""];
  let number = 0;
  const section = (heading: string, body: string[]): void => {
    number += 1;
    lines.push(`## ${number}. ${heading}`, "", ...body);
    if (body.length === 0 || body[body.length - 1] !== "") lines.push("");
  };

  for (const key of prdSections(source)) section(h[key], sectionBody(key, source, h));

  // Extra sections follow on from the last standard one, whatever number they were saved with.
  for (const extra of list(source.additionalSections)) {
    const entry = record(extra);
    if (!entry) continue;
    section(pick(entry, "title"), [text(entry.content), ""]);
  }
  return `${lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;
}
