import assert from "node:assert/strict";
import test from "node:test";

import { hasTransientFailure, withLastKnownCatalogs } from "./discovery.ts";
import { unknownCapabilities, type RuntimeDetection, type RuntimeDiscoveryReport, type RuntimeId } from "./types.ts";

function detection(overrides: Partial<RuntimeDetection> = {}): RuntimeDetection {
  return {
    runtime: "antigravity",
    status: "ready",
    authStatus: "unknown",
    binaryPath: "/fixture/agy",
    version: "1.2.8",
    checkedAt: "2026-09-23T08:00:00.000Z",
    capabilities: unknownCapabilities(),
    catalog: {
      connectionId: "runtime:antigravity",
      runtime: "antigravity",
      source: "antigravity-cli:agy models",
      discoveredAt: "2026-09-23T08:00:00.000Z",
      expiresAt: "2026-09-23T08:15:00.000Z",
      models: [{ modelId: "gemini-fixture" } as never],
      error: null,
    },
    diagnostic: null,
    ...overrides,
  };
}

const failed = (diagnostic: string, overrides: Partial<RuntimeDetection> = {}) =>
  detection({ status: "error", diagnostic, checkedAt: "2026-09-23T09:00:00.000Z", catalog: { ...detection().catalog!, models: [], error: diagnostic }, ...overrides });

function report(...runtimes: RuntimeDetection[]): RuntimeDiscoveryReport {
  return { checkedAt: runtimes[0]!.checkedAt, ttlMs: 900_000, runtimes };
}

test("a refresh that times out keeps the last good catalog, marked stale", () => {
  const lastKnown = new Map<RuntimeId, RuntimeDetection>();
  withLastKnownCatalogs(report(detection()), lastKnown);

  const [agy] = withLastKnownCatalogs(report(failed("METADATA_TIMEOUT")), lastKnown).runtimes;

  assert.equal(agy?.status, "ready");
  assert.equal(agy?.catalog?.stale, true);
  assert.equal(agy?.catalog?.models.length, 1);
  // The age shown is that of the read that succeeded, not of this attempt.
  assert.equal(agy?.catalog?.discoveredAt, "2026-09-23T08:00:00.000Z");
  assert.equal(agy?.catalog?.error, "METADATA_TIMEOUT");
  assert.equal(agy?.checkedAt, "2026-09-23T09:00:00.000Z");
});

test("a login problem, an empty list or another version is not covered up", () => {
  for (const next of [
    detection({ status: "needs_login", diagnostic: "AUTH_REQUIRED", catalog: null }),
    failed("MODEL_CATALOG_EMPTY"),
    failed("METADATA_TIMEOUT", { version: "1.3.0" }),
  ]) {
    const lastKnown = new Map<RuntimeId, RuntimeDetection>();
    withLastKnownCatalogs(report(detection()), lastKnown);

    const [agy] = withLastKnownCatalogs(report(next), lastKnown).runtimes;

    assert.equal(agy?.catalog?.stale, undefined, next.diagnostic ?? "");
    assert.equal(agy?.status, next.status);
    // And the old catalog cannot come back on a later timeout.
    const [later] = withLastKnownCatalogs(report(failed("METADATA_TIMEOUT", { version: next.version })), lastKnown).runtimes;
    assert.equal(later?.catalog?.stale, undefined, next.diagnostic ?? "");
  }
});

test("a good read replaces the kept catalog and is not marked stale", () => {
  const lastKnown = new Map<RuntimeId, RuntimeDetection>();
  withLastKnownCatalogs(report(detection()), lastKnown);
  withLastKnownCatalogs(report(failed("METADATA_TIMEOUT")), lastKnown);

  const fresh = detection({ checkedAt: "2026-09-23T10:00:00.000Z", catalog: { ...detection().catalog!, discoveredAt: "2026-09-23T10:00:00.000Z" } });
  const [agy] = withLastKnownCatalogs(report(fresh), lastKnown).runtimes;

  assert.equal(agy?.catalog?.stale, undefined);
  assert.equal(lastKnown.get("antigravity")?.catalog?.discoveredAt, "2026-09-23T10:00:00.000Z");
});

test("a runtime that timed out with nothing to fall back on is a transient failure", () => {
  assert.equal(hasTransientFailure(report(failed("METADATA_TIMEOUT"))), true);
  assert.equal(hasTransientFailure(report(detection(), failed("PROCESS_ERROR", { runtime: "codex" }))), true);
});

test("a timeout covered by the last good catalog, a login problem, or a good read is not", () => {
  const lastKnown = new Map<RuntimeId, RuntimeDetection>();
  withLastKnownCatalogs(report(detection()), lastKnown);
  assert.equal(hasTransientFailure(withLastKnownCatalogs(report(failed("METADATA_TIMEOUT")), lastKnown)), false);
  assert.equal(hasTransientFailure(report(failed("AUTH_REQUIRED"))), false);
  assert.equal(hasTransientFailure(report(detection())), false);
});
