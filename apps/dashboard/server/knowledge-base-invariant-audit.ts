import { asc, gt, inArray } from "drizzle-orm";

import {
  conversationTurns,
  knowledgeBaseBuildNodes,
  knowledgeBaseBuilds,
  type ConversationTurn,
  type KnowledgeBaseBuild,
  type KnowledgeBaseBuildNode,
} from "../drizzle/schema";
import { getDb } from "./db";
import { readKnowledgeBuildArtifact } from "./knowledge-build-artifact-store";
import {
  inspectKnowledgeBaseLegacyProtocolTerminalHistoryAuthority,
  inspectKnowledgeBaseRetryAuthority,
  inspectKnowledgeBaseTerminalTaskCreateRejectionAuthority,
} from "./knowledge-base-turn-service";

export type KnowledgeBaseInvariantViolation = {
  code: string;
  buildId: string;
  generation: number;
  turnId?: string | null;
};

export type KnowledgeBaseInvariantAuditSnapshot = {
  scanned: number;
  degradedBuildCount: number;
  violationCount: number;
  completedAt: string | null;
};

let latestKnowledgeBaseInvariantAudit = {
  scanned: 0,
  violations: [] as KnowledgeBaseInvariantViolation[],
  completedAt: null as Date | null,
};

/**
 * Readiness exposes build-local degradation for diagnostics only. The value
 * deliberately has no influence on the readiness HTTP status or write path.
 */
export function getKnowledgeBaseInvariantAuditSnapshot(): KnowledgeBaseInvariantAuditSnapshot {
  return {
    scanned: latestKnowledgeBaseInvariantAudit.scanned,
    degradedBuildCount: new Set(
      latestKnowledgeBaseInvariantAudit.violations.map(
        (violation) => violation.buildId,
      ),
    ).size,
    violationCount: latestKnowledgeBaseInvariantAudit.violations.length,
    completedAt:
      latestKnowledgeBaseInvariantAudit.completedAt?.toISOString() ?? null,
  };
}

function isValidRetryableFailedActiveTurn(
  build: KnowledgeBaseBuild,
  turn: ConversationTurn,
) {
  return Boolean(
    build.status === "protocol_error" &&
      turn.status === "failed" &&
      turn.errorCode &&
      turn.errorCode === build.protocolErrorCode &&
      turn.buildGeneration === build.generation &&
      turn.expectedRevision === build.revision &&
      (turn.expectedLeafId ?? null) === (build.currentLeafId ?? null) &&
      turn.completedAt &&
      turn.leaseExpiresAt === null &&
      turn.operationKey &&
      inspectKnowledgeBaseRetryAuthority(turn, build),
  );
}

function isValidReadOnlyLegacyCreateRejection(
  build: KnowledgeBaseBuild,
  turn: ConversationTurn,
) {
  const metadata = (turn.metadata || {}) as Record<string, unknown>;
  return Boolean(
    metadata.createAttemptState === undefined &&
      inspectKnowledgeBaseTerminalTaskCreateRejectionAuthority(turn, build) &&
      !inspectKnowledgeBaseRetryAuthority(turn, build),
  );
}

function isValidReadOnlyLegacyProtocolFailedActiveTurn(
  build: KnowledgeBaseBuild,
  turn: ConversationTurn,
) {
  return Boolean(
    inspectKnowledgeBaseLegacyProtocolTerminalHistoryAuthority(turn, build) &&
      !inspectKnowledgeBaseRetryAuthority(turn, build),
  );
}

export function findKnowledgeBaseInvariantViolations(input: {
  builds: readonly KnowledgeBaseBuild[];
  turns: readonly ConversationTurn[];
  nodes: readonly KnowledgeBaseBuildNode[];
}) {
  const violations: KnowledgeBaseInvariantViolation[] = [];
  const turnsByBuild = new Map<string, ConversationTurn[]>();
  const nodesByBuild = new Map<string, KnowledgeBaseBuildNode[]>();
  for (const turn of input.turns) {
    const rows = turnsByBuild.get(turn.buildId || "") || [];
    rows.push(turn);
    turnsByBuild.set(turn.buildId || "", rows);
  }
  for (const node of input.nodes) {
    const rows = nodesByBuild.get(node.buildId) || [];
    rows.push(node);
    nodesByBuild.set(node.buildId, rows);
  }

  for (const build of input.builds) {
    const turns = turnsByBuild.get(build.id) || [];
    const nodes = nodesByBuild.get(build.id) || [];
    const liveTurns = turns.filter(
      (turn) =>
        turn.buildGeneration === build.generation &&
        (turn.status === "queued" || turn.status === "running"),
    );
    if (liveTurns.length > 1) {
      violations.push({
        code: "MULTIPLE_ACTIVE_TURNS",
        buildId: build.id,
        generation: build.generation,
      });
    }
    if (build.activeTurnId) {
      const active = turns.find((turn) => turn.id === build.activeTurnId);
      if (
        !active ||
        active.buildId !== build.id ||
        active.buildGeneration !== build.generation ||
        !(
          active.status === "queued" ||
          active.status === "running" ||
          isValidRetryableFailedActiveTurn(build, active) ||
          isValidReadOnlyLegacyCreateRejection(build, active) ||
          isValidReadOnlyLegacyProtocolFailedActiveTurn(build, active)
        )
      ) {
        violations.push({
          code: "INVALID_ACTIVE_TURN",
          buildId: build.id,
          generation: build.generation,
          turnId: build.activeTurnId,
        });
      }
    }
    if (
      build.status === "confirming" &&
      !build.activeTurnId &&
      build.currentLeafId
    ) {
      const current = nodes.find((node) => node.leafId === build.currentLeafId);
      if (!current?.contentMarkdown?.trim()) {
        violations.push({
          code: "AWAITING_INPUT_WITHOUT_PRESENTATION",
          buildId: build.id,
          generation: build.generation,
        });
      }
    }
    const currentRows = nodes.filter(
      (node) =>
        node.status === "current" || node.status === "needs_verification",
    );
    if (
      (build.currentLeafId &&
        (currentRows.length !== 1 ||
          currentRows[0]!.leafId !== build.currentLeafId)) ||
      (!build.currentLeafId && currentRows.length !== 0)
    ) {
      violations.push({
        code: "CURRENT_LEAF_MISMATCH",
        buildId: build.id,
        generation: build.generation,
      });
    }
    // `ready_to_publish` means the content transaction completed. Package and
    // optional Logo readiness are independent, recoverable resource states.
    if (build.status === "ready_to_publish" && build.currentLeafId !== null) {
      violations.push({
        code: "CONTENT_COMPLETION_COORDINATE_INVALID",
        buildId: build.id,
        generation: build.generation,
      });
    }
  }
  return violations;
}

export async function auditKnowledgeBaseStateInvariants(
  input: { limit?: number } = {},
) {
  const db = await getDb();
  if (!db)
    return {
      scanned: 0,
      violations: [] as KnowledgeBaseInvariantViolation[],
    };
  const pageSize = Math.min(
    2_000,
    Math.max(1, Math.trunc(input.limit ?? 2_000)),
  );
  const violations: KnowledgeBaseInvariantViolation[] = [];
  let scanned = 0;
  let afterBuildId: string | undefined;

  // A fixed unordered LIMIT permanently hid every build beyond the first
  // page. Walk the complete keyset in stable id order; `limit` is now a page
  // size, not permission to omit the rest of production state.
  for (;;) {
    const builds = afterBuildId
      ? await db
          .select()
          .from(knowledgeBaseBuilds)
          .where(gt(knowledgeBaseBuilds.id, afterBuildId))
          .orderBy(asc(knowledgeBaseBuilds.id))
          .limit(pageSize)
      : await db
          .select()
          .from(knowledgeBaseBuilds)
          .orderBy(asc(knowledgeBaseBuilds.id))
          .limit(pageSize);
    if (builds.length === 0) break;
    scanned += builds.length;
    const buildIds = builds.map((build) => build.id);
    const [turns, nodes] = await Promise.all([
      db
        .select()
        .from(conversationTurns)
        .where(inArray(conversationTurns.buildId, buildIds)),
      db
        .select()
        .from(knowledgeBaseBuildNodes)
        .where(inArray(knowledgeBaseBuildNodes.buildId, buildIds)),
    ]);
    violations.push(
      ...findKnowledgeBaseInvariantViolations({ builds, turns, nodes }),
    );

    for (const build of builds) {
      if (
        build.packageStatus !== "ready" ||
        !build.packageArchiveSha256 ||
        !build.packageSizeBytes
      ) {
        continue;
      }
      try {
        await readKnowledgeBuildArtifact({
          userId: build.userId,
          buildId: build.id,
          generation: build.generation,
          kind: "package",
          storageKey: build.packageStorageKey || undefined,
          expectedSha256: build.packageArchiveSha256,
          expectedBytes: build.packageSizeBytes,
        });
      } catch {
        violations.push({
          code: "PACKAGE_INTEGRITY_MISMATCH",
          buildId: build.id,
          generation: build.generation,
        });
      }
    }

    afterBuildId = builds.at(-1)!.id;
    if (builds.length < pageSize) break;
  }

  if (violations.length > 0) {
    console.warn(
      "[KnowledgeBaseInvariant] build_degraded",
      JSON.stringify({
        count: violations.length,
        samples: violations.slice(0, 20),
      }),
    );
  }
  latestKnowledgeBaseInvariantAudit = {
    scanned,
    violations: [...violations],
    completedAt: new Date(),
  };
  return { scanned, violations };
}
