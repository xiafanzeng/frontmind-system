import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  deliveryProjectAssignments,
  deliveryTicketEvents,
  deliveryTickets,
  jenovaBrandTrackingAssignments,
  jenovaBrandTrackingPolicies,
  jenovaBrandTrackingTurns,
  users,
} from "../drizzle/schema";
import type { AuthenticatedUser } from "./auth-service";
import { JenovaClientError } from "./jenova-brand-tracking-client";
import {
  JENOVA_DEFAULT_ROLLING_LIMIT,
  JENOVA_SESSION_CREATION_FEE,
  JenovaBrandTrackingError,
  addJenovaMoney,
  assertCanManageJenovaBrandTrackingLimit,
  assertJenovaCredentialPoolCapacity,
  assertJenovaBrandTrackingSystemAdmin,
  buildJenovaBrandTrackingKickoff,
  buildJenovaBrandTrackingUsageDto,
  classifyJenovaTurnCompletion,
  findRecoveredJenovaMessage,
  isJenovaBrandTrackingEligibleActor,
  isWithinJenovaRollingWindow,
  isKnownJenovaPreRunRejection,
  jenovaErrorIdentity,
  jenovaCredentialFingerprint,
  jenovaRejectedUsageCost,
  normalizeJenovaBrandTrackingIdentity,
  projectedJenovaActiveCredentialCount,
  recoverJenovaBrandTrackingTurns,
  resolveJenovaCredentialTicketsToComplete,
  startJenovaBrandTrackingSession,
  toJenovaBrandTrackingAuthError,
  updateJenovaBrandTrackingLimit,
} from "./jenova-brand-tracking-service";

const now = new Date("2026-08-09T12:00:00.000Z");

function newSessionReplayDatabase(replayRow?: Record<string, unknown>) {
  const insert = vi.fn(() => {
    throw new Error("unexpected brand-tracking insert");
  });
  const update = vi.fn(() => {
    throw new Error("unexpected brand-tracking update");
  });
  const database: any = {
    insert,
    update,
    transaction: async (callback: (tx: unknown) => unknown) =>
      callback(database),
    select: () => {
      let table: unknown;
      const chain: any = {
        from: (value: unknown) => {
          table = value;
          return chain;
        },
        innerJoin: () => chain,
        where: () => chain,
        limit: () => chain,
        for: async () => {
          if (table === users) {
            return [
              {
                id: 7,
                role: "user",
                isActive: true,
                marketEdition: "overseas",
              },
            ];
          }
          if (table === jenovaBrandTrackingTurns) {
            return replayRow ? [replayRow] : [];
          }
          throw new Error("unexpected brand-tracking select");
        },
      };
      return chain;
    },
  };
  return { database, insert, update };
}

function actor(overrides: Partial<AuthenticatedUser> = {}): AuthenticatedUser {
  return {
    id: 7,
    openId: null,
    username: "overseas-user",
    displayName: "海外客户",
    name: "海外客户",
    email: null,
    loginMethod: "password",
    role: "user",
    adminAccessLevel: null,
    engineerRoleType: null,
    marketEdition: "overseas",
    isActive: true,
    createdAt: now,
    updatedAt: now,
    lastSignedIn: now,
    ...overrides,
  };
}

function usageNumbers(
  overrides: Partial<{
    rolling30DayCost: string;
    lifetimeCost: string;
    limit: string;
    pendingReconciliationCount: number;
    keyConfigured: boolean;
  }> = {},
) {
  return {
    rolling30DayCost: "1.25000000",
    lifetimeCost: "2.50000000",
    limit: JENOVA_DEFAULT_ROLLING_LIMIT,
    pendingReconciliationCount: 0,
    keyConfigured: true,
    windowStartedAt: new Date(now.getTime() - 30 * 86_400_000),
    windowEndsAt: now,
    ...overrides,
  };
}

describe("Jenova Brand Tracker service invariants", () => {
  it("normalizes the dashboard brand and builds the exact hidden kickoff", () => {
    expect(
      normalizeJenovaBrandTrackingIdentity("  Ｆｒｏｎｔ\n\u0000  Mind  "),
    ).toBe("Front Mind");
    expect(buildJenovaBrandTrackingKickoff("  示例\t品牌  ")).toBe(
      [
        "请按以下设置直接启动品牌追踪：",
        "1. 要追踪的品牌、产品或公司名称：示例 品牌",
        "2. 名称变体：不确定",
        "3. 平台：全部",
        "4. 时间范围：过去7天",
      ].join("\n"),
    );
    expect(() => buildJenovaBrandTrackingKickoff("\n\u0000\t")).toThrowError(
      expect.objectContaining({
        code: "BRAND_IDENTITY_REQUIRED",
        statusCode: 422,
      }),
    );
    expect(() =>
      buildJenovaBrandTrackingKickoff("品".repeat(161)),
    ).toThrowError(
      expect.objectContaining({ code: "BRAND_IDENTITY_REQUIRED" }),
    );
  });

  it("fails closed on a missing dashboard brand before turns, spend, or upstream work", async () => {
    const { database, insert, update } = newSessionReplayDatabase();
    const getDashboardWorkspace = vi.fn(async () => ({
      payload: { brandName: "\n\u0000\t" },
    }));
    const streamMessage = vi.fn();

    await expect(
      startJenovaBrandTrackingSession({
        actor: actor(),
        clientRequestId: "11111111-1111-4111-8111-111111111111",
        emit: vi.fn(),
        dependencies: {
          getDatabase: async () => database as never,
          getDashboardWorkspace: getDashboardWorkspace as never,
          client: {
            validateKey: vi.fn(),
            getBalance: vi.fn(),
            streamMessage,
            getSessionRun: vi.fn(),
            listSessionMessages: vi.fn(),
          },
        },
      }),
    ).rejects.toMatchObject({
      code: "BRAND_IDENTITY_REQUIRED",
      statusCode: 422,
    });

    expect(getDashboardWorkspace).toHaveBeenCalledWith(7);
    expect(insert).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(streamMessage).not.toHaveBeenCalled();
  });

  it("replays a frozen legacy kickoff without rereading a changed dashboard brand", async () => {
    const replayRow = {
      turn: {
        id: "turn-legacy",
        sessionId: "session-legacy",
        userId: 7,
        hiddenKickoff: true,
        userContent: "开始品牌追踪",
        assistantContent: "已恢复旧会话",
        status: "completed",
        costState: "confirmed",
        usageCost: "0.02000000",
        sessionFee: "0.01000000",
        createdAt: now,
      },
      session: {
        id: "session-legacy",
        title: "品牌追踪会话",
        status: "active",
      },
      credential: { id: "credential-legacy" },
    };
    const { database, insert, update } = newSessionReplayDatabase(replayRow);
    const getDashboardWorkspace = vi.fn();
    const emit = vi.fn();

    await startJenovaBrandTrackingSession({
      actor: actor(),
      clientRequestId: "11111111-1111-4111-8111-111111111111",
      emit,
      dependencies: {
        getDatabase: async () => database as never,
        getDashboardWorkspace: getDashboardWorkspace as never,
      },
    });

    expect(getDashboardWorkspace).not.toHaveBeenCalled();
    expect(insert).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({ event: "delta" }),
    );
    expect(emit).toHaveBeenLastCalledWith({
      event: "end",
      data: {
        sessionId: "session-legacy",
        messageId: "turn-legacy:assistant",
        status: "completed",
      },
    });
  });

  it("allows only active system administrators to configure Jenova keys", () => {
    expect(() =>
      assertJenovaBrandTrackingSystemAdmin(
        actor({
          role: "admin",
          adminAccessLevel: "system_admin",
          marketEdition: "domestic",
        }),
      ),
    ).not.toThrow();
    expect(() =>
      assertJenovaBrandTrackingSystemAdmin(
        actor({
          role: "admin",
          adminAccessLevel: "delivery_admin",
          marketEdition: "domestic",
        }),
      ),
    ).toThrowError(expect.objectContaining({ code: "FORBIDDEN" }));
    expect(() =>
      assertJenovaBrandTrackingSystemAdmin(
        actor({
          role: "admin",
          adminAccessLevel: "system_admin",
          marketEdition: "domestic",
          isActive: false,
        }),
      ),
    ).toThrowError(expect.objectContaining({ code: "FORBIDDEN" }));
  });

  it("auto-closes each unique active Jenova credential ticket without title inference", () => {
    const tickets = [
      {
        id: "ticket-7",
        userId: 7,
        credentialTargetUserId: 7,
        credentialRequestKind: "jenova_brand_tracking",
        status: "submitted",
      },
      {
        id: "ticket-8",
        userId: 8,
        credentialTargetUserId: 8,
        credentialRequestKind: "jenova_brand_tracking",
        status: "in_progress",
      },
    ];

    expect(
      resolveJenovaCredentialTicketsToComplete({
        userIds: [7],
        activeTickets: tickets,
      }),
    ).toEqual([tickets[0]]);
    expect(
      resolveJenovaCredentialTicketsToComplete({
        userIds: [7, 8],
        activeTickets: tickets,
      }),
    ).toEqual(tickets);
  });

  it("requires an exact related ticket and rejects duplicate active tickets", () => {
    const ticket = {
      id: "ticket-7",
      userId: 7,
      credentialTargetUserId: 7,
      credentialRequestKind: "jenova_brand_tracking",
      status: "scheduled",
    };
    expect(
      resolveJenovaCredentialTicketsToComplete({
        userIds: [7],
        activeTickets: [ticket],
        relatedTicketId: ticket.id,
      }),
    ).toEqual([ticket]);
    expect(() =>
      resolveJenovaCredentialTicketsToComplete({
        userIds: [7],
        activeTickets: [ticket],
        relatedTicketId: "different-ticket",
      }),
    ).toThrowError(
      expect.objectContaining({ code: "CONFLICT", statusCode: 409 }),
    );
    expect(() =>
      resolveJenovaCredentialTicketsToComplete({
        userIds: [7],
        activeTickets: [ticket, { ...ticket, id: "ticket-7-duplicate" }],
      }),
    ).toThrowError(
      expect.objectContaining({ code: "CONFLICT", statusCode: 409 }),
    );
    expect(
      toJenovaBrandTrackingAuthError(
        new JenovaBrandTrackingError("CONFLICT", "存在重复工单", 409),
      ),
    ).toMatchObject({ code: "CONFLICT" });
  });

  it("updates only the Jenova policy when an engineer changes the limit", async () => {
    const selectedTables: unknown[] = [];
    const insertedTables: unknown[] = [];
    const updatedTables: unknown[] = [];
    let turnQueryCount = 0;
    const rowsFor = (table: unknown) => {
      if (table === deliveryProjectAssignments) {
        return [
          {
            customerUserId: 7,
            engineerUserId: 19,
            roleType: "ai_operations_engineer",
            customerRole: "user",
            customerMarketEdition: "overseas",
            customerIsActive: true,
          },
        ];
      }
      if (table === jenovaBrandTrackingPolicies) {
        return [{ limit: "6.00000000" }];
      }
      if (table === jenovaBrandTrackingTurns) {
        turnQueryCount += 1;
        return turnQueryCount === 1
          ? [{ cost: "1.00000000", pending: 0 }]
          : [{ cost: "2.00000000" }];
      }
      if (table === jenovaBrandTrackingAssignments) {
        return [{ credentialId: "credential-1" }];
      }
      throw new Error("unexpected select table");
    };
    const database: any = {
      select: () => {
        let table: unknown;
        const query: any = {
          from: (value: unknown) => {
            table = value;
            selectedTables.push(value);
            return query;
          },
          innerJoin: () => query,
          where: () => query,
          limit: () => query,
          for: () => query,
          then: (resolve: (rows: unknown[]) => unknown, reject: unknown) =>
            Promise.resolve(rowsFor(table)).then(resolve, reject as never),
        };
        return query;
      },
      insert: (table: unknown) => {
        insertedTables.push(table);
        const mutation: any = {
          values: () => mutation,
          onDuplicateKeyUpdate: async () => undefined,
        };
        return mutation;
      },
      update: (table: unknown) => {
        updatedTables.push(table);
        throw new Error("limit updates must not update delivery records");
      },
      transaction: async (callback: (tx: unknown) => unknown) =>
        callback(database),
    };

    const result = await updateJenovaBrandTrackingLimit({
      actor: actor({
        id: 19,
        role: "delivery_member",
        engineerRoleType: "ai_operations_engineer",
        marketEdition: "domestic",
      }),
      projectAssignmentId: "assignment-1",
      limit: "6",
      dependencies: {
        getDatabase: async () => database,
        now: () => now,
      },
    });

    expect(result).toMatchObject({
      customerUserId: 7,
      usage: { limit: "6.00000000" },
    });
    expect(insertedTables).toEqual([jenovaBrandTrackingPolicies]);
    expect(updatedTables).toEqual([]);
    expect(selectedTables).not.toContain(deliveryTickets);
    expect(selectedTables).not.toContain(deliveryTicketEvents);
  });

  it("contains no ticket creation path for Jenova limit changes", async () => {
    const source = await readFile(
      path.resolve(process.cwd(), "server/jenova-brand-tracking-service.ts"),
      "utf8",
    );
    const limitMutation = source.slice(
      source.indexOf("export async function updateJenovaBrandTrackingLimit"),
      source.indexOf("type ReservedTurn"),
    );

    expect(limitMutation).toContain(".insert(jenovaBrandTrackingPolicies)");
    expect(limitMutation).not.toContain("deliveryTickets");
    expect(limitMutation).not.toContain("deliveryTicketEvents");
    expect(source).not.toMatch(/\.insert\(deliveryTickets\)/u);
  });

  it("allows only active overseas customer actors to read conversations", () => {
    expect(isJenovaBrandTrackingEligibleActor(actor())).toBe(true);
    expect(
      isJenovaBrandTrackingEligibleActor(actor({ marketEdition: "domestic" })),
    ).toBe(false);
    expect(isJenovaBrandTrackingEligibleActor(actor({ isActive: false }))).toBe(
      false,
    );
    expect(
      isJenovaBrandTrackingEligibleActor(
        actor({ role: "delivery_member", marketEdition: "overseas" }),
      ),
    ).toBe(false);
  });

  it("uses exact 8-place strings and attributes shared-key costs per user", () => {
    const userACost = addJenovaMoney("0.12000000", JENOVA_SESSION_CREATION_FEE);
    const userBCost = addJenovaMoney("0.34000000", JENOVA_SESSION_CREATION_FEE);
    const sharedKeyAttributedCost = addJenovaMoney(userACost, userBCost);

    expect(userACost).toBe("0.13000000");
    expect(userBCost).toBe("0.35000000");
    expect(sharedKeyAttributedCost).toBe("0.48000000");
    expect(userACost).not.toBe(sharedKeyAttributedCost);
  });

  it("blocks a zero limit, allows one-turn overshoot, then blocks the next turn", () => {
    const paused = buildJenovaBrandTrackingUsageDto(
      usageNumbers({ rolling30DayCost: "0.00000000", limit: "0.00000000" }),
    );
    expect(paused).toMatchObject({
      blocked: true,
      blockReason: "最近 30 天品牌追踪积分已达到上限",
      remaining: "0.00000000",
      exceededBy: "0.00000000",
    });

    const beforeTurn = buildJenovaBrandTrackingUsageDto(
      usageNumbers({ rolling30DayCost: "9.99000000" }),
    );
    expect(beforeTurn.blocked).toBe(false);

    const afterOvershoot = buildJenovaBrandTrackingUsageDto(
      usageNumbers({ rolling30DayCost: "10.25000000" }),
    );
    expect(afterOvershoot).toMatchObject({
      blocked: true,
      blockReason: "最近 30 天品牌追踪积分已达到上限",
      remaining: "0.00000000",
      exceededBy: "0.25000000",
    });
  });

  it("uses an inclusive [now-30d, now] rolling window", () => {
    expect(
      isWithinJenovaRollingWindow(
        new Date(now.getTime() - 30 * 86_400_000),
        now,
      ),
    ).toBe(true);
    expect(isWithinJenovaRollingWindow(now, now)).toBe(true);
    expect(
      isWithinJenovaRollingWindow(
        new Date(now.getTime() - 30 * 86_400_000 - 1),
        now,
      ),
    ).toBe(false);
    expect(isWithinJenovaRollingWindow(new Date(now.getTime() + 1), now)).toBe(
      false,
    );
  });

  it("blocks unknown usage and never represents it as zero", () => {
    const usage = buildJenovaBrandTrackingUsageDto(
      usageNumbers({ pendingReconciliationCount: 1 }),
    );
    expect(usage).toMatchObject({
      blocked: true,
      hasUnknownUsage: true,
      pendingReconciliationCount: 1,
    });
    expect(usage.blockReason).toBe("上一轮积分仍在核对，暂时不能发送新消息");
  });

  it("records failed turns when Jenova supplies cost but reconciles missing cost", () => {
    expect(
      classifyJenovaTurnCompletion({
        success: false,
        usageCost: "0.12500000",
        hasStreamError: true,
      }),
    ).toEqual({
      usageKnown: true,
      status: "failed",
      costState: "confirmed",
    });
    expect(
      classifyJenovaTurnCompletion({
        success: false,
        usageCost: null,
        hasStreamError: true,
      }),
    ).toEqual({
      usageKnown: false,
      status: "recovering",
      costState: "unknown",
    });
  });

  it("treats an explicit continuation HTTP rejection as known zero usage", () => {
    const rejected = new JenovaClientError(
      "UPSTREAM_REJECTED",
      "insufficient credits",
      402,
    );
    expect(
      isKnownJenovaPreRunRejection({
        error: rejected,
        sawUpstreamEvent: false,
        upstreamRunId: null,
      }),
    ).toBe(true);
    expect(
      isKnownJenovaPreRunRejection({
        error: rejected,
        sawUpstreamEvent: true,
        upstreamRunId: null,
      }),
    ).toBe(false);
    expect(
      isKnownJenovaPreRunRejection({
        error: new JenovaClientError("INVALID_KEY", "revoked", 401),
        sawUpstreamEvent: false,
        upstreamRunId: null,
      }),
    ).toBe(true);
    expect(
      isKnownJenovaPreRunRejection({
        error: new JenovaClientError(
          "UPSTREAM_REJECTED",
          "idempotency conflict",
          409,
        ),
        sawUpstreamEvent: false,
        upstreamRunId: null,
      }),
    ).toBe(false);
    expect(
      jenovaRejectedUsageCost(
        new JenovaClientError(
          "UPSTREAM_REJECTED",
          "failed with cost",
          402,
          false,
          "insufficient_credits",
          { data: { error: { usage: { cost: "0.125" } } } },
        ),
      ),
    ).toBe("0.12500000");
    expect(
      jenovaErrorIdentity(
        new JenovaClientError(
          "UPSTREAM_REJECTED",
          "existing request",
          409,
          false,
          "idempotency_conflict",
          {
            idempotency: {
              status: "accepted",
              session_id: "session_1",
              run_id: "run_1",
            },
          },
        ),
      ),
    ).toEqual({ sessionId: "session_1", runId: "run_1" });
  });

  it("never copies an earlier agent reply into an unknown turn during recovery", () => {
    const turn = {
      upstreamRunId: null,
      startedAt: new Date("2026-08-09T12:00:00.000Z"),
      createdAt: new Date("2026-08-09T12:00:00.000Z"),
      userContent: "本轮问题",
    };
    const messages = [
      {
        id: "old-agent",
        from: { type: "agent" },
        content: "上一轮回答",
        created_at: "2026-08-09T11:59:59.000Z",
      },
      {
        id: "current-user",
        from: { type: "external" },
        content: "本轮问题",
        created_at: "2026-08-09T12:00:00.100Z",
      },
      {
        id: "current-agent",
        from: { type: "agent" },
        content: "本轮回答",
        created_at: "2026-08-09T12:00:01.000Z",
      },
    ];
    expect(findRecoveredJenovaMessage(messages, turn)).toMatchObject({
      id: "current-agent",
      content: "本轮回答",
    });
    expect(findRecoveredJenovaMessage([messages[0]!], turn)).toBeUndefined();
    expect(
      findRecoveredJenovaMessage(
        [
          {
            run_id: "run_1",
            from: { type: "external" },
            content: "问题",
            created_at: "2026-08-09T12:00:00.100Z",
          },
          {
            run_id: "run_1",
            from: { type: "agent" },
            content: "正确回答",
            created_at: "2026-08-09T12:00:01.000Z",
          },
        ],
        { ...turn, upstreamRunId: "run_1" },
      ),
    ).toMatchObject({ content: "正确回答" });
  });

  it("deduplicates physical keys by fingerprint and enforces ten active keys", () => {
    expect(jenovaCredentialFingerprint("jnv_sk_same")).toBe(
      jenovaCredentialFingerprint(" jnv_sk_same "),
    );
    expect(jenovaCredentialFingerprint("jnv_sk_same")).not.toBe(
      jenovaCredentialFingerprint("jnv_sk_other"),
    );
    expect(() => assertJenovaCredentialPoolCapacity(9, false)).not.toThrow();
    expect(() => assertJenovaCredentialPoolCapacity(10, true)).not.toThrow();
    expect(projectedJenovaActiveCredentialCount(10, 1)).toBe(9);
    expect(() =>
      assertJenovaCredentialPoolCapacity(
        projectedJenovaActiveCredentialCount(10, 1),
        false,
      ),
    ).not.toThrow();
    expect(() => assertJenovaCredentialPoolCapacity(10, false)).toThrowError(
      expect.objectContaining({ code: "LIMIT_EXCEEDED" }),
    );
  });

  it("allows only the assigned AI operations engineer or system admin to set limits", () => {
    const authority = {
      customerUserId: 7,
      engineerUserId: 19,
      roleType: "ai_operations_engineer" as const,
      customerRole: "user" as const,
      customerMarketEdition: "overseas" as const,
      customerIsActive: true,
    };
    const engineer = actor({
      id: 19,
      role: "delivery_member",
      marketEdition: "domestic",
      engineerRoleType: "ai_operations_engineer",
    });
    expect(() =>
      assertCanManageJenovaBrandTrackingLimit({ actor: engineer, authority }),
    ).not.toThrow();
    expect(() =>
      assertCanManageJenovaBrandTrackingLimit({
        actor: { ...engineer, id: 20 },
        authority,
      }),
    ).toThrowError(expect.objectContaining({ code: "FORBIDDEN" }));
    expect(() =>
      assertCanManageJenovaBrandTrackingLimit({
        actor: actor({
          role: "admin",
          adminAccessLevel: "system_admin",
          marketEdition: "domestic",
        }),
        authority,
      }),
    ).not.toThrow();
  });

  it("surfaces service errors with stable HTTP metadata", () => {
    const error = new JenovaBrandTrackingError(
      "USAGE_UNKNOWN",
      "积分待确认",
      503,
    );
    expect(error).toMatchObject({ code: "USAGE_UNKNOWN", statusCode: 503 });
  });

  it("never POSTs an identity-less recovering turn during repeated sweeps", async () => {
    const row = {
      turn: {
        id: "turn-1",
        sessionId: "session-1",
        userId: 7,
        credentialId: "credential-1",
        clientRequestId: "11111111-1111-4111-8111-111111111111",
        idempotencyKey: "brand-tracking:7:11111111-1111-4111-8111-111111111111",
        upstreamRunId: null,
        hiddenKickoff: true,
        userContent: "开始品牌追踪",
        assistantContent: "",
        status: "recovering",
        costState: "unknown",
        usageCost: null,
        sessionFee: "0.00000000",
        progress: null,
        warnings: null,
        stopReason: null,
        errorCode: "STREAM_INTERRUPTED",
        errorMessage: "interrupted",
        startedAt: now,
        completedAt: null,
        createdAt: now,
        updatedAt: now,
      },
      session: {
        id: "session-1",
        userId: 7,
        credentialId: "credential-1",
        clientRequestId: "11111111-1111-4111-8111-111111111111",
        upstreamSessionId: null,
        title: "品牌追踪会话",
        status: "active",
        archivedReason: null,
        archivedAt: null,
        createdAt: now,
        updatedAt: now,
      },
      credential: {
        id: "credential-1",
        encryptionVersion: 1,
        encryptedKey: "ciphertext",
        encryptionIv: "iv",
        encryptionAuthTag: "tag",
        fingerprint: "jfp_test",
        status: "active",
        validationStatus: "verified",
        lastBalance: null,
        validatedAt: now,
        balanceSyncedAt: null,
        revokedAt: null,
        createdByUserId: 1,
        createdAt: now,
        updatedAt: now,
      },
    };
    const selectChain: any = {
      from: () => selectChain,
      innerJoin: () => selectChain,
      where: () => selectChain,
      orderBy: () => selectChain,
      limit: async () => [row],
    };
    const updateChain: any = {
      set: () => updateChain,
      where: async () => ({ affectedRows: 0 }),
    };
    const database = {
      select: () => selectChain,
      update: () => updateChain,
    };
    let streamCalls = 0;
    const client = {
      validateKey: async () => ({ balance: "1.00000000", agent: {} }),
      getBalance: async () => "1.00000000",
      streamMessage: async () => {
        streamCalls += 1;
      },
      getSessionRun: async () => ({}),
      listSessionMessages: async () => [],
    };

    await recoverJenovaBrandTrackingTurns({
      getDatabase: async () => database as never,
      client,
      now: () => now,
    });
    await recoverJenovaBrandTrackingTurns({
      getDatabase: async () => database as never,
      client,
      now: () => now,
    });
    expect(streamCalls).toBe(0);
  });

  it("rotates more than 50 permanently unresolved turns through bounded sweeps", async () => {
    const rows = Array.from({ length: 51 }, (_, index) => ({
      turn: {
        id: `turn-${index + 1}`,
        sessionId: `session-${index + 1}`,
        userId: index + 1,
        credentialId: `credential-${index + 1}`,
        clientRequestId: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
        idempotencyKey: `brand-tracking:${index + 1}:request-${index + 1}`,
        upstreamRunId: null,
        hiddenKickoff: true,
        userContent: "开始品牌追踪",
        assistantContent: "",
        status: "recovering",
        costState: "unknown",
        usageCost: null,
        sessionFee: "0.00000000",
        progress: null,
        warnings: null,
        stopReason: null,
        errorCode: "identity_missing",
        errorMessage: "等待对账",
        startedAt: now,
        completedAt: null,
        createdAt: now,
        updatedAt: new Date(now.getTime() - (51 - index) * 60_000),
      },
      session: {
        id: `session-${index + 1}`,
        userId: index + 1,
        credentialId: `credential-${index + 1}`,
        clientRequestId: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
        upstreamSessionId: null,
        title: "品牌追踪会话",
        status: "active",
        archivedReason: null,
        archivedAt: null,
        createdAt: now,
        updatedAt: now,
      },
      credential: {
        id: `credential-${index + 1}`,
        encryptionVersion: 1,
        encryptedKey: "ciphertext",
        encryptionIv: "iv",
        encryptionAuthTag: "tag",
        fingerprint: `jfp_${index + 1}`,
        status: "active",
        validationStatus: "verified",
        lastBalance: null,
        validatedAt: now,
        balanceSyncedAt: null,
        revokedAt: null,
        createdByUserId: 1,
        createdAt: now,
        updatedAt: now,
      },
    }));
    let currentBatch: typeof rows = [];
    let updateCursor = 0;
    const attemptedTurnIds: string[] = [];
    const selectChain: any = {
      from: () => selectChain,
      innerJoin: () => selectChain,
      where: () => selectChain,
      orderBy: () => selectChain,
      limit: async (limit: number) => {
        currentBatch = [...rows]
          .sort(
            (left, right) =>
              left.turn.updatedAt.getTime() - right.turn.updatedAt.getTime(),
          )
          .slice(0, limit);
        updateCursor = 0;
        return currentBatch;
      },
    };
    const database = {
      select: () => selectChain,
      update: () => {
        let changes: Record<string, unknown> = {};
        const updateChain: any = {
          set: (value: Record<string, unknown>) => {
            changes = value;
            return updateChain;
          },
          where: async () => {
            const row = currentBatch[updateCursor];
            if (changes.status !== "revoked" && changes.updatedAt && row) {
              row.turn.updatedAt = changes.updatedAt as Date;
              attemptedTurnIds.push(row.turn.id);
              updateCursor += 1;
            }
            return { affectedRows: 1 };
          },
        };
        return updateChain;
      },
    };
    const client = {
      validateKey: async () => ({ balance: "1.00000000", agent: {} }),
      getBalance: async () => "1.00000000",
      streamMessage: async () => undefined,
      getSessionRun: async () => ({}),
      listSessionMessages: async () => [],
    };

    const first = await recoverJenovaBrandTrackingTurns(
      { getDatabase: async () => database as never, client, now: () => now },
      50,
    );
    const second = await recoverJenovaBrandTrackingTurns(
      { getDatabase: async () => database as never, client, now: () => now },
      50,
    );

    expect(first).toMatchObject({ scanned: 50, unresolved: 50 });
    expect(second).toMatchObject({ scanned: 50, unresolved: 50 });
    expect(attemptedTurnIds.slice(0, 50)).not.toContain("turn-51");
    expect(attemptedTurnIds.slice(50)).toContain("turn-51");
  });
});
