import assert from "node:assert/strict";
import { test } from "node:test";

import { additionalPointTitle, agentLangOf, EXAMPLE_VALUES_NOTE, languageDirective, newAppTitle } from "./language.ts";

const HUMAN_EN = "Write user-facing text values (names, titles, summaries, descriptions, questions, rationale…) in English.";
const HUMAN_ID = "Write user-facing text values (names, titles, summaries, descriptions, questions, rationale…) in Indonesian.";
const KEEP = "Keep JSON keys, enum values, identifiers, file paths, code and commands exactly as specified, never translated.";
const FIELDS = ["promptInstructions", "verificationSteps"];

test("directive covers the four human/agent language combinations", () => {
  const agentSentence = (language: string) =>
    `Write coding-agent-facing values (promptInstructions, verificationSteps) in ${language}.`;

  assert.equal(
    languageDirective({ humanLang: "en", agentLang: "en", agentFields: FIELDS }),
    `${HUMAN_EN} ${agentSentence("English")} ${KEEP}`,
  );
  assert.equal(
    languageDirective({ humanLang: "id", agentLang: "en", agentFields: FIELDS }),
    `${HUMAN_ID} ${agentSentence("English")} ${KEEP}`,
  );
  assert.equal(
    languageDirective({ humanLang: "id", agentLang: "id", agentFields: FIELDS }),
    `${HUMAN_ID} ${agentSentence("Indonesian")} ${KEEP}`,
  );
  assert.equal(
    languageDirective({ humanLang: "en", agentLang: "id", agentFields: FIELDS }),
    `${HUMAN_EN} ${agentSentence("Indonesian")} ${KEEP}`,
  );
});

test("directive leaves out the agent sentence without agent fields", () => {
  for (const agentFields of [undefined, []]) {
    const text = languageDirective({ humanLang: "id", agentLang: "id", agentFields });
    assert.equal(text, `${HUMAN_ID} ${KEEP}`);
    assert.doesNotMatch(text, /coding-agent-facing/);
  }
});

test("directive defaults the agent language to English", () => {
  assert.match(languageDirective({ humanLang: "id", agentFields: FIELDS }), /\(promptInstructions, verificationSteps\) in English\./);
});

test("agentLangOf follows the interface language only for \"ui\"", () => {
  assert.equal(agentLangOf({ body: { agentLanguage: "ui" } }, "id"), "id");
  assert.equal(agentLangOf({ body: { agentLanguage: "ui" } }, "en"), "en");
  assert.equal(agentLangOf({ body: { agentLanguage: "en" } }, "id"), "en");
  for (const body of [{}, { agentLanguage: "id" }, { agentLanguage: "UI" }, { agentLanguage: null }, undefined]) {
    assert.equal(agentLangOf({ body }, "id"), "en");
  }
  assert.equal(agentLangOf({}, "id"), "en");
});

test("fallback strings written into data follow the interface language", () => {
  assert.equal(newAppTitle("en"), "New App");
  assert.equal(newAppTitle("id"), "Aplikasi Baru");
  assert.equal(additionalPointTitle("en", 9), "Additional point 9");
  assert.equal(additionalPointTitle("id", 9), "Poin Tambahan 9");
});

test("the example-values note is English scaffolding", () => {
  assert.match(EXAMPLE_VALUES_NOTE, /only illustrate the shape/);
});
