import type { ZhipuThinkingCapture } from "./zhipu-thinking-stream";
import { assertEnterpriseProjectActive } from "../enterprise-project-lifecycle";
import { createHash } from "node:crypto";
import { and, eq, isNull, or, sql } from "drizzle-orm";
import {
  agentOperations,
  agentTasks,
  apiCredentials,
} from "../../drizzle/schema";
import { getDb } from "../db";

export type DashboardProviderIdentity = {
  provider: "manus" | "zhipu";
  accountUserId: number;
  credentialId: string;
  credentialVersion: number;
  credentialOwnerUserId?: number;
  /** Captured when the client is created; asynchronous work never follows UI scope. */
  enterpriseProjectId?: string | null;
  enterpriseProjectLegacyDefault?: boolean;
};
export type DashboardManagedMutation = {
  requestHash: string;
  state: "sending" | "acknowledged" | "rejected" | "outcome_unknown";
  startedAt: string;
  resourceId?: string;
  status?: number | null;
  code?: string;
};
export type DashboardManagedFile = {
  id: string;
  filename: string;
  bytes: number;
  sha256: string;
  contentType: string;
  role: "input" | "output";
  commandKey?: string;
  deleted?: boolean;
  /** Immutable server-provided workflow/knowledge input; browser turns cannot replace its mount. */
  serverOwned?: boolean;
};
export type DashboardManagedCommand = {
  key: string;
  intentId: string;
  prompt: string;
  providerPromptHash: string;
  turnContext?: string | null;
  productIdentityContext?: string | null;
  attachments: Array<{ fileId: string; filename: string; sha256: string }>;
  schema?: Record<string, unknown>;
  beforeEventIds: string[];
  beforeFileIds: string[];
  createdAt: string;
  eventId?: string;
};
export type DashboardManagedRuntime = {
  revision: 1;
  generalIdentitySystem?: string;
  model: string;
  effort: "low" | "high" | "max";
  intentId: string;
  agentId?: string;
  environmentId?: string;
  sessionId?: string;
  title?: string;
  deleted?: boolean;
  mutations: Record<string, DashboardManagedMutation>;
  commands: DashboardManagedCommand[];
  files: DashboardManagedFile[];
  usage?: Record<string, unknown>;
  /** Actual provider thinking transcripts, isolated to the owning command/session. */
  thinkingCaptures?: ZhipuThinkingCapture[];
  observedEventIds?: string[];
  eventCursor?: string;
};
export type DashboardRuntimeRecord = {
  localTaskId: string;
  operationId: string;
  runtime: DashboardManagedRuntime;
};

/** Retain API-delivered text within its owning turn; replay cannot erase it. */
export function retainDashboardThinkingCapture(
  runtime: DashboardManagedRuntime,
  capture: ZhipuThinkingCapture,
): DashboardManagedRuntime {
  if (
    !runtime.generalIdentitySystem ||
    !capture.text.trim() ||
    !runtime.commands.some((command) => command.key === capture.commandKey)
  )
    return runtime;
  const sameCapture = (item: ZhipuThinkingCapture) =>
    item.commandKey === capture.commandKey && item.eventId === capture.eventId;
  const prior = runtime.thinkingCaptures?.find(sameCapture);
  if (
    prior &&
    !capture.authoritativeText &&
    ((!capture.complete && prior.complete) ||
      !capture.text.startsWith(prior.text))
  )
    return runtime;
  return {
    ...runtime,
    thinkingCaptures: [
      ...(runtime.thinkingCaptures ?? []).filter((item) => !sameCapture(item)),
      { ...capture, startedAt: prior?.startedAt ?? capture.startedAt },
    ],
  };
}
export type DashboardRuntimeReservation = {
  generalIdentitySystem?: string;
  identity: DashboardProviderIdentity;
  intentId: string;
  model: string;
  effort: DashboardManagedRuntime["effort"];
  localTaskId?: string;
  operationId?: string;
};
export interface DashboardAgentRuntimeStore {
  reserve(input: DashboardRuntimeReservation): Promise<DashboardRuntimeRecord>;
  findByIntent(
    identity: DashboardProviderIdentity,
    intentId: string,
  ): Promise<DashboardRuntimeRecord | null>;
  findBySession(
    identity: DashboardProviderIdentity,
    sessionId: string,
  ): Promise<DashboardRuntimeRecord | null>;
  findByFile(
    identity: DashboardProviderIdentity,
    fileId: string,
    binding?: {
      localTaskId?: string;
      operationId?: string;
      role?: "input" | "output";
    },
  ): Promise<DashboardRuntimeRecord | null>;
  mutate(
    identity: DashboardProviderIdentity,
    localTaskId: string,
    change: (runtime: DashboardManagedRuntime) => DashboardManagedRuntime,
  ): Promise<DashboardRuntimeRecord>;
}

const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const stableId = (value: string) => {
  const h = hash(value);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
};
const intentHash = (identity: DashboardProviderIdentity, intentId: string) =>
  hash(
    JSON.stringify([
      "dashboard-zhipu-transport",
      identity.accountUserId,
      identity.credentialId,
      identity.credentialVersion,
      ...(identity.enterpriseProjectId ? [identity.enterpriseProjectId] : []),
      intentId,
    ]),
  );
const owned = (identity: DashboardProviderIdentity) =>
  and(
    eq(agentOperations.scope, "managed_user"),
    identity.enterpriseProjectId
      ? eq(agentOperations.enterpriseProjectId, identity.enterpriseProjectId)
      : isNull(agentOperations.enterpriseProjectId),
    eq(agentOperations.accountUserId, identity.accountUserId),
    eq(agentOperations.apiCredentialId, identity.credentialId),
    eq(agentOperations.credentialVersion, identity.credentialVersion),
    eq(agentOperations.provider, "zhipu"),
  );
function decode(row: {
  task: typeof agentTasks.$inferSelect;
  operation: typeof agentOperations.$inferSelect;
}): DashboardRuntimeRecord | null {
  const runtime = row.task.providerRuntime?.dashboardManaged as
    | DashboardManagedRuntime
    | undefined;
  return runtime?.revision === 1
    ? { localTaskId: row.task.id, operationId: row.operation.id, runtime }
    : null;
}
async function database() {
  const db = await getDb();
  if (!db) throw new Error("DATABASE_UNAVAILABLE");
  return db;
}
export function assertDashboardManagedRuntimeImmutable(
  before: DashboardManagedRuntime,
  after: DashboardManagedRuntime,
) {
  if (
    before.revision !== after.revision ||
    before.model !== after.model ||
    before.effort !== after.effort ||
    before.intentId !== after.intentId ||
    before.generalIdentitySystem !== after.generalIdentitySystem
  )
    throw new Error("DASHBOARD_PROVIDER_RUNTIME_CONFLICT");
  for (const key of ["agentId", "environmentId", "sessionId"] as const)
    if (before[key] && before[key] !== after[key])
      throw new Error("DASHBOARD_PROVIDER_IDENTITY_CONFLICT");
  for (const [key, old] of Object.entries(before.mutations)) {
    const next = after.mutations[key];
    if (
      !next ||
      next.requestHash !== old.requestHash ||
      next.startedAt !== old.startedAt ||
      (old.resourceId && old.resourceId !== next.resourceId) ||
      (old.state === "acknowledged" && next.state !== "acknowledged")
    )
      throw new Error("DASHBOARD_PROVIDER_MUTATION_CONFLICT");
  }
  for (const old of before.files) {
    const next = after.files.find((file) => file.id === old.id);
    if (
      !next ||
      old.filename !== next.filename ||
      old.bytes !== next.bytes ||
      old.contentType !== next.contentType ||
      old.role !== next.role ||
      old.commandKey !== next.commandKey ||
      (old.sha256 && old.sha256 !== next.sha256) ||
      (old.serverOwned && !next.serverOwned) ||
      (old.deleted && !next.deleted)
    )
      throw new Error("DASHBOARD_PROVIDER_FILE_CONFLICT");
  }
  for (const old of before.commands) {
    const next = after.commands.find((item) => item.key === old.key);
    if (
      !next ||
      JSON.stringify({ ...old, eventId: undefined }) !==
        JSON.stringify({ ...next, eventId: undefined }) ||
      (old.eventId && old.eventId !== next.eventId)
    )
      throw new Error("DASHBOARD_PROVIDER_COMMAND_CONFLICT");
  }
}

/** Uses the existing tenant-owned operation/task tables. No account-global or
 * API-key-derived lookup can authorize a session or file. The nested namespace
 * leaves the business workflow's runtime fields and status machine intact. */
export const dashboardAgentRuntimeStore: DashboardAgentRuntimeStore = {
  async reserve(input) {
    if (!input.intentId.trim() || input.identity.provider !== "zhipu")
      throw new Error("DASHBOARD_PROVIDER_INTENT_REQUIRED");
    const db = await database();
    return db.transaction(async (tx) => {
      await assertEnterpriseProjectActive(tx, input.identity.enterpriseProjectId, input.identity.accountUserId);
      const [credential] = await tx
        .select({ id: apiCredentials.id })
        .from(apiCredentials)
        .where(
          and(
            eq(apiCredentials.id, input.identity.credentialId),
            eq(
              apiCredentials.userId,
              input.identity.credentialOwnerUserId ??
                input.identity.accountUserId,
            ),
            eq(apiCredentials.version, input.identity.credentialVersion),
            eq(apiCredentials.provider, "zhipu"),
          ),
        )
        .limit(1);
      if (!credential)
        throw new Error("DASHBOARD_PROVIDER_CREDENTIAL_OWNERSHIP");
      const binding = intentHash(input.identity, input.intentId);
      let localTaskId = input.localTaskId;
      if (!localTaskId && !input.operationId && input.identity.enterpriseProjectLegacyDefault && input.identity.enterpriseProjectId) {
        const legacyBinding = intentHash({ ...input.identity, enterpriseProjectId: null }, input.intentId);
        const prior = await tx.select({ id: agentTasks.id })
          .from(agentTasks).innerJoin(agentOperations, eq(agentOperations.id, agentTasks.operationId))
          .where(and(owned(input.identity), or(eq(agentOperations.idempotencyKeyHash, binding), eq(agentOperations.idempotencyKeyHash, legacyBinding))))
          .limit(2).for("update");
        if (prior.length > 1) throw new Error("DASHBOARD_PROVIDER_INTENT_AMBIGUOUS");
        if (prior[0]) localTaskId = prior[0].id;
      }

      if (!localTaskId && input.operationId) {
        const candidates = await tx
          .select({ id: agentTasks.id })
          .from(agentTasks)
          .innerJoin(
            agentOperations,
            eq(agentOperations.id, agentTasks.operationId),
          )
          .where(
            and(
              owned(input.identity),
              eq(agentOperations.id, input.operationId),
            ),
          )
          .limit(2)
          .for("update");
        if (candidates.length !== 1)
          throw new Error("DASHBOARD_PROVIDER_TASK_OWNERSHIP");
        localTaskId = candidates[0]!.id;
      }
      const explicitlyBound = Boolean(localTaskId);
      const operationId = explicitlyBound
        ? input.operationId
        : stableId(`operation:${binding}`);
      localTaskId ??= stableId(`task:${binding}`);
      if (!explicitlyBound) {
        await tx
          .insert(agentOperations)
          .values({
            id: operationId!,
            provider: "zhipu",
            scope: "managed_user",
            accountUserId: input.identity.accountUserId,
            enterpriseProjectId: input.identity.enterpriseProjectId ?? null,
            operationType: "dashboard.provider.transport",
            idempotencyKeyHash: binding,
            requestHash: binding,
            contractName: "dashboard.provider.transport",
            contractRevision: 1,
            schemaHash: hash("dashboard.provider.transport.v1"),
            apiCredentialId: input.identity.credentialId,
            credentialVersion: input.identity.credentialVersion,
            publicProfile: "transport",
            upstreamModel: input.model,
            status: "queued",
          })
          .onDuplicateKeyUpdate({ set: { id: sql`${agentOperations.id}` } });
        await tx
          .insert(agentTasks)
          .values({
            id: localTaskId,
            operationId: operationId!,
            createMarker: binding,
            title: "Dashboard provider transport",
            providerState: "queued",
          })
          .onDuplicateKeyUpdate({ set: { id: sql`${agentTasks.id}` } });
      }
      const [row] = await tx
        .select({ task: agentTasks, operation: agentOperations })
        .from(agentTasks)
        .innerJoin(
          agentOperations,
          eq(agentOperations.id, agentTasks.operationId),
        )
        .where(and(owned(input.identity), eq(agentTasks.id, localTaskId)))
        .limit(1)
        .for("update");
      if (
        !row ||
        (input.localTaskId &&
          input.operationId &&
          row.operation.id !== input.operationId)
      )
        throw new Error("DASHBOARD_PROVIDER_TASK_OWNERSHIP");
      if (row.operation.upstreamModel !== input.model)
        throw new Error("DASHBOARD_PROVIDER_MODEL_CONFLICT");
      const existing = decode(row);
      if (existing) {
        if (
          existing.runtime.model !== input.model ||
          existing.runtime.effort !== input.effort ||
          (!explicitlyBound && existing.runtime.intentId !== input.intentId)
        )
          throw new Error("DASHBOARD_PROVIDER_RUNTIME_CONFLICT");
        return existing;
      }
      const runtime: DashboardManagedRuntime = {
        revision: 1,
        ...(input.generalIdentitySystem
          ? { generalIdentitySystem: input.generalIdentitySystem }
          : {}),
        model: input.model,
        effort: input.effort,
        intentId: input.intentId,
        mutations: {},
        commands: [],
        files: [],
      };
      await tx
        .update(agentTasks)
        .set({
          providerRuntime: {
            ...row.task.providerRuntime,
            dashboardManaged: runtime,
          },
        })
        .where(eq(agentTasks.id, localTaskId));
      return { localTaskId, operationId: row.operation.id, runtime };
    });
  },
  async findByIntent(identity, intentId) {
    const db = await database();
    const rows = await db
      .select({ task: agentTasks, operation: agentOperations })
      .from(agentTasks)
      .innerJoin(
        agentOperations,
        eq(agentOperations.id, agentTasks.operationId),
      )
      .where(
        and(
          owned(identity),
          sql`JSON_UNQUOTE(JSON_EXTRACT(${agentTasks.providerRuntime}, '$.dashboardManaged.intentId')) = ${intentId}`,
        ),
      )
      .limit(2);
    if (rows.length > 1) throw new Error("DASHBOARD_PROVIDER_INTENT_AMBIGUOUS");
    return rows[0] ? decode(rows[0]) : null;
  },
  async findBySession(identity, sessionId) {
    const db = await database();
    const rows = await db
      .select({ task: agentTasks, operation: agentOperations })
      .from(agentTasks)
      .innerJoin(
        agentOperations,
        eq(agentOperations.id, agentTasks.operationId),
      )
      .where(
        and(
          owned(identity),
          sql`JSON_UNQUOTE(JSON_EXTRACT(${agentTasks.providerRuntime}, '$.dashboardManaged.sessionId')) = ${sessionId}`,
        ),
      )
      .limit(2);
    if (rows.length > 1)
      throw new Error("DASHBOARD_PROVIDER_SESSION_AMBIGUOUS");
    return rows[0] ? decode(rows[0]) : null;
  },
  async findByFile(identity, fileId, binding) {
    const db = await database();
    const rows = await db
      .select({ task: agentTasks, operation: agentOperations })
      .from(agentTasks)
      .innerJoin(
        agentOperations,
        eq(agentOperations.id, agentTasks.operationId),
      )
      .where(
        and(
          owned(identity),
          binding?.localTaskId
            ? eq(agentTasks.id, binding.localTaskId)
            : undefined,
          binding?.operationId
            ? eq(agentOperations.id, binding.operationId)
            : undefined,
          sql`JSON_SEARCH(${agentTasks.providerRuntime}, 'one', ${fileId}, NULL, '$.dashboardManaged.files[*].id') IS NOT NULL`,
        ),
      );
    const matches = rows
      .map(decode)
      .filter((row): row is DashboardRuntimeRecord =>
        Boolean(
          row &&
            (!binding?.role ||
              row.runtime.files.some(
                (f) => f.id === fileId && f.role === binding.role,
              )),
        ),
      );
    if (binding?.role === "output" && matches.length > 1)
      throw new Error("DASHBOARD_PROVIDER_ARTIFACT_AMBIGUOUS");
    return matches[0] ?? null;
  },
  async mutate(identity, localTaskId, change) {
    const db = await database();
    return db.transaction(async (tx) => {
      const [row] = await tx
        .select({ task: agentTasks, operation: agentOperations })
        .from(agentTasks)
        .innerJoin(
          agentOperations,
          eq(agentOperations.id, agentTasks.operationId),
        )
        .where(and(owned(identity), eq(agentTasks.id, localTaskId)))
        .limit(1)
        .for("update");
      const record = row ? decode(row) : null;
      if (!record) throw new Error("DASHBOARD_PROVIDER_TASK_OWNERSHIP");
      const next = change(structuredClone(record.runtime));
      assertDashboardManagedRuntimeImmutable(record.runtime, next);
      await tx
        .update(agentTasks)
        .set({
          providerRuntime: {
            ...row.task.providerRuntime,
            ...(next.usage ? { usage: next.usage } : {}),
            dashboardManaged: next,
          },
        })
        .where(eq(agentTasks.id, localTaskId));
      return { ...record, runtime: next };
    });
  },
};
