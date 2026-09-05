import { createHash, timingSafeEqual } from "node:crypto";

import type { NextFunction, Request, Response } from "express";

const SERVICE_TOKEN_HEADER = "x-frontmind-service-token";
const PUBLIC_PLACEHOLDER_SERVICE_TOKENS = new Set([
  "replace-with-at-least-32-random-characters",
  "replace-with-a-random-service-token",
  "replace-with-the-same-random-token",
  "change-me-change-me-change-me-change-me",
]);
const PUBLIC_PLACEHOLDER_MARKERS = [
  "replace-with",
  "same-random-token",
  "change-me",
];

function tokenDigest(value: string) {
  return createHash("sha256").update(value, "utf8").digest();
}

export function isUsablePresalesServiceToken(token: string) {
  const normalized = token.trim();
  return (
    normalized.length >= 32 &&
    !PUBLIC_PLACEHOLDER_SERVICE_TOKENS.has(normalized.toLowerCase()) &&
    !PUBLIC_PLACEHOLDER_MARKERS.some((marker) =>
      normalized.toLowerCase().includes(marker),
    )
  );
}

export function isValidPresalesServiceToken(
  provided: string | undefined,
  configured = process.env.FRONTMIND_PRESALES_SERVICE_TOKEN,
) {
  const expected = configured ?? "";
  const candidate = provided ?? "";
  const equal = timingSafeEqual(tokenDigest(candidate), tokenDigest(expected));
  return (
    isUsablePresalesServiceToken(expected) && candidate.length > 0 && equal
  );
}

export function assertPresalesServiceConfigured() {
  const token = process.env.FRONTMIND_PRESALES_SERVICE_TOKEN ?? "";
  if (!isUsablePresalesServiceToken(token)) {
    throw new Error(
      "FRONTMIND_PRESALES_SERVICE_TOKEN must be a unique random value with at least 32 characters",
    );
  }
}

export function requirePresalesServiceToken(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  const configured = process.env.FRONTMIND_PRESALES_SERVICE_TOKEN;
  if (!configured || !isUsablePresalesServiceToken(configured)) {
    res.status(503).json({
      error: {
        code: "PRESALES_SERVICE_UNAVAILABLE",
        status: 503,
        retryable: false,
      },
    });
    return;
  }
  const header = req.headers[SERVICE_TOKEN_HEADER];
  const provided = Array.isArray(header) ? header[0] : header;
  if (!isValidPresalesServiceToken(provided, configured)) {
    res.status(401).json({
      error: { code: "INVALID_SERVICE_TOKEN", status: 401, retryable: false },
    });
    return;
  }
  res.setHeader("Cache-Control", "no-store");
  next();
}
