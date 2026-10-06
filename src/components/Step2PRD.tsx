// Copyright (c) 2026 Charis Chakim - Undagi (https://github.com/CharisChakim/undagi)
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import React, { useState, useEffect, useRef } from "react";
import { ProjectSession, PRDData, PRDExtraSection } from "../types";
import { MermaidViewer, Markdown } from "./lazy";
import { GenerationProgress } from "./GenerationProgress";
import {
  FileText,
  Sparkles,
  Copy,
  Check,
  ArrowRight,
  RefreshCw,
  Edit3,
  CheckCircle2,
  ListOrdered,
  SlidersHorizontal,
  FileCode,
  Plus,
  Trash2,
  AlertTriangle,
} from "lucide-react";
import { useT, TFunction } from "../lib/i18n";
import { prdHeadings, prdSections, renderPrdMarkdown, TECHNICAL_SECTIONS, type PrdSectionKey } from "../../shared/prdMarkdown";
import { generatePrd, generateTasks, isAbort, PipelineModelControl, usePipelineTarget } from "../lib/generate";
import {
  attachPrdVersionToPrd,
  attachPrdVersionToTasks,
  currentPrdVersion,
  markTasksNeedsSync,
  recordPrdVersion,
  taskNeedsPrdSync,
} from "../lib/artifactVersions";

interface Step2PRDProps {
  session: ProjectSession;
  onUpdateSession: (updated: Partial<ProjectSession>) => void;
  onGoToNextStep: () => void;
}

// Helpers for safe rendering & formatting
// Label struktural di bawah ini sengaja tidak ikut bahasa UI. keepOrReplace
// membandingkan hasil serialisasi ini dengan teks yang sedang diedit untuk
// menebak apakah pengguna mengubahnya; kalau labelnya bisa berganti bahasa,
// mengganti bahasa akan terbaca sebagai suntingan dan meruntuhkan data
// terstruktur dari LLM menjadi satu string datar.
const formatRequirementsToString = (reqs: any): string => {
  if (!reqs) return "";
  if (typeof reqs === "string") return reqs;
  if (Array.isArray(reqs)) {
    return reqs.map((r) => (typeof r === "string" ? r : r.title || r.description || JSON.stringify(r))).join("\n");
  }
  if (typeof reqs === "object") {
    // Acceptance criteria go along, indented, so an edit does not drop them.
    const fn = (reqs.functional || []).flatMap((f: any) => {
      if (typeof f === "string") return [`[Functional] ${f}`];
      const head = [f.id, f.title || f.category].filter(Boolean).join(" ");
      const story = f.userStory || f.description || "";
      const line = `[Functional] ${[head, story].filter(Boolean).join(": ")}${f.priority ? ` (${f.priority})` : ""}`;
      return [line, ...(Array.isArray(f.acceptanceCriteria) ? f.acceptanceCriteria : []).map((c: string) => `  - ${c}`)];
    });
    const nfn = (reqs.nonFunctional || []).map((nf: any) =>
      typeof nf === "string"
        ? `[Non-functional] ${nf}`
        : `[Non-functional] ${nf.category ? `${nf.category}: ` : ""}${nf.specification || nf.description || ""}`
    );
    return [...fn, ...nfn].join("\n");
  }
  return String(reqs);
};

// The other lists, one entry per line. A field the user already edited is text.
const formatLines = (value: any, line: (entry: any) => string = String): string => {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.map((entry) => (typeof entry === "string" ? entry : line(entry))).join("\n");
};

const formatGoal = (g: any): string => `${g.goal || ""} — ${g.metric || ""}: ${g.target || ""}`;
const formatUser = (u: any): string => `${u.name || ""} — ${u.description || ""}`;
const formatRisk = (r: any): string => `${r.risk || ""} — ${r.mitigation || ""}`;

// Plain lists go back to lists on save; lines of a structured entry cannot be
// split back reliably, so those stay text.
const toLines = (text: string): string[] => text.split("\n").map((line) => line.trim()).filter(Boolean);

type EditKey =
  | "overview" | "goals" | "targetUsers" | "nonGoals" | "requirements" | "userFlow"
  | "assumptions" | "risks" | "openQuestions" | "architecture" | "databaseSchema" | "techStack";

const EDIT_FORMAT: Record<EditKey, (value: any) => string> = {
  overview: (v) => v || "",
  goals: (v) => formatLines(v, formatGoal),
  targetUsers: (v) => formatLines(v, formatUser),
  nonGoals: (v) => formatLines(v),
  requirements: (v) => formatRequirementsToString(v),
  userFlow: (v) => v || "",
  assumptions: (v) => formatLines(v),
  risks: (v) => formatLines(v, formatRisk),
  openQuestions: (v) => formatLines(v),
  architecture: (v) => v || "",
  databaseSchema: (v) => formatDbSchemaToString(v),
  techStack: (v) => formatTechStackToString(v),
};

const LIST_KEYS: ReadonlySet<EditKey> = new Set(["nonGoals", "assumptions", "openQuestions"]);

const editableText = (prd: PRDData | undefined): Record<EditKey, string> =>
  Object.fromEntries(
    (Object.keys(EDIT_FORMAT) as EditKey[]).map((key) => [key, EDIT_FORMAT[key]((prd as any)?.[key])])
  ) as Record<EditKey, string>;

const getPhaseFeatures = (cf: any, phaseKey: string): string[] => {
  if (!cf) return [];
  if (cf[phaseKey] && Array.isArray(cf[phaseKey])) return cf[phaseKey];
  if (phaseKey === "fase1" && cf.phase1) return cf.phase1;
  if (phaseKey === "fase2" && cf.phase2) return cf.phase2;
  if (phaseKey === "fase3Plus" && (cf.phase3 || cf.futurePhases)) return cf.phase3 || cf.futurePhases;
  return [];
};

const formatDbSchemaToString = (schema: any): string => {
  if (!schema) return "";
  if (typeof schema === "string") return schema;
  if (Array.isArray(schema)) {
    return schema
      .map((entity: any) => {
        if (typeof entity === "string") return entity;
        // The PRD prompt names an entity "entity" and a field note "description";
        // older data used "name" and "constraints".
        const fields = (entity.fields || [])
          .map((f: any) => `  - ${f.name} (${f.type}): ${f.description || f.constraints || ""}`)
          .join("\n");
        return `Table: ${entity.entity || entity.name}\n${entity.description ? `Description: ${entity.description}\n` : ""}${fields}`;
      })
      .join("\n\n");
  }
  return String(schema);
};

const formatTechStackToString = (ts: any): string => {
  if (!ts) return "";
  if (typeof ts === "string") return ts;
  if (Array.isArray(ts)) {
    return ts
      .map((item: any) => (typeof item === "string" ? item : `${item.layer || "Stack"}: ${item.technology || item.tech || ""} - ${item.rationale || ""}`))
      .join("\n");
  }
  return String(ts);
};

const listOf = (value: unknown): any[] => (Array.isArray(value) ? value : []);

const BulletList: React.FC<{ items: React.ReactNode[] }> = ({ items }) => (
  <ul className="space-y-1.5 text-muted">
    {items.map((item, idx) => (
      <li key={idx} className="flex gap-2.5">
        <span className="text-faint shrink-0">&middot;</span>
        <span className="min-w-0">{item}</span>
      </li>
    ))}
  </ul>
);

// A section the user edited into text shows as they wrote it.
const PlainText: React.FC<{ text: string }> = ({ text }) => (
  <div className="text-muted leading-relaxed whitespace-pre-wrap">{text}</div>
);

const SubHeading: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <h5 className="text-xs font-semibold text-ink">{children}</h5>
);

// The standard sections and the extra ones share one card frame; only the
// number, title, and content differ.
const PrdSection: React.FC<{
  number: number;
  title: string;
  isExtra?: boolean;
  t: TFunction;
  children: React.ReactNode;
}> = ({ number, title, isExtra, t, children }) => (
  <section className="card p-6 space-y-3">
    <h4 className="font-semibold text-ink text-sm flex flex-wrap items-center gap-2 border-b border-line pb-3">
      <span className="w-5 h-5 shrink-0 rounded-md bg-accent-soft text-accent-ink font-semibold text-[11px] grid place-items-center">
        {number}
      </span>
      {title}
      {isExtra && (
        <span className="text-[11px] font-semibold px-1.5 py-0.5 rounded bg-subtle text-muted">
          {t("Extra point")}
        </span>
      )}
    </h4>
    {children}
  </section>
);

export const Step2PRD: React.FC<Step2PRDProps> = ({ session, onUpdateSession, onGoToNextStep }) => {
  const { t, lang } = useT();
  const pipelineTarget = usePipelineTarget();
  const [loading, setLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [copiedMd, setCopiedMd] = useState(false);
  const [activeTab, setActiveTab] = useState<"sections" | "overview_edit" | "markdown">("sections");

  const prd = session.prd;
  const h = prdHeadings(lang);
  const sections = prd ? prdSections(prd) : [];
  const extraSections = prd?.additionalSections || [];
  const currentVersion = currentPrdVersion(session.prdVersions);
  const tasksNeedingSync = (session.tasks || []).filter((task) => taskNeedsPrdSync(task, currentVersion)).length;

  // Editable state for the review tab
  const [edits, setEdits] = useState<Record<EditKey, string>>(() => editableText(prd));
  const [editExtraSections, setEditExtraSections] = useState<PRDExtraSection[]>(prd?.additionalSections || []);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [generatingTasks, setGeneratingTasks] = useState(false);
  const [generationChars, setGenerationChars] = useState(0);
  const [briefTitle, setBriefTitle] = useState(session.input.title || session.title || "");
  const [briefDescription, setBriefDescription] = useState(session.input.description || "");
  const prdAbort = useRef<AbortController | null>(null);
  const tasksAbort = useRef<AbortController | null>(null);

  const updateExtraSection = (idx: number, patch: Partial<PRDExtraSection>) =>
    setEditExtraSections((prev) => prev.map((s, i) => (i === idx ? { ...s, ...patch } : s)));

  const addExtraSection = () =>
    setEditExtraSections((prev) => [...prev, { number: sections.length + 1 + prev.length, title: "", content: "" }]);

  const removeExtraSection = (idx: number) =>
    setEditExtraSections((prev) => prev.filter((_, i) => i !== idx));

  // Synchronize edit states when PRD is updated
  useEffect(() => {
    if (prd) {
      setEdits(editableText(prd));
      setEditExtraSections(prd.additionalSections || []);
    }
  }, [prd]);

  useEffect(() => {
    setBriefTitle(session.input.title || session.title || "");
    setBriefDescription(session.input.description || "");
  }, [session.id]);

  const handleGeneratePRD = async () => {
    if (loading || generatingTasks) return;
    setLoading(true);
    setErrorMessage(null);
    setGenerationChars(0);
    const controller = new AbortController();
    prdAbort.current = controller;

    try {
      const title = briefTitle.trim() || session.input.title || session.title;
      const description = briefDescription.trim() || session.input.description;
      const sourceSession: ProjectSession = {
        ...session,
        title,
        input: { ...session.input, title, description },
      };
      if (!session.plan) onUpdateSession({ title, input: sourceSession.input });
      const generatedPrd = await generatePrd(sourceSession, lang, controller.signal, setGenerationChars, pipelineTarget);
      const recorded = recordPrdVersion(generatedPrd, session.prdVersions);
      const versionedPrd = attachPrdVersionToPrd(generatedPrd, recorded.version);
      onUpdateSession({
        prd: versionedPrd,
        prdVersions: recorded.versions,
        tasks: markTasksNeedsSync(session.tasks, recorded.version),
      });
    } catch (err: any) {
      if (!isAbort(err)) setErrorMessage(err.message || t("Something went wrong while generating the PRD."));
    } finally {
      if (prdAbort.current === controller) prdAbort.current = null;
      setLoading(false);
    }
  };

  // Sama seperti transisi Step 1 -> Step 2: task disusun dulu sambil menunggu
  // di halaman ini, baru pindah. Task yang sudah ada tidak dibuat ulang.
  const handleContinueToTasks = async () => {
    if (loading || generatingTasks) return;
    // Backfill a version for sessions created before PRD versioning existed.
    // This also gives first-generation tasks a source snapshot.
    const recorded = prd ? recordPrdVersion(prd, session.prdVersions) : null;
    const versionedPrd = recorded && prd ? attachPrdVersionToPrd(prd, recorded.version) : prd;

    if (session.tasks && session.tasks.length > 0) {
      if (recorded && versionedPrd) {
        onUpdateSession({
          prd: versionedPrd,
          prdVersions: recorded.versions,
          tasks: markTasksNeedsSync(session.tasks, recorded.version),
        });
      }
      onGoToNextStep();
      return;
    }

    setErrorMessage(null);
    setGeneratingTasks(true);
    setGenerationChars(0);
    const controller = new AbortController();
    tasksAbort.current = controller;

    try {
      const taskSession = versionedPrd && recorded
        ? { ...session, prd: versionedPrd, prdVersions: recorded.versions }
        : session;
      const generatedTasks = await generateTasks(taskSession, lang, controller.signal, setGenerationChars, pipelineTarget);
      onUpdateSession({
        ...(recorded && versionedPrd ? { prd: versionedPrd, prdVersions: recorded.versions } : {}),
        tasks: attachPrdVersionToTasks(generatedTasks, recorded?.version),
      });
      onGoToNextStep();
    } catch (err: any) {
      if (!isAbort(err)) {
        setErrorMessage(err.message || t("Something went wrong while generating the agent tasks."));
      }
    } finally {
      tasksAbort.current = null;
      setGeneratingTasks(false);
    }
  };

  const handleSavePrdOverviewEdits = () => {
    if (!prd || loading || generatingTasks) return;

    // Bidang terstruktur hanya diganti kalau teksnya benar-benar berubah. Kalau
    // tidak disentuh, data asli dari LLM dibiarkan utuh — sebelumnya struktur itu
    // selalu diruntuhkan jadi satu entri palsu meski pengguna tidak mengedit.
    const updatedPrd: PRDData = { ...prd };
    for (const key of Object.keys(EDIT_FORMAT) as EditKey[]) {
      const original = (prd as any)[key];
      const edited = edits[key];
      if (edited.trim() === EDIT_FORMAT[key](original).trim()) continue;
      (updatedPrd as any)[key] = LIST_KEYS.has(key) ? toLines(edited) : edited;
    }
    // Empty extra sections are dropped; the rest are numbered after the standard ones.
    const first = prdSections(updatedPrd).length + 1;
    updatedPrd.additionalSections = editExtraSections
      .filter((s) => s.title.trim() !== "" || s.content.trim() !== "")
      .map((s, idx) => ({
        number: first + idx,
        title: s.title.trim() || t("Additional point {n}", { n: first + idx }),
        content: s.content,
      }));

    // Ekspor .md membaca fullMarkdownText. Tanpa dibangun ulang, Export/Copy MD
    // akan mengekspor versi sebelum diedit.
    updatedPrd.fullMarkdownText = renderPrdMarkdown(updatedPrd, lang);

    const recorded = recordPrdVersion(updatedPrd, session.prdVersions);
    const versionedPrd = attachPrdVersionToPrd(updatedPrd, recorded.version);
    onUpdateSession({
      prd: versionedPrd,
      prdVersions: recorded.versions,
      tasks: markTasksNeedsSync(session.tasks, recorded.version),
    });
    setSaveSuccess(true);
    setTimeout(() => setSaveSuccess(false), 2500);
  };

  const handleCopyMarkdown = () => {
    if (!prd?.fullMarkdownText) return;
    navigator.clipboard.writeText(prd.fullMarkdownText);
    setCopiedMd(true);
    setTimeout(() => setCopiedMd(false), 2000);
  };

  const renderSection = (key: PrdSectionKey): React.ReactNode => {
    if (!prd) return null;
    switch (key) {
      case "overview":
        return <PlainText text={prd.overview || ""} />;
      case "goals":
        return typeof prd.goals === "string" ? <PlainText text={prd.goals} /> : (
          <BulletList
            items={listOf(prd.goals).map((g) => (typeof g === "string" ? g : (
              <>
                <span className="text-ink">{g.goal}</span>
                {g.metric && <> — {h.metric}: {g.metric}</>}
                {g.target && <> · {h.target}: {g.target}</>}
              </>
            )))}
          />
        );
      case "users":
        return typeof prd.targetUsers === "string" ? <PlainText text={prd.targetUsers} /> : (
          <BulletList
            items={listOf(prd.targetUsers).map((u) => (typeof u === "string" ? u : (
              <><span className="text-ink">{u.name}</span>{u.description && <> — {u.description}</>}</>
            )))}
          />
        );
      case "scope": {
        const nonGoals = prd.nonGoals;
        return (
          <>
            <div className="grid grid-cols-1 @3xl/pane:grid-cols-3 gap-x-6 gap-y-5">
              {(
                [
                  [t("Phase 1"), t("Core MVP"), "fase1"],
                  [t("Phase 2"), t("Enrichment"), "fase2"],
                  [t("Phase 3+"), t("Advanced"), "fase3Plus"],
                ] as const
              ).map(([label, caption, phase]) => (
                <div key={phase} className="space-y-2">
                  <div className="flex items-baseline gap-2 pb-2 border-b border-line">
                    <span className="font-medium text-ink">{label}</span>
                    <span className="text-xs text-faint">{caption}</span>
                  </div>
                  <BulletList items={getPhaseFeatures(prd.coreFeatures, phase)} />
                </div>
              ))}
            </div>
            {(typeof nonGoals === "string" ? nonGoals.trim() !== "" : listOf(nonGoals).length > 0) && (
              <div className="space-y-2 pt-2">
                <SubHeading>{h.outOfScope}</SubHeading>
                {typeof nonGoals === "string" ? <PlainText text={nonGoals} /> : <BulletList items={listOf(nonGoals)} />}
              </div>
            )}
          </>
        );
      }
      case "requirements": {
        if (typeof prd.requirements === "string") return <PlainText text={prd.requirements} />;
        const functional = listOf(prd.requirements?.functional);
        const nonFunctional = listOf(prd.requirements?.nonFunctional);
        return (
          <div className="space-y-5">
            {functional.length > 0 && (
              <div className="space-y-2">
                <SubHeading>{h.functional}</SubHeading>
                <ul className="space-y-4">
                  {functional.map((f, idx) => (typeof f === "string" ? <li key={idx} className="text-muted">{f}</li> : (
                    <li key={idx} className="space-y-1.5">
                      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                        {f.id && <span className="font-mono text-xs text-faint">{f.id}</span>}
                        <span className="font-medium text-ink">{f.title || f.category}</span>
                        {f.priority && <span className="rounded bg-subtle px-1.5 py-0.5 text-[11px] font-medium text-muted">{f.priority}</span>}
                      </div>
                      {(f.userStory || f.description) && <p className="text-muted leading-relaxed">{f.userStory || f.description}</p>}
                      {listOf(f.acceptanceCriteria).length > 0 && (
                        <div className="space-y-1 border-l border-line pl-3">
                          <span className="text-xs text-faint">{h.acceptance}</span>
                          <BulletList items={listOf(f.acceptanceCriteria)} />
                        </div>
                      )}
                    </li>
                  )))}
                </ul>
              </div>
            )}
            {nonFunctional.length > 0 && (
              <div className="space-y-2">
                <SubHeading>{h.nonFunctional}</SubHeading>
                <BulletList
                  items={nonFunctional.map((nf) => (typeof nf === "string" ? nf : (
                    <><span className="text-ink">{nf.category}</span>: {nf.specification || nf.description}</>
                  )))}
                />
              </div>
            )}
          </div>
        );
      }
      case "userFlow":
        return (
          <>
            <PlainText text={prd.userFlow || ""} />
            {prd.logicFlowMermaid && (
              <MermaidViewer
                chart={prd.logicFlowMermaid}
                explanation={prd.logicFlowExplanation}
                title={t("User flow & logic diagram: {title}", { title: prd.projectTitle })}
              />
            )}
          </>
        );
      case "risks": {
        const blocks: Array<[string, unknown, (entry: any) => React.ReactNode]> = [
          [h.assumptions, prd.assumptions, (a) => a],
          [h.riskList, prd.risks, (r) => (
            <><span className="text-ink">{r.risk}</span>{r.mitigation && <> — {h.mitigation}: {r.mitigation}</>}</>
          )],
          [h.openQuestions, prd.openQuestions, (q) => q],
        ];
        return (
          <div className="space-y-4">
            {blocks.map(([label, value, item]) => {
              if (typeof value === "string") {
                return value.trim() ? (
                  <div key={label} className="space-y-2"><SubHeading>{label}</SubHeading><PlainText text={value} /></div>
                ) : null;
              }
              const entries = listOf(value);
              return entries.length > 0 ? (
                <div key={label} className="space-y-2">
                  <SubHeading>{label}</SubHeading>
                  <BulletList items={entries.map((entry) => (typeof entry === "string" ? entry : item(entry)))} />
                </div>
              ) : null;
            })}
          </div>
        );
      }
      case "architecture":
        return <PlainText text={prd.architecture || ""} />;
      case "dataModel":
        return (
          <div className="p-4 bg-code text-code-ink rounded-lg text-xs font-mono leading-relaxed whitespace-pre-wrap overflow-x-auto">
            {formatDbSchemaToString(prd.databaseSchema)}
          </div>
        );
      case "techStack":
        return (
          <div className="p-4 bg-accent-soft text-accent-ink rounded-lg font-medium whitespace-pre-wrap">
            {formatTechStackToString(prd.techStack)}
          </div>
        );
    }
  };

  const onePerLine = t("One per line.");
  const editFields: Array<{ key: EditKey; label: string; hint?: string; rows: number; mono?: boolean }> = [
    { key: "overview", label: h.overview, rows: 3 },
    { key: "goals", label: h.goals, hint: t("One per line: goal — metric: target."), rows: 3 },
    { key: "targetUsers", label: h.users, hint: t("One per line: who — what they need."), rows: 2 },
    { key: "nonGoals", label: h.outOfScope, hint: onePerLine, rows: 3 },
    { key: "requirements", label: h.requirements, hint: t("One requirement per line, its acceptance criteria indented below it."), rows: 8 },
    { key: "userFlow", label: h.userFlow, rows: 3 },
    { key: "assumptions", label: h.assumptions, hint: onePerLine, rows: 2 },
    { key: "risks", label: h.riskList, hint: t("One per line: risk — mitigation."), rows: 3 },
    { key: "openQuestions", label: h.openQuestions, hint: onePerLine, rows: 2 },
    { key: "architecture", label: h.architecture, rows: 3, mono: true },
    { key: "databaseSchema", label: h.dataModel, rows: 4, mono: true },
    { key: "techStack", label: h.techStack, rows: 2 },
  ];

  return (
    <div className="max-w-none space-y-6 pb-12">
      {/* Page heading */}
      <div className="max-w-2xl">
        <h2 className="text-xl font-semibold tracking-tight text-ink">{t("Product Requirement Document")}</h2>
        <p className="text-muted mt-1.5 leading-relaxed">
          {t(
            "What to build and why — goals, users, scope and non-goals, requirements with acceptance criteria, risks — then how, for the coding agent: architecture, data model, tech stack. Review and edit before it is broken into tasks."
          )}
        </p>
      </div>

      {/* Error Alert */}
      {errorMessage && (
        <div className="p-4 bg-danger-soft border border-danger/30 text-danger-ink rounded-xl">
          <strong className="font-semibold">{t("Error")}:</strong> {errorMessage}
        </div>
      )}

      <GenerationProgress
        active={loading || generatingTasks}
        label={generatingTasks ? t("Building the task board...") : t("Assembling the PRD & diagram...")}
        chars={generationChars}
        onCancel={() => (loading ? prdAbort.current : tasksAbort.current)?.abort()}
      />

      {/* Generate Action Card if no PRD */}
      {!prd ? (
        <div className="card mx-auto max-w-2xl space-y-5 p-6 sm:p-8">
          <div className="w-12 h-12 bg-accent-soft text-accent-ink rounded-xl mx-auto flex items-center justify-center">
            <Sparkles className="w-6 h-6" />
          </div>
          <div className="mx-auto max-w-md space-y-1.5 text-center">
            <h3 className="font-semibold text-ink text-base">{t("Generate the PRD automatically")}</h3>
            <p className="text-muted leading-relaxed">
              {session.plan
                ? t("The system builds the PRD from the approved project plan, sized to the project, with Phase 1 as the MVP.")
                : t("Build the PRD straight from the project description you entered.")}
            </p>
          </div>
          {!session.plan && (
            <div className="space-y-4 rounded-xl border border-line bg-canvas p-4 text-left">
              <div>
                <label className="field-label" htmlFor="prd-project-title">{t("Project name")}</label>
                <input id="prd-project-title" className="field" value={briefTitle} onChange={(event) => setBriefTitle(event.target.value)} placeholder={t("Project name from the selected folder")} />
              </div>
              <div>
                <label className="field-label" htmlFor="prd-project-brief">{t("Project brief")} <span className="text-danger">*</span></label>
                <textarea id="prd-project-brief" rows={5} className="field resize-y leading-relaxed" value={briefDescription} onChange={(event) => setBriefDescription(event.target.value)} placeholder={t("Describe the product, users, problem, and main outcome...")} />
              </div>
            </div>
          )}
          <div className="flex flex-wrap items-center justify-between gap-3 -mx-6 -mb-6 border-t border-line px-6 py-4 sm:-mx-8 sm:-mb-8 sm:px-8">
          <PipelineModelControl />
          <button onClick={handleGeneratePRD} disabled={loading || generatingTasks || (!session.plan && !briefDescription.trim())} className="btn-primary">
            {loading ? (
              <>
                <RefreshCw className="w-4 h-4 animate-spin" />
                {t("Assembling the PRD & diagram...")}
              </>
            ) : (
              <>
                <Sparkles className="w-4 h-4" />
                {t("Generate PRD")}
              </>
            )}
          </button>
          </div>
        </div>
      ) : (
        <div className="space-y-5 animate-in fade-in duration-300">
          {/* PRD Header & Toolbar */}
          <div className="card p-5 flex flex-wrap items-start justify-between gap-5">
            <div className="min-w-0">
              <div className="flex items-center gap-1.5 text-ok text-xs font-medium mb-1.5">
                <CheckCircle2 className="w-3.5 h-3.5" /> {t("PRD ready")}
                {currentVersion && <span className="text-faint">· v{currentVersion.number}</span>}
              </div>
              <h3 className="text-base font-semibold text-ink">{prd.projectTitle || session.title}</h3>
              <p className="text-muted mt-1 max-w-xl line-clamp-2 leading-relaxed">
                {prd.overview || prd.executiveSummary}
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-2 min-w-0">
              <PipelineModelControl />
              <button onClick={handleCopyMarkdown} className="btn-ghost">
                {copiedMd ? <Check className="w-4 h-4 text-ok" /> : <Copy className="w-4 h-4" />}
                {copiedMd ? t("Copied") : t("Copy MD")}
              </button>

              <button onClick={handleContinueToTasks} disabled={loading || generatingTasks} className="btn-primary">
                {t("Continue to tasks")}
                <ArrowRight className="w-4 h-4" />
              </button>
            </div>
          </div>

          {tasksNeedingSync > 0 && (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-warn/30 bg-warn-soft p-4 text-warn-ink">
              <div className="flex items-start gap-2 text-sm">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>
                  <strong className="font-semibold">
                    {tasksNeedingSync === 1
                      ? t("{count} task needs sync.", { count: tasksNeedingSync })
                      : t("{count} tasks need sync.", { count: tasksNeedingSync })}
                  </strong>{" "}
                  {t("Review the task board and explicitly sync generated tasks to PRD v{version}.", { version: currentVersion?.number || "latest" })}
                </span>
              </div>
              <button type="button" onClick={onGoToNextStep} disabled={loading || generatingTasks} className="btn-outline shrink-0 text-xs">
                {t("Review task sync")}
                <ArrowRight className="h-3.5 w-3.5" />
              </button>
            </div>
          )}

          {/* View Mode Tabs */}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="inline-flex items-center gap-1 bg-subtle p-1 rounded-lg">
              {(
                [
                  {
                    id: "sections",
                    label: t("PRD · {count} sections", { count: sections.length + extraSections.length }),
                    icon: ListOrdered,
                  },
                  { id: "overview_edit", label: t("Review & edit"), icon: Edit3 },
                  { id: "markdown", label: t("Raw markdown"), icon: FileCode },
                ] as const
              ).map(({ id, label, icon: Icon }) => (
                <button
                  key={id}
                  onClick={() => setActiveTab(id)}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
                    activeTab === id ? "bg-surface text-ink shadow-elev-1" : "text-muted hover:text-ink"
                  }`}
                >
                  <Icon className="w-3.5 h-3.5" />
                  {label}
                </button>
              ))}
            </div>

            <button onClick={handleGeneratePRD} disabled={loading || generatingTasks} className="btn-outline text-xs">
              <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
              {t("Regenerate PRD")}
            </button>
          </div>

          {/* TAB 1: STRUCTURED PRD DISPLAY */}
          {activeTab === "sections" && (
            <div className="space-y-4">
              {sections.map((key, idx) => (
                <React.Fragment key={key}>
                  {key === TECHNICAL_SECTIONS[0] && (
                    <div className="flex items-center gap-3 pt-4">
                      <span className="text-xs font-semibold uppercase tracking-wide text-faint">{t("Technical design")}</span>
                      <span className="text-xs text-faint">{t("How it will be built, for the coding agent.")}</span>
                      <span className="h-px flex-1 bg-line" aria-hidden />
                    </div>
                  )}
                  <PrdSection t={t} number={idx + 1} title={key === "userFlow" ? t("User flow & logic diagram") : h[key]}>
                    {renderSection(key)}
                  </PrdSection>
                </React.Fragment>
              ))}

              {/* Extra sections the AI judged necessary after its analysis */}
              {extraSections.map((section, idx) => (
                <PrdSection t={t} key={`extra-${idx}`} number={sections.length + idx + 1} title={section.title} isExtra>
                  <div className="text-muted leading-relaxed whitespace-pre-wrap">{section.content}</div>
                </PrdSection>
              ))}
            </div>
          )}

          {/* TAB 2: OVERVIEW & EDITABLE REVIEW BEFORE TASK GENERATION */}
          {activeTab === "overview_edit" && (
            <div className="card p-6 space-y-5">
              <div className="flex flex-wrap items-start justify-between gap-3 border-b border-line pb-4">
                <div>
                  <h3 className="font-semibold text-ink text-sm flex items-center gap-2">
                    <SlidersHorizontal className="w-4 h-4 text-faint" />
                    {t("Review & edit the PRD before it becomes tasks")}
                  </h3>
                  <p className="text-xs text-faint mt-1">
                    {t("Adjust anything that reads wrong here; the AI agent works from this version when it builds the Kanban tasks.")}
                  </p>
                </div>

                {saveSuccess && (
                  <span className="inline-flex items-center gap-1.5 px-2.5 py-1 bg-ok-soft text-ok-ink rounded-lg text-xs font-medium animate-in fade-in">
                    <Check className="w-3.5 h-3.5" /> {t("Changes saved")}
                  </span>
                )}
              </div>

              <div className="space-y-4">
                {editFields.map(({ key, label, hint, rows, mono }) => (
                  <div key={key}>
                    <label className="field-label" htmlFor={`prd-edit-${key}`}>{label}</label>
                    {hint && <p className="-mt-0.5 mb-1 text-xs text-faint">{hint}</p>}
                    <textarea
                      id={`prd-edit-${key}`}
                      rows={rows}
                      value={edits[key]}
                      onChange={(e) => setEdits((prev) => ({ ...prev, [key]: e.target.value }))}
                      className={`field resize-y ${mono ? "font-mono text-xs" : ""}`}
                    />
                  </div>
                ))}

                {/* Extra sections: can be changed, deleted, or added by hand */}
                <div className="pt-4 border-t border-line space-y-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <span className="block text-xs font-medium text-muted">{t("Extra points")}</span>
                      <p className="text-xs text-faint mt-0.5">
                        {t("Points beyond the standard sections. They are numbered after them on save.")}
                      </p>
                    </div>
                    <button type="button" onClick={addExtraSection} className="btn-outline text-xs">
                      <Plus className="w-3.5 h-3.5" />
                      {t("Add point")}
                    </button>
                  </div>

                  {editExtraSections.length === 0 ? (
                    <p className="text-xs text-faint border border-dashed border-line rounded-lg p-3">
                      {t("No extra points yet. The AI adds them when its analysis calls for it, or you can add your own.")}
                    </p>
                  ) : (
                    editExtraSections.map((section, idx) => (
                      <div key={idx} className="p-3 bg-subtle rounded-lg space-y-2">
                        <div className="flex items-center gap-2">
                          <span className="w-5 h-5 shrink-0 rounded-md bg-accent-soft text-accent-ink font-semibold text-[11px] grid place-items-center">
                            {sections.length + 1 + idx}
                          </span>
                          <input
                            type="text"
                            value={section.title}
                            onChange={(e) => updateExtraSection(idx, { title: e.target.value })}
                            placeholder={t("Point title, e.g. Test plan")}
                            className="field flex-1 min-w-0 font-medium"
                          />
                          <button
                            type="button"
                            onClick={() => removeExtraSection(idx)}
                            className="p-2 shrink-0 text-faint hover:text-danger rounded-lg transition-colors"
                            title={t("Delete this point")}
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                        <textarea
                          rows={3}
                          value={section.content}
                          onChange={(e) => updateExtraSection(idx, { content: e.target.value })}
                          placeholder={t("Content for this point...")}
                          className="field resize-y"
                        />
                      </div>
                    ))
                  )}
                </div>
              </div>

              <div className="flex flex-wrap items-center justify-between gap-3 -mx-6 -mb-6 px-6 py-4 border-t border-line">
                <button onClick={handleSavePrdOverviewEdits} disabled={loading || generatingTasks} className="btn-outline">
                  <Check className="w-4 h-4" />
                  {t("Save changes")}
                </button>

                <button onClick={handleContinueToTasks} disabled={loading || generatingTasks} className="btn-primary">
                  {t("Approve & continue to tasks")}
                  <ArrowRight className="w-4 h-4" />
                </button>
              </div>
            </div>
          )}

          {/* TAB 3: RAW MARKDOWN DOCUMENT */}
          {activeTab === "markdown" && (
            <div className="card p-6 markdown-body">
              <Markdown>{prd.fullMarkdownText}</Markdown>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
