import { randomBytes, randomUUID } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const dependencies = vi.hoisted(() => ({
  getDb: vi.fn(),
  describeDomains: vi.fn(),
  describeDomainInfo: vi.fn(),
}));
vi.mock("../db", () => ({ getDb: dependencies.getDb }));
vi.mock("./aliyun-sdk-constructors", () => ({
  AliyunDnsClient: class {
    describeDomains(request: unknown) {
      return dependencies.describeDomains(request);
    }
    describeDomainInfo(request: unknown) {
      return dependencies.describeDomainInfo(request);
    }
  },
}));

import {
  presalesApiCredentials,
  siteDnsRecords,
  siteOperations,
  siteProjects,
  siteProviderConnections,
  workspaceSiteProfiles,
  type SiteDnsRecord,
} from "../../drizzle/schema";
import { AuthServiceError } from "../auth-service";
import {
  OfficialAliyunProviderSdkFactory,
  aliyunDnsExpectedRecordsHash,
  assertAliyunDomainSelectionSafe,
  assertAliyunDnsTargetCurrent,
  bindAliyunCustomerAccountFromOAuth,
  bindAliyunDnsPlan,
  disconnectAliyunCustomerConnection,
  getAliyunCustomerConnectionStatus,
  isExplicitPublicDnsAbsence,
  listAliyunCustomerDomains,
  normalizeAliyunDomain,
  openAliyunRefreshToken,
  planAliyunDnsRecords,
  requireAliyunOwnedDomain,
  sealAliyunRefreshToken,
  verifyPublicDnsRollback,
  type AliyunDnsApi,
} from "./aliyun-provider";
import {
  ALIYUN_OAUTH_CREDENTIAL_SLOT,
  encryptAliyunPlatformCredential,
} from "./aliyun-platform-service";

function expectedDnsRecord(
  overrides: Partial<SiteDnsRecord> = {},
): SiteDnsRecord {
  const now = new Date();
  return {
    id: "record-row-1",
    projectId: "project-1",
    userId: 1,
    domainAscii: "example.com",
    domainRevision: 2,
    recordType: "CNAME",
    rr: "www",
    expectedValue: "edge.example.net",
    expectedTtl: 600,
    beforeValue: null,
    beforeTtl: null,
    observedValue: null,
    observedTtl: null,
    providerRecordId: null,
    remarkMarker: "frontmind:project-1:2",
    status: "planned",
    verifiedAt: null,
    errorCode: null,
    errorMessage: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function thenableRows<T>(rows: T[]) {
  const promise = Promise.resolve(rows) as Promise<T[]> & {
    for: () => Promise<T[]>;
  };
  promise.for = async () => rows;
  return promise;
}

describe("Aliyun OAuth-only DNS provider", () => {
  const originalEncryptionKey = process.env.FRONTMIND_CREDENTIAL_ENCRYPTION_KEY;

  beforeEach(() => {
    dependencies.getDb.mockReset();
    dependencies.describeDomains.mockReset();
    dependencies.describeDomainInfo.mockReset();
    process.env.FRONTMIND_CREDENTIAL_ENCRYPTION_KEY =
      randomBytes(32).toString("base64");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalEncryptionKey == null) {
      delete process.env.FRONTMIND_CREDENTIAL_ENCRYPTION_KEY;
    } else {
      process.env.FRONTMIND_CREDENTIAL_ENCRYPTION_KEY = originalEncryptionKey;
    }
  });

  it("binds a refresh token to connection + account + OAuth credential AAD", () => {
    const input = {
      connectionId: randomUUID(),
      accountUid: "1234567890123456",
      oauthCredentialId: randomUUID(),
      refreshToken: "refresh-token-secret",
    };
    const sealed = sealAliyunRefreshToken(input);
    expect(JSON.stringify(sealed)).not.toContain(input.refreshToken);
    expect(
      openAliyunRefreshToken({
        id: input.connectionId,
        accountUid: input.accountUid,
        oauthCredentialId: input.oauthCredentialId,
        ...sealed,
      }),
    ).toBe(input.refreshToken);
    expect(() =>
      openAliyunRefreshToken({
        id: input.connectionId,
        accountUid: "9999999999999999",
        oauthCredentialId: input.oauthCredentialId,
        ...sealed,
      }),
    ).toThrow();
  });

  it("atomically binds the probed OAuth grant without exposing its token", async () => {
    const projectId = randomUUID();
    const credentialId = randomUUID();
    const inserted: Array<Record<string, unknown>> = [];
    const updated: Array<{ table: unknown; values: Record<string, unknown> }> =
      [];
    const tx = {
      select: vi.fn(() => ({
        from: vi.fn((table: unknown) => {
          const rows =
            table === siteProjects
              ? [{ id: projectId, revision: 4 }]
              : table === presalesApiCredentials
                ? [{ id: credentialId }]
                : table === siteProviderConnections
                  ? []
                  : [];
          return {
            where: vi.fn(() => ({
              limit: vi.fn(() => thenableRows(rows)),
            })),
          };
        }),
      })),
      insert: vi.fn(() => ({
        values: vi.fn(async (value: Record<string, unknown>) => {
          inserted.push(value);
        }),
      })),
      update: vi.fn((table: unknown) => ({
        set: vi.fn((value: Record<string, unknown>) => ({
          where: vi.fn(async () => {
            updated.push({ table, values: value });
            return { affectedRows: 1 };
          }),
        })),
      })),
      delete: vi.fn(() => ({ where: vi.fn(async () => undefined) })),
    };
    dependencies.getDb.mockResolvedValue({
      transaction: vi.fn(
        async (operation: (executor: typeof tx) => Promise<unknown>) =>
          operation(tx),
      ),
    });

    const result = await bindAliyunCustomerAccountFromOAuth({
      projectId,
      userId: 7,
      credentialId,
      accountUid: "1234567890123456",
      refreshToken: "refresh-token-secret",
    });

    expect(result).toMatchObject({
      accountUid: "1234567890123456",
      status: "active",
      capabilities: ["alidns_read", "alidns_write"],
    });
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({
      projectId,
      userId: 7,
      oauthCredentialId: credentialId,
      status: "active",
      capabilities: ["alidns_read", "alidns_write"],
    });
    expect(JSON.stringify(inserted)).not.toContain("refresh-token-secret");
    expect(updated).toContainEqual(
      expect.objectContaining({
        table: presalesApiCredentials,
        values: expect.objectContaining({ validationStatus: "verified" }),
      }),
    );
    expect(updated).toContainEqual(
      expect.objectContaining({
        table: siteProjects,
        values: expect.objectContaining({ revision: 5 }),
      }),
    );
  });

  it("refuses an OAuth account switch while AliDNS or ESA work is in flight", async () => {
    const projectId = randomUUID();
    const credentialId = randomUUID();
    const existing = {
      id: randomUUID(),
      accountUid: "1234567890123456",
    };
    const update = vi.fn();
    const tx = {
      select: vi.fn(() => ({
        from: vi.fn((table: unknown) => {
          const rows =
            table === siteProjects
              ? [{ id: projectId, revision: 4 }]
              : table === presalesApiCredentials
                ? [{ id: credentialId }]
                : table === siteProviderConnections
                  ? [existing]
                  : table === siteOperations
                    ? [{ id: randomUUID() }]
                    : [];
          return {
            where: vi.fn(() => ({ limit: vi.fn(() => thenableRows(rows)) })),
          };
        }),
      })),
      update,
    };
    dependencies.getDb.mockResolvedValue({
      transaction: vi.fn(
        async (operation: (executor: typeof tx) => Promise<unknown>) =>
          operation(tx),
      ),
    });

    await expect(
      bindAliyunCustomerAccountFromOAuth({
        projectId,
        userId: 7,
        credentialId,
        accountUid: "9999999999999999",
        refreshToken: "new-refresh-token-secret",
      }),
    ).rejects.toMatchObject({ code: "CONNECTION_IN_USE" });
    expect(update).not.toHaveBeenCalled();
  });

  it("keeps old DNS ownership evidence until a cross-account reset finishes", async () => {
    const projectId = randomUUID();
    const credentialId = randomUUID();
    const existing = {
      id: randomUUID(),
      accountUid: "1234567890123456",
    };
    const update = vi.fn();
    const deleteRows = vi.fn();
    const tx = {
      select: vi.fn(() => ({
        from: vi.fn((table: unknown) => {
          const rows =
            table === siteProjects
              ? [{ id: projectId, revision: 4 }]
              : table === presalesApiCredentials
                ? [{ id: credentialId }]
                : table === siteProviderConnections
                  ? [existing]
                  : table === workspaceSiteProfiles
                    ? [
                        {
                          domain: "example.com",
                          normalizedAsciiDomain: "example.com",
                          providerAccountUid: existing.accountUid,
                          domainOwnershipStatus: "verified",
                          dnsStatus: "active",
                        },
                      ]
                    : table === siteDnsRecords
                      ? [{ id: "owned-dns-row" }]
                      : [];
          return {
            where: vi.fn(() => ({ limit: vi.fn(() => thenableRows(rows)) })),
          };
        }),
      })),
      update,
      delete: deleteRows,
    };
    dependencies.getDb.mockResolvedValue({
      transaction: vi.fn(
        async (operation: (executor: typeof tx) => Promise<unknown>) =>
          operation(tx),
      ),
    });

    await expect(
      bindAliyunCustomerAccountFromOAuth({
        projectId,
        userId: 7,
        credentialId,
        accountUid: "9999999999999999",
        refreshToken: "new-refresh-token-secret",
      }),
    ).rejects.toMatchObject({
      code: "ALIYUN_ACCOUNT_CHANGE_REQUIRES_RESET",
    });
    expect(update).not.toHaveBeenCalled();
    expect(deleteRows).not.toHaveBeenCalled();
  });

  it("requires the existing safe reset chain before selecting another domain", () => {
    expect(() =>
      assertAliyunDomainSelectionSafe({
        sameDomain: false,
        hasExistingDomainState: true,
      }),
    ).toThrowError(
      expect.objectContaining({ code: "DOMAIN_SWITCH_REQUIRES_RESET" }),
    );
    expect(() =>
      assertAliyunDomainSelectionSafe({
        sameDomain: true,
        hasExistingDomainState: true,
      }),
    ).not.toThrow();
    expect(() =>
      assertAliyunDomainSelectionSafe({
        sameDomain: false,
        hasExistingDomainState: false,
      }),
    ).not.toThrow();
  });

  it("blocks disconnect while the AliDNS/ESA successor chain is in flight", async () => {
    const connection = {
      id: randomUUID(),
      projectId: randomUUID(),
      userId: 7,
      provider: "aliyun_cn" as const,
      accountUid: "1234567890123456",
      oauthCredentialId: randomUUID(),
      encryptionVersion: 1,
      encryptedRefreshToken: "sealed",
      encryptionIv: "iv",
      encryptionAuthTag: "tag",
      capabilities: ["alidns_read", "alidns_write"],
      status: "active" as const,
      verifiedAt: new Date(),
      lastErrorCode: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    dependencies.getDb.mockResolvedValue({
      select: vi.fn(() => ({
        from: vi.fn((table: unknown) => ({
          where: vi.fn(() => ({
            limit: vi.fn(async () =>
              table === siteProviderConnections
                ? [connection]
                : table === siteOperations
                  ? [{ id: "esa-successor-operation" }]
                  : [],
            ),
          })),
        })),
      })),
    });
    await expect(
      getAliyunCustomerConnectionStatus({
        projectId: connection.projectId,
        userId: connection.userId,
      }),
    ).resolves.toMatchObject({
      configured: true,
      status: "active",
      canDisconnect: false,
    });
  });

  it("atomically marks invalid_grant and bumps the project observation cursor", async () => {
    const projectId = randomUUID();
    const credentialId = randomUUID();
    const connectionId = randomUUID();
    const sealed = sealAliyunRefreshToken({
      connectionId,
      accountUid: "1234567890123456",
      oauthCredentialId: credentialId,
      refreshToken: "refresh-token-secret",
    });
    const connection = {
      id: connectionId,
      projectId,
      userId: 7,
      provider: "aliyun_cn" as const,
      accountUid: "1234567890123456",
      oauthCredentialId: credentialId,
      ...sealed,
      capabilities: ["alidns_read", "alidns_write"],
      status: "active" as const,
      verifiedAt: new Date(),
      lastErrorCode: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const updates: Array<{ table: unknown; values: Record<string, unknown> }> =
      [];
    const tx = {
      select: vi.fn(() => ({
        from: vi.fn((table: unknown) => {
          const rows =
            table === siteProjects
              ? [{ id: projectId, revision: 9 }]
              : table === siteProviderConnections
                ? [{ status: "active" as const }]
                : [];
          return {
            where: vi.fn(() => ({ limit: vi.fn(() => thenableRows(rows)) })),
          };
        }),
      })),
      update: vi.fn((table: unknown) => ({
        set: vi.fn((values: Record<string, unknown>) => ({
          where: vi.fn(async () => {
            updates.push({ table, values });
            return { affectedRows: 1 };
          }),
        })),
      })),
    };
    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({ limit: vi.fn(async () => [connection]) })),
        })),
      })),
      transaction: vi.fn(
        async (operation: (executor: typeof tx) => Promise<unknown>) =>
          operation(tx),
      ),
    };
    dependencies.getDb.mockResolvedValue(db);

    await expect(
      listAliyunCustomerDomains(
        { projectId, userId: 7 },
        {
          refreshAccessToken: vi.fn(async () => {
            throw new AuthServiceError(
              "INVALID_CREDENTIAL",
              "refresh grant invalid",
            );
          }),
        },
      ),
    ).rejects.toMatchObject({ code: "ALIYUN_REAUTHORIZATION_REQUIRED" });
    expect(updates).toContainEqual(
      expect.objectContaining({
        table: siteProviderConnections,
        values: expect.objectContaining({
          status: "invalid",
          lastErrorCode: "ALIYUN_OAUTH_INVALID_GRANT",
        }),
      }),
    );
    expect(updates).toContainEqual(
      expect.objectContaining({
        table: siteProjects,
        values: expect.objectContaining({ revision: 10 }),
      }),
    );
  });

  it("atomically revokes locally, overwrites the grant, and bumps the cursor", async () => {
    const projectId = randomUUID();
    const credentialId = randomUUID();
    const connectionId = randomUUID();
    const accountUid = "1234567890123456";
    const sealed = sealAliyunRefreshToken({
      connectionId,
      accountUid,
      oauthCredentialId: credentialId,
      refreshToken: "refresh-token-secret",
    });
    const connection = {
      id: connectionId,
      projectId,
      userId: 7,
      provider: "aliyun_cn" as const,
      accountUid,
      oauthCredentialId: credentialId,
      ...sealed,
      capabilities: ["alidns_read", "alidns_write"],
      status: "active" as const,
      verifiedAt: new Date(),
      lastErrorCode: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const appCredential = {
      id: credentialId,
      slot: ALIYUN_OAUTH_CREDENTIAL_SLOT,
      version: 1,
      ...encryptAliyunPlatformCredential(
        ALIYUN_OAUTH_CREDENTIAL_SLOT,
        credentialId,
        {
          clientId: "4724570903440411234",
          clientSecret: "frontmind-oauth-client-secret",
          callbackUrl:
            "https://dashboard.frontmind.net/api/site-ops/aliyun/oauth/callback",
        },
      ),
    };
    const updates: Array<{ table: unknown; values: Record<string, unknown> }> =
      [];
    const tx = {
      select: vi.fn(() => ({
        from: vi.fn((table: unknown) => {
          const rows =
            table === siteProjects
              ? [{ id: projectId, revision: 12 }]
              : table === siteProviderConnections
                ? [{ status: "active" as const }]
                : [];
          return {
            where: vi.fn(() => ({ limit: vi.fn(() => thenableRows(rows)) })),
          };
        }),
      })),
      update: vi.fn((table: unknown) => ({
        set: vi.fn((values: Record<string, unknown>) => ({
          where: vi.fn(async () => {
            updates.push({ table, values });
            return { affectedRows: 1 };
          }),
        })),
      })),
    };
    const db = {
      select: vi.fn(() => ({
        from: vi.fn((table: unknown) => {
          const rows =
            table === siteProviderConnections
              ? [connection]
              : table === siteOperations
                ? []
                : table === presalesApiCredentials
                  ? [appCredential]
                  : [];
          return {
            where: vi.fn(() => ({ limit: vi.fn(async () => rows) })),
          };
        }),
      })),
      transaction: vi.fn(
        async (operation: (executor: typeof tx) => Promise<unknown>) =>
          operation(tx),
      ),
    };
    dependencies.getDb.mockResolvedValue(db);

    await expect(
      disconnectAliyunCustomerConnection(
        { projectId, userId: 7 },
        {
          fetchImpl: vi.fn(async () => new Response(null, { status: 204 })),
        },
      ),
    ).resolves.toEqual({ disconnected: true, revokedRemote: true });
    const revoked = updates.find(
      (entry) => entry.table === siteProviderConnections,
    )?.values;
    expect(revoked).toMatchObject({ status: "revoked", lastErrorCode: null });
    expect(JSON.stringify(revoked)).not.toContain("refresh-token-secret");
    expect(updates).toContainEqual(
      expect.objectContaining({
        table: siteProjects,
        values: expect.objectContaining({ revision: 13 }),
      }),
    );
  });

  it("paginates, keeps only AliDomain=true, normalizes, deduplicates, and sorts", async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => ({
      aliDomain: true,
      domainName: `owned-${String(index).padStart(3, "0")}.example`,
    }));
    dependencies.describeDomains
      .mockResolvedValueOnce({ body: { domains: { domain: firstPage } } })
      .mockResolvedValueOnce({
        body: {
          domains: {
            domain: [
              { aliDomain: false, domainName: "third-party.example" },
              { aliDomain: true, domainName: "OWNED-000.EXAMPLE." },
              { aliDomain: true, domainName: "例子.公司" },
            ],
          },
        },
      });
    const api = new OfficialAliyunProviderSdkFactory().dns("memory-token");
    const domains = await api.listDomains();
    expect(dependencies.describeDomains).toHaveBeenCalledTimes(2);
    expect(domains).not.toContainEqual(
      expect.objectContaining({ domain: "third-party.example" }),
    );
    expect(
      domains.filter((item) => item.domain === "owned-000.example"),
    ).toHaveLength(1);
    expect(domains).toContainEqual({
      domain: "xn--fsqu00a.xn--55qx5d",
      displayDomain: "例子.公司",
    });
    expect(domains).toEqual(
      [...domains].sort((left, right) =>
        left.domain.localeCompare(right.domain),
      ),
    );
  });

  it("accepts only an exact domain returned by the connected account", async () => {
    const api = {
      listDomains: vi.fn(async () => [
        { domain: "example.com", displayDomain: "example.com" },
      ]),
      getDomain: vi.fn(async (domain: string) =>
        domain === "example.com"
          ? { domain: "example.com", displayDomain: "example.com" }
          : null,
      ),
    } as unknown as AliyunDnsApi;
    await expect(
      requireAliyunOwnedDomain(api, "EXAMPLE.COM."),
    ).resolves.toEqual({
      domain: "example.com",
      displayDomain: "example.com",
    });
    await expect(
      requireAliyunOwnedDomain(api, "other.example"),
    ).rejects.toMatchObject({ code: "ALIYUN_DOMAIN_NOT_OWNED" });
  });

  it("normalizes IDN domains and rejects non-domain input", () => {
    expect(normalizeAliyunDomain("例子.公司.")).toEqual({
      ascii: "xn--fsqu00a.xn--55qx5d",
      unicode: "例子.公司",
    });
    expect(() => normalizeAliyunDomain("not-a-domain")).toThrowError(
      expect.objectContaining({ code: "INVALID_DOMAIN" }),
    );
  });

  it("rejects stale DNS targets", () => {
    const active = {
      normalizedAsciiDomain: "example.com",
      domainRevision: 2,
      domainStatus: "completed" as const,
      domainOwnershipStatus: "verified",
    };
    expect(() =>
      assertAliyunDnsTargetCurrent(active, {
        domain: "EXAMPLE.com",
        revision: 2,
      }),
    ).not.toThrow();
    expect(() =>
      assertAliyunDnsTargetCurrent(active, {
        domain: "new.example.com",
        revision: 3,
      }),
    ).toThrowError(
      expect.objectContaining({ code: "DNS_DOMAIN_REVISION_STALE" }),
    );
  });

  it("keeps desired DNS hashes independent from provider reconciliation state", () => {
    const expected = expectedDnsRecord();
    const initial = aliyunDnsExpectedRecordsHash({
      mode: "apply",
      domain: expected.domainAscii,
      revision: expected.domainRevision,
      records: [expected],
    });
    expect(
      aliyunDnsExpectedRecordsHash({
        mode: "apply",
        domain: expected.domainAscii,
        revision: expected.domainRevision,
        records: [
          {
            ...expected,
            providerRecordId: "record-created-after-apply",
            observedValue: expected.expectedValue,
            status: "propagating",
          },
        ],
      }),
    ).toBe(initial);
    expect(
      aliyunDnsExpectedRecordsHash({
        mode: "apply",
        domain: expected.domainAscii,
        revision: expected.domainRevision,
        records: [{ ...expected, expectedValue: "changed.example.net" }],
      }),
    ).not.toBe(initial);
  });

  it("never overwrites a foreign same-RR/type record", () => {
    const plan = planAliyunDnsRecords(
      [expectedDnsRecord()],
      [
        {
          recordId: "customer-record",
          rr: "www",
          type: "CNAME",
          value: "customer.example.net",
          ttl: 600,
          remark: "managed-by-customer",
        },
      ],
    );
    expect(plan).toEqual([
      expect.objectContaining({
        action: "conflict",
        reason: expect.stringContaining("非 FrontMind"),
      }),
    ]);
  });

  it("does not repeat an unknown write or delete a customer-modified record", () => {
    const unknown = expectedDnsRecord({
      providerRecordId: "frontmind-record",
      status: "outcome_unknown",
    });
    expect(
      planAliyunDnsRecords(
        [unknown],
        [
          {
            recordId: "frontmind-record",
            rr: "www",
            type: "CNAME",
            value: "old-edge.example.net",
            ttl: 600,
            remark: unknown.remarkMarker,
          },
        ],
      )[0],
    ).toEqual(expect.objectContaining({ action: "unknown" }));

    const rollback = expectedDnsRecord({
      providerRecordId: "frontmind-record",
      beforeValue: null,
    });
    expect(
      planAliyunDnsRecords(
        [rollback],
        [
          {
            recordId: "frontmind-record",
            rr: "www",
            type: "CNAME",
            value: "customer-changed.example.net",
            ttl: 600,
            remark: rollback.remarkMarker,
          },
        ],
        "rollback",
      )[0],
    ).toEqual(expect.objectContaining({ action: "conflict" }));
  });

  it("reconciles an exact owned-record delete without repeating writes", () => {
    const created = expectedDnsRecord({
      id: "created-by-frontmind",
      providerRecordId: "frontmind-created-record",
      beforeValue: null,
      status: "outcome_unknown",
    });
    expect(planAliyunDnsRecords([created], [], "rollback")[0]).toMatchObject({
      action: "rollback_verify",
      current: null,
    });

    const legacyUpdated = expectedDnsRecord({
      id: "legacy-updated-by-frontmind",
      providerRecordId: "frontmind-legacy-record",
      beforeValue: "customer.example.net",
      beforeTtl: 300,
      status: "outcome_unknown",
    });
    const exactOwnedRecord = {
      recordId: "frontmind-legacy-record",
      rr: legacyUpdated.rr,
      type: legacyUpdated.recordType,
      value: legacyUpdated.expectedValue,
      ttl: legacyUpdated.expectedTtl,
      remark: legacyUpdated.remarkMarker,
    };
    expect(
      planAliyunDnsRecords([legacyUpdated], [exactOwnedRecord], "rollback")[0],
    ).toMatchObject({ action: "rollback_delete" });
    expect(
      planAliyunDnsRecords([legacyUpdated], [], "rollback")[0],
    ).toMatchObject({ action: "rollback_verify" });
  });

  it("requires public DNS to lose every FrontMind-owned value", async () => {
    const created = expectedDnsRecord({
      id: "created-by-frontmind",
      rr: "_frontmind",
      recordType: "TXT",
      expectedValue: "frontmind-verification",
      beforeValue: null,
    });
    const secondOwned = expectedDnsRecord({
      id: "second-owned-record",
      rr: "www",
      expectedValue: "frontmind-edge.example.net",
      beforeValue: "customer-edge.example.net",
    });
    const resolver = vi.fn(async () => []);
    await expect(
      verifyPublicDnsRollback([created, secondOwned], resolver),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      verifyPublicDnsRollback(
        [created],
        vi.fn(async () => ["frontmind-verification"]),
      ),
    ).resolves.toMatchObject({ ok: false });
    await expect(
      verifyPublicDnsRollback(
        [created],
        vi.fn(async () => {
          throw Object.assign(new Error("temporary DNS failure"), {
            code: "ESERVFAIL",
          });
        }),
      ),
    ).resolves.toMatchObject({
      ok: false,
      observations: [
        expect.objectContaining({
          matched: false,
          unavailable: true,
          errorCode: "ESERVFAIL",
        }),
      ],
    });
  });

  it("treats only explicit DNS absence as an empty public answer", () => {
    expect(isExplicitPublicDnsAbsence({ code: "ENODATA" })).toBe(true);
    expect(isExplicitPublicDnsAbsence({ code: "ENOTFOUND" })).toBe(true);
    expect(isExplicitPublicDnsAbsence({ code: "ETIMEOUT" })).toBe(false);
    expect(isExplicitPublicDnsAbsence({ code: "ESERVFAIL" })).toBe(false);
    expect(isExplicitPublicDnsAbsence(new Error("network unavailable"))).toBe(
      false,
    );
  });

  it("binds a DNS plan to the exact tuple and provider snapshot", () => {
    const expected = expectedDnsRecord();
    const plan = planAliyunDnsRecords([expected], []);
    const first = bindAliyunDnsPlan({
      domain: expected.domainAscii,
      revision: expected.domainRevision,
      expectedRecords: [expected],
      plan,
    });
    const repeated = bindAliyunDnsPlan({
      domain: expected.domainAscii,
      revision: expected.domainRevision,
      expectedRecords: [expected],
      plan,
    });
    expect(first).toEqual(repeated);
    expect(first.canApply).toBe(true);
    expect(first.items[0]).toMatchObject({ action: "create", rr: "www" });
  });
});
