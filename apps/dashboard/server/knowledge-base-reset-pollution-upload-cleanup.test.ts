import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const provider = vi.hoisted(() => ({ post: vi.fn(), delete: vi.fn() }));
vi.mock("axios", () => ({
  default: { post: provider.post, delete: provider.delete },
}));

import {
  createManagedUploadIntent,
  managedUploadIntentStorageRoot,
} from "./managed-upload-intent";
import {
  inspectResetPollutionRetainedSources,
  inspectResetPollutionUploadIntents,
  removeResetPollutionRetainedSources,
  retireResetPollutionUploadIntents,
} from "./knowledge-base-reset-pollution-upload-cleanup";

const temporary: string[] = [];

afterEach(async () => {
  delete process.env.FRONTMIND_DASHBOARD_ASSET_DIR;
  delete process.env.FRONTMIND_CREDENTIAL_ENCRYPTION_KEY;
  provider.post.mockReset();
  provider.delete.mockReset();
  await Promise.all(
    temporary
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

async function rewriteManifest(
  intentId: string,
  update: (manifest: Record<string, any>) => void,
) {
  const directory = path.join(
    managedUploadIntentStorageRoot(),
    createHash("sha256").update(intentId).digest("hex"),
  );
  const target = path.join(directory, "manifest.json");
  const manifest = JSON.parse(await fs.readFile(target, "utf8"));
  update(manifest);
  await fs.writeFile(target, `${JSON.stringify(manifest)}\n`, "utf8");
}

function hashedJsonKey(value: unknown) {
  return createHash("sha256")
    .update(JSON.stringify(value), "utf8")
    .digest("hex");
}

function operationIndexPath(operationId: string) {
  return path.join(
    managedUploadIntentStorageRoot(),
    "by-operation",
    `${hashedJsonKey([42, null, operationId])}.json`,
  );
}

function resumeIndexPath(coordinate: {
  conversationId: string;
  turnId: string;
}) {
  return path.join(
    managedUploadIntentStorageRoot(),
    "by-resume-scope",
    `${hashedJsonKey([
      42,
      null,
      "knowledge_base",
      coordinate.conversationId,
      coordinate.turnId,
    ])}.json`,
  );
}

async function writeRetiredOperationIndex(operationId: string) {
  await fs.writeFile(
    operationIndexPath(operationId),
    `${JSON.stringify({
      schemaVersion: 1,
      state: "retired",
      retiredAt: "2026-08-13T06:45:00.000Z",
    })}\n`,
    "utf8",
  );
}

async function exactMixedFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "kb-reset-upload-"));
  temporary.push(root);
  process.env.FRONTMIND_DASHBOARD_ASSET_DIR = root;
  process.env.FRONTMIND_CREDENTIAL_ENCRYPTION_KEY = Buffer.alloc(
    32,
    7,
  ).toString("base64");
  const coordinate = {
    userId: 42,
    projectAssignmentId: null,
    conversationId: "conversation-reset-pollution",
    turnId: "00000000-0000-4000-8000-000000000142",
    clientRequestId: "request-reset-pollution",
  };
  const common = {
    batchId: "reset-pollution",
    total: 8,
    userId: 42,
    projectAssignmentId: null,
    credentialId: "credential-1",
    credentialOwnerUserId: 42,
    credentialVersion: 1,
    resumeScope: {
      kind: "knowledge_base" as const,
      conversationId: coordinate.conversationId,
      turnId: coordinate.turnId,
      clientRequestId: coordinate.clientRequestId,
    },
  };
  const uploaded = await createManagedUploadIntent({
    ...common,
    operationId: "upload-operation-1",
    ordinal: 1,
    filename: "uploaded.pdf",
    mimeType: "application/pdf",
    sizeBytes: 11,
  });
  const awaiting = await createManagedUploadIntent({
    ...common,
    operationId: "upload-operation-2",
    ordinal: 2,
    filename: "awaiting.pdf",
    mimeType: "application/pdf",
    sizeBytes: 12,
  });
  const sha256 = createHash("sha256").update("hello world").digest("hex");
  const now = new Date("2026-08-13T06:40:00.000Z");
  const fileId = "provider-file-1";
  await rewriteManifest(uploaded.intentId, (manifest) => {
    Object.assign(manifest, {
      state: "uploaded",
      phase: null,
      sizeBytes: 11,
      sha256,
      sealedAt: now.toISOString(),
      providerGeneration: 1,
      provider: [
        {
          generation: 1,
          state: "uploaded",
          ownershipRecorded: true,
          createStartedAt: now.toISOString(),
          createUnknownAt: null,
          retryNotBefore: null,
          fileId,
          filename: "uploaded.pdf",
          providerStatus: "uploaded",
          uploadExpiresAt: new Date(now.getTime() + 60_000).toISOString(),
          putStartedAt: now.toISOString(),
          putReplayed: false,
          putResponse2xx: true,
          updatedAt: now.toISOString(),
        },
      ],
      receipt: {
        fileId,
        sizeBytes: 11,
        uploadedAt: now.getTime(),
        providerReadyAt: now.getTime() + 1,
        expiresAt: now.getTime() + 86_400_000,
        replayed: false,
        recreated: false,
      },
      safeErrorCode: null,
      completedAt: now.toISOString(),
    });
  });
  await rewriteManifest(awaiting.intentId, (manifest) => {
    manifest.safeErrorCode = "UPLOAD_BROWSER_BODY_INCOMPLETE";
  });
  return { coordinate, uploaded, awaiting, sha256, fileId };
}

describe("reset-pollution exact mixed upload cleanup", () => {
  it("retires one uploaded and one browser-incomplete intent without Provider calls", async () => {
    const fixture = await exactMixedFixture();
    const proof = await inspectResetPollutionUploadIntents(fixture.coordinate);
    expect(proof).toMatchObject({
      intentCount: 2,
      retired: false,
      stateSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      items: [
        {
          intentIdSha256: createHash("sha256")
            .update(fixture.uploaded.intentId)
            .digest("hex"),
          operationIdSha256: createHash("sha256")
            .update(fixture.uploaded.operationId)
            .digest("hex"),
          credentialIdSha256: createHash("sha256")
            .update("credential-1")
            .digest("hex"),
          ordinal: 1,
          total: 8,
          state: "uploaded",
          providerGeneration: 1,
          safeErrorCode: null,
          fileIdSha256: createHash("sha256")
            .update(fixture.fileId)
            .digest("hex"),
          sizeBytes: 11,
          sha256: fixture.sha256,
        },
        {
          ordinal: 2,
          state: "awaiting_browser",
          providerGeneration: 0,
          safeErrorCode: "UPLOAD_BROWSER_BODY_INCOMPLETE",
          fileIdSha256: null,
          sizeBytes: null,
          sha256: null,
        },
      ],
    });
    await expect(
      retireResetPollutionUploadIntents({
        ...fixture.coordinate,
        expectedStateSha256: proof.stateSha256,
      }),
    ).resolves.toEqual({ retiredCount: 2 });
    const retired = await inspectResetPollutionUploadIntents(
      fixture.coordinate,
    );
    expect(retired).toEqual({ ...proof, retired: true });
    expect(provider.post).not.toHaveBeenCalled();
    expect(provider.delete).not.toHaveBeenCalled();
  });

  it("rejects an uploaded intent whose receipt and provider identity diverge", async () => {
    const fixture = await exactMixedFixture();
    await rewriteManifest(fixture.uploaded.intentId, (manifest) => {
      manifest.receipt.fileId = "different-provider-file";
    });
    await expect(
      inspectResetPollutionUploadIntents(fixture.coordinate),
    ).rejects.toThrow("KB_RESET_POLLUTION_UPLOAD_NOT_NEVER_SENT");
  });

  it("accepts the exact browser-stage expiry after zero Provider work", async () => {
    const fixture = await exactMixedFixture();
    await rewriteManifest(fixture.awaiting.intentId, (manifest) => {
      manifest.state = "expired";
      manifest.safeErrorCode = "UPLOAD_BROWSER_STAGE_EXPIRED";
    });
    const proof = await inspectResetPollutionUploadIntents(fixture.coordinate);
    expect(proof.items[1]).toMatchObject({
      state: "expired",
      providerGeneration: 0,
      safeErrorCode: "UPLOAD_BROWSER_STAGE_EXPIRED",
      fileIdSha256: null,
      sizeBytes: null,
      sha256: null,
    });
    await expect(
      retireResetPollutionUploadIntents({
        ...fixture.coordinate,
        expectedStateSha256: proof.stateSha256,
      }),
    ).resolves.toEqual({ retiredCount: 2 });
    expect(provider.post).not.toHaveBeenCalled();
    expect(provider.delete).not.toHaveBeenCalled();
  });

  it("resumes after crashing with only the first operation index retired", async () => {
    const fixture = await exactMixedFixture();
    const proof = await inspectResetPollutionUploadIntents(fixture.coordinate);
    await writeRetiredOperationIndex(fixture.uploaded.operationId);

    await expect(
      inspectResetPollutionUploadIntents(fixture.coordinate),
    ).resolves.toEqual(proof);
    await expect(
      retireResetPollutionUploadIntents({
        ...fixture.coordinate,
        expectedStateSha256: proof.stateSha256,
      }),
    ).resolves.toEqual({ retiredCount: 2 });
    await expect(
      inspectResetPollutionUploadIntents(fixture.coordinate),
    ).resolves.toEqual({ ...proof, retired: true });
  });

  it("resumes after the retired resume ledger commits before directory deletion", async () => {
    const fixture = await exactMixedFixture();
    const proof = await inspectResetPollutionUploadIntents(fixture.coordinate);
    await writeRetiredOperationIndex(fixture.uploaded.operationId);
    await writeRetiredOperationIndex(fixture.awaiting.operationId);
    await fs.writeFile(
      resumeIndexPath(fixture.coordinate),
      `${JSON.stringify({
        schemaVersion: 1,
        state: "retired",
        intentIds: [],
        retiredCount: proof.intentCount,
        stateSha256: proof.stateSha256,
        items: proof.items,
        retiredAt: "2026-08-13T06:45:00.000Z",
      })}\n`,
      "utf8",
    );

    await expect(
      inspectResetPollutionUploadIntents(fixture.coordinate),
    ).resolves.toEqual({ ...proof, retired: true });
    await expect(
      retireResetPollutionUploadIntents({
        ...fixture.coordinate,
        expectedStateSha256: proof.stateSha256,
      }),
    ).resolves.toEqual({ retiredCount: 2 });
    for (const intent of [fixture.uploaded, fixture.awaiting]) {
      const directory = path.join(
        managedUploadIntentStorageRoot(),
        createHash("sha256").update(intent.intentId).digest("hex"),
      );
      await expect(fs.stat(directory)).rejects.toMatchObject({
        code: "ENOENT",
      });
    }
  });

  it("resumes after both operation indices retire before the resume ledger commits", async () => {
    const fixture = await exactMixedFixture();
    const proof = await inspectResetPollutionUploadIntents(fixture.coordinate);
    await writeRetiredOperationIndex(fixture.uploaded.operationId);
    await writeRetiredOperationIndex(fixture.awaiting.operationId);
    await expect(
      inspectResetPollutionUploadIntents(fixture.coordinate),
    ).resolves.toEqual(proof);
    await expect(
      retireResetPollutionUploadIntents({
        ...fixture.coordinate,
        expectedStateSha256: proof.stateSha256,
      }),
    ).resolves.toEqual({ retiredCount: 2 });
  });

  it("proves retained bytes before removing the exact build-owned source", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "kb-reset-source-"));
    temporary.push(root);
    process.env.FRONTMIND_DASHBOARD_ASSET_DIR = root;
    const content = Buffer.from("retained-local-source");
    const contentSha256 = createHash("sha256").update(content).digest("hex");
    const buildId = "00000000-0000-4000-8000-000000000142";
    const localStorageKey = `knowledge-base/build-sources/42/${buildId}/g1/${contentSha256}.bin`;
    const target = path.join(root, ...localStorageKey.split("/"));
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content);
    const input = {
      userId: 42,
      buildId,
      generation: 1,
      sources: [{ localStorageKey, contentSha256, sizeBytes: content.length }],
    };
    await expect(inspectResetPollutionRetainedSources(input)).resolves.toEqual({
      verifiedCount: 1,
    });
    await expect(removeResetPollutionRetainedSources(input)).resolves.toEqual({
      removedOrMissingCount: 1,
    });
    await expect(fs.stat(target)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
