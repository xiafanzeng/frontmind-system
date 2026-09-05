import { beforeEach, describe, expect, it, vi } from "vitest";

const databaseMock = vi.hoisted(() => ({ getDb: vi.fn() }));

vi.mock("./db", () => ({ getDb: databaseMock.getDb }));

import {
  apiKeyOwnership,
  deliveryRedirectPreviews,
  deliveryTicketAttachments,
  deliveryTickets,
  knowledgeBaseResetRequests,
  sessions,
  upstreamResources,
  userPasswordSetupTokens,
  users,
  websiteStyleSampleBatches,
  websiteStyleSamples,
  websiteUserProvisions,
} from "../drizzle/schema";
import { COOKIE_NAME } from "../shared/const";
import {
  authenticateRequest,
  changeOwnPassword,
  deleteManagedUser,
  hashPassword,
  loginWithPassword,
  resetManagedUserPassword,
  sessionPredatesPasswordChange,
  verifyPassword,
} from "./auth-service";

function lockedSelect(rows: unknown[]) {
  return {
    from: () => ({
      where: () => {
        const locked = { for: async () => rows };
        return {
          ...locked,
          limit: () => locked,
        };
      },
    }),
  };
}

function transactionDatabase(
  selectedRows: unknown[],
  options: { failSessionUpdate?: boolean } = {},
) {
  const updateTables: unknown[] = [];
  const updateValues: Array<Record<string, unknown>> = [];
  const deleteTables: unknown[] = [];
  let rolledBack = false;
  const tx = {
    select: () => lockedSelect(selectedRows),
    update: (table: unknown) => ({
      set: (values: Record<string, unknown>) => ({
        where: async () => {
          updateTables.push(table);
          updateValues.push(values);
          if (table === sessions && options.failSessionUpdate) {
            throw new Error("SESSION_REVOKE_FAILED");
          }
        },
      }),
    }),
    delete: (table: unknown) => ({
      where: async () => {
        deleteTables.push(table);
      },
    }),
  };
  const db = {
    update: vi.fn(() => {
      throw new Error("OUTSIDE_TRANSACTION_UPDATE");
    }),
    transaction: async (callback: (value: typeof tx) => Promise<unknown>) => {
      try {
        return await callback(tx);
      } catch (error) {
        rolledBack = true;
        throw error;
      }
    },
  };
  return {
    db,
    updateTables,
    updateValues,
    deleteTables,
    rolledBack: () => rolledBack,
  };
}

describe("password/session atomicity", () => {
  beforeEach(() => {
    databaseMock.getDb.mockReset();
  });

  it("updates the password and revokes every session in one transaction", async () => {
    const currentHash = await hashPassword("current-password");
    const fake = transactionDatabase([{ id: 7, passwordHash: currentHash }]);
    databaseMock.getDb.mockResolvedValue(fake.db);

    await changeOwnPassword(7, "current-password", "new-password");

    expect(fake.db.update).not.toHaveBeenCalled();
    expect(fake.updateTables).toEqual([
      users,
      userPasswordSetupTokens,
      websiteUserProvisions,
      sessions,
    ]);
    const passwordUpdate = fake.updateValues[0]!;
    await expect(
      verifyPassword("new-password", String(passwordUpdate.passwordHash)),
    ).resolves.toBe(true);
    expect(passwordUpdate.passwordChangedAt).toBeInstanceOf(Date);
    expect(fake.updateValues[1]?.consumedAt).toBe(
      passwordUpdate.passwordChangedAt,
    );
    expect(fake.updateValues[2]?.accountSetupTokenConsumedAt).toBe(
      passwordUpdate.passwordChangedAt,
    );
    expect(fake.updateValues[3]?.revokedAt).toBe(
      passwordUpdate.passwordChangedAt,
    );
  });

  it("surfaces a session revocation failure from the password transaction", async () => {
    const currentHash = await hashPassword("current-password");
    const fake = transactionDatabase([{ id: 7, passwordHash: currentHash }], {
      failSessionUpdate: true,
    });
    databaseMock.getDb.mockResolvedValue(fake.db);

    await expect(
      changeOwnPassword(7, "current-password", "new-password"),
    ).rejects.toThrow("SESSION_REVOKE_FAILED");
    expect(fake.rolledBack()).toBe(true);
    expect(fake.db.update).not.toHaveBeenCalled();
  });

  it("locks the managed account and revokes all sessions inside the reset transaction", async () => {
    const fake = transactionDatabase([{ id: 19 }]);
    databaseMock.getDb.mockResolvedValue(fake.db);

    await resetManagedUserPassword(19, "replacement-password");

    expect(fake.db.update).not.toHaveBeenCalled();
    expect(fake.updateTables).toEqual([
      users,
      userPasswordSetupTokens,
      websiteUserProvisions,
      sessions,
    ]);
    expect(fake.updateValues[3]?.revokedAt).toBe(
      fake.updateValues[0]?.passwordChangedAt,
    );
  });

  it("retires both setup protocols and sessions before permanently deleting an account", async () => {
    const fake = transactionDatabase([
      {
        id: 29,
        username: "departing-customer",
        role: "user",
        isActive: true,
      },
    ]);
    databaseMock.getDb.mockResolvedValue(fake.db);

    await expect(deleteManagedUser(1, 29)).resolves.toEqual({
      disposition: "permanently_deleted",
    });

    expect(fake.updateTables).toEqual([
      userPasswordSetupTokens,
      websiteUserProvisions,
      sessions,
    ]);
    expect(fake.updateValues[0]?.consumedAt).toBeInstanceOf(Date);
    expect(fake.updateValues[1]?.accountSetupTokenConsumedAt).toBe(
      fake.updateValues[0]?.consumedAt,
    );
    expect(fake.updateValues[2]?.revokedAt).toBe(
      fake.updateValues[0]?.consumedAt,
    );
    expect(fake.deleteTables).toEqual([
      websiteStyleSamples,
      websiteStyleSampleBatches,
      knowledgeBaseResetRequests,
      deliveryRedirectPreviews,
      deliveryTicketAttachments,
      deliveryTickets,
      upstreamResources,
      apiKeyOwnership,
      users,
    ]);
  });

  it("locks password verification and session creation into the same login transaction", async () => {
    const passwordHash = await hashPassword("current-password");
    const insertedSessions: Array<Record<string, unknown>> = [];
    const user = {
      id: 23,
      openId: null,
      username: "customer",
      passwordHash,
      displayName: "Customer",
      name: null,
      email: null,
      loginMethod: "password",
      role: "user",
      adminAccessLevel: null,
      engineerRoleType: null,
      marketEdition: "domestic",
      isActive: true,
      passwordChangedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      lastSignedIn: null,
    };
    const tx = {
      select: () => lockedSelect([user]),
      update: (table: unknown) => ({
        set: () => ({
          where: async () => {
            expect(table).toBe(users);
          },
        }),
      }),
      insert: (table: unknown) => ({
        values: async (value: Record<string, unknown>) => {
          expect(table).toBe(sessions);
          insertedSessions.push(value);
        },
      }),
    };
    const db = {
      update: vi.fn(),
      insert: vi.fn(),
      transaction: (callback: (value: typeof tx) => Promise<unknown>) =>
        callback(tx),
    };
    databaseMock.getDb.mockResolvedValue(db);

    await expect(
      loginWithPassword("customer", "current-password", "127.0.0.1"),
    ).resolves.toMatchObject({
      user: { id: 23, username: "customer" },
      token: expect.any(String),
    });
    expect(insertedSessions).toHaveLength(1);
    expect(insertedSessions[0]).toMatchObject({ userId: 23 });
    expect(db.update).not.toHaveBeenCalled();
    expect(db.insert).not.toHaveBeenCalled();
  });
});

describe("password version session fence", () => {
  it("rejects sessions created before a password change but permits the same timestamp precision", () => {
    const passwordChangedAt = new Date("2026-08-02T10:00:00.000Z");
    expect(
      sessionPredatesPasswordChange(
        new Date("2026-08-02T09:59:59.000Z"),
        passwordChangedAt,
      ),
    ).toBe(true);
    expect(
      sessionPredatesPasswordChange(passwordChangedAt, passwordChangedAt),
    ).toBe(false);
    expect(sessionPredatesPasswordChange(passwordChangedAt, null)).toBe(false);
  });

  it("fails authentication before touching lastSeenAt for a stale session", async () => {
    const update = vi.fn();
    const staleRow = {
      user: {
        id: 7,
        openId: null,
        username: "customer",
        displayName: "Customer",
        name: null,
        email: null,
        loginMethod: "password",
        role: "user",
        adminAccessLevel: null,
        engineerRoleType: null,
        marketEdition: "domestic",
        isActive: true,
        passwordChangedAt: new Date("2026-08-02T10:00:00.000Z"),
        createdAt: new Date("2026-08-01T00:00:00.000Z"),
        updatedAt: new Date("2026-08-02T10:00:00.000Z"),
        lastSignedIn: new Date("2026-08-02T09:00:00.000Z"),
      },
      lastSeenAt: new Date("2026-08-02T09:00:00.000Z"),
      sessionCreatedAt: new Date("2026-08-02T09:00:00.000Z"),
    };
    databaseMock.getDb.mockResolvedValue({
      select: () => ({
        from: () => ({
          innerJoin: () => ({
            where: () => ({ limit: async () => [staleRow] }),
          }),
        }),
      }),
      update,
    });

    await expect(
      authenticateRequest({
        headers: { cookie: `${COOKIE_NAME}=opaque-session-token` },
      } as never),
    ).resolves.toBeNull();
    expect(update).not.toHaveBeenCalled();
  });
});
