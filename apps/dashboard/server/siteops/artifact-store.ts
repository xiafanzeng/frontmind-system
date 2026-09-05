import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { and, eq } from "drizzle-orm";

import { localAssets, type LocalAsset } from "../../drizzle/schema";
import { getDb } from "../db";
import { sealLocalAssetStorageIdentity } from "../local-asset-storage-key";
import {
  readStoredPresalesFile,
  removeStoredPresalesFile,
  stagePresalesFileContent,
  withStoredPresalesFileMutationLock,
} from "../presales-file-store";

const MAX_SITEOPS_ARTIFACT_BYTES = 100 * 1024 * 1024;

function deterministicUuid(value: string) {
  const bytes = createHash("sha256")
    .update(value, "utf8")
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function siteOpsArtifactIdForIdempotency(input: {
  userId: number;
  projectId: string;
  kind: string;
  idempotencyKey: string;
}) {
  if (
    !Number.isSafeInteger(input.userId) ||
    input.userId < 1 ||
    !input.projectId ||
    !/^[A-Za-z0-9][A-Za-z0-9:._-]{0,511}$/u.test(input.idempotencyKey)
  ) {
    throw new Error("SITEOPS_ARTIFACT_IDEMPOTENCY_KEY_INVALID");
  }
  return deterministicUuid(
    `frontmind.siteops-artifact.v1\0${input.userId}\0${input.projectId}\0${input.kind}\0${input.idempotencyKey}`,
  );
}

async function requireDb() {
  const db = await getDb();
  if (!db) throw new Error("DATABASE_UNAVAILABLE");
  return db;
}

function safeFilename(value: string) {
  const normalized = value
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f/\\]/gu, "_")
    .trim();
  if (!normalized || normalized.length > 240) {
    throw new Error("SITEOPS_ARTIFACT_FILENAME_INVALID");
  }
  return normalized;
}

function safeMimeType(value: string) {
  const normalized = value.trim().toLowerCase();
  if (
    !/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/u.test(
      normalized,
    )
  ) {
    throw new Error("SITEOPS_ARTIFACT_MIME_INVALID");
  }
  return normalized;
}

/**
 * Stores an immutable SiteOps artifact through the existing local file store.
 * The database row is the tenant ownership boundary; callers never receive a
 * filesystem path or choose a storage key.
 */
export async function persistSiteOpsArtifact(input: {
  userId: number;
  projectId: string;
  kind: string;
  filename: string;
  mimeType: string;
  buffer: Buffer;
  maxBytes?: number;
  idempotencyKey?: string;
  retainUntil?: Date;
}): Promise<LocalAsset> {
  const filename = safeFilename(input.filename);
  const mimeType = safeMimeType(input.mimeType);
  const maxBytes = Math.min(
    Math.max(1, input.maxBytes ?? MAX_SITEOPS_ARTIFACT_BYTES),
    MAX_SITEOPS_ARTIFACT_BYTES,
  );
  if (input.buffer.length < 1 || input.buffer.length > maxBytes) {
    throw new Error("SITEOPS_ARTIFACT_SIZE_INVALID");
  }

  if (
    input.retainUntil &&
    (!Number.isFinite(input.retainUntil.getTime()) ||
      input.retainUntil.getTime() <= Date.now())
  ) {
    throw new Error("SITEOPS_ARTIFACT_RETENTION_INVALID");
  }
  const db = await requireDb();
  const id = input.idempotencyKey
    ? siteOpsArtifactIdForIdempotency({
        userId: input.userId,
        projectId: input.projectId,
        kind: input.kind,
        idempotencyKey: input.idempotencyKey,
      })
    : randomUUID();
  const storageKey = `siteops:${input.projectId}:${input.kind}:${id}`;
  const expectedSha256 = createHash("sha256")
    .update(input.buffer)
    .digest("hex");
  // The stage may stream up to 100 MiB and has its own two-minute I/O timeout.
  // Keep that work outside the mutation lock so a slow disk can never make a
  // healthy lock look stale to another process. `stagePresalesFileContent`
  // writes only a unique temporary file until `commit` runs below.
  const staged = await stagePresalesFileContent({
    fileId: id,
    stream: Readable.from(input.buffer),
    maxBytes,
  });
  try {
    return await withStoredPresalesFileMutationLock(id, async () => {
      const existingRows = await db
        .select()
        .from(localAssets)
        .where(
          and(
            eq(localAssets.id, id),
            eq(localAssets.scope, "managed_user"),
            eq(localAssets.accountUserId, input.userId),
          ),
        )
        .limit(1);
      const existing = existingRows[0];
      if (existing) {
        if (
          existing.storageKey !== storageKey ||
          existing.filename !== filename ||
          existing.mimeType !== mimeType ||
          existing.sizeBytes !== input.buffer.length ||
          existing.contentSha256 !== expectedSha256
        ) {
          throw new Error("SITEOPS_ARTIFACT_IDEMPOTENCY_CONFLICT");
        }
        const stored = await readStoredPresalesFile(existing.id);
        if (
          stored &&
          stored.sizeBytes === existing.sizeBytes &&
          (!stored.sha256 || stored.sha256 === existing.contentSha256)
        ) {
          await staged.discard();
          return existing;
        }
        // A deterministic ownership row is immutable. Never overwrite or
        // delete its body during a retry: a partial re-stage could destroy the
        // last known-good copy if its DB update then failed.
        throw new Error("SITEOPS_ARTIFACT_BODY_MISMATCH");
      }
      let contentCommittedByThisCall = false;
      try {
        await staged.commit({
          filename,
          mimeType,
          ...(input.retainUntil
            ? {
                uploadedAt: new Date(),
                contentExpiresAt: input.retainUntil,
                replaceManagedRetention: false,
              }
            : {}),
        });
        contentCommittedByThisCall = true;
        await db.insert(localAssets).values(
          sealLocalAssetStorageIdentity({
            id,
            scope: "managed_user" as const,
            accountUserId: input.userId,
            presalesProjectId: null,
            filename,
            mimeType,
            sizeBytes: staged.sizeBytes,
            contentSha256: staged.sha256,
            storageKey,
            refCount: 1,
            // Bound outputs are retained by their domain references. Operation
            // staging receives a hard filesystem/database deadline instead.
            retainUntil: input.retainUntil ?? null,
          }),
        );
      } catch (error) {
        await staged.discard().catch(() => undefined);
        let raceReadFailed = false;
        const racedRows = await db
          .select()
          .from(localAssets)
          .where(
            and(
              eq(localAssets.id, id),
              eq(localAssets.scope, "managed_user"),
              eq(localAssets.accountUserId, input.userId),
            ),
          )
          .limit(1)
          .catch(() => {
            raceReadFailed = true;
            return [] as LocalAsset[];
          });
        const raced = racedRows[0];
        if (
          raced &&
          raced.storageKey === storageKey &&
          raced.filename === filename &&
          raced.mimeType === mimeType &&
          raced.sizeBytes === input.buffer.length &&
          raced.contentSha256 === expectedSha256
        ) {
          const stored = await readStoredPresalesFile(raced.id).catch(
            () => null,
          );
          if (
            stored &&
            stored.sizeBytes === raced.sizeBytes &&
            (!stored.sha256 || stored.sha256 === raced.contentSha256)
          ) {
            return raced;
          }
        }
        if (contentCommittedByThisCall && !raced && !raceReadFailed) {
          await removeStoredPresalesFile(id).catch(() => undefined);
        }
        throw error;
      }
      const rows = await db
        .select()
        .from(localAssets)
        .where(
          and(
            eq(localAssets.id, id),
            eq(localAssets.scope, "managed_user"),
            eq(localAssets.accountUserId, input.userId),
          ),
        )
        .limit(1);
      if (!rows[0]) {
        await removeStoredPresalesFile(id).catch(() => undefined);
        throw new Error("SITEOPS_ARTIFACT_COMMIT_LOST");
      }
      return rows[0];
    });
  } catch (error) {
    // This only removes the caller's unique temp when commit never consumed it.
    // It is deliberately not `removeStoredPresalesFile(id)`.
    await staged.discard().catch(() => undefined);
    throw error;
  }
}

export async function readSiteOpsArtifact(input: {
  userId: number;
  localAssetId: string;
  expectedSha256?: string | null;
  expectedMimeTypes?: readonly string[];
}) {
  const db = await requireDb();
  const rows = await db
    .select()
    .from(localAssets)
    .where(
      and(
        eq(localAssets.id, input.localAssetId),
        eq(localAssets.scope, "managed_user"),
        eq(localAssets.accountUserId, input.userId),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  if (
    input.expectedSha256 &&
    row.contentSha256 !== input.expectedSha256.toLowerCase()
  ) {
    throw new Error("SITEOPS_ARTIFACT_HASH_MISMATCH");
  }
  if (
    input.expectedMimeTypes &&
    !input.expectedMimeTypes.includes(row.mimeType)
  ) {
    throw new Error("SITEOPS_ARTIFACT_MIME_MISMATCH");
  }
  const stored = await readStoredPresalesFile(row.id);
  if (
    !stored ||
    stored.sizeBytes !== row.sizeBytes ||
    (stored.sha256 && stored.sha256 !== row.contentSha256)
  ) {
    throw new Error("SITEOPS_ARTIFACT_BODY_MISMATCH");
  }
  return { row, stored };
}
