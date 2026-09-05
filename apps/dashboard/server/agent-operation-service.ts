import { randomUUID } from "node:crypto";

import { and, eq, isNull } from "drizzle-orm";

import {
  agentEvents,
  agentOperations,
  agentTasks,
  artifacts,
  localAssets,
  providerFileLeases,
  websiteProjectAttributions,
} from "../drizzle/schema";
import { getDb } from "./db";
import type {
  PresalesV2ArtifactIndex,
  PresalesV2AssetRecord,
  PresalesV2TaskRecord,
} from "./presales-v2-store";
import { sealLocalAssetStorageIdentity } from "./local-asset-storage-key";
import { lockActiveWebsiteProjectLifecycle } from "./website-project-lifecycle";

async function requireDb() {
  const db = await getDb();
  if (!db) throw new Error("DATABASE_UNAVAILABLE");
  return db;
}

export async function assertActiveWebsiteProject(projectId: string) {
  const db = await requireDb();
  await db.transaction(async (tx) => {
    await lockActiveWebsiteProjectLifecycle(tx, projectId);
  });
}

export type WebsiteProjectBusinessOwnerBinding =
  | { state: "bound" | "existing"; businessOwnerName: string }
  | { state: "missing" | "conflict" };

export function resolveWebsiteProjectBusinessOwnerBinding(
  current: string | null,
  requested: string | null,
): WebsiteProjectBusinessOwnerBinding {
  if (current) {
    if (requested === null || requested === current) {
      return { state: "existing", businessOwnerName: current };
    }
    return { state: "conflict" };
  }
  return requested === null
    ? { state: "missing" }
    : { state: "bound", businessOwnerName: requested };
}

/**
 * Binds the invitation-verified business owner before any Provider work.
 * The lifecycle row is the project-wide mutex, so two initial requests cannot
 * race an insert and silently relabel the same project.
 */
export async function bindWebsiteProjectBusinessOwner(input: {
  projectId: string;
  businessOwnerName: string | null;
}): Promise<WebsiteProjectBusinessOwnerBinding> {
  const db = await requireDb();
  return db.transaction(async (tx) => {
    await lockActiveWebsiteProjectLifecycle(tx, input.projectId);
    const existing = await tx
      .select({
        businessOwnerName: websiteProjectAttributions.businessOwnerName,
      })
      .from(websiteProjectAttributions)
      .where(eq(websiteProjectAttributions.projectId, input.projectId))
      .limit(1)
      .for("update");
    const decision = resolveWebsiteProjectBusinessOwnerBinding(
      existing[0]?.businessOwnerName ?? null,
      input.businessOwnerName,
    );
    if (decision.state !== "bound") return decision;
    await tx.insert(websiteProjectAttributions).values({
      projectId: input.projectId,
      businessOwnerName: decision.businessOwnerName,
    });
    return decision;
  });
}

export async function ensureWebsiteAgentOperation(
  record: PresalesV2TaskRecord,
) {
  if (!record.projectId) throw new Error("AGENT_OPERATION_PROJECT_REQUIRED");
  const db = await requireDb();
  const existing = await db
    .select()
    .from(agentOperations)
    .where(
      and(
        eq(agentOperations.scope, "website_frontend"),
        eq(agentOperations.idempotencyKeyHash, record.idempotencyHash),
      ),
    )
    .limit(1);
  if (existing[0]) {
    if (
      existing[0].id !== record.operationId ||
      existing[0].requestHash !== record.requestHash ||
      existing[0].presalesProjectId !== record.projectId ||
      existing[0].contractName !== record.contract.name ||
      existing[0].contractRevision !== record.contract.revision ||
      existing[0].schemaHash !== record.contract.schemaHash ||
      existing[0].apiCredentialId !== record.credentialId ||
      existing[0].credentialVersion !== record.credentialVersion ||
      existing[0].publicProfile !== record.profile ||
      existing[0].upstreamModel !== record.upstreamModel
    ) {
      throw new Error("AGENT_OPERATION_IDEMPOTENCY_CONFLICT");
    }
    return existing[0];
  }
  await db.transaction(async (tx) => {
    await tx.insert(agentOperations).values({
      id: record.operationId,
      scope: "website_frontend",
      accountUserId: null,
      presalesProjectId: record.projectId,
      operationType: record.contract.name,
      idempotencyKeyHash: record.idempotencyHash,
      requestHash: record.requestHash,
      contractName: record.contract.name,
      contractRevision: record.contract.revision,
      schemaHash: record.contract.schemaHash,
      apiCredentialId: record.credentialId,
      credentialVersion: record.credentialVersion,
      publicProfile: record.profile,
      upstreamModel: record.upstreamModel,
      status: record.status,
      errorCode: record.errorCode,
    });
    await tx.insert(agentTasks).values({
      id: record.localTaskId,
      operationId: record.operationId,
      providerTaskId: record.providerTaskId,
      providerRequestId: record.providerRequestId,
      createMarker: record.operationToken,
      title: record.providerTitle,
      providerState: record.status,
      resultDeadlineAt: record.resultDeadlineAt
        ? new Date(record.resultDeadlineAt)
        : null,
    });
  });
  return (
    await db
      .select()
      .from(agentOperations)
      .where(eq(agentOperations.id, record.operationId))
      .limit(1)
  )[0]!;
}

export async function ensureWebsiteAgentRepairOperation(
  record: PresalesV2TaskRecord,
) {
  if (!record.projectId || !record.repair) {
    throw new Error("AGENT_REPAIR_OPERATION_REQUIRED");
  }
  const repair = record.repair;
  const db = await requireDb();
  const existing = await db
    .select()
    .from(agentOperations)
    .where(
      and(
        eq(agentOperations.scope, "website_frontend"),
        eq(agentOperations.idempotencyKeyHash, repair.idempotencyHash),
      ),
    )
    .limit(1);
  if (existing[0]) {
    if (
      existing[0].id !== repair.operationId ||
      existing[0].requestHash !== repair.requestHash ||
      existing[0].presalesProjectId !== record.projectId ||
      existing[0].contractName !== record.contract.name ||
      existing[0].contractRevision !== record.contract.revision ||
      existing[0].schemaHash !== record.contract.schemaHash ||
      existing[0].apiCredentialId !== record.credentialId ||
      existing[0].credentialVersion !== record.credentialVersion ||
      existing[0].publicProfile !== record.profile ||
      existing[0].upstreamModel !== record.upstreamModel
    ) {
      throw new Error("AGENT_REPAIR_IDEMPOTENCY_CONFLICT");
    }
    return existing[0];
  }
  await db.insert(agentOperations).values({
    id: repair.operationId,
    scope: "website_frontend",
    accountUserId: null,
    presalesProjectId: record.projectId,
    operationType: `${record.contract.name}.repair`,
    idempotencyKeyHash: repair.idempotencyHash,
    requestHash: repair.requestHash,
    contractName: record.contract.name,
    contractRevision: record.contract.revision,
    schemaHash: record.contract.schemaHash,
    apiCredentialId: record.credentialId,
    credentialVersion: record.credentialVersion,
    publicProfile: record.profile,
    upstreamModel: record.upstreamModel,
    status: repair.status,
    errorCode: record.errorCode,
  });
  return (
    await db
      .select()
      .from(agentOperations)
      .where(eq(agentOperations.id, repair.operationId))
      .limit(1)
  )[0]!;
}

export async function persistWebsiteAgentTaskState(
  record: PresalesV2TaskRecord,
  providerEvents: ReadonlyArray<{
    id: string;
    type: string;
    timestamp: number;
  }> = [],
) {
  const db = await requireDb();
  await db.transaction(async (tx) => {
    await tx
      .update(agentOperations)
      .set({ status: record.status, errorCode: record.errorCode })
      .where(eq(agentOperations.id, record.operationId));
    await tx
      .update(agentTasks)
      .set({
        providerTaskId: record.providerTaskId,
        providerRequestId: record.providerRequestId,
        providerState: record.status,
        lastMessageSyncAt:
          record.safeEvents.length > 0 ? new Date() : undefined,
        resultDeadlineAt: record.resultDeadlineAt
          ? new Date(record.resultDeadlineAt)
          : null,
      })
      .where(eq(agentTasks.id, record.localTaskId));
    if (record.repair) {
      await tx
        .update(agentOperations)
        .set({
          status: record.repair.status,
          errorCode: record.errorCode,
        })
        .where(eq(agentOperations.id, record.repair.operationId));
    }
    // `record.safeEvents` is a public projection and therefore contains only
    // locally-derived opaque event identities. Provider event identities stay
    // inside this durable internal ledger, supplied directly by the reconcile
    // pass that observed them.
    for (const event of providerEvents) {
      await tx
        .insert(agentEvents)
        .values({
          id: randomUUID(),
          taskId: record.localTaskId,
          providerEventId: event.id,
          eventType: event.type,
          providerTimestampMs: event.timestamp,
          normalizedPayload: {
            id: event.id,
            type: event.type,
            timestamp: event.timestamp,
          },
        })
        .onDuplicateKeyUpdate({
          set: {
            eventType: event.type,
            providerTimestampMs: event.timestamp,
            normalizedPayload: {
              id: event.id,
              type: event.type,
              timestamp: event.timestamp,
            },
          },
        });
    }
  });
}

export async function persistWebsiteLocalAsset(asset: PresalesV2AssetRecord) {
  if (asset.status !== "uploaded" || asset.bytes === null || !asset.sha256) {
    throw new Error("LOCAL_ASSET_NOT_SEALED");
  }
  const db = await requireDb();
  const existing = await db
    .select()
    .from(localAssets)
    .where(eq(localAssets.id, asset.localAssetId))
    .limit(1);
  if (existing[0]) {
    if (
      existing[0].scope !== "website_frontend" ||
      existing[0].presalesProjectId !== asset.projectId ||
      existing[0].filename !== asset.filename ||
      existing[0].mimeType !== asset.mimeType ||
      existing[0].sizeBytes !== asset.bytes ||
      existing[0].contentSha256 !== asset.sha256
    ) {
      throw new Error("LOCAL_ASSET_IDENTITY_CONFLICT");
    }
    return existing[0];
  }
  await db.insert(localAssets).values(
    sealLocalAssetStorageIdentity({
      id: asset.localAssetId,
      scope: "website_frontend" as const,
      accountUserId: null,
      presalesProjectId: asset.projectId,
      filename: asset.filename,
      mimeType: asset.mimeType,
      sizeBytes: asset.bytes,
      contentSha256: asset.sha256,
      storageKey: `presales-v2:${asset.localAssetId}`,
      refCount: 1,
      retainUntil: new Date(Date.now() + 30 * 24 * 60 * 60 * 1_000),
    }),
  );
  return (
    await db
      .select()
      .from(localAssets)
      .where(eq(localAssets.id, asset.localAssetId))
      .limit(1)
  )[0]!;
}

export async function bindWebsiteLocalAssetToProject(input: {
  localAssetId: string;
  projectId: string;
}) {
  const db = await requireDb();
  await db
    .update(localAssets)
    .set({ presalesProjectId: input.projectId })
    .where(
      and(
        eq(localAssets.id, input.localAssetId),
        eq(localAssets.scope, "website_frontend"),
        isNull(localAssets.presalesProjectId),
      ),
    );
  const row = (
    await db
      .select()
      .from(localAssets)
      .where(eq(localAssets.id, input.localAssetId))
      .limit(1)
  )[0];
  if (!row || row.presalesProjectId !== input.projectId) {
    throw new Error("LOCAL_ASSET_PROJECT_CONFLICT");
  }
  return row;
}

export async function releaseWebsiteLocalAssetReference(localAssetId: string) {
  const db = await requireDb();
  const row = (
    await db
      .select()
      .from(localAssets)
      .where(
        and(
          eq(localAssets.id, localAssetId),
          eq(localAssets.scope, "website_frontend"),
        ),
      )
      .limit(1)
  )[0];
  if (!row) return false;
  await db
    .update(localAssets)
    .set({ refCount: Math.max(0, row.refCount - 1) })
    .where(eq(localAssets.id, localAssetId));
  return true;
}

export async function persistWebsiteProviderFileLease(input: {
  record: PresalesV2TaskRecord;
  lease: PresalesV2TaskRecord["providerFileLeases"][number];
}) {
  const db = await requireDb();
  const uploadedBytes =
    input.lease.uploadState === "uploaded"
      ? ((
          await db
            .select({ sizeBytes: localAssets.sizeBytes })
            .from(localAssets)
            .where(eq(localAssets.id, input.lease.localAssetId))
            .limit(1)
        )[0]?.sizeBytes ?? 0)
      : 0;
  await db
    .insert(providerFileLeases)
    .values({
      id: randomUUID(),
      localAssetId: input.lease.localAssetId,
      apiCredentialId: input.record.credentialId,
      credentialVersion: input.record.credentialVersion,
      providerFileId: input.lease.providerFileId,
      providerRequestId: input.lease.providerRequestId,
      uploadState: input.lease.uploadState,
      uploadedBytes,
      expiresAt: new Date(input.lease.expiresAt * 1_000),
    })
    .onDuplicateKeyUpdate({
      set: {
        providerRequestId: input.lease.providerRequestId,
        uploadState: input.lease.uploadState,
        uploadedBytes,
        expiresAt: new Date(input.lease.expiresAt * 1_000),
      },
    });
}

export async function expireWebsiteProviderFileLease(providerFileId: string) {
  const db = await requireDb();
  await db
    .update(providerFileLeases)
    .set({ uploadState: "expired" })
    .where(eq(providerFileLeases.providerFileId, providerFileId));
}

export async function persistWebsiteArtifact(
  artifact: PresalesV2ArtifactIndex,
) {
  const db = await requireDb();
  await db
    .insert(artifacts)
    .values({
      id: artifact.artifactId,
      operationId: artifact.operationId,
      taskId: artifact.localTaskId,
      sourceEventId: artifact.sourceEventId,
      attachmentIndex: artifact.attachmentIndex,
      filename: artifact.filename,
      mimeType: artifact.mimeType,
      sizeBytes: artifact.bytes,
      contentSha256: artifact.sha256,
      storageKey: `presales-v2:${artifact.artifactId}`,
      validationState: "valid",
      refCount: 1,
    })
    .onDuplicateKeyUpdate({
      set: {
        filename: artifact.filename,
        mimeType: artifact.mimeType,
        sizeBytes: artifact.bytes,
        contentSha256: artifact.sha256,
        validationState: "valid",
      },
    });
}

export async function releaseWebsiteArtifactReference(artifactId: string) {
  const db = await requireDb();
  const row = (
    await db
      .select()
      .from(artifacts)
      .where(eq(artifacts.id, artifactId))
      .limit(1)
  )[0];
  if (!row) return false;
  await db
    .update(artifacts)
    .set({ refCount: Math.max(0, row.refCount - 1) })
    .where(eq(artifacts.id, artifactId));
  return true;
}
