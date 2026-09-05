import crypto from "node:crypto";
import { PaymentError } from "./errors.js";

const MAX_ORDER_ID_BITS = 106n;
const HASH_PREFIX_BYTES = 14;

function boundedIdentityPart(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 256) {
    throw new PaymentError(`${field}格式无效`, "PAYMENT_REQUEST_INVALID", 400);
  }
  return normalized;
}

/**
 * Derives ZPAY's required numeric order identifier without timestamps or
 * random state. The length-prefixed, domain-separated material makes retries
 * for one user/idempotency key stable while keeping other users isolated.
 *
 * The first 106 SHA-256 bits fit in at most 32 decimal digits. The probability
 * of a collision remains negligible for this product, while the database
 * unique constraint is still the final collision guard.
 */
export function deriveZpayProviderOrderId(input: {
  userId: string;
  idempotencyKey: string;
}): string {
  const userId = boundedIdentityPart(input.userId, "用户");
  const idempotencyKey = boundedIdentityPart(input.idempotencyKey, "幂等键");
  const material = JSON.stringify([
    "frontmind:zpay-provider-order:v1",
    userId,
    idempotencyKey,
  ]);
  const prefix = crypto
    .createHash("sha256")
    .update(material, "utf8")
    .digest()
    .subarray(0, HASH_PREFIX_BYTES);
  const value =
    BigInt(`0x${prefix.toString("hex")}`) >>
    (BigInt(HASH_PREFIX_BYTES * 8) - MAX_ORDER_ID_BITS);
  return (value === 0n ? 1n : value).toString(10);
}
