import React, { useEffect, useRef, useState } from "react";
import type { FeatureSpec, ProjectSession } from "../../types";
import { MermaidViewer, PlanCanvas } from "../lazy";
import { FeatureEditor } from "../FeatureEditor";
import { GenerationProgress } from "../GenerationProgress";
import { generatePrd, generateProjectPlan, isAbort, PipelineModelControl, usePipelineTarget } from "../../lib/generate";
import { complexityLabelKey, normalizeComplexity } from "../../lib/complexity";
import { useT } from "../../lib/i18n";
import { AlertTriangle, ArrowRight, Check, CheckCircle2, Clock, Compass, Cpu, Edit3, Layers, ListTodo, Network, RefreshCw, ShieldCheck, Undo2 } from "lucide-react";
import { readStoredFollowUpAnswers, toTransportAnswers } from "./followups";
import { PlanIntake } from "./PlanIntake";

export interface PlanViewProps {
  session: ProjectSession;
  onUpdateSession: (updated: Partial<ProjectSession>) => void;
  onGoToNextStep: () => void;
}

const sectionTitle = "font-semibold text-ink text-sm flex items-center gap-2";

const provisionalTitle = (idea: string): string => {
  const firstLine = idea.trim().split("\n")[0].trim();
  if (firstLine.length <= 60) return firstLine;
  return firstLine.slice(0, 57).trimEnd() + "...";
};

export const PlanView: React.FC<PlanViewProps> = ({
  session,
  onUpdateSession,
  onGoToNextStep,
}) => {
  const { t, lang } = useT();
  const pipelineTarget = usePipelineTarget();
  const plan = session.plan;
  const [title, setTitle] = useState(session.input.title || "");
  const [description, setDescription] = useState(session.input.description || "");
  const [targetAudience, setTargetAudience] = useState(session.input.targetAudience || "");
  const [techStackPreference, setTechStackPreference] = useState(session.input.techStackPreference || "");
  const [answers, setAnswers] = useState<Record<string, string>>(() =>
    readStoredFollowUpAnswers(session.followUps, session.input.answersToFollowUp),
  );
  const [editingFeatures, setEditingFeatures] = useState(false);
  const [featuresBackup, setFeaturesBackup] = useState<{ features: FeatureSpec[]; wasEdited: boolean } | null>(null);
  const [resyncing, setResyncing] = useState(false);
  const [generatingPrd, setGeneratingPrd] = useState(false);
  const [generationChars, setGenerationChars] = useState(0);
  const [editingInput, setEditingInput] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const resyncAbort = useRef<AbortController | null>(null);
  const prdAbort = useRef<AbortController | null>(null);

  useEffect(() => {
    setTitle(session.input.title || "");
    setDescription(session.input.description || "");
    setTargetAudience(session.input.targetAudience || "");
    setTechStackPreference(session.input.techStackPreference || "");
    setAnswers(readStoredFollowUpAnswers(session.followUps, session.input.answersToFollowUp));
    setEditingFeatures(false);
    setFeaturesBackup(null);
    setErrorMessage(null);
  }, [session.id, session.followUps, session.input.answersToFollowUp]);

  const startEditingFeatures = () => {
    if (!plan) return;
    setFeaturesBackup({
      features: JSON.parse(JSON.stringify(plan.specs.coreFeatures)),
      wasEdited: Boolean(session.planFeaturesEdited),
    });
    setEditingFeatures(true);
  };

  const finishEditingFeatures = () => {
    setFeaturesBackup(null);
    setEditingFeatures(false);
  };

  const cancelEditingFeatures = () => {
    if (featuresBackup && plan) {
      onUpdateSession({
        plan: { ...plan, specs: { ...plan.specs, coreFeatures: featuresBackup.features } },
        planFeaturesEdited: featuresBackup.wasEdited,
      });
    }
    finishEditingFeatures();
  };

  const handleFeaturesChange = (coreFeatures: FeatureSpec[]) => {
    if (!plan) return;
    onUpdateSession({
      plan: { ...plan, specs: { ...plan.specs, coreFeatures } },
      planFeaturesEdited: true,
    });
  };

  const handleResyncPlan = async () => {
    if (!plan) return;

    setErrorMessage(null);
    setResyncing(true);
    setGenerationChars(0);
    const controller = new AbortController();
    resyncAbort.current = controller;

    try {
      const data = await generateProjectPlan({
        title: title || provisionalTitle(description),
        description,
        targetAudience,
        techStackPreference,
        answers: toTransportAnswers(session.followUps, answers),
        lockedFeatures: plan.specs.coreFeatures,
        llmConfig: session.llmConfig,
        language: lang,
      }, lang, controller.signal, setGenerationChars, pipelineTarget);
      onUpdateSession({ plan: data, planFeaturesEdited: false });
      finishEditingFeatures();
    } catch (err: any) {
      if (!isAbort(err)) setErrorMessage(err.message || t("Failed to re-sync the plan."));
    } finally {
      if (resyncAbort.current === controller) resyncAbort.current = null;
      setResyncing(false);
    }
  };

  const handleContinueToPrd = async () => {
    if (session.prd) {
      onGoToNextStep();
      return;
    }

    setErrorMessage(null);
    setGeneratingPrd(true);
    setGenerationChars(0);
    const controller = new AbortController();
    prdAbort.current = controller;

    try {
      const prd = await generatePrd(session, lang, controller.signal, setGenerationChars, pipelineTarget);
      onUpdateSession({ prd });
      onGoToNextStep();
    } catch (err: any) {
      if (!isAbort(err)) setErrorMessage(err.message || t("Something went wrong while generating the PRD."));
    } finally {
      prdAbort.current = null;
      setGeneratingPrd(false);
    }
  };

  if (!plan) return null;

  if (editingInput) {
    return (
      <PlanIntake
        session={session}
        onUpdateSession={onUpdateSession}
        onGoToNextStep={onGoToNextStep}
        initialView="form"
        onPlanGenerated={() => setEditingInput(false)}
        onCancel={() => setEditingInput(false)}
      />
    );
  }

  return (
    <div className="space-y-6 pb-12">
      <div className="max-w-2xl space-y-4">
        <div>
          <h2 className="text-xl font-semibold tracking-tight text-ink">{t("Clarify the idea, architecture, and logic diagram")}</h2>
          <p className="text-muted mt-1.5 leading-relaxed">{t("Start from a rough idea. The AI asks clarifying questions until it is confident enough, then drafts an architecture and diagram for you to review before the PRD.")}</p>
        </div>
        <div className="inline-flex items-center gap-1 p-1 bg-subtle rounded-lg">
          <span className="px-3 py-1.5 rounded-md text-sm font-medium flex items-center gap-1.5 bg-surface text-ink shadow-elev-1"><CheckCircle2 className="w-3.5 h-3.5" /> {t("Architecture review")}</span>
        </div>
      </div>

      {errorMessage && <div className="max-w-3xl p-4 bg-danger-soft border border-danger/30 text-danger-ink rounded-xl text-sm">{errorMessage}</div>}

      <GenerationProgress
        active={generatingPrd}
        label={t("Assembling the PRD & diagram...")}
        chars={generationChars}
        onCancel={() => prdAbort.current?.abort()}
      />

      <div className="space-y-4 animate-in fade-in duration-300">
        <div className="card p-5 flex flex-wrap items-start justify-between gap-5">
          <div className="min-w-0">
            <div className="flex items-center gap-1.5 text-ok text-xs font-medium mb-1.5"><CheckCircle2 className="w-3.5 h-3.5" /> {t("Plan & architecture ready")}</div>
            <h3 className="text-base font-semibold text-ink">{session.input.title || session.title}</h3>
            <p className="text-muted mt-1 max-w-2xl leading-relaxed">{plan.summary}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2 shrink-0">
            <PipelineModelControl />
            <button type="button" onClick={() => setEditingInput(true)} className="btn-ghost"><Edit3 className="w-3.5 h-3.5" /> {t("Edit input")}</button>
            <button type="button" onClick={() => void handleContinueToPrd()} disabled={generatingPrd} className="btn-primary">{t("Continue to the PRD")} <ArrowRight className="w-4 h-4" /></button>
          </div>
        </div>

        {session.planFeaturesEdited && <div className="p-4 bg-warn-soft border border-warn/30 rounded-xl flex flex-wrap items-start justify-between gap-4">
          <div className="flex items-start gap-3 min-w-0"><AlertTriangle className="w-4 h-4 text-warn shrink-0 mt-0.5" /><div className="text-warn-ink leading-relaxed"><strong className="font-semibold block mb-0.5">{t("Features changed; the rest has not caught up.")}</strong>{t("The architecture, diagram, roadmap and estimate still describe the version before your edit. Re-sync so the PRD does not inherit parts that no longer apply.")}</div></div>
          <button type="button" onClick={() => void handleResyncPlan()} disabled={resyncing} className="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-warn text-warn-fg text-sm font-medium hover:brightness-110 transition-[filter,opacity] disabled:opacity-50 shrink-0"><RefreshCw className={`w-4 h-4 ${resyncing ? "animate-spin" : ""}`} />{resyncing ? t("Re-syncing...") : t("Re-sync")}</button>
        </div>}

        <GenerationProgress
          active={resyncing}
          label={t("Re-syncing the plan...")}
          chars={generationChars}
          onCancel={() => resyncAbort.current?.abort()}
        />

        <div className="space-y-2.5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h4 className={sectionTitle}><Network className="w-4 h-4 text-faint" /> {t("Feature structure")}</h4>
            <div className="flex items-center gap-3"><span className="text-xs text-faint">{t("{features} features · {subs} sub features", { features: plan.specs.coreFeatures.length, subs: plan.specs.coreFeatures.reduce((count, feature) => count + (feature.subFeatures?.length || 0), 0) })}</span>{editingFeatures ? <div className="flex items-center gap-1"><button type="button" onClick={cancelEditingFeatures} className="btn-ghost"><Undo2 className="w-3.5 h-3.5" />{t("Cancel edit")}</button><button type="button" onClick={finishEditingFeatures} className="btn-ghost"><Check className="w-3.5 h-3.5" />{t("Done editing")}</button></div> : <button type="button" onClick={startEditingFeatures} className="btn-ghost"><Edit3 className="w-3.5 h-3.5" />{t("Edit features")}</button>}</div>
          </div>
          <PlanCanvas title={session.input.title || session.title || t("Planning")} features={plan.specs.coreFeatures} />
          {editingFeatures && <FeatureEditor features={plan.specs.coreFeatures} onChange={handleFeaturesChange} />}
        </div>

        {plan.architectureDraft.diagramMermaid && <div className="space-y-2.5 pt-2"><h4 className={sectionTitle}><Layers className="w-4 h-4 text-faint" />{t("System logic & architecture diagram")}</h4><MermaidViewer chart={plan.architectureDraft.diagramMermaid} explanation={plan.architectureDraft.dataFlow} title={t("System architecture: {title}", { title: session.input.title || session.title })} /></div>}

        <div className="grid grid-cols-1 @4xl/pane:grid-cols-2 gap-4 pt-2">
          <div className="card p-5 space-y-3"><h4 className={`${sectionTitle} border-b border-line pb-3`}><ListTodo className="w-4 h-4 text-faint" />{t("Core feature priorities")}</h4><div className="space-y-2 max-h-96 overflow-y-auto pr-1">{plan.specs.coreFeatures.map((feature, index) => <div key={index} className="p-3 bg-subtle rounded-lg space-y-1"><div className="flex items-center justify-between gap-3"><span className="font-semibold text-ink text-xs">{feature.name}</span><span className={`text-[11px] font-semibold px-1.5 py-0.5 rounded shrink-0 ${feature.priority === "P0" ? "bg-danger-soft text-danger-ink" : feature.priority === "P1" ? "bg-warn-soft text-warn-ink" : "bg-surface text-muted"}`}>{feature.priority} {feature.priority === "P0" ? t("(MVP)") : ""}</span></div><p className="text-muted leading-relaxed">{feature.description}</p></div>)}</div></div>
          <div className="card p-5 space-y-3"><h4 className={`${sectionTitle} border-b border-line pb-3`}><Cpu className="w-4 h-4 text-faint" />{t("Recommended tech stack")}</h4><div className="space-y-2 max-h-96 overflow-y-auto pr-1">{plan.specs.techStack.map((tech, index) => <div key={index} className="p-3 bg-subtle rounded-lg space-y-1"><div className="flex items-center justify-between gap-3"><span className="text-[11px] font-semibold px-1.5 py-0.5 rounded bg-accent-soft text-accent-ink">{tech.layer}</span><span className="font-semibold text-ink text-xs">{tech.technology}</span></div><p className="text-muted leading-relaxed">{tech.rationale}</p></div>)}</div></div>
        </div>

        <div className="card p-5 space-y-5"><h4 className={sectionTitle}><Layers className="w-4 h-4 text-faint" />{t("Component & security detail")}</h4><div><p className="text-xs font-medium text-faint mb-1.5">{t("Architecture overview")}</p><p className="text-muted leading-relaxed max-w-4xl">{plan.architectureDraft.overview}</p></div><div className="grid grid-cols-1 @2xl/pane:grid-cols-2 gap-5"><div className="space-y-2"><p className="text-xs font-medium text-faint">{t("Main components")}</p><ul className="space-y-2">{plan.architectureDraft.components.map((component, index) => <li key={index} className="bg-subtle p-3 rounded-lg"><div className="flex items-center justify-between gap-3"><span className="font-medium text-ink">{component.name}</span><span className="text-xs text-faint font-mono shrink-0">{component.type}</span></div><div className="text-muted mt-0.5">{component.purpose}</div></li>)}</ul></div><div className="space-y-5"><div><p className="text-xs font-medium text-faint mb-1.5">{t("Data flow")}</p><p className="text-muted leading-relaxed">{plan.architectureDraft.dataFlow}</p></div><div><p className="text-xs font-medium text-faint mb-1.5 flex items-center gap-1.5"><ShieldCheck className="w-3.5 h-3.5" />{t("Security & authentication")}</p><p className="text-muted leading-relaxed">{plan.architectureDraft.securityAndAuth}</p></div></div></div></div>

        <div className="grid grid-cols-1 @4xl/pane:grid-cols-3 gap-4"><div className="@4xl/pane:col-span-2 card p-5 space-y-4"><h4 className={sectionTitle}><Compass className="w-4 h-4 text-faint" />{t("Delivery roadmap")}</h4><ol className="space-y-4">{plan.roadmap.map((phase, index) => <li key={index} className="flex gap-3"><span className="w-5 h-5 shrink-0 rounded-md bg-subtle text-muted text-[11px] font-semibold grid place-items-center">{index + 1}</span><div className="min-w-0"><div className="flex flex-wrap items-baseline gap-x-2.5"><span className="font-medium text-ink">{phase.title}</span><span className="text-xs text-faint">{phase.duration}</span></div><ul className="mt-1 space-y-1 text-muted">{phase.deliverables.map((deliverable, deliverableIndex) => <li key={deliverableIndex} className="flex gap-2"><span className="text-faint">&middot;</span>{deliverable}</li>)}</ul></div></li>)}</ol></div><div className="card p-5 space-y-4"><h4 className={sectionTitle}><Clock className="w-4 h-4 text-faint" />{t("Estimate & resources")}</h4><div className="grid grid-cols-2 gap-3"><div className="bg-subtle rounded-lg p-3"><p className="text-xs font-medium text-faint">{t("Total estimate")}</p><p className="text-base font-semibold text-ink mt-0.5">{plan.estimation.totalTimeWeeks}</p></div><div className="bg-subtle rounded-lg p-3"><p className="text-xs font-medium text-faint">{t("Complexity")}</p><p className="text-base font-semibold text-ink mt-0.5">{t(complexityLabelKey(normalizeComplexity(plan.estimation.complexityLevel)))}</p></div></div><div><p className="text-xs font-medium text-faint mb-1.5">{t("Resources needed")}</p><ul className="space-y-1 text-muted">{plan.estimation.requiredResources.map((resource, index) => <li key={index} className="flex gap-2"><span className="text-faint">&middot;</span>{resource}</li>)}</ul></div></div></div>
      </div>

    </div>
  );
};

export default PlanView;
