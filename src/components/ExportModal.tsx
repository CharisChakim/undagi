// Copyright (c) 2026 Charis Chakim - Undagi (https://github.com/CharisChakim/undagi)
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import React, { useEffect, useRef } from "react";
import { ProjectSession } from "../types";
import { X, Download, FileText, Compass, Bot, FileCode, Check } from "lucide-react";
import { complexityLabelKey, normalizeComplexity } from "../lib/complexity";
import { useT } from "../lib/i18n";
import { agentsMarkdownFilename, buildAgentsMarkdown } from "../lib/agentsMd";
import { downloadBlob, downloadFile } from "../lib/download";
import { buildZip } from "../lib/zip";
import { stripLocalOnlyFields } from "../lib/sessionStore";
import {
  buildHandoffJson,
  buildHandoffMarkdown,
  handoffJsonFilename,
  handoffMarkdownFilename,
} from "../lib/handoff";

interface ExportDocument {
  id: string;
  available: boolean;
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  caption: string;
  filename: string;
  mime: string;
  build: () => string;
}

interface ExportModalProps {
  isOpen: boolean;
  onClose: () => void;
  session: ProjectSession;
}

export const ExportModal: React.FC<ExportModalProps> = ({ isOpen, onClose, session }) => {
  const { t } = useT();
  const [showHandoffPreview, setShowHandoffPreview] = React.useState(false);
  const closeButton = useRef<HTMLButtonElement>(null);
  const [selected, setSelected] = React.useState<Set<string>>(new Set());

  // Dokumen milik langkah yang sedang dibuka sudah tercentang saat dialog dibuka.
  useEffect(() => {
    if (!isOpen) return;
    const byStep: Record<number, string> = { 1: "plan", 2: "prd", 3: "tasks" };
    setSelected(new Set([byStep[session.currentStep]].filter(Boolean)));
    // Hanya saat dialog dibuka: edit sesi di belakang tidak boleh mengubah pilihan.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  // Dialog lain di aplikasi ini sudah begini: fokus masuk ke tombol tutup,
  // Escape menutup, dan fokus kembali ke tempat asalnya saat dialog hilang.
  useEffect(() => {
    if (!isOpen) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const frame = window.requestAnimationFrame(() => closeButton.current?.focus());
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener("keydown", closeOnEscape);
      previousFocus?.focus();
    };
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const projectTitle = session.input.title || session.title || "Project";
  const slug = projectTitle.toLowerCase().replace(/[^a-z0-9]/g, "_");

  const buildPlanMarkdown = (): string => {
    const plan = session.plan!;
    let md = `# PROJECT PLAN & ARCHITECTURE SPECIFICATION: ${projectTitle.toUpperCase()}\n\n`;
    md += `## SUMMARY\n${plan.summary}\n\n`;
    md += `## CORE FEATURES\n`;
    plan.specs.coreFeatures.forEach((f) => {
      md += `- **[${f.priority}] ${f.name}**: ${f.description}\n`;
    });
    md += `\n## RECOMMENDED TECH STACK\n`;
    plan.specs.techStack.forEach((t) => {
      md += `- **${t.layer}**: ${t.technology} (${t.rationale})\n`;
    });
    md += `\n## ARCHITECTURE DRAFT\n${plan.architectureDraft.overview}\n\n`;
    md += `### Data Flow\n${plan.architectureDraft.dataFlow}\n\n`;
    md += `### Security & Auth\n${plan.architectureDraft.securityAndAuth}\n\n`;
    md += `## ROADMAP\n`;
    plan.roadmap.forEach((r) => {
      md += `### ${r.title} (${r.duration})\n`;
      r.deliverables.forEach((d) => (md += `- ${d}\n`));
      md += `\n`;
    });
    md += `## ESTIMATION & RESOURCES\n`;
    md += `- Total Time: ${plan.estimation.totalTimeWeeks}\n`;
    md += `- Complexity: ${t(complexityLabelKey(normalizeComplexity(plan.estimation.complexityLevel)))}\n`;
    return md;
  };

  const documents: ExportDocument[] = [
    {
      id: "plan",
      available: Boolean(session.plan),
      icon: Compass,
      title: t("Project plan & architecture (.md)"),
      caption: t("Specification, tech stack, and roadmap."),
      filename: `PLAN_${slug}.md`,
      mime: "text/markdown",
      build: buildPlanMarkdown,
    },
    {
      id: "prd",
      available: Boolean(session.prd?.fullMarkdownText),
      icon: FileText,
      title: t("Product requirement document (.md)"),
      caption: t("The full PRD including its logic diagram."),
      filename: `PRD_${slug}.md`,
      mime: "text/markdown",
      build: () => session.prd!.fullMarkdownText,
    },
    {
      id: "tasks",
      available: Boolean(session.tasks),
      icon: Bot,
      title: t("AI agent executable tasks (AGENTS.md)"),
      caption: t("Atomic tasks ready to hand to an AI coding agent."),
      filename: agentsMarkdownFilename(session),
      mime: "text/markdown",
      build: () => buildAgentsMarkdown(session),
    },
    {
      id: "handoff-json",
      available: true,
      icon: FileCode,
      title: t("Handoff package (.json)"),
      caption: t("PRD, task scope, dependencies and verification steps for another tool."),
      filename: handoffJsonFilename(session),
      mime: "application/json",
      build: () => buildHandoffJson(session),
    },
    {
      id: "handoff-md",
      available: true,
      icon: FileText,
      title: t("Handoff package (.md)"),
      caption: t("The same handoff, readable as a document."),
      filename: handoffMarkdownFilename(session),
      mime: "text/markdown",
      build: () => buildHandoffMarkdown(session),
    },
    {
      id: "backup",
      available: true,
      icon: FileCode,
      title: t("Full backup of the project session (.json)"),
      caption: t("Model credentials are not included in this backup."),
      filename: `PROJECT_BUNDLE_${slug}.json`,
      mime: "application/json",
      build: () => JSON.stringify(stripLocalOnlyFields(session), null, 2),
    },
  ];

  const chosen = documents.filter((doc) => doc.available && selected.has(doc.id));

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });

  const handleExport = () => {
    if (chosen.length === 0) return;
    if (chosen.length === 1) {
      downloadFile(chosen[0].filename, chosen[0].build(), chosen[0].mime);
      return;
    }
    const zip = buildZip(chosen.map((doc) => ({ name: doc.filename, content: doc.build() })));
    downloadBlob(`EXPORT_${slug}.zip`, new Blob([zip], { type: "application/zip" }));
  };

  const handoffPreview = buildHandoffJson(session);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-xs p-4 overflow-y-auto">
      <div role="dialog" aria-modal="true" aria-labelledby="export-modal-title" className="card shadow-elev-3 w-full max-w-lg overflow-hidden animate-in fade-in zoom-in-95 duration-200">
        <div className="px-6 py-4 border-b border-line flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <Download className="w-4 h-4 text-faint" />
            <h3 id="export-modal-title" className="font-semibold text-ink">{t("Export project document bundle")}</h3>
          </div>
          <button
            ref={closeButton}
            onClick={onClose}
            className="p-1.5 text-faint hover:text-ink hover:bg-subtle rounded-lg transition-colors"
            aria-label={t("Close")}
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-6 space-y-4">
          <p className="text-muted leading-relaxed">
            {t("Tick the documents to export. One document downloads as a file; several download together as a .zip.")}
          </p>

          <div className="rounded-xl border border-accent/30 bg-accent-soft p-4 space-y-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <h4 className="text-sm font-semibold text-ink">{t("Handoff package")}</h4>
                <p className="mt-1 text-xs leading-relaxed text-muted">
                  {t("Share the current PRD, task scope, dependencies and verification steps with another tool.")}
                </p>
              </div>
              <span className="shrink-0 rounded-full bg-surface px-2 py-1 text-[10px] font-semibold text-accent-ink">
                {t("Ready to export")}
              </span>
            </div>
            <button type="button" onClick={() => setShowHandoffPreview((value) => !value)} className="btn-outline text-xs">
              {showHandoffPreview ? t("Hide preview") : t("Preview package")}
            </button>
            {showHandoffPreview && (
              <pre className="max-h-56 overflow-auto rounded-lg bg-code p-3 text-[10px] leading-relaxed text-code-ink whitespace-pre-wrap">
                {handoffPreview}
              </pre>
            )}
          </div>

          <div className="space-y-2">
            {documents.map(({ id, available, icon: Icon, title, caption }) => {
              const checked = available && selected.has(id);
              return (
                <label
                  key={id}
                  className={`lift w-full flex items-center justify-between gap-3 p-3 border rounded-lg text-left ${
                    available ? "cursor-pointer hover:bg-subtle" : "cursor-not-allowed opacity-40"
                  } ${checked ? "border-accent/50 bg-accent-soft/40" : "border-line"}`}
                >
                  <span className="flex items-center gap-3 min-w-0">
                    <span className="w-8 h-8 shrink-0 rounded-lg bg-accent-soft text-accent-ink grid place-items-center">
                      <Icon className="w-4 h-4" />
                    </span>
                    <span className="min-w-0">
                      <span className="block font-medium text-xs text-ink truncate">{title}</span>
                      <span className="block text-xs text-faint truncate">{caption}</span>
                    </span>
                  </span>
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={!available}
                    onChange={() => toggle(id)}
                    className="peer sr-only"
                  />
                  <span
                    aria-hidden
                    className={`w-5 h-5 shrink-0 rounded-md border grid place-items-center peer-focus-visible:ring-2 peer-focus-visible:ring-accent ${
                      checked ? "border-accent bg-accent text-white" : "border-line"
                    }`}
                  >
                    {checked && <Check className="w-3.5 h-3.5" />}
                  </span>
                </label>
              );
            })}
          </div>
        </div>

        <div className="px-6 py-4 border-t border-line flex justify-end gap-2">
          <button onClick={onClose} className="btn-outline">
            {t("Close")}
          </button>
          <button onClick={handleExport} disabled={chosen.length === 0} className="btn-primary disabled:opacity-50">
            <Download className="w-4 h-4" />
            {t("Export ({count})", { count: chosen.length })}
          </button>
        </div>
      </div>
    </div>
  );
};
