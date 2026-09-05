import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AuthServiceError, decryptApiKey, encryptApiKey } from "./auth-service";
import { WEBSITE_PROJECT_PHYSICAL_DELETE_ENABLED } from "./website-project-lifecycle";
import {
  agentOperations,
  presalesApiCredentials,
  presalesOutputUrls,
  presalesMonitorRuns,
  presalesTaskRequests,
  presalesUpstreamResources,
  providerFileLeases,
  websiteProjectDeletionTombstones,
} from "../drizzle/schema";
import {
  PRESALES_REVOKABLE_STATUSES,
  aggregatePresalesCreditUsagePage,
  acquirePresalesTaskReservation,
  completePresalesTaskReservation,
  completePresalesProjectTaskPurge,
  deletePresalesTaskEvidence,
  deletePresalesApiCredential,
  decryptPresalesApiKey,
  encryptPresalesApiKey,
  finalizePresalesFileUploadRetention,
  hashPresalesOutputUrl,
  hashPresalesIdempotencyKey,
  hashPresalesTaskPayload,
  isPresalesDuplicateEntryError,
  markPresalesFileContentDeleted,
  projectWebsiteUsageOwnership,
  projectPresalesTaskBusinessOwners,
  recordPresalesUpstreamResource,
  readPresalesProjectTaskPurgeSnapshot,
  releasePresalesTaskReservation,
  retainPresalesTaskPurgeTarget,
  reservePresalesFileUploadRetention,
  resolvePresalesTaskCredentialForFiles,
  syncPresalesOutputUrlGrants,
} from "./presales-service";

const originalMasterKey = process.env.FRONTMIND_CREDENTIAL_ENCRYPTION_KEY;

describe("presales credential encryption", () => {
  beforeEach(() => {
    process.env.FRONTMIND_CREDENTIAL_ENCRYPTION_KEY =
      randomBytes(32).toString("base64");
  });

  afterEach(() => {
    if (originalMasterKey === undefined) {
      delete process.env.FRONTMIND_CREDENTIAL_ENCRYPTION_KEY;
    } else {
      process.env.FRONTMIND_CREDENTIAL_ENCRYPTION_KEY = originalMasterKey;
    }
  });

  it("round-trips without persisting plaintext", () => {
    const id = randomUUID();
    const apiKey = "sk-presales-secret-that-must-stay-server-side";
    const encrypted = encryptPresalesApiKey(id, apiKey);

    expect(Object.values(encrypted).join(" ")).not.toContain(apiKey);
    expect(decryptPresalesApiKey({ id, ...encrypted })).toBe(apiKey);
  });

  it("binds ciphertext to the website presales slot and credential id", () => {
    const encrypted = encryptPresalesApiKey(randomUUID(), "sk-presales-secret");
    expect(() =>
      decryptPresalesApiKey({ id: randomUUID(), ...encrypted }),
    ).toThrowError(AuthServiceError);
  });

  it("allows the website credential to independently store an account's raw Key", () => {
    const apiKey = "sk-shared-between-website-and-account";
    const websiteCredentialId = randomUUID();
    const accountCredentialId = randomUUID();
    const websiteEncrypted = encryptPresalesApiKey(websiteCredentialId, apiKey);
    const accountEncrypted = encryptApiKey(7, accountCredentialId, apiKey);

    expect(websiteEncrypted.encryptedKey).not.toBe(
      accountEncrypted.encryptedKey,
    );
    expect(
      decryptPresalesApiKey({
        id: websiteCredentialId,
        ...websiteEncrypted,
      }),
    ).toBe(apiKey);
    expect(
      decryptApiKey({
        id: accountCredentialId,
        userId: 7,
        ...accountEncrypted,
      }),
    ).toBe(apiKey);
  });
});

describe("presales rolling usage aggregation", () => {
  it("projects owner names for v2 and monitor tasks without guessing history", () => {
    const projected = projectPresalesTaskBusinessOwners({
      taskIds: ["v2-task", "monitor-task", "historical-task"],
      agentTaskRows: [{ upstreamTaskId: "v2-task", projectId: "project-v2" }],
      monitorRows: [
        { upstreamTaskId: "monitor-task", projectId: "project-monitor" },
      ],
      attributionRows: [
        { projectId: "project-v2", businessOwnerName: "应祥" },
        { projectId: "project-monitor", businessOwnerName: "Alice" },
      ],
    });
    expect(Object.fromEntries(projected)).toEqual({
      "v2-task": "应祥",
      "monitor-task": "Alice",
      "historical-task": null,
    });
  });

  it("includes v2 agent tasks in Website ownership and unsettled scans", () => {
    const createdAt = new Date("2026-08-02T08:00:00.000Z");
    const projected = projectWebsiteUsageOwnership({
      resourceRows: [],
      ownedRows: [],
      monitorRows: [],
      agentTaskRows: [
        {
          upstreamTaskId: "provider-v2-running",
          apiCredentialId: "credential-v2-running",
          createdAt,
          status: "running",
        },
        {
          upstreamTaskId: "provider-v2-complete",
          apiCredentialId: "credential-v2-complete",
          createdAt,
          status: "succeeded",
        },
        {
          upstreamTaskId: null,
          apiCredentialId: "credential-v2-unknown",
          createdAt,
          status: "attention_required",
        },
      ],
    });

    expect([...projected.websiteTaskIds]).toEqual([
      "provider-v2-running",
      "provider-v2-complete",
    ]);
    expect([...projected.unsettledCredentialIds]).toEqual([
      "credential-v2-running",
      "credential-v2-unknown",
    ]);
  });

  it("deduplicates the same task returned by multiple credential versions and enforces the 30-day boundary", () => {
    const now = Date.parse("2026-08-02T08:00:00.000Z");
    const cutoff = now - 30 * 86_400_000;
    const seenTaskIds = new Set<string>();
    const currentVersion = aggregatePresalesCreditUsagePage({
      tasks: [
        { id: "shared-task", created_at: cutoff, credit_usage: 40 },
        { id: "future-task", created_at: now, credit_usage: 100 },
      ],
      websiteTaskIds: new Set(["shared-task", "future-task"]),
      cutoffMs: cutoff,
      endExclusive: now,
      seenTaskIds,
    });
    const retiredVersion = aggregatePresalesCreditUsagePage({
      tasks: [
        { id: "shared-task", created_at: cutoff, credit_usage: 40 },
        { id: "old-task", created_at: cutoff - 1, credit_usage: 80 },
      ],
      websiteTaskIds: new Set(["shared-task", "old-task"]),
      cutoffMs: cutoff,
      endExclusive: now,
      seenTaskIds,
    });
    expect(currentVersion).toMatchObject({
      keyTotalUsed: 40,
      websiteUsed: 40,
      recentWebsiteTasks: [
        expect.objectContaining({ businessOwnerName: null }),
      ],
    });
    expect(retiredVersion).toMatchObject({
      keyTotalUsed: 0,
      websiteUsed: 0,
      reachedCutoff: true,
    });
  });

  it("marks a page incomplete instead of reporting a false total when a task timestamp is unknown", () => {
    const result = aggregatePresalesCreditUsagePage({
      tasks: [{ id: "unknown-time", credit_usage: 50 }],
      websiteTaskIds: new Set(["unknown-time"]),
      cutoffMs: 0,
      endExclusive: Date.now(),
      seenTaskIds: new Set(),
    });
    expect(result).toMatchObject({
      keyTotalUsed: 0,
      websiteUsed: 0,
      complete: false,
    });
  });

  it("keeps scanning a page when an expired task appears before a recent task", () => {
    const now = Date.parse("2026-08-02T08:00:00.000Z");
    const cutoff = now - 30 * 86_400_000;
    const result = aggregatePresalesCreditUsagePage({
      tasks: [
        { id: "old-first", created_at: cutoff - 1, credit_usage: 99 },
        { id: "new-later", created_at: cutoff + 1, credit_usage: 40 },
      ],
      websiteTaskIds: new Set(["new-later"]),
      cutoffMs: cutoff,
      endExclusive: now,
      seenTaskIds: new Set(),
    });
    expect(result).toMatchObject({
      keyTotalUsed: 40,
      websiteUsed: 40,
      reachedCutoff: false,
      complete: true,
    });
  });
});

function resourceCredential(id: string, status: "active" | "retired") {
  return {
    id,
    version: id === "credential-1" ? 1 : 2,
    apiKey: `sk-${id}`,
    fingerprint: `fingerprint-${id}`,
    status,
    verifiedAt: new Date("2026-07-22T00:00:00.000Z"),
    resource: {
      id: `resource-${id}`,
      apiCredentialId: id,
      kind: "file" as const,
      upstreamId: `file-${id}`,
      parentTaskId: null,
      contentSource: "user_upload" as const,
      uploadReservedAt: new Date("2026-07-22T00:00:00.000Z"),
      uploadedAt: new Date("2026-07-22T00:00:00.000Z"),
      contentExpiresAt: new Date("2026-08-21T00:00:00.000Z"),
      contentDeletedAt: null,
      createdAt: new Date("2026-07-22T00:00:00.000Z"),
    },
  };
}

describe("presales credential version binding", () => {
  it("rejects retired attachments even when they all belong to one old version", async () => {
    const oldCredential = resourceCredential("credential-1", "retired");
    const active = resourceCredential("credential-2", "active");
    await expect(
      resolvePresalesTaskCredentialForFiles(
        ["kb.zip", "evidence.pdf", "kb.zip"],
        {
          getActive: async () => {
            const { resource: _resource, ...value } = active;
            return value;
          },
          getForFile: async () => oldCredential,
        },
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("rejects attachments owned by multiple credential versions", async () => {
    await expect(
      resolvePresalesTaskCredentialForFiles(["old.zip", "new.pdf"], {
        getActive: async () => {
          const { resource: _resource, ...value } = resourceCredential(
            "credential-2",
            "active",
          );
          return value;
        },
        getForFile: async (fileId) =>
          fileId === "old.zip"
            ? resourceCredential("credential-1", "retired")
            : resourceCredential("credential-2", "active"),
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("rejects an attachment whose credential was revoked", async () => {
    await expect(
      resolvePresalesTaskCredentialForFiles(["revoked.zip"], {
        getActive: async () => {
          const { resource: _resource, ...value } = resourceCredential(
            "credential-2",
            "active",
          );
          return value;
        },
        getForFile: async () => null,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("uses the active credential only when there are no attachments", async () => {
    const active = resourceCredential("credential-2", "active");
    const credential = await resolvePresalesTaskCredentialForFiles([], {
      getActive: async () => {
        const { resource: _resource, ...value } = active;
        return value;
      },
    });
    expect(credential?.id).toBe("credential-2");
  });

  it("returns the current credential when every attachment belongs to it", async () => {
    const activeResource = resourceCredential("credential-2", "active");
    const { resource: _resource, ...active } = activeResource;
    const credential = await resolvePresalesTaskCredentialForFiles(
      ["current.zip", "current.skill.zip"],
      {
        getActive: async () => active,
        getForFile: async () => activeResource,
      },
    );
    expect(credential).toEqual(active);
  });
});

describe("presales credential revocation", () => {
  it("destroys only an unbound active version and preserves retired history", async () => {
    let update: Record<string, unknown> | undefined;
    let selectIndex = 0;
    const executor = {
      select: () => {
        const rows = selectIndex++ === 0 ? [{ id: "active-credential" }] : [];
        return {
          from: () => ({
            where: () => ({
              for: async () => rows,
              limit: () => ({ for: async () => rows }),
            }),
          }),
        };
      },
      update: () => ({
        set: (value: Record<string, unknown>) => {
          update = value;
          return { where: async () => undefined };
        },
      }),
    };

    await deletePresalesApiCredential(executor);

    expect(PRESALES_REVOKABLE_STATUSES).toEqual(["active"]);
    expect(update).toMatchObject({
      status: "deleted",
      validationStatus: "unverified",
    });
    expect(update?.deletedAt).toBeInstanceOf(Date);
    expect(String(update?.encryptedKey)).toHaveLength(44);
    expect(String(update?.encryptionIv)).toHaveLength(16);
    expect(String(update?.encryptionAuthTag)).toHaveLength(24);
  });

  it("fails closed when the active website Key still owns a task, file or monitor run", async () => {
    let selectIndex = 0;
    let updateCalled = false;
    const executor = {
      select: () => {
        const rows =
          selectIndex++ === 0
            ? [{ id: "active-credential" }]
            : selectIndex === 2
              ? [{ id: "bound-resource" }]
              : [];
        return {
          from: () => ({
            where: () => ({
              for: async () => rows,
              limit: () => ({ for: async () => rows }),
            }),
          }),
        };
      },
      update: () => {
        updateCalled = true;
        return { set: () => ({ where: async () => undefined }) };
      },
    };

    await expect(deletePresalesApiCredential(executor)).rejects.toMatchObject({
      code: "CONFLICT",
    });
    expect(updateCalled).toBe(false);
  });

  it("fails closed when a website v2 operation is still non-terminal", async () => {
    let updateCalled = false;
    const executor = {
      select: () => ({
        from: (table: unknown) => ({
          where: () => {
            const rows =
              table === presalesApiCredentials
                ? [{ id: "active-credential" }]
                : table === agentOperations
                  ? [{ id: "operation-running" }]
                  : table === providerFileLeases
                    ? []
                    : [];
            return {
              for: async () => rows,
              limit: () => ({ for: async () => rows }),
            };
          },
        }),
      }),
      update: () => {
        updateCalled = true;
        return { set: () => ({ where: async () => undefined }) };
      },
    };

    await expect(deletePresalesApiCredential(executor)).rejects.toMatchObject({
      code: "CONFLICT",
    });
    expect(updateCalled).toBe(false);
  });

  it("fails closed when a website v2 provider upload outcome is unresolved", async () => {
    let updateCalled = false;
    const executor = {
      select: () => ({
        from: (table: unknown) => ({
          where: () => {
            const rows =
              table === presalesApiCredentials
                ? [{ id: "active-credential" }]
                : table === providerFileLeases
                  ? [{ id: "lease-unknown" }]
                  : [];
            return {
              for: async () => rows,
              limit: () => ({ for: async () => rows }),
            };
          },
        }),
      }),
      update: () => {
        updateCalled = true;
        return { set: () => ({ where: async () => undefined }) };
      },
    };

    await expect(deletePresalesApiCredential(executor)).rejects.toMatchObject({
      code: "CONFLICT",
    });
    expect(updateCalled).toBe(false);
  });

  it("stores only a deterministic hash for signed task output URLs", () => {
    const url = "https://objects.example.com/result.zip?signature=secret";
    const hash = hashPresalesOutputUrl(url);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    expect(hashPresalesOutputUrl(url)).toBe(hash);
    expect(hash).not.toContain("signature");
    expect(hashPresalesOutputUrl(`${url}-different`)).not.toBe(hash);
  });

  it("replaces URL grants so removed task outputs are revoked", async () => {
    const operations: Array<string | { insert: unknown[] }> = [];
    const transaction = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: () => ({
              for: async () => [{ id: "resource-task-1" }],
            }),
          }),
        }),
      }),
      delete: () => ({
        where: async () => {
          operations.push("delete");
        },
      }),
      insert: () => ({
        values: async (values: unknown[]) => {
          operations.push({ insert: values });
        },
      }),
    };
    const executor = {
      select: () => ({
        from: () => ({
          where: () => ({ limit: async () => [{ projectId: null }] }),
        }),
      }),
      transaction: async (run: (tx: typeof transaction) => Promise<void>) =>
        run(transaction),
    };

    await syncPresalesOutputUrlGrants(
      {
        apiCredentialId: "credential-1",
        parentTaskId: "task-1",
        urls: [
          {
            url: "https://objects.example.com/current.zip?signature=secret",
            hostname: "objects.example.com",
          },
        ],
      },
      executor,
    );
    expect(operations[0]).toBe("delete");
    expect(operations[1]).toMatchObject({
      insert: [
        {
          apiCredentialId: "credential-1",
          parentTaskId: "task-1",
          hostname: "objects.example.com",
        },
      ],
    });
    expect(JSON.stringify(operations)).not.toContain("signature=secret");

    operations.length = 0;
    await syncPresalesOutputUrlGrants(
      {
        apiCredentialId: "credential-1",
        parentTaskId: "task-1",
        urls: [],
      },
      executor,
    );
    expect(operations).toEqual(["delete"]);
  });
});

function createPresalesFileRetentionExecutor(input?: {
  parentTaskId?: string | null;
  contentSource?: "user_upload" | "assistant_output" | null;
  uploadReservedAt?: Date | null;
  uploadedAt?: Date | null;
  contentExpiresAt?: Date | null;
  contentDeletedAt?: Date | null;
}) {
  let observedNow = new Date("2026-08-04T08:00:00.000Z");
  const resource = {
    id: "presales-file-resource-1",
    projectId: null as string | null,
    apiCredentialId: "credential-1",
    kind: "file" as const,
    upstreamId: "file-1",
    parentTaskId: input?.parentTaskId ?? null,
    contentSource: input?.contentSource ?? null,
    uploadReservedAt: input?.uploadReservedAt ?? null,
    uploadedAt: input?.uploadedAt ?? null,
    contentExpiresAt: input?.contentExpiresAt ?? null,
    contentDeletedAt: input?.contentDeletedAt ?? null,
    createdAt: new Date("2026-08-04T07:59:00.000Z"),
  };
  const update = (table: unknown) => ({
    set: (values: Record<string, unknown>) => ({
      where: async () => {
        if (table !== presalesUpstreamResources) return;
        if ("uploadReservedAt" in values) {
          const lifecycleIsValid =
            (resource.uploadReservedAt === null &&
              resource.uploadedAt === null &&
              resource.contentExpiresAt === null) ||
            (resource.uploadReservedAt !== null &&
              resource.uploadedAt === null &&
              resource.contentExpiresAt === null &&
              resource.uploadReservedAt.getTime() + 30 * 24 * 60 * 60 * 1_000 >
                observedNow.getTime()) ||
            (resource.uploadReservedAt !== null &&
              resource.uploadedAt?.getTime() ===
                resource.uploadReservedAt.getTime() &&
              resource.contentExpiresAt?.getTime() ===
                resource.uploadReservedAt.getTime() +
                  30 * 24 * 60 * 60 * 1_000 &&
              resource.contentExpiresAt.getTime() > observedNow.getTime());
          if (
            resource.contentSource === "user_upload" &&
            resource.contentDeletedAt === null &&
            lifecycleIsValid
          ) {
            resource.uploadReservedAt ??= new Date(observedNow);
          }
          return;
        }
        if ("uploadedAt" in values && "contentExpiresAt" in values) {
          if (
            resource.contentSource === "user_upload" &&
            resource.contentDeletedAt === null &&
            resource.uploadReservedAt &&
            resource.uploadReservedAt.getTime() + 30 * 24 * 60 * 60 * 1_000 >
              observedNow.getTime() &&
            ((resource.uploadedAt === null &&
              resource.contentExpiresAt === null) ||
              (resource.uploadedAt?.getTime() ===
                resource.uploadReservedAt.getTime() &&
                resource.contentExpiresAt?.getTime() ===
                  resource.uploadReservedAt.getTime() +
                    30 * 24 * 60 * 60 * 1_000))
          ) {
            resource.uploadedAt ??= new Date(resource.uploadReservedAt);
            resource.contentExpiresAt ??= new Date(
              resource.uploadReservedAt.getTime() + 30 * 24 * 60 * 60 * 1_000,
            );
          }
          return;
        }
        if ("contentDeletedAt" in values) {
          if (resource.contentSource === "user_upload") {
            resource.contentDeletedAt ??= new Date(observedNow);
          }
          return;
        }
        if (typeof values.contentSource === "string") {
          resource.contentSource = values.contentSource as
            | "user_upload"
            | "assistant_output";
        }
        if (typeof values.parentTaskId === "string") {
          resource.parentTaskId = values.parentTaskId;
        }
        if (typeof values.projectId === "string") {
          resource.projectId = values.projectId;
        }
      },
    }),
  });
  const rows = () => {
    const promise = Promise.resolve([resource]);
    return {
      for: async () => [resource],
      then: promise.then.bind(promise),
    };
  };
  const select = () => ({
    from: () => ({
      where: () => ({ limit: () => rows() }),
    }),
  });
  const executor: any = {
    update,
    select,
    resource,
    transactionCount: 0,
    setNow(now: Date) {
      observedNow = now;
    },
  };
  executor.transaction = async (run: (tx: any) => Promise<unknown>) => {
    executor.transactionCount += 1;
    return run(executor);
  };
  return executor;
}

describe("presales file retention ledger", () => {
  it("reserves before PUT, finalizes after 2xx, and never moves the clock", async () => {
    const executor = createPresalesFileRetentionExecutor({
      contentSource: "user_upload",
    });
    const uploadedAt = new Date("2026-08-04T08:00:00.000Z");
    executor.setNow(uploadedAt);

    const first = await reservePresalesFileUploadRetention(
      {
        fileId: "file-1",
        apiCredentialId: "credential-1",
        now: uploadedAt,
      },
      executor,
    );
    expect(first).toMatchObject({
      contentSource: "user_upload",
      uploadReservedAt: uploadedAt,
      uploadedAt: null,
      contentExpiresAt: null,
      contentDeletedAt: null,
    });

    const finalized = await finalizePresalesFileUploadRetention(
      {
        fileId: "file-1",
        apiCredentialId: "credential-1",
        now: new Date("2026-08-04T08:01:00.000Z"),
      },
      executor,
    );
    expect(finalized).toMatchObject({
      uploadReservedAt: uploadedAt,
      uploadedAt,
      contentExpiresAt: new Date("2026-09-03T08:00:00.000Z"),
    });

    const retryAt = new Date("2026-08-14T08:00:00.000Z");
    executor.setNow(retryAt);
    const retry = await reservePresalesFileUploadRetention(
      {
        fileId: "file-1",
        apiCredentialId: "credential-1",
        now: retryAt,
      },
      executor,
    );
    expect(retry.uploadReservedAt).toEqual(uploadedAt);
    expect(retry.uploadedAt).toEqual(uploadedAt);
    expect(retry.contentExpiresAt).toEqual(
      new Date("2026-09-03T08:00:00.000Z"),
    );
    expect(executor.transactionCount).toBe(0);
  });

  it("rejects expired, deleted, and assistant-output rows without renewing them", async () => {
    const uploadedAt = new Date("2026-07-05T08:00:00.000Z");
    const contentExpiresAt = new Date("2026-08-04T08:00:00.000Z");
    const expired = createPresalesFileRetentionExecutor({
      contentSource: "user_upload",
      uploadReservedAt: uploadedAt,
      uploadedAt,
      contentExpiresAt,
    });
    expired.setNow(contentExpiresAt);
    await expect(
      reservePresalesFileUploadRetention(
        {
          fileId: "file-1",
          apiCredentialId: "credential-1",
          now: contentExpiresAt,
        },
        expired,
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(expired.resource).toMatchObject({ uploadedAt, contentExpiresAt });

    const expiredReservation = createPresalesFileRetentionExecutor({
      contentSource: "user_upload",
      uploadReservedAt: uploadedAt,
    });
    expiredReservation.setNow(contentExpiresAt);
    await expect(
      reservePresalesFileUploadRetention(
        {
          fileId: "file-1",
          apiCredentialId: "credential-1",
          now: contentExpiresAt,
        },
        expiredReservation,
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(expiredReservation.resource).toMatchObject({
      uploadReservedAt: uploadedAt,
      uploadedAt: null,
      contentExpiresAt: null,
    });

    const deleted = createPresalesFileRetentionExecutor({
      contentSource: "user_upload",
      uploadReservedAt: uploadedAt,
      uploadedAt,
      contentExpiresAt: new Date("2026-09-03T08:00:00.000Z"),
      contentDeletedAt: new Date("2026-08-04T07:00:00.000Z"),
    });
    await expect(
      reservePresalesFileUploadRetention(
        {
          fileId: "file-1",
          apiCredentialId: "credential-1",
          now: new Date("2026-08-04T08:00:00.000Z"),
        },
        deleted,
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    const output = createPresalesFileRetentionExecutor({
      contentSource: "assistant_output",
    });
    await expect(
      reservePresalesFileUploadRetention(
        {
          fileId: "file-1",
          apiCredentialId: "credential-1",
          now: new Date("2026-08-04T08:00:00.000Z"),
        },
        output,
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(output.resource.contentSource).toBe("assistant_output");
    expect(output.resource.uploadedAt).toBeNull();
  });

  it("records the first physical deletion time without moving it", async () => {
    const executor = createPresalesFileRetentionExecutor({
      contentSource: "user_upload",
      uploadReservedAt: new Date("2026-07-05T08:00:00.000Z"),
      uploadedAt: new Date("2026-07-05T08:00:00.000Z"),
      contentExpiresAt: new Date("2026-08-04T08:00:00.000Z"),
    });
    const firstDeletedAt = new Date("2026-08-04T08:05:00.000Z");
    executor.setNow(firstDeletedAt);
    const first = await markPresalesFileContentDeleted(
      {
        fileId: "file-1",
        apiCredentialId: "credential-1",
        now: firstDeletedAt,
      },
      executor,
    );
    expect(first.contentDeletedAt).toEqual(firstDeletedAt);

    const retryAt = new Date("2026-08-04T09:00:00.000Z");
    executor.setNow(retryAt);
    const retry = await markPresalesFileContentDeleted(
      { fileId: "file-1", now: retryAt },
      executor,
    );
    expect(retry.contentDeletedAt).toEqual(firstDeletedAt);
  });

  it("accepts only file provenance and never changes an existing source", async () => {
    await expect(
      recordPresalesUpstreamResource(
        {
          apiCredentialId: "credential-1",
          kind: "task",
          upstreamId: "task-1",
          contentSource: "user_upload",
        },
        {},
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(
      recordPresalesUpstreamResource(
        {
          apiCredentialId: "credential-1",
          kind: "file",
          upstreamId: "file-1",
          contentSource: "invalid" as never,
        },
        {},
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    const output = createPresalesFileRetentionExecutor({
      contentSource: "assistant_output",
    });
    await expect(
      recordPresalesUpstreamResource(
        {
          apiCredentialId: "credential-1",
          kind: "file",
          upstreamId: "file-1",
          contentSource: "user_upload",
        },
        output,
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    const unclassified = createPresalesFileRetentionExecutor();
    const stillUnknown = await recordPresalesUpstreamResource(
      {
        apiCredentialId: "credential-1",
        kind: "file",
        upstreamId: "file-1",
        contentSource: "assistant_output",
      },
      unclassified,
    );
    expect(stillUnknown.contentSource).toBeNull();
  });

  it("upgrades only an explicitly verified lifecycle-free historical file bound to the exact task", async () => {
    const historical = createPresalesFileRetentionExecutor({
      parentTaskId: "task-assessment",
      contentSource: null,
    });

    const upgraded = await recordPresalesUpstreamResource(
      {
        apiCredentialId: "credential-1",
        kind: "file",
        upstreamId: "file-1",
        parentTaskId: "task-assessment",
        contentSource: "assistant_output",
        verifiedAssistantOutput: true,
      },
      historical,
    );

    expect(upgraded).toMatchObject({
      parentTaskId: "task-assessment",
      contentSource: "assistant_output",
      uploadReservedAt: null,
      uploadedAt: null,
      contentExpiresAt: null,
      contentDeletedAt: null,
    });
  });

  it.each([
    {
      name: "an unbound historical file",
      existingParentTaskId: null,
      requestedParentTaskId: "task-assessment",
      verifiedAssistantOutput: true,
      lifecycle: {},
      rejects: false,
    },
    {
      name: "a historical file observed without a current parent task",
      existingParentTaskId: "task-assessment",
      requestedParentTaskId: null,
      verifiedAssistantOutput: true,
      lifecycle: {},
      rejects: false,
    },
    {
      name: "a file bound to a different task",
      existingParentTaskId: "task-other",
      requestedParentTaskId: "task-assessment",
      verifiedAssistantOutput: true,
      lifecycle: {},
      rejects: true,
    },
    {
      name: "a matching file without explicit verification",
      existingParentTaskId: "task-assessment",
      requestedParentTaskId: "task-assessment",
      verifiedAssistantOutput: undefined,
      lifecycle: {},
      rejects: false,
    },
    {
      name: "a matching file with an upload reservation",
      existingParentTaskId: "task-assessment",
      requestedParentTaskId: "task-assessment",
      verifiedAssistantOutput: true,
      lifecycle: {
        uploadReservedAt: new Date("2026-08-04T08:00:00.000Z"),
      },
      rejects: false,
    },
    {
      name: "a matching uploaded file",
      existingParentTaskId: "task-assessment",
      requestedParentTaskId: "task-assessment",
      verifiedAssistantOutput: true,
      lifecycle: {
        uploadReservedAt: new Date("2026-08-04T08:00:00.000Z"),
        uploadedAt: new Date("2026-08-04T08:00:00.000Z"),
        contentExpiresAt: new Date("2026-09-03T08:00:00.000Z"),
      },
      rejects: false,
    },
    {
      name: "a matching deleted file",
      existingParentTaskId: "task-assessment",
      requestedParentTaskId: "task-assessment",
      verifiedAssistantOutput: true,
      lifecycle: {
        contentDeletedAt: new Date("2026-08-04T08:00:00.000Z"),
      },
      rejects: false,
    },
  ])(
    "does not upgrade $name",
    async ({
      existingParentTaskId,
      requestedParentTaskId,
      verifiedAssistantOutput,
      lifecycle,
      rejects,
    }) => {
      const historical = createPresalesFileRetentionExecutor({
        parentTaskId: existingParentTaskId,
        contentSource: null,
        ...lifecycle,
      });
      const operation = recordPresalesUpstreamResource(
        {
          apiCredentialId: "credential-1",
          kind: "file",
          upstreamId: "file-1",
          parentTaskId: requestedParentTaskId,
          contentSource: "assistant_output",
          ...(verifiedAssistantOutput === undefined
            ? {}
            : { verifiedAssistantOutput }),
        },
        historical,
      );

      if (rejects) {
        await expect(operation).rejects.toMatchObject({ code: "CONFLICT" });
      } else {
        await operation;
      }
      expect(historical.resource.contentSource).toBeNull();
      expect(historical.resource.parentTaskId).toBe(existingParentTaskId);
    },
  );
});

function createIdempotencyExecutor(options?: {
  duplicateError?: () => unknown;
}) {
  let request: any = null;
  let beforeTransaction: (() => void) | undefined;
  const resources: any[] = [];
  const lifecycle: { status: "active" | "deleting" | "deleted" } = {
    status: "active",
  };
  const lockOrder: string[] = [];

  const result = (values: any[], lockLabel?: string) => {
    const promise = Promise.resolve(values);
    const query: any = {
      for: async () => {
        if (lockLabel) lockOrder.push(lockLabel);
        return values;
      },
      then: promise.then.bind(promise),
    };
    query.limit = () => query;
    return query;
  };

  const insert = (table: unknown) => ({
    values: (value: any) => {
      if (table === websiteProjectDeletionTombstones) {
        return { onDuplicateKeyUpdate: async () => undefined };
      }
      if (table === presalesTaskRequests) {
        if (request) {
          throw (
            options?.duplicateError?.() ??
            Object.assign(new Error("duplicate"), { code: "ER_DUP_ENTRY" })
          );
        }
        request = { ...value };
        return Promise.resolve();
      }
      if (table === presalesUpstreamResources) {
        resources.push({ ...value });
      }
      return Promise.resolve();
    },
  });
  const transaction = {
    select: () => ({
      from: (table: unknown) => ({
        where: () =>
          result(
            table === websiteProjectDeletionTombstones
              ? [lifecycle]
              : table === presalesTaskRequests
                ? request
                  ? [request]
                  : []
                : table === presalesMonitorRuns
                  ? []
                  : resources.slice(0, 1),
            table === websiteProjectDeletionTombstones
              ? "lifecycle"
              : table === presalesTaskRequests
                ? "task_request"
                : undefined,
          ),
      }),
    }),
    insert,
    update: (table: unknown) => ({
      set: (value: any) => ({
        where: async () => {
          if (table === presalesTaskRequests && request) {
            request = { ...request, ...value };
          }
          if (table === presalesUpstreamResources && resources[0]) {
            resources[0] = { ...resources[0], ...value };
          }
          if (table === websiteProjectDeletionTombstones) {
            Object.assign(lifecycle, value);
          }
        },
      }),
    }),
    delete: (table: unknown) => ({
      where: async () => {
        if (table === presalesTaskRequests) request = null;
        if (table === presalesUpstreamResources) resources.splice(0);
      },
    }),
  };

  return {
    insert,
    select: transaction.select,
    transaction: async (run: (tx: typeof transaction) => Promise<unknown>) => {
      const hook = beforeTransaction;
      beforeTransaction = undefined;
      hook?.();
      return run(transaction);
    },
    get request() {
      return request;
    },
    lifecycle,
    lockOrder,
    setLifecycle(status: typeof lifecycle.status) {
      lifecycle.status = status;
    },
    beforeNextTransaction(operation: () => void) {
      beforeTransaction = operation;
    },
    replaceRequestProjectId(projectId: string | null) {
      request = request ? { ...request, projectId } : request;
    },
    resources,
  };
}

describe("presales task evidence deletion", () => {
  it("physically deletes task requests, ownership and generated evidence mappings in one transaction", async () => {
    const deletedTables: unknown[] = [];
    const transaction = {
      select: (selection: Record<string, unknown>) => ({
        from: (_table: unknown) => ({
          where: () => {
            const rows =
              "fileId" in selection
                ? [{ fileId: "file-output-1" }]
                : [{ id: "task-resource-1" }];
            const promise = Promise.resolve(rows);
            return {
              limit: () => ({ for: async () => rows }),
              then: promise.then.bind(promise),
            };
          },
        }),
      }),
      delete: (table: unknown) => ({
        where: async () => {
          deletedTables.push(table);
        },
      }),
    };
    const executor = {
      transaction: vi.fn(
        async (run: (tx: typeof transaction) => Promise<unknown>) =>
          run(transaction),
      ),
    };

    await expect(
      deletePresalesTaskEvidence(
        { taskId: "task-1", apiCredentialId: "credential-1" },
        executor,
      ),
    ).resolves.toEqual({ deleted: true, fileIds: ["file-output-1"] });
    expect(deletedTables).toEqual([
      presalesOutputUrls,
      presalesTaskRequests,
      presalesUpstreamResources,
      presalesUpstreamResources,
    ]);
    expect(executor.transaction).toHaveBeenCalledOnce();
  });
});

describe("presales task idempotency", () => {
  const input = {
    idempotencyKey: "project-123:knowledge-base:create",
    requestHash: hashPresalesTaskPayload({
      prompt: "build",
      attachments: [],
      agentProfile: "manus-1.6",
      taskMode: "agent",
    }),
    apiCredentialId: "credential-1",
    credentialVersion: 1,
    now: new Date("2026-07-22T00:00:00.000Z"),
    leaseMs: 60_000,
  };

  it("uses a canonical payload hash while preserving array order", () => {
    expect(hashPresalesTaskPayload({ b: 2, a: 1 })).toBe(
      hashPresalesTaskPayload({ a: 1, b: 2 }),
    );
    expect(hashPresalesTaskPayload({ attachments: ["a", "b"] })).not.toBe(
      hashPresalesTaskPayload({ attachments: ["b", "a"] }),
    );
  });

  it("recognizes duplicate-key errors wrapped by Drizzle without traversing cycles forever", () => {
    expect(
      isPresalesDuplicateEntryError(
        Object.assign(new Error("Failed query"), {
          cause: Object.assign(new Error("duplicate"), { errno: 1062 }),
        }),
      ),
    ).toBe(true);
    const cycle: { cause?: unknown } = {};
    cycle.cause = cycle;
    expect(isPresalesDuplicateEntryError(cycle)).toBe(false);
  });

  it("rejects a new reservation after the project deletion tombstone is locked", async () => {
    const insert = vi.fn();
    const transaction = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: () => ({
              for: async () => [{ projectId: "project-20260728-0001" }],
            }),
          }),
        }),
      }),
      insert: (table: unknown) => ({
        values: (value: unknown) =>
          table === websiteProjectDeletionTombstones
            ? {
                onDuplicateKeyUpdate: async () => undefined,
              }
            : insert(value),
      }),
    };
    const executor = {
      insert: () => ({ values: vi.fn() }),
      transaction: async (run: (tx: typeof transaction) => Promise<unknown>) =>
        run(transaction),
    };

    await expect(
      acquirePresalesTaskReservation(
        { ...input, projectId: "project-20260728-0001" },
        executor,
      ),
    ).rejects.toMatchObject({
      code: "PROJECT_DELETED",
      message: "项目已进入永久删除流程，不能再创建任务",
    });
    expect(insert).not.toHaveBeenCalled();
  });

  it("creates a project-bound reservation while the durable lifecycle is active", async () => {
    const insertedRequests: unknown[] = [];
    const transaction = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: () => ({
              for: async () => [{ status: "active" }],
            }),
          }),
        }),
      }),
      insert: (table: unknown) => ({
        values: (value: unknown) => {
          if (table === websiteProjectDeletionTombstones) {
            return { onDuplicateKeyUpdate: async () => undefined };
          }
          insertedRequests.push(value);
          return Promise.resolve();
        },
      }),
    };
    const executor = {
      insert: () => ({ values: vi.fn() }),
      transaction: async (run: (tx: typeof transaction) => Promise<unknown>) =>
        run(transaction),
    };

    await expect(
      acquirePresalesTaskReservation(
        { ...input, projectId: "project-20260728-0001" },
        executor,
      ),
    ).resolves.toMatchObject({ state: "acquired" });
    expect(insertedRequests).toHaveLength(1);
    expect(insertedRequests[0]).toMatchObject({
      projectId: "project-20260728-0001",
      status: "pending",
    });
  });

  it("stores only hashes and allows only one concurrent owner", async () => {
    const executor = createIdempotencyExecutor();
    const results = await Promise.allSettled([
      acquirePresalesTaskReservation(input, executor),
      acquirePresalesTaskReservation(input, executor),
    ]);

    const fulfilled = results.filter(
      (result): result is PromiseFulfilledResult<any> =>
        result.status === "fulfilled",
    );
    const rejected = results.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    expect(fulfilled).toHaveLength(1);
    expect(fulfilled[0].value.state).toBe("acquired");
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toMatchObject({ code: "IDEMPOTENCY_PENDING" });
    expect(executor.request.keyHash).toBe(
      hashPresalesIdempotencyKey(input.idempotencyKey),
    );
    expect(JSON.stringify(executor.request)).not.toContain(
      input.idempotencyKey,
    );
  });

  it("returns the original completed upstream task without a new owner", async () => {
    const executor = createIdempotencyExecutor();
    const first = await acquirePresalesTaskReservation(input, executor);
    expect(first.state).toBe("acquired");
    if (first.state !== "acquired") throw new Error("expected reservation");

    await completePresalesTaskReservation(
      {
        reservationId: first.reservationId,
        attemptId: first.attemptId,
        apiCredentialId: input.apiCredentialId,
        upstreamTaskId: "task-original",
      },
      executor,
    );
    const replay = await acquirePresalesTaskReservation(input, executor);
    expect(replay).toEqual({
      state: "completed",
      upstreamTaskId: "task-original",
    });
    expect(executor.resources).toHaveLength(1);
    expect(executor.resources[0]).toMatchObject({
      kind: "task",
      upstreamId: "task-original",
      apiCredentialId: "credential-1",
    });
  });

  it("replays a completed task when Drizzle wraps the duplicate-key error", async () => {
    const executor = createIdempotencyExecutor({
      duplicateError: () =>
        Object.assign(new Error("Failed query"), {
          cause: Object.assign(new Error("duplicate"), {
            code: "ER_DUP_ENTRY",
            errno: 1062,
          }),
        }),
    });
    const first = await acquirePresalesTaskReservation(input, executor);
    if (first.state !== "acquired") throw new Error("expected reservation");
    await completePresalesTaskReservation(
      {
        reservationId: first.reservationId,
        attemptId: first.attemptId,
        apiCredentialId: input.apiCredentialId,
        upstreamTaskId: "task-wrapped-duplicate",
      },
      executor,
    );

    await expect(
      acquirePresalesTaskReservation(input, executor),
    ).resolves.toEqual({
      state: "completed",
      upstreamTaskId: "task-wrapped-duplicate",
    });
  });

  it("rolls back completion when an unbound reservation gains a project before its row lock", async () => {
    const executor = createIdempotencyExecutor();
    const reservation = await acquirePresalesTaskReservation(input, executor);
    if (reservation.state !== "acquired")
      throw new Error("expected reservation");
    executor.beforeNextTransaction(() => {
      executor.replaceRequestProjectId("project-lineage-race");
      executor.setLifecycle("deleted");
    });

    await expect(
      completePresalesTaskReservation(
        {
          reservationId: reservation.reservationId,
          attemptId: reservation.attemptId,
          apiCredentialId: input.apiCredentialId,
          upstreamTaskId: "task-lineage-race",
        },
        executor,
      ),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_PENDING" });
    expect(executor.request).toMatchObject({
      status: "pending",
      upstreamTaskId: null,
    });
    expect(executor.resources).toHaveLength(0);
  });

  it.runIf(WEBSITE_PROJECT_PHYSICAL_DELETE_ENABLED)(
    "keeps a delete-race task ID discoverable through retry and final tombstone completion",
    async () => {
      const executor = createIdempotencyExecutor();
      const projectInput = {
        ...input,
        projectId: "project-20260728-0001",
      };
      const reservation = await acquirePresalesTaskReservation(
        projectInput,
        executor,
      );
      if (reservation.state !== "acquired") {
        throw new Error("expected reservation");
      }
      executor.setLifecycle("deleting");

      await retainPresalesTaskPurgeTarget(
        {
          reservationId: reservation.reservationId,
          attemptId: reservation.attemptId,
          apiCredentialId: projectInput.apiCredentialId,
          upstreamTaskId: "task-cleanup-retry",
        },
        executor,
      );
      expect(executor.lockOrder.slice(-2)).toEqual([
        "lifecycle",
        "task_request",
      ]);
      await expect(
        readPresalesProjectTaskPurgeSnapshot(
          projectInput.projectId,
          executor,
          new Date("2030-01-01T00:00:00.000Z"),
        ),
      ).resolves.toEqual({
        projectId: projectInput.projectId,
        pendingReservations: 0,
        tasks: [
          {
            taskId: "task-cleanup-retry",
            apiCredentialId: projectInput.apiCredentialId,
          },
        ],
      });

      await deletePresalesTaskEvidence(
        {
          taskId: "task-cleanup-retry",
          apiCredentialId: projectInput.apiCredentialId,
          deletedFileIds: [],
        },
        executor,
      );
      expect(executor.request).toBeNull();
      await expect(
        completePresalesProjectTaskPurge(projectInput.projectId, executor),
      ).resolves.toMatchObject({ completed: true });
      expect(executor.lifecycle.status).toBe("deleted");
    },
  );

  it.runIf(!WEBSITE_PROJECT_PHYSICAL_DELETE_ENABLED)(
    "retains a late provider id only behind a pre-existing D1 deletion fence after rollback",
    async () => {
      const executor = createIdempotencyExecutor();
      const projectInput = { ...input, projectId: "project-d0-rollback" };
      const reservation = await acquirePresalesTaskReservation(
        projectInput,
        executor,
      );
      if (reservation.state !== "acquired") {
        throw new Error("expected reservation");
      }

      await expect(
        retainPresalesTaskPurgeTarget(
          {
            reservationId: reservation.reservationId,
            attemptId: reservation.attemptId,
            apiCredentialId: projectInput.apiCredentialId,
            upstreamTaskId: "task-active-project",
          },
          executor,
        ),
      ).rejects.toMatchObject({ code: "CONFLICT" });

      executor.setLifecycle("deleting");
      await retainPresalesTaskPurgeTarget(
        {
          reservationId: reservation.reservationId,
          attemptId: reservation.attemptId,
          apiCredentialId: projectInput.apiCredentialId,
          upstreamTaskId: "task-d0-rollback",
        },
        executor,
      );
      expect(executor.lifecycle.status).toBe("deleting");
      expect(executor.request).toMatchObject({
        status: "completed",
        upstreamTaskId: "task-d0-rollback",
      });
    },
  );

  it("upgrades an in-flight legacy reservation and task resource to the project binding", async () => {
    const executor = createIdempotencyExecutor();
    const first = await acquirePresalesTaskReservation(input, executor);
    if (first.state !== "acquired") throw new Error("expected reservation");
    await completePresalesTaskReservation(
      {
        reservationId: first.reservationId,
        attemptId: first.attemptId,
        apiCredentialId: input.apiCredentialId,
        upstreamTaskId: "task-legacy",
      },
      executor,
    );

    await expect(
      acquirePresalesTaskReservation(
        {
          ...input,
          projectId: "project-20260728-0001",
          requestHash: hashPresalesTaskPayload({
            projectId: "project-20260728-0001",
            task: { prompt: "build" },
          }),
          compatibleRequestHashes: [input.requestHash],
        },
        executor,
      ),
    ).resolves.toMatchObject({
      state: "completed",
      upstreamTaskId: "task-legacy",
    });
    expect(executor.request.projectId).toBe("project-20260728-0001");
    expect(executor.resources[0].projectId).toBe("project-20260728-0001");
  });

  it("rejects reuse with another payload or credential version", async () => {
    const executor = createIdempotencyExecutor();
    await acquirePresalesTaskReservation(input, executor);

    await expect(
      acquirePresalesTaskReservation(
        { ...input, requestHash: "f".repeat(64) },
        executor,
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(
      acquirePresalesTaskReservation(
        {
          ...input,
          apiCredentialId: "credential-2",
          credentialVersion: 2,
        },
        executor,
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("releases failed attempts and permits a safe retry", async () => {
    const executor = createIdempotencyExecutor();
    const first = await acquirePresalesTaskReservation(input, executor);
    if (first.state !== "acquired") throw new Error("expected reservation");
    await releasePresalesTaskReservation(first, executor);
    expect(executor.request).toBeNull();

    const retry = await acquirePresalesTaskReservation(input, executor);
    expect(retry.state).toBe("acquired");
    if (retry.state === "acquired") {
      expect(retry.attemptId).not.toBe(first.attemptId);
    }
  });

  it("allows one new owner to take over an expired lease", async () => {
    const executor = createIdempotencyExecutor();
    const first = await acquirePresalesTaskReservation(input, executor);
    const retry = await acquirePresalesTaskReservation(
      { ...input, now: new Date("2026-07-22T00:02:00.000Z") },
      executor,
    );
    expect(first.state).toBe("acquired");
    expect(retry.state).toBe("acquired");
    if (first.state === "acquired" && retry.state === "acquired") {
      expect(retry.reservationId).toBe(first.reservationId);
      expect(retry.attemptId).not.toBe(first.attemptId);
    }
  });
});

describe("presales migrations", () => {
  it("keeps every MySQL constraint identifier within 64 characters", () => {
    for (const migration of [
      "0003_natural_legion.sql",
      "0004_light_tag.sql",
      "0005_dry_invaders.sql",
    ]) {
      const sql = readFileSync(
        resolve(process.cwd(), "drizzle", migration),
        "utf8",
      );
      const names = [...sql.matchAll(/(?:CONSTRAINT|INDEX) `([^`]+)`/g)].map(
        (match) => match[1],
      );
      expect(names.length).toBeGreaterThan(0);
      for (const name of names) expect(name.length).toBeLessThanOrEqual(64);
    }
    const idempotencySql = readFileSync(
      resolve(process.cwd(), "drizzle", "0005_dry_invaders.sql"),
      "utf8",
    );
    expect(idempotencySql).toContain(
      "CONSTRAINT `presales_task_requests_key_uq` UNIQUE(`keyHash`)",
    );
    const retentionSql = readFileSync(
      resolve(process.cwd(), "drizzle", "0054_file_content_retention.sql"),
      "utf8",
    );
    expect(retentionSql).toContain(
      "ALTER TABLE `presales_upstream_resources` ADD `contentSource` enum('user_upload','assistant_output')",
    );
    for (const column of [
      "uploadReservedAt",
      "uploadedAt",
      "contentExpiresAt",
      "contentDeletedAt",
    ]) {
      expect(retentionSql).toContain(
        `ALTER TABLE \`presales_upstream_resources\` ADD \`${column}\` timestamp`,
      );
    }
    expect(retentionSql).toContain(
      "CREATE INDEX `presales_upstream_resources_content_expiry_idx` ON `presales_upstream_resources` (`kind`,`contentSource`,`uploadReservedAt`,`contentExpiresAt`,`contentDeletedAt`,`id`)",
    );
  });
});
