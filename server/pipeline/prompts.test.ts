import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildFollowupsPrompt,
  buildFollowupsSystemPrompt,
  NO_AI_OPTION,
} from "./followups.ts";
import { languageDirective, newAppTitle, type Lang } from "./language.ts";
import {
  buildPlanPrompt,
  buildPlanResyncPrompt,
  buildPlanResyncSystemPrompt,
  buildPlanSystemPrompt,
} from "./plan.ts";
import { buildPrdPrompt, buildPrdSystemPrompt } from "./prd.ts";
import { buildTasksPrompt, buildTasksSystemPrompt, cleanExistingTasks } from "./tasks.ts";

const LANGS: Lang[] = ["en", "id"];

const planInput = {
  description: "A habit tracker for runners",
  answers: { "Who uses it?": "Casual runners" },
};
const lockedFeatures = [{ name: "Run log", priority: "P0", subFeatures: ["Add run", "Edit run"] }];
const plan = { summary: "Track runs", specs: { coreFeatures: lockedFeatures, techStack: [] }, architectureDraft: {} };
const prd = { overview: "Overview", coreFeatures: {}, userFlow: "Open -> Log", techStack: [], databaseSchema: [] };

// Every prompt a human language can produce, keyed for readable failures.
function allPrompts(humanLang: Lang): Record<string, string> {
  return {
    planSystem: buildPlanSystemPrompt(humanLang),
    planUser: buildPlanPrompt(planInput),
    resyncSystem: buildPlanResyncSystemPrompt(lockedFeatures, humanLang),
    resyncUser: buildPlanResyncPrompt(planInput),
    prdSystem: buildPrdSystemPrompt(humanLang),
    prdUser: buildPrdPrompt("Run Log", plan),
    tasksSystem: buildTasksSystemPrompt(humanLang),
    tasksUser: buildTasksPrompt("Run Log", plan, prd),
    followupsSystem1: buildFollowupsSystemPrompt(humanLang, 1),
    followupsSystem2: buildFollowupsSystemPrompt(humanLang, 2),
    followupsUser: buildFollowupsPrompt({ description: "A habit tracker for runners" }, humanLang),
    followupsUserRound2: buildFollowupsPrompt(
      { description: "A habit tracker for runners", previousAnswers: { "Sync?": "Yes" }, round: 2 },
      humanLang,
    ),
  };
}

function hasKeys(text: string, keys: string[]): void {
  for (const key of keys) assert.match(text, new RegExp(`"${key}"\\s*:`), `missing JSON key "${key}"`);
}

test("instruction scaffolding is English for both human languages", () => {
  const indonesian = /\b(anda|tugas|kembalikan|pengguna|fase|sedang|minggu|jawaban|wajib|dengan|yang|untuk|dan|adalah|tidak|rendah|tinggi|pilihan|aplikasi|buatkan|ajukan)\b/i;
  for (const humanLang of LANGS) {
    for (const [name, prompt] of Object.entries(allPrompts(humanLang))) {
      // The forced option and the saved-data fallback are the two deliberate Indonesian strings.
      const scaffolding = prompt.replaceAll(NO_AI_OPTION.id, "").replaceAll(newAppTitle("id"), "");
      assert.doesNotMatch(scaffolding, indonesian, `${humanLang}/${name} still has Indonesian text`);
    }
  }
});

test("no Indonesian example values in the English-scaffold prompts", () => {
  for (const humanLang of LANGS) {
    for (const [name, prompt] of Object.entries(allPrompts(humanLang))) {
      for (const leftover of ["Fase", "Sedang", "Minggu", "Rendah", "Tinggi"]) {
        assert.ok(!prompt.includes(leftover), `${humanLang}/${name} contains "${leftover}"`);
      }
    }
  }
});

test("system prompts carry the language directive for the human language", () => {
  for (const humanLang of LANGS) {
    const directive = languageDirective({ humanLang });
    const prompts = allPrompts(humanLang);
    for (const name of ["planSystem", "resyncSystem", "prdSystem", "followupsSystem1", "followupsSystem2"]) {
      assert.ok(prompts[name].includes(directive), `${humanLang}/${name} is missing the directive`);
    }
    const tasksDirective = languageDirective({
      humanLang,
      agentLang: "en",
      agentFields: ["promptInstructions", "verificationSteps"],
    });
    assert.ok(prompts.tasksSystem.includes(tasksDirective));
  }
});

test("only the tasks prompt names agent-facing fields", () => {
  const sentence = "Write coding-agent-facing values (promptInstructions, verificationSteps) in English.";
  for (const humanLang of LANGS) {
    const prompts = allPrompts(humanLang);
    assert.ok(prompts.tasksSystem.includes(sentence));
    for (const name of ["planSystem", "resyncSystem", "prdSystem", "followupsSystem1", "followupsSystem2"]) {
      assert.doesNotMatch(prompts[name], /coding-agent-facing/, `${humanLang}/${name}`);
    }
  }
});

test("tasks prompt follows the agent language independently of the human one", () => {
  const fields = "(promptInstructions, verificationSteps)";
  assert.match(buildTasksSystemPrompt("id", "en"), /in Indonesian\.[^]*\(promptInstructions, verificationSteps\) in English\./);
  assert.match(buildTasksSystemPrompt("id", "id"), /in Indonesian\.[^]*\(promptInstructions, verificationSteps\) in Indonesian\./);
  assert.match(buildTasksSystemPrompt("en", "id"), /in English\.[^]*\(promptInstructions, verificationSteps\) in Indonesian\./);
  assert.ok(buildTasksSystemPrompt("en").includes(`${fields} in English.`));
});

test("JSON key names stay the same in every schema", () => {
  const planKeys = [
    "suggestedTitle", "summary", "specs", "targetAudience", "keyValueProposition", "techStack", "layer",
    "technology", "rationale", "architectureDraft", "overview", "components", "name", "purpose", "type",
    "dataFlow", "securityAndAuth", "diagramMermaid", "roadmap", "phase", "title", "duration", "deliverables",
    "estimation", "totalTimeWeeks", "complexityLevel", "requiredResources", "potentialRisks", "risk", "mitigation",
  ];
  const featureKeys = ["coreFeatures", "description", "priority", "subFeatures"];
  const prdKeys = [
    "projectTitle", "overview", "requirements", "functional", "id", "category", "description", "acceptanceCriteria",
    "nonFunctional", "specification", "coreFeatures", "phase1", "phase2", "phase3", "futurePhases", "userFlow",
    "architecture", "databaseSchema", "entity", "fields", "name", "type", "techStack", "layer", "technology",
    "rationale", "additionalSections", "number", "title", "content", "logicFlowMermaid", "logicFlowExplanation",
    "fullMarkdownText",
  ];
  const taskKeys = [
    "tasks", "id", "phase", "title", "priority", "targetFiles", "dependencies", "promptInstructions",
    "verificationSteps", "status",
  ];
  const followupKeys = [
    "needsMoreInfo", "readinessNote", "questions", "id", "category", "question", "explanation",
    "suggestedAnswer", "options",
  ];

  for (const humanLang of LANGS) {
    const prompts = allPrompts(humanLang);
    hasKeys(prompts.planSystem, [...planKeys, ...featureKeys]);
    hasKeys(prompts.resyncSystem, planKeys);
    assert.doesNotMatch(prompts.resyncSystem, /"coreFeatures"\s*:/, "resync schema must not ask for coreFeatures");
    hasKeys(prompts.prdSystem, prdKeys);
    hasKeys(prompts.tasksSystem, taskKeys);
    hasKeys(prompts.followupsSystem1, followupKeys);
  }
});

test("complexity is a neutral enum, not an Indonesian label", () => {
  const enumList = '"low", "medium", "high", "very_high"';
  for (const humanLang of LANGS) {
    const prompts = allPrompts(humanLang);
    for (const name of ["planSystem", "resyncSystem"]) {
      assert.ok(prompts[name].includes(`"complexityLevel": "medium", // exactly one of ${enumList}`), name);
    }
  }
});

test("task priority keeps its English enum values", () => {
  assert.ok(buildTasksSystemPrompt("id").includes('"priority": "High", // "High", "Medium", or "Low"'));
  assert.ok(buildTasksSystemPrompt("id").includes('"status": "todo"'));
});

test("translated rules keep their constraints", () => {
  const prompts = allPrompts("en");
  for (const name of ["planSystem", "resyncSystem"]) {
    const text = prompts[name];
    assert.match(text, /'graph LR' OR 'flowchart LR'/);
    assert.match(text, /MAXIMUM 12 nodes/);
    assert.match(text, /'subgraph' blocks per layer/);
    assert.match(text, /do NOT add an "AI Engine"/);
  }
  assert.match(prompts.planSystem, /broken down into 2 to 6 sub features/);
  assert.match(prompts.planSystem, /\(2-4 words\)/);
  assert.match(prompts.resyncSystem, /ALREADY FINAL/);
  assert.ok(prompts.resyncSystem.includes(JSON.stringify(lockedFeatures, null, 2)));
  assert.match(prompts.prdSystem, /7 MAIN POINTS/);
  assert.match(prompts.prdSystem, /"additionalSections": \[\]/);
  assert.match(prompts.prdSystem, /'graph LR' or 'flowchart LR'/);
  assert.match(prompts.tasksSystem, /initial status "todo"/);
  assert.match(prompts.followupsSystem1, /There is NO limit on the number of questions/);
  assert.match(prompts.followupsSystem1, /3 to 4 structured answer choices/);
  assert.ok(prompts.followupsSystem1.includes('"id": "r1q1"'));
  assert.ok(prompts.followupsSystem2.includes('"id": "r2q1"'));
});

test("the forced round-1 follow-up option is Indonesian only for the Indonesian UI", () => {
  const english = buildFollowupsSystemPrompt("en", 1);
  assert.ok(english.includes(`option "${NO_AI_OPTION.en}"`));
  assert.ok(!english.includes(NO_AI_OPTION.id));

  const indonesian = buildFollowupsSystemPrompt("id", 1);
  assert.ok(indonesian.includes(`option "${NO_AI_OPTION.id}"`));
  assert.ok(!indonesian.includes(NO_AI_OPTION.en));

  // Later rounds do not force it at all.
  for (const humanLang of LANGS) {
    const later = buildFollowupsSystemPrompt(humanLang, 2);
    assert.ok(!later.includes(NO_AI_OPTION.en) && !later.includes(NO_AI_OPTION.id));
    assert.doesNotMatch(later, /MANDATORY IN THIS ROUND 1/);
  }
  assert.equal(NO_AI_OPTION.id, "Tidak perlu AI, cukup logika biasa");
});

test("the follow-up default title follows the human language", () => {
  assert.match(buildFollowupsPrompt({ description: "x" }, "en"), /Project Title: New App\n/);
  assert.match(buildFollowupsPrompt({ description: "x" }, "id"), /Project Title: Aplikasi Baru\n/);
  assert.match(buildFollowupsPrompt({ title: "Run Log", description: "x" }, "id"), /Project Title: Run Log\n/);
});

test("follow-up round and previous answers reach the user prompt", () => {
  const text = buildFollowupsPrompt(
    { description: "x", previousAnswers: { "Sync?": "Yes" }, round: 2 },
    "en",
  );
  assert.match(text, /CLARIFICATION ROUND 2/);
  assert.ok(text.includes("- Sync?\n  Answer: Yes"));
});

test("plan user prompt omits empty optional lines and formats answers", () => {
  const text = buildPlanPrompt({ ...planInput, title: "Run Log", targetAudience: "Runners" });
  assert.ok(text.includes('Temporary name used by the system: Run Log'));
  assert.ok(text.includes("Target Users: Runners"));
  assert.ok(text.includes("- Who uses it?: Casual runners"));
  assert.ok(!buildPlanPrompt({ description: "x" }).includes("Target Users:"));
  assert.ok(buildPlanPrompt({ description: "x" }).includes("No additional answers from the follow-up."));
});

test("the task generator asks for a runnable verifyCommand, or an empty one", () => {
  const system = buildTasksSystemPrompt("en");
  assert.match(system, /"verifyCommand": "npm run build"/);
  assert.match(system, /exits 0/);
  assert.match(system, /Leave it "" when no command can check the task/);
  assert.match(system, /Never use destructive commands/);
});

test("the task generator keeps verifyCommand to one command, since Windows PowerShell 5.1 has no &&", () => {
  const system = buildTasksSystemPrompt("en");
  assert.match(system, /one plain command with no chaining or piping/);
  assert.match(system, /Windows PowerShell 5\.1, which has no `&&`/);
});

test("the task prompt lists cards that stay on the board, and only when there are some", () => {
  const plan = { specs: {} };
  const prd = { overview: "x" };
  assert.ok(!buildTasksPrompt("App", plan, prd).includes("already on the board"));

  const prompt = buildTasksPrompt("App", plan, prd, [
    { id: "TASK-01", title: "Set up the project", status: "done", targetFiles: ["package.json", "src/types.ts"] },
    { id: "TASK-02", title: "Add auth", targetFiles: [] },
  ]);
  assert.match(prompt, /already on the board and stay as they are/);
  assert.match(prompt, /do not reuse their IDs/);
  assert.match(prompt, /- TASK-01 \[done\] Set up the project \(package\.json, src\/types\.ts\)/);
  assert.match(prompt, /- TASK-02 Add auth\n?$/);
});

test("existing cards from a request are cut down to ids, titles, statuses and files", () => {
  const cleaned = cleanExistingTasks([
    { id: "A", title: "  Spaced \n title ", status: "done", targetFiles: ["a.ts", 5, ""], agentNote: "ignore me" },
    { id: "", title: "no id" },
    "not a card",
    null,
  ]);

  assert.deepEqual(cleaned, [{ id: "A", title: "Spaced title", status: "done", targetFiles: ["a.ts"] }]);
  assert.deepEqual(cleanExistingTasks("nope"), []);
  assert.equal(cleanExistingTasks(Array.from({ length: 150 }, (_, i) => ({ id: `T${i}`, title: "t" }))).length, 100);
});

test("from round 3 the clarification prompt asks the model to stop unless a gap would make the plan wrong", () => {
  assert.ok(!buildFollowupsSystemPrompt("en", 2).includes("THIS IS ROUND"));
  const third = buildFollowupsSystemPrompt("en", 3);
  assert.match(third, /THIS IS ROUND 3/);
  assert.match(third, /would make the plan wrong/);
  assert.match(third, /"needsMoreInfo": false/);
});
