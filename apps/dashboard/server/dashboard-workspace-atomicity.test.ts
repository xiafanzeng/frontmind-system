import { beforeEach, describe, expect, it, vi } from "vitest";

const dependencies = vi.hoisted(() => ({
  getDb: vi.fn(),
}));

vi.mock("./db", () => ({ getDb: dependencies.getDb }));

import {
  dashboardImportPreflights,
  knowledgeBaseSnapshots,
  serviceProgressReports,
  userDashboardContents,
  users,
  workspaceAuditEvents,
  workspaceContentRevisions,
} from "../drizzle/schema";
import { createDefaultDashboardPayload } from "../shared/dashboard";
import {
  issueDashboardImportPreflight,
  type DashboardImportPreflightRecord,
  type DashboardImportPreflightStore,
} from "./dashboard-import-preflight-service";
import { dashboardImportTransactionHooks } from "./dashboard-api";
import { updateDashboardWorkspace } from "./dashboard-service";

const ACTOR = {
  id: 7,
  username: "delivery-admin",
  role: "admin",
  adminAccessLevel: "delivery_admin",
} as const;
const WORKSPACE_USER_ID = 42;
const FILE_HASH = "d".repeat(64);

async function importCredential() {
  const records: DashboardImportPreflightRecord[] = [];
  const store: DashboardImportPreflightStore = {
    async issue(record) {
      records.push(record);
    },
    async consume() {
      throw new Error("not used while issuing");
    },
  };
  const credential = await issueDashboardImportPreflight({
    binding: {
      actorId: ACTOR.id,
      workspaceUserId: WORKSPACE_USER_ID,
      module: "metrics",
      revision: 1,
      fileHash: FILE_HASH,
    },
    store,
  });
  const record = records[0]!;
  return {
    token: credential.preflightToken,
    row: {
      id: record.nonce,
      actorUserId: record.actorId,
      workspaceUserId: record.workspaceUserId,
      module: record.module,
      dashboardRevision: record.revision,
      fileHash: record.fileHash,
      sectionId: record.sectionId ?? null,
      targetBatchKey: record.targetBatchKey ?? null,
      expiresAt: record.expiresAt,
      consumedAt: record.consumedAt,
    },
  };
}

function transactionalDatabase(input: {
  preflight: Record<string, any>;
  failAudit?: boolean;
}) {
  let failAudit = Boolean(input.failAudit);
  let committed = {
    content: {
      userId: WORKSPACE_USER_ID,
      payload: createDefaultDashboardPayload("正式企业"),
      sourceName: "metrics-R1.json",
      enterpriseIdentityBoundAt: new Date("2026-07-01T00:00:00.000Z"),
      revision: 1,
      updatedByUserId: ACTOR.id,
      updatedAt: new Date("2026-07-27T00:00:00.000Z"),
    } as Record<string, any>,
    preflight: { ...input.preflight } as Record<string, any>,
    revisions: [] as Record<string, any>[],
    audits: [] as Record<string, any>[],
    progressReports: [] as Record<string, any>[],
  };

  const rowsFor = (
    table: unknown,
    state: typeof committed,
  ): Record<string, any>[] => {
    if (table === users) {
      return [
        {
          id: WORKSPACE_USER_ID,
          displayName: "正式企业",
          username: "formal-company",
        },
      ];
    }
    if (table === userDashboardContents) return [state.content];
    if (table === knowledgeBaseSnapshots) return [];
    if (table === dashboardImportPreflights) return [state.preflight];
    return [];
  };

  const query = (rows: Record<string, any>[]) => {
    const chain: Record<string, any> = {
      where() {
        return chain;
      },
      orderBy() {
        return chain;
      },
      limit(limit: number) {
        return query(rows.slice(0, limit));
      },
      async for() {
        return rows;
      },
      then(resolve: (value: Record<string, any>[]) => unknown) {
        return Promise.resolve(rows).then(resolve);
      },
    };
    return chain;
  };

  const executor = (state: typeof committed) => ({
    select() {
      return {
        from(table: unknown) {
          return query(rowsFor(table, state));
        },
      };
    },
    update(table: unknown) {
      return {
        set(values: Record<string, any>) {
          return {
            async where() {
              if (table === userDashboardContents) {
                state.content = { ...state.content, ...values };
              }
              if (table === dashboardImportPreflights) {
                state.preflight = { ...state.preflight, ...values };
              }
            },
          };
        },
      };
    },
    insert(table: unknown) {
      return {
        async values(values: Record<string, any> | Record<string, any>[]) {
          const rows = Array.isArray(values) ? values : [values];
          if (table === userDashboardContents) {
            state.content = { ...rows[0] };
          }
          if (table === workspaceContentRevisions) {
            state.revisions.push(...rows);
          }
          if (table === serviceProgressReports) {
            state.progressReports.push(...rows);
          }
          if (table === workspaceAuditEvents) {
            if (failAudit) throw new Error("simulated audit insert failure");
            state.audits.push(...rows);
          }
        },
      };
    },
  });

  const db = {
    ...executor(committed),
    async transaction(callback: (tx: any) => Promise<unknown>) {
      const local = {
        content: { ...committed.content },
        preflight: { ...committed.preflight },
        revisions: committed.revisions.map((row) => ({ ...row })),
        audits: committed.audits.map((row) => ({ ...row })),
        progressReports: committed.progressReports.map((row) => ({ ...row })),
      };
      const result = await callback(executor(local));
      committed = local;
      Object.assign(db, executor(committed));
      return result;
    },
  };

  return {
    db,
    setFailAudit(value: boolean) {
      failAudit = value;
    },
    get state() {
      return committed;
    },
  };
}

beforeEach(() => {
  dependencies.getDb.mockReset();
});

describe("dashboard workspace publication transaction", () => {
  it("rolls back the preflight consumption, content revision, and history when the audit write fails", async () => {
    const credential = await importCredential();
    const database = transactionalDatabase({
      preflight: credential.row,
      failAudit: true,
    });
    dependencies.getDb.mockResolvedValue(database.db);
    const transactionHooks = dashboardImportTransactionHooks({
      actor: ACTOR as any,
      targetUserId: WORKSPACE_USER_ID,
      module: "metrics",
      expectedRevision: 1,
      fileHash: FILE_HASH,
      preflightToken: credential.token,
      sourceFileName: "metrics-R1.json",
    });

    const publish = () =>
      updateDashboardWorkspace({
        userId: WORKSPACE_USER_ID,
        actorUserId: ACTOR.id,
        payload: {
          ...createDefaultDashboardPayload("正式企业"),
          metrics: [{ label: "提及率", value: "38", unit: "%" }],
        },
        sourceName: "metrics-R1.json",
        expectedRevision: 1,
        ...transactionHooks,
      });

    await expect(publish()).rejects.toThrow("simulated audit insert failure");
    expect(database.state.content.revision).toBe(1);
    expect(database.state.preflight.consumedAt).toBeNull();
    expect(database.state.revisions).toHaveLength(0);
    expect(database.state.audits).toHaveLength(0);

    database.setFailAudit(false);
    const workspace = await publish();
    expect(workspace.revision).toBe(2);
    expect(workspace.payload.metrics).toEqual([
      { label: "提及率", value: "38", unit: "%" },
    ]);
    expect(database.state.preflight.consumedAt).toBeInstanceOf(Date);
    expect(database.state.revisions).toHaveLength(1);
    expect(database.state.audits).toHaveLength(1);
    expect(database.state.audits[0]).toMatchObject({
      action: "workspace.dashboard.module_imported",
      metadata: { revision: 2 },
    });
  });
});
