import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import type { Database } from "./client.js";
import { RepositoryError } from "./repository-error.js";
import {
  attemptMoneySettlements,
  attemptPriceSnapshots,
  moneyLedger,
  moneyReservations,
  moneyWallets,
} from "./schema.js";

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

/**
 * Idempotently settles one immutable attempt quote. A late success may convert
 * a released charge to consumed and can make the posted balance negative; it
 * never recreates a reservation and future runs remain blocked until funded.
 */
export async function settleAttemptMoney(
  tx: Transaction,
  input: {
    attemptId: string;
    settlement: "consumed" | "released";
    settledAt: Date;
    reason: string;
  },
): Promise<boolean> {
  const [settlement] = await tx
    .select()
    .from(attemptMoneySettlements)
    .where(eq(attemptMoneySettlements.attemptId, input.attemptId))
    .for("update")
    .limit(1);
  if (!settlement)
    throw new RepositoryError(
      "INVALID_STATE",
      "Attempt money settlement is missing",
    );
  if (settlement.status === input.settlement) return false;
  if (settlement.status === "consumed") {
    throw new RepositoryError(
      "INVALID_STATE",
      "Consumed attempt money cannot be released",
    );
  }
  if (settlement.status === "released" && input.settlement !== "consumed") {
    return false;
  }
  const [snapshot] = await tx
    .select()
    .from(attemptPriceSnapshots)
    .where(eq(attemptPriceSnapshots.attemptId, input.attemptId))
    .limit(1);
  const [reservation] = await tx
    .select()
    .from(moneyReservations)
    .where(eq(moneyReservations.id, settlement.reservationId))
    .for("update")
    .limit(1);
  if (!snapshot || !reservation)
    throw new RepositoryError(
      "INVALID_STATE",
      "Attempt money reservation is incomplete",
    );
  const [wallet] = await tx
    .select()
    .from(moneyWallets)
    .where(eq(moneyWallets.userId, reservation.userId))
    .for("update")
    .limit(1);
  if (!wallet)
    throw new RepositoryError("INVALID_STATE", "Money wallet is missing");
  const amount = snapshot.amountTenThousandths;
  const fromReserved = settlement.status === "reserved";
  if (fromReserved && wallet.reservedTenThousandths < amount) {
    throw new RepositoryError(
      "INVALID_STATE",
      "Money wallet has insufficient reserved funds",
    );
  }
  if (
    settlement.status === "released" &&
    reservation.releasedTenThousandths < amount
  ) {
    throw new RepositoryError(
      "INVALID_STATE",
      "Released reservation cannot be converted to a charge",
    );
  }

  const nextReserved = fromReserved
    ? wallet.reservedTenThousandths - amount
    : wallet.reservedTenThousandths;
  const nextBalance =
    input.settlement === "consumed"
      ? wallet.balanceTenThousandths - amount
      : wallet.balanceTenThousandths;
  const nextConsumed =
    reservation.consumedTenThousandths +
    (input.settlement === "consumed" ? amount : 0n);
  const nextReleased =
    reservation.releasedTenThousandths +
    (input.settlement === "released" ? amount : 0n) -
    (settlement.status === "released" && input.settlement === "consumed"
      ? amount
      : 0n);
  if (
    nextConsumed < 0n ||
    nextReleased < 0n ||
    nextConsumed + nextReleased > reservation.totalTenThousandths
  ) {
    throw new RepositoryError(
      "INVALID_STATE",
      "Money reservation would be over-settled",
    );
  }

  await tx
    .update(moneyWallets)
    .set({
      balanceTenThousandths: nextBalance,
      reservedTenThousandths: nextReserved,
      spentTenThousandths:
        wallet.spentTenThousandths +
        (input.settlement === "consumed" ? amount : 0n),
    })
    .where(eq(moneyWallets.userId, reservation.userId));
  await tx
    .update(moneyReservations)
    .set({
      consumedTenThousandths: nextConsumed,
      releasedTenThousandths: nextReleased,
      status:
        nextConsumed + nextReleased === reservation.totalTenThousandths
          ? "settled"
          : "active",
    })
    .where(eq(moneyReservations.id, reservation.id));
  await tx
    .update(attemptMoneySettlements)
    .set({
      status: input.settlement,
      settledTenThousandths: amount,
      settledAt: input.settledAt,
    })
    .where(eq(attemptMoneySettlements.attemptId, input.attemptId));
  await tx
    .insert(moneyLedger)
    .values({
      id: randomUUID(),
      userId: reservation.userId,
      type: input.settlement === "consumed" ? "consume" : "release",
      balanceDeltaTenThousandths:
        input.settlement === "consumed" ? -amount : 0n,
      reservedDeltaTenThousandths: fromReserved ? -amount : 0n,
      balanceAfterTenThousandths: nextBalance,
      reservedAfterTenThousandths: nextReserved,
      idempotencyKey: `${input.settlement}:${input.attemptId}`,
      reservationId: reservation.id,
      attemptId: input.attemptId,
      referenceType: "attempt",
      referenceId: input.attemptId,
      reason: input.reason,
      metadata: {
        settledAt: input.settledAt.toISOString(),
        ...(settlement.status === "released"
          ? { reconciledFrom: "released" }
          : {}),
      },
    })
    .onDuplicateKeyUpdate({
      set: { idempotencyKey: sql`${moneyLedger.idempotencyKey}` },
    });
  return true;
}
