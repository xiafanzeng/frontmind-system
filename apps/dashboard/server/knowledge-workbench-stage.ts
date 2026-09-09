import { and, eq } from "drizzle-orm";
import { conversationTurns, type KnowledgeBaseBuild } from "../drizzle/schema";
import { enterpriseOwnerPredicate } from "./enterprise-project-scope";

export function knowledgeWorkbenchRecord(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, any>)
    : {};
}

/** A generation has one logical start. Ambiguous historical rows grant no authority. */
export async function knowledgeWorkbenchStart(
  tx: any,
  build: KnowledgeBaseBuild,
  lock = false,
) {
  const query = tx
    .select()
    .from(conversationTurns)
    .where(
      and(
        enterpriseOwnerPredicate(conversationTurns, build.userId),
        eq(conversationTurns.buildId, build.id),
        eq(conversationTurns.buildGeneration, build.generation),
        eq(conversationTurns.operationType, "start"),
      ),
    )
    .limit(2);
  const rows = await (lock ? query.for("update") : query);
  return rows.length === 1
    ? (rows[0] as typeof conversationTurns.$inferSelect)
    : null;
}

export function knowledgeWorkbenchStage(
  build: Pick<
    KnowledgeBaseBuild,
    "id" | "generation" | "stateEpoch" | "publishedSnapshotId"
  >,
  start: { metadata: unknown } | null,
) {
  const workbench = knowledgeWorkbenchRecord(
    knowledgeWorkbenchRecord(start?.metadata).knowledgeWorkbench,
  );
  const receipt = knowledgeWorkbenchRecord(workbench.initialAcceptance);
  const accepted =
    receipt.buildId === build.id &&
    receipt.generation === build.generation &&
    typeof receipt.requestHash === "string";
  // This compatibility rule applies only to pre-contract published work. New
  // generations carry a birth marker and must receive their own acceptance.
  const legacyPublished =
    workbench.schemaVersion !== 1 && Boolean(build.publishedSnapshotId);
  return {
    generation: build.generation,
    stateEpoch: build.stateEpoch,
    phase:
      accepted || legacyPublished ? ("editing" as const) : ("initial" as const),
    acceptedAt:
      accepted && typeof receipt.acceptedAt === "string"
        ? receipt.acceptedAt
        : null,
    legacyPublished,
  };
}

export async function knowledgeWorkbenchEditingAllowed(
  tx: any,
  build: KnowledgeBaseBuild,
) {
  return (
    knowledgeWorkbenchStage(build, await knowledgeWorkbenchStart(tx, build))
      .phase === "editing"
  );
}
