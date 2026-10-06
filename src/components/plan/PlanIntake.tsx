// Copyright (c) 2026 Charis Chakim - Undagi (https://github.com/CharisChakim/undagi)
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import React, { useEffect, useRef, useState } from "react";
import type { ProjectSession, FollowUpQuestion } from "../../types";
import { GenerationProgress } from "../GenerationProgress";
import { ClarificationReadyDialog } from "./ClarificationReadyDialog";
import {
  Check,
  CheckCircle2,
  Edit3,
  HelpCircle,
  Layers,
  RefreshCw,
  Sparkles,
  Wand2,
  Zap,
} from "lucide-react";
import { useT } from "../../lib/i18n";
import { useDraft } from "../../lib/draftStore";
import { generateFollowUpQuestions, generateProjectPlan, isAbort, PipelineModelControl, usePipelineTarget } from "../../lib/generate";
import {
  createFollowUpState,
  getFollowUpOptions,
  getPrefilledFollowUpAnswer,
  mergeFollowUpQuestions,
  mergeFollowUpRound,
  toTransportAnswers,
  type FollowUpState,
} from "./followups";

export interface PlanIntakeProps {
  session: ProjectSession;
  onUpdateSession: (updated: Partial<ProjectSession>) => void;
  onGoToNextStep: () => void;
  initialView?: IntakeView;
  onPlanGenerated?: () => void;
  onCancel?: () => void;
}

const sectionTitle = "font-semibold text-ink text-sm flex items-center gap-2";

const provisionalTitle = (idea: string): string => {
  const firstLine = idea.trim().split("\n")[0].trim();
  if (firstLine.length <= 60) return firstLine;
  return firstLine.slice(0, 57).trimEnd() + "...";
};

type IntakeView = "form" | "clarify";

export const PlanIntake: React.FC<PlanIntakeProps> = ({
  session,
  onUpdateSession,
  initialView,
  onPlanGenerated,
  onCancel,
}) => {
  const { t, lang } = useT();
  const pipelineTarget = usePipelineTarget();
  const [title, setTitle, clearTitleDraft] = useDraft(
    { sessionId: session.id, name: "plan-title" },
    session.input.title || "",
  );
  const [description, setDescription, clearDescriptionDraft] = useDraft(
    { sessionId: session.id, name: "plan-description" },
    session.input.description || "",
  );
  const [targetAudience, setTargetAudience, clearTargetAudienceDraft] = useDraft(
    { sessionId: session.id, name: "plan-target-audience" },
    session.input.targetAudience || "",
  );
  const [techStackPreference, setTechStackPreference, clearTechStackDraft] = useDraft(
    { sessionId: session.id, name: "plan-tech-stack" },
    session.input.techStackPreference || "",
  );
  const [followUpState, setFollowUpState, clearFollowUpDraft] = useDraft<FollowUpState>(
    { sessionId: session.id, name: "plan-follow-ups" },
    createFollowUpState(session.followUps, session.input.answersToFollowUp),
  );
  const [loadingQuestions, setLoadingQuestions] = useState(false);
  const [loadingPlan, setLoadingPlan] = useState(false);
  const [generationChars, setGenerationChars] = useState(0);
  const [readyDialog, setReadyDialog] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [subView, setSubView] = useState<IntakeView>(initialView || (session.followUps.length > 0 ? "clarify" : "form"));
  const generationAbort = useRef<AbortController | null>(null);

  const { questions, answers, customAnswerActive } = followUpState;

  useEffect(() => {
    setErrorMessage(null);
  }, [session.id]);

  useEffect(() => {
    if (session.followUps.length > 0 && !session.plan) setSubView("clarify");
  }, [session.id, session.followUps.length, session.plan]);

  const requestFollowUps = async (isFirstRound: boolean) => {
    if (!description.trim()) {
      setErrorMessage(t("Enter a project description first."));
      return;
    }

    setErrorMessage(null);
    setLoadingQuestions(true);
    setGenerationChars(0);
    const controller = new AbortController();
    generationAbort.current = controller;

    try {
      const nextRound = isFirstRound ? 1 : (session.clarificationRound || 1) + 1;
      const data = await generateFollowUpQuestions({
        title: title || provisionalTitle(description),
        description,
        targetAudience,
        techStackPreference,
        previousAnswers: isFirstRound ? {} : toTransportAnswers(questions, answers),
        round: nextRound,
        llmConfig: session.llmConfig,
        language: lang,
      }, lang, controller.signal, setGenerationChars, pipelineTarget);

      const newQuestions: FollowUpQuestion[] = data.questions || [];
      const nextState = isFirstRound
        ? createFollowUpState(newQuestions)
        : mergeFollowUpRound(followUpState, newQuestions);
      const mergedQuestions = isFirstRound
        ? newQuestions
        : mergeFollowUpQuestions(session.followUps, newQuestions);
      const transportAnswers = toTransportAnswers(mergedQuestions, nextState.answers);

      setFollowUpState(nextState);
      onUpdateSession({
        input: {
          title,
          description,
          targetAudience,
          techStackPreference,
          answersToFollowUp: transportAnswers,
        },
        followUps: mergedQuestions,
        clarificationRound: nextRound,
        clarificationComplete: data.needsMoreInfo === false,
        readinessNote: data.readinessNote || "",
      });

      // A first round with nothing to ask leaves no question cards to show.
      if (isFirstRound && newQuestions.length > 0) setSubView("clarify");
      if (data.needsMoreInfo === false) setReadyDialog(true);
    } catch (err: any) {
      if (!isAbort(err)) setErrorMessage(err.message || t("Something went wrong talking to the LLM."));
    } finally {
      if (generationAbort.current === controller) generationAbort.current = null;
      setLoadingQuestions(false);
    }
  };

  const handleAnalyzeQuestions = (event?: React.FormEvent) => {
    event?.preventDefault();
    void requestFollowUps(true);
  };

  const handleGeneratePlan = async () => {
    setErrorMessage(null);
    setLoadingPlan(true);
    setGenerationChars(0);
    const controller = new AbortController();
    generationAbort.current = controller;

    try {
      const data = await generateProjectPlan({
        title: title || provisionalTitle(description),
        description,
        targetAudience,
        techStackPreference,
        answers: toTransportAnswers(questions, answers),
        llmConfig: session.llmConfig,
        language: lang,
      }, lang, controller.signal, setGenerationChars, pipelineTarget);

      const resolvedTitle = title.trim() || (data.suggestedTitle || "").trim() || provisionalTitle(description);
      onUpdateSession({
        title: resolvedTitle,
        input: {
          title: resolvedTitle,
          description,
          targetAudience,
          techStackPreference,
          answersToFollowUp: toTransportAnswers(questions, answers),
        },
        plan: data,
        planFeaturesEdited: false,
      });
      clearTitleDraft();
      clearDescriptionDraft();
      clearTargetAudienceDraft();
      clearTechStackDraft();
      clearFollowUpDraft();
      onPlanGenerated?.();
    } catch (err: any) {
      if (!isAbort(err)) setErrorMessage(err.message || t("Failed to generate the project plan."));
    } finally {
      if (generationAbort.current === controller) generationAbort.current = null;
      setLoadingPlan(false);
    }
  };

  const handleSelectOption = (questionId: string, selectedOption: string) => {
    setFollowUpState((previous) => ({
      ...previous,
      answers: { ...previous.answers, [questionId]: selectedOption },
      customAnswerActive: { ...previous.customAnswerActive, [questionId]: false },
    }));
  };

  const handleFillAllSuggested = () => {
    const nextAnswers = { ...answers };
    questions.forEach((question) => {
      nextAnswers[question.id] = getPrefilledFollowUpAnswer(question);
    });
    setFollowUpState((previous) => ({ ...previous, answers: nextAnswers }));
  };

  return (
    <div className="space-y-6 pb-12">
      <div className="space-y-4">
        <div className="max-w-2xl">
          <h2 className="text-xl font-semibold tracking-tight text-ink">
            {t("Clarify the idea, architecture, and logic diagram")}
          </h2>
          <p className="text-muted mt-1.5 leading-relaxed">
            {t(
              "Start from a rough idea. The AI asks clarifying questions until it is confident enough, then drafts an architecture and diagram for you to review before the PRD.",
            )}
          </p>
        </div>

        {onCancel && (
          <button type="button" onClick={onCancel} className="btn-ghost w-fit">
            {t("Back to plan")}
          </button>
        )}

        {questions.length > 0 && (
          <div className="inline-flex items-center gap-1 p-1 bg-subtle rounded-lg">
            <button
              type="button"
              onClick={() => setSubView("form")}
              className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors flex items-center gap-1.5 ${
                subView === "form" ? "bg-surface text-ink shadow-elev-1" : "text-muted hover:text-ink"
              }`}
            >
              <Edit3 className="w-3.5 h-3.5" /> {t("Project data")}
            </button>
            <button
              type="button"
              onClick={() => setSubView("clarify")}
              className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors flex items-center gap-1.5 ${
                subView === "clarify" ? "bg-surface text-ink shadow-elev-1" : "text-muted hover:text-ink"
              }`}
            >
              <HelpCircle className="w-3.5 h-3.5" /> {t("Clarification")}
            </button>
          </div>
        )}
      </div>

      {errorMessage && <div className="max-w-3xl p-4 bg-danger-soft border border-danger/30 text-danger-ink rounded-xl text-sm">{errorMessage}</div>}

      <GenerationProgress
        active={loadingQuestions || loadingPlan}
        label={loadingPlan ? t("Drafting the architecture & diagram...") : subView === "clarify" ? t("Reviewing your answers...") : t("Analysing your idea...")}
        chars={generationChars}
        onCancel={() => generationAbort.current?.abort()}
      />

      {subView === "form" && (
        <div className="grid grid-cols-1 @5xl/pane:grid-cols-[minmax(0,2fr)_minmax(0,1fr)] gap-4 items-start max-w-none">
          <form onSubmit={handleAnalyzeQuestions} className="card p-6 space-y-5">
            <div className="grid grid-cols-1 @2xl/pane:grid-cols-2 gap-5">
              <div>
                <label className="field-label">{t("Project title")}</label>
                <input type="text" value={title} onChange={(event) => setTitle(event.target.value)} placeholder={t("e.g. AI Code Reviewer Bot")} className="field" />
                <p className="field-hint">{t("Leave empty and the AI proposes a title.")}</p>
              </div>
              <div>
                <label className="field-label">{t("Target users")}</label>
                <input type="text" value={targetAudience} onChange={(event) => setTargetAudience(event.target.value)} placeholder={t("e.g. tech leads, students, shop cashiers")} className="field" />
                <p className="field-hint">{t("Optional.")}</p>
              </div>
            </div>

            <div>
              <label className="field-label">{t("Detailed project description")} <span className="text-danger">*</span></label>
              <textarea rows={5} value={description} onChange={(event) => setDescription(event.target.value)} placeholder={t("Describe your idea: the problem it solves, the main features you picture, and how it works.")} className="field leading-relaxed resize-y" />
            </div>

            <div>
              <label className="field-label">{t("Preferred tech stack")}</label>
              <input type="text" value={techStackPreference} onChange={(event) => setTechStackPreference(event.target.value)} placeholder={t("e.g. React, Node.js, PostgreSQL")} className="field" />
              <p className="field-hint">{t("Optional. Leave empty and the AI recommends one.")}</p>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3 -mx-6 -mb-6 px-6 py-4 border-t border-line">
              <PipelineModelControl />
              <button type="submit" disabled={loadingQuestions || !description.trim()} className="btn-primary shrink-0">
                {loadingQuestions ? <><RefreshCw className="w-4 h-4 animate-spin" /> {t("Analysing...")}</> : <><Wand2 className="w-4 h-4" /> {t("Analyse the idea & draft questions")}</>}
              </button>
            </div>
          </form>

          <aside className="space-y-4">
            <div className="card p-5 space-y-3">
              <h3 className={sectionTitle}><Wand2 className="w-4 h-4 text-faint" /> {t("What makes a good description")}</h3>
              <ul className="space-y-2 text-xs text-muted leading-relaxed">
                {[t("Name the problem it solves, and who runs into it."), t("List the features you already picture, even roughly."), t("Mention hard constraints: an existing stack, a deadline, something you must not use."), t("The more you put here, the fewer clarification rounds the AI needs.")].map((tip) => <li key={tip} className="flex gap-2"><span className="text-faint shrink-0">&middot;</span>{tip}</li>)}
              </ul>
            </div>
          </aside>
        </div>
      )}

      {subView === "clarify" && questions.length > 0 && (
        <div className="grid grid-cols-1 @5xl/pane:grid-cols-[minmax(0,2fr)_minmax(0,1fr)] gap-4 items-start max-w-none">
          <div className="space-y-4">
            <div className="flex flex-wrap items-end justify-between gap-4">
              <div>
                <h3 className={sectionTitle}><HelpCircle className="w-4 h-4 text-faint" /> {t("Clarification from the AI")}</h3>
                <p className="text-xs text-faint mt-1">{t("Pick one of the options, or write your own if none of them fit.")}</p>
              </div>
              <button type="button" onClick={handleFillAllSuggested} className="btn-outline text-xs"><Zap className="w-3.5 h-3.5 text-faint" /> {t("Use the AI recommendations")}</button>
            </div>

            {session.readinessNote && <div className={`p-3.5 rounded-xl border text-xs flex items-start gap-2.5 ${session.clarificationComplete ? "bg-ok-soft border-ok/30 text-ok-ink" : "bg-warn-soft border-warn/30 text-warn-ink"}`}>
              {session.clarificationComplete ? <CheckCircle2 className="w-4 h-4 text-ok shrink-0 mt-0.5" /> : <HelpCircle className="w-4 h-4 text-warn shrink-0 mt-0.5" />}
              <div className="leading-relaxed"><strong className="font-semibold block mb-0.5">{session.clarificationComplete ? t("Round {round}: the AI considers the information sufficient.", { round: session.clarificationRound ?? 1 }) : t("Round {round}: the AI still has questions.", { round: session.clarificationRound ?? 1 })}</strong>{session.readinessNote}</div>
            </div>}

            <div className="space-y-3">
              {questions.map((question, index) => {
                const currentAnswer = answers[question.id] || "";
                const isCustom = customAnswerActive[question.id] || false;
                const options = getFollowUpOptions(question);
                return <div key={question.id || index} className="card p-5 space-y-3">
                  <div className="space-y-1.5"><div className="flex items-center gap-1.5"><span className="inline-block px-1.5 py-0.5 rounded bg-accent-soft text-accent-ink text-[11px] font-semibold">{question.category}</span>{question.round && question.round > 1 && <span className="inline-block px-1.5 py-0.5 rounded bg-subtle text-muted text-[11px] font-semibold">{t("Round {round}", { round: question.round })}</span>}</div><h4 className="font-semibold text-ink text-sm">{question.question}</h4><p className="text-xs text-faint leading-relaxed">{question.explanation}</p></div>
                  <div className="flex flex-wrap gap-2">{options.map((option, optionIndex) => { const selected = !isCustom && currentAnswer === option; return <button key={optionIndex} type="button" onClick={() => handleSelectOption(question.id, option)} className={`px-3 py-1.5 rounded-lg text-xs font-medium border text-left transition-colors flex items-center gap-2 ${selected ? "bg-accent text-accent-fg border-accent" : "bg-subtle text-muted border-line hover:text-ink"}`}>{selected ? <Check className="w-3.5 h-3.5 shrink-0" /> : <span className="w-1.5 h-1.5 rounded-full bg-strong shrink-0" />}<span>{option}</span></button>; })}<button type="button" onClick={() => setFollowUpState((previous) => ({ ...previous, customAnswerActive: { ...previous.customAnswerActive, [question.id]: true } }))} className={`px-3 py-1.5 rounded-lg text-xs font-medium border text-left transition-colors flex items-center gap-2 ${isCustom ? "bg-ink text-canvas border-ink" : "bg-surface text-muted border-line hover:text-ink"}`}><Edit3 className="w-3.5 h-3.5 shrink-0" /><span>{t("My own answer")}</span></button></div>
                  {isCustom && <input type="text" value={currentAnswer} onChange={(event) => setFollowUpState((previous) => ({ ...previous, answers: { ...previous.answers, [question.id]: event.target.value } }))} placeholder={t("Type your own answer here...")} className="field animate-in fade-in" />}
                </div>;
              })}
            </div>

            <div className="flex flex-wrap items-center justify-end gap-2 pt-1">
              <div className="mr-auto"><PipelineModelControl /></div>
              <button type="button" onClick={() => void requestFollowUps(false)} disabled={loadingQuestions || loadingPlan} className={session.clarificationComplete ? "btn-ghost" : "btn-outline"} title={t("Send the current answers so the AI can judge whether anything is still missing")}>{loadingQuestions ? <><RefreshCw className="w-4 h-4 animate-spin" /> {t("Reviewing your answers...")}</> : <><HelpCircle className="w-4 h-4" /> {t("Continue clarifying (round {round})", { round: (session.clarificationRound || 1) + 1 })}</>}</button>
              <button type="button" onClick={() => void handleGeneratePlan()} disabled={loadingPlan || loadingQuestions} className="btn-primary">{loadingPlan ? <><RefreshCw className="w-4 h-4 animate-spin" /> {t("Drafting the architecture & diagram...")}</> : <><Sparkles className="w-4 h-4" /> {t("Generate project plan")}</>}</button>
            </div>
          </div>

          <aside className="space-y-4">
            <div className="card p-5 space-y-3"><div className="flex items-start justify-between gap-2"><h3 className={sectionTitle}><Edit3 className="w-4 h-4 text-faint" /> {t("Your project")}</h3><button type="button" onClick={() => setSubView("form")} className="btn-ghost !py-1 !px-2 text-xs shrink-0">{t("Fill in manually")}</button></div><div><p className="text-xs font-medium text-faint mb-0.5">{t("Project title")}</p><p className="text-xs text-ink">{title || t("Untitled project")}</p></div><div><p className="text-xs font-medium text-faint mb-0.5">{t("Detailed project description")}</p><p className="text-xs text-muted leading-relaxed max-h-40 overflow-y-auto">{description}</p></div>{targetAudience && <div><p className="text-xs font-medium text-faint mb-0.5">{t("Target users")}</p><p className="text-xs text-muted">{targetAudience}</p></div>}{techStackPreference && <div><p className="text-xs font-medium text-faint mb-0.5">{t("Preferred tech stack")}</p><p className="text-xs text-muted">{techStackPreference}</p></div>}</div>
            <div className="card p-5 space-y-2"><h3 className={sectionTitle}><HelpCircle className="w-4 h-4 text-faint" /> {t("What happens next")}</h3><p className="text-xs text-muted leading-relaxed">{t("Answer what you can, then generate the plan. If the AI still has gaps it will say so above, and one more round costs you nothing but a minute.")}</p></div>
          </aside>
        </div>
      )}

      {readyDialog && (
        <ClarificationReadyDialog
          note={session.readinessNote || ""}
          onClose={() => setReadyDialog(false)}
          onGenerate={() => {
            setReadyDialog(false);
            void handleGeneratePlan();
          }}
        />
      )}
    </div>
  );
};

export default PlanIntake;
