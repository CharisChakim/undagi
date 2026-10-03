import { parseJsonFromLlm } from "../llm/json.ts";
import type { Connection } from "../llm/types.ts";
import type { Lang } from "../messages.ts";
import { EXAMPLE_VALUES_NOTE, languageDirective } from "./language.ts";
import { generateLlmText, type PipelineOptions } from "./llm.ts";

// Read by a coding agent, not by the person reviewing the board, so they follow
// the agent language while phase and title follow the interface language.
const AGENT_FIELDS = ["promptInstructions", "verificationSteps"];

// Undagi runs this after the agent says a task is done, and the card counts
// as verified only when it exits 0. The user approves it like any command. It
// runs in whichever shell the machine has, so the rules keep it to one command.
const VERIFY_COMMAND_RULES = `verifyCommand is one shell command that Undagi runs from the project root after the agent reports the task done; the task counts as verified only when it exits 0. It must be non-interactive, finish within about two minutes, and check this task specifically (prefer a targeted test, a type-check or a build over the whole suite). Write it as one plain command with no chaining or piping (no \`&&\`, \`||\`, \`;\` or \`|\`): it may run in /bin/sh or in Windows PowerShell 5.1, which has no \`&&\`, so pick the single most specific check instead. Never use destructive commands, installs outside the project, or calls to production services. Leave it "" when no command can check the task, such as a visual or manual change.`;

export function buildTasksSystemPrompt(humanLang: Lang, agentLang: Lang = "en"): string {
  return `You are a Principal AI Engineer & Prompt Architect.
${languageDirective({ humanLang, agentLang, agentFields: AGENT_FIELDS })}
Your task is to break the PRD (7 points) and the Project Architecture down into a list of coding tasks that are modular, atomic in pattern, and READY TO BE EXECUTED BY AN AI CODING AGENT (such as Cursor, Antigravity Agent, Claude Code, Gemini Code Assist).

These tasks must be self-contained, with clear technical instructions, specific target files, dependencies, and verification steps.
${VERIFY_COMMAND_RULES}
Every task must have the initial status "todo".

Return the response EXACTLY in the following JSON format. ${EXAMPLE_VALUES_NOTE}
{
  "tasks": [
    {
      "id": "TASK-01",
      "phase": "Phase 1: Setup & Database",
      "title": "Project Initialization & Data Schema",
      "priority": "High", // "High", "Medium", or "Low"
      "targetFiles": ["src/types.ts", "package.json"],
      "dependencies": [],
      "promptInstructions": "Create the file src/types.ts that defines the interface...",
      "verificationSteps": "Run npm run build and make sure there are no TypeScript errors.",
      "verifyCommand": "npm run build",
      "status": "todo"
    }
  ]
}`;
}

/** A card already on the board that the generator must not build again. */
export interface ExistingTask {
  id: string;
  title: string;
  status?: string;
  targetFiles: string[];
}

const MAX_EXISTING_TASKS = 100;

const clip = (value: unknown, limit: number): string =>
  typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, limit) : "";

/** The cards from a request body, cut down to what the prompt needs. Anything else is dropped. */
export function cleanExistingTasks(value: unknown): ExistingTask[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, MAX_EXISTING_TASKS).flatMap((item): ExistingTask[] => {
    const card = item && typeof item === "object" ? item as Record<string, unknown> : {};
    const id = clip(card.id, 60);
    if (!id) return [];
    const status = clip(card.status, 20);
    const files = Array.isArray(card.targetFiles) ? card.targetFiles.map((file) => clip(file, 120)).filter(Boolean).slice(0, 8) : [];
    return [{ id, title: clip(card.title, 120), ...(status ? { status } : {}), targetFiles: files }];
  });
}

function existingTasksBlock(existing: ExistingTask[]): string {
  if (existing.length === 0) return "";
  const lines = existing.map((task) =>
    `- ${task.id}${task.status ? ` [${task.status}]` : ""} ${task.title}${task.targetFiles.length ? ` (${task.targetFiles.join(", ")})` : ""}`
  );
  return `

These cards are already on the board and stay as they are. Do not create tasks for work they cover, and do not reuse their IDs. A new task may list one of these IDs in "dependencies" when it builds on that work.
${lines.join("\n")}`;
}

export function buildTasksPrompt(title: string, plan: any, prd: any, existing: ExistingTask[] = []): string {
  return `Project Details:
Title: ${title}
PRD Overview: ${prd?.overview || prd?.executiveSummary || ""}
Core Feature Phases: ${JSON.stringify(prd?.coreFeatures || {})}
User Flow: ${prd?.userFlow || ""}
Architecture & Tech Stack: ${JSON.stringify(prd?.techStack || plan?.specs?.techStack || [])}
Database Schema: ${JSON.stringify(prd?.databaseSchema || prd?.dataSchema || [])}

Please produce a comprehensive AI Agent Task breakdown (at least 5-10 sequential atomic tasks).
Every task must include complete promptInstructions that are ready to be copy/pasted or read by an AI coding Agent without ambiguity.${existingTasksBlock(existing)}`;
}

export async function generateTasks(
  title: string,
  plan: any,
  prd: any,
  conn: Connection,
  model: string,
  lang: Lang,
  options?: PipelineOptions & { existingTasks?: unknown },
): Promise<any[]> {
  const { existingTasks, ...llmOptions } = options ?? {};
  const rawText = await generateLlmText({
    prompt: buildTasksPrompt(title, plan, prd, cleanExistingTasks(existingTasks)),
    system: buildTasksSystemPrompt(lang, llmOptions.agentLang),
    conn,
    model,
    lang,
    ...llmOptions,
  });
  const data = parseJsonFromLlm(rawText, lang);

  const tasks = (data.tasks || []).map((t: any) => ({
    ...t,
    verifyCommand: typeof t.verifyCommand === "string" ? t.verifyCommand.trim() : "",
    status: t.status || "todo",
  }));

  return tasks;
}
