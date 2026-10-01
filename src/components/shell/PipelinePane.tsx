import React, { Suspense } from "react";
import { Check } from "lucide-react";
import type { AgentTask, ProjectSession } from "../../types";
import { isStepReachable, STEP_PATHS, Step } from "../../lib/routing";
import { useT } from "../../lib/i18n";
import { PipelineModelControlContext, PipelineTargetContext } from "../../lib/generate";
import { legacyRuntimeSelection, type RuntimeChatSelection } from "../../lib/runtimeChat";

const Step1Plan = React.lazy(() =>
  import("../Step1Plan").then((module) => ({ default: module.Step1Plan }))
);
const Step2PRD = React.lazy(() => import("../Step2PRD").then((module) => ({ default: module.Step2PRD })));
const Step3AgentTasks = React.lazy(() =>
  import("../Step3AgentTasks").then((module) => ({ default: module.Step3AgentTasks }))
);

export interface PipelinePaneProps {
  step: Step;
  session: ProjectSession;
  onUpdateSession: (updated: Partial<ProjectSession>) => void;
  onGoToNextStep: () => void;
  onSelectStep: (step: Step) => void;
  onSelectAgent?: () => void;
  onRunTask?: (task: AgentTask) => void;
  runningTaskId?: string | null;
  /** A warning for the card whose run failed and is being tried again. */
  retryNotice?: { taskId: string; text: string } | null;
  /** The model Plan, PRD, and tasks are generated with, and its picker. */
  generationTarget?: RuntimeChatSelection;
  modelControl?: React.ReactNode;
}

const tabs: { step: Step; label: string; path: string }[] = [
  { step: 1, label: "Plan", path: STEP_PATHS[1] },
  { step: 2, label: "PRD", path: STEP_PATHS[2] },
  { step: 3, label: "Kanban", path: STEP_PATHS[3] },
];

export const PaneSkeleton: React.FC = () => (
  <div className="space-y-6 animate-pulse" aria-label="Loading pipeline step">
    <div className="h-8 w-2/5 rounded-lg bg-subtle" />
    <div className="h-4 w-4/5 rounded bg-subtle" />
    <div className="h-4 w-3/5 rounded bg-subtle" />
    <div className="grid gap-4 @2xl/pane:grid-cols-2">
      <div className="h-36 rounded-xl border border-line bg-subtle" />
      <div className="h-36 rounded-xl border border-line bg-subtle" />
    </div>
  </div>
);

interface TabStripProps {
  step: Step;
  session: ProjectSession;
  onSelectStep: (step: Step) => void;
  onSelectAgent?: () => void;
}

export const TabStrip: React.FC<TabStripProps> = ({ step, session, onSelectStep, onSelectAgent }) => {
  const { t } = useT();

  return (
    <nav
      aria-label={t("Project context")}
      className="shell-pane-tabs sticky top-0 z-20 flex shrink-0 gap-1 overflow-x-auto border-b border-line bg-canvas/95 px-4 backdrop-blur @3xl/pane:px-8"
    >
      <button
        type="button"
        aria-label={t("Chat")}
        onClick={onSelectAgent}
        className="inline-flex min-w-max items-center gap-1.5 border-b-2 border-transparent px-3 py-3 text-sm font-medium text-muted transition-colors hover:border-line hover:text-ink"
      >
        {t("Chat")}
      </button>
      {tabs.filter((tab) => tab.step === 1 ? step === 1 : true).map((tab) => {
        const reachable = isStepReachable(tab.step, session);
        const active = step === tab.step;
        const label = t(tab.label);

        return (
          <button
            key={tab.path}
            type="button"
            aria-current={active ? "page" : undefined}
            aria-label={`${label} (${tab.path})`}
            title={tab.path}
            onClick={() => {
              if (reachable) onSelectStep(tab.step);
            }}
            className={`inline-flex min-w-max items-center gap-1.5 border-b-2 px-3 py-3 text-sm font-medium transition-colors ${
              active
                ? "border-accent text-accent-ink"
                : reachable
                  ? "border-transparent text-muted hover:border-line hover:text-ink"
                  : "cursor-not-allowed border-transparent text-faint"
            }`}
          >
            {reachable && tab.step < step && <Check className="h-3.5 w-3.5" aria-hidden />}
            {label}
          </button>
        );
      })}
    </nav>
  );
};

export const PipelinePane: React.FC<PipelinePaneProps> = ({
  step,
  session,
  onUpdateSession,
  onGoToNextStep,
  onSelectStep,
  onSelectAgent,
  onRunTask,
  runningTaskId,
  retryNotice,
  generationTarget = legacyRuntimeSelection(),
  modelControl,
}) => (
  <div className="shell-project-pane @container/pane flex min-h-0 flex-1 min-w-0 flex-col overflow-y-auto">
    <TabStrip step={step} session={session} onSelectStep={onSelectStep} onSelectAgent={onSelectAgent} />
    <div className="shell-project-content px-4 py-8 @3xl/pane:px-8">
      <PipelineTargetContext.Provider value={generationTarget}>
      <PipelineModelControlContext.Provider value={modelControl}>
      <Suspense fallback={<PaneSkeleton />}>
        {step === 1 && (
          <Step1Plan
            session={session}
            onUpdateSession={onUpdateSession}
            onGoToNextStep={onGoToNextStep}
          />
        )}
        {step === 2 && (
          <Step2PRD session={session} onUpdateSession={onUpdateSession} onGoToNextStep={onGoToNextStep} />
        )}
        {step === 3 && (
          <Step3AgentTasks
            session={session}
            onUpdateSession={onUpdateSession}
            onRunTask={onRunTask}
            runningTaskId={runningTaskId}
            retryNotice={retryNotice}
            onSelectStep={onSelectStep}
          />
        )}
      </Suspense>
      </PipelineModelControlContext.Provider>
      </PipelineTargetContext.Provider>
    </div>
  </div>
);

export default PipelinePane;
