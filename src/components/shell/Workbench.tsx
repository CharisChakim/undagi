import React from "react";
import { AlertTriangle, Bot } from "lucide-react";
import type { AgentTask, PermissionMode, ProjectSession, SessionUpdate } from "../../types";
import { isStepReachable, Step } from "../../lib/routing";
import { LayoutMode } from "../../lib/layout";
import { useT } from "../../lib/i18n";
import { useAgentRun } from "../../lib/useAgentRun";
import { applyTaskOutcome } from "../../lib/taskOutcome";
import { readableRunError, runWithRetries, type RunReport } from "../../lib/runRetry";
import { useRuntimeDiscovery } from "../../lib/runtimes";
import {
  defaultAwaitsDiscovery,
  defaultRuntimeSelection,
  hasRuntimeSelection,
  loadLastRuntimeSelection,
  loadPipelineSelection,
  loadRuntimeSelection,
  savePipelineSelection,
  saveRuntimeSelection,
  type RuntimeChatSelection,
} from "../../lib/runtimeChat";
import { useConnections } from "../../lib/connections";
import { AgentPane } from "../agent/AgentPane";
import { RuntimeControls } from "../agent/RuntimeControls";
import type { AgentHarnessSettings } from "../../lib/agentHarness";
import { PipelinePane } from "./PipelinePane";
import { Splitter } from "./Splitter";

export interface WorkbenchProps {
  session: ProjectSession;
  storeError?: string | null;
  onDismissStoreError?: () => void;
  onUpdateSession: (update: SessionUpdate) => void;
  onWorkspaceSelected: (workspaceRoot: string) => void | Promise<void>;
  onSelectStep: (step: Step) => void;
  onToolApplied?: () => void | Promise<void>;
  layoutMode: LayoutMode;
  ratio: number;
  onLayoutModeChange: (mode: LayoutMode) => void;
  onRatioChange: (ratio: number) => void;
  onRatioCommit: (ratio: number) => void;
  onOpenConnections?: () => void;
  harnessSettings: AgentHarnessSettings;
}

const stepLabel = (step: Step, t: ReturnType<typeof useT>["t"]): string => {
  if (step === 1) return t("Plan");
  if (step === 2) return t("PRD");
  return t("Send to Agent");
};

export const Workbench: React.FC<WorkbenchProps> = ({
  session,
  storeError,
  onDismissStoreError,
  onUpdateSession,
  onWorkspaceSelected,
  onSelectStep,
  onToolApplied,
  layoutMode,
  ratio,
  onLayoutModeChange,
  onRatioChange,
  onRatioCommit,
  onOpenConnections,
  harnessSettings,
}) => {
  const { t } = useT();
  const inProgressTasks = (session.tasks ?? []).filter((task) => task.status === "in_progress").length;
  const [runningTaskId, setRunningTaskId] = React.useState<string | null>(null);
  const [retryNotice, setRetryNotice] = React.useState<{ taskId: string; text: string } | null>(null);
  // Read when a retry is due, not to write: the run can outlast the render that started it.
  const sessionRef = React.useRef(session);
  React.useEffect(() => { sessionRef.current = session; }, [session]);
  // Stop also has to end a task's pause between retries, when no run is open to abort.
  const retryStop = React.useRef<AbortController | null>(null);
  // Every chat starts asking; a wider mode is chosen per chat, never carried over.
  const [permissionState, setPermissionState] = React.useState<{ sessionId: string; mode: PermissionMode }>({ sessionId: session.id, mode: "ask" });
  const permissionMode = permissionState.sessionId === session.id ? permissionState.mode : "ask";
  const runtimeDiscovery = useRuntimeDiscovery(true);
  const { roles } = useConnections();
  // A chat the user has not picked a runtime for follows the default, which
  // is worked out again as discovery and the Legacy API endpoint load.
  const storedSelection = (sessionId: string) => (hasRuntimeSelection(sessionId) ? loadRuntimeSelection(sessionId) : null);
  const [runtimeState, setRuntimeState] = React.useState<{ sessionId: string; selection: RuntimeChatSelection | null }>(() => ({
    sessionId: session.id,
    selection: storedSelection(session.id),
  }));
  React.useEffect(() => {
    setRuntimeState({ sessionId: session.id, selection: storedSelection(session.id) });
  }, [session.id]);
  const chosenSelection = runtimeState.sessionId === session.id ? runtimeState.selection : storedSelection(session.id);
  const defaultSelection = React.useMemo(() => defaultRuntimeSelection({
    last: loadLastRuntimeSelection(),
    legacyAvailable: Boolean(roles.agent),
    report: runtimeDiscovery.report,
    // session.id: the last pick may have changed in the chat just left.
  }), [roles.agent, runtimeDiscovery.report, session.id]);
  const runtimeSelection = chosenSelection ?? defaultSelection;
  const runtimeDetecting = !chosenSelection && defaultAwaitsDiscovery({
    last: loadLastRuntimeSelection(),
    legacyAvailable: Boolean(roles.agent),
    report: runtimeDiscovery.report,
    loading: runtimeDiscovery.loading,
  });
  const handleRuntimeSelectionChange = React.useCallback((selection: RuntimeChatSelection) => {
    setRuntimeState({ sessionId: session.id, selection });
    saveRuntimeSelection(session.id, selection);
  }, [session.id]);
  // Plan, PRD, and tasks have their own pick, kept per project like the chat's.
  const [pipelineState, setPipelineState] = React.useState(() => ({ sessionId: session.id, selection: loadPipelineSelection(session.id) }));
  const pipelineSelection = pipelineState.sessionId === session.id ? pipelineState.selection : loadPipelineSelection(session.id);
  const handlePipelineSelectionChange = React.useCallback((selection: RuntimeChatSelection) => {
    setPipelineState({ sessionId: session.id, selection });
    savePipelineSelection(session.id, selection);
  }, [session.id]);
  const handleToolApplied = React.useCallback(() => onToolApplied?.(), [onToolApplied]);

  const agentRun = useAgentRun({
    sessionId: session.id,
    workspaceRoot: session.workspaceRoot || "",
    allowShell: Boolean(session.allowShell),
    onToolApplied: handleToolApplied,
    runtimeSelection,
    harnessSettings,
    permissionMode,
  });
  // A retry can start minutes after the click; it sends with the runtime, permission
  // mode, settings and language chosen by then, not the ones the click saw.
  const sendRef = React.useRef(agentRun.send);
  React.useEffect(() => { sendRef.current = agentRun.send; }, [agentRun.send]);

  const handleRunTask = React.useCallback((task: AgentTask): void => {
    if (agentRun.busy) return;
    setRunningTaskId(task.id);
    // Di layar sempit split dipetakan App menjadi board, jadi agent dibuka
    // langsung agar klik Run tetap menghasilkan permukaan kerja yang terlihat.
    onLayoutModeChange(window.innerWidth <= 1100 ? "agent" : "split");
    const prompt = [
      `Execute task ${task.id}: ${task.title}`,
      `Target files: ${(task.targetFiles || []).join(", ") || "None"}`,
      `Dependencies: ${(task.dependencies || []).join(", ") || "None"}`,
      `Instructions:\n${task.promptInstructions}`,
      `Verification steps:\n${task.verificationSteps}`,
      "Report the implementation and verification evidence.",
    ].join("\n\n");

    const sessionId = session.id;
    // The run can end long after this render, on a different open session, so
    // the card is moved from the session as it is by then.
    const moveCard = (report: RunReport, attempts: number): void => {
      if (!report.outcome) return;
      const outcome = report.outcome;
      const failure = report.error ? readableRunError(report.error) : null;
      const note = failure
        ? (attempts > 1 ? t("Failed after {count} attempts: {error}", { count: attempts, error: failure }) : failure)
        : report.note;
      onUpdateSession((current) => {
        if (current.id !== sessionId) return null;
        const tasks = applyTaskOutcome(current.tasks ?? [], task.id, outcome, note);
        return tasks ? { tasks } : null;
      });
    };
    // Once the loop below is over, the chat's "Try again" can send this same message
    // again with the same options; that run has no loop to hand its report to, so it
    // moves the card itself.
    let loopEnded = false;
    // One attempt, to its end. The report arrives just before send settles; a
    // send that never started (another run is open) reports nothing.
    const attempt = async (message: string): Promise<RunReport> => {
      let report: RunReport = { outcome: null, note: "", error: null, errorCode: null };
      await sendRef.current(message, {
        taskId: task.id,
        onOutcome: (next) => {
          report = next;
          if (loopEnded) moveCard(next, 1);
        },
      });
      return report;
    };
    // The card still waits for this run while it sits in In progress on the same project.
    const stillWanted = (): boolean => {
      const current = sessionRef.current;
      return current.id === sessionId && current.tasks?.find((item) => item.id === task.id)?.status === "in_progress";
    };

    const stopRetries = new AbortController();
    retryStop.current = stopRetries;
    void runWithRetries({
      message: prompt,
      send: attempt,
      stillWanted,
      signal: stopRetries.signal,
      onRetry: ({ attempt: failed, total, error }) => setRetryNotice({
        taskId: task.id,
        text: t("Attempt {attempt} of {total} failed, trying again: {error}", { attempt: failed, total, error: readableRunError(error) }),
      }),
    }).then(({ report, attempts }) => {
      loopEnded = true;
      moveCard(report, attempts);
    }).finally(() => {
      if (retryStop.current === stopRetries) retryStop.current = null;
      setRunningTaskId(null);
      setRetryNotice(null);
    });
  }, [agentRun.busy, onLayoutModeChange, onUpdateSession, session.id, t]);

  const handleStop = React.useCallback((): void => {
    retryStop.current?.abort();
    agentRun.stop();
  }, [agentRun.stop]);

  const openPipeline = (step: Step) => {
    if (!isStepReachable(step, session)) return;
    onSelectStep(step);
    onLayoutModeChange("split");
  };

  const agentPane = (
    <div className="shell-chat-pane flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-surface [&>aside]:!static [&>aside]:!inset-auto [&>aside]:!h-full [&>aside]:!w-full [&>aside]:!max-w-none [&>aside]:!shadow-none">
      <AgentPane
        sessionId={session.id}
        workspaceRoot={session.workspaceRoot || ""}
        allowShell={Boolean(session.allowShell)}
        onChangeWorkspace={onUpdateSession}
        onWorkspaceSelected={onWorkspaceSelected}
        onNavigatePipeline={openPipeline}
        entries={agentRun.entries}
        // A task waiting to be retried is still running: the chat cannot start
        // another run in the pause, and Stop ends it.
        busy={agentRun.busy || runningTaskId !== null}
        error={agentRun.error}
        onSend={agentRun.send}
        onRetry={agentRun.retry}
        onDecideApproval={agentRun.decideApproval}
        onRespondQuestions={agentRun.respondQuestions}
        onStop={handleStop}
        hasPlan={Boolean(session.plan)}
        runtimeSelection={runtimeSelection}
        runtimeReport={runtimeDiscovery.report}
        runtimePreferences={runtimeDiscovery.preferences}
        runtimeLoading={runtimeDiscovery.loading}
        runtimeDetecting={runtimeDetecting}
        onRuntimeSelectionChange={handleRuntimeSelectionChange}
        onOpenConnections={onOpenConnections}
        permissionMode={permissionMode}
        onPermissionModeChange={(mode) => setPermissionState({ sessionId: session.id, mode })}
      />
    </div>
  );

  return (
    <main className="shell-workbench flex min-h-0 flex-1 flex-col overflow-hidden bg-canvas">
      {storeError && (
        <div className="mx-4 mt-4 flex shrink-0 items-start gap-3 rounded-xl border border-warn/30 bg-warn-soft p-4 text-warn-ink lg:mx-8">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <div className="min-w-0 flex-1">
            <p className="font-medium">{t("Project storage is not responding")}</p>
            <p className="mt-0.5 opacity-80">{storeError}</p>
          </div>
          {onDismissStoreError && (
            <button type="button" onClick={onDismissStoreError} className="shrink-0 text-xs font-medium hover:underline">
              {t("Dismiss")}
            </button>
          )}
        </div>
      )}

      <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
        <div className="flex min-h-0 flex-1 flex-row overflow-hidden">
          <div
            className={`min-h-0 min-w-0 ${layoutMode === "board" ? "hidden" : ""}`}
            style={{ width: layoutMode === "split" ? `${ratio * 100}%` : "100%" }}
          >
              {agentPane}
          </div>

          {layoutMode === "split" && <Splitter ratio={ratio} onRatioChange={onRatioChange} onCommit={onRatioCommit} />}

          {layoutMode !== "agent" && (
            <div className="min-h-0 min-w-0 flex-1" style={{ width: layoutMode === "split" ? `${(1 - ratio) * 100}%` : "100%" }}>
              <PipelinePane
                step={session.currentStep}
                session={session}
                onUpdateSession={onUpdateSession}
                onGoToNextStep={() => onSelectStep(session.currentStep === 3 ? 3 : (session.currentStep + 1) as Step)}
                onSelectStep={openPipeline}
                onSelectAgent={() => onLayoutModeChange("agent")}
                onRunTask={handleRunTask}
                runningTaskId={agentRun.busy ? runningTaskId ?? "__agent_busy__" : runningTaskId}
                retryNotice={retryNotice}
                generationTarget={pipelineSelection}
                modelControl={(
                  <div className="inline-flex min-w-0 max-w-full rounded-lg border border-line bg-canvas px-1">
                  <RuntimeControls
                    sessionId={session.id}
                    selection={pipelineSelection}
                    report={runtimeDiscovery.report}
                    preferences={runtimeDiscovery.preferences}
                    loading={runtimeDiscovery.loading}
                    onChange={handlePipelineSelectionChange}
                    onOpenConnections={onOpenConnections}
                    idPrefix="pipeline"
                    legacyRoles={["plan", "prd", "tasks"]}
                    compact
                  />
                  </div>
                )}
              />
            </div>
          )}
        </div>

        {layoutMode === "board" && (
          <button
            type="button"
            onClick={() => onLayoutModeChange("agent")}
            className="lift absolute bottom-4 right-4 z-20 inline-flex items-center gap-2 rounded-full border border-line bg-surface px-3 py-2 text-xs font-medium text-ink shadow-elev-3 hover:border-accent"
          >
            <Bot className="h-3.5 w-3.5 text-accent-ink" />
            {t("Agent")} · {inProgressTasks} {t("In progress")}
          </button>
        )}
      </div>
    </main>
  );
};

export default Workbench;
