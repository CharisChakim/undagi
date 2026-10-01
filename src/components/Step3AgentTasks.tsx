import React, { useEffect, useRef, useState } from "react";
import type { ProjectSession, AgentTask } from "../types";
import { generateTasks, isAbort, PipelineModelControl, usePipelineTarget } from "../lib/generate";
import { agentsMarkdownFilename, buildAgentsMarkdown } from "../lib/agentsMd";
import { downloadFile } from "../lib/download";
import { buildHandoffJson, handoffJsonFilename } from "../lib/handoff";
import { fetchTaskRunReview, type TaskRunReview } from "../lib/runs";
import { GenerationProgress } from "./GenerationProgress";
import {
  Bot,
  Sparkles,
  Download,
  Copy,
  Check,
  RefreshCw,
  Code2,
  CheckCircle2,
  ListOrdered,
  ChevronDown,
  ChevronUp,
  Kanban,
  ArrowRight,
  ArrowLeft,
  X,
  AlertTriangle,
  Plus,
  Trash2,
} from "lucide-react";
import { useT } from "../lib/i18n";
import { openDependencies } from "../lib/taskDependencies";
import { agentLanguageFor, loadAgentHarnessSettings } from "../lib/agentHarness";
import {
  attachPrdVersionToPrd,
  attachPrdVersionToTasks,
  currentPrdVersion,
  hasPrdSource,
  mergeGeneratedTasks,
  recordPrdVersion,
  taskNeedsPrdSync,
} from "../lib/artifactVersions";

interface Step3AgentTasksProps {
  session: ProjectSession;
  onUpdateSession: (updated: Partial<ProjectSession>) => void;
  onRunTask?: (task: AgentTask) => void;
  runningTaskId?: string | null;
  onSelectStep?: (step: 1 | 2 | 3) => void;
}

type TaskStatus = "todo" | "in_progress" | "done" | "blocked";

function runDate(value: string | null | undefined): string {
  if (!value) return "";
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toLocaleString() : value;
}

export const Step3AgentTasks: React.FC<Step3AgentTasksProps> = ({ session, onUpdateSession, onRunTask, runningTaskId, onSelectStep }) => {
  const { t, lang } = useT();
  const pipelineTarget = usePipelineTarget();
  const [loading, setLoading] = useState(false);
  const [generationChars, setGenerationChars] = useState(0);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [copiedTaskId, setCopiedTaskId] = useState<string | null>(null);
  const [copiedAll, setCopiedAll] = useState(false);
  const [expandedTasks, setExpandedTasks] = useState<Record<string, boolean>>({});
  const [viewMode, setViewMode] = useState<"kanban" | "list">("kanban");
  const [selectedTask, setSelectedTask] = useState<AgentTask | null>(null);
  const [manualFormOpen, setManualFormOpen] = useState(false);
  const [manualTitle, setManualTitle] = useState("");
  const [manualInstructions, setManualInstructions] = useState("");
  const [manualVerification, setManualVerification] = useState("");
  const [manualPriority, setManualPriority] = useState<AgentTask["priority"]>("Medium");
  const [reviewRefresh, setReviewRefresh] = useState(0);
  const [runReview, setRunReview] = useState<{
    taskId: string | null;
    loading: boolean;
    data: TaskRunReview | null;
    error: string | null;
  }>({ taskId: null, loading: false, data: null, error: null });

  // Kartu dipindah dengan drag-and-drop HTML5 asli — tidak perlu pustaka untuk
  // tiga kolom. Tombol kecil di kaki kartu tetap ada: drag HTML5 tidak bekerja
  // di layar sentuh, dan tombol juga terjangkau lewat keyboard.
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<TaskStatus | null>(null);
  const tasksAbort = useRef<AbortController | null>(null);
  const reviewAbort = useRef<AbortController | null>(null);

  const tasks = session.tasks || [];
  const blockedTitle = (task: AgentTask): string | undefined => {
    const open = openDependencies(task, tasks);
    return open.length ? t("Waiting on {tasks}, which is not done yet.", { tasks: open.join(", ") }) : undefined;
  };
  const currentVersion = currentPrdVersion(session.prdVersions);
  const tasksNeedingSync = tasks.filter((task) => taskNeedsPrdSync(task, currentVersion)).length;

  // The details panel opens beside the board, not over it, so keyboard users
  // are taken to it and brought back to the card they came from.
  const detailPanel = useRef<HTMLElement>(null);
  const detailCloseButton = useRef<HTMLButtonElement>(null);
  const detailOpener = useRef<HTMLElement | null>(null);
  const selectedTaskId = selectedTask?.id ?? null;
  useEffect(() => {
    if (!selectedTaskId) {
      // Only an actual close returns focus. Switching to another card while
      // the panel is open keeps the newer card as the one to go back to.
      const opener = detailOpener.current;
      detailOpener.current = null;
      if (opener?.isConnected) opener.focus();
      return;
    }
    // A mouse click on the card body leaves focus on <body>: nothing to return to.
    const active = document.activeElement;
    if (!(active instanceof HTMLElement && detailPanel.current?.contains(active))) {
      detailOpener.current = active instanceof HTMLElement && active !== document.body ? active : null;
    }
    const frame = window.requestAnimationFrame(() => detailCloseButton.current?.focus());
    // Only from inside the panel: a dialog or menu opened over the board owns
    // its own Escape, and one press should not close both.
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && detailPanel.current?.contains(event.target as Node)) setSelectedTask(null);
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [selectedTaskId]);

  useEffect(() => {
    if (!selectedTask) return;
    const current = tasks.find((task) => task.id === selectedTask.id);
    if (current) setSelectedTask(current);
    else setSelectedTask(null);
  }, [session.tasks]);

  useEffect(() => {
    reviewAbort.current?.abort();
    if (!selectedTask) {
      setRunReview({ taskId: null, loading: false, data: null, error: null });
      return;
    }

    const controller = new AbortController();
    reviewAbort.current = controller;
    const taskId = selectedTask.id;
    setRunReview({ taskId, loading: true, data: null, error: null });

    fetchTaskRunReview(taskId, controller.signal)
      .then((data) => {
        if (!controller.signal.aborted) setRunReview({ taskId, loading: false, data, error: null });
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          setRunReview({
            taskId,
            loading: false,
            data: null,
            error: error instanceof Error ? error.message : t("Could not load run history for this task."),
          });
        }
      });

    return () => controller.abort();
  }, [selectedTask?.id, reviewRefresh, t]);

  const handleGenerateTasks = async () => {
    setLoading(true);
    setErrorMessage(null);
    setGenerationChars(0);
    const controller = new AbortController();
    tasksAbort.current = controller;

    try {
      const recorded = session.prd ? recordPrdVersion(session.prd, session.prdVersions) : null;
      const versionedPrd = recorded && session.prd
        ? attachPrdVersionToPrd(session.prd, recorded.version)
        : session.prd;
      const taskSession = recorded && versionedPrd
        ? { ...session, prd: versionedPrd, prdVersions: recorded.versions }
        : session;
      const generated = await generateTasks(taskSession, lang, controller.signal, setGenerationChars, pipelineTarget);
      const generatedTasks = attachPrdVersionToTasks(generated, recorded?.version);
      onUpdateSession({
        ...(recorded && versionedPrd ? { prd: versionedPrd, prdVersions: recorded.versions } : {}),
        tasks: mergeGeneratedTasks(tasks, generatedTasks),
      });

      // Expand all by default
      const initialExpanded: Record<string, boolean> = {};
      generatedTasks.forEach((task) => (initialExpanded[task.id] = true));
      setExpandedTasks(initialExpanded);

      // Trigger celebratory confetti. Dimuat saat dipakai supaya paketnya
      // tidak ikut bundel awal hanya untuk satu perayaan.
      const { default: confetti } = await import("canvas-confetti");
      confetti({
        particleCount: 80,
        spread: 70,
        origin: { y: 0.6 },
      });
    } catch (err: any) {
      if (!isAbort(err)) {
        setErrorMessage(err.message || t("Something went wrong while generating the agent tasks."));
      }
    } finally {
      tasksAbort.current = null;
      setLoading(false);
    }
  };

  const handleTaskStatusChange = (taskId: string, newStatus: TaskStatus) => {
    const updated = tasks.map((t) => (t.id === taskId ? { ...t, status: newStatus } : t));
    onUpdateSession({ tasks: updated });
    if (selectedTask && selectedTask.id === taskId) {
      setSelectedTask({ ...selectedTask, status: newStatus });
    }
  };

  const nextManualTaskId = (): string => {
    const used = new Set(tasks.map((task) => task.id));
    let index = 1;
    let id = `MANUAL-${String(index).padStart(2, "0")}`;
    while (used.has(id)) id = `MANUAL-${String(++index).padStart(2, "0")}`;
    return id;
  };

  const handleAddManualTask = (): void => {
    const title = manualTitle.trim();
    if (!title) return;
    const task: AgentTask = {
      id: nextManualTaskId(),
      phase: t("Manual plan"),
      title,
      priority: manualPriority,
      targetFiles: [],
      dependencies: [],
      promptInstructions: manualInstructions.trim() || title,
      // Read by a coding agent, so English unless the user asked for agent text in their language.
      verificationSteps: manualVerification.trim() ||
        (agentLanguageFor(loadAgentHarnessSettings()) === "ui"
          ? t("Verify the requested outcome before marking this task done.")
          : "Verify the requested outcome before marking this task done."),
      status: "todo",
    };
    onUpdateSession({ tasks: [...tasks, task] });
    setExpandedTasks((current) => ({ ...current, [task.id]: true }));
    setManualTitle("");
    setManualInstructions("");
    setManualVerification("");
    setManualPriority("Medium");
    setManualFormOpen(false);
    setViewMode("kanban");
  };

  const handleDeleteTask = (taskId: string): void => {
    onUpdateSession({ tasks: tasks.filter((task) => task.id !== taskId) });
    if (selectedTask?.id === taskId) setSelectedTask(null);
  };

  const runTask = (task: AgentTask, event?: React.MouseEvent): void => {
    event?.stopPropagation();
    if (openDependencies(task, tasks).length) return;
    if (task.status !== "in_progress") handleTaskStatusChange(task.id, "in_progress");
    onRunTask?.(task);
  };

  const toggleExpand = (id: string) => {
    setExpandedTasks((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  const handleCopyTaskPrompt = (task: AgentTask) => {
    // Isi bundel selalu Inggris: pembacanya adalah AI coding agent, bukan
    // pengguna, dan prompt agent lain di sekitarnya pun berbahasa Inggris.
    const text = `AI AGENT PROMPT [${task.id}] - ${task.title}\n` +
      `Target files: ${(task.targetFiles || []).join(", ")}\n` +
      `\nInstructions:\n${task.promptInstructions}\n` +
      `\nVerification steps:\n${task.verificationSteps}`;

    navigator.clipboard.writeText(text);
    setCopiedTaskId(task.id);
    setTimeout(() => setCopiedTaskId(null), 2000);
  };

  const handleDownloadMdFile = () => {
    downloadFile(
      agentsMarkdownFilename(session),
      buildAgentsMarkdown(session),
      "text/markdown",
    );
  };

  const handleDownloadTaskHandoff = (task: AgentTask) => {
    // Like Run: the work waits until the tasks it depends on are done.
    if (openDependencies(task, tasks).length > 0) return;
    const handedOffTask: AgentTask = {
      ...task,
      handoffStatus: "handed_off",
      handedOffAt: new Date().toISOString(),
    };
    onUpdateSession({ tasks: tasks.map((item) => item.id === task.id ? handedOffTask : item) });
    downloadFile(handoffJsonFilename(session, handedOffTask), buildHandoffJson(session, handedOffTask), "application/json");
  };

  const handleCopyAllMd = () => {
    const content = buildAgentsMarkdown(session);
    navigator.clipboard.writeText(content);
    setCopiedAll(true);
    setTimeout(() => setCopiedAll(false), 2000);
  };

  // Kolom board dirender dari satu kerangka yang sama; hanya isi,
  // warna penanda, dan aksi di kaki kartunya yang berbeda per status.
  const columns = [
    {
      status: "todo" as const,
      label: t("To do"),
      dot: "bg-faint",
      tasks: tasks.filter((t) => !t.status || t.status === "todo"),
      emptyHint: t("Every task has been dealt with."),
    },
    {
      status: "in_progress" as const,
      label: t("In progress"),
      dot: "bg-warn animate-pulse",
      tasks: tasks.filter((t) => t.status === "in_progress"),
      emptyHint: t('Hit "Mark in progress" on a To do task to move it here.'),
    },
    {
      status: "blocked" as const,
      label: t("Blocked"),
      dot: "bg-danger",
      tasks: tasks.filter((t) => t.status === "blocked"),
      // Kolom ini hanya tampil bila ada isinya, jadi petunjuk kosong tak pernah terbaca.
      emptyHint: "",
    },
    {
      status: "done" as const,
      label: t("Done"),
      dot: "bg-ok",
      tasks: tasks.filter((t) => t.status === "done"),
      emptyHint: t("Tasks the AI agent has verified show up here."),
    },
  ];

  // Run yang gagal atau macet mendarat di Blocked; selama kosong, board tetap tiga kolom.
  const visibleColumns = columns.filter((column) => column.status !== "blocked" || column.tasks.length > 0);

  const selectedTaskHandoffJson = selectedTask ? buildHandoffJson(session, selectedTask) : null;
  const manualTaskForm = manualFormOpen ? (
    <div className="card max-w-3xl space-y-4 p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="font-semibold text-ink">{t("Add a manual task")}</h3>
          <p className="mt-1 text-xs leading-relaxed text-muted">{t("Manual tasks are kept when you later generate or sync tasks from a PRD.")}</p>
        </div>
        <button type="button" onClick={() => setManualFormOpen(false)} className="rounded-lg p-1.5 text-faint hover:bg-subtle hover:text-ink" aria-label={t("Close")}><X className="h-4 w-4" /></button>
      </div>
      <div>
        <label htmlFor="manual-task-title" className="field-label">{t("Task title")} <span className="text-danger">*</span></label>
        <input id="manual-task-title" autoFocus value={manualTitle} onChange={(event) => setManualTitle(event.target.value)} className="field" placeholder={t("What needs to be done?")} />
      </div>
      <div className="grid gap-4 @2xl/pane:grid-cols-2">
        <div>
          <label htmlFor="manual-task-instructions" className="field-label">{t("Implementation notes")}</label>
          <textarea id="manual-task-instructions" rows={4} value={manualInstructions} onChange={(event) => setManualInstructions(event.target.value)} className="field resize-y" placeholder={t("Describe the work, constraints, and expected result...")} />
        </div>
        <div>
          <label htmlFor="manual-task-verification" className="field-label">{t("Done when")}</label>
          <textarea id="manual-task-verification" rows={4} value={manualVerification} onChange={(event) => setManualVerification(event.target.value)} className="field resize-y" placeholder={t("Describe how this task should be verified...")} />
        </div>
      </div>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <label htmlFor="manual-task-priority" className="field-label">{t("Priority")}</label>
          <select id="manual-task-priority" value={manualPriority} onChange={(event) => setManualPriority(event.target.value as AgentTask["priority"])} className="field min-w-32 py-2">
            <option value="High">{t("High")}</option>
            <option value="Medium">{t("Medium")}</option>
            <option value="Low">{t("Low")}</option>
          </select>
        </div>
        <button type="button" onClick={handleAddManualTask} disabled={!manualTitle.trim()} className="btn-primary disabled:opacity-40"><Plus className="h-4 w-4" />{t("Add to Kanban")}</button>
      </div>
    </div>
  ) : null;

  return (
    <div className="relative space-y-6 pb-12">
      {/* Page heading */}
      <div className="max-w-2xl">
        <h2 className="text-xl font-semibold tracking-tight text-ink">{t("Kanban workspace")}</h2>
        <p className="text-muted mt-1.5 leading-relaxed">
          {t("Plan work manually or generate executable tasks from a PRD. Both sources share one board without overwriting each other.")}
        </p>
      </div>

      {manualTaskForm}

      {/* Error Alert */}
      {errorMessage && (
        <div className="max-w-3xl p-4 bg-danger-soft border border-danger/30 text-danger-ink rounded-xl">
          <strong className="font-semibold">{t("Error")}:</strong> {errorMessage}
        </div>
      )}

      <GenerationProgress
        active={loading}
        label={t("Building the task board...")}
        chars={generationChars}
        onCancel={() => tasksAbort.current?.abort()}
      />

      {/* Choose an explicit starting path if no tasks exist yet. */}
      {tasks.length === 0 ? (
        <div className="grid max-w-4xl gap-4 @3xl/pane:grid-cols-2">
          <div className="card flex flex-col p-6">
            <div className="mb-4 grid h-10 w-10 place-items-center rounded-xl bg-accent-soft text-accent-ink"><Kanban className="h-5 w-5" /></div>
            <h3 className="font-semibold text-ink">{t("Plan manually")}</h3>
            <p className="mt-1 flex-1 text-sm leading-relaxed text-muted">{t("Start with your own tasks and arrange them directly on the board. No Plan or PRD is required.")}</p>
            <button type="button" onClick={() => setManualFormOpen(true)} className="btn-primary mt-5 self-start"><Plus className="h-4 w-4" />{t("Add first task")}</button>
          </div>
          <div className="card flex flex-col p-6">
            <div className="mb-4 grid h-10 w-10 place-items-center rounded-xl bg-ok-soft text-ok"><Bot className="h-5 w-5" /></div>
            <h3 className="font-semibold text-ink">{t("Generate from PRD")}</h3>
            <p className="mt-1 flex-1 text-sm leading-relaxed text-muted">{session.prd ? t("Turn the current PRD into atomic, agent-ready tasks. Existing manual tasks stay on the board.") : t("Create or open a PRD first, then let the AI break it into executable tasks.")}</p>
            {session.prd ? (
              <div className="mt-5 flex flex-wrap items-center justify-between gap-2">
                <PipelineModelControl />
                <button onClick={handleGenerateTasks} disabled={loading} className="btn-outline">
                  <Sparkles className="h-4 w-4" />{loading ? t("Building the task board...") : t("Generate task board")}
                </button>
              </div>
            ) : (
              <button type="button" onClick={() => onSelectStep?.(2)} className="btn-outline mt-5 self-start">{t("Open PRD builder")}<ArrowRight className="h-4 w-4" /></button>
            )}
          </div>
        </div>
      ) : (
        <div className="space-y-5 animate-in fade-in duration-300">
          {/* Header Action Bar */}
          <div className="card p-5 flex flex-wrap items-start justify-between gap-5">
            <div className="min-w-0">
              <div className="flex items-center gap-1.5 text-ok text-xs font-medium mb-1.5">
                <CheckCircle2 className="w-3.5 h-3.5" /> {t("{count} tasks ready to run", { count: tasks.filter((task) => task.status !== "done" && openDependencies(task, tasks).length === 0).length })}
                {currentVersion && <span className="text-faint">· PRD v{currentVersion.number}</span>}
              </div>
              <h3 className="text-base font-semibold text-ink">{t("Task board")}</h3>
              <p className="text-muted mt-1 max-w-xl leading-relaxed">
                {t("Move tasks between states on the board below, or download AGENTS.md for your AI agent to run.")}
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-2 shrink-0">
              <button type="button" onClick={() => setManualFormOpen(true)} className="btn-outline">
                <Plus className="h-4 w-4" />{t("Add task")}
              </button>
              <button onClick={handleCopyAllMd} className="btn-ghost">
                {copiedAll ? <Check className="w-4 h-4 text-ok" /> : <Copy className="w-4 h-4" />}
                {copiedAll ? t("Copied") : t("Copy all")}
              </button>

              <button onClick={handleDownloadMdFile} className="btn-primary">
                <Download className="w-4 h-4" />
                {t("Download AGENTS.md")}
              </button>
            </div>
          </div>

          {tasksNeedingSync > 0 && (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-warn/30 bg-warn-soft p-4 text-warn-ink">
              <div className="flex items-start gap-2 text-sm">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>
                  <strong className="font-semibold">{tasksNeedingSync} task{tasksNeedingSync === 1 ? "" : "s"} need sync.</strong>{" "}
                  The PRD changed. Sync generated tasks when you are ready; manual tasks remain available.
                </span>
              </div>
              <button type="button" onClick={handleGenerateTasks} disabled={loading} className="btn-primary shrink-0 text-xs">
                <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
                {loading ? t("Building the task board...") : t("Sync tasks")}
              </button>
            </div>
          )}

          {/* View Switcher Bar */}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="inline-flex items-center gap-1 bg-subtle p-1 rounded-lg">
              {(
                [
                  { id: "kanban", label: t("Kanban board"), icon: Kanban },
                  { id: "list", label: t("Detailed list"), icon: ListOrdered },
                ] as const
              ).map(({ id, label, icon: Icon }) => (
                <button
                  key={id}
                  onClick={() => setViewMode(id)}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
                    viewMode === id ? "bg-surface text-ink shadow-elev-1" : "text-muted hover:text-ink"
                  }`}
                >
                  <Icon className="w-3.5 h-3.5" />
                  {label}
                </button>
              ))}
            </div>

            {session.prd ? (
              <div className="flex flex-wrap items-center gap-2">
              <PipelineModelControl />
              <button onClick={handleGenerateTasks} disabled={loading} className="btn-outline text-xs">
                <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
                {tasksNeedingSync > 0 ? t("Sync PRD tasks") : t("Generate PRD tasks")}
              </button>
              </div>
            ) : (
              <button type="button" onClick={() => onSelectStep?.(2)} className="text-xs text-muted hover:text-accent-ink">{t("PRD is optional")} · {t("Open builder")}</button>
            )}
          </div>

          {/* VIEW 1: KANBAN BOARD */}
          {viewMode === "kanban" && (
            <div className={`grid grid-cols-1 ${visibleColumns.length > 3 ? "@4xl/pane:grid-cols-4" : "@4xl/pane:grid-cols-3"} gap-4 items-start`}>
              {visibleColumns.map((column) => (
                <div
                  key={column.status}
                  onDragOver={(e) => {
                    // Tanpa preventDefault, browser menolak jatuhan apa pun.
                    e.preventDefault();
                    e.dataTransfer.dropEffect = "move";
                    if (dropTarget !== column.status) setDropTarget(column.status);
                  }}
                  onDragLeave={(e) => {
                    // Pindah antar anak kolom ikut memicu dragleave; hanya yang
                    // benar-benar keluar dari kolom yang dihitung.
                    if (!e.currentTarget.contains(e.relatedTarget as Node)) {
                      setDropTarget((current) => (current === column.status ? null : current));
                    }
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    const id = e.dataTransfer.getData("text/plain") || draggingId;
                    const task = tasks.find((item) => item.id === id);
                    if (task && (task.status || "todo") !== column.status) {
                      handleTaskStatusChange(id, column.status);
                    }
                    setDropTarget(null);
                    setDraggingId(null);
                  }}
                  className={`bg-subtle rounded-xl p-3 space-y-2.5 min-h-32 transition-colors ${
                    dropTarget === column.status ? "ring-2 ring-accent ring-inset" : ""
                  }`}
                >
                  <div className="flex items-center gap-2 px-1.5 pb-2 border-b border-line text-xs font-semibold text-muted">
                    <span className={`w-2 h-2 rounded-full ${column.dot}`} />
                    {column.label}
                    <span className="text-faint">{column.tasks.length}</span>
                  </div>

                  <div className="space-y-2.5">
                    {column.tasks.map((task) => (
                      <div
                        key={task.id}
                        draggable
                        onDragStart={(e) => {
                          e.dataTransfer.setData("text/plain", task.id);
                          e.dataTransfer.effectAllowed = "move";
                          setDraggingId(task.id);
                        }}
                        onDragEnd={() => {
                          setDraggingId(null);
                          setDropTarget(null);
                        }}
                        onClick={() => setSelectedTask(task)}
                        className={`card lift p-3.5 cursor-grab active:cursor-grabbing hover:border-accent space-y-2 ${
                          draggingId === task.id ? "opacity-40" : ""
                        }`}
                      >
                        <div className="flex items-start justify-between gap-2">
                          <span className="shrink-0 whitespace-nowrap text-[11px] font-mono font-semibold px-1.5 py-0.5 rounded bg-subtle text-muted">
                            {task.id}
                          </span>
                          <div className="flex min-w-0 flex-wrap items-center justify-end gap-1">
                            <span className="max-w-28 truncate text-[10px] font-medium rounded bg-subtle px-1.5 py-0.5 text-muted">
                              {task.phase || t("Main phase")}
                            </span>
                            <span className={`text-[11px] font-semibold px-1.5 py-0.5 rounded ${task.priority === "High" ? "bg-danger-soft text-danger-ink" : "bg-warn-soft text-warn-ink"}`}>
                              {task.priority}
                            </span>
                            {taskNeedsPrdSync(task, currentVersion) && (
                              <span className="text-[10px] font-semibold rounded bg-warn-soft px-1.5 py-0.5 text-warn-ink">
                                {t("Needs sync")}
                              </span>
                            )}
                            {openDependencies(task, tasks).length > 0 && column.status !== "done" && (
                              <span className="whitespace-nowrap text-[10px] font-semibold rounded bg-subtle px-1.5 py-0.5 text-muted" title={blockedTitle(task)}>
                                {t("Waiting on {tasks}", { tasks: openDependencies(task, tasks).join(", ") })}
                              </span>
                            )}
                            {task.handoffStatus === "handed_off" && (
                              <span className="text-[10px] font-semibold rounded bg-accent-soft px-1.5 py-0.5 text-accent-ink">
                                {t("Handed off")}
                              </span>
                            )}
                            <span className="text-[10px] font-medium text-faint">{hasPrdSource(task) ? t("From PRD") : t("Manual")}</span>
                          </div>
                        </div>

                        <h5
                          className={`font-medium text-xs leading-snug ${
                            column.status === "done" ? "text-muted line-through" : "text-ink"
                          }`}
                        >
                          {/* The card itself only takes a mouse click; this is the
                              keyboard way in to the task's details. */}
                          <button
                            type="button"
                            onClick={() => setSelectedTask(task)}
                            className="rounded-sm text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                          >
                            {task.title}
                          </button>
                        </h5>

                        {/* Catatan penutup agent dari run terakhir. Di kolom lain ia sudah basi. */}
                        {task.agentNote && (column.status === "blocked" || column.status === "done") && (
                          // Padding di pembungkus: pada elemen ber-line-clamp, padding membiarkan baris ke-4 mengintip.
                          <div className="rounded bg-subtle px-2 py-1.5" title={task.agentNote}>
                            <p className="line-clamp-3 whitespace-pre-line text-[11px] leading-snug text-muted">{task.agentNote}</p>
                          </div>
                        )}

                        <div className="pt-2 border-t border-line flex flex-wrap items-center justify-between gap-2 text-xs">
                          <span className="flex min-w-0 items-center gap-1.5 text-faint">
                            <span>{t("{count} target files", { count: task.targetFiles?.length || 0 })}</span>
                            {runningTaskId === task.id && <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-accent" title={t("Agent is working on this task")} />}
                          </span>
                          {column.status === "todo" && (
                            <>
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  handleTaskStatusChange(task.id, "in_progress");
                                }}
                                className="font-medium text-accent-ink hover:brightness-110 flex items-center gap-1 shrink-0"
                              >
                                {t("Mark in progress")} <ArrowRight className="w-3 h-3" />
                              </button>
                            </>
                          )}

                          {(column.status === "in_progress" || column.status === "blocked") && (
                            <>
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  handleTaskStatusChange(task.id, "todo");
                                }}
                                className="text-muted hover:text-ink flex items-center gap-1"
                              >
                                <ArrowLeft className="w-3 h-3" />
                                {t("Back")}
                              </button>
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  handleTaskStatusChange(task.id, "done");
                                }}
                                className="font-medium text-ok hover:brightness-110 flex items-center gap-1"
                              >
                                {t("Accept as done")} <Check className="w-3 h-3" />
                              </button>
                            </>
                          )}

                          {column.status === "done" && (
                            <>
                              <span className="text-ok flex items-center gap-1">
                                <Check className="w-3 h-3" /> {t("Accepted")}
                              </span>
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  handleTaskStatusChange(task.id, "in_progress");
                                }}
                                className="text-muted hover:text-ink flex items-center gap-1"
                              >
                                <ArrowLeft className="w-3 h-3" />
                                {t("Reopen")}
                              </button>
                            </>
                          )}
                          {onRunTask && column.status !== "done" && (
                            <button
                              type="button"
                              onClick={(event) => runTask(task, event)}
                              disabled={Boolean(runningTaskId) || task.status === "done" || openDependencies(task, tasks).length > 0}
                              title={blockedTitle(task)}
                              className="btn-primary !px-2 !py-1 text-[11px] disabled:opacity-50"
                            >
                              {t("Run")}
                            </button>
                          )}
                        </div>
                      </div>
                    ))}

                    {column.tasks.length === 0 && (
                      <p className="p-5 text-center text-xs text-faint rounded-lg border border-dashed border-line">
                        {column.emptyHint}
                      </p>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* VIEW 2: DETAILED LIST VIEW */}
          {viewMode === "list" && (
            <div className="max-w-none space-y-3">
              {tasks.map((task, idx) => {
                const isExpanded = expandedTasks[task.id] ?? true;
                const isCopied = copiedTaskId === task.id;

                return (
                  <div key={task.id || idx} className="card overflow-hidden">
                    <div
                      onClick={() => toggleExpand(task.id)}
                      className="px-4 py-3 bg-subtle border-b border-line flex flex-wrap items-center justify-between gap-3 cursor-pointer select-none"
                    >
                      <div className="flex items-center gap-3 min-w-0">
                        <span className="px-1.5 py-0.5 rounded bg-surface text-muted font-mono font-medium text-[11px] shrink-0">
                          {task.id}
                        </span>

                        <div className="min-w-0">
                          <div className="flex flex-wrap items-baseline gap-x-2 text-xs text-faint">
                            <span>{task.phase || t("Main phase")}</span>
                            <span>&middot;</span>
                            <span className={task.priority === "High" ? "text-danger font-medium" : ""}>
                              {t("Priority {level}", { level: task.priority })}
                            </span>
                            {taskNeedsPrdSync(task, currentVersion) && (
                              <span className="font-semibold text-warn-ink">· {t("Needs sync")}</span>
                            )}
                            {task.handoffStatus === "handed_off" && (
                              <span className="font-semibold text-accent-ink">· {t("Handed off")}</span>
                            )}
                          </div>
                          <h5 className="font-medium text-ink mt-0.5 truncate">{task.title}</h5>
                        </div>
                      </div>

                      <div className="flex items-center gap-2">
                        {onRunTask && task.status !== "done" && (
                          <button
                            type="button"
                            onClick={(event) => runTask(task, event)}
                            disabled={Boolean(runningTaskId) || openDependencies(task, tasks).length > 0}
                            title={blockedTitle(task)}
                            className="btn-primary !px-2 !py-1 text-[11px] disabled:opacity-50"
                          >
                            {t("Run")}
                          </button>
                        )}
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            handleCopyTaskPrompt(task);
                          }}
                          className="btn-outline text-xs !py-1.5"
                        >
                          {isCopied ? <Check className="w-3.5 h-3.5 text-ok" /> : <Copy className="w-3.5 h-3.5" />}
                          {isCopied ? t("Copied") : t("Copy prompt")}
                        </button>

                        <span className="p-1.5 text-faint">
                          {isExpanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                        </span>
                      </div>
                    </div>

                    {isExpanded && (
                      <div className="p-5 space-y-4">
                        <div className="grid grid-cols-1 @xl/pane:grid-cols-2 gap-4">
                          <div>
                            <span className="text-[11px] font-semibold text-faint block mb-1.5">
                              {t("Target files")}
                            </span>
                            <div className="flex flex-wrap gap-1">
                              {task.targetFiles?.map((f, fIdx) => (
                                <span
                                  key={fIdx}
                                  className="font-mono text-xs bg-subtle text-muted px-1.5 py-0.5 rounded"
                                >
                                  {f}
                                </span>
                              ))}
                            </div>
                          </div>

                          <div>
                            <span className="text-[11px] font-semibold text-faint block mb-1.5">
                              {t("Dependencies")}
                            </span>
                            <div className="text-muted">
                              {task.dependencies && task.dependencies.length > 0 ? (
                                task.dependencies.join(", ")
                              ) : (
                                <span className="text-faint">{t("No dependencies")}</span>
                              )}
                            </div>
                          </div>
                        </div>

                        <div>
                          <span className="text-xs font-medium text-muted flex items-center gap-1.5 mb-1.5">
                            <Code2 className="w-3.5 h-3.5 text-accent-ink" /> {t("Prompt instructions for the AI agent")}
                          </span>
                          <div className="bg-code text-code-ink font-mono text-xs leading-relaxed p-4 rounded-lg overflow-x-auto whitespace-pre-wrap select-all">
                            {task.promptInstructions}
                          </div>
                        </div>

                        <div className="p-3.5 bg-ok-soft rounded-lg text-ok-ink">
                          <strong className="font-medium mb-1 flex items-center gap-1.5">
                            <CheckCircle2 className="w-3.5 h-3.5" /> {t("Verification steps")}
                          </strong>
                          <p className="text-xs leading-relaxed opacity-90">{task.verificationSteps}</p>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Panel tetap berada di dalam pipeline agar papan dan transcript tidak tertutup modal penuh. */}
      {selectedTask && (
        <aside ref={detailPanel} className="absolute inset-y-0 right-0 z-30 flex w-[min(100%,32rem)] flex-col border-l border-line bg-surface shadow-elev-3 animate-in slide-in-from-right duration-200" aria-label={t("Task details")}>
          <div className="sticky top-0 flex items-start justify-between gap-4 border-b border-line bg-surface px-6 py-4">
            <div className="min-w-0">
              <div className="flex items-center gap-2 mb-1">
                <span className="font-mono text-[11px] font-semibold px-1.5 py-0.5 rounded bg-subtle text-muted">
                  {selectedTask.id}
                </span>
                <span className="text-xs text-faint truncate">{selectedTask.phase}</span>
              </div>
              <h3 className="text-base font-semibold text-ink">{selectedTask.title}</h3>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <button
                type="button"
                onClick={() => handleDeleteTask(selectedTask.id)}
                className="rounded-lg p-1.5 text-faint transition-colors hover:bg-danger-soft hover:text-danger-ink"
                aria-label={t("Delete task")}
                title={t("Delete task")}
              >
                <Trash2 className="h-4 w-4" />
              </button>
              <button
                type="button"
                ref={detailCloseButton}
                onClick={() => setSelectedTask(null)}
                className="rounded-lg p-1.5 text-faint transition-colors hover:bg-subtle hover:text-ink"
                aria-label={t("Close")}
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto p-6 space-y-4">
            <div>
              <span className="field-label">{t("Work status")}</span>
              <div className="inline-flex items-center gap-1 bg-subtle p-1 rounded-lg">
                {(
                  [
                    ["todo", t("To do")],
                    ["in_progress", t("In progress")],
                    ["blocked", t("Blocked")],
                    ["done", t("Done")],
                  ] as const
                ).map(([status, label]) => {
                  const isActive =
                    selectedTask.status === status ||
                    (status === "todo" && !selectedTask.status);
                  return (
                    <button
                      key={status}
                      onClick={() => handleTaskStatusChange(selectedTask.id, status)}
                      className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                        isActive ? "bg-surface text-ink shadow-elev-1" : "text-muted hover:text-ink"
                      }`}
                    >
                      {label}
                    </button>
                  );
                })}
              </div>
            </div>

            <div>
              <span className="field-label">{t("Target files")}</span>
              <div className="flex flex-wrap gap-1">
                {selectedTask.targetFiles?.map((f, i) => (
                  <span key={i} className="font-mono text-xs bg-subtle text-muted px-2 py-1 rounded">
                    {f}
                  </span>
                ))}
              </div>
            </div>

            <div>
              <span className="field-label">{t("Dependencies")}</span>
              <p className="text-muted">{selectedTask.dependencies?.length ? selectedTask.dependencies.join(", ") : t("No dependencies")}</p>
            </div>

            <div>
              <span className="field-label">{t("Prompt instructions for the AI agent")}</span>
              <div className="p-4 bg-code text-code-ink font-mono text-xs rounded-lg whitespace-pre-wrap leading-relaxed select-all overflow-x-auto">
                {selectedTask.promptInstructions}
              </div>
            </div>

            <div className="p-4 bg-ok-soft rounded-lg text-ok-ink">
              <strong className="text-xs font-medium block mb-1">{t("Verification steps")}</strong>
              <p className="text-xs opacity-90">{selectedTask.verificationSteps}</p>
            </div>

            {selectedTaskHandoffJson && (
              <div className="rounded-lg border border-accent/30 bg-accent-soft p-4 text-accent-ink">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <strong className="text-xs font-semibold block">{t("Handoff package")}</strong>
                    <p className="mt-1 text-[11px] leading-relaxed opacity-80">
                      {selectedTask.handoffStatus === "handed_off" ? t("Handed off") : t("Ready to hand off; status is saved after download")}. {t("External results remain in Review until evidence is available.")}
                    </p>
                  </div>
                  <Download className="w-4 h-4 shrink-0" />
                </div>
                <details className="mt-3">
                  <summary className="cursor-pointer text-xs font-medium">{t("Preview package")}</summary>
                  <pre className="mt-2 max-h-48 overflow-auto rounded-lg bg-code p-3 text-[10px] leading-relaxed text-code-ink whitespace-pre-wrap">
                    {selectedTaskHandoffJson}
                  </pre>
                </details>
                {blockedTitle(selectedTask) && (
                  <p className="mt-2 text-[11px] font-medium">{blockedTitle(selectedTask)}</p>
                )}
                <button
                  type="button"
                  onClick={() => handleDownloadTaskHandoff(selectedTask)}
                  disabled={openDependencies(selectedTask, tasks).length > 0}
                  title={blockedTitle(selectedTask)}
                  className="btn-primary mt-3 !px-2.5 !py-1.5 text-xs disabled:opacity-50"
                >
                  <Download className="w-3.5 h-3.5" /> {t("Download handoff (.json)")}
                </button>
              </div>
            )}

            {selectedTask.agentNote && (selectedTask.status === "blocked" || selectedTask.status === "done") && (
              <section className="rounded-lg border border-line bg-subtle p-4" aria-label={t("Agent note")}>
                <span className="field-label">{t("Agent note")}</span>
                <p className="mt-2 whitespace-pre-wrap text-xs leading-relaxed text-ink">{selectedTask.agentNote}</p>
              </section>
            )}

            <section className="rounded-lg border border-line bg-subtle p-4" aria-label={t("Review and evidence")}>
              <div className="flex items-center justify-between gap-3">
                <div>
                  <span className="field-label">{t("Review and evidence")}</span>
                  <p className="mt-1 text-[11px] text-faint">{t("Run status and attached verification evidence")}</p>
                </div>
                <button
                  type="button"
                  onClick={() => setReviewRefresh((value) => value + 1)}
                  disabled={runReview.loading}
                  className="btn-ghost !px-2 !py-1 text-[11px] disabled:opacity-50"
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${runReview.loading ? "animate-spin" : ""}`} />
                  {t("Refresh")}
                </button>
              </div>

              {runReview.loading && <p className="mt-3 text-xs text-faint">{t("Loading run history...")}</p>}
              {!runReview.loading && runReview.error && (
                <div className="mt-3 rounded-lg border border-danger/30 bg-danger-soft p-3 text-xs text-danger-ink">
                  {runReview.error}
                </div>
              )}
              {!runReview.loading && !runReview.error && runReview.data?.runs.length === 0 && (
                <p className="mt-3 rounded-lg border border-dashed border-line p-3 text-xs leading-relaxed text-faint">
                  {t("No runs recorded for this task yet. Run it or hand it off to an external tool; completion claims alone do not create evidence.")}
                </p>
              )}

              {!runReview.loading && !runReview.error && runReview.data && runReview.data.runs.length > 0 && (
                <div className="mt-3 space-y-2">
                  {runReview.data.runs.map((run) => {
                    const evidence = runReview.data?.evidenceByRunId[run.id] || [];
                    const evidenceError = runReview.data?.evidenceErrors[run.id];
                    return (
                      <div key={run.id} className="rounded-lg border border-line bg-surface p-3">
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-mono text-[10px] text-faint">{run.id}</span>
                          <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                            run.status === "completed" ? "bg-ok-soft text-ok-ink" :
                            run.status === "failed" || run.status === "cancelled" || run.status === "interrupted" ? "bg-danger-soft text-danger-ink" :
                            "bg-subtle text-muted"
                          }`}>
                            {run.status}
                          </span>
                        </div>
                        <p className="mt-1 text-[10px] text-faint">{runDate(run.updatedAt || run.createdAt)}</p>
                        {run.error && <p className="mt-2 text-xs text-danger-ink">{run.error}</p>}
                        <div className="mt-2 border-t border-line pt-2 text-xs">
                          {evidenceError ? (
                            <p className="text-danger-ink">{evidenceError}</p>
                          ) : evidence.length ? (
                            <div className="space-y-1.5">
                              <p className="font-medium text-ink">{t("Evidence ({count})", { count: evidence.length })}</p>
                              {evidence.map((item) => (
                                <div key={item.id} className="rounded bg-subtle px-2 py-1.5 text-muted">
                                  <span className="font-medium text-ink">{item.kind}</span>
                                  {item.summary && <span>: {item.summary}</span>}
                                  {item.exitCode !== null && <span className="text-faint"> · exit {item.exitCode}</span>}
                                </div>
                              ))}
                            </div>
                          ) : (
                            <p className="text-faint">{t("No evidence attached to this run yet.")}</p>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </section>
          </div>

          <div className="flex flex-wrap items-center justify-end gap-3 border-t border-line px-6 py-4">
            {onRunTask && selectedTask.status !== "done" && (
              <button type="button" onClick={() => runTask(selectedTask)} disabled={Boolean(runningTaskId) || openDependencies(selectedTask, tasks).length > 0} title={blockedTitle(selectedTask)} className="btn-primary disabled:opacity-50">
                {t("Run")}
              </button>
            )}
            <button type="button" onClick={() => handleCopyTaskPrompt(selectedTask)} className="btn-outline">
              {copiedTaskId === selectedTask.id ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
              {copiedTaskId === selectedTask.id ? t("Copied") : t("Copy task prompt")}
            </button>
          </div>
        </aside>
      )}
    </div>
  );
};
