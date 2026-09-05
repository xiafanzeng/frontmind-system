import { createHash } from "node:crypto";
import { lstat, readdir, readFile, rm } from "node:fs/promises";
import path from "node:path";

import { and, eq } from "drizzle-orm";

import { knowledgeBaseBuilds } from "../drizzle/schema";
import { installImmutableFileAtomically } from "./atomic-immutable-file";
import { getDb } from "./db";

const BUILD_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const GENERATION_DIRECTORY_PATTERN = /^g([1-9][0-9]*)$/u;
const SOURCE_FILENAME_PATTERN = /^[a-f0-9]{64}\.bin$/u;
const TERMINAL_MARKER_FILENAME = ".retention-terminal.json";

export const KNOWLEDGE_BASE_BUILD_SOURCE_RETENTION_MS =
  30 * 24 * 60 * 60 * 1_000;

export type KnowledgeBaseBuildSourceTerminalReason =
  | "published"
  | "cancelled"
  | "reset";

export type KnowledgeBaseBuildSourceLifecycle = {
  exists: boolean;
  status: string | null;
  generation: number | null;
  terminalAt: Date | null;
};

export type ResolveKnowledgeBaseBuildSourceLifecycle = (input: {
  userId: number;
  buildId: string;
  generation: number;
}) => Promise<KnowledgeBaseBuildSourceLifecycle>;

type KnowledgeBaseBuildSourceTerminalMarker = {
  schemaVersion: 1;
  userId: number;
  buildId: string;
  generation: number;
  reason: KnowledgeBaseBuildSourceTerminalReason;
  terminalAt: string;
  proofSha256: string;
};

function assetRoot() {
  return path.resolve(
    process.env.FRONTMIND_DASHBOARD_ASSET_DIR ||
      path.join(process.cwd(), ".frontmind-dashboard-assets"),
  );
}

function sourceRoot() {
  return path.join(assetRoot(), "knowledge-base", "build-sources");
}

function markerProof(
  marker: Omit<KnowledgeBaseBuildSourceTerminalMarker, "proofSha256">,
) {
  return createHash("sha256").update(JSON.stringify(marker)).digest("hex");
}

function assertIdentity(input: {
  userId: number;
  buildId: string;
  generation?: number;
}) {
  if (
    !Number.isSafeInteger(input.userId) ||
    input.userId < 1 ||
    !BUILD_ID_PATTERN.test(input.buildId) ||
    (input.generation !== undefined &&
      (!Number.isSafeInteger(input.generation) || input.generation < 1))
  ) {
    throw new Error(
      "Knowledge-base build source lifecycle identity is invalid",
    );
  }
}

function buildDirectory(input: { userId: number; buildId: string }) {
  assertIdentity(input);
  return path.join(
    sourceRoot(),
    String(input.userId),
    input.buildId.toLowerCase(),
  );
}

function generationDirectory(input: {
  userId: number;
  buildId: string;
  generation: number;
}) {
  assertIdentity(input);
  return path.join(buildDirectory(input), `g${input.generation}`);
}

async function isRealDirectory(target: string) {
  try {
    return (await lstat(target)).isDirectory();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function retainedGenerationNumbers(input: {
  userId: number;
  buildId: string;
}) {
  const target = buildDirectory(input);
  if (!(await isRealDirectory(target))) return [];
  const entries = await readdir(target, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => GENERATION_DIRECTORY_PATTERN.exec(entry.name))
    .filter((match): match is RegExpExecArray => Boolean(match))
    .map((match) => Number(match[1]))
    .filter((generation) => Number.isSafeInteger(generation))
    .sort((left, right) => left - right);
}

async function generationContainsSource(target: string) {
  if (!(await isRealDirectory(target))) return false;
  return (await readdir(target, { withFileTypes: true })).some(
    (entry) => entry.isFile() && SOURCE_FILENAME_PATTERN.test(entry.name),
  );
}

function parseTerminalMarker(
  raw: string,
  expected: { userId: number; buildId: string; generation: number },
) {
  let candidate: unknown;
  try {
    candidate = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    return null;
  }
  const marker = candidate as KnowledgeBaseBuildSourceTerminalMarker;
  const base = {
    schemaVersion: 1 as const,
    userId: marker.userId,
    buildId: marker.buildId,
    generation: marker.generation,
    reason: marker.reason,
    terminalAt: marker.terminalAt,
  };
  if (
    marker.schemaVersion !== 1 ||
    marker.userId !== expected.userId ||
    marker.buildId !== expected.buildId.toLowerCase() ||
    marker.generation !== expected.generation ||
    !["published", "cancelled", "reset"].includes(marker.reason) ||
    !Number.isFinite(Date.parse(marker.terminalAt)) ||
    marker.proofSha256 !== markerProof(base)
  ) {
    return null;
  }
  return marker;
}

async function readTerminalMarker(input: {
  userId: number;
  buildId: string;
  generation: number;
}) {
  const markerPath = path.join(
    generationDirectory(input),
    TERMINAL_MARKER_FILENAME,
  );
  try {
    return parseTerminalMarker(await readFile(markerPath, "utf8"), input);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function writeTerminalMarker(input: {
  userId: number;
  buildId: string;
  generation: number;
  reason: KnowledgeBaseBuildSourceTerminalReason;
  terminalAt: Date;
}) {
  const target = generationDirectory(input);
  if (!Number.isFinite(input.terminalAt.getTime())) {
    throw new Error("Knowledge-base build source terminal time is invalid");
  }
  if (!(await generationContainsSource(target))) return "missing" as const;

  const current = await readTerminalMarker(input);
  if (current) return "exists" as const;

  const base = {
    schemaVersion: 1 as const,
    userId: input.userId,
    buildId: input.buildId.toLowerCase(),
    generation: input.generation,
    reason: input.reason,
    terminalAt: input.terminalAt.toISOString(),
  };
  const marker: KnowledgeBaseBuildSourceTerminalMarker = {
    ...base,
    proofSha256: markerProof(base),
  };
  const result = await installImmutableFileAtomically({
    target: path.join(target, TERMINAL_MARKER_FILENAME),
    buffer: Buffer.from(`${JSON.stringify(marker)}\n`, "utf8"),
  });
  if (result === "exists" && !(await readTerminalMarker(input))) {
    throw new Error("Knowledge-base build source terminal marker is invalid");
  }
  return result;
}

/** Record terminal retention for one exact build generation. */
export async function markKnowledgeBaseBuildSourceGenerationTerminal(input: {
  userId: number;
  buildId: string;
  generation: number;
  reason: KnowledgeBaseBuildSourceTerminalReason;
  terminalAt: Date;
}) {
  return writeTerminalMarker(input);
}

/**
 * Records a terminal proof for every retained generation currently owned by a
 * build. Failure is intentionally fail-closed: callers may leak bytes, but a
 * missing or malformed proof can never make the sweeper delete them.
 */
export async function markKnowledgeBaseBuildSourcesTerminal(input: {
  userId: number;
  buildId: string;
  reason: KnowledgeBaseBuildSourceTerminalReason;
  terminalAt: Date;
}) {
  const generations = await retainedGenerationNumbers(input);
  const results = await Promise.allSettled(
    generations.map((generation) =>
      writeTerminalMarker({ ...input, generation }),
    ),
  );
  return {
    generations: generations.length,
    marked: results.filter(
      (result) => result.status === "fulfilled" && result.value !== "missing",
    ).length,
    failed: results.filter((result) => result.status === "rejected").length,
  };
}

function terminalReason(status: string | null) {
  return status === "published" || status === "cancelled" || status === "reset"
    ? status
    : null;
}

function terminalBeforeCutoff(terminalAt: Date | null, cutoff: number) {
  return Boolean(
    terminalAt &&
      Number.isFinite(terminalAt.getTime()) &&
      terminalAt.getTime() <= cutoff,
  );
}

async function defaultResolveBuildLifecycle(input: {
  userId: number;
  buildId: string;
  generation: number;
}): Promise<KnowledgeBaseBuildSourceLifecycle> {
  const db = await getDb();
  if (!db) throw new Error("Database is not configured");
  const rows = await db
    .select({
      id: knowledgeBaseBuilds.id,
      status: knowledgeBaseBuilds.status,
      generation: knowledgeBaseBuilds.generation,
      publishedAt: knowledgeBaseBuilds.publishedAt,
      completedAt: knowledgeBaseBuilds.completedAt,
      updatedAt: knowledgeBaseBuilds.updatedAt,
    })
    .from(knowledgeBaseBuilds)
    .where(
      and(
        eq(knowledgeBaseBuilds.userId, input.userId),
        eq(knowledgeBaseBuilds.id, input.buildId),
      ),
    )
    .limit(1);
  const build = rows[0];
  if (!build) {
    return { exists: false, status: null, generation: null, terminalAt: null };
  }
  const status = String(build.status);
  return {
    exists: true,
    status,
    generation: build.generation,
    terminalAt:
      status === "published"
        ? build.publishedAt
        : status === "cancelled" || status === "reset"
          ? build.completedAt || build.updatedAt
          : null,
  };
}

async function listRetainedGenerations(limit: number) {
  const candidates: Array<{
    userId: number;
    buildId: string;
    generation: number;
  }> = [];
  if (!(await isRealDirectory(sourceRoot()))) return candidates;
  const users = await readdir(sourceRoot(), { withFileTypes: true });
  for (const userEntry of users.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!userEntry.isDirectory() || !/^[1-9][0-9]*$/u.test(userEntry.name)) {
      continue;
    }
    const userId = Number(userEntry.name);
    if (!Number.isSafeInteger(userId)) continue;
    const userDirectory = path.join(sourceRoot(), userEntry.name);
    const builds = await readdir(userDirectory, { withFileTypes: true });
    for (const buildEntry of builds.sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      if (
        !buildEntry.isDirectory() ||
        !BUILD_ID_PATTERN.test(buildEntry.name)
      ) {
        continue;
      }
      for (const generation of await retainedGenerationNumbers({
        userId,
        buildId: buildEntry.name,
      })) {
        candidates.push({
          userId,
          buildId: buildEntry.name.toLowerCase(),
          generation,
        });
        if (candidates.length >= limit) return candidates;
      }
    }
  }
  return candidates;
}

function deletionAuthorized(input: {
  lifecycle: KnowledgeBaseBuildSourceLifecycle;
  marker: KnowledgeBaseBuildSourceTerminalMarker | null;
  generation: number;
  cutoff: number;
}) {
  if (!input.lifecycle.exists) {
    return Boolean(
      input.marker && Date.parse(input.marker.terminalAt) <= input.cutoff,
    );
  }
  if (
    !terminalReason(input.lifecycle.status) ||
    !terminalBeforeCutoff(input.lifecycle.terminalAt, input.cutoff)
  ) {
    return false;
  }
  return input.lifecycle.generation === input.generation;
}

/**
 * Removes only one exact build generation after 30 days of terminal state.
 * Every delete is fenced by a second lifecycle lookup. Active builds retain
 * every generation, even if a stale marker happens to exist on disk.
 */
export async function sweepKnowledgeBaseBuildSources(
  input: {
    now?: Date;
    retentionMs?: number;
    limit?: number;
    resolveBuildLifecycle?: ResolveKnowledgeBaseBuildSourceLifecycle;
  } = {},
) {
  const now = input.now ?? new Date();
  const retentionMs = Math.max(
    KNOWLEDGE_BASE_BUILD_SOURCE_RETENTION_MS,
    Math.trunc(input.retentionMs ?? KNOWLEDGE_BASE_BUILD_SOURCE_RETENTION_MS),
  );
  if (!Number.isFinite(now.getTime())) throw new Error("Sweep time is invalid");
  const limit = Math.min(10_000, Math.max(1, Math.trunc(input.limit ?? 250)));
  const cutoff = now.getTime() - retentionMs;
  const resolve = input.resolveBuildLifecycle ?? defaultResolveBuildLifecycle;
  const candidates = await listRetainedGenerations(limit);
  let deleted = 0;
  let retained = 0;
  let failed = 0;

  for (const candidate of candidates) {
    try {
      const marker = await readTerminalMarker(candidate);
      const lifecycle = await resolve(candidate);
      if (
        !deletionAuthorized({
          lifecycle,
          marker,
          generation: candidate.generation,
          cutoff,
        })
      ) {
        retained += 1;
        continue;
      }

      // A build can change between scan and deletion. Re-resolve immediately
      // before touching bytes; an active row always wins over any file marker.
      const fence = await resolve(candidate);
      if (
        !deletionAuthorized({
          lifecycle: fence,
          marker,
          generation: candidate.generation,
          cutoff,
        })
      ) {
        retained += 1;
        continue;
      }
      const target = generationDirectory(candidate);
      if (!(await isRealDirectory(target))) {
        retained += 1;
        continue;
      }
      await rm(target, { recursive: true, force: false });
      deleted += 1;
    } catch {
      failed += 1;
    }
  }
  return { scanned: candidates.length, deleted, retained, failed };
}
