import { beforeEach, describe, expect, it, vi } from "vitest";

const dependencies = vi.hoisted(() => ({
  getDb: vi.fn(),
  getServicePortal: vi.fn(),
  assertWorkspaceAccess: vi.fn(),
}));

vi.mock("./db", () => ({ getDb: dependencies.getDb }));
vi.mock("./dashboard-service", async () => {
  const actual = await vi.importActual<typeof import("./dashboard-service")>(
    "./dashboard-service",
  );
  return {
    ...actual,
    assertWorkspaceAccess: dependencies.assertWorkspaceAccess,
  };
});
vi.mock("./service-entitlement", async () => {
  const actual = await vi.importActual<typeof import("./service-entitlement")>(
    "./service-entitlement",
  );
  return {
    ...actual,
    getServicePortal: dependencies.getServicePortal,
  };
});

import {
  dashboardImportPreflights,
  deliveryTicketEvents,
  deliveryTickets,
  serviceQuotaPeriods,
  workspaceAuditEvents,
} from "../drizzle/schema";
import {
  issueDashboardImportPreflight,
  type DashboardImportPreflightRecord,
  type DashboardImportPreflightStore,
} from "./dashboard-import-preflight-service";
import {
  createWebsiteContentTemplate,
  publishWebsiteContentTemplate,
} from "./website-content-template-service";

const ACTOR = {
  id: 7,
  role: "admin",
  username: "system-admin",
  displayName: "系统管理员",
  adminAccessLevel: "system_admin",
} as any;
const WORKSPACE_USER_ID = 42;
const FILE_HASH = "c".repeat(64);
const NOW = new Date("2026-07-28T00:00:00.000Z");

function ticket(
  patch: Partial<Record<string, unknown>> = {},
): Record<string, any> {
  return {
    id: "970b87d8-d4f4-45db-8f11-44c45f52ade9",
    userId: WORKSPACE_USER_ID,
    contractId: "contract-1",
    quotaPeriodId: "period-1",
    type: "website_operation",
    quotaPool: "website_content_publish",
    workflowDomain: null,
    category: "company_facts",
    topic: "企业品牌事实",
    title: "企业资料与品牌事实",
    status: "submitted",
    quotaState: "reserved",
    publicSummary: null,
    revision: 3,
    scheduledAt: null,
    resolvedAt: null,
    technicalDedupeKey: null,
    quotaReleasedAt: null,
    createdAt: new Date("2026-07-27T00:00:00.000Z"),
    ...patch,
  };
}

function preflightMemoryStore() {
  const rows = new Map<string, DashboardImportPreflightRecord>();
  const store: DashboardImportPreflightStore = {
    async issue(record) {
      rows.set(record.nonce, { ...record });
    },
    async consume() {
      throw new Error("not used while issuing");
    },
  };
  return { rows, store };
}

async function websiteCredential() {
  const memory = preflightMemoryStore();
  const issuedAt = new Date();
  const credential = await issueDashboardImportPreflight({
    binding: {
      actorId: ACTOR.id,
      workspaceUserId: WORKSPACE_USER_ID,
      module: "website-content",
      revision: 0,
      fileHash: FILE_HASH,
    },
    now: issuedAt,
    ttlSeconds: 300,
    store: memory.store,
  });
  const record = [...memory.rows.values()][0]!;
  return {
    credential,
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
  tickets: Record<string, any>[];
  preflight: Record<string, any>;
  failOnDeliveryUpdate?: number;
}) {
  let committedTickets = input.tickets.map((row) => ({ ...row }));
  let committedPreflight = { ...input.preflight };
  const committedEvents: Record<string, any>[] = [];
  const committedAudits: Record<string, any>[] = [];
  let transactionCount = 0;

  const db = {
    async transaction(callback: (tx: any) => Promise<unknown>) {
      transactionCount += 1;
      const localTickets = committedTickets.map((row) => ({ ...row }));
      const localPreflight = { ...committedPreflight };
      const localEvents: Record<string, any>[] = [];
      const localAudits: Record<string, any>[] = [];
      const localQuotaPeriods = [
        {
          id: "period-1",
          userId: WORKSPACE_USER_ID,
          contractId: "contract-1",
        },
      ];
      let deliveryUpdateCount = 0;
      let deliveryUpdateIndex = 0;
      const rowsFor = (table: unknown) =>
        table === deliveryTickets
          ? localTickets
          : table === dashboardImportPreflights
            ? [localPreflight]
            : table === serviceQuotaPeriods
              ? localQuotaPeriods
              : [];
      const query = (rows: Record<string, any>[]) => {
        const terminal = {
          async for() {
            return rows;
          },
          then(
            resolve: (value: Record<string, any>[]) => unknown,
            reject: (reason: unknown) => unknown,
          ) {
            return Promise.resolve(rows).then(resolve, reject);
          },
        };
        return {
          where() {
            return {
              orderBy() {
                return terminal;
              },
              limit() {
                return {
                  async for() {
                    return rows.slice(0, 1);
                  },
                };
              },
            };
          },
        };
      };
      const tx = {
        select() {
          return {
            from(table: unknown) {
              return query(rowsFor(table));
            },
          };
        },
        update(table: unknown) {
          return {
            set(values: Record<string, any>) {
              return {
                async where() {
                  if (table === deliveryTickets) {
                    deliveryUpdateCount += 1;
                    if (input.failOnDeliveryUpdate === deliveryUpdateCount) {
                      throw new Error("simulated delivery update failure");
                    }
                    const targetIndex = deliveryUpdateIndex++;
                    const target = localTickets[targetIndex]!;
                    localTickets[targetIndex] = { ...target, ...values };
                  } else if (table === dashboardImportPreflights) {
                    Object.assign(localPreflight, values);
                  }
                },
              };
            },
          };
        },
        insert(table: unknown) {
          return {
            async values(values: Record<string, any>) {
              if (table === deliveryTicketEvents) localEvents.push(values);
              if (table === workspaceAuditEvents) localAudits.push(values);
            },
          };
        },
      };
      const result = await callback(tx);
      committedTickets = localTickets;
      committedPreflight = localPreflight;
      committedEvents.push(...localEvents);
      committedAudits.push(...localAudits);
      return result;
    },
  };
  return {
    db,
    get tickets() {
      return committedTickets;
    },
    get preflight() {
      return committedPreflight;
    },
    events: committedEvents,
    audits: committedAudits,
    get transactionCount() {
      return transactionCount;
    },
  };
}

beforeEach(() => {
  dependencies.assertWorkspaceAccess.mockReset().mockResolvedValue(undefined);
  dependencies.getServicePortal
    .mockReset()
    .mockRejectedValue(new Error("current service has expired"));
  dependencies.getDb.mockReset();
});

describe("website content template transactional publication", () => {
  it("rejects users and propagates the managed-workspace ACL before touching the database", async () => {
    const template = createWebsiteContentTemplate({
      workspaceUserId: WORKSPACE_USER_ID,
      rows: [],
      exportedAt: NOW,
    });
    await expect(
      publishWebsiteContentTemplate({
        actor: { ...ACTOR, role: "user" },
        workspaceUserId: WORKSPACE_USER_ID,
        template,
        fileHash: FILE_HASH,
        preflightToken: undefined,
      }),
    ).rejects.toMatchObject({
      code: "WEBSITE_CONTENT_TEMPLATE_ADMIN_REQUIRED",
    });
    expect(dependencies.assertWorkspaceAccess).not.toHaveBeenCalled();
    expect(dependencies.getDb).not.toHaveBeenCalled();

    dependencies.assertWorkspaceAccess.mockRejectedValueOnce(
      new Error("workspace not found"),
    );
    await expect(
      publishWebsiteContentTemplate({
        actor: ACTOR,
        workspaceUserId: WORKSPACE_USER_ID,
        template,
        fileHash: FILE_HASH,
        preflightToken: undefined,
      }),
    ).rejects.toThrow("workspace not found");
    expect(dependencies.getDb).not.toHaveBeenCalled();
  });

  it("completes and corrects multiple records with quota, events, audit and nonce in one transaction", async () => {
    const current = [
      ticket(),
      ticket({
        id: "5f05091b-0e0a-4482-8f11-654c4502b3e1",
        category: "faq_content",
        topic: "FAQ 页面",
        status: "completed",
        quotaState: "consumed",
        publicSummary: "旧总结",
        revision: 5,
      }),
    ];
    const template = createWebsiteContentTemplate({
      workspaceUserId: WORKSPACE_USER_ID,
      rows: current as any,
      exportedAt: NOW,
    });
    template.records[0] = {
      ...template.records[0]!,
      publicSummary: "已完成企业品牌事实内容更新。",
      complete: true,
    };
    template.records[1] = {
      ...template.records[1]!,
      publicSummary: "已修正 FAQ 页面内容总结。",
    };
    const preflight = await websiteCredential();
    const database = transactionalDatabase({
      tickets: current,
      preflight: preflight.row,
    });
    dependencies.getDb.mockResolvedValue(database.db);

    const result = await publishWebsiteContentTemplate({
      actor: ACTOR,
      workspaceUserId: WORKSPACE_USER_ID,
      template,
      fileHash: FILE_HASH,
      preflightToken: preflight.credential.preflightToken,
    });

    expect(dependencies.assertWorkspaceAccess).toHaveBeenCalledWith(
      ACTOR,
      WORKSPACE_USER_ID,
    );
    expect(dependencies.getServicePortal).not.toHaveBeenCalled();
    expect(database.transactionCount).toBe(1);
    expect(result).toMatchObject({
      success: true,
      changed: 2,
      completing: 1,
      summariesUpdated: 2,
    });
    expect(database.tickets[0]).toMatchObject({
      status: "completed",
      quotaState: "consumed",
      publicSummary: "已完成企业品牌事实内容更新。",
      revision: 4,
    });
    expect(database.tickets[1]).toMatchObject({
      status: "completed",
      quotaState: "consumed",
      publicSummary: "已修正 FAQ 页面内容总结。",
      revision: 6,
    });
    expect(database.events).toHaveLength(1);
    expect(database.events[0]).toMatchObject({
      ticketId: current[0]!.id,
      kind: "status_change",
      fromStatus: "submitted",
      toStatus: "completed",
    });
    expect(database.audits.map((event) => event.action)).toEqual([
      "delivery_ticket.status_updated",
      "delivery_ticket.public_summary_updated",
      "workspace.website_content.template_published",
    ]);
    expect(database.preflight.consumedAt).toBeInstanceOf(Date);
  });

  it("requires the full role workbench before completing a role-owned website ticket", async () => {
    const current = [
      ticket({
        workflowDomain: "ai_operations_engineer",
        assignedProjectAssignmentId: "0f627a35-c9cf-41bb-b20f-b42cd91864bb",
        assignedMemberId: 19,
      }),
    ];
    const template = createWebsiteContentTemplate({
      workspaceUserId: WORKSPACE_USER_ID,
      rows: current as any,
      exportedAt: NOW,
    });
    template.records[0] = {
      ...template.records[0]!,
      publicSummary: "不能绕过岗位校验直接完成。",
      complete: true,
    };
    const preflight = await websiteCredential();
    const database = transactionalDatabase({
      tickets: current,
      preflight: preflight.row,
    });
    dependencies.getDb.mockResolvedValue(database.db);

    await expect(
      publishWebsiteContentTemplate({
        actor: ACTOR,
        workspaceUserId: WORKSPACE_USER_ID,
        template,
        fileHash: FILE_HASH,
        preflightToken: preflight.credential.preflightToken,
      }),
    ).rejects.toMatchObject({
      code: "WEBSITE_CONTENT_TEMPLATE_ROLE_WORKBENCH_REQUIRED",
    });

    expect(database.tickets).toEqual(current);
    expect(database.preflight.consumedAt).toBeNull();
    expect(database.events).toHaveLength(0);
    expect(database.audits).toHaveLength(0);
  });

  it("rolls back ticket writes and nonce consumption when any record update fails", async () => {
    const current = [
      ticket(),
      ticket({
        id: "5f05091b-0e0a-4482-8f11-654c4502b3e1",
        category: "faq_content",
        topic: "FAQ 页面",
        revision: 5,
      }),
    ];
    const template = createWebsiteContentTemplate({
      workspaceUserId: WORKSPACE_USER_ID,
      rows: current as any,
      exportedAt: NOW,
    });
    template.records = template.records.map((record, index) => ({
      ...record,
      publicSummary: `第 ${index + 1} 条完成总结`,
      complete: true,
    }));
    const preflight = await websiteCredential();
    const database = transactionalDatabase({
      tickets: current,
      preflight: preflight.row,
      failOnDeliveryUpdate: 2,
    });
    dependencies.getDb.mockResolvedValue(database.db);

    await expect(
      publishWebsiteContentTemplate({
        actor: ACTOR,
        workspaceUserId: WORKSPACE_USER_ID,
        template,
        fileHash: FILE_HASH,
        preflightToken: preflight.credential.preflightToken,
      }),
    ).rejects.toThrow("simulated delivery update failure");

    expect(database.tickets).toEqual(current);
    expect(database.preflight.consumedAt).toBeNull();
    expect(database.events).toHaveLength(0);
    expect(database.audits).toHaveLength(0);
  });
});
