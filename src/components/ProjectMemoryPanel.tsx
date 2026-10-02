import React from "react";
import { Brain, X } from "lucide-react";
import type { ProjectSession } from "../types";
import { useT } from "../lib/i18n";
import { forgetFact } from "../lib/projectMemory";

interface ProjectMemoryPanelProps {
  session: ProjectSession;
  onUpdateSession: (updated: Partial<ProjectSession>) => void;
}

// What every new task session is handed (server/agent/projectMemory.ts): the done
// cards with their notes, and the facts runs left on MEMORY lines. It is shown so
// the user sees what the agents are told, and can drop a fact that is wrong.
export const ProjectMemoryPanel: React.FC<ProjectMemoryPanelProps> = ({ session, onUpdateSession }) => {
  const { t } = useT();
  const facts = session.projectMemory ?? [];
  const done = (session.tasks ?? []).filter((task) => task.status === "done");

  const forget = (id: string): void => {
    const next = forgetFact(session.projectMemory, id);
    if (next) onUpdateSession({ projectMemory: next });
  };

  return (
    <details className="card p-0">
      <summary className="flex cursor-pointer list-none flex-wrap items-center justify-between gap-x-3 gap-y-1 px-5 py-3.5 text-sm">
        <span className="flex items-center gap-2 font-medium text-ink">
          <Brain className="h-4 w-4 text-faint" aria-hidden />
          {t("Project memory")}
        </span>
        <span className="text-xs text-faint">
          {t("Learned: {count}", { count: facts.length })} · {t("Done tasks: {count}", { count: done.length })}
        </span>
      </summary>
      <div className="space-y-4 border-t border-line px-5 py-4 text-sm">
        <p className="text-xs leading-relaxed text-muted">
          {t("Every new task session starts with this. Facts come from the agents' MEMORY lines; delete one that is wrong.")}
        </p>
        {facts.length === 0 && done.length === 0 && (
          <p className="text-xs text-faint">{t("Nothing yet. Done tasks and the facts their runs leave show up here.")}</p>
        )}
        {facts.length > 0 && (
          <div>
            <p className="mb-1.5 text-xs font-medium text-faint">{t("Learned by agents")}</p>
            <ul className="space-y-1">
              {facts.map((fact) => (
                <li key={fact.id} className="flex items-start gap-2 rounded-lg bg-subtle px-3 py-2">
                  <span className="min-w-0 flex-1 break-words text-ink">{fact.text}</span>
                  <span className="shrink-0 font-mono text-[11px] text-faint">{fact.taskId}</span>
                  <button
                    type="button"
                    onClick={() => forget(fact.id)}
                    className="shrink-0 rounded p-0.5 text-faint hover:text-danger"
                    aria-label={t("Forget this fact")}
                    title={t("Forget this fact")}
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
        {done.length > 0 && (
          <div>
            <p className="mb-1.5 text-xs font-medium text-faint">{t("Done tasks")}</p>
            <ul className="space-y-1">
              {done.map((task) => (
                <li key={task.id} className="rounded-lg bg-subtle px-3 py-2">
                  <span className="font-mono text-[11px] text-faint">{task.id}</span>{" "}
                  <span className="text-ink">{task.title}</span>
                  {task.agentNote && <p className="mt-0.5 line-clamp-2 text-xs text-muted">{task.agentNote}</p>}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </details>
  );
};
