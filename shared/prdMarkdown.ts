// The PRD's Markdown document, written from its structured fields. The model used
// to be asked for this as well as the fields, so every PRD was written twice and
// took twice as long. Server and client share this one writer: the server
// fills `fullMarkdownText` after parsing, and the client refills it after an edit.

export type PrdLang = "en" | "id";

const HEADINGS: Record<PrdLang, Record<string, string>> = {
  en: {
    document: "PRD - Project Requirements Document",
    overview: "Overview",
    requirements: "Requirements",
    functional: "Functional requirements",
    nonFunctional: "Non-functional requirements",
    acceptance: "Acceptance criteria",
    coreFeatures: "Core Features",
    phase1: "Phase 1",
    phase2: "Phase 2",
    phase3: "Phase 3",
    later: "Later phases",
    userFlow: "User Flow",
    flowDiagram: "Logic diagram",
    architecture: "Architecture",
    database: "Database Schema",
    techStack: "Tech Stack",
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
    requirements: "Kebutuhan",
    functional: "Kebutuhan fungsional",
    nonFunctional: "Kebutuhan non-fungsional",
    acceptance: "Kriteria penerimaan",
    coreFeatures: "Fitur Utama",
    phase1: "Fase 1",
    phase2: "Fase 2",
    phase3: "Fase 3",
    later: "Fase lanjutan",
    userFlow: "Alur Pengguna",
    flowDiagram: "Diagram alur",
    architecture: "Arsitektur",
    database: "Skema Basis Data",
    techStack: "Tech Stack",
    field: "Bidang",
    type: "Tipe",
    description: "Keterangan",
    layer: "Lapisan",
    technology: "Teknologi",
    rationale: "Alasan",
  },
};

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

function requirementsBlock(value: unknown, h: Record<string, string>): string[] {
  // After the user edits point 2 it is free text; before, it is a pair of lists.
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
      const description = pick(entry, "description");
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

function featuresBlock(value: unknown, h: Record<string, string>): string[] {
  const features = record(value) ?? {};
  // Older sessions named the phases in Indonesian.
  const phases: Array<[string, unknown[]]> = [
    [h.phase1, list(features.phase1 ?? features.fase1)],
    [h.phase2, list(features.phase2 ?? features.fase2)],
    [h.phase3, list(features.phase3 ?? features.fase3Plus)],
    [h.later, list(features.futurePhases)],
  ];
  const lines: string[] = [];
  for (const [label, items] of phases) {
    const entries = items.map(text).filter(Boolean);
    if (entries.length === 0) continue;
    lines.push(`### ${label}`, ...entries.map((entry) => `- ${entry}`), "");
  }
  return lines;
}

function databaseBlock(value: unknown, h: Record<string, string>): string[] {
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

/** The PRD as a Markdown document, headings in `lang`. Missing parts are skipped, never printed as "undefined". */
export function renderPrdMarkdown(prd: unknown, lang: PrdLang = "en"): string {
  const h = HEADINGS[lang] ?? HEADINGS.en;
  const source = record(prd) ?? {};
  const title = text(source.projectTitle);
  const lines: string[] = [`# ${title ? `PRD - ${title}` : h.document}`, ""];
  const section = (number: number, heading: string, body: string[]): void => {
    lines.push(`## ${number}. ${heading}`, "", ...body);
    if (body.length === 0 || body[body.length - 1] !== "") lines.push("");
  };

  section(1, h.overview, [text(source.overview), ""]);
  section(2, h.requirements, requirementsBlock(source.requirements, h));
  section(3, h.coreFeatures, featuresBlock(source.coreFeatures, h));

  const flow: string[] = [text(source.userFlow), ""];
  const diagram = text(source.logicFlowMermaid);
  if (diagram) flow.push("```mermaid", diagram, "```", "");
  const explanation = text(source.logicFlowExplanation);
  if (explanation) flow.push(explanation, "");
  section(4, h.userFlow, flow);

  section(5, h.architecture, [text(source.architecture), ""]);
  section(6, h.database, databaseBlock(source.databaseSchema, h));
  section(7, h.techStack, techStackBlock(source.techStack, h));

  for (const extra of list(source.additionalSections)) {
    const entry = record(extra);
    if (!entry) continue;
    const number = Number(entry.number) || 8;
    section(number, pick(entry, "title"), [text(entry.content), ""]);
  }
  return `${lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;
}
