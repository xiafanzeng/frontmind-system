import * as fs from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  acquireManagedUploadDeletionFence,
  assertManagedUploadScopesAvailable,
  completeManagedUploadDeletionFence,
  ManagedUploadDeletionFenceError,
  reconcileDeletedManagedUploadAccountRetirements,
  reconcileStaleManagedUploadDeletionFence,
  renewManagedUploadDeletionFence,
  replayManagedUploadRetirementForDeletedAccount,
  retireManagedUploadIntentsForAccountDeletion,
  rollbackManagedUploadDeletionFence,
} from "./managed-upload-intent-fence";

describe("managed upload deletion fences", () => {
  let assetDirectory: string;

  beforeEach(async () => {
    assetDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "intent-fence-"));
    process.env.FRONTMIND_DASHBOARD_ASSET_DIR = assetDirectory;
  });

  afterEach(async () => {
    vi.useRealTimers();
    delete process.env.FRONTMIND_DASHBOARD_ASSET_DIR;
    await fs.rm(assetDirectory, { recursive: true, force: true });
  });

  async function writeIntent(value: Record<string, unknown>) {
    const directory = path.join(
      assetDirectory,
      "managed-upload-intents",
      "intent-directory",
    );
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(
      path.join(directory, "manifest.json"),
      JSON.stringify(value),
    );
  }

  it("blocks user, credential and project deletion while a sealed intent exists", async () => {
    await writeIntent({
      userId: 42,
      credentialId: "credential-1",
      projectAssignmentId: "project-1",
      state: "sealed",
    });

    for (const scope of [
      { kind: "user" as const, userId: 42 },
      {
        kind: "credential" as const,
        userId: 42,
        credentialId: "credential-1",
      },
      {
        kind: "project" as const,
        userId: 42,
        projectAssignmentId: "project-1",
      },
    ]) {
      await expect(acquireManagedUploadDeletionFence(scope)).rejects.toEqual(
        expect.objectContaining<Partial<ManagedUploadDeletionFenceError>>({
          code: "ACTIVE_INTENT",
        }),
      );
      await expect(assertManagedUploadScopesAvailable([scope])).resolves.toBe(
        undefined,
      );
    }
  });

  it("treats a shared credential id as global across credential owner and intent actor", async () => {
    await writeIntent({
      userId: 84,
      credentialId: "admin-owned-credential",
      credentialOwnerUserId: 42,
      projectAssignmentId: null,
      state: "sealed",
    });

    await expect(
      acquireManagedUploadDeletionFence({
        kind: "credential",
        userId: 42,
        credentialId: "admin-owned-credential",
      }),
    ).rejects.toMatchObject({ code: "ACTIVE_INTENT" });

    await expect(
      acquireManagedUploadDeletionFence({ kind: "user", userId: 42 }),
    ).rejects.toMatchObject({ code: "ACTIVE_INTENT" });
  });

  it("rolls back a deleting fence and retains a completed tombstone", async () => {
    const scope = {
      kind: "credential" as const,
      userId: 42,
      credentialId: "credential-2",
    };
    const rolledBack = await acquireManagedUploadDeletionFence(scope);
    await expect(
      assertManagedUploadScopesAvailable([scope]),
    ).rejects.toMatchObject({ code: "DELETION_IN_PROGRESS" });
    await rollbackManagedUploadDeletionFence(rolledBack);
    await expect(assertManagedUploadScopesAvailable([scope])).resolves.toBe(
      undefined,
    );

    const completed = await acquireManagedUploadDeletionFence(scope);
    await completeManagedUploadDeletionFence(completed);
    await expect(
      assertManagedUploadScopesAvailable([scope]),
    ).rejects.toMatchObject({ code: "DELETION_IN_PROGRESS" });
  });

  it("renews a live deletion lease and reconciles only after authoritative state", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-12T00:00:00.000Z"));
    const scope = { kind: "user" as const, userId: 77 };
    const token = await acquireManagedUploadDeletionFence(scope);

    vi.setSystemTime(new Date("2026-08-12T00:01:00.000Z"));
    await renewManagedUploadDeletionFence(token);
    vi.setSystemTime(new Date("2026-08-12T00:21:01.000Z"));
    await expect(
      reconcileStaleManagedUploadDeletionFence(scope, "active"),
    ).rejects.toMatchObject({ code: "DELETION_IN_PROGRESS" });

    vi.setSystemTime(new Date("2026-08-12T00:22:01.000Z"));
    await expect(
      reconcileStaleManagedUploadDeletionFence(scope, "active"),
    ).resolves.toBe("active");
    await expect(assertManagedUploadScopesAvailable([scope])).resolves.toBe(
      undefined,
    );
  });

  it("lets an administrator resume the exact permanent-account fence without waiting for its worker lease", async () => {
    const scope = { kind: "user" as const, userId: 78 };
    const original = await acquireManagedUploadDeletionFence(scope, {
      disposition: "cancel_active_intents",
      purpose: "account_deletion",
    });
    const resumed = await acquireManagedUploadDeletionFence(scope, {
      disposition: "cancel_active_intents",
      purpose: "account_deletion",
    });
    expect(resumed).toMatchObject({
      scope,
      nonce: original.nonce,
      resumed: true,
    });
    await expect(
      acquireManagedUploadDeletionFence(scope, {
        disposition: "cancel_active_intents",
      }),
    ).rejects.toMatchObject({ code: "DELETION_IN_PROGRESS" });
    await rollbackManagedUploadDeletionFence(original);
  });

  it("fails closed for terminal manifests with an active lease or orphan provider", async () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    await writeIntent({
      userId: 91,
      credentialId: "credential-terminal",
      projectAssignmentId: null,
      state: "uploaded",
      leaseOwner: "crashed-finalizer",
      leaseExpiresAt: future,
      provider: [],
    });
    const userScope = { kind: "user" as const, userId: 91 };
    await expect(
      acquireManagedUploadDeletionFence(userScope),
    ).rejects.toMatchObject({ code: "ACTIVE_INTENT" });

    await fs.rm(
      path.join(
        assetDirectory,
        "managed-upload-intents",
        "intent-directory",
        "manifest.json",
      ),
    );
    await writeIntent({
      userId: 91,
      credentialId: "credential-terminal",
      projectAssignmentId: null,
      state: "expired",
      leaseOwner: null,
      leaseExpiresAt: null,
      provider: [{ fileId: "provider-orphan", state: "waiting" }],
    });
    await expect(
      acquireManagedUploadDeletionFence(userScope),
    ).rejects.toMatchObject({ code: "ACTIVE_INTENT" });
  });

  it("ignores index directories and lets permanent account deletion retire active intents", async () => {
    const root = path.join(assetDirectory, "managed-upload-intents");
    await fs.mkdir(path.join(root, "by-resume-scope"), { recursive: true });
    await fs.writeFile(
      path.join(root, "by-resume-scope", "unrelated.json"),
      JSON.stringify({ schemaVersion: 1, intentIds: [] }),
    );
    const cleanScope = { kind: "user" as const, userId: 201 };
    const clean = await acquireManagedUploadDeletionFence(cleanScope);
    await rollbackManagedUploadDeletionFence(clean);

    const intentId = "intent-account-delete";
    const operationId = "operation-account-delete";
    const requestHash = "a".repeat(64);
    const key = createHash("sha256").update(intentId).digest("hex");
    const directory = path.join(root, key);
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, "upload.part"), "partial");
    await fs.writeFile(path.join(directory, "upload.content"), "sealed");
    await fs.writeFile(
      path.join(directory, "manifest.json"),
      JSON.stringify({
        intentId,
        operationId,
        requestHash,
        userId: 42,
        credentialOwnerUserId: 42,
        projectAssignmentId: null,
        resumeScope: null,
        state: "processing",
        phase: "waiting_provider",
        revision: 7,
        leaseOwner: "worker",
        leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
        provider: [{ fileId: "provider-file", state: "waiting" }],
        receipt: null,
      }),
    );
    const scope = { kind: "user" as const, userId: 42 };
    await expect(
      acquireManagedUploadDeletionFence(scope),
    ).rejects.toMatchObject({ code: "ACTIVE_INTENT" });

    const token = await acquireManagedUploadDeletionFence(scope, {
      disposition: "cancel_active_intents",
    });
    await expect(
      retireManagedUploadIntentsForAccountDeletion({ userId: 42, token }),
    ).resolves.toMatchObject({ matched: 1, retired: 1, warnings: 0 });
    const retired = JSON.parse(
      await fs.readFile(path.join(directory, "manifest.json"), "utf8"),
    );
    expect(retired).toMatchObject({
      state: "cleanup_pending",
      leaseOwner: null,
      leaseExpiresAt: null,
      safeErrorCode: "UPLOAD_ACCOUNT_DELETION_CLEANUP_PENDING",
    });
    expect(
      JSON.parse(
        await fs.readFile(path.join(directory, "cleanup-request.json"), "utf8"),
      ),
    ).toMatchObject({
      reason: "account_deleted",
      providerFiles: [
        expect.objectContaining({
          fileId: "provider-file",
          state: "pending",
        }),
      ],
    });
    await expect(
      fs.stat(path.join(directory, "upload.part")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      fs.stat(path.join(directory, "upload.content")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await completeManagedUploadDeletionFence(token);
    await expect(
      assertManagedUploadScopesAvailable([scope]),
    ).rejects.toMatchObject({ code: "DELETION_IN_PROGRESS" });
  });

  it("claims each provider cleanup once and missing-user replay only completes local retirement", async () => {
    const root = path.join(assetDirectory, "managed-upload-intents");
    const intentId = "intent-provider-cleanup";
    const operationId = "operation-provider-cleanup";
    const requestHash = "b".repeat(64);
    const directory = path.join(
      root,
      createHash("sha256").update(intentId).digest("hex"),
    );
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, "upload.content"), "sealed");
    await fs.writeFile(
      path.join(directory, "manifest.json"),
      JSON.stringify({
        intentId,
        operationId,
        requestHash,
        userId: 42,
        credentialId: "credential-1",
        credentialOwnerUserId: 42,
        credentialVersion: 3,
        projectAssignmentId: null,
        resumeScope: null,
        state: "processing",
        phase: "waiting_provider",
        revision: 7,
        leaseOwner: null,
        leaseExpiresAt: null,
        provider: [{ fileId: "provider-file", state: "waiting" }],
        receipt: null,
      }),
    );
    const scope = { kind: "user" as const, userId: 42 };
    const token = await acquireManagedUploadDeletionFence(scope, {
      disposition: "cancel_active_intents",
    });
    const discard = vi.fn().mockRejectedValue(new Error("provider timeout"));
    await expect(
      retireManagedUploadIntentsForAccountDeletion({
        userId: 42,
        token,
        discardProviderFile: discard,
      }),
    ).resolves.toMatchObject({
      retired: 1,
      cleanupPending: 1,
      warnings: 1,
    });
    expect(discard).toHaveBeenCalledOnce();
    expect(
      JSON.parse(
        await fs.readFile(path.join(directory, "cleanup-request.json"), "utf8"),
      ),
    ).toMatchObject({
      providerFiles: [
        expect.objectContaining({
          fileId: "provider-file",
          state: "attempted",
          attemptedAt: expect.any(String),
        }),
      ],
    });
    await completeManagedUploadDeletionFence(token);
    await expect(
      replayManagedUploadRetirementForDeletedAccount(42),
    ).resolves.toMatchObject({ retired: 1, cleanupPending: 1 });
    expect(discard).toHaveBeenCalledOnce();
    await expect(
      fs.stat(path.join(directory, "upload.content")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("marks an intent cancelled only after fence-token provider cleanup succeeds", async () => {
    const root = path.join(assetDirectory, "managed-upload-intents");
    const intentId = "intent-provider-cleanup-success";
    const directory = path.join(
      root,
      createHash("sha256").update(intentId).digest("hex"),
    );
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(
      path.join(directory, "manifest.json"),
      JSON.stringify({
        intentId,
        operationId: "operation-provider-cleanup-success",
        requestHash: "c".repeat(64),
        userId: 42,
        credentialId: "credential-1",
        credentialOwnerUserId: 42,
        credentialVersion: 3,
        projectAssignmentId: null,
        resumeScope: null,
        state: "uploaded",
        phase: null,
        revision: 7,
        leaseOwner: null,
        leaseExpiresAt: null,
        provider: [
          {
            fileId: "provider-file-success",
            state: "uploaded",
            ownershipRecorded: true,
          },
        ],
        receipt: { fileId: "provider-file-success" },
      }),
    );
    const token = await acquireManagedUploadDeletionFence(
      { kind: "user", userId: 42 },
      { disposition: "cancel_active_intents" },
    );
    const discard = vi.fn().mockResolvedValue(undefined);
    await expect(
      retireManagedUploadIntentsForAccountDeletion({
        userId: 42,
        token,
        discardProviderFile: discard,
      }),
    ).resolves.toMatchObject({ retired: 1, cleanupPending: 0, warnings: 0 });
    expect(discard).toHaveBeenCalledWith(
      expect.objectContaining({
        credentialId: "credential-1",
        credentialVersion: 3,
        fileId: "provider-file-success",
      }),
    );
    expect(
      JSON.parse(
        await fs.readFile(path.join(directory, "manifest.json"), "utf8"),
      ),
    ).toMatchObject({
      state: "cancelled",
      receipt: null,
      provider: [
        expect.objectContaining({
          fileId: "provider-file-success",
          state: "discarded",
          ownershipRecorded: false,
        }),
      ],
    });
    expect(
      JSON.parse(
        await fs.readFile(path.join(directory, "cleanup-request.json"), "utf8"),
      ),
    ).toMatchObject({
      providerFiles: [
        expect.objectContaining({
          fileId: "provider-file-success",
          state: "discarded",
          attemptedAt: expect.any(String),
          completedAt: expect.any(String),
        }),
      ],
    });
    await completeManagedUploadDeletionFence(token);
  });

  it("does not delete an unprovable corrupt directory and does not let it block account deletion", async () => {
    const root = path.join(assetDirectory, "managed-upload-intents");
    const directory = path.join(root, "f".repeat(64));
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, "manifest.json"), "{broken-json");
    await fs.writeFile(path.join(directory, "upload.part"), "unknown-owner");
    const token = await acquireManagedUploadDeletionFence(
      { kind: "user", userId: 42 },
      {
        disposition: "cancel_active_intents",
        purpose: "account_deletion",
      },
    );
    await expect(
      retireManagedUploadIntentsForAccountDeletion({ userId: 42, token }),
    ).resolves.toMatchObject({
      matched: 0,
      retired: 0,
      corrupt: 1,
      warnings: 1,
    });
    await completeManagedUploadDeletionFence(token);
    await expect(
      fs.readFile(path.join(directory, "upload.part"), "utf8"),
    ).resolves.toBe("unknown-owner");
  });

  it("startup reconciliation retires local capabilities after a crash following the database commit", async () => {
    const root = path.join(assetDirectory, "managed-upload-intents");
    const intentId = "intent-post-commit-crash";
    const operationId = "operation-post-commit-crash";
    const requestHash = "d".repeat(64);
    const directory = path.join(
      root,
      createHash("sha256").update(intentId).digest("hex"),
    );
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, "upload.part"), "partial");
    await fs.writeFile(
      path.join(directory, "manifest.json"),
      JSON.stringify({
        intentId,
        operationId,
        requestHash,
        userId: 77,
        credentialId: "credential-77",
        credentialOwnerUserId: 77,
        credentialVersion: 1,
        projectAssignmentId: null,
        resumeScope: null,
        state: "receiving",
        phase: "receiving",
        revision: 2,
        leaseOwner: null,
        leaseExpiresAt: null,
        provider: [],
        receipt: null,
      }),
    );
    const token = await acquireManagedUploadDeletionFence(
      { kind: "user", userId: 77 },
      { disposition: "cancel_active_intents" },
    );
    // Simulate the user-row commit and process exit before local retirement.
    await completeManagedUploadDeletionFence(token);

    await expect(
      reconcileDeletedManagedUploadAccountRetirements(),
    ).resolves.toMatchObject({ reconciled: 1, failed: 0 });
    expect(
      JSON.parse(
        await fs.readFile(path.join(directory, "manifest.json"), "utf8"),
      ),
    ).toMatchObject({
      state: "cancelled",
      safeErrorCode: "UPLOAD_ACCOUNT_DELETED",
    });
    await expect(
      fs.stat(path.join(directory, "upload.part")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    const operationKey = createHash("sha256")
      .update(JSON.stringify([77, null, operationId]))
      .digest("hex");
    expect(
      JSON.parse(
        await fs.readFile(
          path.join(root, "by-operation", `${operationKey}.json`),
          "utf8",
        ),
      ),
    ).toMatchObject({ state: "retired" });
  });
});
