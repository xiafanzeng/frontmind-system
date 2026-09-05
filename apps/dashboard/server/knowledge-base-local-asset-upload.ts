import { createHash } from "node:crypto";

import {
  KNOWLEDGE_BASE_LOCAL_UPLOAD_HEADERS,
  type KnowledgeBaseLocalUploadCoordinate,
} from "../shared/knowledge-base-local-upload";

type HeaderValue = string | string[] | undefined;

export class KnowledgeBaseLocalAssetCoordinateError extends Error {
  readonly code = "KNOWLEDGE_BASE_UPLOAD_COORDINATE_INVALID";

  constructor() {
    super("Knowledge-base upload coordinate is invalid");
    this.name = "KnowledgeBaseLocalAssetCoordinateError";
  }
}

function lowerCaseHeaders(headers: Record<string, HeaderValue>) {
  return new Map(
    Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]),
  );
}

function scalarHeader(
  headers: Map<string, HeaderValue>,
  name: string,
): string | undefined {
  const value = headers.get(name.toLowerCase());
  if (Array.isArray(value)) return undefined;
  return typeof value === "string" ? value.trim() : undefined;
}

/**
 * Ordinary-chat uploads send none of these headers. A knowledge-base upload
 * must send the complete set so a partial or forged coordinate cannot silently
 * fall back to a non-idempotent asset.
 */
export function parseKnowledgeBaseLocalUploadCoordinate(
  inputHeaders: Record<string, HeaderValue>,
): KnowledgeBaseLocalUploadCoordinate | null {
  const headers = lowerCaseHeaders(inputHeaders);
  const coordinateNames = Object.values(
    KNOWLEDGE_BASE_LOCAL_UPLOAD_HEADERS,
  ).filter((name) => name !== KNOWLEDGE_BASE_LOCAL_UPLOAD_HEADERS.attempt);
  const requiredNames = coordinateNames.filter(
    (name) => name !== KNOWLEDGE_BASE_LOCAL_UPLOAD_HEADERS.contentSha256,
  );
  const anyPresent = coordinateNames.filter(
    (name) => scalarHeader(headers, name) !== undefined,
  );
  if (anyPresent.length === 0) return null;
  const requiredPresent = requiredNames.filter(
    (name) => scalarHeader(headers, name) !== undefined,
  );
  if (requiredPresent.length !== requiredNames.length) {
    throw new KnowledgeBaseLocalAssetCoordinateError();
  }

  const conversationId = scalarHeader(
    headers,
    KNOWLEDGE_BASE_LOCAL_UPLOAD_HEADERS.conversationId,
  )!;
  const turnId = scalarHeader(
    headers,
    KNOWLEDGE_BASE_LOCAL_UPLOAD_HEADERS.turnId,
  )!;
  const clientRequestId = scalarHeader(
    headers,
    KNOWLEDGE_BASE_LOCAL_UPLOAD_HEADERS.clientRequestId,
  )!;
  const itemId = scalarHeader(
    headers,
    KNOWLEDGE_BASE_LOCAL_UPLOAD_HEADERS.itemId,
  )!;
  const expectedResetRevision = Number(
    scalarHeader(
      headers,
      KNOWLEDGE_BASE_LOCAL_UPLOAD_HEADERS.expectedResetRevision,
    ),
  );
  const contentSha256 = scalarHeader(
    headers,
    KNOWLEDGE_BASE_LOCAL_UPLOAD_HEADERS.contentSha256,
  )?.toLowerCase();
  const ordinal = Number(
    scalarHeader(headers, KNOWLEDGE_BASE_LOCAL_UPLOAD_HEADERS.ordinal),
  );

  if (
    !conversationId ||
    conversationId.length > 191 ||
    !turnId ||
    turnId.length > 191 ||
    !clientRequestId ||
    clientRequestId.length > 128 ||
    !itemId ||
    itemId.length > 191 ||
    !Number.isSafeInteger(expectedResetRevision) ||
    expectedResetRevision < 0 ||
    (contentSha256 !== undefined && !/^[a-f0-9]{64}$/u.test(contentSha256)) ||
    !Number.isSafeInteger(ordinal) ||
    ordinal < 1 ||
    ordinal > 1_000
  ) {
    throw new KnowledgeBaseLocalAssetCoordinateError();
  }

  return {
    conversationId,
    turnId,
    clientRequestId,
    itemId,
    expectedResetRevision,
    ...(contentSha256 ? { contentSha256 } : {}),
    ordinal,
  };
}

function digest(value: unknown) {
  return createHash("sha256")
    .update(JSON.stringify(value), "utf8")
    .digest("hex");
}

/**
 * The local id is stable for one reserved manifest item. Content identity is
 * deliberately part of storageKey but not localAssetId: replaying the same
 * item with changed bytes therefore becomes a conflict instead of a fork.
 */
export function knowledgeBaseLocalAssetIdentity(input: {
  userId: number;
  projectAssignmentId: string | null;
  coordinate: KnowledgeBaseLocalUploadCoordinate;
  sizeBytes: number;
  /** Digest calculated from the complete Dashboard-owned upload stream. */
  authoritativeContentSha256?: string;
}) {
  const operation = [
    input.userId,
    input.projectAssignmentId,
    input.coordinate.conversationId,
    input.coordinate.turnId,
    input.coordinate.clientRequestId,
    input.coordinate.itemId,
    input.coordinate.expectedResetRevision,
  ];
  const operationDigest = digest(operation);
  const contentSha256 =
    input.authoritativeContentSha256 ?? input.coordinate.contentSha256;
  const contentDigest = contentSha256
    ? digest([operationDigest, contentSha256, input.sizeBytes])
    : null;
  return {
    localAssetId: `asset_${operationDigest.slice(0, 30)}`,
    ...(contentDigest
      ? { storageKey: `frontmind-v2:knowledge-base:${contentDigest}` }
      : {}),
  };
}

export function knowledgeBaseLocalAssetContentReplayMatches(
  existing: {
    sizeBytes: number;
    contentSha256: string;
    storageKey: string;
  },
  expected: {
    sizeBytes: number;
    contentSha256: string;
    storageKey: string;
  },
) {
  return (
    existing.sizeBytes === expected.sizeBytes &&
    existing.contentSha256.toLowerCase() ===
      expected.contentSha256.toLowerCase() &&
    existing.storageKey === expected.storageKey
  );
}

export type KnowledgeBaseLocalAssetStoredContentState =
  | "matching"
  | "missing"
  | "mismatched";

/**
 * Decide whether an already-sealed deterministic row can be replayed or have
 * its missing/expired body rebuilt. Display metadata is intentionally absent:
 * the live frozen manifest already proved the incoming filename and MIME, and
 * neither field is part of the Dashboard-owned content identity.
 */
export function knowledgeBaseLocalAssetExistingRowDisposition(input: {
  existing: {
    id: string;
    scope: string;
    accountUserId: number | null;
    presalesProjectId: string | null;
    sizeBytes: number;
    contentSha256: string;
    storageKey: string;
    storageKeyHash: string;
    retainUntil: Date | null;
  };
  expected: {
    localAssetId: string;
    ownerUserId: number;
    sizeBytes: number;
    contentSha256: string;
    storageKey: string;
    storageKeyHash: string;
  };
  storedContent: KnowledgeBaseLocalAssetStoredContentState;
  now: number;
}):
  | { action: "replay"; status: 200 }
  | { action: "rebuild"; status: 201 }
  | { action: "conflict"; status: 409 } {
  const { existing, expected } = input;
  if (
    existing.id !== expected.localAssetId ||
    existing.scope !== "managed_user" ||
    existing.accountUserId !== expected.ownerUserId ||
    existing.presalesProjectId !== null ||
    !knowledgeBaseLocalAssetContentReplayMatches(existing, expected) ||
    existing.storageKeyHash !== expected.storageKeyHash ||
    input.storedContent === "mismatched"
  ) {
    return { action: "conflict", status: 409 };
  }
  if (
    input.storedContent === "missing" ||
    (existing.retainUntil?.getTime() ?? 0) <= input.now
  ) {
    return { action: "rebuild", status: 201 };
  }
  return { action: "replay", status: 200 };
}
