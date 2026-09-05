import { createHash } from "node:crypto";
import path from "node:path";

import { and, eq } from "drizzle-orm";

import {
  knowledgeBaseWorkingSets,
  type KnowledgeBaseBuild,
} from "../drizzle/schema";
import type { KnowledgeBaseApprovedResourceDto } from "../shared/knowledge-base-progress";
import {
  type KnowledgeBaseWorkingSetAsset,
  type ValidatedKnowledgeBaseWorkingSet,
  validateKnowledgeBaseWorkingSetArchive,
} from "./knowledge-base-materialized-contract";
import { readKnowledgeBaseLocalSource } from "./knowledge-base-local-source-store";
import {
  knowledgeBasePublicResource,
  knowledgeBasePublicResourceHandleMatches,
} from "./knowledge-base-public-resource";

const SHA256_RE = /^[a-f0-9]{64}$/u;

export class KnowledgeBaseMaterializedAssetError extends Error {
  constructor(
    readonly code:
      | "WORKING_SET_NOT_FOUND"
      | "WORKING_SET_COORDINATES_INVALID"
      | "WORKING_SET_RESOURCE_NOT_FOUND"
      | "WORKING_SET_RESOURCE_INTEGRITY_MISMATCH",
    message: string,
  ) {
    super(message);
    this.name = "KnowledgeBaseMaterializedAssetError";
  }
}

function resourceError(
  code: KnowledgeBaseMaterializedAssetError["code"],
  message: string,
): never {
  throw new KnowledgeBaseMaterializedAssetError(code, message);
}

function sha256(value: Buffer | string) {
  return createHash("sha256").update(value).digest("hex");
}

function filename(value: string, fallback: string) {
  const candidate = path.posix.basename(value).normalize("NFKC").trim();
  return candidate && candidate.length <= 512 ? candidate : fallback;
}

function encoded(value: string) {
  return encodeURIComponent(value);
}

export function knowledgeBaseWorkingSetAssetUrl(input: {
  buildId: string;
  asset: Pick<KnowledgeBaseWorkingSetAsset, "assetId" | "sha256">;
}) {
  return `/api/knowledge-base/artifacts/${encoded(input.buildId)}/working-set/assets/${encoded(input.asset.assetId)}/${input.asset.sha256}`;
}

export function knowledgeBaseWorkingSetEvidenceUrl(input: {
  buildId: string;
  leafId: string;
  path: string;
  sha256: string;
}) {
  return `/api/knowledge-base/artifacts/${encoded(input.buildId)}/working-set/evidence/${encoded(input.leafId)}/${sha256(input.path)}/${input.sha256}`;
}

export function knowledgeBaseWorkingSetAssetInternalIdentity(input: {
  leafId: string;
  asset: Pick<KnowledgeBaseWorkingSetAsset, "assetId" | "sha256" | "path">;
}) {
  return `${input.leafId}\0${input.asset.assetId}\0${input.asset.path}\0${input.asset.sha256}`;
}

export function projectKnowledgeBaseWorkingSetLeafResources(input: {
  buildId: string;
  leafId: string;
  workingSet: ValidatedKnowledgeBaseWorkingSet;
}): KnowledgeBaseApprovedResourceDto[] {
  const leaf = input.workingSet.manifest.leaves.find(
    (candidate) => candidate.leafId === input.leafId,
  );
  if (!leaf) {
    return resourceError(
      "WORKING_SET_RESOURCE_NOT_FOUND",
      "Active Working Set does not contain the requested leaf",
    );
  }
  const assetById = new Map(
    input.workingSet.manifest.assets.map((asset) => [asset.assetId, asset]),
  );
  const assetResources = leaf.assetIds.map((assetId) => {
    const asset = assetById.get(assetId);
    const bytes = asset ? input.workingSet.files.get(asset.path) : undefined;
    if (
      !asset ||
      !bytes ||
      bytes.length !== asset.bytes ||
      sha256(bytes) !== asset.sha256 ||
      !asset.documentIds.includes(leaf.leafId)
    ) {
      return resourceError(
        "WORKING_SET_RESOURCE_INTEGRITY_MISMATCH",
        "Active Working Set asset does not match its manifest binding",
      );
    }
    return knowledgeBasePublicResource({
      buildId: input.buildId,
      kind: "working_set_asset",
      internalIdentity: knowledgeBaseWorkingSetAssetInternalIdentity({
        leafId: leaf.leafId,
        asset,
      }),
      contentSha256: asset.sha256,
      mimeType: asset.mimeType,
      sizeBytes: asset.bytes,
      caption: asset.caption,
    });
  });
  // Evidence bytes remain bound inside the immutable Working Set and are
  // available to server-side validation/revision code. They are deliberately
  // not projected as source.md cards into the customer conversation.
  return assetResources;
}

export function resolveKnowledgeBaseWorkingSetResourceByOpaqueHandle(input: {
  suppliedHandle: string;
  buildId: string;
  workingSet: ValidatedKnowledgeBaseWorkingSet;
}) {
  for (const leaf of input.workingSet.manifest.leaves) {
    for (const assetId of leaf.assetIds) {
      const asset = input.workingSet.manifest.assets.find(
        (candidate) => candidate.assetId === assetId,
      );
      if (
        asset &&
        asset.documentIds.includes(leaf.leafId) &&
        knowledgeBasePublicResourceHandleMatches({
          suppliedHandle: input.suppliedHandle,
          buildId: input.buildId,
          kind: "working_set_asset",
          internalIdentity: knowledgeBaseWorkingSetAssetInternalIdentity({
            leafId: leaf.leafId,
            asset,
          }),
        })
      ) {
        return resolveKnowledgeBaseWorkingSetResource({
          buildId: input.buildId,
          workingSet: input.workingSet,
          kind: "asset",
          assetId: asset.assetId,
          expectedSha256: asset.sha256,
        });
      }
    }
  }
  return null;
}

export function knowledgeBaseWorkingSetLeafLocalUrls(input: {
  buildId: string;
  leafId: string;
  workingSet: ValidatedKnowledgeBaseWorkingSet;
}) {
  const resources = projectKnowledgeBaseWorkingSetLeafResources(input);
  return {
    imageUrls: resources
      .filter((resource) => resource.kind === "working_set_asset")
      .map((resource) => resource.sameOriginUrl),
    // Evidence remains an internal integrity input. New customer snapshots do
    // not mint paths containing evidence paths, hashes, or leaf coordinates.
    evidenceUrls: [] as string[],
  };
}

type ActiveWorkingSetBuild = Pick<
  KnowledgeBaseBuild,
  | "id"
  | "generation"
  | "contentVersion"
  | "activeWorkingSetId"
  | "skillContentHash"
  | "companyName"
  | "executionMode"
>;

/**
 * Read and revalidate the exact immutable ZIP selected by activeWorkingSetId.
 * The JSON database projection is never sufficient authority for serving a
 * resource: every byte is checked against the ZIP manifest and stored digest.
 */
export async function readValidatedActiveKnowledgeBaseWorkingSet(input: {
  db: any;
  build: ActiveWorkingSetBuild;
}) {
  const contentVersion = input.build.contentVersion;
  if (
    input.build.executionMode !== "materialized_bundle_v1" ||
    !input.build.activeWorkingSetId ||
    contentVersion === null ||
    contentVersion < 1
  ) {
    return resourceError(
      "WORKING_SET_COORDINATES_INVALID",
      "Build has no active materialized Working Set",
    );
  }
  const row = (
    await input.db
      .select()
      .from(knowledgeBaseWorkingSets)
      .where(
        and(
          eq(knowledgeBaseWorkingSets.id, input.build.activeWorkingSetId),
          eq(knowledgeBaseWorkingSets.buildId, input.build.id),
          eq(knowledgeBaseWorkingSets.generation, input.build.generation),
          eq(knowledgeBaseWorkingSets.contentVersion, contentVersion),
          eq(knowledgeBaseWorkingSets.status, "active"),
        ),
      )
      .limit(1)
  )[0];
  if (!row) {
    return resourceError(
      "WORKING_SET_NOT_FOUND",
      "Active Working Set row is unavailable",
    );
  }
  if (
    !SHA256_RE.test(row.packageSha256) ||
    !SHA256_RE.test(row.manifestSha256)
  ) {
    return resourceError(
      "WORKING_SET_COORDINATES_INVALID",
      "Active Working Set digest coordinates are invalid",
    );
  }
  let bytes: Buffer;
  let validated: ValidatedKnowledgeBaseWorkingSet;
  try {
    bytes = await readKnowledgeBaseLocalSource({
      storageKey: row.storageKey,
      contentSha256: row.packageSha256,
      sizeBytes: row.sizeBytes,
    });
    validated = await validateKnowledgeBaseWorkingSetArchive(bytes, {
      buildId: input.build.id,
      generation: input.build.generation,
      contentVersion,
      skillContentHash: input.build.skillContentHash || undefined,
      companyName: input.build.companyName,
    });
  } catch (error) {
    if (error instanceof KnowledgeBaseMaterializedAssetError) throw error;
    return resourceError(
      "WORKING_SET_RESOURCE_INTEGRITY_MISMATCH",
      "Active Working Set bytes failed their immutable manifest proof",
    );
  }
  if (
    validated.packageSha256 !== row.packageSha256 ||
    validated.manifestSha256 !== row.manifestSha256
  ) {
    return resourceError(
      "WORKING_SET_RESOURCE_INTEGRITY_MISMATCH",
      "Active Working Set bytes do not match the selected row",
    );
  }
  return { row, bytes, validated };
}

export function resolveKnowledgeBaseWorkingSetResource(input: {
  buildId: string;
  workingSet: ValidatedKnowledgeBaseWorkingSet;
  kind: "asset" | "evidence";
  assetId?: string;
  leafId?: string;
  pathSha256?: string;
  expectedSha256: string;
}) {
  if (!SHA256_RE.test(input.expectedSha256)) {
    return resourceError(
      "WORKING_SET_RESOURCE_NOT_FOUND",
      "Working Set resource digest is invalid",
    );
  }
  if (input.kind === "asset") {
    const asset = input.workingSet.manifest.assets.find(
      (candidate) => candidate.assetId === input.assetId,
    );
    if (!asset || asset.sha256 !== input.expectedSha256) {
      return resourceError(
        "WORKING_SET_RESOURCE_NOT_FOUND",
        "Working Set asset is not registered",
      );
    }
    const bytes = input.workingSet.files.get(asset.path);
    if (
      !bytes ||
      bytes.length !== asset.bytes ||
      sha256(bytes) !== asset.sha256
    ) {
      return resourceError(
        "WORKING_SET_RESOURCE_INTEGRITY_MISMATCH",
        "Working Set asset bytes failed their manifest proof",
      );
    }
    return {
      bytes,
      filename: filename(asset.path, `${asset.assetId}.img`),
      mimeType: asset.mimeType,
      disposition: "inline" as const,
    };
  }
  const leaf = input.workingSet.manifest.leaves.find(
    (candidate) => candidate.leafId === input.leafId,
  );
  const evidence = leaf?.evidencePaths
    .map((evidencePath) =>
      input.workingSet.manifest.evidenceLedger.find(
        (candidate) => candidate.path === evidencePath,
      ),
    )
    .find(
      (candidate) =>
        candidate &&
        candidate.leafId === leaf?.leafId &&
        candidate.sha256 === input.expectedSha256 &&
        sha256(candidate.path) === input.pathSha256,
    );
  if (!leaf || !evidence) {
    return resourceError(
      "WORKING_SET_RESOURCE_NOT_FOUND",
      "Working Set evidence is not registered for this leaf",
    );
  }
  const bytes = input.workingSet.files.get(evidence.path);
  if (!bytes || sha256(bytes) !== evidence.sha256) {
    return resourceError(
      "WORKING_SET_RESOURCE_INTEGRITY_MISMATCH",
      "Working Set evidence bytes failed their manifest proof",
    );
  }
  return {
    bytes,
    filename: filename(evidence.path, `${leaf.leafId}-evidence.txt`),
    mimeType: "text/plain; charset=utf-8",
    disposition: "attachment" as const,
  };
}
