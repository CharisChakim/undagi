import assert from "node:assert/strict";
import test from "node:test";

import { renderPrdMarkdown } from "../../shared/prdMarkdown.ts";

// Shaped like a PRD from before goals, users, non-goals and risks were asked for.
const generated = {
  projectTitle: "Shop Stock",
  overview: "A stock tracker for one corner shop.",
  requirements: {
    functional: [
      { id: "FR-01", category: "Authentication", description: "The owner signs in with email", acceptanceCriteria: ["Email is validated", "Redirects to the dashboard"] },
      { id: "FR-02", category: "Stock", description: "The owner records deliveries" },
    ],
    nonFunctional: [{ category: "Performance", specification: "Pages load in under 2 s" }],
  },
  coreFeatures: { phase1: ["Stock list", "Low-stock warning"], phase2: ["Reports"], phase3: [], futurePhases: ["Mobile app"] },
  userFlow: "Sign in -> list -> edit",
  logicFlowMermaid: "graph LR\n  A[Owner] --> B[Stock]",
  logicFlowExplanation: "The owner goes from sign-in to the stock list.",
  architecture: "A web app with a small API.",
  databaseSchema: [
    { entity: "Products", fields: [{ name: "id", type: "UUID", description: "Primary key" }, { name: "qty", type: "INT", description: "Units | on hand" }] },
  ],
  techStack: [{ layer: "Frontend", technology: "React", rationale: "Fast to build" }],
  additionalSections: [{ number: 8, title: "Testing Plan", content: "Unit tests for the stock rules." }],
};

test("an older PRD renders its seven sections, in order, from its fields", () => {
  const md = renderPrdMarkdown(generated, "en");

  const headings = md.split("\n").filter((line) => line.startsWith("## "));
  assert.deepEqual(headings, [
    "## 1. Overview", "## 2. Scope & Release Plan", "## 3. Requirements", "## 4. User Flow",
    "## 5. Architecture", "## 6. Data Model", "## 7. Tech Stack", "## 8. Testing Plan",
  ]);
  assert.ok(md.startsWith("# PRD - Shop Stock\n"));
  assert.match(md, /- \*\*FR-01\*\* Authentication: The owner signs in with email\n {2}- Acceptance criteria:\n {4}- Email is validated\n {4}- Redirects to the dashboard/);
  assert.match(md, /- \*\*FR-02\*\* Stock: The owner records deliveries\n/);
  assert.match(md, /### Non-functional requirements\n\n- \*\*Performance\*\*: Pages load in under 2 s/);
  assert.match(md, /### Phase 1 \(MVP\)\n- Stock list\n- Low-stock warning/);
  assert.match(md, /### Later phases\n- Mobile app/);
  assert.ok(!md.includes("### Phase 3"), "an empty phase is left out");
  assert.match(md, /```mermaid\ngraph LR\n {2}A\[Owner\] --> B\[Stock\]\n```\n\nThe owner goes from sign-in/);
  assert.match(md, /### Products\n\n\| Field \| Type \| Description \|\n\| --- \| --- \| --- \|\n\| id \| UUID \| Primary key \|/);
  assert.match(md, /\| Frontend \| React \| Fast to build \|/);
  assert.match(md, /## 8\. Testing Plan\n\nUnit tests for the stock rules\.\n$/);
});

test("the same fields always give the same document", () => {
  assert.equal(renderPrdMarkdown(generated, "en"), renderPrdMarkdown(structuredClone(generated), "en"));
});

test("headings follow the language", () => {
  const md = renderPrdMarkdown(generated, "id");

  assert.match(md, /## 1\. Gambaran Umum/);
  assert.match(md, /## 6\. Model Data/);
  assert.match(md, /### Kebutuhan non-fungsional/);
  assert.match(md, /\| Bidang \| Tipe \| Keterangan \|/);
  assert.match(md, /- Kriteria penerimaan:/);
});

test("a pipe or a line break in a cell does not break the table", () => {
  const md = renderPrdMarkdown(generated, "en");

  assert.match(md, /\| qty \| INT \| Units \\\| on hand \|/);
  const row = renderPrdMarkdown({ ...generated, databaseSchema: [{ entity: "T", fields: [{ name: "a", type: "TEXT", description: "line one\nline two" }] }] });
  assert.match(row, /\| a \| TEXT \| line one line two \|/);
});

test("points the user edited into plain text pass through, and nothing prints as undefined", () => {
  const md = renderPrdMarkdown({
    projectTitle: "",
    overview: "Edited overview",
    requirements: "[Functional] Sign in\n[Non-functional] Fast",
    coreFeatures: {},
    userFlow: "Flow",
    architecture: "Arch",
    databaseSchema: "Table: users",
    techStack: "React + Node",
  }, "en");

  assert.ok(md.startsWith("# PRD - Project Requirements Document\n"));
  assert.match(md, /## 3\. Requirements\n\n\[Functional\] Sign in\n\[Non-functional\] Fast\n/);
  assert.match(md, /## 6\. Data Model\n\nTable: users\n/);
  assert.match(md, /## 7\. Tech Stack\n\nReact \+ Node\n/);
  assert.ok(!/undefined|\[object Object\]|NaN/.test(md));
});

test("older sessions that named the phases in Indonesian still render them", () => {
  const md = renderPrdMarkdown({ ...generated, coreFeatures: { fase1: ["Satu"], fase2: ["Dua"], fase3Plus: ["Tiga"] } }, "en");

  assert.match(md, /### Phase 1 \(MVP\)\n- Satu/);
  assert.match(md, /### Phase 2\n- Dua/);
  assert.match(md, /### Phase 3\n- Tiga/);
});

test("an empty or malformed PRD still renders its seven headings", () => {
  for (const input of [null, undefined, "text", {}, { requirements: 5, techStack: [null, 3], databaseSchema: [7] }]) {
    const md = renderPrdMarkdown(input, "en");
    assert.equal(md.split("\n").filter((line) => /^## [1-7]\./.test(line)).length, 7);
    assert.ok(!/undefined|\[object Object\]/.test(md));
  }
});

// Shaped like the answer the PRD prompt asks for now.
const current = {
  ...generated,
  goals: [{ goal: "Know what to reorder", metric: "Low-stock items seen before they run out", target: "9 in 10" }],
  targetUsers: [{ name: "Shop owner", description: "Records stock on a phone between customers." }],
  nonGoals: ["Online payments", "More than one shop"],
  requirements: {
    functional: [{
      id: "FR-01",
      title: "Record a delivery",
      userStory: "As a shop owner, I want to record a delivery so that stock stays right.",
      priority: "Must",
      acceptanceCriteria: ["Saving 10 units raises stock by 10"],
    }],
    nonFunctional: [{ category: "Performance", specification: "Pages load in under 2 s" }],
  },
  assumptions: ["The owner has a phone"],
  risks: [{ risk: "Counts drift", mitigation: "Weekly stock check" }],
  openQuestions: [],
  additionalSections: [{ number: 8, title: "Testing Plan", content: "Unit tests." }],
};

test("a current PRD renders the product sections, then the technical ones, then the extras after them", () => {
  const md = renderPrdMarkdown(current, "en");

  const headings = md.split("\n").filter((line) => line.startsWith("## "));
  assert.deepEqual(headings, [
    "## 1. Overview", "## 2. Goals & Success Metrics", "## 3. Target Users", "## 4. Scope & Release Plan",
    "## 5. Requirements", "## 6. User Flow", "## 7. Assumptions, Risks & Open Questions",
    "## 8. Architecture", "## 9. Data Model", "## 10. Tech Stack", "## 11. Testing Plan",
  ]);
  assert.match(md, /\| Goal \| Metric \| Target \|\n\| --- \| --- \| --- \|\n\| Know what to reorder \| Low-stock items seen before they run out \| 9 in 10 \|/);
  assert.match(md, /- \*\*Shop owner\*\*: Records stock on a phone between customers\./);
  assert.match(md, /### Out of scope \(non-goals\)\n- Online payments\n- More than one shop/);
  assert.match(md, /- \*\*FR-01\*\* Record a delivery: As a shop owner, I want to record a delivery so that stock stays right\. \(Must\)\n {2}- Acceptance criteria:\n {4}- Saving 10 units raises stock by 10/);
  assert.match(md, /### Assumptions\n- The owner has a phone/);
  assert.match(md, /### Risks\n\n\| Risk \| Mitigation \|\n\| --- \| --- \|\n\| Counts drift \| Weekly stock check \|/);
  assert.ok(!md.includes("### Open questions"), "an empty list is left out");
});

test("sections the user edited into text pass through", () => {
  const md = renderPrdMarkdown({ ...current, goals: "Sell more", nonGoals: ["No payments"], risks: "Drift" }, "id");

  assert.match(md, /## 2\. Tujuan & Metrik Keberhasilan\n\nSell more\n/);
  assert.match(md, /### Di luar lingkup \(non-goals\)\n- No payments/);
  assert.match(md, /### Risiko\nDrift\n/);
  assert.ok(!/undefined|\[object Object\]/.test(md));
});
