import { max } from "drizzle-orm";

import { z } from "zod";

import { siteProjects } from "../../drizzle/schema";

export const APPROVED_RESET_UNPUBLISH = "approved_reset_unpublish";

const MYSQL_TIMESTAMP_SECOND_MS = 1_000;

/**
 * SiteOps reset epochs are persisted in MySQL TIMESTAMP(0) columns. Keep the
 * JSON coordinate at that same precision so a value written and read back is
 * stable instead of depending on an in-memory millisecond remainder.
 */
export function siteOpsResetEpochAtDatabasePrecision(value: Date) {
  return new Date(
    Math.floor(value.getTime() / MYSQL_TIMESTAMP_SECOND_MS) *
      MYSQL_TIMESTAMP_SECOND_MS,
  );
}

function resetEpochSecond(value: Date | string) {
  const timestamp =
    value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(timestamp)
    ? Math.floor(timestamp / MYSQL_TIMESTAMP_SECOND_MS)
    : null;
}

function resetEpochsMatch(left: Date | string, right: Date | string) {
  const leftSecond = resetEpochSecond(left);
  return leftSecond !== null && leftSecond === resetEpochSecond(right);
}

export const approvedResetUnpublishInputSchema = z
  .object({
    schemaVersion: z.literal(1),
    intent: z.literal(APPROVED_RESET_UNPUBLISH),
    rebuildTicketId: z.string().uuid(),
    expectedProjectRevision: z.number().int().positive(),
    expectedCurrentBuildId: z.string().uuid().nullable(),
    expectedKnowledgeSnapshotId: z.string().uuid().nullable(),
    expectedGlobalLiveDeploymentId: z.string().uuid().nullable(),
    expectedMainlandLiveDeploymentId: z.string().uuid().nullable(),
    expectedCanonicalHostname: z.string().trim().min(1).max(255).nullable(),
    resetAppliedProjectRevision: z.number().int().positive().optional(),
    resetEpochStartedAt: z
      .string()
      .datetime({ offset: true })
      .transform((value) =>
        siteOpsResetEpochAtDatabasePrecision(new Date(value)).toISOString(),
      )
      .optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      (value.resetAppliedProjectRevision === undefined) !==
      (value.resetEpochStartedAt === undefined)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "resetAppliedProjectRevision and resetEpochStartedAt must be provided together",
      });
    }
  });

export type ApprovedResetUnpublishInput = z.infer<
  typeof approvedResetUnpublishInputSchema
>;

export function parseApprovedResetUnpublishInput(value: unknown) {
  const parsed = approvedResetUnpublishInputSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function approvedResetUnpublishProjectMatches(
  input: ApprovedResetUnpublishInput,
  project: Pick<
    typeof siteProjects.$inferSelect,
    | "revision"
    | "currentBuildId"
    | "currentKnowledgeSnapshotId"
    | "globalLiveDeploymentId"
    | "mainlandLiveDeploymentId"
    | "canonicalHostname"
    | "currentTaskStartedAt"
  >,
) {
  if (approvedResetUnpublishFreshEpochMatches(input, project)) return true;
  return (
    project.revision === input.expectedProjectRevision &&
    approvedResetUnpublishNonRevisionCoordinatesMatch(input, project)
  );
}

export function approvedResetUnpublishNonRevisionCoordinatesMatch(
  input: ApprovedResetUnpublishInput,
  project: Pick<
    typeof siteProjects.$inferSelect,
    | "currentBuildId"
    | "currentKnowledgeSnapshotId"
    | "globalLiveDeploymentId"
    | "mainlandLiveDeploymentId"
    | "canonicalHostname"
  >,
) {
  return (
    project.currentBuildId === input.expectedCurrentBuildId &&
    project.currentKnowledgeSnapshotId === input.expectedKnowledgeSnapshotId &&
    project.globalLiveDeploymentId === input.expectedGlobalLiveDeploymentId &&
    project.mainlandLiveDeploymentId ===
      input.expectedMainlandLiveDeploymentId &&
    project.canonicalHostname === input.expectedCanonicalHostname
  );
}

/**
 * A decoupled reset intentionally clears the old build/live-head coordinates
 * before provider cleanup completes. The immutable epoch timestamp is the
 * fence: later local builds may advance the revision and current build, while
 * an old provider result can only reconcile the external coordinates frozen
 * in the reset input.
 */
export function approvedResetUnpublishFreshEpochMatches(
  input: ApprovedResetUnpublishInput,
  project: Pick<
    typeof siteProjects.$inferSelect,
    "revision" | "currentTaskStartedAt"
  >,
) {
  if (
    input.resetAppliedProjectRevision === undefined ||
    input.resetEpochStartedAt === undefined
  ) {
    return false;
  }
  return (
    project.revision >= input.resetAppliedProjectRevision &&
    resetEpochsMatch(project.currentTaskStartedAt, input.resetEpochStartedAt)
  );
}
