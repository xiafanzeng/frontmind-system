import { assertEnterpriseProjectActive } from "./enterprise-project-lifecycle";
import { AuthServiceError } from "./auth-service";
import { createHash, randomUUID } from "node:crypto";
import { and, eq, gte, inArray, lt, sql } from "drizzle-orm";
import {
  agentOperations,
  agentTasks,
  aiChargeCommands,
  aiCostEvents,
  aiWalletLedger,
} from "../drizzle/schema";
import { unifiedMoneyWallets as moneyWallets } from "../drizzle/schema";
import { ensureDashboardAccountLink } from "../../../packages/monitoring-db/src/dashboard-account-links";
import { getDb } from "./db";
import {
  applyCostRemainder,
  formatCostCny,
  nativeTokens,
  zhipuCostNanos,
  ZHIPU_PRICING_SOURCE,
  ZHIPU_PRICING_VERSION,
  type NativeTokens,
} from "./zhipu-cost";

type Identity = {
  accountUserId: number;
  credentialId: string;
  credentialVersion: number;
  enterpriseProjectId?: string | null;
  enterpriseProjectLegacyDefault?: boolean;
};
type CommandInput = {
  identity: Identity;
  localTaskId: string;
  operationId: string;
  sessionId: string;
  commandKey: string;
  model: string;
  effort: string;
};
type Observation = {
  identity?: Identity;
  localTaskId: string;
  operationId: string;
  sessionId: string;
  model: string;
  commands: Array<{
    key: string;
    eventId?: string;
    createdAt: string;
    providerPromptHash?: string;
    beforeEventIds?: string[];
  }>;
  events: Record<string, unknown>[];
  session: Record<string, unknown>;
};
const stableId = (value: string) => {
  const bytes = createHash("sha256").update(value).digest();
  bytes[6] = (bytes[6]! & 15) | 80;
  bytes[8] = (bytes[8]! & 63) | 128;
  const h = bytes.subarray(0, 16).toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
};
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
async function database() {
  const db = await getDb();
  if (!db) throw new Error("AI_BILLING_DATABASE_UNAVAILABLE");
  return db;
}
export class AiBillingError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "AiBillingError";
  }
}
export type AiBillingPause = {
  reason: "balance" | "cost";
  stage: "before_send" | "after_send";
  commandKey: string;
  sessionId: string;
  pausedAt: string;
};
export class AiBillingPausedError extends AiBillingError {
  constructor(readonly pause: AiBillingPause) {
    super(pause.reason === "balance" ? "AI_BALANCE_PAUSED" : "AI_COST_PENDING");
  }
}
export async function assertAiAccountFunds(
  accountUserId: number,
): Promise<void> {
  const db = await database();
  const link = await ensureDashboardAccountLink(db as any, accountUserId);
  await db.transaction(async (tx) => {
    await configuration(tx);
    const wallet = await lockWallet(tx, link.monitoringUserId);
    if (
      wallet.balanceTenThousandths -
        wallet.reservedTenThousandths -
        wallet.frozenTenThousandths <=
      0n
    )
      throw new AiBillingError("AI_BALANCE_INSUFFICIENT");
  });
}
async function configuration(tx: any) {
  const [rows] =
    await tx.execute(sql`SELECT c.mode, c.enabled_at AS enabledAt, c.initial_reserve_ten_thousandths AS reserveAmount,
    c.refill_ratio_basis_points AS refillRatio, f.mode AS walletMode
    FROM ai_billing_configuration c JOIN unified_finance_state f ON f.id=1 WHERE c.id=1`);
  const config = rows[0];
  if (!config || config.mode !== "active" || config.walletMode !== "active")
    throw new AiBillingError("AI_BILLING_NOT_ACTIVE");
  return {
    enabledAt: new Date(config.enabledAt),
    reserveAmount: BigInt(config.reserveAmount),
    refillRatio: BigInt(config.refillRatio),
  };
}
async function ownedOperation(
  tx: any,
  input: Pick<Observation, "identity" | "operationId" | "localTaskId">,
) {
  const [row] = await tx
    .select({ operation: agentOperations, task: agentTasks })
    .from(agentTasks)
    .innerJoin(agentOperations, eq(agentOperations.id, agentTasks.operationId))
    .where(
      and(
        eq(agentTasks.id, input.localTaskId),
        eq(agentOperations.id, input.operationId),
        eq(agentOperations.provider, "zhipu"),
      ),
    )
    .limit(1)
    .for("update");
  if (
    !row ||
    (input.identity
      ? row.operation.scope !== "managed_user" ||
        row.operation.accountUserId !== input.identity.accountUserId ||
        row.operation.apiCredentialId !== input.identity.credentialId ||
        row.operation.credentialVersion !== input.identity.credentialVersion
      : row.operation.scope !== "website_frontend")
  )
    throw new AiBillingError("AI_BILLING_TASK_OWNERSHIP");
  if (input.identity) {
    const expected = input.identity.enterpriseProjectId ?? null;
    const actual = row.operation.enterpriseProjectId ?? null;
    if (
      actual !== expected &&
      !(input.identity.enterpriseProjectLegacyDefault && actual === null)
    )
      throw new AiBillingError("AI_BILLING_PROJECT_OWNERSHIP");
  }
  return row.operation;
}
async function lockWallet(tx: any, userId: string) {
  const [wallet] = await tx
    .select()
    .from(moneyWallets)
    .where(eq(moneyWallets.userId, userId))
    .limit(1)
    .for("update");
  if (!wallet) throw new AiBillingError("AI_BILLING_WALLET_MISSING");
  return wallet as typeof moneyWallets.$inferSelect;
}
async function ledger(
  tx: any,
  input: {
    userId: string;
    commandId: string;
    type: "reserve" | "consume" | "release";
    balanceDelta: bigint;
    reservedDelta: bigint;
    balanceAfter: bigint;
    key: string;
    reason: string;
    referenceId?: string;
  },
) {
  await tx.insert(aiWalletLedger).values({
    id: stableId(input.key),
    userId: input.userId,
    commandId: input.commandId,
    type: input.type,
    balanceDeltaTenThousandths: input.balanceDelta,
    reservedDeltaTenThousandths: input.reservedDelta,
    balanceAfterTenThousandths: input.balanceAfter,
    idempotencyKey: input.key,
    reason: input.reason,
    referenceId: input.referenceId,
  });
}
/** Called only by the durable provider dispatch fence, before the external POST. */
export async function authorizeManagedAiCommand(
  input: CommandInput,
): Promise<void> {
  if (
    zhipuCostNanos(input.model, {
      inputTokens: 0n,
      outputTokens: 0n,
      cacheReadInputTokens: 0n,
      cacheCreationInputTokens: 0n,
    }) === null
  )
    throw new AiBillingError("AI_MODEL_PRICE_UNAVAILABLE");
  const db = await database();
  await registerAiUsageTask(input.localTaskId);
  const link = await ensureDashboardAccountLink(
    db as any,
    input.identity.accountUserId,
  );
  await db
    .transaction(async (tx) => {
      try {
        await assertEnterpriseProjectActive(
          tx,
          input.identity.enterpriseProjectId,
          input.identity.accountUserId,
        );
      } catch (error) {
        if (error instanceof AuthServiceError && error.code === "NOT_FOUND")
          throw new AiBillingError("AI_BILLING_PROJECT_OWNERSHIP");
        throw error;
      }
      const config = await configuration(tx);
      const operation = await ownedOperation(tx, input);
      const [ownedTask] = await tx
        .select({ runtime: agentTasks.providerRuntime })
        .from(agentTasks)
        .where(eq(agentTasks.id, input.localTaskId))
        .limit(1);
      if (record(record(ownedTask?.runtime).billingPause).reason === "cost")
        throw new AiBillingError("AI_COST_PENDING");
      const id = stableId(
        `ai:command:${input.localTaskId}:${input.commandKey}`,
      );
      const [prior] = await tx
        .select()
        .from(aiChargeCommands)
        .where(eq(aiChargeCommands.id, id))
        .limit(1)
        .for("update");
      if (prior) {
        if (
          prior.walletUserId !== link.monitoringUserId ||
          prior.model !== input.model ||
          prior.sessionId !== input.sessionId
        )
          throw new AiBillingError("AI_BILLING_COMMAND_CONFLICT");
        if (["settled", "rejected"].includes(prior.state))
          throw new AiBillingError("AI_BILLING_COMMAND_CLOSED");
        return;
      }
      const wallet = await lockWallet(tx, link.monitoringUserId);
      const available =
        wallet.balanceTenThousandths -
        wallet.reservedTenThousandths -
        wallet.frozenTenThousandths;
      if (available <= 0n) throw new AiBillingError("AI_BALANCE_INSUFFICIENT");
      const reserveAmount =
        available < config.reserveAmount ? available : config.reserveAmount;
      await tx.insert(aiChargeCommands).values({
        id,
        localTaskId: input.localTaskId,
        commandKey: input.commandKey,
        operationId: input.operationId,
        accountUserId: input.identity.accountUserId,
        walletUserId: link.monitoringUserId,
        enterpriseProjectId: operation.enterpriseProjectId ?? null,
        sessionId: input.sessionId,
        model: input.model,
        effort: input.effort,
        pricingVersion: ZHIPU_PRICING_VERSION,
        reservedTenThousandths: reserveAmount,
        reserveWindowTenThousandths: reserveAmount,
      });
      await tx
        .update(moneyWallets)
        .set({
          reservedTenThousandths: wallet.reservedTenThousandths + reserveAmount,
        })
        .where(eq(moneyWallets.userId, wallet.userId));
      await ledger(tx, {
        userId: wallet.userId,
        commandId: id,
        type: "reserve",
        balanceDelta: 0n,
        reservedDelta: reserveAmount,
        balanceAfter: wallet.balanceTenThousandths,
        key: `ai:reserve:${id}:initial`,
        reason: "AI 任务启动预留（按实际用量结算）",
      });
    })
    .catch(async (error) => {
      if (
        error instanceof AiBillingError &&
        error.code === "AI_BALANCE_INSUFFICIENT"
      ) {
        await db.transaction(async (tx) => {
          await ownedOperation(tx, input);
          const [task] = await tx
            .select()
            .from(agentTasks)
            .where(eq(agentTasks.id, input.localTaskId))
            .limit(1);
          const pause: AiBillingPause = {
            reason: "balance",
            stage: "before_send",
            commandKey: input.commandKey,
            sessionId: input.sessionId,
            pausedAt: new Date().toISOString(),
          };
          await tx
            .update(agentTasks)
            .set({
              providerRuntime: {
                ...record(task?.providerRuntime),
                billingPause: pause,
              },
            })
            .where(eq(agentTasks.id, input.localTaskId));
        });
      }
      throw error;
    });
}
export function extractModelUsageEvent(event: Record<string, unknown>) {
  const span = record(event.span);
  const isModelEnd =
    event.type === "span.model_request_end" ||
    (event.type === "span" && span.type === "model_request_end");
  if (!isModelEnd || typeof event.id !== "string" || event.id.length > 255)
    return null;
  const stamp = new Date(String(event.processed_at ?? event.created_at ?? ""));
  if (!Number.isFinite(stamp.getTime())) return null;
  return {
    id: event.id,
    tokens: nativeTokens(span.model_usage ?? event.model_usage),
    occurredAt: stamp,
    isError: (span.is_error ?? event.is_error) === true,
  };
}
function tokensEqual(a: NativeTokens | null, b: NativeTokens) {
  return (
    !!a &&
    a.inputTokens === b.inputTokens &&
    a.outputTokens === b.outputTokens &&
    a.cacheReadInputTokens === b.cacheReadInputTokens &&
    a.cacheCreationInputTokens === b.cacheCreationInputTokens
  );
}
/** Raw provider GET history is authoritative. SSE merely schedules another observation. */
export async function observeManagedAiUsage(
  input: Observation,
): Promise<{ shouldInterrupt: boolean; pause?: AiBillingPause }> {
  const db = await database();
  let shouldInterrupt = false;
  let pause: AiBillingPause | undefined;
  let pauseReason: AiBillingPause["reason"] = "cost";
  await db.transaction(async (tx) => {
    const operation = await ownedOperation(tx, input);
    const commandRows = await tx
      .select()
      .from(aiChargeCommands)
      .where(eq(aiChargeCommands.localTaskId, input.localTaskId))
      .for("update");
    const commands = new Map(commandRows.map((c) => [c.commandKey, c]));
    const eventCommands = new Map(
      input.commands.filter((c) => c.eventId).map((c) => [c.eventId!, c.key]),
    );
    // A lost HTTP acknowledgement must not erase accepted spend. Recover billing attribution
    // only from a unique authoritative event matching the frozen request, excluding prior turns.
    // This never resends the message or changes the business workflow's mutation fence.
    for (const command of input.commands) {
      if (
        command.eventId ||
        !command.providerPromptHash ||
        !commands.has(command.key)
      )
        continue;
      const before = new Set(command.beforeEventIds ?? []);
      const candidates = input.events.filter((event) => {
        if (
          event.type !== "user.message" ||
          !event.processed_at ||
          typeof event.id !== "string" ||
          before.has(event.id)
        )
          return false;
        const content =
          typeof event.content === "string"
            ? event.content
            : Array.isArray(event.content)
              ? event.content
                  .filter((b) => record(b).type === "text")
                  .map((b) => String(record(b).text ?? ""))
                  .join("\n")
              : "";
        return (
          createHash("sha256").update(content).digest("hex") ===
          command.providerPromptHash
        );
      });
      if (candidates.length === 1)
        eventCommands.set(String(candidates[0]!.id), command.key);
    }
    let commandKey: string | null = null;
    const totals: NativeTokens = {
      inputTokens: 0n,
      outputTokens: 0n,
      cacheReadInputTokens: 0n,
      cacheCreationInputTokens: 0n,
    };
    let valid = true;
    const pendingCommands = new Set<string>();
    const terminalCommands = new Set<string>();
    for (const event of input.events) {
      if (event.type === "user.message" && event.processed_at !== null)
        commandKey = eventCommands.get(String(event.id)) ?? null;
      if (
        ["session.status_idle", "session.status_terminated"].includes(
          String(event.type),
        ) &&
        commandKey
      )
        terminalCommands.add(commandKey);
      if (event.type === "session.status_running" && commandKey)
        terminalCommands.delete(commandKey);
      const native = extractModelUsageEvent(event);
      if (!native) continue;
      if (native.tokens)
        for (const key of Object.keys(totals) as Array<keyof NativeTokens>)
          totals[key] += native.tokens[key];
      else valid = false;
      const command = commandKey ? commands.get(commandKey) : undefined;
      if (
        !command &&
        commandRows.some(
          (c) =>
            native.occurredAt >= c.createdAt &&
            !["settled", "rejected"].includes(c.state),
        )
      )
        shouldInterrupt = true;
      const cost = zhipuCostNanos(command?.model ?? input.model, native.tokens);
      if (command && cost === null) {
        pendingCommands.add(command.id);
        shouldInterrupt = true;
      }
      const [existing] = await tx
        .select()
        .from(aiCostEvents)
        .where(
          and(
            eq(aiCostEvents.sessionId, input.sessionId),
            eq(aiCostEvents.providerEventId, native.id),
          ),
        )
        .limit(1);
      if (
        existing &&
        existing.costNanos !== null &&
        (existing.commandId || !command)
      )
        continue;
      const values: typeof aiCostEvents.$inferInsert = {
        id: existing?.id ?? stableId(`zhipu:${input.sessionId}:${native.id}`),
        providerEventId: native.id,
        sessionId: input.sessionId,
        localTaskId: input.localTaskId,
        operationId: input.operationId,
        commandId: command?.id ?? null,
        accountUserId: operation.accountUserId,
        enterpriseProjectId: operation.enterpriseProjectId ?? null,
        scope: operation.scope,
        model: command?.model ?? input.model,
        pricingVersion: cost === null ? null : ZHIPU_PRICING_VERSION,
        inputTokens: native.tokens?.inputTokens,
        outputTokens: native.tokens?.outputTokens,
        cacheReadInputTokens: native.tokens?.cacheReadInputTokens,
        cacheCreationInputTokens: native.tokens?.cacheCreationInputTokens,
        costNanos: cost,
        costState:
          cost === null
            ? "pending"
            : command
              ? "charged"
              : input.identity
                ? commandRows.some((c) => native.occurredAt >= c.createdAt)
                  ? "pending_identity"
                  : "historical"
                : "platform",
        isError: native.isError,
        occurredAt: native.occurredAt,
      };
      if (cost !== null && command) {
        const wallet = await lockWallet(tx, command.walletUserId);
        const money = applyCostRemainder(cost, wallet.aiCostRemainderNanos);
        const fromReserve =
          money.charge < command.reservedTenThousandths
            ? money.charge
            : command.reservedTenThousandths;
        if (wallet.reservedTenThousandths < fromReserve)
          throw new AiBillingError("AI_RESERVATION_INCONSISTENT");
        const balanceAfter = wallet.balanceTenThousandths - money.charge;
        await tx
          .update(moneyWallets)
          .set({
            balanceTenThousandths: balanceAfter,
            reservedTenThousandths: wallet.reservedTenThousandths - fromReserve,
            spentTenThousandths: wallet.spentTenThousandths + money.charge,
            aiCostRemainderNanos: money.remainder,
          })
          .where(eq(moneyWallets.userId, wallet.userId));
        command.reservedTenThousandths -= fromReserve;
        command.consumedTenThousandths += money.charge;
        await tx
          .update(aiChargeCommands)
          .set({
            reservedTenThousandths: command.reservedTenThousandths,
            consumedTenThousandths: command.consumedTenThousandths,
            observedAt: new Date(),
          })
          .where(eq(aiChargeCommands.id, command.id));
        values.chargedTenThousandths = money.charge;
        await ledger(tx, {
          userId: wallet.userId,
          commandId: command.id,
          type: "consume",
          balanceDelta: -money.charge,
          reservedDelta: -fromReserve,
          balanceAfter,
          key: `ai:cost:${values.id}`,
          reason: "智谱 AI 原价用量",
          referenceId: native.id,
        });
        if (
          balanceAfter -
            wallet.reservedTenThousandths +
            fromReserve -
            wallet.frozenTenThousandths <
          0n
        ) {
          shouldInterrupt = true;
          pauseReason = "balance";
        }
      }
      if (existing)
        await tx
          .update(aiCostEvents)
          .set(values)
          .where(eq(aiCostEvents.id, existing.id));
      else await tx.insert(aiCostEvents).values(values);
    }
    const complete =
      valid && tokensEqual(nativeTokens(input.session.usage), totals);
    for (const command of commandRows) {
      if (["settled", "rejected"].includes(command.state)) continue;
      const currentStillRunning =
        command.commandKey === input.commands.at(-1)?.key &&
        ["running", "rescheduling"].includes(String(input.session.status));
      const terminal =
        terminalCommands.has(command.commandKey) &&
        complete &&
        !pendingCommands.has(command.id) &&
        !currentStillRunning;
      const wallet = await lockWallet(tx, command.walletUserId);
      if (terminal) {
        if (wallet.reservedTenThousandths < command.reservedTenThousandths)
          throw new AiBillingError("AI_RESERVATION_INCONSISTENT");
        await tx
          .update(moneyWallets)
          .set({
            reservedTenThousandths:
              wallet.reservedTenThousandths - command.reservedTenThousandths,
          })
          .where(eq(moneyWallets.userId, wallet.userId));
        if (command.reservedTenThousandths > 0n)
          await ledger(tx, {
            userId: wallet.userId,
            commandId: command.id,
            type: "release",
            balanceDelta: 0n,
            reservedDelta: -command.reservedTenThousandths,
            balanceAfter: wallet.balanceTenThousandths,
            key: `ai:release:${command.id}`,
            reason: "AI 任务结束，释放未使用预留",
          });
        await tx
          .update(aiChargeCommands)
          .set({
            reservedTenThousandths: 0n,
            state: "settled",
            observedAt: new Date(),
          })
          .where(eq(aiChargeCommands.id, command.id));
      } else if (pendingCommands.has(command.id)) {
        await tx
          .update(aiChargeCommands)
          .set({ state: "pending_cost", observedAt: new Date() })
          .where(eq(aiChargeCommands.id, command.id));
      } else {
        const config = await configuration(tx);
        const threshold =
          (command.reserveWindowTenThousandths *
            (10_000n - config.refillRatio)) /
          10_000n;
        if (command.reservedTenThousandths <= threshold) {
          const available =
            wallet.balanceTenThousandths -
            wallet.reservedTenThousandths -
            wallet.frozenTenThousandths;
          if (available <= 0n) {
            shouldInterrupt = true;
            pauseReason = "balance";
          } else {
            const extra =
              available < config.reserveAmount
                ? available
                : config.reserveAmount;
            await tx
              .update(moneyWallets)
              .set({
                reservedTenThousandths: wallet.reservedTenThousandths + extra,
              })
              .where(eq(moneyWallets.userId, wallet.userId));
            await tx
              .update(aiChargeCommands)
              .set({
                reservedTenThousandths: command.reservedTenThousandths + extra,
                reserveWindowTenThousandths:
                  command.reservedTenThousandths + extra,
                state: "running",
                observedAt: new Date(),
              })
              .where(eq(aiChargeCommands.id, command.id));
            await ledger(tx, {
              userId: wallet.userId,
              commandId: command.id,
              type: "reserve",
              balanceDelta: 0n,
              reservedDelta: extra,
              balanceAfter: wallet.balanceTenThousandths,
              key: `ai:reserve:${command.id}:${command.consumedTenThousandths}:${command.reservedTenThousandths}`,
              reason: "AI 任务继续运行，补充预留",
            });
          }
        }
      }
    }
    const [task] = await tx
      .select()
      .from(agentTasks)
      .where(eq(agentTasks.id, input.localTaskId))
      .limit(1);
    const runtime = record(task?.providerRuntime);
    const previous = runtime.billingPause as AiBillingPause | undefined;
    const latest = input.commands.at(-1);
    pause = previous;
    if (previous?.reason === "cost" && complete && !shouldInterrupt)
      pause = undefined;
    const acceptedLatest =
      latest?.eventId ||
      (latest && [...eventCommands.values()].includes(latest.key));
    if (
      previous &&
      latest &&
      acceptedLatest &&
      (previous.stage === "before_send" || latest.key !== previous.commandKey)
    )
      pause = undefined;
    if (shouldInterrupt)
      pause = {
        reason: pauseReason,
        stage: "after_send",
        commandKey: latest?.key ?? "",
        sessionId: input.sessionId,
        pausedAt: previous?.pausedAt ?? new Date().toISOString(),
      };
    if (previous || pause) {
      const next = { ...runtime };
      if (pause) next.billingPause = pause;
      else delete next.billingPause;
      await tx
        .update(agentTasks)
        .set({ providerRuntime: next })
        .where(eq(agentTasks.id, input.localTaskId));
    }
  });
  return { shouldInterrupt, ...(pause ? { pause } : {}) };
}
export async function rejectManagedAiCommand(input: {
  localTaskId: string;
  commandKey: string;
}): Promise<void> {
  const db = await database();
  await db.transaction(async (tx) => {
    // Same lock order as native observations: task -> command -> wallet.
    await tx
      .select({ id: agentTasks.id })
      .from(agentTasks)
      .where(eq(agentTasks.id, input.localTaskId))
      .for("update");
    const [command] = await tx
      .select()
      .from(aiChargeCommands)
      .where(
        and(
          eq(aiChargeCommands.localTaskId, input.localTaskId),
          eq(aiChargeCommands.commandKey, input.commandKey),
        ),
      )
      .limit(1)
      .for("update");
    if (!command || command.state === "rejected") return;
    if (command.consumedTenThousandths > 0n)
      throw new AiBillingError("AI_ALREADY_CONSUMED");
    const wallet = await lockWallet(tx, command.walletUserId);
    await tx
      .update(moneyWallets)
      .set({
        reservedTenThousandths:
          wallet.reservedTenThousandths - command.reservedTenThousandths,
      })
      .where(eq(moneyWallets.userId, wallet.userId));
    if (command.reservedTenThousandths > 0n)
      await ledger(tx, {
        userId: wallet.userId,
        commandId: command.id,
        type: "release",
        balanceDelta: 0n,
        reservedDelta: -command.reservedTenThousandths,
        balanceAfter: wallet.balanceTenThousandths,
        key: `ai:reject:${command.id}`,
        reason: "上游明确拒绝执行，释放 AI 预留",
      });
    await tx
      .update(aiChargeCommands)
      .set({ reservedTenThousandths: 0n, state: "rejected" })
      .where(eq(aiChargeCommands.id, command.id));
  });
}
/** All displayed counters and money use exactly the same event-time window. */
export function projectAiCostTotals(
  rows: Array<{
    accountUserId: number | null;
    localTaskId?: string;
    costNanos: bigint | string | null;
    inputTokens?: bigint | string | null;
    outputTokens?: bigint | string | null;
    cacheReadInputTokens?: bigint | string | null;
  }>,
) {
  const totals = new Map<
    number | null,
    {
      nanos: bigint;
      known: number;
      unknown: number;
      input: bigint;
      output: bigint;
      cache: bigint;
      tasks: Set<string>;
    }
  >();
  for (const row of rows) {
    const value = totals.get(row.accountUserId) ?? {
      nanos: 0n,
      known: 0,
      unknown: 0,
      input: 0n,
      output: 0n,
      cache: 0n,
      tasks: new Set<string>(),
    };
    if (row.costNanos == null) value.unknown++;
    else {
      value.nanos += BigInt(row.costNanos);
      value.known++;
    }
    value.input += BigInt(row.inputTokens ?? 0);
    value.output += BigInt(row.outputTokens ?? 0);
    value.cache += BigInt(row.cacheReadInputTokens ?? 0);
    if (row.localTaskId) value.tasks.add(row.localTaskId);
    totals.set(row.accountUserId, value);
  }
  return new Map(
    [...totals].map(([id, value]) => [
      id,
      {
        provider: "zhipu" as const,
        unit: "tokens" as const,
        inputTokens: Number(value.input),
        outputTokens: Number(value.output),
        cacheReadInputTokens: Number(value.cache),
        observedTasks: value.tasks.size,
        observedEvents: value.known + value.unknown,
        unknownEvents: value.unknown,
        costCny: value.known ? formatCostCny(value.nanos) : null,
        // This is FrontMind's recorded event coverage, never a claim about the complete Key bill.
        costStatus: value.known ? ("partial" as const) : ("unknown" as const),
        pricingSourceUrl: ZHIPU_PRICING_SOURCE,
      },
    ]),
  );
}

export async function readAiCostTotals(input: {
  executor?: any;
  accountIds?: number[];
  scope: "managed_user" | "website_frontend";
  startAt: number;
  endAt: number;
}) {
  const db = input.executor ?? (await database());
  const rows = await db
    .select({
      accountUserId: aiCostEvents.accountUserId,
      localTaskId: aiCostEvents.localTaskId,
      costNanos: aiCostEvents.costNanos,
      inputTokens: aiCostEvents.inputTokens,
      outputTokens: aiCostEvents.outputTokens,
      cacheReadInputTokens: aiCostEvents.cacheReadInputTokens,
    })
    .from(aiCostEvents)
    .where(
      and(
        eq(aiCostEvents.scope, input.scope),
        gte(aiCostEvents.occurredAt, new Date(input.startAt)),
        lt(aiCostEvents.occurredAt, new Date(input.endAt)),
        input.accountIds?.length
          ? inArray(aiCostEvents.accountUserId, input.accountIds)
          : undefined,
      ),
    );
  return projectAiCostTotals(rows);
}

export async function registerAiUsageTask(localTaskId: string) {
  const db = await database();
  await db.execute(sql`INSERT INTO ai_usage_sync_targets(local_task_id,next_sync_at) VALUES(${localTaskId},UTC_TIMESTAMP(3)+INTERVAL 10 SECOND)
    ON DUPLICATE KEY UPDATE next_sync_at=LEAST(next_sync_at,VALUES(next_sync_at))`);
}
/** Recover accounting after browser closes, process crashes, or provider responses arrive late. */
export async function sweepAiUsageAccounting(): Promise<number> {
  const db = await database();
  const token = randomUUID();
  const [claim] =
    (await db.execute(sql`UPDATE ai_billing_configuration SET sync_token=${token},sync_until=UTC_TIMESTAMP(3)+INTERVAL 2 MINUTE
    WHERE id=1 AND mode='active' AND (sync_until IS NULL OR sync_until<UTC_TIMESTAMP(3))`)) as any;
  if (!claim.affectedRows) return 0;
  let processed = 0;
  try {
    const [targets] =
      (await db.execute(sql`SELECT s.local_task_id AS localTaskId FROM ai_usage_sync_targets s
      WHERE s.next_sync_at<=UTC_TIMESTAMP(3) ORDER BY s.next_sync_at LIMIT 20`)) as unknown as [
        Array<{ localTaskId: string }>,
      ];
    for (const target of targets) {
      await db.execute(
        sql`UPDATE ai_billing_configuration SET sync_until=UTC_TIMESTAMP(3)+INTERVAL 2 MINUTE WHERE id=1 AND sync_token=${token}`,
      );
      try {
        const [row] = await db
          .select({ task: agentTasks, operation: agentOperations })
          .from(agentTasks)
          .innerJoin(
            agentOperations,
            eq(agentOperations.id, agentTasks.operationId),
          )
          .where(eq(agentTasks.id, target.localTaskId))
          .limit(1);
        if (!row) {
          await db.execute(
            sql`DELETE FROM ai_usage_sync_targets WHERE local_task_id=${target.localTaskId}`,
          );
          continue;
        }
        const runtime = record(row.task.providerRuntime);
        const managed = record(runtime.dashboardManaged);
        const sessionId = String(
          managed.sessionId ??
            runtime.sessionId ??
            row.task.providerTaskId ??
            "",
        );
        if (!sessionId) throw new AiBillingError("AI_SESSION_NOT_ACKNOWLEDGED");
        const identity =
          row.operation.scope === "managed_user"
            ? {
                accountUserId: row.operation.accountUserId!,
                credentialId: row.operation.apiCredentialId,
                credentialVersion: row.operation.credentialVersion,
                enterpriseProjectId: row.operation.enterpriseProjectId ?? null,
              }
            : undefined;
        const credential = identity
          ? await (
              await import("./auth-service")
            ).getDecryptedCredentialForAccountById(
              identity.accountUserId,
              identity.credentialId,
            )
          : await (
              await import("./presales-service")
            ).getPresalesCredentialById(row.operation.apiCredentialId);
        if (
          !credential ||
          credential.version !== row.operation.credentialVersion
        )
          throw new AiBillingError("AI_CREDENTIAL_UNAVAILABLE");
        const { ZhipuManagedClient } = await import(
          "./providers/zhipu-managed-client"
        );
        const api = new ZhipuManagedClient({
          apiKey: credential.apiKey,
          requestTimeoutMs: 30_000,
        });
        const [session, events] = await Promise.all([
          api.request("GET", `/v1/sessions/${sessionId}`),
          api.listAll(`/v1/sessions/${sessionId}/events`, { order: "asc" }),
        ]);
        const commands = Array.isArray(managed.commands)
          ? (managed.commands as Observation["commands"])
          : [];
        const result = await observeManagedAiUsage({
          identity,
          localTaskId: target.localTaskId,
          operationId: row.operation.id,
          sessionId,
          model: String(
            managed.model ?? runtime.model ?? row.operation.upstreamModel,
          ),
          commands,
          session,
          events,
        });
        if (
          result.shouldInterrupt &&
          ["running", "rescheduling"].includes(String(session.status))
        ) {
          // Durable stop fence is shared with interactive stop; no duplicate interrupt on restart.
          if (identity) {
            const { createDashboardAgentClient } = await import(
              "./providers/dashboard-agent-provider"
            );
            const { runWithStoredEnterpriseProjectScope } = await import(
              "./enterprise-project-recovery"
            );
            await runWithStoredEnterpriseProjectScope(
              identity.accountUserId,
              row.operation.enterpriseProjectId,
              () =>
                createDashboardAgentClient({
                  ...identity,
                  provider: "zhipu",
                  apiKey: credential.apiKey,
                  localTaskId: target.localTaskId,
                  operationId: row.operation.id,
                }).stopTask(sessionId),
            );
          }
        }
        const active =
          session.status === "running" || session.status === "rescheduling";
        await db.execute(
          sql`UPDATE ai_usage_sync_targets SET next_sync_at=UTC_TIMESTAMP(3)+INTERVAL ${active ? 15 : 600} SECOND,last_error=NULL WHERE local_task_id=${target.localTaskId}`,
        );
        processed++;
      } catch (error) {
        const code =
          error instanceof AiBillingError
            ? error.code
            : "AI_USAGE_SYNC_UNAVAILABLE";
        await db.execute(
          sql`UPDATE ai_usage_sync_targets SET next_sync_at=UTC_TIMESTAMP(3)+INTERVAL 60 SECOND,last_error=${code} WHERE local_task_id=${target.localTaskId}`,
        );
      }
    }
  } finally {
    await db.execute(
      sql`UPDATE ai_billing_configuration SET sync_token=NULL,sync_until=NULL WHERE id=1 AND sync_token=${token}`,
    );
  }
  return processed;
}
export function startAiUsageAccountingScheduler() {
  if (process.env.NODE_ENV === "test") return () => {};
  let running = false;
  const sweep = async () => {
    if (running) return;
    running = true;
    try {
      await sweepAiUsageAccounting();
    } catch {
      console.error(
        "[AI accounting] Sync unavailable; pending funds remain reserved",
      );
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void sweep(), 15_000);
  timer.unref();
  const initial = setTimeout(() => void sweep(), 2_000);
  initial.unref();
  return () => {
    clearInterval(timer);
    clearTimeout(initial);
  };
}
