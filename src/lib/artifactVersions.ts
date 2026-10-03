import type { AgentTask, PRDArtifactVersion, PRDData } from "../types";

/**
 * The markdown document is the canonical PRD payload. Older sessions may not
 * have one, so fall back to a stable JSON representation of the PRD fields.
 */
export function prdContent(prd: PRDData): string {
  if (typeof prd.fullMarkdownText === "string" && prd.fullMarkdownText.length > 0) {
    return prd.fullMarkdownText;
  }

  // Version pointers are metadata about the PRD, so they must not become part
  // of the content hash when a legacy PRD is backfilled with its first version.
  const {
    artifactVersionId: _artifactVersionId,
    artifactVersionNumber: _artifactVersionNumber,
    artifactContentHash: _artifactContentHash,
    ...contentFields
  } = prd;
  return JSON.stringify(contentFields);
}

/**
 * A small synchronous content hash keeps version creation usable in event
 * handlers and in environments without Web Crypto (including unit tests).
 * It is used for identity/deduplication, not for security.
 */
export function hashArtifactContent(content: string): string {
  const bytes = new TextEncoder().encode(content);
  let hash = 14695981039346656037n;

  for (const byte of bytes) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 1099511628211n);
  }

  return hash.toString(16).padStart(16, "0");
}

export interface PrdVersionResult {
  version: PRDArtifactVersion;
  versions: PRDArtifactVersion[];
  created: boolean;
}

/**
 * Add a PRD version without ever duplicating a content hash. Version content
 * and identity are copied into a fresh object; only lifecycle status changes
 * when a different version becomes current.
 */
export function recordPrdVersion(
  prd: PRDData,
  previousVersions: PRDArtifactVersion[] = [],
  now = new Date(),
): PrdVersionResult {
  const content = prdContent(prd);
  const contentHash = hashArtifactContent(content);
  const versionsWithoutDuplicateHashes = previousVersions.filter(
    (item, index, versions) => versions.findIndex((candidate) => candidate.contentHash === item.contentHash) === index,
  );
  const existing = versionsWithoutDuplicateHashes.find((item) => item.contentHash === contentHash);

  if (existing) {
    const versions = versionsWithoutDuplicateHashes.map((item) => ({
      ...item,
      status: item.id === existing.id ? "active" as const : "superseded" as const,
    }));
    return { version: { ...existing, status: "active" }, versions, created: false };
  }

  const nextNumber = versionsWithoutDuplicateHashes.reduce((max, item) => Math.max(max, item.number || 0), 0) + 1;
  const version: PRDArtifactVersion = {
    id: `prd-${nextNumber}-${contentHash.slice(0, 12)}`,
    number: nextNumber,
    timestamp: now.toISOString(),
    contentHash,
    content,
    status: "active",
  };

  const versions = [
    ...versionsWithoutDuplicateHashes.map((item) => ({ ...item, status: "superseded" as const })),
    version,
  ];

  return { version, versions, created: true };
}

export function currentPrdVersion(versions: PRDArtifactVersion[] = []): PRDArtifactVersion | undefined {
  return versions.find((version) => version.status === "active") || versions[versions.length - 1];
}

export function attachPrdVersionToPrd(prd: PRDData, version: PRDArtifactVersion): PRDData {
  return {
    ...prd,
    artifactVersionId: version.id,
    artifactVersionNumber: version.number,
    artifactContentHash: version.contentHash,
  };
}

function sourceHash(task: AgentTask): string | undefined {
  return task.sourcePrdContentHash || task.prdContentHash;
}

export function hasPrdSource(task: AgentTask): boolean {
  return Boolean(sourceHash(task) || task.sourcePrdVersionId || task.prdVersionId);
}

/** A card that was started: a run or the user moved it off To do. */
export function hasProgress(task: AgentTask): boolean {
  return task.status !== undefined && task.status !== "todo";
}

/** Sync leaves these alone: cards the user added, and generated ones already worked on. */
export function isKeptOnSync(task: AgentTask): boolean {
  return !hasPrdSource(task) || hasProgress(task);
}

/** How a sync would treat the board, for the confirmation: cards replaced and cards kept. */
export function syncImpact(tasks: AgentTask[] = []): { replaced: number; kept: number } {
  const kept = tasks.filter(isKeptOnSync).length;
  return { replaced: tasks.length - kept, kept };
}

/**
 * Keep the cards sync leaves alone, put the generated ones after them, and rename
 * generated IDs on collision. With `version`, a kept generated card is marked as
 * synced to it: the user was told it stays as it is, so it is not stale.
 */
export function mergeGeneratedTasks(
  existingTasks: AgentTask[] = [],
  generatedTasks: AgentTask[] = [],
  version?: PRDArtifactVersion,
): AgentTask[] {
  const manualTasks = existingTasks.filter(isKeptOnSync).map((task) =>
    version && hasPrdSource(task) ? attachPrdVersionToTasks([task], version)[0]! : task
  );
  const usedIds = new Set(manualTasks.map((task) => task.id));
  const idMap = new Map<string, string>();

  const uniqueGenerated = generatedTasks.map((task) => {
    const originalId = task.id;
    let id = originalId;
    let suffix = 2;
    while (usedIds.has(id)) id = `${originalId}-generated-${suffix++}`;
    usedIds.add(id);
    if (!idMap.has(originalId)) idMap.set(originalId, id);
    return id === originalId ? task : { ...task, id };
  });

  return [
    ...manualTasks,
    ...uniqueGenerated.map((task) => ({
      ...task,
      dependencies: task.dependencies.map((dependency) => idMap.get(dependency) ?? dependency),
    })),
  ];
}

export function taskNeedsPrdSync(task: AgentTask, version?: PRDArtifactVersion): boolean {
  if (!version || !hasPrdSource(task)) return task.syncStatus === "needs_sync" || task.needsSync === true;
  return (
    task.syncStatus === "needs_sync" ||
    task.needsSync === true ||
    (Boolean(sourceHash(task)) && sourceHash(task) !== version.contentHash)
  );
}

/** Mark generated tasks from an older PRD as needing an explicit sync. */
export function markTasksNeedsSync(
  tasks: AgentTask[] = [],
  version?: PRDArtifactVersion,
): AgentTask[] {
  if (!version) return tasks;

  return tasks.map((task) => {
    if (!hasPrdSource(task)) return task;
    const stale = sourceHash(task) !== version.contentHash;
    return {
      ...task,
      syncStatus: stale ? "needs_sync" : "current",
      needsSync: stale,
    };
  });
}

/** Attach the source snapshot to freshly generated tasks. */
export function attachPrdVersionToTasks(
  tasks: AgentTask[] = [],
  version?: PRDArtifactVersion,
): AgentTask[] {
  if (!version) return tasks;

  return tasks.map((task) => ({
    ...task,
    sourcePrdVersionId: version.id,
    sourcePrdVersionNumber: version.number,
    sourcePrdContentHash: version.contentHash,
    // Keep the short names for clients that already model artifact references
    // directly on a task. They are aliases, not a second source of truth.
    prdVersionId: version.id,
    prdVersionNumber: version.number,
    prdContentHash: version.contentHash,
    syncStatus: "current" as const,
    needsSync: false,
  }));
}
