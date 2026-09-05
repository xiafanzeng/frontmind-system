import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  agentOperations,
  apiCredentials,
  apiKeyOwnership,
  attachments,
  conversationTurns,
  deliveryRedirectPreviews,
  deliveryTicketAttachments,
  deliveryTickets,
  knowledgeBaseBuilds,
  knowledgeBaseResetRequests,
  providerFileLeases,
  upstreamResources,
  users,
  visualCandidatePools,
  websiteStyleSampleBatches,
  websiteStyleSamples,
} from "../drizzle/schema";
import {
  AuthServiceError,
  assertAdminHasNoHistoricalCredentialResources,
  assertAdminHasNoUsageOwnedUsers,
  credentialsUseSameUpstreamApiKey,
  discardUnboundUpstreamFileInTransaction,
  deleteActiveApiCredentialInTransaction,
  deleteManagedUser,
  decryptApiKey,
  encryptApiKey,
  getDecryptedCredentialForManagedUploadIntent,
  getDecryptedCredentialForKnowledgeBaseReservation,
  getApiKeyFingerprint,
  hashPassword,
  hashSessionToken,
  normalizeUsername,
  permanentlyDeleteManagedUserRows,
  verifyPassword,
} from "./auth-service";
import {
  decryptPresalesApiKey,
  encryptPresalesApiKey,
} from "./presales-service";

const originalMasterKey = process.env.FRONTMIND_CREDENTIAL_ENCRYPTION_KEY;

function mockLockedRows<T>(rows: T[]) {
  return {
    for: vi.fn().mockResolvedValue(rows),
    then<TResult1 = T[], TResult2 = never>(
      resolve?: ((value: T[]) => TResult1 | PromiseLike<TResult1>) | null,
      reject?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
    ) {
      return Promise.resolve(rows).then(resolve, reject);
    },
  };
}

function credentialFenceToken(userId: number, credentialId: string) {
  return {
    scope: { kind: "credential" as const, userId, credentialId },
    nonce: "test-fence-token",
  };
}

describe("password authentication primitives", () => {
  it("normalizes usernames consistently", () => {
    expect(normalizeUsername("  Internal.User  ")).toBe("internal.user");
    expect(normalizeUsername("ＦＯＯ")).toBe("foo");
  });

  it("hashes passwords with a random salt and verifies in constant-time form", async () => {
    const first = await hashPassword("a sufficiently long password");
    const second = await hashPassword("a sufficiently long password");

    expect(first).not.toBe(second);
    expect(first).not.toContain("a sufficiently long password");
    await expect(
      verifyPassword("a sufficiently long password", first),
    ).resolves.toBe(true);
    await expect(verifyPassword("the wrong password", first)).resolves.toBe(
      false,
    );
    await expect(verifyPassword("anything", "not-a-valid-hash")).resolves.toBe(
      false,
    );
  });

  it("hashes opaque session tokens without retaining their plaintext", () => {
    const token = randomBytes(32).toString("base64url");
    const hash = hashSessionToken(token);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    expect(hash).not.toContain(token);
    expect(hashSessionToken(token)).toBe(hash);
  });
});

describe("managed account deletion", () => {
  it("physically removes restrictive ledgers before deleting the user", async () => {
    const where = vi.fn().mockResolvedValue(undefined);
    const deleteFrom = vi.fn().mockReturnValue({ where });
    const select = vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          for: vi.fn().mockResolvedValue([{ id: "style-batch-1" }]),
        }),
      }),
    });

    await permanentlyDeleteManagedUserRows({ delete: deleteFrom, select }, 42);

    expect(deleteFrom).toHaveBeenCalledTimes(10);
    expect(deleteFrom).toHaveBeenNthCalledWith(1, visualCandidatePools);
    expect(deleteFrom).toHaveBeenNthCalledWith(2, websiteStyleSamples);
    expect(deleteFrom).toHaveBeenNthCalledWith(3, websiteStyleSampleBatches);
    expect(deleteFrom).toHaveBeenNthCalledWith(4, knowledgeBaseResetRequests);
    expect(deleteFrom).toHaveBeenNthCalledWith(5, deliveryRedirectPreviews);
    expect(deleteFrom).toHaveBeenNthCalledWith(6, deliveryTicketAttachments);
    expect(deleteFrom).toHaveBeenNthCalledWith(7, deliveryTickets);
    expect(deleteFrom).toHaveBeenNthCalledWith(8, upstreamResources);
    expect(deleteFrom).toHaveBeenNthCalledWith(9, apiKeyOwnership);
    expect(deleteFrom).toHaveBeenNthCalledWith(10, users);
    expect(where).toHaveBeenCalledTimes(10);
  });

  it("rejects deleting the administrator's current account", async () => {
    await expect(deleteManagedUser(42, 42)).rejects.toMatchObject({
      code: "CONFLICT",
    });
  });

  it.each([
    ["deactivate", "停用管理员"],
    ["delete", "删除管理员"],
  ] as const)(
    "requires usage ownership transfer before attempting to %s a delivery administrator",
    (mutation, actionLabel) => {
      expect(() =>
        assertAdminHasNoUsageOwnedUsers({
          ownedUserCount: 1,
          mutation,
        }),
      ).toThrowError(
        `该管理员仍负责用户，请先转移这些用户的 Key 与积分归属，再${actionLabel}`,
      );
    },
  );

  it("allows administrator lifecycle changes after all usage ownership is transferred", () => {
    expect(() =>
      assertAdminHasNoUsageOwnedUsers({
        ownedUserCount: 0,
        mutation: "deactivate",
      }),
    ).not.toThrow();
  });

  it("preserves customer task history when an old administrator Key is still referenced", () => {
    expect(() => assertAdminHasNoHistoricalCredentialResources(1)).toThrowError(
      "该管理员的历史 Key 仍关联客户任务或文件，不能永久删除；可以停用账号并保留历史成果",
    );
    expect(() =>
      assertAdminHasNoHistoricalCredentialResources(0),
    ).not.toThrow();
  });
});

describe("API credential encryption", () => {
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

  it("round-trips with AES-256-GCM without placing plaintext in stored fields", () => {
    const credentialId = randomUUID();
    const apiKey = "sk-test-this-value-must-never-be-returned";
    const encrypted = encryptApiKey(42, credentialId, apiKey);

    expect(Object.values(encrypted).join(" ")).not.toContain(apiKey);
    expect(
      decryptApiKey({
        id: credentialId,
        userId: 42,
        ...encrypted,
      }),
    ).toBe(apiKey);
  });

  it("binds ciphertext to its user and credential id through authenticated data", () => {
    const credentialId = randomUUID();
    const encrypted = encryptApiKey(42, credentialId, "sk-test-secret");

    expect(() =>
      decryptApiKey({ id: credentialId, userId: 43, ...encrypted }),
    ).toThrowError(AuthServiceError);
    expect(() =>
      decryptApiKey({ id: randomUUID(), userId: 42, ...encrypted }),
    ).toThrowError(AuthServiceError);
  });

  it("exposes only a stable one-way fingerprint", () => {
    const apiKey = "sk-test-secret-material";
    const fingerprint = getApiKeyFingerprint(apiKey);
    expect(fingerprint).toMatch(/^fp_[a-f0-9]{16}$/);
    expect(fingerprint).not.toContain(apiKey.slice(0, 4));
    expect(getApiKeyFingerprint(apiKey)).toBe(fingerprint);
    expect(getApiKeyFingerprint(`${apiKey}x`)).not.toBe(fingerprint);
  });

  it("recognizes the same upstream key across separate account credentials", () => {
    const apiKey = "sk-shared-across-frontmind-accounts";
    const fingerprint = getApiKeyFingerprint(apiKey);
    const firstId = randomUUID();
    const secondId = randomUUID();
    const firstEncrypted = encryptApiKey(11, firstId, apiKey);
    const secondEncrypted = encryptApiKey(12, secondId, apiKey);
    expect(firstEncrypted.encryptedKey).not.toBe(secondEncrypted.encryptedKey);
    const firstDecrypted = decryptApiKey({
      id: firstId,
      userId: 11,
      ...firstEncrypted,
    });
    const secondDecrypted = decryptApiKey({
      id: secondId,
      userId: 12,
      ...secondEncrypted,
    });

    expect(
      credentialsUseSameUpstreamApiKey(
        { apiKey: firstDecrypted, fingerprint },
        { apiKey: secondDecrypted, fingerprint },
      ),
    ).toBe(true);
    expect(
      credentialsUseSameUpstreamApiKey(
        { apiKey, fingerprint },
        { apiKey: `${apiKey}-different`, fingerprint },
      ),
    ).toBe(false);
    expect(
      credentialsUseSameUpstreamApiKey(
        { apiKey, fingerprint },
        {
          apiKey: `${apiKey}-different`,
          fingerprint: getApiKeyFingerprint(`${apiKey}-different`),
        },
      ),
    ).toBe(false);
  });

  it("uses a locked historical KB reservation as the only authority after owner A is replaced by B", async () => {
    const credentialId = randomUUID();
    const turnId = randomUUID();
    const buildId = randomUUID();
    const apiKey = "sk-historical-owner-a-reservation";
    const encrypted = encryptApiKey(7, credentialId, apiKey);
    const credential = {
      id: credentialId,
      userId: 7,
      version: 3,
      ...encrypted,
      fingerprint: getApiKeyFingerprint(apiKey),
      status: "retired",
      validationStatus: "verified",
      verifiedAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
      retiredAt: new Date(),
      deletedAt: null,
    };
    const build = {
      id: buildId,
      userId: 42,
      generation: 2,
      activeTurnId: turnId,
      status: "researching",
    };
    const turn = {
      id: turnId,
      userId: 42,
      buildId,
      buildGeneration: 2,
      apiCredentialId: credentialId,
      status: "running",
    };
    const lockOrder: string[] = [];
    const executor = {
      transaction: async (run: (tx: any) => Promise<unknown>) =>
        run({
          select: () => ({
            from: (table: unknown) => ({
              where: () => ({
                limit: () => ({
                  for: async () => {
                    if (table === apiCredentials) {
                      lockOrder.push("credential");
                      return [credential];
                    }
                    if (table === knowledgeBaseBuilds) {
                      lockOrder.push("build");
                      return [build];
                    }
                    if (table === conversationTurns) {
                      lockOrder.push("turn");
                      return [turn];
                    }
                    return [];
                  },
                }),
              }),
            }),
          }),
        }),
    };

    await expect(
      getDecryptedCredentialForKnowledgeBaseReservation(
        {
          userId: 42,
          turnId,
          buildId,
          buildGeneration: 2,
          apiCredentialId: credentialId,
        },
        executor,
      ),
    ).resolves.toMatchObject({ id: credentialId, userId: 7, apiKey });
    expect(lockOrder).toEqual(["credential", "build", "turn"]);

    build.activeTurnId = randomUUID();
    await expect(
      getDecryptedCredentialForKnowledgeBaseReservation(
        {
          userId: 42,
          turnId,
          buildId,
          buildGeneration: 2,
          apiCredentialId: credentialId,
        },
        executor,
      ),
    ).resolves.toBeNull();
    build.activeTurnId = turnId;
    credential.status = "deleted";
    await expect(
      getDecryptedCredentialForKnowledgeBaseReservation(
        {
          userId: 42,
          turnId,
          buildId,
          buildGeneration: 2,
          apiCredentialId: credentialId,
        },
        executor,
      ),
    ).resolves.toBeNull();
  });

  it("resolves a frozen managed-upload credential after the account usage owner changes", async () => {
    const credentialId = randomUUID();
    const apiKey = "sk-frozen-managed-upload-owner-a";
    const encrypted = encryptApiKey(7, credentialId, apiKey);
    const credential = {
      id: credentialId,
      userId: 7,
      version: 3,
      ...encrypted,
      fingerprint: getApiKeyFingerprint(apiKey),
      status: "retired",
      validationStatus: "verified",
      verifiedAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
      retiredAt: new Date(),
      deletedAt: null,
    };
    const select = vi.fn(() => ({
      from: () => ({
        where: () => ({
          limit: async () => [credential],
        }),
      }),
    }));
    const executor = { select };

    await expect(
      getDecryptedCredentialForManagedUploadIntent(
        {
          credentialId,
          credentialOwnerUserId: 7,
          credentialVersion: 3,
        },
        executor,
      ),
    ).resolves.toMatchObject({
      id: credentialId,
      userId: 7,
      version: 3,
      apiKey,
      status: "retired",
    });
    expect(select).toHaveBeenCalledTimes(1);

    credential.userId = 8;
    await expect(
      getDecryptedCredentialForManagedUploadIntent(
        {
          credentialId,
          credentialOwnerUserId: 7,
          credentialVersion: 3,
        },
        executor,
      ),
    ).resolves.toBeNull();
  });

  it("allows an account credential to independently store the website's raw Key", () => {
    const apiKey = "sk-shared-between-account-and-website";
    const accountCredentialId = randomUUID();
    const websiteCredentialId = randomUUID();
    const accountEncrypted = encryptApiKey(42, accountCredentialId, apiKey);
    const websiteEncrypted = encryptPresalesApiKey(websiteCredentialId, apiKey);

    expect(accountEncrypted.encryptedKey).not.toBe(
      websiteEncrypted.encryptedKey,
    );
    expect(
      decryptApiKey({
        id: accountCredentialId,
        userId: 42,
        ...accountEncrypted,
      }),
    ).toBe(apiKey);
    expect(
      decryptPresalesApiKey({
        id: websiteCredentialId,
        ...websiteEncrypted,
      }),
    ).toBe(apiKey);
  });

  it("adds a monotonically versioned tombstone when a Key is revoked", async () => {
    const active = {
      id: randomUUID(),
      userId: 42,
      version: 3,
      status: "active",
      encryptedKey: "encrypted",
      agentProfile: null,
    };
    const inserted: Array<Record<string, unknown>> = [];
    const executor = {
      select: vi.fn(() => ({
        from: vi.fn((table) => {
          if (table === conversationTurns) {
            return {
              innerJoin: vi.fn(() => ({
                where: vi.fn(() => ({
                  limit: vi.fn(() => ({
                    for: vi.fn().mockResolvedValue([]),
                  })),
                })),
              })),
              where: vi.fn(() => mockLockedRows([])),
            };
          }
          if (table === upstreamResources) {
            return { where: vi.fn(() => mockLockedRows([])) };
          }
          if (table === agentOperations || table === providerFileLeases) {
            return {
              where: vi.fn(() => ({
                limit: vi.fn(() => ({
                  for: vi.fn().mockResolvedValue([]),
                })),
              })),
            };
          }
          if (table === knowledgeBaseBuilds) {
            return {
              where: vi.fn(() => ({
                for: vi.fn().mockResolvedValue([]),
              })),
            };
          }
          expect(table).toBe(apiCredentials);
          return {
            where: vi.fn(() => ({
              orderBy: vi.fn(() => ({
                limit: vi.fn(() => ({
                  for: vi.fn().mockResolvedValue([active]),
                })),
              })),
            })),
          };
        }),
      })),
      update: vi.fn((table) => {
        expect(table).toBe(apiCredentials);
        return {
          set: vi.fn((values) => ({
            where: vi.fn(async () => Object.assign(active, values)),
          })),
        };
      }),
      insert: vi.fn((table) => {
        expect(table).toBe(apiCredentials);
        return {
          values: vi.fn(async (values) => {
            inserted.push(values);
          }),
        };
      }),
    };

    await expect(
      deleteActiveApiCredentialInTransaction({
        executor,
        userId: 42,
        fenceToken: credentialFenceToken(42, active.id),
        now: new Date("2026-07-30T12:00:00.000Z"),
      }),
    ).resolves.toEqual({ version: 4, deleted: true });
    expect(active.status).toBe("deleted");
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({
      userId: 42,
      version: 4,
      agentProfile: null,
      status: "deleted",
      validationStatus: "unverified",
    });
    expect(JSON.stringify(inserted[0])).not.toContain("sk-");
  });

  it("blocks credential revocation while an authoritative knowledge-base turn is recoverable", async () => {
    const active = {
      id: randomUUID(),
      userId: 42,
      version: 3,
      status: "active",
      encryptedKey: "encrypted",
    };
    const update = vi.fn();
    const insert = vi.fn();
    const executor = {
      select: vi.fn(() => ({
        from: vi.fn((table) => {
          if (table === apiCredentials) {
            return {
              where: vi.fn(() => ({
                orderBy: vi.fn(() => ({
                  limit: vi.fn(() => ({
                    for: vi.fn().mockResolvedValue([active]),
                  })),
                })),
              })),
            };
          }
          expect(table).toBe(conversationTurns);
          return {
            innerJoin: vi.fn(() => ({
              where: vi.fn(() => ({
                limit: vi.fn(() => ({
                  for: vi.fn().mockResolvedValue([{ turnId: "turn-1" }]),
                })),
              })),
            })),
          };
        }),
      })),
      update,
      insert,
    };

    await expect(
      deleteActiveApiCredentialInTransaction({
        executor,
        userId: 42,
        fenceToken: credentialFenceToken(42, active.id),
        now: new Date("2026-07-30T12:00:00.000Z"),
      }),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      message: expect.stringContaining("知识库轮次"),
    });
    expect(update).not.toHaveBeenCalled();
    expect(insert).not.toHaveBeenCalled();
  });

  it("blocks credential revocation while a v2 operation is non-terminal", async () => {
    const active = {
      id: randomUUID(),
      userId: 42,
      version: 3,
      status: "active",
      encryptedKey: "still-decryptable",
    };
    const update = vi.fn();
    const insert = vi.fn();
    const executor = {
      select: vi.fn(() => ({
        from: vi.fn((table) => {
          if (table === apiCredentials) {
            return {
              where: vi.fn(() => ({
                orderBy: vi.fn(() => ({
                  limit: vi.fn(() => ({
                    for: vi.fn().mockResolvedValue([active]),
                  })),
                })),
              })),
            };
          }
          if (table === conversationTurns) {
            return {
              innerJoin: vi.fn(() => ({
                where: vi.fn(() => ({
                  limit: vi.fn(() => ({
                    for: vi.fn().mockResolvedValue([]),
                  })),
                })),
              })),
            };
          }
          if (table === upstreamResources) {
            return { where: vi.fn(() => mockLockedRows([])) };
          }
          if (table === agentOperations) {
            return {
              where: vi.fn(() => ({
                limit: vi.fn(() => ({
                  for: vi.fn().mockResolvedValue([{ id: "operation-live" }]),
                })),
              })),
            };
          }
          if (table === providerFileLeases) {
            return {
              where: vi.fn(() => ({
                limit: vi.fn(() => ({
                  for: vi.fn().mockResolvedValue([]),
                })),
              })),
            };
          }
          throw new Error("unexpected table in v2 revocation test");
        }),
      })),
      update,
      insert,
    };

    await expect(
      deleteActiveApiCredentialInTransaction({
        executor,
        userId: 42,
        fenceToken: credentialFenceToken(42, active.id),
      }),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      message: expect.stringContaining("v2 任务或文件上传"),
    });
    expect(active.encryptedKey).toBe("still-decryptable");
    expect(update).not.toHaveBeenCalled();
    expect(insert).not.toHaveBeenCalled();
  });

  it("blocks credential revocation while a v2 provider upload outcome is unresolved", async () => {
    const active = {
      id: randomUUID(),
      userId: 42,
      version: 3,
      status: "active",
      encryptedKey: "still-decryptable",
    };
    const update = vi.fn();
    const insert = vi.fn();
    const executor = {
      select: vi.fn(() => ({
        from: vi.fn((table) => {
          if (table === apiCredentials) {
            return {
              where: vi.fn(() => ({
                orderBy: vi.fn(() => ({
                  limit: vi.fn(() => ({
                    for: vi.fn().mockResolvedValue([active]),
                  })),
                })),
              })),
            };
          }
          if (table === conversationTurns) {
            return {
              innerJoin: vi.fn(() => ({
                where: vi.fn(() => ({
                  limit: vi.fn(() => ({
                    for: vi.fn().mockResolvedValue([]),
                  })),
                })),
              })),
            };
          }
          if (table === upstreamResources) {
            return { where: vi.fn(() => mockLockedRows([])) };
          }
          if (table === agentOperations) {
            return {
              where: vi.fn(() => ({
                limit: vi.fn(() => ({
                  for: vi.fn().mockResolvedValue([]),
                })),
              })),
            };
          }
          if (table === providerFileLeases) {
            return {
              where: vi.fn(() => ({
                limit: vi.fn(() => ({
                  for: vi.fn().mockResolvedValue([{ id: "lease-unknown" }]),
                })),
              })),
            };
          }
          throw new Error("unexpected table in v2 lease revocation test");
        }),
      })),
      update,
      insert,
    };

    await expect(
      deleteActiveApiCredentialInTransaction({
        executor,
        userId: 42,
        fenceToken: credentialFenceToken(42, active.id),
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(active.encryptedKey).toBe("still-decryptable");
    expect(update).not.toHaveBeenCalled();
    expect(insert).not.toHaveBeenCalled();
  });

  it("preserves a Key while any upstream task or file still depends on it", async () => {
    const active = {
      id: randomUUID(),
      userId: 42,
      version: 3,
      status: "active",
      encryptedKey: "still-decryptable",
    };
    const build = {
      id: "build-historical",
      userId: 84,
      generation: 1,
      status: "protocol_error",
      protocolErrorCode: "PACKAGE_REBIND_REQUIRED",
      skillVersion: "4",
      upstreamTaskId: "task-historical",
      packageTaskId: "task-historical",
      packageFileId: "file-historical-zip",
      packageStorageKey: null,
      packageArchiveSha256: null,
      packageSizeBytes: null,
      logoStorageKey: null,
      logoSha256: null,
      logoBytes: null,
    };
    const update = vi.fn();
    const insert = vi.fn();
    const executor = {
      select: vi.fn(() => ({
        from: vi.fn((table) => {
          if (table === apiCredentials) {
            return {
              where: vi.fn(() => ({
                orderBy: vi.fn(() => ({
                  limit: vi.fn(() => ({
                    for: vi.fn().mockResolvedValue([active]),
                  })),
                })),
              })),
            };
          }
          if (table === knowledgeBaseBuilds) {
            return {
              where: vi.fn(() => ({
                for: vi.fn().mockResolvedValue([build]),
              })),
            };
          }
          if (table === upstreamResources) {
            return {
              where: vi.fn(() =>
                mockLockedRows([
                  { kind: "task", upstreamId: "task-historical" },
                ]),
              ),
            };
          }
          expect(table).toBe(conversationTurns);
          return {
            innerJoin: vi.fn(() => ({
              where: vi.fn(() => ({
                limit: vi.fn(() => ({
                  for: vi.fn().mockResolvedValue([]),
                })),
              })),
            })),
            where: vi.fn(() =>
              mockLockedRows([
                {
                  buildId: build.id,
                  buildGeneration: build.generation,
                  upstreamTaskId: build.upstreamTaskId,
                },
              ]),
            ),
          };
        }),
      })),
      update,
      insert,
    };

    await expect(
      deleteActiveApiCredentialInTransaction({
        executor,
        userId: 42,
        fenceToken: credentialFenceToken(42, active.id),
        now: new Date("2026-08-02T00:00:00.000Z"),
      }),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      message: expect.stringContaining("仍绑定已有任务或文件"),
    });
    expect(active.encryptedKey).toBe("still-decryptable");
    expect(update).not.toHaveBeenCalled();
    expect(insert).not.toHaveBeenCalled();
  });

  it("allows cryptoshredding after authoritative ZIP and Logo rebind has completed", async () => {
    const active = {
      id: randomUUID(),
      userId: 42,
      version: 3,
      status: "active",
      encryptedKey: "still-decryptable",
    };
    const inserted: Array<Record<string, unknown>> = [];
    const executor = {
      select: vi.fn(() => ({
        from: vi.fn((table) => {
          if (table === apiCredentials) {
            return {
              where: vi.fn(() => ({
                orderBy: vi.fn(() => ({
                  limit: vi.fn(() => ({
                    for: vi.fn().mockResolvedValue([active]),
                  })),
                })),
              })),
            };
          }
          if (table === knowledgeBaseBuilds) {
            return {
              where: vi.fn(() => ({
                for: vi.fn().mockResolvedValue([
                  {
                    id: "build-historical",
                    generation: 1,
                    status: "ready_to_publish",
                    protocolErrorCode: null,
                    skillVersion: "4",
                    upstreamTaskId: "task-historical",
                    packageTaskId: "task-historical",
                    packageFileId: "file-historical-zip",
                    packageStorageKey: "builds/42/package.zip",
                    packageArchiveSha256: "a".repeat(64),
                    packageSizeBytes: 4096,
                    logoStorageKey: "builds/42/logo.bin",
                    logoSha256: "b".repeat(64),
                    logoBytes: 512,
                  },
                ]),
              })),
            };
          }
          if (table === upstreamResources) {
            return { where: vi.fn(() => mockLockedRows([])) };
          }
          if (table === agentOperations || table === providerFileLeases) {
            return {
              where: vi.fn(() => ({
                limit: vi.fn(() => ({
                  for: vi.fn().mockResolvedValue([]),
                })),
              })),
            };
          }
          expect(table).toBe(conversationTurns);
          return {
            innerJoin: vi.fn(() => ({
              where: vi.fn(() => ({
                limit: vi.fn(() => ({
                  for: vi.fn().mockResolvedValue([]),
                })),
              })),
            })),
            where: vi.fn(() => mockLockedRows([])),
          };
        }),
      })),
      update: vi.fn(() => ({
        set: vi.fn((values) => ({
          where: vi.fn(async () => Object.assign(active, values)),
        })),
      })),
      insert: vi.fn(() => ({
        values: vi.fn(async (values) => inserted.push(values)),
      })),
    };

    await expect(
      deleteActiveApiCredentialInTransaction({
        executor,
        userId: 42,
        fenceToken: credentialFenceToken(42, active.id),
        now: new Date("2026-08-02T00:01:00.000Z"),
      }),
    ).resolves.toEqual({ version: 4, deleted: true });
    expect(active.status).toBe("deleted");
    expect(active.encryptedKey).not.toBe("still-decryptable");
    expect(inserted).toHaveLength(1);
  });

  it("allows deleting an unreferenced active replacement while recovery remains pinned to a retired version", async () => {
    const activeReplacement = {
      id: "credential-active-v4",
      userId: 42,
      version: 4,
      status: "active",
      encryptedKey: "replacement-ciphertext",
    };
    const inserted: Array<Record<string, unknown>> = [];
    const executor = {
      select: vi.fn(() => ({
        from: vi.fn((table) => {
          if (table === apiCredentials) {
            return {
              where: vi.fn(() => ({
                orderBy: vi.fn(() => ({
                  limit: vi.fn(() => ({
                    for: vi.fn().mockResolvedValue([activeReplacement]),
                  })),
                })),
              })),
            };
          }
          if (table === knowledgeBaseBuilds) {
            return {
              where: vi.fn(() => ({
                for: vi.fn().mockResolvedValue([
                  {
                    id: "build-historical",
                    generation: 1,
                    status: "protocol_error",
                    protocolErrorCode: "PACKAGE_REBIND_REQUIRED",
                    skillVersion: "4",
                    upstreamTaskId: "task-retired-key",
                    packageTaskId: "task-retired-key",
                    packageFileId: "file-retired-key",
                    packageStorageKey: null,
                    packageArchiveSha256: null,
                    packageSizeBytes: null,
                    logoStorageKey: null,
                    logoSha256: null,
                    logoBytes: null,
                  },
                ]),
              })),
            };
          }
          if (table === upstreamResources) {
            return {
              where: vi.fn(() =>
                // The task/file rows belong to the retained v3 credential,
                // not the current replacement selected above.
                mockLockedRows([]),
              ),
            };
          }
          if (table === agentOperations || table === providerFileLeases) {
            return {
              where: vi.fn(() => ({
                limit: vi.fn(() => ({
                  for: vi.fn().mockResolvedValue([]),
                })),
              })),
            };
          }
          expect(table).toBe(conversationTurns);
          return {
            innerJoin: vi.fn(() => ({
              where: vi.fn(() => ({
                limit: vi.fn(() => ({
                  for: vi.fn().mockResolvedValue([]),
                })),
              })),
            })),
            where: vi.fn(() => mockLockedRows([])),
          };
        }),
      })),
      update: vi.fn(() => ({
        set: vi.fn((values) => ({
          where: vi.fn(async () => Object.assign(activeReplacement, values)),
        })),
      })),
      insert: vi.fn(() => ({
        values: vi.fn(async (values) => inserted.push(values)),
      })),
    };

    await expect(
      deleteActiveApiCredentialInTransaction({
        executor,
        userId: 42,
        fenceToken: credentialFenceToken(42, activeReplacement.id),
        now: new Date("2026-08-02T00:02:00.000Z"),
      }),
    ).resolves.toEqual({ version: 5, deleted: true });
    expect(activeReplacement.status).toBe("deleted");
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({ version: 5, status: "deleted" });
  });

  it("transactionally discards only an owned unbound file and uses its frozen credential", async () => {
    const credentialId = randomUUID();
    const apiKey = "sk-bound-file-discard";
    const encrypted = encryptApiKey(42, credentialId, apiKey);
    const row = {
      resource: {
        id: randomUUID(),
        userId: 42,
        apiCredentialId: credentialId,
        projectAssignmentId: null,
        kind: "file",
        upstreamId: "file-unbound",
        conversationId: null,
      },
      credential: {
        id: credentialId,
        userId: 42,
        version: 3,
        status: "active",
        ...encrypted,
      },
    };
    const deleteWhere = vi.fn().mockResolvedValue(undefined);
    const executor = {
      select: vi.fn(() => ({
        from: vi.fn((table) => {
          if (table === upstreamResources) {
            return {
              innerJoin: vi.fn(() => ({
                where: vi.fn(() => ({
                  limit: vi.fn(() => ({
                    for: vi.fn().mockResolvedValue([row]),
                  })),
                })),
              })),
            };
          }
          if (table === attachments || table === conversationTurns) {
            return {
              where: vi.fn(() => ({
                limit: vi.fn().mockResolvedValue([]),
              })),
            };
          }
          if (
            table === deliveryTicketAttachments ||
            table === deliveryRedirectPreviews ||
            table === knowledgeBaseBuilds
          ) {
            return {
              where: vi.fn(() => ({
                limit: vi.fn().mockResolvedValue([]),
              })),
            };
          }
          throw new Error("unexpected table");
        }),
      })),
      delete: vi.fn((table) => {
        expect(table).toBe(upstreamResources);
        return { where: deleteWhere };
      }),
    };
    const discard = vi.fn().mockResolvedValue(undefined);

    await expect(
      discardUnboundUpstreamFileInTransaction({
        executor,
        userId: 42,
        fileId: "file-unbound",
        discard,
      }),
    ).resolves.toEqual({ discarded: true });
    expect(discard).toHaveBeenCalledWith({
      fileId: "file-unbound",
      userId: 42,
      projectAssignmentId: null,
      apiCredentialId: credentialId,
      apiKey,
    });
    expect(deleteWhere).toHaveBeenCalledTimes(1);
    expect(executor.select).toHaveBeenCalledTimes(6);
  });

  it.each([
    ["conversation binding", "conversation-1", [], [], []],
    ["live attachment", null, [{ id: "attachment-1" }], [], []],
    ["knowledge turn", null, [], [{ id: "turn-1" }], []],
    ["knowledge package", null, [], [], [{ id: "build-1" }]],
  ])(
    "refuses discard when an owned file has a %s",
    async (
      _label,
      conversationId,
      attachmentRows,
      turnRows,
      knowledgeBuildRows,
    ) => {
      const credentialId = randomUUID();
      const encrypted = encryptApiKey(
        42,
        credentialId,
        "sk-bound-file-reference",
      );
      const row = {
        resource: {
          id: randomUUID(),
          userId: 42,
          apiCredentialId: credentialId,
          projectAssignmentId: null,
          kind: "file",
          upstreamId: "file-referenced",
          conversationId,
        },
        credential: {
          id: credentialId,
          userId: 42,
          version: 1,
          status: "active",
          ...encrypted,
        },
      };
      const executor = {
        select: vi.fn(() => ({
          from: vi.fn((table) => {
            if (table === upstreamResources) {
              return {
                innerJoin: vi.fn(() => ({
                  where: vi.fn(() => ({
                    limit: vi.fn(() => ({
                      for: vi.fn().mockResolvedValue([row]),
                    })),
                  })),
                })),
              };
            }
            if (table === attachments) {
              return {
                where: vi.fn(() => ({
                  limit: vi.fn().mockResolvedValue(attachmentRows),
                })),
              };
            }
            if (table === conversationTurns) {
              return {
                where: vi.fn(() => ({
                  limit: vi.fn().mockResolvedValue(turnRows),
                })),
              };
            }
            if (
              table === deliveryTicketAttachments ||
              table === deliveryRedirectPreviews
            ) {
              return {
                where: vi.fn(() => ({
                  limit: vi.fn().mockResolvedValue([]),
                })),
              };
            }
            if (table === knowledgeBaseBuilds) {
              return {
                where: vi.fn(() => ({
                  limit: vi.fn().mockResolvedValue(knowledgeBuildRows),
                })),
              };
            }
            throw new Error("unexpected table");
          }),
        })),
        delete: vi.fn(),
      };
      const discard = vi.fn();

      await expect(
        discardUnboundUpstreamFileInTransaction({
          executor,
          userId: 42,
          fileId: "file-referenced",
          discard,
        }),
      ).rejects.toMatchObject({ code: "CONFLICT" });
      expect(discard).not.toHaveBeenCalled();
      expect(executor.delete).not.toHaveBeenCalled();
    },
  );

  it("fails closed when the encryption key is missing or malformed", () => {
    delete process.env.FRONTMIND_CREDENTIAL_ENCRYPTION_KEY;
    expect(() => encryptApiKey(1, randomUUID(), "sk-test-secret")).toThrowError(
      AuthServiceError,
    );

    process.env.FRONTMIND_CREDENTIAL_ENCRYPTION_KEY = "too-short";
    expect(() => encryptApiKey(1, randomUUID(), "sk-test-secret")).toThrowError(
      AuthServiceError,
    );
  });
});
