import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  finalizeKnowledgeBaseReadyPackageBackfill,
  inspectKnowledgeBaseStateMachineBackfill,
  prepareKnowledgeBaseStateMachineBackfill,
  type KnowledgeBaseBackfillSummary,
} from "../server/knowledge-base-state-machine-backfill";

const apply = process.argv.includes("--apply");
const inventoryReviewed = process.argv.includes("--inventory-reviewed");
const finalizeReadyRebind = process.argv.includes("--finalize-ready-rebind");
const prepareOnly = process.argv.includes("--prepare-only");
const finalizeOnly = process.argv.includes("--finalize-only");
const limitArgument = process.argv.find((value) =>
  value.startsWith("--limit="),
);
const limit = limitArgument
  ? Number.parseInt(limitArgument.slice("--limit=".length), 10)
  : undefined;

async function inspectWithSkillPins() {
  const { getKnowledgeBaseSkillDescriptor } = await import(
    "../server/knowledge-base-api"
  );
  return inspectKnowledgeBaseStateMachineBackfill({
    resolveSkillPin: getKnowledgeBaseSkillDescriptor,
  });
}

function knowledgeBaseBuildNeedsRecoverableSkillPin(
  build: Awaited<ReturnType<typeof inspectWithSkillPins>>["builds"][number],
) {
  if (build.skillVersion !== "3" && build.skillVersion !== "4") return false;
  if (!build.activeTurnNeedsSkill) return false;
  if (build.status === "researching" || build.status === "confirming") {
    return true;
  }
  return (
    build.status === "protocol_error" &&
    ![
      "PACKAGE_REBIND_REQUIRED",
      "LEGACY_TASK_REBIND_REQUIRED",
      "LEGACY_CREDENTIAL_REBIND_REQUIRED",
    ].includes(build.protocolErrorCode || "")
  );
}

export function assertRecoverableSkillPins(
  inventory: Awaited<ReturnType<typeof inspectWithSkillPins>>,
) {
  const unresolved = inventory.builds.filter(
    (build) =>
      knowledgeBaseBuildNeedsRecoverableSkillPin(build) &&
      (build.skillPinStatus === "missing_hash" ||
        build.skillPinStatus === "unresolvable"),
  );
  if (unresolved.length > 0) {
    throw new Error(
      `KB_SKILL_PIN_UNRESOLVABLE:${unresolved
        .map((build) => build.buildId)
        .join(",")}`,
    );
  }
}

export function assertKnowledgeBaseBackfillCoverage(input: {
  inventory: Awaited<ReturnType<typeof inspectWithSkillPins>>;
  prepared: AggregateBackfillSummary;
}) {
  if (input.inventory.builds.some((build) => !build.activeTurnValid)) {
    throw new Error("KB_ACTIVE_TURN_INVALID");
  }
  const expected = input.inventory.builds.filter(
    (build) =>
      !build.hasActiveTurn &&
      ["researching", "confirming", "protocol_error"].includes(build.status),
  ).length;
  if (
    input.prepared.scanned !== expected ||
    input.prepared.dispositions.length !== input.prepared.scanned
  ) {
    throw new Error("KB_PREPARE_INVENTORY_MISMATCH");
  }
  if (
    input.prepared.dispositions.some(
      (disposition) =>
        disposition.actions.length === 0 ||
        disposition.actions.includes("skip_missing_or_active_turn"),
    )
  ) {
    throw new Error("KB_PREPARE_CANDIDATE_SKIPPED");
  }
}

export function assertKnowledgeBaseReservationsRecovered(input: {
  prepared: AggregateBackfillSummary;
  claimedTurnIds: readonly string[];
}) {
  const expectedTurnIds = input.prepared.dispositions
    .filter(
      (disposition) =>
        disposition.actions.includes("prepare_legacy_reconcile_reservation") &&
        !disposition.actions.includes("already_migrated"),
    )
    .map((disposition) => disposition.turnId)
    .filter((turnId): turnId is string => Boolean(turnId));
  if (
    expectedTurnIds.length !== input.prepared.reservationsCreated ||
    new Set(expectedTurnIds).size !== expectedTurnIds.length
  ) {
    throw new Error("KB_BACKFILL_RESERVATION_SET_INVALID");
  }
  const claimed = new Set(input.claimedTurnIds);
  const missing = expectedTurnIds.filter((turnId) => !claimed.has(turnId));
  if (missing.length > 0) {
    throw new Error("KB_BACKFILL_RESERVATION_NOT_RECOVERED");
  }
}

export function assertKnowledgeBaseReadyPackageBackfillFinalized(
  inventory: Awaited<ReturnType<typeof inspectWithSkillPins>>,
) {
  if (
    inventory.builds.some(
      (build) => build.status === "ready_to_publish" && !build.hasPackage,
    )
  ) {
    throw new Error("KB_READY_PACKAGE_BACKFILL_INCOMPLETE");
  }
}

type AggregateBackfillSummary = Omit<
  KnowledgeBaseBackfillSummary,
  "nextCursor" | "hasMore"
> & { pages: number };

export async function prepareAllKnowledgeBaseStateMachineBackfill(input: {
  apply: boolean;
  pageSize?: number;
  prepare?: typeof prepareKnowledgeBaseStateMachineBackfill;
}) {
  const prepare = input.prepare ?? prepareKnowledgeBaseStateMachineBackfill;
  const pageSize = Math.min(
    10_000,
    Math.max(1, Math.trunc(input.pageSize ?? 500)),
  );
  const aggregate: AggregateBackfillSummary = {
    pages: 0,
    scanned: 0,
    reservationsCreated: 0,
    staleErrorsCleared: 0,
    rebindRequired: 0,
    alreadyMigrated: 0,
    skipped: 0,
    dispositions: [],
  };
  let after: KnowledgeBaseBackfillSummary["nextCursor"] = null;
  for (let page = 0; page < 10_000; page += 1) {
    const result = await prepare({
      apply: input.apply,
      limit: pageSize,
      ...(after ? { after } : {}),
    });
    aggregate.pages += 1;
    aggregate.scanned += result.scanned;
    aggregate.reservationsCreated += result.reservationsCreated;
    aggregate.staleErrorsCleared += result.staleErrorsCleared;
    aggregate.rebindRequired += result.rebindRequired;
    aggregate.alreadyMigrated += result.alreadyMigrated;
    aggregate.skipped += result.skipped;
    aggregate.dispositions.push(...result.dispositions);
    if (!result.hasMore) return aggregate;
    if (!result.nextCursor) throw new Error("KB_PREPARE_CURSOR_MISSING");
    after = result.nextCursor;
  }
  throw new Error("KB_PREPARE_DRAIN_LIMIT");
}

export async function drainKnowledgeBaseRecovery(input: {
  recoverExpiredKnowledgeBaseTurns: typeof import("../server/knowledge-base-api").recoverExpiredKnowledgeBaseTurns;
  recoverOpenKnowledgeBaseTasks: typeof import("../server/knowledge-base-api").recoverOpenKnowledgeBaseTasks;
}) {
  const aggregate = {
    turnPasses: 0,
    turns: {
      scanned: 0,
      claimed: 0,
      rebound: 0,
      reconciled: 0,
      skipped: 0,
      failed: 0,
    },
    claimedTurnIds: [] as string[],
    buildPasses: 0,
    builds: {
      scanned: 0,
      reconciled: 0,
      skipped: 0,
      failed: 0,
      packageRebindRequired: 0,
    },
  };
  for (let pass = 0; pass < 100; pass += 1) {
    const result = await input.recoverExpiredKnowledgeBaseTurns({
      limit: 200,
      concurrency: 3,
      includeClaimedTurnIds: true,
    });
    aggregate.turnPasses += 1;
    for (const key of Object.keys(aggregate.turns) as Array<
      keyof typeof aggregate.turns
    >) {
      aggregate.turns[key] += result[key];
    }
    aggregate.claimedTurnIds.push(...result.claimedTurnIds);
    if (result.failed > 0) throw new Error("KB_TURN_RECOVERY_FAILED");
    if (result.skipped > 0) throw new Error("KB_TURN_RECOVERY_SKIPPED");
    if (result.scanned < 200) break;
    if (pass === 99) throw new Error("KB_TURN_RECOVERY_DRAIN_LIMIT");
  }
  let afterBuildId: string | undefined;
  for (let pass = 0; pass < 10_000; pass += 1) {
    const result = await input.recoverOpenKnowledgeBaseTasks({
      limit: 500,
      concurrency: 3,
      afterBuildId,
    });
    aggregate.buildPasses += 1;
    aggregate.builds.scanned += result.scanned;
    aggregate.builds.reconciled += result.reconciled;
    aggregate.builds.skipped += result.skipped;
    aggregate.builds.failed += result.failed;
    aggregate.builds.packageRebindRequired += result.packageRebindRequired ?? 0;
    if (result.failed > 0) throw new Error("KB_BUILD_RECOVERY_FAILED");
    if (result.skipped > 0) throw new Error("KB_BUILD_RECOVERY_SKIPPED");
    if (!result.hasMore) break;
    if (!result.nextCursor) throw new Error("KB_BUILD_RECOVERY_CURSOR_MISSING");
    afterBuildId = result.nextCursor;
    if (pass === 9_999) throw new Error("KB_BUILD_RECOVERY_DRAIN_LIMIT");
  }
  return aggregate;
}

async function main() {
  const before = await inspectWithSkillPins();
  if (!apply) {
    const prepared = await prepareAllKnowledgeBaseStateMachineBackfill({
      apply: false,
      pageSize: limit,
    });
    assertKnowledgeBaseBackfillCoverage({ inventory: before, prepared });
    const finalized = await finalizeKnowledgeBaseReadyPackageBackfill({
      apply: false,
    });
    console.log(
      JSON.stringify(
        { mode: "dry-run", inventory: before, prepared, finalized },
        null,
        2,
      ),
    );
    console.log(
      "知识库状态机回填预检完成；未修改数据库。确认备份后使用 --apply。",
    );
    return;
  }
  if (!inventoryReviewed) {
    throw new Error(
      "apply 前必须先保存并审核 dry-run 清单，再携带 --inventory-reviewed",
    );
  }
  assertRecoverableSkillPins(before);
  if (prepareOnly === finalizeOnly) {
    throw new Error(
      "apply 必须且只能选择 --prepare-only 或 --finalize-only 一个阶段",
    );
  }
  if (finalizeOnly) {
    if (!finalizeReadyRebind) {
      throw new Error("finalize-only 必须显式携带 --finalize-ready-rebind");
    }
    const finalized = await finalizeKnowledgeBaseReadyPackageBackfill({
      apply: true,
      confirmRebindRequired: true,
    });
    const after = await inspectWithSkillPins();
    assertKnowledgeBaseReadyPackageBackfillFinalized(after);
    console.log(
      JSON.stringify(
        {
          mode: "finalize-only",
          inventoryBefore: before,
          finalized,
          inventoryAfter: after,
        },
        null,
        2,
      ),
    );
    console.log("KB_V2_REBIND_FINALIZATION_COMPLETE");
    return;
  }

  const prepared = await prepareAllKnowledgeBaseStateMachineBackfill({
    apply: true,
    pageSize: limit,
  });
  assertKnowledgeBaseBackfillCoverage({ inventory: before, prepared });

  // Import lazily so dry-run cannot accidentally initialize any upstream
  // recovery path. These calls reuse stored encrypted credential bindings;
  // API keys and response bodies are never printed.
  const { recoverExpiredKnowledgeBaseTurns, recoverOpenKnowledgeBaseTasks } =
    await import("../server/knowledge-base-api");
  const recovery = await drainKnowledgeBaseRecovery({
    recoverExpiredKnowledgeBaseTurns,
    recoverOpenKnowledgeBaseTasks,
  });
  assertKnowledgeBaseReservationsRecovered({
    prepared,
    claimedTurnIds: recovery.claimedTurnIds,
  });
  const pendingFinalization = await finalizeKnowledgeBaseReadyPackageBackfill({
    apply: false,
  });
  const after = await inspectWithSkillPins();
  const { claimedTurnIds: _claimedTurnIds, ...recoverySummary } = recovery;
  console.log(
    JSON.stringify(
      {
        mode: "apply",
        inventoryBefore: before,
        prepared,
        recovery: recoverySummary,
        pendingFinalization,
        inventoryAfter: after,
      },
      null,
      2,
    ),
  );
  console.log("KB_V2_BACKFILL_RECOVERY_COMPLETE");
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  void main().catch((error) => {
    const code =
      error instanceof Error && /^KB_[A-Z0-9_]+(?::|$)/u.test(error.message)
        ? error.message.split(":", 1)[0]
        : "KB_V2_BACKFILL_FAILED";
    console.error("知识库状态机回填失败", { code });
    process.exitCode = 1;
  });
}
