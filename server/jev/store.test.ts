import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// db.ts reads this on first import, so the store is loaded dynamically afterwards.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "undagi-jev-store-test-"));
process.env.UNDAGI_DATA_DIR = dataDir;

const { db } = await import("../../db.ts");
process.on("exit", () => {
  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});
const { getJevSettings, readJevKey, updateJevSettings } = await import("./store.ts");

const OFF = { intentRouting: false, intakeCheck: false, permissionRisk: false, dependencyCheck: false };

test("defaults are everything off and no key", () => {
  assert.deepEqual(getJevSettings(), { enabled: false, hasKey: false, features: OFF });
  assert.equal(readJevKey(), null);
});

test("the key is stored trimmed and never appears in the public settings", () => {
  const key = `test-${randomUUID()}`;
  const saved = updateJevSettings({ apiKey: `  ${key}\n` });
  assert.equal(saved.hasKey, true);
  assert.equal(readJevKey(), key);
  assert.ok(!JSON.stringify(saved).includes(key));
  assert.ok(!JSON.stringify(getJevSettings()).includes(key));
  assert.deepEqual(Object.keys(saved).sort(), ["enabled", "features", "hasKey"]);
});

test("apiKey: omitted and null keep, empty and whitespace clear, a string replaces", () => {
  const first = `test-${randomUUID()}`;
  const second = `test-${randomUUID()}`;
  updateJevSettings({ apiKey: first });

  updateJevSettings({ enabled: true });
  assert.equal(readJevKey(), first);
  updateJevSettings({ apiKey: null });
  assert.equal(readJevKey(), first);
  updateJevSettings({ apiKey: second });
  assert.equal(readJevKey(), second);

  assert.equal(updateJevSettings({ apiKey: "" }).hasKey, false);
  assert.equal(readJevKey(), null);

  updateJevSettings({ apiKey: first });
  assert.equal(updateJevSettings({ apiKey: "   \t" }).hasKey, false);
  assert.equal(readJevKey(), null);
  assert.throws(() => updateJevSettings({ apiKey: 5 as unknown as string }), /apiKey must be a string or null/);
});

test("features merge per name, ignore unknown names and coerce to booleans", () => {
  updateJevSettings({ enabled: false, features: { intentRouting: true } });
  let settings = getJevSettings();
  assert.equal(settings.enabled, false);
  assert.deepEqual(settings.features, { ...OFF, intentRouting: true });

  settings = updateJevSettings({
    enabled: true,
    features: { permissionRisk: 1, intentRouting: undefined, nonsense: true } as never,
  });
  assert.equal(settings.enabled, true);
  assert.deepEqual(settings.features, { ...OFF, intentRouting: true, permissionRisk: true });
  assert.ok(!("nonsense" in settings.features));

  settings = updateJevSettings({ features: { intentRouting: false, permissionRisk: 0 as never } });
  assert.deepEqual(settings.features, OFF);
  assert.equal(settings.enabled, true);
});

test("a corrupt features column falls back to defaults instead of failing", () => {
  db.prepare("UPDATE jev_settings SET features = ? WHERE id = 1").run("{not json");
  assert.deepEqual(getJevSettings().features, OFF);
  db.prepare("UPDATE jev_settings SET features = ? WHERE id = 1").run("[1,2]");
  assert.deepEqual(getJevSettings().features, OFF);
});

test("the table holds a single row", () => {
  assert.throws(() =>
    db.prepare("INSERT INTO jev_settings (id, enabled, api_key, features, updated_at) VALUES (2, 0, '', '{}', '')").run(),
  );
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM jev_settings").get() as { n: number }).n, 1);
});
