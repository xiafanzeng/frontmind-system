import { createHmac, timingSafeEqual } from "node:crypto";

import type { KnowledgeBaseApprovedResourceDto } from "../shared/knowledge-base-progress";
import { customerSafeKnowledgeAssetLabel } from "../shared/knowledge-base-public-artifacts";
import { resolveDownloadTokenSecret } from "./signed-download-token";

const RESOURCE_HANDLE_VERSION = "frontmind.kb-public-resource.v1";
const OPAQUE_PART_RE = /^[A-Za-z0-9_-]{43}$/u;

export type KnowledgeBasePublicResourceKind =
  | "logo"
  | "customer_upload"
  | "working_set_asset";

function signature(domain: string, payload: string) {
  return createHmac("sha256", resolveDownloadTokenSecret())
    .update(`${RESOURCE_HANDLE_VERSION}\0${domain}\0${payload}`, "utf8")
    .digest("base64url");
}

function safeEqual(left: string, right: string) {
  if (!OPAQUE_PART_RE.test(left) || !OPAQUE_PART_RE.test(right)) return false;
  const leftBytes = Buffer.from(left, "base64url");
  const rightBytes = Buffer.from(right, "base64url");
  return (
    leftBytes.length === rightBytes.length &&
    timingSafeEqual(leftBytes, rightBytes)
  );
}

export function knowledgeBasePublicBuildSelector(buildId: string) {
  return signature("build", buildId);
}

export function knowledgeBasePublicBuildSelectorMatches(input: {
  suppliedSelector: string;
  buildId: string;
}) {
  return safeEqual(
    input.suppliedSelector,
    knowledgeBasePublicBuildSelector(input.buildId),
  );
}

export function knowledgeBaseOfficialLogoInternalIdentity(input: {
  generation: number;
  sha256: string;
}) {
  return `${input.generation}\0${input.sha256}`;
}

export function knowledgeBasePublicResourceHandle(input: {
  buildId: string;
  kind: KnowledgeBasePublicResourceKind;
  internalIdentity: string;
}) {
  const buildSelector = knowledgeBasePublicBuildSelector(input.buildId);
  const resourceSelector = signature(
    "resource",
    `${input.buildId}\0${input.kind}\0${input.internalIdentity}`,
  );
  return `${buildSelector}.${resourceSelector}`;
}

export function parseKnowledgeBasePublicResourceHandle(value: unknown) {
  const candidate = typeof value === "string" ? value.trim() : "";
  const [buildSelector, resourceSelector, extra] = candidate.split(".");
  return !extra &&
    buildSelector &&
    resourceSelector &&
    OPAQUE_PART_RE.test(buildSelector) &&
    OPAQUE_PART_RE.test(resourceSelector)
    ? { buildSelector, resourceSelector, handle: candidate }
    : null;
}

export function knowledgeBasePublicResourceHandleMatches(input: {
  suppliedHandle: string;
  buildId: string;
  kind: KnowledgeBasePublicResourceKind;
  internalIdentity: string;
}) {
  const supplied = parseKnowledgeBasePublicResourceHandle(input.suppliedHandle);
  if (!supplied) return false;
  const expected = parseKnowledgeBasePublicResourceHandle(
    knowledgeBasePublicResourceHandle(input),
  )!;
  return (
    safeEqual(supplied.buildSelector, expected.buildSelector) &&
    safeEqual(supplied.resourceSelector, expected.resourceSelector)
  );
}

export function knowledgeBasePublicResourceId(input: {
  buildId: string;
  contentSha256: string;
  mimeType: string;
}) {
  return signature(
    "content-id",
    `${input.buildId}\0${input.contentSha256}\0${input.mimeType.toLowerCase()}`,
  );
}

export function knowledgeBasePublicResource(input: {
  buildId: string;
  kind: KnowledgeBasePublicResourceKind;
  internalIdentity: string;
  contentSha256: string;
  mimeType: string;
  sizeBytes?: number;
  caption?: unknown;
}): KnowledgeBaseApprovedResourceDto {
  const handle = knowledgeBasePublicResourceHandle(input);
  const defaultCaption =
    input.kind === "logo" ? "企业官方主 Logo" : "知识库配图";
  return {
    id: knowledgeBasePublicResourceId({
      buildId: input.buildId,
      contentSha256: input.contentSha256,
      mimeType: input.mimeType,
    }),
    kind: input.kind,
    caption: customerSafeKnowledgeAssetLabel(input.caption) ?? defaultCaption,
    mimeType: input.mimeType,
    ...(input.sizeBytes === undefined ? {} : { sizeBytes: input.sizeBytes }),
    sameOriginUrl: `/api/knowledge-base/artifacts/resources/${handle}`,
  };
}
