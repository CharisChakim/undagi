// Copyright (c) 2026 Charis Chakim - Undagi (https://github.com/CharisChakim/undagi)
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import React from "react";
import { AlertTriangle, Bot } from "lucide-react";
import type { AgentTask, PermissionMode, ProjectSession, SessionUpdate } from "../../types";
import { isStepReachable, Step } from "../../lib/routing";
import { LayoutMode } from "../../lib/layout";
import { useT } from "../../lib/i18n";
import { useAgentRun } from "../../lib/useAgentRun";
import { applyTaskOutcome, markTaskStopped } from "../../lib/taskOutcome";
import { rememberFacts } from "../../lib/projectMemory";
import { runVerifyCommand, verifyDone, verifyOutputForNote } from "../../lib/taskVerify";
import { readableRunError, runWithRetries, type RunReport } from "../../lib/runRetry";
import { currentPhase, dependenciesSaved, idleBoardEnd, nextBoardTask, type BoardRunEnd, type BoardRunState } from "../../lib/boardRun";
import type { TaskOutcome } from "../../lib/taskOutcome";

/** How one card's run ended: its outcome (null when stopped), and whether the user moved the card meanwhile. */
interface TaskRunEnd {
  outcome: TaskOutcome | null;
  movedByUser: boolean;
}
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
  /** Changes when another chat of the project is opened. */
  chatKey?: number;
  /** A chat turn ended; the chat list may have a new or renamed chat. */
  onChatTurnEnded?: () => void;
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
  chatKey = 0,
  onChatTurnEnded,
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
  // The task run in flight, and whether the user has since moved its card by hand.
  const activeTaskRun = React.useRef<{ taskId: string; movedByUser: boolean } | null>(null);
  // The board run in flight; Stop sets `stopped` so no further card starts.
  const boardRun = React.useRef<{ stopped: boolean } | null>(null);
  const [boardStateRaw, setBoardState] = React.useState<({ sessionId: string } & BoardRunState) | null>(null);
  const boardState = boardStateRaw?.sessionId === session.id ? boardStateRaw : null;
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
  // Until it is made they use the chat's runtime: starting them on a Legacy API
  // with no endpoint made a fresh install fail its first plan while Codex was ready.
  const [pipelineState, setPipelineState] = React.useState(() => ({ sessionId: session.id, selection: loadPipelineSelection(session.id) }));
  const pickedPipeline = pipelineState.sessionId === session.id ? pipelineState.selection : loadPipelineSelection(session.id);
  const pipelineSelection = pickedPipeline ?? runtimeSelection;
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
    chatKey,
  });
  // A retry can start minutes after the click; it sends with the runtime, permission
  // mode, settings and language chosen by then, not the ones the click saw.
  const sendRef = React.useRef(agentRun.send);
  React.useEffect(() => { sendRef.current = agentRun.send; }, [agentRun.send]);
  // A verify command is asked for, or not, by the permission mode chosen by then.
  const askApprovalRef = React.useRef(agentRun.askApproval);
  React.useEffect(() => { askApprovalRef.current = agentRun.askApproval; }, [agentRun.askApproval]);
  const permissionModeRef = React.useRef(permissionMode);
  React.useEffect(() => { permissionModeRef.current = permissionMode; }, [permissionMode]);

  // One card's run, to its end: the agent's attempts, then its verify command.
  // Resolves with how the card ended, or null when another card's run is open.
  const runTask = React.useCallback((task: AgentTask): Promise<TaskRunEnd | null> => {
    if (activeTaskRun.current) return Promise.resolve(null);
    const run = { taskId: task.id, movedByUser: false };
    activeTaskRun.current = run;
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
    const moveCard = (report: RunReport, attempts: number, verified?: boolean): void => {
      if (!report.outcome) {
        // Stopped: the card stays, marked as no longer being worked on.
        onUpdateSession((current) => {
          if (current.id !== sessionId) return null;
          const tasks = markTaskStopped(current.tasks ?? [], task.id);
          return tasks ? { tasks } : null;
        });
        return;
      }
      const outcome = report.outcome;
      const failure = report.error ? readableRunError(report.error) : null;
      const note = failure
        ? (attempts > 1 ? t("Failed after {count} attempts: {error}", { count: attempts, error: failure }) : failure)
        : report.note;
      onUpdateSession((current) => {
        if (current.id !== sessionId) return null;
        const tasks = applyTaskOutcome(current.tasks ?? [], task.id, outcome, note, verified);
        return tasks ? { tasks } : null;
      });
    };
    // What a run left for later tasks is kept however its card ends up, a card
    // moved by hand included. A stopped run's partial reply leaves nothing.
    const remember = (report: RunReport): void => {
      if (!report.outcome || !report.memory?.length) return;
      onUpdateSession((current) => {
        if (current.id !== sessionId) return null;
        const projectMemory = rememberFacts(current.projectMemory, report.memory, task.id);
        return projectMemory ? { projectMemory } : null;
      });
    };
    // Once the loop below is over, the chat's "Try again" can send this same message
    // again with the same options; that run has no loop to hand its report to, so it
    // moves the card itself. A move by hand during such a rerun is not tracked.
    let loopEnded = false;
    // One attempt, to its end. The report arrives just before send settles; a
    // send that never started (another run is open) reports nothing.
    const attempt = async (message: string): Promise<RunReport> => {
      let report: RunReport = { outcome: null, note: "", error: null, errorCode: null };
      await sendRef.current(message, {
        taskId: task.id,
        onOutcome: (next) => {
          report = next;
          remember(next);
          // Such a rerun is not checked, so a Done from it stands on the agent's word.
          if (loopEnded) moveCard(next, 1, next.outcome === "done" ? false : undefined);
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
    const onRetry = ({ attempt: failed, total, error }: { attempt: number; total: number; error: string }) => setRetryNotice({
      taskId: task.id,
      text: t("Attempt {attempt} of {total} failed, trying again: {error}", { attempt: failed, total, error: readableRunError(error) }),
    });
    // The agent said done; the card's verify command decides (lib/taskVerify.ts).
    const verify = (first: { report: RunReport; attempts: number }) => verifyDone(first, {
      command: () => {
        const current = sessionRef.current;
        return current.id === sessionId ? current.tasks?.find((item) => item.id === task.id)?.verifyCommand ?? "" : "";
      },
      approve: async (command) => permissionModeRef.current === "full"
        || askApprovalRef.current(command, sessionRef.current.workspaceRoot || undefined),
      run: () => runVerifyCommand(sessionId, task.id, stopRetries.signal),
      retry: (message) => runWithRetries({ message, send: attempt, stillWanted, signal: stopRetries.signal, onRetry }),
      stillWanted,
      movedByUser: () => run.movedByUser,
      signal: stopRetries.signal,
      onRunning: (command) => setRetryNotice({ taskId: task.id, text: t("Running the verify command: {command}", { command }) }),
      onRetrying: ({ exitCode, attempt: round, total }) => setRetryNotice({
        taskId: task.id,
        text: t("The verify command failed (exit {code}); its output went back to the agent ({attempt} of {total}).", { code: exitCode, attempt: round, total }),
      }),
      couldNotRun: (reason) => t("The verify command could not run: {error}", { error: reason }),
      stillFailed: (result) => t("The verify command failed (exit {code}): {command}\n{output}", { code: result.exitCode, command: result.command, output: verifyOutputForNote(result) }),
    });
    return runWithRetries({
      message: prompt,
      send: attempt,
      stillWanted,
      signal: stopRetries.signal,
      onRetry,
    }).then(verify).then(({ report, attempts, verified }): TaskRunEnd => {
      loopEnded = true;
      // A card the user placed by hand while the run went on stays where they put it.
      // (A card that only reads To do because the session refresh lost In progress
      // was not moved by hand, so it still takes the outcome.)
      if (!run.movedByUser) moveCard(report, attempts, verified);
      return { outcome: report.outcome, movedByUser: run.movedByUser };
    }).finally(() => {
      if (retryStop.current === stopRetries) retryStop.current = null;
      if (activeTaskRun.current === run) activeTaskRun.current = null;
      setRunningTaskId(null);
      setRetryNotice(null);
    });
  }, [onLayoutModeChange, onUpdateSession, session.id, t]);

  const handleRunTask = React.useCallback((task: AgentTask): void => {
    if (agentRun.busy || boardRun.current) return;
    void runTask(task);
  }, [agentRun.busy, runTask]);

  // The board run takes one phase: the first that is not finished. It runs that
  // phase's To do cards one at a time, in board order, each once its dependencies
  // are done, and stops when the phase is done or at the first card that does not
  // end done, so nothing builds on a card that failed.
  const runTaskRef = React.useRef(runTask);
  React.useEffect(() => { runTaskRef.current = runTask; }, [runTask]);
  const runBoard = React.useCallback(async (): Promise<void> => {
    if (boardRun.current || activeTaskRun.current) return;
    const sessionId = sessionRef.current.id;
    const phase = currentPhase(sessionRef.current.tasks ?? []);
    if (phase === null) {
      setBoardState({ sessionId, running: false, end: { kind: "all_done" } });
      return;
    }
    const token = { stopped: false };
    boardRun.current = token;
    setBoardState({ sessionId, running: true, phase, end: null });
    if (isStepReachable(3, sessionRef.current)) onSelectStep(3);
    onLayoutModeChange(window.innerWidth <= 1100 ? "agent" : "split");
    // Cards this run finished or started; the session may not show them yet.
    const finished = new Set<string>();
    const tried = new Set<string>();
    let end: BoardRunEnd = { kind: "stopped" };
    try {
      for (;;) {
        const current = sessionRef.current;
        if (token.stopped || current.id !== sessionId) break;
        const tasks = current.tasks ?? [];
        const next = nextBoardTask(tasks, phase, finished, tried);
        if (!next) {
          end = idleBoardEnd(tasks, phase, finished);
          break;
        }
        tried.add(next.id);
        await dependenciesSaved(sessionId, next);
        if (token.stopped) break;
        onUpdateSession((latest) => {
          if (latest.id !== sessionId) return null;
          return { tasks: (latest.tasks ?? []).map((item) => (item.id === next.id ? { ...item, status: "in_progress" as const, runStopped: undefined, verified: undefined } : item)) };
        });
        const result = await runTaskRef.current(next);
        if (!result || result.outcome === null) break;
        if (result.movedByUser) {
          end = { kind: "moved_by_hand", taskId: next.id };
          break;
        }
        if (result.outcome !== "done") {
          end = { kind: "card_ended", taskId: next.id, outcome: result.outcome };
          break;
        }
        finished.add(next.id);
      }
    } finally {
      if (boardRun.current === token) boardRun.current = null;
      setBoardState({ sessionId, running: false, phase, end });
    }
  }, [onLayoutModeChange, onSelectStep, onUpdateSession]);
  const runBoardRef = React.useRef(runBoard);
  React.useEffect(() => { runBoardRef.current = runBoard; }, [runBoard]);

  // A chat turn whose agent wrote the board marker starts the board run once it ends.
  const sendFromChat = React.useCallback((text: string) => agentRun.send(text, {
    onOutcome: (report) => {
      onChatTurnEnded?.();
      if (report.runBoard) window.setTimeout(() => void runBoardRef.current(), 0);
    },
  }), [agentRun.send, onChatTurnEnded]);

  // Moving the card back to In progress hands it to the run again.
  const handleTaskMoved = React.useCallback((taskId: string, status: NonNullable<AgentTask["status"]>): void => {
    const run = activeTaskRun.current;
    if (run?.taskId === taskId) run.movedByUser = status !== "in_progress";
  }, []);

  const handleStop = React.useCallback((): void => {
    if (boardRun.current) boardRun.current.stopped = true;
    retryStop.current?.abort();
    agentRun.stop();
  }, [agentRun.stop]);

  const openPipeline = (step: Step) => {
    if (!isStepReachable(step, session)) return;
    onSelectStep(step);
    onLayoutModeChange("split");
  };

  // A pane that comes into view fades and rises in instead of appearing at
  // once: both panes on a layout change, the pipeline alone on a step change.
  // The panes stay mounted, so this never resets the chat.
  const agentPaneRef = React.useRef<HTMLDivElement>(null);
  const pipelinePaneRef = React.useRef<HTMLDivElement>(null);
  const previousView = React.useRef({ layoutMode, step: session.currentStep });
  React.useEffect(() => {
    const previous = previousView.current;
    previousView.current = { layoutMode, step: session.currentStep };
    const modeChanged = previous.layoutMode !== layoutMode;
    if (!modeChanged && previous.step === session.currentStep) return;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    const panes = modeChanged ? [agentPaneRef.current, pipelinePaneRef.current] : [pipelinePaneRef.current];
    for (const pane of panes) {
      if (!pane || pane.offsetParent === null) continue;
      pane.animate?.(
        [{ opacity: 0, transform: "translateY(6px)" }, { opacity: 1, transform: "none" }],
        { duration: 220, easing: "cubic-bezier(0.32, 0.72, 0, 1)" },
      );
    }
  }, [layoutMode, session.currentStep]);

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
        onSend={sendFromChat}
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
            ref={agentPaneRef}
            className={`min-h-0 min-w-0 ${layoutMode === "board" ? "hidden" : ""}`}
            style={{ width: layoutMode === "split" ? `${ratio * 100}%` : "100%" }}
          >
              {agentPane}
          </div>

          {layoutMode === "split" && <Splitter ratio={ratio} onRatioChange={onRatioChange} onCommit={onRatioCommit} />}

          {layoutMode !== "agent" && (
            <div ref={pipelinePaneRef} className="flex min-h-0 min-w-0 flex-1 flex-col" style={{ width: layoutMode === "split" ? `${(1 - ratio) * 100}%` : "100%" }}>
              {/* A flex column, so the pane's flex-1 and min-h-0 hold it to this height
                  and it scrolls itself instead of overflowing the row. */}
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
                onTaskMoved={handleTaskMoved}
                boardRun={boardState}
                onRunBoard={() => void runBoard()}
                onStopBoard={handleStop}
                generationTarget={pipelineSelection}
                modelControl={(
                  <div className="inline-flex min-w-0 max-w-full rounded-lg border border-line bg-canvas px-1">
                  <RuntimeControls
                    sessionId={session.id}
                    selection={pipelineSelection}
                    report={runtimeDiscovery.report}
                    preferences={runtimeDiscovery.preferences}
                    loading={runtimeDiscovery.loading}
                    detecting={!pickedPipeline && runtimeDetecting}
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
