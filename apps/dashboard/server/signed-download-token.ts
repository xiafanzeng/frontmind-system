import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto";

const TOKEN_VERSION = 1 as const;
const DEVELOPMENT_TOKEN_SECRET =
  "frontmind-development-download-token-secret-do-not-use-in-production";
const DOWNLOAD_TOKEN_DERIVATION_SALT = Buffer.from(
  "frontmind-dashboard/download-token/salt/v1",
  "utf8",
);
const DOWNLOAD_TOKEN_DERIVATION_INFO = Buffer.from(
  "frontmind-dashboard/download-token-signing/v1",
  "utf8",
);

export type OwnedFileDownloadClaims = {
  v: typeof TOKEN_VERSION;
  kind: "owned_file";
  userId: number;
  fileId: string;
  credentialId: string;
  projectAssignmentId: string | null;
  exp: number;
};

export type PreparedFileDownloadClaims = {
  v: typeof TOKEN_VERSION;
  kind: "prepared_file";
  userId: number;
  assetId: string;
  credentialId: string;
  projectAssignmentId: string | null;
  exp: number;
};

export type DownloadTokenClaims =
  | OwnedFileDownloadClaims
  | PreparedFileDownloadClaims;

export class SignedDownloadTokenError extends Error {
  constructor(
    public readonly code:
      | "DOWNLOAD_TOKEN_SECRET_UNAVAILABLE"
      | "DOWNLOAD_TOKEN_INVALID"
      | "DOWNLOAD_TOKEN_EXPIRED",
    message: string,
  ) {
    super(message);
    this.name = "SignedDownloadTokenError";
  }
}

function decodeProductionCredentialMasterKey(value: string) {
  const trimmed = value.trim();
  if (!trimmed.startsWith("base64:")) {
    throw new SignedDownloadTokenError(
      "DOWNLOAD_TOKEN_SECRET_UNAVAILABLE",
      "下载令牌派生主密钥格式无效",
    );
  }
  const encoded = trimmed.slice("base64:".length);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
    throw new SignedDownloadTokenError(
      "DOWNLOAD_TOKEN_SECRET_UNAVAILABLE",
      "下载令牌派生主密钥格式无效",
    );
  }
  const decoded = Buffer.from(encoded, "base64");
  if (
    decoded.length !== 32 ||
    decoded.toString("base64").replace(/=+$/u, "") !==
      encoded.replace(/=+$/u, "")
  ) {
    throw new SignedDownloadTokenError(
      "DOWNLOAD_TOKEN_SECRET_UNAVAILABLE",
      "下载令牌派生主密钥格式无效",
    );
  }
  return decoded;
}

/**
 * Existing production replicas already share this 32-byte credential master
 * key. HKDF creates an independent signing sub-key, so the AES key bytes are
 * never reused directly for download-token HMACs.
 */
export function deriveDownloadTokenSecretFromCredentialMasterKey(
  encodedMasterKey: string,
) {
  const masterKey = decodeProductionCredentialMasterKey(encodedMasterKey);
  return Buffer.from(
    hkdfSync(
      "sha256",
      masterKey,
      DOWNLOAD_TOKEN_DERIVATION_SALT,
      DOWNLOAD_TOKEN_DERIVATION_INFO,
      32,
    ),
  ).toString("base64url");
}

/**
 * Every application instance must use the same signing secret. Production is
 * deliberately fail-closed: silently generating an in-memory secret would
 * recreate the cross-instance 404/410 problem this token format fixes.
 */
export function resolveDownloadTokenSecret(explicitSecret?: string) {
  const configured =
    explicitSecret?.trim() ||
    process.env.FRONTMIND_DOWNLOAD_TOKEN_SECRET?.trim() ||
    process.env.JWT_SECRET?.trim() ||
    "";
  if (configured) {
    if (process.env.NODE_ENV === "production" && configured.length < 32) {
      throw new SignedDownloadTokenError(
        "DOWNLOAD_TOKEN_SECRET_UNAVAILABLE",
        "下载令牌签名密钥长度不足",
      );
    }
    return configured;
  }
  if (process.env.NODE_ENV === "production") {
    return deriveDownloadTokenSecretFromCredentialMasterKey(
      process.env.FRONTMIND_CREDENTIAL_ENCRYPTION_KEY ?? "",
    );
  }
  return DEVELOPMENT_TOKEN_SECRET;
}

function signature(payload: string, secret: string) {
  return createHmac("sha256", secret).update(payload).digest();
}

function isRequiredIdentifier(value: unknown, maximumLength = 255) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximumLength &&
    !/[\0\r\n]/.test(value)
  );
}

function isProjectAssignmentId(value: unknown) {
  return value === null || isRequiredIdentifier(value);
}

function optionalProjectContextValue(value: unknown) {
  if (value === undefined || value === null || value === "") return null;
  if (!isRequiredIdentifier(value)) {
    throw new SignedDownloadTokenError(
      "DOWNLOAD_TOKEN_INVALID",
      "下载链接的客户项目上下文无效",
    );
  }
  return value as string;
}

/**
 * Native browser downloads cannot attach the project header used by API
 * fetches. The signed URL therefore repeats the non-secret assignment id in a
 * query parameter. All project signals that are present must agree exactly.
 */
export function resolveDownloadProjectContext(input: {
  middleware?: unknown;
  query?: unknown;
  header?: unknown;
}) {
  const values = [input.middleware, input.query, input.header]
    .map(optionalProjectContextValue)
    .filter((value): value is string => value !== null);
  if (new Set(values).size > 1) {
    throw new SignedDownloadTokenError(
      "DOWNLOAD_TOKEN_INVALID",
      "下载链接与当前客户项目不匹配",
    );
  }
  return values[0] ?? null;
}

export function bindDownloadUrlToProject(
  downloadUrl: string,
  projectAssignmentId?: string | null,
) {
  if (!projectAssignmentId) return downloadUrl;
  const separator = downloadUrl.includes("?") ? "&" : "?";
  return `${downloadUrl}${separator}projectAssignmentId=${encodeURIComponent(
    projectAssignmentId,
  )}`;
}

function parseClaims(value: unknown): DownloadTokenClaims {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new SignedDownloadTokenError(
      "DOWNLOAD_TOKEN_INVALID",
      "下载链接无效",
    );
  }
  const claims = value as Record<string, unknown>;
  if (
    claims.v !== TOKEN_VERSION ||
    !Number.isInteger(claims.userId) ||
    Number(claims.userId) < 1 ||
    !Number.isSafeInteger(claims.exp) ||
    Number(claims.exp) < 1 ||
    !isRequiredIdentifier(claims.credentialId) ||
    !isProjectAssignmentId(claims.projectAssignmentId)
  ) {
    throw new SignedDownloadTokenError(
      "DOWNLOAD_TOKEN_INVALID",
      "下载链接无效",
    );
  }

  if (claims.kind === "owned_file" && isRequiredIdentifier(claims.fileId)) {
    return {
      v: TOKEN_VERSION,
      kind: "owned_file",
      userId: Number(claims.userId),
      fileId: claims.fileId as string,
      credentialId: claims.credentialId as string,
      projectAssignmentId: claims.projectAssignmentId as string | null,
      exp: Number(claims.exp),
    };
  }
  if (
    claims.kind === "prepared_file" &&
    typeof claims.assetId === "string" &&
    /^[a-f0-9]{40}$/.test(claims.assetId)
  ) {
    return {
      v: TOKEN_VERSION,
      kind: "prepared_file",
      userId: Number(claims.userId),
      assetId: claims.assetId,
      credentialId: claims.credentialId as string,
      projectAssignmentId: claims.projectAssignmentId as string | null,
      exp: Number(claims.exp),
    };
  }
  throw new SignedDownloadTokenError("DOWNLOAD_TOKEN_INVALID", "下载链接无效");
}

export function createSignedDownloadToken(
  claims:
    | Omit<OwnedFileDownloadClaims, "v">
    | Omit<PreparedFileDownloadClaims, "v">,
  options: { secret?: string } = {},
) {
  // Validate the exact payload before it is signed, including opaque file IDs.
  const normalized = parseClaims({ v: TOKEN_VERSION, ...claims });
  const payload = Buffer.from(JSON.stringify(normalized), "utf8").toString(
    "base64url",
  );
  const secret = resolveDownloadTokenSecret(options.secret);
  return `${payload}.${signature(payload, secret).toString("base64url")}`;
}

export function verifySignedDownloadToken<
  TKind extends DownloadTokenClaims["kind"],
>(
  token: string,
  expectedKind: TKind,
  options: { secret?: string; now?: number } = {},
): Extract<DownloadTokenClaims, { kind: TKind }> {
  if (typeof token !== "string" || token.length > 4_096) {
    throw new SignedDownloadTokenError(
      "DOWNLOAD_TOKEN_INVALID",
      "下载链接无效",
    );
  }
  const [payload, encodedSignature, extra] = token.split(".");
  if (!payload || !encodedSignature || extra) {
    throw new SignedDownloadTokenError(
      "DOWNLOAD_TOKEN_INVALID",
      "下载链接无效",
    );
  }
  const expectedSignature = signature(
    payload,
    resolveDownloadTokenSecret(options.secret),
  );
  let actualSignature: Buffer;
  try {
    actualSignature = Buffer.from(encodedSignature, "base64url");
  } catch {
    actualSignature = Buffer.alloc(0);
  }
  if (
    actualSignature.length !== expectedSignature.length ||
    !timingSafeEqual(actualSignature, expectedSignature)
  ) {
    throw new SignedDownloadTokenError(
      "DOWNLOAD_TOKEN_INVALID",
      "下载链接无效",
    );
  }

  let claims: DownloadTokenClaims;
  try {
    claims = parseClaims(
      JSON.parse(Buffer.from(payload, "base64url").toString("utf8")),
    );
  } catch (error) {
    if (error instanceof SignedDownloadTokenError) throw error;
    throw new SignedDownloadTokenError(
      "DOWNLOAD_TOKEN_INVALID",
      "下载链接无效",
    );
  }
  if (claims.kind !== expectedKind) {
    throw new SignedDownloadTokenError(
      "DOWNLOAD_TOKEN_INVALID",
      "下载链接类型无效",
    );
  }
  if (claims.exp <= (options.now ?? Date.now())) {
    throw new SignedDownloadTokenError(
      "DOWNLOAD_TOKEN_EXPIRED",
      "下载链接已失效",
    );
  }
  return claims as Extract<DownloadTokenClaims, { kind: TKind }>;
}
