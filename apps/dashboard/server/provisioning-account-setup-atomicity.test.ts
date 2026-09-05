import { createHash, createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const databaseState = vi.hoisted(() => ({ value: undefined as any }));

vi.mock("./db", () => ({
  getDb: async () => databaseState.value,
}));

import {
  sessions,
  userPasswordSetupTokens,
  users,
  websiteProjectDeletionTombstones,
  websiteUserProvisions,
} from "../drizzle/schema";
import { setupWebsiteAccountPassword } from "./provisioning-v2-service";

const SECRET = "account-setup-atomicity-secret-at-least-32-characters";
const NOW = new Date("2026-08-02T02:00:00.000Z");
const EXPIRES_AT = new Date("2026-08-03T02:00:00.000Z");

function setupToken(provisionId: string) {
  const payload = Buffer.from(
    JSON.stringify({
      v: 1,
      provisionId,
      exp: EXPIRES_AT.getTime(),
    }),
  ).toString("base64url");
  const signature = createHmac("sha256", SECRET)
    .update(payload)
    .digest("base64url");
  return `${payload}.${signature}`;
}

class AccountSetupDb {
  readonly operations: Array<{
    table: unknown;
    values: Record<string, unknown>;
  }> = [];
  transactionCount = 0;

  constructor(
    private readonly token: string,
    private readonly accountActive = true,
  ) {}

  select() {
    let selectedTable: unknown;
    const selectedRows = () =>
      selectedTable === websiteProjectDeletionTombstones
        ? [{ status: "active" }]
        : selectedTable === websiteUserProvisions
          ? [
              {
                id: "provision-account-setup-001",
                projectId: "project-account-setup-001",
                userId: 42,
                status: "completed",
                accountMode: "create",
                accountSetupTokenConsumedAt: null,
                accountSetupTokenExpiresAt: EXPIRES_AT,
                accountSetupTokenHash: createHash("sha256")
                  .update(this.token, "utf8")
                  .digest("hex"),
                requestedUsername: "setup.customer",
              },
            ]
          : selectedTable === users
            ? [
                {
                  id: 42,
                  username: "setup.customer",
                  role: "user",
                  isActive: this.accountActive,
                },
              ]
            : [];
    const query: any = {
      from: (table: unknown) => {
        selectedTable = table;
        return query;
      },
      where: () => query,
      limit: () => query,
      for: async () => selectedRows(),
      then: (resolve: (rows: unknown[]) => unknown) =>
        Promise.resolve(selectedRows()).then(resolve),
    };
    return query;
  }

  insert(table: unknown) {
    return {
      values: () =>
        table === websiteProjectDeletionTombstones
          ? { onDuplicateKeyUpdate: async () => undefined }
          : Promise.resolve(undefined),
    };
  }

  update(table: unknown) {
    return {
      set: (values: Record<string, unknown>) => ({
        where: async () => {
          this.operations.push({ table, values });
        },
      }),
    };
  }

  async transaction<T>(operation: (tx: AccountSetupDb) => Promise<T>) {
    this.transactionCount += 1;
    return operation(this);
  }
}

describe("website account setup transaction", () => {
  beforeEach(() => {
    databaseState.value = undefined;
  });

  it("updates the password, revokes every session and consumes the token in one transaction", async () => {
    const token = setupToken("provision-account-setup-001");
    const db = new AccountSetupDb(token);
    databaseState.value = db;

    await expect(
      setupWebsiteAccountPassword({
        token,
        password: "new-account-password",
        secret: SECRET,
        now: NOW,
      }),
    ).resolves.toMatchObject({ success: true, username: "setup.customer" });

    expect(db.transactionCount).toBe(1);
    expect(db.operations.map(({ table }) => table)).toEqual([
      users,
      userPasswordSetupTokens,
      websiteUserProvisions,
      sessions,
    ]);
    expect(db.operations[0]?.values).toMatchObject({
      passwordHash: expect.stringMatching(/^scrypt\$v1\$/),
      passwordChangedAt: NOW,
    });
    expect(db.operations[1]?.values).toMatchObject({ consumedAt: NOW });
    expect(db.operations[2]?.values).toMatchObject({
      accountSetupTokenConsumedAt: NOW,
    });
    expect(db.operations[3]?.values).toEqual({ revokedAt: NOW });
  });

  it("does not consume a setup token for a missing or inactive account", async () => {
    const token = setupToken("provision-account-setup-001");
    const db = new AccountSetupDb(token, false);
    databaseState.value = db;

    await expect(
      setupWebsiteAccountPassword({
        token,
        password: "must-not-be-written",
        secret: SECRET,
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: "ACCOUNT_SETUP_INVALID" });
    expect(db.operations).toEqual([]);
  });
});
