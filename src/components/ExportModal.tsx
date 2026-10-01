import React, { useEffect, useRef } from "react";
import { ProjectSession } from "../types";
import { X, Download, FileText, Compass, Bot, FileCode, CheckCircle2 } from "lucide-react";
import { complexityLabelKey, normalizeComplexity } from "../lib/complexity";
import { useT } from "../lib/i18n";
import { agentsMarkdownFilename, buildAgentsMarkdown } from "../lib/agentsMd";
import { downloadFile } from "../lib/download";
import { stripLocalOnlyFields } from "../lib/sessionStore";
import {
  buildHandoffJson,
  buildHandoffMarkdown,
  handoffJsonFilename,
  handoffMarkdownFilename,
} from "../lib/handoff";

interface ExportModalProps {
  isOpen: boolean;
  onClose: () => void;
  session: ProjectSession;
}

export const ExportModal: React.FC<ExportModalProps> = ({ isOpen, onClose, session }) => {
  const { t } = useT();
  const [showHandoffPreview, setShowHandoffPreview] = React.useState(false);
  const closeButton = useRef<HTMLButtonElement>(null);

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

  const handleDownloadPlan = () => {
    if (!session.plan) return;
    let md = `# PROJECT PLAN & ARCHITECTURE SPECIFICATION: ${projectTitle.toUpperCase()}\n\n`;
    md += `## SUMMARY\n${session.plan.summary}\n\n`;
    md += `## CORE FEATURES\n`;
    session.plan.specs.coreFeatures.forEach((f) => {
      md += `- **[${f.priority}] ${f.name}**: ${f.description}\n`;
    });
    md += `\n## RECOMMENDED TECH STACK\n`;
    session.plan.specs.techStack.forEach((t) => {
      md += `- **${t.layer}**: ${t.technology} (${t.rationale})\n`;
    });
    md += `\n## ARCHITECTURE DRAFT\n${session.plan.architectureDraft.overview}\n\n`;
    md += `### Data Flow\n${session.plan.architectureDraft.dataFlow}\n\n`;
    md += `### Security & Auth\n${session.plan.architectureDraft.securityAndAuth}\n\n`;
    md += `## ROADMAP\n`;
    session.plan.roadmap.forEach((r) => {
      md += `### ${r.title} (${r.duration})\n`;
      r.deliverables.forEach((d) => (md += `- ${d}\n`));
      md += `\n`;
    });
    md += `## ESTIMATION & RESOURCES\n`;
    md += `- Total Time: ${session.plan.estimation.totalTimeWeeks}\n`;
    md += `- Complexity: ${t(complexityLabelKey(normalizeComplexity(session.plan.estimation.complexityLevel)))}\n`;

    downloadFile(`PLAN_${slug}.md`, md, "text/markdown");
  };

  const handleDownloadPrd = () => {
    if (!session.prd?.fullMarkdownText) return;
    downloadFile(`PRD_${slug}.md`, session.prd.fullMarkdownText, "text/markdown");
  };

  const handleDownloadTasks = () => {
    if (!session.tasks) return;
    downloadFile(agentsMarkdownFilename(session), buildAgentsMarkdown(session), "text/markdown");
  };

  const handleDownloadJsonBackup = () => {
    const jsonStr = JSON.stringify(stripLocalOnlyFields(session), null, 2);
    downloadFile(`PROJECT_BUNDLE_${slug}.json`, jsonStr, "application/json");
  };

  const handleDownloadHandoffJson = () => {
    downloadFile(handoffJsonFilename(session), buildHandoffJson(session), "application/json");
  };

  const handleDownloadHandoffMarkdown = () => {
    downloadFile(handoffMarkdownFilename(session), buildHandoffMarkdown(session), "text/markdown");
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
            {t("Download the planning artifacts. Pick a single document, or export the whole session as JSON.")}
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
            <div className="flex flex-wrap gap-2">
              <button type="button" onClick={() => setShowHandoffPreview((value) => !value)} className="btn-outline text-xs">
                {showHandoffPreview ? t("Hide preview") : t("Preview package")}
              </button>
              <button type="button" onClick={handleDownloadHandoffJson} className="btn-primary text-xs">
                <Download className="w-3.5 h-3.5" /> {t("Download handoff (.json)")}
              </button>
              <button type="button" onClick={handleDownloadHandoffMarkdown} className="btn-ghost text-xs">
                <FileText className="w-3.5 h-3.5" /> {t("Download handoff (.md)")}
              </button>
            </div>
            {showHandoffPreview && (
              <pre className="max-h-56 overflow-auto rounded-lg bg-code p-3 text-[10px] leading-relaxed text-code-ink whitespace-pre-wrap">
                {handoffPreview}
              </pre>
            )}
          </div>

          <div className="space-y-2">
            {[
              {
                onClick: handleDownloadPlan,
                disabled: !session.plan,
                icon: Compass,
                title: t("Project plan & architecture (.md)"),
                caption: t("Specification, tech stack, and roadmap."),
              },
              {
                onClick: handleDownloadPrd,
                disabled: !session.prd,
                icon: FileText,
                title: t("Product requirement document (.md)"),
                caption: t("The full PRD including its logic diagram."),
              },
              {
                onClick: handleDownloadTasks,
                disabled: !session.tasks,
                icon: Bot,
                title: t("AI agent executable tasks (AGENTS.md)"),
                caption: t("Atomic tasks ready to hand to an AI coding agent."),
              },
              {
                onClick: handleDownloadJsonBackup,
                disabled: false,
                icon: FileCode,
                title: t("Full backup of the project session (.json)"),
                caption: t("Model credentials are not included in this backup."),
              },
            ].map(({ onClick, disabled, icon: Icon, title, caption }) => (
              <button
                key={title}
                onClick={onClick}
                disabled={disabled}
                className="lift w-full flex items-center justify-between gap-3 p-3 border border-line hover:bg-subtle rounded-lg text-left disabled:opacity-40 disabled:hover:bg-transparent"
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
                <Download className="w-4 h-4 text-faint shrink-0" />
              </button>
            ))}
          </div>
        </div>

        <div className="px-6 py-4 border-t border-line flex justify-end">
          <button onClick={onClose} className="btn-outline">
            {t("Close")}
          </button>
        </div>
      </div>
    </div>
  );
};
