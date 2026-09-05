import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMock = vi.hoisted(() => ({
  getDb: vi.fn(),
}));

vi.mock("./db", () => ({
  getDb: dbMock.getDb,
}));

import { userPasswordSetupTokens, users } from "../drizzle/schema";
import {
  createManagedUserWithPasswordHash,
  createManagedUserWithSetupToken,
  hashPassword,
  setupManagedUserPassword,
  validateManagedAccountSetupToken,
  verifyPassword,
} from "./auth-service";

class AccountSetupDb {
  userRows: Array<Record<string, any>> = [];
  tokenRows: Array<Record<string, any>> = [];

  select(selection?: Record<string, unknown>) {
    return {
      from: (table: unknown) => {
        const rows = () => {
          if (table === users) {
            if (!selection) return this.userRows;
            return this.userRows.map((row) => {
              const projected: Record<string, unknown> = {};
              for (const key of Object.keys(selection))
                projected[key] = row[key];
              return projected;
            });
          }
          if (table === userPasswordSetupTokens) return this.tokenRows;
          return [];
        };
        return {
          where: () => {
            const limit = () => {
              const values = rows();
              const query = Promise.resolve(values) as Promise<
                Array<Record<string, any>>
              > & {
                for: () => Promise<Array<Record<string, any>>>;
              };
              query.for = async () => values;
              return query;
            };
            return { limit };
          },
        };
      },
    };
  }

  insert(table: unknown) {
    return {
      values: async (values: Record<string, any>) => {
        if (table === users) {
          this.userRows.push({
            id: this.userRows.length + 1,
            openId: null,
            email: null,
            lastSignedIn: null,
            ...values,
          });
        }
        if (table === userPasswordSetupTokens) {
          this.tokenRows.push({ ...values });
        }
      },
    };
  }

  update(table: unknown) {
    return {
      set: (values: Record<string, any>) => ({
        where: async () => {
          if (table === users) Object.assign(this.userRows[0]!, values);
          if (table === userPasswordSetupTokens) {
            Object.assign(this.tokenRows[0]!, values);
          }
        },
      }),
    };
  }

  async transaction<T>(callback: (tx: AccountSetupDb) => Promise<T>) {
    return callback(this);
  }
}

describe("system-admin managed account setup", () => {
  let db: AccountSetupDb;
  const now = new Date("2026-07-26T08:00:00.000Z");

  beforeEach(() => {
    db = new AccountSetupDb();
    dbMock.getDb.mockResolvedValue(db);
  });

  it("creates an immediately usable account from a precomputed hash without plaintext persistence", async () => {
    const plaintext = "customer-selected-password";
    const passwordHash = await hashPassword(plaintext);
    const created = await createManagedUserWithPasswordHash(
      {
        username: "Customer.Chosen",
        passwordHash,
        displayName: "客户自选账号",
        role: "user",
        now,
      },
      db,
    );

    expect(created.username).toBe("customer.chosen");
    expect(db.userRows[0]?.passwordHash).toBe(passwordHash);
    expect(JSON.stringify(db.userRows)).not.toContain(plaintext);
    await expect(
      verifyPassword(plaintext, db.userRows[0]?.passwordHash),
    ).resolves.toBe(true);
  });

  it("stores only an opaque token hash and an unusable random password", async () => {
    const created = await createManagedUserWithSetupToken({
      username: "Customer.User",
      displayName: "客户用户",
      createdByUserId: 1,
      now,
    });

    expect(created.user.username).toBe("customer.user");
    expect(created.setupToken).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(db.tokenRows[0]?.tokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(db.tokenRows[0]?.tokenHash).not.toContain(created.setupToken);
    expect(db.userRows[0]?.passwordChangedAt).toBeNull();
    await expect(
      verifyPassword(
        "administrator-selected-password",
        db.userRows[0]?.passwordHash,
      ),
    ).resolves.toBe(false);
  });

  it("validates once, sets the password, and rejects reuse", async () => {
    const created = await createManagedUserWithSetupToken({
      username: "single.use",
      createdByUserId: 1,
      now,
    });

    await expect(
      validateManagedAccountSetupToken({
        token: created.setupToken,
        now: new Date(now.getTime() + 1_000),
      }),
    ).resolves.toMatchObject({ valid: true, username: "single.use" });

    await expect(
      setupManagedUserPassword({
        token: created.setupToken,
        password: "customer-selected-password",
        now: new Date(now.getTime() + 2_000),
      }),
    ).resolves.toMatchObject({ success: true, username: "single.use" });
    await expect(
      verifyPassword(
        "customer-selected-password",
        db.userRows[0]?.passwordHash,
      ),
    ).resolves.toBe(true);
    expect(db.tokenRows[0]?.consumedAt).toEqual(
      new Date(now.getTime() + 2_000),
    );

    await expect(
      setupManagedUserPassword({
        token: created.setupToken,
        password: "another-customer-password",
        now: new Date(now.getTime() + 3_000),
      }),
    ).rejects.toMatchObject({ code: "INVALID_CREDENTIAL" });
  });

  it("rejects an expired activation token", async () => {
    const created = await createManagedUserWithSetupToken({
      username: "expired.user",
      createdByUserId: 1,
      now,
      ttlMs: 1_000,
    });

    await expect(
      validateManagedAccountSetupToken({
        token: created.setupToken,
        now: new Date(now.getTime() + 1_001),
      }),
    ).rejects.toMatchObject({ code: "INVALID_CREDENTIAL" });
  });
});
