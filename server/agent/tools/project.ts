import type { ToolContext, ToolSpec } from "../registry.ts";
import { getSession, saveSession } from "../../../db.ts";

// Tool proyek selalu tersedia karena agent perlu dapat membaca dan mengubah
// proyek yang sedang dibuka, terlepas dari izin folder kerja atau shell.
export const projectTools: ToolSpec[] = [
  {
    def: {
      name: "get_project",
      description:
        "Read the current state of the project: the plan summary, the feature list with sub-features and priorities, whether a PRD exists, and the number of tasks per status. Call this first before changing anything, so changes are based on the actual content, not guesses.",
      parameters: { type: "object", properties: {}, required: [] },
    },
    available: () => true,
    async run(_input: unknown, ctx: ToolContext): Promise<unknown> {
      const session = getSession(ctx.sessionId);
      if (!session) return { error: `Session ${ctx.sessionId} not found.` };

      return {
        title: session.input?.title || session.title || "",
        currentStep: session.currentStep,
        summary: session.plan?.summary || null,
        features: (session.plan?.specs?.coreFeatures || []).map((f: any) => ({
          name: f.name,
          description: f.description,
          priority: f.priority,
          subFeatures: f.subFeatures || [],
        })),
        hasPrd: Boolean(session.prd),
        tasks: (session.tasks || []).map((t: any) => ({ id: t.id, title: t.title, status: t.status || "todo" })),
        planFeaturesEdited: Boolean(session.planFeaturesEdited),
      };
    },
  },
  {
    def: {
      name: "update_features",
      description:
        "Replace the entire core feature list of the project. Send the complete desired list, not only what changed — the old entries are replaced in full. Using this marks the architecture, diagram, roadmap, and estimate as no longer in sync, so the user is asked to realign them.",
      parameters: {
        type: "object",
        properties: {
          features: {
            type: "array",
            description: "The complete feature list after the change.",
            items: {
              type: "object",
              properties: {
                name: { type: "string", description: "Feature name, short." },
                description: { type: "string", description: "One to two sentences." },
                priority: { type: "string", enum: ["P0", "P1", "P2"], description: "P0 MVP, P1 important, P2 later." },
                subFeatures: {
                  type: "array",
                  items: { type: "string" },
                  description: "Concrete breakdown, 2-4 words per item.",
                },
              },
              required: ["name", "description", "priority", "subFeatures"],
            },
          },
        },
        required: ["features"],
      },
    },
    available: () => true,
    async run(input: any, ctx: ToolContext): Promise<unknown> {
      const session = getSession(ctx.sessionId);
      if (!session) return { error: `Session ${ctx.sessionId} not found.` };
      if (!session.plan) return { error: "This project has no plan yet, so there are no features to change." };
      const features = Array.isArray(input?.features) ? input.features : [];
      if (features.length === 0) return { error: "The feature list is empty. Send the complete desired list." };

      session.plan.specs.coreFeatures = features.map((f: any) => ({
        name: String(f?.name ?? "").trim(),
        description: String(f?.description ?? "").trim(),
        priority: ["P0", "P1", "P2"].includes(f?.priority) ? f.priority : "P1",
        subFeatures: (Array.isArray(f?.subFeatures) ? f.subFeatures : [])
          .map((s: any) => String(s ?? "").trim())
          .filter((s: string) => s.length > 0),
      }));
      session.planFeaturesEdited = true;
      session.updatedAt = new Date().toISOString();
      saveSession(session);

      return {
        ok: true,
        featureCount: session.plan.specs.coreFeatures.length,
        note: "Features saved. The architecture, diagram, roadmap, and estimate are now marked as out of sync — the user can realign them with the button on the review page.",
      };
    },
  },
  {
    def: {
      name: "set_task_status",
      description:
        "Move one task on the kanban board to another column. Use the task id exactly as returned by get_project.",
      parameters: {
        type: "object",
        properties: {
          taskId: { type: "string", description: "Task id, e.g. TASK-01." },
          status: { type: "string", enum: ["todo", "in_progress", "blocked", "failed", "done"] },
        },
        required: ["taskId", "status"],
      },
    },
    available: () => true,
    async run(input: any, ctx: ToolContext): Promise<unknown> {
      const session = getSession(ctx.sessionId);
      if (!session) return { error: `Session ${ctx.sessionId} not found.` };
      const tasks = session.tasks || [];
      const task = tasks.find((t: any) => t.id === input?.taskId);
      if (!task) return { error: `Task ${input?.taskId} does not exist. Call get_project to see the available ids.` };

      // Enum di skema tool hanya petunjuk untuk model, bukan aturan yang ditegakkan
      // API. Papan kanban menyaring persis kelima nilai ini, jadi nilai lain tidak
      // membuat kartunya salah kolom — kartunya lenyap dari papan sama sekali.
      const allowed = ["todo", "in_progress", "blocked", "failed", "done"];
      if (!allowed.includes(input?.status)) {
        return {
          error: `Status "${input?.status}" is not recognized. Use one of: ${allowed.join(", ")}.`,
        };
      }
      task.status = input.status;
      session.updatedAt = new Date().toISOString();
      saveSession(session);
      return { ok: true, taskId: task.id, status: task.status };
    },
  },
];
