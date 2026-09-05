import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import type { Database } from "./client.js";
import { transitionPublisherFunds } from "./publisher-money.js";
import { RepositoryError } from "./repository-error.js";
import {
  mediaPublishingItemSettlements,
  mediaPublishingLedger,
  mediaPublishingReservations,
  mediaPublishingWallets,
  publisherItems,
} from "./schema.js";

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

export type PublisherFundsStatus =
  | "reserved"
  | "frozen"
  | "consumed"
  | "released";

/**
 * A batch-level label cannot express a split settlement. Preserve the most
 * restrictive active state first, then report consumption when a completed
 * batch contains both consumed and released items. Item rows remain the
 * authoritative per-media breakdown.
 */
export function derivePublisherBatchFundsStatus(
  statuses: readonly PublisherFundsStatus[],
): PublisherFundsStatus {
  if (statuses.some((status) => status === "frozen")) return "frozen";
  if (statuses.some((status) => status === "reserved")) return "reserved";
  if (statuses.some((status) => status === "consumed")) return "consumed";
  return "released";
}

export async function settlePublisherItemMoney(
  tx: Transaction,
  input: {
    itemId: string;
    settlement: "frozen" | "consumed" | "released";
    settledAt: Date;
    reason: string;
  },
): Promise<boolean> {
  const [settlement] = await tx
    .select()
    .from(mediaPublishingItemSettlements)
    .where(eq(mediaPublishingItemSettlements.itemId, input.itemId))
    .for("update")
    .limit(1);
  if (!settlement) {
    throw new RepositoryError(
      "INVALID_STATE",
      "Publisher item money settlement is missing",
    );
  }
  if (settlement.status === input.settlement) return false;
  if (settlement.status === "consumed" || settlement.status === "released") {
    throw new RepositoryError(
      "INVALID_STATE",
      "Final publisher item money cannot be changed",
    );
  }
  const [reservation] = await tx
    .select()
    .from(mediaPublishingReservations)
    .where(eq(mediaPublishingReservations.id, settlement.reservationId))
    .for("update")
    .limit(1);
  const [wallet] = await tx
    .select()
    .from(mediaPublishingWallets)
    .where(eq(mediaPublishingWallets.userId, settlement.ownerId))
    .for("update")
    .limit(1);
  if (!reservation || !wallet || reservation.ownerId !== settlement.ownerId) {
    throw new RepositoryError(
      "INVALID_STATE",
      "Publisher item money reservation is incomplete",
    );
  }
  const amount = settlement.amountTenThousandths;
  const previous = settlement.status as "reserved" | "frozen";
  const nextWallet = transitionPublisherFunds(
    wallet,
    amount,
    previous,
    input.settlement,
  );
  const nextConsumed =
    reservation.consumedTenThousandths +
    (input.settlement === "consumed" ? amount : 0n);
  const nextReleased =
    reservation.releasedTenThousandths +
    (input.settlement === "released" ? amount : 0n);
  const nextFrozen =
    reservation.frozenTenThousandths -
    (previous === "frozen" ? amount : 0n) +
    (input.settlement === "frozen" ? amount : 0n);
  if (
    nextConsumed < 0n ||
    nextReleased < 0n ||
    nextFrozen < 0n ||
    nextConsumed + nextReleased + nextFrozen >
      reservation.totalTenThousandths
  ) {
    throw new RepositoryError(
      "INVALID_STATE",
      "Publisher reservation would be over-settled",
    );
  }
  const reservationSettled =
    nextConsumed + nextReleased === reservation.totalTenThousandths &&
    nextFrozen === 0n;

  await tx
    .update(mediaPublishingWallets)
    .set(nextWallet)
    .where(eq(mediaPublishingWallets.userId, settlement.ownerId));
  await tx
    .update(mediaPublishingReservations)
    .set({
      consumedTenThousandths: nextConsumed,
      releasedTenThousandths: nextReleased,
      frozenTenThousandths: nextFrozen,
      status: reservationSettled ? "settled" : "active",
    })
    .where(eq(mediaPublishingReservations.id, reservation.id));
  await tx
    .update(mediaPublishingItemSettlements)
    .set({ status: input.settlement, settledAt: input.settledAt })
    .where(eq(mediaPublishingItemSettlements.itemId, input.itemId));
  await tx
    .update(publisherItems)
    .set({ fundsStatus: input.settlement })
    .where(eq(publisherItems.id, input.itemId));
  await tx
    .insert(mediaPublishingLedger)
    .values({
      id: randomUUID(),
      ownerId: settlement.ownerId,
      type:
        input.settlement === "frozen"
          ? "freeze"
          : input.settlement === "consumed"
            ? "consume"
            : "release",
      balanceDeltaTenThousandths:
        input.settlement === "consumed" ? -amount : 0n,
      reservedDeltaTenThousandths:
        previous === "reserved" ? -amount : 0n,
      frozenDeltaTenThousandths:
        (previous === "frozen" ? -amount : 0n) +
        (input.settlement === "frozen" ? amount : 0n),
      balanceAfterTenThousandths: nextWallet.balanceTenThousandths,
      reservedAfterTenThousandths: nextWallet.reservedTenThousandths,
      frozenAfterTenThousandths: nextWallet.frozenTenThousandths,
      idempotencyKey: `publisher:${input.settlement}:${input.itemId}`,
      reservationId: reservation.id,
      itemId: input.itemId,
      referenceType: "publication_item",
      referenceId: input.itemId,
      reason: input.reason,
      metadata: { settledAt: input.settledAt.toISOString(), from: previous },
    })
    .onDuplicateKeyUpdate({
      set: { idempotencyKey: sql`${mediaPublishingLedger.idempotencyKey}` },
    });
  return true;
}

/** Admin-authorized UNKNOWN replay moves the same frozen quote back to reserve. */
export async function reactivatePublisherItemReservation(
  tx: Transaction,
  input: {
    itemId: string;
    authorizedAt: Date;
    actorId: string;
    reason: string;
  },
): Promise<boolean> {
  const [settlement] = await tx
    .select()
    .from(mediaPublishingItemSettlements)
    .where(eq(mediaPublishingItemSettlements.itemId, input.itemId))
    .for("update")
    .limit(1);
  if (!settlement) {
    throw new RepositoryError("INVALID_STATE", "Publisher item settlement is missing");
  }
  if (settlement.status === "reserved") return false;
  if (settlement.status !== "frozen") {
    throw new RepositoryError(
      "INVALID_STATE",
      "Only frozen publisher funds can be re-reserved",
    );
  }
  const [reservation] = await tx
    .select()
    .from(mediaPublishingReservations)
    .where(eq(mediaPublishingReservations.id, settlement.reservationId))
    .for("update")
    .limit(1);
  const [wallet] = await tx
    .select()
    .from(mediaPublishingWallets)
    .where(eq(mediaPublishingWallets.userId, settlement.ownerId))
    .for("update")
    .limit(1);
  if (!reservation || !wallet) {
    throw new RepositoryError("INVALID_STATE", "Publisher reservation is incomplete");
  }
  const amount = settlement.amountTenThousandths;
  if (
    wallet.frozenTenThousandths < amount ||
    reservation.frozenTenThousandths < amount
  ) {
    throw new RepositoryError("INVALID_STATE", "Frozen publisher funds are inconsistent");
  }
  const nextReserved = wallet.reservedTenThousandths + amount;
  const nextFrozen = wallet.frozenTenThousandths - amount;
  await tx
    .update(mediaPublishingWallets)
    .set({
      reservedTenThousandths: nextReserved,
      frozenTenThousandths: nextFrozen,
    })
    .where(eq(mediaPublishingWallets.userId, settlement.ownerId));
  await tx
    .update(mediaPublishingReservations)
    .set({
      frozenTenThousandths: reservation.frozenTenThousandths - amount,
      status: "active",
    })
    .where(eq(mediaPublishingReservations.id, reservation.id));
  await tx
    .update(mediaPublishingItemSettlements)
    .set({ status: "reserved", settledAt: null })
    .where(eq(mediaPublishingItemSettlements.itemId, input.itemId));
  await tx
    .update(publisherItems)
    .set({ fundsStatus: "reserved" })
    .where(eq(publisherItems.id, input.itemId));
  await tx
    .insert(mediaPublishingLedger)
    .values({
      id: randomUUID(),
      ownerId: settlement.ownerId,
      type: "reserve",
      balanceDeltaTenThousandths: 0n,
      reservedDeltaTenThousandths: amount,
      frozenDeltaTenThousandths: -amount,
      balanceAfterTenThousandths: wallet.balanceTenThousandths,
      reservedAfterTenThousandths: nextReserved,
      frozenAfterTenThousandths: nextFrozen,
      idempotencyKey: `publisher:resubmit-reserve:${input.itemId}:${input.authorizedAt.toISOString()}`,
      reservationId: reservation.id,
      itemId: input.itemId,
      actorId: input.actorId,
      referenceType: "publication_item",
      referenceId: input.itemId,
      reason: input.reason,
      metadata: { authorizedAt: input.authorizedAt.toISOString() },
    });
  return true;
}
