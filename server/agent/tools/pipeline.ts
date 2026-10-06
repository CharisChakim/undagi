// Copyright (c) 2026 Charis Chakim - Undagi (https://github.com/CharisChakim/undagi)
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { getSession, saveSession } from "../../../db.ts";
import { resolveRoleOrAgent } from "../../connections/store.ts";
import { generateFollowups } from "../../pipeline/followups.ts";
import { generatePlan } from "../../pipeline/plan.ts";
import { generatePrd } from "../../pipeline/prd.ts";
import { generateTasks } from "../../pipeline/tasks.ts";
import type { Lang } from "../../messages.ts";
import { newAppTitle } from "../../pipeline/language.ts";
import type { PipelineOptions } from "../../pipeline/llm.ts";
import type { ToolContext, ToolSpec } from "../registry.ts";
import { resultMessage } from "../../../shared/resultMessages.ts";

function sessionOrError(ctx: ToolContext): { session: any } | { error: string } {
  const session = getSession(ctx.sessionId);
  return session
    ? { session }
    : { error: resultMessage("sessionNotFound", { id: ctx.sessionId }) };
}

// The chat request carries the UI language; a context without one means "en".
export function languageFor(ctx: Pick<ToolContext, "lang">): Lang {
  return ctx.lang === "id" ? "id" : "en";
}

// Whether the instructions the generators write for coding agents follow the UI
// language is the user's choice; without one they stay English.
function optionsFor(ctx: Pick<ToolContext, "agentLang">): PipelineOptions {
  return { agentLang: ctx.agentLang === "id" ? "id" : "en" };
}

function saveArtifact(session: any): void {
  session.updatedAt = new Date().toISOString();
  saveSession(session);
}

// A chat that asks for a plan without the "Plan a project" card has no saved
// idea yet, so the agent passes the user's request as the description.
function ensureDescription(session: any, value: unknown): string {
  const current = String(session.input?.description ?? "").trim();
  if (current) return current;
  const idea = typeof value === "string" ? value.trim() : "";
  if (!idea) return "";
  session.input = { ...session.input, description: idea };
  saveArtifact(session);
  return idea;
}

const DESCRIPTION_PARAM = {
  type: "string",
  description: "The project idea from the user's request. Required if the project description is not saved yet; ignored if it already exists.",
};

function titleFor(session: any, lang: Lang = "en"): string {
  return String(session?.input?.title || session?.title || session?.plan?.suggestedTitle || newAppTitle(lang));
}

function roleConnection(role: "plan" | "prd" | "tasks"): { conn: any; model: string } | { error: string } {
  const resolved = resolveRoleOrAgent(role);
  return resolved || { error: resultMessage("noConnection", { role }) };
}

function shortPlanResult(plan: any): Record<string, unknown> {
  return {
    ok: true,
    summary: plan?.summary || "Plan generated.",
    suggestedTitle: plan?.suggestedTitle || null,
    featureCount: Array.isArray(plan?.specs?.coreFeatures) ? plan.specs.coreFeatures.length : 0,
  };
}

function shortPrdResult(prd: any): Record<string, unknown> {
  return {
    ok: true,
    summary: prd?.overview || prd?.executiveSummary || "PRD generated.",
    projectTitle: prd?.projectTitle || null,
    additionalSections: Array.isArray(prd?.additionalSections) ? prd.additionalSections.length : 0,
  };
}

function shortTasksResult(tasks: any[]): Record<string, unknown> {
  return {
    ok: true,
    summary: resultMessage("tasksGenerated", { count: tasks.length }),
    taskCount: tasks.length,
    taskIds: tasks.map((task) => task?.id).filter((id): id is string => typeof id === "string"),
  };
}

function answerMap(value: unknown): Record<string, string> {
  const candidate = value && typeof value === "object" && !Array.isArray(value) && "answers" in value
    ? (value as { answers?: unknown }).answers
    : value;

  if (Array.isArray(candidate)) {
    return Object.fromEntries(
      candidate
        .filter((entry) => entry && typeof entry === "object")
        .map((entry: any) => [entry.id, entry.answer ?? entry.value])
        .filter(([id, answer]) => typeof id === "string" && answer !== undefined && answer !== null)
        .map(([id, answer]) => [id, String(answer)]),
    );
  }

  if (!candidate || typeof candidate !== "object") return {};
  return Object.fromEntries(
    Object.entries(candidate)
      .filter(([, answer]) => answer !== undefined && answer !== null)
      .map(([id, answer]) => [id, String(answer)]),
  );
}

const getPlan: ToolSpec = {
  def: {
    name: "get_plan",
    description:
      "Read the full Project Plan: summary, target users, features and sub-features, priorities, tech stack, architecture, data flow, Mermaid diagrams, roadmap, and estimate. Use it before working on a task so the implementation follows the approved plan.",
    parameters: { type: "object", properties: {}, required: [] },
  },
  available: () => true,
  async run(_input: unknown, ctx: ToolContext): Promise<unknown> {
    const found = sessionOrError(ctx);
    if ("error" in found) return found;
    const plan = found.session.plan;
    if (!plan) return { status: "missing", message: "The plan has not been created yet." };

    return {
      summary: plan.summary || "",
      specs: plan.specs || {},
      architectureDraft: plan.architectureDraft || {},
      roadmap: Array.isArray(plan.roadmap) ? plan.roadmap : [],
      estimation: plan.estimation || {},
    };
  },
};

const getPrd: ToolSpec = {
  def: {
    name: "get_prd",
    description:
      "Read the full PRD: overview, goals and success metrics, target users, scope per phase with non-goals, requirements with acceptance criteria, user flow, assumptions, risks and open questions, then the technical part (architecture, database schema, tech stack), and additional sections if any. PRDs made before goals, users, non-goals and risks existed return them empty. Every value is kept exactly as it is, including when the user already edited it into text.",
    parameters: { type: "object", properties: {}, required: [] },
  },
  available: () => true,
  async run(_input: unknown, ctx: ToolContext): Promise<unknown> {
    const found = sessionOrError(ctx);
    if ("error" in found) return found;
    const prd = found.session.prd;
    if (!prd) return { status: "missing", message: "The PRD has not been created yet." };

    return {
      projectTitle: prd.projectTitle || titleFor(found.session, languageFor(ctx)),
      overview: prd.overview || prd.executiveSummary || "",
      goals: prd.goals ?? [],
      targetUsers: prd.targetUsers ?? [],
      coreFeatures: prd.coreFeatures || {},
      nonGoals: prd.nonGoals ?? [],
      requirements: prd.requirements ?? {
        functional: prd.functionalRequirements || [],
        nonFunctional: prd.nonFunctionalRequirements || [],
      },
      userFlow: prd.userFlow || "",
      assumptions: prd.assumptions ?? [],
      risks: prd.risks ?? [],
      openQuestions: prd.openQuestions ?? [],
      architecture: prd.architecture || "",
      databaseSchema: prd.databaseSchema ?? prd.dataSchema ?? [],
      techStack: prd.techStack ?? [],
      additionalSections: Array.isArray(prd.additionalSections) ? prd.additionalSections : [],
    };
  },
};

const getTasks: ToolSpec = {
  def: {
    name: "get_tasks",
    description:
      "Read the whole coding task board. Each task has its id, phase, title, priority, target files, dependencies, prompt instructions, verification steps, and current status.",
    parameters: { type: "object", properties: {}, required: [] },
  },
  available: () => true,
  async run(_input: unknown, ctx: ToolContext): Promise<unknown> {
    const found = sessionOrError(ctx);
    if ("error" in found) return found;
    if (!Array.isArray(found.session.tasks)) return { status: "missing", message: "The tasks have not been created yet." };

    return {
      tasks: found.session.tasks.map((task: any) => ({
        id: task.id,
        phase: task.phase,
        title: task.title,
        priority: task.priority,
        targetFiles: task.targetFiles || [],
        dependencies: task.dependencies || [],
        promptInstructions: task.promptInstructions || "",
        verificationSteps: task.verificationSteps || "",
        verifyCommand: task.verifyCommand || "",
        status: task.status || "todo",
      })),
    };
  },
};

const generatePlanTool: ToolSpec = {
  def: {
    name: "generate_plan",
    description:
      "Create or update the Project Plan from the project input and the saved follow-up answers. Uses the plan role model, saves the result to the session, then returns a short summary.",
    parameters: { type: "object", properties: { description: DESCRIPTION_PARAM }, required: [] },
  },
  available: () => true,
  async run(input: any, ctx: ToolContext): Promise<unknown> {
    const found = sessionOrError(ctx);
    if ("error" in found) return found;
    const session = found.session;
    if (!ensureDescription(session, input?.description)) return { error: "The project description has not been filled in yet." };

    const resolved = roleConnection("plan");
    if ("error" in resolved) return resolved;
    const lockedFeatures = session.planFeaturesEdited && Array.isArray(session.plan?.specs?.coreFeatures)
      ? session.plan.specs.coreFeatures
      : undefined;
    const planInput = {
      ...session.input,
      answers: session.input.answers ?? session.input.answersToFollowUp ?? {},
    };
    const plan = await generatePlan(
      planInput,
      resolved.conn,
      resolved.model,
      languageFor(ctx),
      lockedFeatures,
      optionsFor(ctx),
    );
    session.plan = plan;
    session.planFeaturesEdited = false;
    saveArtifact(session);
    return shortPlanResult(plan);
  },
};

const generatePrdTool: ToolSpec = {
  def: {
    name: "generate_prd",
    description:
      "Create the PRD from the saved Project Plan using the prd role model. Saves the result to the session and returns a short summary. Call get_plan first if needed.",
    parameters: { type: "object", properties: {}, required: [] },
  },
  available: () => true,
  async run(_input: unknown, ctx: ToolContext): Promise<unknown> {
    const found = sessionOrError(ctx);
    if ("error" in found) return found;
    const session = found.session;
    if (!session.plan) return { error: "The plan has not been created yet. Create the plan before creating the PRD." };

    const resolved = roleConnection("prd");
    if ("error" in resolved) return resolved;
    const prd = await generatePrd(
      titleFor(session, languageFor(ctx)),
      session.plan,
      resolved.conn,
      resolved.model,
      languageFor(ctx),
      optionsFor(ctx),
    );
    session.prd = prd;
    saveArtifact(session);
    return shortPrdResult(prd);
  },
};

/** Cards past To do. The board's Sync keeps them; this tool replaces the whole list. */
export function startedTaskCount(tasks: unknown): number {
  return (Array.isArray(tasks) ? tasks : []).filter(
    (task) => task && typeof task === "object" && task.status && task.status !== "todo",
  ).length;
}

const generateTasksTool: ToolSpec = {
  def: {
    name: "generate_tasks",
    description:
      "Create atomic coding tasks from the saved Project Plan and PRD using the tasks role model. Saves the task board to the session and returns a short summary.",
    parameters: { type: "object", properties: {}, required: [] },
  },
  available: () => true,
  async run(_input: unknown, ctx: ToolContext): Promise<unknown> {
    const found = sessionOrError(ctx);
    if ("error" in found) return found;
    const session = found.session;
    if (!session.prd) return { error: "The PRD has not been created yet. Create the PRD before creating tasks." };
    const started = startedTaskCount(session.tasks);
    if (started > 0) {
      return {
        error: `The task board already has ${started} task(s) that were started, and this tool would replace the whole list and lose them. Tell the user to use Sync on the task board instead; it keeps started tasks.`,
      };
    }

    const resolved = roleConnection("tasks");
    if ("error" in resolved) return resolved;
    const generated: any = await generateTasks(
      titleFor(session, languageFor(ctx)),
      session.plan || {},
      session.prd,
      resolved.conn,
      resolved.model,
      languageFor(ctx),
      optionsFor(ctx),
    );
    const tasks = Array.isArray(generated) ? generated : generated?.tasks;
    if (!Array.isArray(tasks)) return { error: "The tasks pipeline did not return a valid task list." };

    session.tasks = tasks.map((task: any) => ({ ...task, status: task.status || "todo" }));
    saveArtifact(session);
    return shortTasksResult(session.tasks);
  },
};

const askFollowups: ToolSpec = {
  def: {
    name: "ask_followups",
    description:
      "Ask targeted clarifying questions about the project description. The questions are shown to the user through an interactive card; save the user's answers to the project input before continuing to generate_plan.",
    parameters: {
      type: "object",
      properties: {
        round: { type: "integer", description: "The next clarification round, starting from 1." },
        description: DESCRIPTION_PARAM,
      },
      required: [],
    },
  },
  available: () => true,
  async run(input: any, ctx: ToolContext): Promise<unknown> {
    const found = sessionOrError(ctx);
    if ("error" in found) return found;
    const session = found.session;
    const description = ensureDescription(session, input?.description);
    if (!description) return { error: "The project description has not been filled in yet." };

    const resolved = roleConnection("plan");
    if ("error" in resolved) return resolved;
    const currentRound = Math.max(
      1,
      Number(input?.round) || Number(session.clarificationRound || 0) + 1,
    );
    const previousAnswers = session.input.answersToFollowUp || {};
    const generated = await generateFollowups(
      {
        ...session.input,
        description,
        answers: previousAnswers,
        previousAnswers,
        round: currentRound,
      },
      resolved.conn,
      resolved.model,
      languageFor(ctx),
      optionsFor(ctx),
    );
    const questions = (Array.isArray(generated?.questions) ? generated.questions : []).map((question: any) => ({
      ...question,
      round: question.round ?? currentRound,
    }));

    session.followUps = questions;
    session.clarificationRound = currentRound;
    session.clarificationComplete = generated?.needsMoreInfo === false || questions.length === 0;
    session.readinessNote = generated?.readinessNote || "";

    if (questions.length === 0) {
      saveArtifact(session);
      return {
        ok: true,
        needsMoreInfo: false,
        summary: generated?.readinessNote || "There is enough project information to create the plan.",
        answers: previousAnswers,
      };
    }

    const response = await ctx.elicit({ kind: "questions", questions, round: currentRound });
    const answers = answerMap(response);
    if (Object.keys(answers).length === 0) {
      return {
        ok: false,
        needsMoreInfo: true,
        summary: "The follow-up questions have not been answered.",
        questions,
      };
    }

    session.input.answersToFollowUp = { ...previousAnswers, ...answers };
    saveArtifact(session);
    return {
      ok: true,
      needsMoreInfo: generated?.needsMoreInfo !== false,
      summary: resultMessage("answersSaved", { count: Object.keys(answers).length }),
      answers,
      questions,
    };
  },
};

export const pipelineTools: ToolSpec[] = [
  getPlan,
  getPrd,
  getTasks,
  generatePlanTool,
  generatePrdTool,
  generateTasksTool,
  askFollowups,
];
