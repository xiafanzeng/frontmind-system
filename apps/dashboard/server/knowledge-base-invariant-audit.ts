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
import { activateKnowledgeBaseInvariantWriteBlock } from "./knowledge-base-runtime-guard";
import { inspectKnowledgeBaseRetryAuthority } from "./knowledge-base-turn-service";

export type KnowledgeBaseInvariantViolation = {
  code: string;
  buildId: string;
  generation: number;
  turnId?: string | null;
};

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
          isValidRetryableFailedActiveTurn(build, active)
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
    if (
      build.status === "ready_to_publish" &&
      (!build.packageStorageKey ||
        !build.packageArchiveSha256 ||
        !build.packageSizeBytes ||
        !build.logoStorageKey ||
        !build.logoSha256 ||
        !build.logoBytes ||
        build.packageRevision !== build.revision ||
        build.currentLeafId !== null)
    ) {
      violations.push({
        code: "READY_ARTIFACT_BINDING_INVALID",
        buildId: build.id,
        generation: build.generation,
      });
    }
  }
  return violations;
}

export async function auditKnowledgeBaseStateInvariants(
  input: {
    limit?: number;
    blockWritesOnP0?: boolean;
  } = {},
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
        build.status !== "ready_to_publish" ||
        !build.packageArchiveSha256 ||
        !build.packageSizeBytes ||
        !build.logoSha256 ||
        !build.logoBytes
      ) {
        continue;
      }
      for (const kind of ["logo", "package"] as const) {
        try {
          await readKnowledgeBuildArtifact({
            userId: build.userId,
            buildId: build.id,
            generation: build.generation,
            kind,
            storageKey:
              kind === "logo"
                ? build.logoStorageKey || undefined
                : build.packageStorageKey || undefined,
            expectedSha256:
              kind === "logo" ? build.logoSha256 : build.packageArchiveSha256,
            expectedBytes:
              kind === "logo" ? build.logoBytes : build.packageSizeBytes,
          });
        } catch {
          violations.push({
            code:
              kind === "logo"
                ? "LOGO_INTEGRITY_MISMATCH"
                : "PACKAGE_INTEGRITY_MISMATCH",
            buildId: build.id,
            generation: build.generation,
          });
        }
      }
    }

    afterBuildId = builds.at(-1)!.id;
    if (builds.length < pageSize) break;
  }

  if (violations.length > 0) {
    console.error(
      "[KnowledgeBaseInvariant] p0",
      JSON.stringify({
        count: violations.length,
        samples: violations.slice(0, 20),
      }),
    );
    if (input.blockWritesOnP0 !== false) {
      activateKnowledgeBaseInvariantWriteBlock(violations[0]!.code);
    }
  }
  return { scanned, violations };
}
