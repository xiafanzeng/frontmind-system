import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";

import {
  OwnedFileContentResolver,
  type OwnedFileContentResolverDependencies,
} from "./owned-file-content-resolver";
import type { StoredPresalesFile } from "./presales-file-store";

async function readAll(stream: NodeJS.ReadableStream) {
  const chunks: Buffer[] = [];
  for await (const value of stream) {
    chunks.push(Buffer.isBuffer(value) ? value : Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

function storedFile(
  bytes: Buffer,
  overrides: Partial<StoredPresalesFile> = {},
): StoredPresalesFile {
  return {
    filename: "report.txt",
    mimeType: "text/plain",
    recordedSizeBytes: bytes.length,
    sizeBytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    uploadedAt: null,
    contentExpiresAt: null,
    contentStoredAt: null,
    manifestUpdatedAt: null,
    createReadStream: () => Readable.from([bytes]),
    ...overrides,
  };
}

function dependencies(input?: {
  stored?: StoredPresalesFile | null;
  contentSource?: "user_upload" | "assistant_output";
  parentTaskId?: string | null;
  expiresAt?: Date | null;
}) {
  const request = vi.fn();
  const removeStoredFile = vi.fn(async () => undefined);
  const deps: OwnedFileContentResolverDependencies = {
    getCredential: vi.fn(async () => ({
      id: "credential-1",
      apiKey: "secret-api-key",
      resource: {
        parentTaskId: input?.parentTaskId ?? null,
        contentSource: input?.contentSource ?? "user_upload",
        uploadedAt: new Date("2026-08-01T00:00:00Z"),
        contentExpiresAt:
          input && "expiresAt" in input
            ? input.expiresAt
            : new Date("2026-09-01T00:00:00Z"),
        contentDeletedAt: null,
      },
    })),
    readStoredFile: vi.fn(async () => input?.stored ?? null),
    removeStoredFile,
    stageStoredFile: vi.fn(async () => {
      throw new Error("v2 resolver must not recapture provider content");
    }),
    getBaseUrl: () => "https://api.frontmind.example",
    request,
  };
  return { deps, request, removeStoredFile };
}

describe("OwnedFileContentResolver v2 local authority", () => {
  it("authorizes a managed local asset by owner and retainUntil without a Provider credential", async () => {
    const bytes = Buffer.from("managed local asset");
    const { deps } = dependencies({ stored: storedFile(bytes) });
    deps.getManagedLocalAsset = vi.fn(async () => ({
      id: `asset_${"a".repeat(30)}`,
      retainUntil: new Date("2026-09-14T00:00:00Z"),
    }));
    const resolver = new OwnedFileContentResolver(deps);
    const resolved = await resolver.resolve({
      ownerUserId: 7,
      fileId: `asset_${"a".repeat(30)}`,
      expectedSourceKind: "managed_local_asset",
      expectedSourceAuthorityId: `asset_${"a".repeat(30)}`,
      now: Date.parse("2026-08-15T00:00:00Z"),
    });

    expect(resolved).toMatchObject({
      sourceKind: "managed_local_asset",
      sourceAuthorityId: `asset_${"a".repeat(30)}`,
      credentialId: undefined,
      expiresAt: Date.parse("2026-09-14T00:00:00Z"),
    });
    expect(deps.getCredential).not.toHaveBeenCalled();
    expect(await readAll(resolved.stream)).toEqual(bytes);
  });

  it("rejects a managed local asset after its immutable retainUntil", async () => {
    const localAssetId = `asset_${"b".repeat(30)}`;
    const { deps } = dependencies({
      stored: storedFile(Buffer.from("expired managed asset")),
    });
    deps.getManagedLocalAsset = vi.fn(async () => ({
      id: localAssetId,
      retainUntil: new Date("2026-08-14T00:00:00Z"),
    }));

    await expect(
      new OwnedFileContentResolver(deps).resolve({
        ownerUserId: 7,
        fileId: localAssetId,
        now: Date.parse("2026-08-15T00:00:00Z"),
      }),
    ).rejects.toMatchObject({
      code: "SOURCE_EXPIRED",
      statusCode: 410,
      retryable: false,
      recoveryAction: "reupload",
      expiresAt: Date.parse("2026-08-14T00:00:00Z"),
    });
    expect(deps.getCredential).not.toHaveBeenCalled();
    expect(deps.readStoredFile).not.toHaveBeenCalled();
  });

  it.each([
    ["belongs to another owner", `asset_${"c".repeat(30)}`],
    ["is absent from local_assets", `asset_${"d".repeat(30)}`],
  ])("fails closed when a managed local asset %s", async (_label, fileId) => {
    const { deps } = dependencies({
      stored: storedFile(Buffer.from("unreachable bytes")),
    });
    deps.getManagedLocalAsset = vi.fn(async () => null);

    await expect(
      new OwnedFileContentResolver(deps).resolve({
        ownerUserId: 7,
        fileId,
        now: Date.parse("2026-08-15T00:00:00Z"),
      }),
    ).rejects.toMatchObject({
      code: "SOURCE_FORBIDDEN",
      statusCode: 403,
      retryable: false,
      recoveryAction: "contact_admin",
    });
    expect(deps.getCredential).not.toHaveBeenCalled();
    expect(deps.readStoredFile).not.toHaveBeenCalled();
  });

  it("serves a size/SHA verified local copy without Provider access", async () => {
    const bytes = Buffer.from("durable local copy");
    const { deps, request } = dependencies({ stored: storedFile(bytes) });
    const resolved = await new OwnedFileContentResolver(deps).resolve({
      ownerUserId: 7,
      fileId: "file-1",
      projectAssignmentId: "project-a",
      expectedCredentialId: "credential-1",
      now: Date.parse("2026-08-04T00:00:00Z"),
    });

    expect(resolved).toMatchObject({
      source: "local",
      sourceKind: "provider_file",
      sourceAuthorityId: "credential-1",
      credentialId: "credential-1",
    });
    expect(await readAll(resolved.stream)).toEqual(bytes);
    expect(request).not.toHaveBeenCalled();
  });

  it("rejects a missing local copy without calling legacy /content", async () => {
    const { deps, request } = dependencies({ stored: null });
    await expect(
      new OwnedFileContentResolver(deps).resolve({
        ownerUserId: 7,
        fileId: "file-missing",
        now: Date.parse("2026-08-04T00:00:00Z"),
      }),
    ).rejects.toMatchObject({
      code: "CONTENT_UNAVAILABLE",
      statusCode: 410,
      retryable: false,
      recoveryAction: "reupload",
    });
    expect(request).not.toHaveBeenCalled();
  });

  it("isolates a corrupt local copy and fails closed", async () => {
    const { deps, request, removeStoredFile } = dependencies({
      stored: storedFile(Buffer.from("corrupt"), { sha256: "0".repeat(64) }),
    });
    await expect(
      new OwnedFileContentResolver(deps).resolve({
        ownerUserId: 7,
        fileId: "file-corrupt",
        now: Date.parse("2026-08-04T00:00:00Z"),
      }),
    ).rejects.toMatchObject({ code: "CONTENT_UNAVAILABLE" });
    expect(removeStoredFile).toHaveBeenCalledWith("file-corrupt");
    expect(request).not.toHaveBeenCalled();
  });

  it("requires a newly materialized artifact when assistant output is absent", async () => {
    const { deps, request } = dependencies({
      stored: null,
      contentSource: "assistant_output",
      parentTaskId: "provider-task-1",
      expiresAt: null,
    });
    await expect(
      new OwnedFileContentResolver(deps).resolve({
        ownerUserId: 7,
        fileId: "assistant-artifact-missing",
        now: Date.parse("2026-08-04T00:00:00Z"),
      }),
    ).rejects.toMatchObject({
      code: "CONTENT_UNAVAILABLE",
      message: "本地成品文件不可用，请重新生成",
    });
    expect(request).not.toHaveBeenCalled();
  });

  it("keeps the existing local retention fence", async () => {
    const { deps } = dependencies({
      stored: storedFile(Buffer.from("expired")),
      expiresAt: new Date("2026-08-02T00:00:00Z"),
    });
    await expect(
      new OwnedFileContentResolver(deps).resolve({
        ownerUserId: 7,
        fileId: "expired-file",
        now: Date.parse("2026-08-04T00:00:00Z"),
      }),
    ).rejects.toMatchObject({
      code: "SOURCE_EXPIRED",
      statusCode: 410,
    });
  });
});
