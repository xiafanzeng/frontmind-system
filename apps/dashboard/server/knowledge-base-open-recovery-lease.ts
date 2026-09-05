import { createHash, randomUUID } from "node:crypto";

import { and, eq, isNull, lte, or } from "drizzle-orm";

import {
  knowledgeBaseBuilds,
  type KnowledgeBaseBuild,
} from "../drizzle/schema";
import { getDb } from "./db";

const DEFAULT_OPEN_RECOVERY_LEASE_MS = 300_000;

export type KnowledgeBaseOpenRecoveryKind = "reconcile" | "package_rebind";

export type KnowledgeBaseOpenRecoveryClaim = {
  build: KnowledgeBaseBuild;
  kind: KnowledgeBaseOpenRecoveryKind;
  leaseToken: string;
  leaseExpiresAt: Date;
};

function ownerHash(leaseToken: string) {
  return createHash("sha256").update(leaseToken, "utf8").digest("hex");
}

function validLeaseMs(value: number | undefined) {
  const leaseMs = value ?? DEFAULT_OPEN_RECOVERY_LEASE_MS;
  if (!Number.isSafeInteger(leaseMs) || leaseMs < 1_000) {
    throw new Error("Knowledge-base open recovery lease is invalid");
  }
  return leaseMs;
}

export function classifyKnowledgeBaseOpenRecoveryBuild(
  build: Pick<
    KnowledgeBaseBuild,
    | "activeTurnId"
    | "upstreamTaskId"
    | "status"
    | "awaitingResponseSince"
    | "packageStorageKey"
    | "protocolErrorCode"
  >,
): KnowledgeBaseOpenRecoveryKind | null {
  if (build.activeTurnId || !build.upstreamTaskId) return null;
  if (
    build.status === "researching" ||
    (build.status === "confirming" && build.awaitingResponseSince)
  ) {
    return "reconcile";
  }
  if (
    !build.packageStorageKey &&
    (build.status === "ready_to_publish" ||
      (build.status === "protocol_error" &&
        build.protocolErrorCode === "PACKAGE_REBIND_REQUIRED"))
  ) {
    return "package_rebind";
  }
  return null;
}

async function requireDb() {
  const db = await getDb();
  if (!db) throw new Error("Database is unavailable");
  return db;
}

/**
 * Claims one legacy/open build under a database row lock. The candidate
 * coordinates come from the cheap scan and make a stale page a no-op. The
 * persisted owner hash lets another process recover after expiry without
 * storing the bearer lease token.
 */
export async function claimKnowledgeBaseOpenRecoveryBuild(
  input: {
    buildId: string;
    expectedGeneration: number;
    expectedStateEpoch: number;
    expectedTaskId: string;
    now?: Date;
    leaseMs?: number;
  },
  executor?: any,
): Promise<KnowledgeBaseOpenRecoveryClaim | null> {
  const db = executor ?? (await requireDb());
  const now = input.now ?? new Date();
  const leaseMs = validLeaseMs(input.leaseMs);
  return db.transaction(async (tx: any) => {
    const build = (
      await tx
        .select()
        .from(knowledgeBaseBuilds)
        .where(eq(knowledgeBaseBuilds.id, input.buildId))
        .limit(1)
        .for("update")
    )[0] as KnowledgeBaseBuild | undefined;
    const kind = build ? classifyKnowledgeBaseOpenRecoveryBuild(build) : null;
    if (
      !build ||
      !kind ||
      build.generation !== input.expectedGeneration ||
      build.stateEpoch !== input.expectedStateEpoch ||
      build.upstreamTaskId !== input.expectedTaskId ||
      (build.recoveryLeaseExpiresAt &&
        build.recoveryLeaseExpiresAt.getTime() > now.getTime())
    ) {
      return null;
    }

    const leaseToken = randomUUID();
    const recoveryLeaseOwnerHash = ownerHash(leaseToken);
    const leaseExpiresAt = new Date(now.getTime() + leaseMs);
    await tx
      .update(knowledgeBaseBuilds)
      .set({
        recoveryLeaseOwnerHash,
        recoveryLeaseExpiresAt: leaseExpiresAt,
        updatedAt: now,
      })
      .where(
        and(
          eq(knowledgeBaseBuilds.id, build.id),
          eq(knowledgeBaseBuilds.userId, build.userId),
          eq(knowledgeBaseBuilds.generation, input.expectedGeneration),
          eq(knowledgeBaseBuilds.stateEpoch, input.expectedStateEpoch),
          eq(knowledgeBaseBuilds.upstreamTaskId, input.expectedTaskId),
          isNull(knowledgeBaseBuilds.activeTurnId),
          or(
            isNull(knowledgeBaseBuilds.recoveryLeaseExpiresAt),
            lte(knowledgeBaseBuilds.recoveryLeaseExpiresAt, now),
          ),
        ),
      );
    return {
      build: {
        ...build,
        recoveryLeaseOwnerHash,
        recoveryLeaseExpiresAt: leaseExpiresAt,
        updatedAt: now,
      },
      kind,
      leaseToken,
      leaseExpiresAt,
    };
  });
}

export async function renewKnowledgeBaseOpenRecoveryLease(
  input: {
    buildId: string;
    generation: number;
    leaseToken: string;
    now?: Date;
    leaseMs?: number;
  },
  executor?: any,
) {
  const db = executor ?? (await requireDb());
  const now = input.now ?? new Date();
  const leaseMs = validLeaseMs(input.leaseMs);
  return db.transaction(async (tx: any) => {
    const build = (
      await tx
        .select()
        .from(knowledgeBaseBuilds)
        .where(eq(knowledgeBaseBuilds.id, input.buildId))
        .limit(1)
        .for("update")
    )[0] as KnowledgeBaseBuild | undefined;
    if (
      !build ||
      build.generation !== input.generation ||
      build.activeTurnId !== null ||
      build.recoveryLeaseOwnerHash !== ownerHash(input.leaseToken)
    ) {
      return null;
    }
    const leaseExpiresAt = new Date(now.getTime() + leaseMs);
    await tx
      .update(knowledgeBaseBuilds)
      .set({ recoveryLeaseExpiresAt: leaseExpiresAt, updatedAt: now })
      .where(
        and(
          eq(knowledgeBaseBuilds.id, build.id),
          eq(knowledgeBaseBuilds.generation, input.generation),
          eq(
            knowledgeBaseBuilds.recoveryLeaseOwnerHash,
            ownerHash(input.leaseToken),
          ),
          isNull(knowledgeBaseBuilds.activeTurnId),
        ),
      );
    return leaseExpiresAt;
  });
}

export async function releaseKnowledgeBaseOpenRecoveryLease(
  input: {
    buildId: string;
    generation: number;
    leaseToken: string;
    now?: Date;
  },
  executor?: any,
) {
  const db = executor ?? (await requireDb());
  const now = input.now ?? new Date();
  return db.transaction(async (tx: any) => {
    const build = (
      await tx
        .select()
        .from(knowledgeBaseBuilds)
        .where(eq(knowledgeBaseBuilds.id, input.buildId))
        .limit(1)
        .for("update")
    )[0] as KnowledgeBaseBuild | undefined;
    if (
      !build ||
      build.generation !== input.generation ||
      build.recoveryLeaseOwnerHash !== ownerHash(input.leaseToken)
    ) {
      return false;
    }
    await tx
      .update(knowledgeBaseBuilds)
      .set({
        recoveryLeaseOwnerHash: null,
        recoveryLeaseExpiresAt: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(knowledgeBaseBuilds.id, build.id),
          eq(knowledgeBaseBuilds.generation, input.generation),
          eq(
            knowledgeBaseBuilds.recoveryLeaseOwnerHash,
            ownerHash(input.leaseToken),
          ),
        ),
      );
    return true;
  });
}
