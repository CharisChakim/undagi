import express, { type Response } from "express";
import { createJevClient, JevError, type JevClient } from "./client.ts";
import { adviseDependencies, adviseIntake, adviseIntent, type AdviseDeps } from "./features.ts";
import { getJevSettings, readJevKey, updateJevSettings } from "./store.ts";
import { JEV_FEATURES, type JevSettingsPatch, type JevTaskInput } from "./types.ts";

/** Chat message characters accepted by /intent (features.ts trims further before sending). */
const MAX_MESSAGE_CHARS = 4000;
/** Description characters accepted by /intake. */
const MAX_DESCRIPTION_CHARS = 8000;
/** Intake answers accepted per request. */
const MAX_ANSWERS = 50;
/** Characters accepted per intake answer. */
const MAX_ANSWER_CHARS = 4000;
/** Tasks accepted by /dependencies; also the most features.ts will look at. */
const MAX_TASKS = 60;
/** Characters accepted for a task id. */
const MAX_TASK_ID_CHARS = 200;
/** Characters accepted for a task title. */
const MAX_TASK_TITLE_CHARS = 1000;
/** Characters accepted for a task's prompt instructions. */
const MAX_TASK_INSTRUCTIONS_CHARS = 20_000;
/** Target files or dependency ids accepted per task. */
const MAX_TASK_LIST_ITEMS = 100;
/** Characters accepted per target file path. */
const MAX_TASK_FILE_CHARS = 500;
/** Real keys are far shorter; the cap only stops absurd input from being stored. */
const MAX_KEY_CHARS = 512;
/** Header-safe: printable ASCII, no spaces or control characters. */
const KEY_SHAPE = /^[\x21-\x7e]+$/;

class RequestError extends Error {
  constructor(message: string, readonly statusCode = 400) {
    super(message);
  }
}

function sendError(res: Response, error: unknown, label: string): void {
  // Only our own validation messages are shown; anything else could name internals,
  // so it is logged by type alone and answered with a fixed line.
  if (error instanceof RequestError) {
    res.status(error.statusCode).json({ error: error.message });
    return;
  }
  console.error(`Error ${label}:`, error instanceof Error ? error.name : "unknown");
  res.status(500).json({ error: "Jev request failed." });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function bodyOf(body: unknown): Record<string, unknown> {
  if (!isRecord(body)) throw new RequestError("Request body must be an object.");
  return body;
}

function boundedString(value: unknown, field: string, max: number): string {
  if (typeof value !== "string") throw new RequestError(`${field} must be a string.`);
  if (value.length > max) throw new RequestError(`${field} must be at most ${max} characters.`);
  return value;
}

function optionalFlag(value: unknown, field: string): boolean {
  if (value === undefined) return false;
  if (typeof value !== "boolean") throw new RequestError(`${field} must be a boolean.`);
  return value;
}

function stringList(value: unknown, field: string, maxItems: number, maxChars: number): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new RequestError(`${field} must be an array of strings.`);
  if (value.length > maxItems) throw new RequestError(`${field} must have at most ${maxItems} items.`);
  return value.map((item, index) => boundedString(item, `${field}[${index}]`, maxChars));
}

function settingsPatch(body: unknown): JevSettingsPatch {
  const input = bodyOf(body);
  const patch: JevSettingsPatch = {};

  if (input.enabled !== undefined) {
    if (typeof input.enabled !== "boolean") throw new RequestError("enabled must be a boolean.");
    patch.enabled = input.enabled;
  }

  if (input.apiKey !== undefined) {
    if (input.apiKey !== null && typeof input.apiKey !== "string") {
      throw new RequestError("apiKey must be a string or null.");
    }
    if (typeof input.apiKey === "string") {
      const trimmed = input.apiKey.trim();
      if (trimmed && (trimmed.length > MAX_KEY_CHARS || !KEY_SHAPE.test(trimmed))) {
        // The value is never echoed back, not even in an error.
        throw new RequestError("apiKey has an invalid format.");
      }
    }
    patch.apiKey = input.apiKey as string | null;
  }

  if (input.features !== undefined) {
    if (!isRecord(input.features)) throw new RequestError("features must be an object.");
    const features: NonNullable<JevSettingsPatch["features"]> = {};
    for (const name of JEV_FEATURES) {
      const value = input.features[name];
      if (value === undefined) continue;
      if (typeof value !== "boolean") throw new RequestError(`features.${name} must be a boolean.`);
      features[name] = value;
    }
    patch.features = features;
  }

  return patch;
}

function taskInputs(value: unknown): JevTaskInput[] {
  if (!Array.isArray(value)) throw new RequestError("tasks must be an array.");
  if (value.length > MAX_TASKS) throw new RequestError(`tasks must have at most ${MAX_TASKS} items.`);

  return value.map((raw, index) => {
    const field = `tasks[${index}]`;
    if (!isRecord(raw)) throw new RequestError(`${field} must be an object.`);
    const id = boundedString(raw.id, `${field}.id`, MAX_TASK_ID_CHARS);
    if (!id.trim()) throw new RequestError(`${field}.id is required.`);
    const task: JevTaskInput = {
      id,
      title: boundedString(raw.title, `${field}.title`, MAX_TASK_TITLE_CHARS),
      dependencies: stringList(raw.dependencies, `${field}.dependencies`, MAX_TASK_LIST_ITEMS, MAX_TASK_ID_CHARS),
    };
    if (raw.targetFiles !== undefined) {
      task.targetFiles = stringList(raw.targetFiles, `${field}.targetFiles`, MAX_TASK_LIST_ITEMS, MAX_TASK_FILE_CHARS);
    }
    if (raw.promptInstructions !== undefined) {
      task.promptInstructions = boundedString(
        raw.promptInstructions,
        `${field}.promptInstructions`,
        MAX_TASK_INSTRUCTIONS_CHARS,
      );
    }
    return task;
  });
}

export interface JevRouterDeps {
  /** Tests point the client at a fake upstream; production builds the default one. */
  createClient?: (apiKey: string) => JevClient;
}

export function createJevRouter(routerDeps: JevRouterDeps = {}): express.Router {
  const router = express.Router();
  const makeClient = routerDeps.createClient ?? ((apiKey: string) => createJevClient({ apiKey }));

  // Without a key there is nothing to call, and features.ts answers null by itself.
  function adviseDeps(): AdviseDeps | undefined {
    if (!routerDeps.createClient) return undefined;
    const apiKey = readJevKey();
    return apiKey ? { client: makeClient(apiKey) } : undefined;
  }

  router.get("/api/jev/settings", (_req, res) => {
    try {
      res.json(getJevSettings());
    } catch (error) {
      sendError(res, error, "GET /api/jev/settings");
    }
  });

  router.put("/api/jev/settings", (req, res) => {
    try {
      res.json(updateJevSettings(settingsPatch(req.body)));
    } catch (error) {
      sendError(res, error, "PUT /api/jev/settings");
    }
  });

  router.post("/api/jev/test", async (_req, res) => {
    try {
      const apiKey = readJevKey();
      if (!apiKey) {
        res.json({ ok: false, error: "No API key saved" });
        return;
      }
      const started = Date.now();
      try {
        await makeClient(apiKey).evaluate("The sky is blue.", {
          ping: { type: "noul", instructions: "Is the statement in the state about a colour?" },
        });
        res.json({ ok: true, latencyMs: Date.now() - started });
      } catch (error) {
        // JevError messages are written to be safe; any other error is reduced to a fixed line.
        res.json({ ok: false, error: error instanceof JevError ? error.message : "Jev test failed" });
      }
    } catch (error) {
      sendError(res, error, "POST /api/jev/test");
    }
  });

  router.post("/api/jev/intent", async (req, res) => {
    try {
      const body = bodyOf(req.body);
      const advice = await adviseIntent({
        message: boundedString(body.message, "message", MAX_MESSAGE_CHARS),
        hasPlan: optionalFlag(body.hasPlan, "hasPlan"),
        hasPrd: optionalFlag(body.hasPrd, "hasPrd"),
        hasTasks: optionalFlag(body.hasTasks, "hasTasks"),
      }, adviseDeps());
      res.json({ advice });
    } catch (error) {
      sendError(res, error, "POST /api/jev/intent");
    }
  });

  router.post("/api/jev/intake", async (req, res) => {
    try {
      const body = bodyOf(req.body);
      const advice = await adviseIntake({
        description: boundedString(body.description, "description", MAX_DESCRIPTION_CHARS),
        answers: stringList(body.answers, "answers", MAX_ANSWERS, MAX_ANSWER_CHARS),
      }, adviseDeps());
      res.json({ advice });
    } catch (error) {
      sendError(res, error, "POST /api/jev/intake");
    }
  });

  router.post("/api/jev/dependencies", async (req, res) => {
    try {
      const advice = await adviseDependencies(taskInputs(bodyOf(req.body).tasks), adviseDeps());
      res.json({ advice });
    } catch (error) {
      sendError(res, error, "POST /api/jev/dependencies");
    }
  });

  return router;
}

export const jevRouter = createJevRouter();
