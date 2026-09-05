import { createHash } from "node:crypto";

import {
  SITEOPS_COMPOSER_LOCAL_UPLOAD_HEADERS,
  SITEOPS_COMPOSER_LOCAL_UPLOAD_SCOPE,
  type SiteOpsComposerLocalUploadCoordinate,
} from "../shared/siteops-composer-local-upload";

type HeaderValue = string | string[] | undefined;

export class SiteOpsComposerLocalAssetCoordinateError extends Error {
  readonly code = "SITEOPS_COMPOSER_UPLOAD_COORDINATE_INVALID";

  constructor() {
    super("SiteOps composer upload coordinate is invalid");
    this.name = "SiteOpsComposerLocalAssetCoordinateError";
  }
}

function scalarHeader(
  headers: Map<string, HeaderValue>,
  name: string,
): string | undefined {
  const value = headers.get(name.toLowerCase());
  if (Array.isArray(value)) return undefined;
  return typeof value === "string" ? value.trim() : undefined;
}

/** A partial SiteOps coordinate must never degrade to an ordinary upload. */
export function parseSiteOpsComposerLocalUploadCoordinate(
  inputHeaders: Record<string, HeaderValue>,
): SiteOpsComposerLocalUploadCoordinate | null {
  const headers = new Map(
    Object.entries(inputHeaders).map(([name, value]) => [
      name.toLowerCase(),
      value,
    ]),
  );
  const names = Object.values(SITEOPS_COMPOSER_LOCAL_UPLOAD_HEADERS);
  const present = names.filter(
    (name) => scalarHeader(headers, name) !== undefined,
  );
  if (present.length === 0) return null;
  if (present.length !== names.length) {
    throw new SiteOpsComposerLocalAssetCoordinateError();
  }

  const scope = scalarHeader(
    headers,
    SITEOPS_COMPOSER_LOCAL_UPLOAD_HEADERS.scope,
  );
  const clientRequestId = scalarHeader(
    headers,
    SITEOPS_COMPOSER_LOCAL_UPLOAD_HEADERS.clientRequestId,
  )!;
  const contentSha256 = scalarHeader(
    headers,
    SITEOPS_COMPOSER_LOCAL_UPLOAD_HEADERS.contentSha256,
  )!.toLowerCase();
  const ordinal = Number(
    scalarHeader(headers, SITEOPS_COMPOSER_LOCAL_UPLOAD_HEADERS.ordinal),
  );
  if (
    scope !== SITEOPS_COMPOSER_LOCAL_UPLOAD_SCOPE ||
    !/^[A-Za-z0-9._:-]{8,128}$/u.test(clientRequestId) ||
    !/^[a-f0-9]{64}$/u.test(contentSha256) ||
    !Number.isSafeInteger(ordinal) ||
    ordinal < 1 ||
    ordinal > 8
  ) {
    throw new SiteOpsComposerLocalAssetCoordinateError();
  }
  return { clientRequestId, contentSha256, ordinal };
}

function digest(value: unknown) {
  return createHash("sha256")
    .update(JSON.stringify(value), "utf8")
    .digest("hex");
}

/** The task epoch owns the id; exact bytes and metadata own its storage key. */
export function siteOpsComposerLocalAssetIdentity(input: {
  userId: number;
  projectId: string;
  currentTaskStartedAt: Date;
  knowledgeInputEpochId: string | null;
  coordinate: SiteOpsComposerLocalUploadCoordinate;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  authoritativeContentSha256?: string;
}) {
  const operationDigest = digest([
    input.userId,
    input.projectId,
    input.knowledgeInputEpochId ?? input.currentTaskStartedAt.toISOString(),
    input.coordinate.clientRequestId,
    input.coordinate.ordinal,
  ]);
  const contentSha256 =
    input.authoritativeContentSha256 ?? input.coordinate.contentSha256;
  const contentDigest = digest([
    operationDigest,
    contentSha256,
    input.filename,
    input.mimeType,
    input.sizeBytes,
  ]);
  return {
    localAssetId: `asset_${operationDigest.slice(0, 30)}`,
    storageKey: `frontmind-v2:siteops-composer:${contentDigest}`,
  };
}

export function siteOpsComposerLocalAssetExistingRowDisposition(input: {
  existing: {
    id: string;
    scope: string;
    accountUserId: number | null;
    presalesProjectId: string | null;
    filename: string;
    mimeType: string;
    sizeBytes: number;
    contentSha256: string;
    storageKey: string;
    storageKeyHash: string;
    retainUntil: Date | null;
    createdAt: Date;
    siteOpsKnowledgeInputEpochId: string | null;
  };
  expected: {
    localAssetId: string;
    ownerUserId: number;
    filename: string;
    mimeType: string;
    sizeBytes: number;
    contentSha256: string;
    storageKey: string;
    storageKeyHash: string;
    currentTaskStartedAt: Date;
    knowledgeInputEpochId: string | null;
  };
  storedContent: "matching" | "missing" | "mismatched";
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
    existing.filename !== expected.filename ||
    existing.mimeType !== expected.mimeType ||
    existing.sizeBytes !== expected.sizeBytes ||
    existing.contentSha256.toLowerCase() !==
      expected.contentSha256.toLowerCase() ||
    existing.storageKey !== expected.storageKey ||
    existing.storageKeyHash !== expected.storageKeyHash ||
    (expected.knowledgeInputEpochId
      ? existing.siteOpsKnowledgeInputEpochId !== expected.knowledgeInputEpochId
      : existing.siteOpsKnowledgeInputEpochId !== null ||
        existing.createdAt.getTime() <
          expected.currentTaskStartedAt.getTime()) ||
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
