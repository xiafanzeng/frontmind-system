import { and, eq } from "drizzle-orm";

import {
  websitePaymentReceipts,
  type InsertWebsitePaymentReceipt,
  type WebsitePaymentReceipt,
} from "../drizzle/schema";
import {
  paymentReceiptReadRequestSchema,
  paymentReceiptResponseSchema,
  paymentReceiptWriteRequestSchema,
  type PaymentReceipt,
  type PaymentReceiptReadRequest,
  type PaymentReceiptResponse,
  type PaymentReceiptWriteRequest,
} from "../shared/payment-receipt";
import { getDb } from "./db";

const EARLIEST_SUPPORTED_PAYMENT_MS = Date.parse("2020-01-01T00:00:00.000Z");
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

export type PaymentReceiptLedgerErrorCode =
  | "PAYMENT_RECEIPT_CONFLICT"
  | "PAYMENT_RECEIPT_NOT_FOUND"
  | "PAYMENT_RECEIPT_TIMESTAMP_INVALID"
  | "PAYMENT_RECEIPT_DATABASE_UNAVAILABLE";

export class PaymentReceiptLedgerError extends Error {
  constructor(
    public readonly code: PaymentReceiptLedgerErrorCode,
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "PaymentReceiptLedgerError";
  }
}

export interface PaymentReceiptRepository {
  findByOrderId(orderId: string): Promise<WebsitePaymentReceipt | undefined>;
  findByTradeNo(tradeNo: string): Promise<WebsitePaymentReceipt | undefined>;
  findScoped(
    input: PaymentReceiptReadRequest,
  ): Promise<WebsitePaymentReceipt | undefined>;
  insert(value: InsertWebsitePaymentReceipt): Promise<WebsitePaymentReceipt>;
  ready(): Promise<void>;
}

export type PaymentReceiptLedgerService = {
  record(input: PaymentReceiptWriteRequest): Promise<{
    response: PaymentReceiptResponse;
    replayed: boolean;
  }>;
  read(input: PaymentReceiptReadRequest): Promise<PaymentReceiptResponse>;
  ready(): Promise<{ schemaVersion: 1; ready: true }>;
};

type PaymentReceiptLedgerServiceOptions = {
  repository?: PaymentReceiptRepository;
  now?: () => Date;
};

function databaseUnavailable(_error?: unknown): never {
  throw new PaymentReceiptLedgerError(
    "PAYMENT_RECEIPT_DATABASE_UNAVAILABLE",
    "The payment receipt ledger is unavailable",
    503,
  );
}

function conflict(): never {
  throw new PaymentReceiptLedgerError(
    "PAYMENT_RECEIPT_CONFLICT",
    "The order or trade number is already bound to a different payment receipt",
    409,
  );
}

function isDuplicateEntry(error: unknown) {
  return (error as { code?: unknown } | null)?.code === "ER_DUP_ENTRY";
}

function publicReceipt(row: WebsitePaymentReceipt): PaymentReceipt {
  return {
    orderId: row.orderId,
    tradeNo: row.tradeNo,
    amountFen: row.amountFen,
    paidAt: row.paidAt.toISOString(),
    purchaseType: row.purchaseType,
    scopeHash: row.scopeHash,
    authorizationDigest: row.authorizationDigest,
    reviewRequired: row.reviewRequired,
  };
}

function response(row: WebsitePaymentReceipt) {
  return paymentReceiptResponseSchema.parse({
    schemaVersion: 1,
    receipt: publicReceipt(row),
  });
}

function sameReceipt(row: WebsitePaymentReceipt, value: PaymentReceipt) {
  return (
    row.schemaVersion === 1 &&
    row.orderId === value.orderId &&
    row.tradeNo === value.tradeNo &&
    row.amountFen === value.amountFen &&
    row.paidAt.getTime() === Date.parse(value.paidAt) &&
    row.purchaseType === value.purchaseType &&
    row.scopeHash === value.scopeHash &&
    row.authorizationDigest === value.authorizationDigest &&
    row.reviewRequired === value.reviewRequired
  );
}

async function defaultRepository(): Promise<PaymentReceiptRepository> {
  const db = await getDb();
  if (!db) databaseUnavailable();

  const findByOrderId = async (orderId: string) => {
    const rows = await db
      .select()
      .from(websitePaymentReceipts)
      .where(eq(websitePaymentReceipts.orderId, orderId))
      .limit(1);
    return rows[0];
  };

  return {
    findByOrderId,
    async findByTradeNo(tradeNo) {
      const rows = await db
        .select()
        .from(websitePaymentReceipts)
        .where(eq(websitePaymentReceipts.tradeNo, tradeNo))
        .limit(1);
      return rows[0];
    },
    async findScoped(input) {
      const rows = await db
        .select()
        .from(websitePaymentReceipts)
        .where(
          and(
            eq(websitePaymentReceipts.orderId, input.orderId),
            eq(websitePaymentReceipts.scopeHash, input.scopeHash),
            eq(
              websitePaymentReceipts.authorizationDigest,
              input.authorizationDigest,
            ),
          ),
        )
        .limit(1);
      return rows[0];
    },
    async insert(value) {
      await db.insert(websitePaymentReceipts).values(value);
      const stored = await findByOrderId(value.orderId);
      if (!stored) databaseUnavailable();
      return stored;
    },
    async ready() {
      await db
        .select({ schemaVersion: websitePaymentReceipts.schemaVersion })
        .from(websitePaymentReceipts)
        .limit(1);
    },
  };
}

export function createPaymentReceiptLedgerService(
  options: PaymentReceiptLedgerServiceOptions = {},
): PaymentReceiptLedgerService {
  const repository = async () => options.repository ?? defaultRepository();
  const now = options.now ?? (() => new Date());

  return {
    async record(input) {
      const { receipt } = paymentReceiptWriteRequestSchema.parse(input);
      const paidAt = Date.parse(receipt.paidAt);
      const nowMs = now().getTime();
      if (
        paidAt < EARLIEST_SUPPORTED_PAYMENT_MS ||
        paidAt > nowMs + MAX_CLOCK_SKEW_MS
      ) {
        throw new PaymentReceiptLedgerError(
          "PAYMENT_RECEIPT_TIMESTAMP_INVALID",
          "paidAt is outside the supported payment window",
          400,
        );
      }

      try {
        const store = await repository();
        const existingOrder = await store.findByOrderId(receipt.orderId);
        if (existingOrder) {
          if (!sameReceipt(existingOrder, receipt)) conflict();
          return { response: response(existingOrder), replayed: true };
        }

        const existingTrade = await store.findByTradeNo(receipt.tradeNo);
        if (existingTrade) conflict();

        try {
          const stored = await store.insert({
            orderId: receipt.orderId,
            schemaVersion: 1,
            tradeNo: receipt.tradeNo,
            amountFen: receipt.amountFen,
            paidAt: new Date(paidAt),
            purchaseType: receipt.purchaseType,
            scopeHash: receipt.scopeHash,
            authorizationDigest: receipt.authorizationDigest,
            reviewRequired: receipt.reviewRequired,
          });
          return { response: response(stored), replayed: false };
        } catch (error) {
          if (!isDuplicateEntry(error)) throw error;
          const racedOrder = await store.findByOrderId(receipt.orderId);
          if (racedOrder && sameReceipt(racedOrder, receipt)) {
            return { response: response(racedOrder), replayed: true };
          }
          conflict();
        }
      } catch (error) {
        if (error instanceof PaymentReceiptLedgerError) throw error;
        databaseUnavailable(error);
      }
    },

    async read(input) {
      const value = paymentReceiptReadRequestSchema.parse(input);
      try {
        const stored = await (await repository()).findScoped(value);
        if (!stored) {
          throw new PaymentReceiptLedgerError(
            "PAYMENT_RECEIPT_NOT_FOUND",
            "Payment receipt not found",
            404,
          );
        }
        return response(stored);
      } catch (error) {
        if (error instanceof PaymentReceiptLedgerError) throw error;
        databaseUnavailable(error);
      }
    },

    async ready() {
      try {
        await (await repository()).ready();
        return { schemaVersion: 1, ready: true };
      } catch (error) {
        if (error instanceof PaymentReceiptLedgerError) throw error;
        databaseUnavailable(error);
      }
    },
  };
}
