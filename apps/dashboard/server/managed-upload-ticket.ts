import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto";

import {
  assertSafeExternalUrl,
  ExternalUrlRejectedError,
} from "./_core/safe-external-url";

const TICKET_VERSION = "mu1" as const;
const TICKET_KIND = "managed_file_upload" as const;
const MAX_TICKET_BYTES = 12_000;
const MAX_TARGET_BYTES = 4_096;
const MAX_FILENAME_BYTES = 512;
const MAX_IDENTIFIER_BYTES = 255;
const MAX_TICKET_TTL_MS = 5 * 60_000;
const EXPIRY_SAFETY_MS = 5_000;
const DERIVATION_SALT = Buffer.from(
  "frontmind-dashboard/managed-upload-ticket/salt/v1",
  "utf8",
);
const DERIVATION_INFO = Buffer.from(
  "frontmind-dashboard/managed-upload-ticket/signing/v1",
  "utf8",
);
const SIGNATURE_DOMAIN = "frontmind-dashboard/managed-upload-ticket:v1.";

export type ManagedUploadTicketClaims = {
  v: 1;
  kind: typeof TICKET_KIND;
  fileId: string;
  ownerUserId: number;
  credentialId: string;
  projectAssignmentId: string | null;
  providerFilename: string;
  target: string;
  iat: number;
  exp: number;
};

export class ManagedUploadTicketError extends Error {
  constructor(
    readonly code:
      | "UPLOAD_TICKET_SECRET_UNAVAILABLE"
      | "UPLOAD_CAPABILITY_INVALID"
      | "UPLOAD_CAPABILITY_EXPIRED",
    message: string,
  ) {
    super(message);
    this.name = "ManagedUploadTicketError";
  }
}

function invalidTicket(message = "Invalid managed upload capability"): never {
  throw new ManagedUploadTicketError("UPLOAD_CAPABILITY_INVALID", message);
}

function decodeCredentialMasterKey(value: string) {
  const trimmed = value.trim();
  let decoded: Buffer;
  try {
    if (trimmed.startsWith("base64:")) {
      decoded = Buffer.from(trimmed.slice("base64:".length), "base64");
    } else if (trimmed.startsWith("hex:")) {
      decoded = Buffer.from(trimmed.slice("hex:".length), "hex");
    } else if (/^[a-f\d]{64}$/iu.test(trimmed)) {
      decoded = Buffer.from(trimmed, "hex");
    } else {
      decoded = Buffer.from(trimmed, "base64");
    }
  } catch {
    throw new ManagedUploadTicketError(
      "UPLOAD_TICKET_SECRET_UNAVAILABLE",
      "Managed upload signing key is invalid",
    );
  }
  if (decoded.length !== 32) {
    throw new ManagedUploadTicketError(
      "UPLOAD_TICKET_SECRET_UNAVAILABLE",
      "Managed upload signing key must contain exactly 32 bytes",
    );
  }
  return decoded;
}

/** Derives a cross-replica, domain-separated signing key without a new secret. */
export function deriveManagedUploadTicketKey(encodedMasterKey: string) {
  return Buffer.from(
    hkdfSync(
      "sha256",
      decodeCredentialMasterKey(encodedMasterKey),
      DERIVATION_SALT,
      DERIVATION_INFO,
      32,
    ),
  );
}

export function resolveManagedUploadTicketKey() {
  const configured = process.env.FRONTMIND_CREDENTIAL_ENCRYPTION_KEY?.trim();
  if (!configured) {
    throw new ManagedUploadTicketError(
      "UPLOAD_TICKET_SECRET_UNAVAILABLE",
      "Managed upload signing key is not configured",
    );
  }
  return deriveManagedUploadTicketKey(configured);
}

function signature(encodedClaims: string, key: Buffer) {
  return createHmac("sha256", key)
    .update(`${SIGNATURE_DOMAIN}${encodedClaims}`, "utf8")
    .digest();
}

function parsedEpochMs(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value < 1_000_000_000_000 ? value * 1_000 : value;
  }
  if (typeof value !== "string" || !value.trim()) return null;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) {
    return numeric < 1_000_000_000_000 ? numeric * 1_000 : numeric;
  }
  const iso = value.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/u,
  );
  if (!iso) return null;
  const milliseconds = Number((iso[7] || "0").padEnd(3, "0"));
  const parsed = Date.UTC(
    Number(iso[1]),
    Number(iso[2]) - 1,
    Number(iso[3]),
    Number(iso[4]),
    Number(iso[5]),
    Number(iso[6]),
    milliseconds,
  );
  const roundtrip = new Date(parsed);
  return roundtrip.getUTCFullYear() === Number(iso[1]) &&
    roundtrip.getUTCMonth() === Number(iso[2]) - 1 &&
    roundtrip.getUTCDate() === Number(iso[3]) &&
    roundtrip.getUTCHours() === Number(iso[4]) &&
    roundtrip.getUTCMinutes() === Number(iso[5]) &&
    roundtrip.getUTCSeconds() === Number(iso[6]) &&
    roundtrip.getUTCMilliseconds() === milliseconds
    ? parsed
    : null;
}

function exactUtcTimestamp(parts: RegExpMatchArray) {
  const values = parts.slice(1, 7).map(Number);
  const timestamp = Date.UTC(
    values[0],
    values[1] - 1,
    values[2],
    values[3],
    values[4],
    values[5],
  );
  const parsed = new Date(timestamp);
  return parsed.getUTCFullYear() === values[0] &&
    parsed.getUTCMonth() === values[1] - 1 &&
    parsed.getUTCDate() === values[2] &&
    parsed.getUTCHours() === values[3] &&
    parsed.getUTCMinutes() === values[4] &&
    parsed.getUTCSeconds() === values[5]
    ? timestamp
    : null;
}

function signedTargetExpiry(target: string) {
  try {
    const parsed = new URL(target);
    const hasSignedAt = parsed.searchParams.has("X-Amz-Date");
    const hasExpires = parsed.searchParams.has("X-Amz-Expires");
    if (!hasSignedAt && !hasExpires) return { state: "absent" } as const;
    const signedAtValue = parsed.searchParams.get("X-Amz-Date");
    const expiresValue = parsed.searchParams.get("X-Amz-Expires");
    const signedAt = signedAtValue?.match(
      /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/u,
    );
    if (!signedAt || !expiresValue || !/^\d+$/u.test(expiresValue)) {
      return { state: "invalid" } as const;
    }
    const signedAtMs = exactUtcTimestamp(signedAt);
    if (signedAtMs === null) return { state: "invalid" } as const;
    const expiresSeconds = Number(expiresValue);
    if (!Number.isSafeInteger(expiresSeconds) || expiresSeconds < 0) {
      return { state: "invalid" } as const;
    }
    return {
      state: "valid",
      value: signedAtMs + expiresSeconds * 1_000,
    } as const;
  } catch {
    return { state: "invalid" } as const;
  }
}

function requiredString(value: unknown, maximumBytes = MAX_IDENTIFIER_BYTES) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    Buffer.byteLength(value, "utf8") <= maximumBytes &&
    !/[\0\r\n]/u.test(value)
  );
}

function validClaims(value: unknown): value is ManagedUploadTicketClaims {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const claims = value as Record<string, unknown>;
  const expectedKeys = [
    "credentialId",
    "exp",
    "fileId",
    "iat",
    "kind",
    "ownerUserId",
    "projectAssignmentId",
    "providerFilename",
    "target",
    "v",
  ];
  if (Object.keys(claims).sort().join("\0") !== expectedKeys.join("\0")) {
    return false;
  }
  return (
    claims.v === 1 &&
    claims.kind === TICKET_KIND &&
    requiredString(claims.fileId) &&
    typeof claims.ownerUserId === "number" &&
    Number.isSafeInteger(claims.ownerUserId) &&
    claims.ownerUserId > 0 &&
    requiredString(claims.credentialId) &&
    (claims.projectAssignmentId === null ||
      requiredString(claims.projectAssignmentId)) &&
    requiredString(claims.providerFilename, MAX_FILENAME_BYTES) &&
    requiredString(claims.target, MAX_TARGET_BYTES) &&
    typeof claims.iat === "number" &&
    Number.isSafeInteger(claims.iat) &&
    typeof claims.exp === "number" &&
    Number.isSafeInteger(claims.exp) &&
    claims.exp > claims.iat &&
    claims.exp - claims.iat <= Math.ceil(MAX_TICKET_TTL_MS / 1_000)
  );
}

export function createManagedUploadTicket(
  input: {
    fileId: string;
    ownerUserId: number;
    credentialId: string;
    projectAssignmentId?: string | null;
    providerFilename: string;
    target: string;
    upstreamExpiresAt?: unknown;
  },
  options: { now?: number; key?: Buffer } = {},
) {
  const now = options.now ?? Date.now();
  const target = assertSafeExternalUrl(input.target);
  if (new URL(target).protocol !== "https:") {
    invalidTicket("Managed upload capability must use HTTPS");
  }
  const explicitUpstreamExpiry = parsedEpochMs(input.upstreamExpiresAt);
  if (
    input.upstreamExpiresAt !== undefined &&
    input.upstreamExpiresAt !== null &&
    explicitUpstreamExpiry === null
  ) {
    invalidTicket("Managed upload capability has an invalid provider expiry");
  }
  const signedExpiry = signedTargetExpiry(target);
  if (signedExpiry.state === "invalid") {
    invalidTicket("Managed upload capability has invalid signed URL timing");
  }
  const providerDeadlines = [
    explicitUpstreamExpiry,
    signedExpiry.state === "valid" ? signedExpiry.value : null,
  ].filter((value): value is number => value !== null);
  if (providerDeadlines.length < 1) {
    // The final candidate is our local cap; at least one provider-owned expiry
    // must also be available so this ticket can never outlive its capability.
    invalidTicket("Managed upload capability has no usable provider expiry");
  }
  const expiresAt =
    Math.min(...providerDeadlines, now + MAX_TICKET_TTL_MS) - EXPIRY_SAFETY_MS;
  const issuedAtSeconds = Math.floor(now / 1_000);
  const expiresAtSeconds = Math.floor(expiresAt / 1_000);
  const claims: ManagedUploadTicketClaims = {
    v: 1,
    kind: TICKET_KIND,
    fileId: input.fileId,
    ownerUserId: input.ownerUserId,
    credentialId: input.credentialId,
    projectAssignmentId: input.projectAssignmentId ?? null,
    providerFilename: input.providerFilename,
    target,
    iat: issuedAtSeconds,
    exp: expiresAtSeconds,
  };
  if (!validClaims(claims) || expiresAtSeconds <= issuedAtSeconds) {
    invalidTicket();
  }
  const encodedClaims = Buffer.from(JSON.stringify(claims), "utf8").toString(
    "base64url",
  );
  const encodedSignature = signature(
    encodedClaims,
    options.key ?? resolveManagedUploadTicketKey(),
  ).toString("base64url");
  return {
    ticket: `${TICKET_VERSION}.${encodedClaims}.${encodedSignature}`,
    expiresAt: expiresAtSeconds * 1_000,
  };
}

export function openManagedUploadTicket(
  ticket: string,
  expected: {
    fileId: string;
    ownerUserId: number;
    credentialId: string;
    projectAssignmentId?: string | null;
    providerFilename?: string;
  },
  options: { now?: number; key?: Buffer; allowExpired?: boolean } = {},
) {
  if (!ticket || Buffer.byteLength(ticket, "utf8") > MAX_TICKET_BYTES) {
    invalidTicket();
  }
  const parts = ticket.split(".");
  const [version, encodedClaims, encodedSignature] = parts;
  if (
    parts.length !== 3 ||
    version !== TICKET_VERSION ||
    !encodedClaims ||
    !encodedSignature
  ) {
    invalidTicket();
  }
  const expectedSignature = signature(
    encodedClaims,
    options.key ?? resolveManagedUploadTicketKey(),
  );
  let suppliedSignature: Buffer;
  try {
    suppliedSignature = Buffer.from(encodedSignature, "base64url");
  } catch {
    invalidTicket();
  }
  if (
    suppliedSignature!.toString("base64url") !== encodedSignature ||
    suppliedSignature!.length !== expectedSignature.length ||
    !timingSafeEqual(suppliedSignature!, expectedSignature)
  ) {
    invalidTicket();
  }
  let claims: ManagedUploadTicketClaims;
  try {
    const bytes = Buffer.from(encodedClaims, "base64url");
    if (bytes.toString("base64url") !== encodedClaims) invalidTicket();
    const parsed = JSON.parse(bytes.toString("utf8"));
    if (!validClaims(parsed)) invalidTicket();
    claims = parsed;
  } catch (error) {
    if (error instanceof ManagedUploadTicketError) throw error;
    invalidTicket();
  }
  const projectAssignmentId = expected.projectAssignmentId ?? null;
  if (
    claims!.fileId !== expected.fileId ||
    claims!.ownerUserId !== expected.ownerUserId ||
    claims!.credentialId !== expected.credentialId ||
    claims!.projectAssignmentId !== projectAssignmentId ||
    (expected.providerFilename !== undefined &&
      claims!.providerFilename !== expected.providerFilename)
  ) {
    invalidTicket("Managed upload capability binding mismatch");
  }
  try {
    const target = assertSafeExternalUrl(claims!.target);
    if (new URL(target).protocol !== "https:") invalidTicket();
  } catch (error) {
    if (error instanceof ExternalUrlRejectedError) invalidTicket();
    throw error;
  }
  const nowSeconds = Math.floor((options.now ?? Date.now()) / 1_000);
  if (!options.allowExpired && claims!.exp <= nowSeconds) {
    throw new ManagedUploadTicketError(
      "UPLOAD_CAPABILITY_EXPIRED",
      "Managed upload capability has expired",
    );
  }
  return claims!;
}
