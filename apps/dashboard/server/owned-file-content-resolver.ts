import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { and, eq } from "drizzle-orm";

import { localAssets } from "../drizzle/schema";
import { getCredentialForUpstreamResource } from "./auth-service";
import { getDb } from "./db";
import {
  readStoredPresalesFile,
  removeStoredPresalesFile,
  type StagedPresalesFile,
  type StoredPresalesFile,
} from "./presales-file-store";
import { FILE_CONTENT_RETENTION_MS } from "./file-content-retention";

export const OWNED_FILE_CONTENT_RESOLVER_VERSION = 3;

export type FileContentRecoveryAction = "retry" | "reupload" | "contact_admin";

export class OwnedFileContentError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly options: {
      statusCode: number;
      retryable: boolean;
      recoveryAction: FileContentRecoveryAction;
      expiresAt?: number;
      upstreamStatus?: number;
    },
  ) {
    super(message);
    this.name = "OwnedFileContentError";
  }

  get statusCode() {
    return this.options.statusCode;
  }

  get retryable() {
    return this.options.retryable;
  }

  get recoveryAction() {
    return this.options.recoveryAction;
  }

  get expiresAt() {
    return this.options.expiresAt;
  }
}

type OwnedResourceCredential = {
  id: string;
  apiKey: string;
  resource: {
    parentTaskId?: string | null;
    contentSource?: "user_upload" | "assistant_output" | null;
    createdAt?: Date | string | number | null;
    uploadedAt?: Date | string | number | null;
    contentExpiresAt?: Date | string | number | null;
    contentDeletedAt?: Date | string | number | null;
  };
};

export type OwnedFileContentResolverDependencies = {
  getCredential: (
    ownerUserId: number,
    kind: "file",
    fileId: string,
    projectAssignmentId?: string,
  ) => Promise<OwnedResourceCredential | null>;
  readStoredFile: (fileId: string) => Promise<StoredPresalesFile | null>;
  removeStoredFile: (fileId: string) => Promise<void>;
  getManagedLocalAsset?: (
    ownerUserId: number,
    fileId: string,
  ) => Promise<{
    id: string;
    retainUntil: Date | string | number | null;
  } | null>;
  /** @deprecated v2 keeps this only for source compatibility; never called. */
  stageStoredFile?: (input: {
    fileId: string;
    stream: Readable;
    maxBytes: number;
  }) => Promise<StagedPresalesFile>;
  /** @deprecated v2 never resolves Provider content URLs. */
  getBaseUrl?: () => string;
  /** @deprecated v2 never resolves Provider content URLs. */
  request?: (
    url: string,
    options: Record<string, unknown>,
  ) => Promise<{
    status: number;
    data: unknown;
    headers?: Record<string, unknown>;
  }>;
};

export type OwnedFileAccessInput = {
  ownerUserId: number;
  fileId: string;
  projectAssignmentId?: string | null;
  expectedCredentialId?: string;
  expectedSourceKind?: "managed_local_asset" | "provider_file";
  expectedSourceAuthorityId?: string;
  now?: number;
};

export type OwnedFileAuthorization = {
  credentialId?: string;
  apiKey?: string;
  sourceKind: "managed_local_asset" | "provider_file";
  sourceAuthorityId: string;
  expiresAt?: number;
  isTaskBoundAssistantOutput: boolean;
};

export type ResolvedOwnedFileContent = {
  fileId: string;
  credentialId?: string;
  sourceKind: "managed_local_asset" | "provider_file";
  sourceAuthorityId: string;
  source: "local" | "upstream";
  filename: string;
  mimeType: string;
  sizeBytes?: number;
  sha256?: string;
  expiresAt?: number;
  stream: Readable;
};

function timestampMillis(value: unknown) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number" && Number.isFinite(value)) {
    return value < 1_000_000_000_000 ? value * 1_000 : value;
  }
  if (typeof value === "string" && value.trim()) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) {
      return numeric < 1_000_000_000_000 ? numeric * 1_000 : numeric;
    }
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function cleanFilename(value: unknown, fallback: string) {
  const filename = String(value || fallback)
    .replace(/[\\/\0\r\n"]/g, "_")
    .trim();
  return filename || fallback;
}

async function getManagedLocalAsset(ownerUserId: number, fileId: string) {
  const db = await getDb();
  if (!db) return null;
  return (
    (
      await db
        .select({ id: localAssets.id, retainUntil: localAssets.retainUntil })
        .from(localAssets)
        .where(
          and(
            eq(localAssets.id, fileId),
            eq(localAssets.scope, "managed_user"),
            eq(localAssets.accountUserId, ownerUserId),
          ),
        )
        .limit(1)
    )[0] ?? null
  );
}

async function validateStoredFile(stored: StoredPresalesFile) {
  if (
    !Number.isSafeInteger(stored.recordedSizeBytes) ||
    Number(stored.recordedSizeBytes) < 1 ||
    typeof stored.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/iu.test(stored.sha256)
  ) {
    throw new Error("LOCAL_FILE_INTEGRITY_METADATA_MISSING");
  }
  let sizeBytes = 0;
  const hash = createHash("sha256");
  for await (const value of stored.createReadStream()) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    sizeBytes += chunk.length;
    hash.update(chunk);
  }
  if (
    sizeBytes < 1 ||
    sizeBytes !== stored.sizeBytes ||
    sizeBytes !== stored.recordedSizeBytes
  ) {
    throw new Error("LOCAL_FILE_CONTENT_SIZE_MISMATCH");
  }
  const sha256 = hash.digest("hex");
  if (stored.sha256.toLowerCase() !== sha256) {
    throw new Error("LOCAL_FILE_CONTENT_SHA256_MISMATCH");
  }
  return sha256;
}

export class OwnedFileContentResolver {
  constructor(
    private readonly dependencies: OwnedFileContentResolverDependencies = {
      getCredential: (ownerUserId, kind, fileId, projectAssignmentId) =>
        getCredentialForUpstreamResource(
          ownerUserId,
          kind,
          fileId,
          projectAssignmentId,
          { allowExpiredFileContent: true },
        ),
      readStoredFile: readStoredPresalesFile,
      removeStoredFile: removeStoredPresalesFile,
      getManagedLocalAsset,
    },
  ) {}

  async authorize(
    input: OwnedFileAccessInput,
  ): Promise<OwnedFileAuthorization> {
    // fileId is an opaque upstream identifier. Whitespace is significant and
    // must not be rewritten; trim is used only to reject an empty-looking ID.
    const fileId = String(input.fileId ?? "");
    if (!fileId.trim()) {
      throw new OwnedFileContentError(
        "SOURCE_FORBIDDEN",
        "文件不属于当前账号或客户项目，请联系管理员",
        {
          statusCode: 403,
          retryable: false,
          recoveryAction: "contact_admin",
        },
      );
    }
    if (fileId.startsWith("asset_")) {
      const localAsset = await this.dependencies.getManagedLocalAsset?.(
        input.ownerUserId,
        fileId,
      );
      if (
        !localAsset ||
        (input.expectedSourceKind &&
          input.expectedSourceKind !== "managed_local_asset") ||
        (input.expectedSourceAuthorityId &&
          input.expectedSourceAuthorityId !== localAsset.id)
      ) {
        throw new OwnedFileContentError(
          "SOURCE_FORBIDDEN",
          "文件不属于当前账号或客户项目，请联系管理员",
          {
            statusCode: 403,
            retryable: false,
            recoveryAction: "contact_admin",
          },
        );
      }
      const expiresAt = timestampMillis(localAsset.retainUntil);
      const now = input.now ?? Date.now();
      if (expiresAt === undefined || expiresAt <= now) {
        throw new OwnedFileContentError(
          "SOURCE_EXPIRED",
          "文件已超过 30 天，请重新上传",
          {
            statusCode: 410,
            retryable: false,
            recoveryAction: "reupload",
            expiresAt,
          },
        );
      }
      return {
        sourceKind: "managed_local_asset" as const,
        sourceAuthorityId: localAsset.id,
        expiresAt,
        isTaskBoundAssistantOutput: false,
      };
    }
    const credential = await this.dependencies.getCredential(
      input.ownerUserId,
      "file",
      fileId,
      input.projectAssignmentId ?? undefined,
    );
    if (
      !credential ||
      (input.expectedSourceKind &&
        input.expectedSourceKind !== "provider_file") ||
      (input.expectedSourceAuthorityId &&
        input.expectedSourceAuthorityId !== credential.id) ||
      (input.expectedCredentialId &&
        credential.id !== input.expectedCredentialId)
    ) {
      throw new OwnedFileContentError(
        "SOURCE_FORBIDDEN",
        "文件不属于当前账号或客户项目，请联系管理员",
        {
          statusCode: 403,
          retryable: false,
          recoveryAction: "contact_admin",
        },
      );
    }

    const explicitExpiresAt = timestampMillis(
      credential.resource.contentExpiresAt,
    );
    const uploadedAt = timestampMillis(credential.resource.uploadedAt);
    const expiresAt =
      explicitExpiresAt ??
      (uploadedAt === undefined
        ? undefined
        : uploadedAt + FILE_CONTENT_RETENTION_MS);
    const deletedAt = timestampMillis(credential.resource.contentDeletedAt);
    const now = input.now ?? Date.now();
    if (
      deletedAt !== undefined ||
      (expiresAt !== undefined && expiresAt <= now)
    ) {
      throw new OwnedFileContentError(
        "SOURCE_EXPIRED",
        "文件已超过 30 天，请重新上传",
        {
          statusCode: 410,
          retryable: false,
          recoveryAction: "reupload",
          expiresAt: expiresAt ?? deletedAt,
        },
      );
    }

    const isTaskBoundAssistantOutput =
      credential.resource.contentSource === "assistant_output" &&
      typeof credential.resource.parentTaskId === "string" &&
      credential.resource.parentTaskId.trim().length > 0;

    return {
      credentialId: credential.id,
      apiKey: credential.apiKey,
      sourceKind: "provider_file" as const,
      sourceAuthorityId: credential.id,
      expiresAt,
      isTaskBoundAssistantOutput,
    };
  }

  async resolve(
    input: OwnedFileAccessInput,
  ): Promise<ResolvedOwnedFileContent> {
    const fileId = String(input.fileId ?? "");
    const authorization = await this.authorize({ ...input, fileId });

    try {
      const stored = await this.dependencies.readStoredFile(fileId);
      if (stored) {
        const sha256 = await validateStoredFile(stored);
        return {
          fileId,
          credentialId: authorization.credentialId,
          sourceKind: authorization.sourceKind,
          sourceAuthorityId: authorization.sourceAuthorityId,
          source: "local",
          filename: cleanFilename(stored.filename, fileId),
          mimeType: stored.mimeType || "application/octet-stream",
          sizeBytes: stored.sizeBytes,
          sha256,
          expiresAt: authorization.expiresAt,
          stream: stored.createReadStream(),
        };
      }
    } catch (error) {
      // A damaged local copy must never be served. Manus v2 has no durable
      // authenticated content endpoint, so this falls through to a closed
      // CONTENT_UNAVAILABLE result instead of attempting Provider recovery.
      console.warn("[OwnedFileContent] Local authoritative copy unavailable", {
        fileId,
        code: error instanceof Error ? error.message : "LOCAL_FILE_INVALID",
      });
      await this.dependencies.removeStoredFile(fileId).catch(() => undefined);
    }

    // Manus v2 intentionally does not expose a credential-authenticated file
    // content endpoint. Provider ids and signed URLs are leases, never durable
    // storage. If the verified Dashboard copy is absent or corrupt, fail
    // closed and require a fresh upload/reset instead of calling legacy v1.
    throw new OwnedFileContentError(
      "CONTENT_UNAVAILABLE",
      authorization.isTaskBoundAssistantOutput
        ? "本地成品文件不可用，请重新生成"
        : "本地文件内容不可用，请重新上传",
      {
        statusCode: 410,
        retryable: false,
        recoveryAction: "reupload",
        expiresAt: authorization.expiresAt,
      },
    );
  }
}

export const ownedFileContentResolver = new OwnedFileContentResolver();
