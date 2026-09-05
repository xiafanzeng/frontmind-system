import { z } from "zod";

const INVALID_CONTROLS =
  /[\p{Cc}\p{Cf}\u2028\u2029\u202A-\u202E\u2066-\u2069]/u;
const ALLOWED_CHARACTERS = /^[\p{L}\p{M}\p{N} ·・.\-'’]+$/u;

export function normalizeBusinessOwnerName(value: string) {
  if (INVALID_CONTROLS.test(value)) {
    throw new Error("BUSINESS_OWNER_NAME_INVALID");
  }
  const normalized = value.normalize("NFKC").trim().replace(/\s+/gu, " ");
  const codePoints = Array.from(normalized);
  if (
    codePoints.length < 1 ||
    codePoints.length > 40 ||
    !ALLOWED_CHARACTERS.test(normalized)
  ) {
    throw new Error("BUSINESS_OWNER_NAME_INVALID");
  }
  return normalized;
}

export const businessOwnerNameSchema = z
  .string()
  .transform((value, context) => {
    try {
      return normalizeBusinessOwnerName(value);
    } catch {
      context.addIssue({
        code: "custom",
        message: "Invalid business owner name",
      });
      return z.NEVER;
    }
  });
