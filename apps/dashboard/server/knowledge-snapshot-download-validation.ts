import { createHash } from "node:crypto";

import { eq } from "drizzle-orm";
import JSZip from "jszip";

import {
  knowledgeBaseBuildNodes,
  knowledgeBaseBuilds,
  type KnowledgeBaseBuild,
  type KnowledgeBaseBuildNode,
  type KnowledgeBaseSnapshot,
} from "../drizzle/schema";
import { containsPrivateProviderBrand } from "../shared/frontmind-public-brand";
import { getDb } from "./db";
import { knowledgeBuildArtifactLocalPackageStorageKey } from "./knowledge-build-artifact-store";
import {
  isDashboardOwnedKnowledgePackageBuild,
  readDashboardOwnedKnowledgePackage,
} from "./knowledge-base-local-package";
import {
  knowledgeBasePackageWriterTaskId,
  knowledgeBasePublicationBindingHash,
} from "./knowledge-base-publication-binding";

type SnapshotBindingFields = Pick<
  KnowledgeBaseSnapshot,
  | "id"
  | "userId"
  | "sourceFileName"
  | "sourceConversationId"
  | "sourceBuildId"
  | "sourceBuildRevision"
  | "sourceTaskId"
  | "sourceArtifactHash"
  | "archiveHash"
  | "totalBytes"
>;

type BuildBindingFields = Pick<
  KnowledgeBaseBuild,
  | "id"
  | "userId"
  | "conversationId"
  | "companyName"
  | "status"
  | "generation"
  | "revision"
  | "executionMode"
  | "upstreamTaskId"
  | "canonicalTaskId"
  | "packageStatus"
  | "packageRevision"
  | "packageTaskId"
  | "packageOutputItemId"
  | "packageFilename"
  | "packageDescriptorHash"
  | "packageStorageKey"
  | "packageArchiveSha256"
  | "packageSizeBytes"
  | "publishedSnapshotId"
>;

export type DashboardOwnedSnapshotDownloadBinding = {
  buildId: string;
  archiveSha256: string;
  archiveBytes: number;
  expected: {
    buildId: string;
    generation: number;
    revision: number;
    companyName: string;
  };
};

export type KnowledgeSnapshotDownloadValidation =
  | { kind: "historical" }
  | (DashboardOwnedSnapshotDownloadBinding & {
      kind: "dashboard_owned";
      nodes: readonly KnowledgeBaseBuildNode[];
    });

export class KnowledgeSnapshotDownloadBindingError extends Error {
  constructor(message = "知识库本地归档与已发布版本绑定不一致") {
    super(message);
    this.name = "KnowledgeSnapshotDownloadBindingError";
  }
}

export class KnowledgeSnapshotPublicArchiveError extends Error {
  constructor() {
    super("该知识库归档包含无法公开的内部信息，请重新生成后下载");
    this.name = "KnowledgeSnapshotPublicArchiveError";
  }
}

const MAX_PUBLIC_ARCHIVE_SCAN_BYTES = 250 * 1024 * 1024;
const PUBLIC_ARCHIVE_SCAN_CHUNK_BYTES = 1024 * 1024;

function bufferContainsPrivateProviderBrand(buffer: Buffer) {
  for (
    let offset = 0;
    offset < buffer.length;
    offset += PUBLIC_ARCHIVE_SCAN_CHUNK_BYTES
  ) {
    const start = Math.max(0, offset - 64);
    const end = Math.min(
      buffer.length,
      offset + PUBLIC_ARCHIVE_SCAN_CHUNK_BYTES,
    );
    const chunk = buffer.subarray(start, end);
    if (
      containsPrivateProviderBrand(chunk.toString("latin1")) ||
      containsPrivateProviderBrand(chunk.toString("utf16le"))
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Final customer-download gate for both historical and Dashboard-owned ZIPs.
 * The immutable archive and receipt are never rewritten: a polluted legacy
 * package is simply unavailable until a new customer-safe derivative exists.
 */
export async function assertKnowledgeSnapshotArchiveCustomerSafe(input: {
  buffer: Buffer;
  sourceFileName: string;
}) {
  if (containsPrivateProviderBrand(input.sourceFileName)) {
    throw new KnowledgeSnapshotPublicArchiveError();
  }
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(input.buffer, { checkCRC32: true });
  } catch {
    throw new KnowledgeSnapshotPublicArchiveError();
  }
  if (
    containsPrivateProviderBrand(
      (zip as JSZip & { comment?: string }).comment || "",
    )
  ) {
    throw new KnowledgeSnapshotPublicArchiveError();
  }
  let scannedBytes = 0;
  for (const entry of Object.values(zip.files)) {
    const rawEntry = entry as typeof entry & {
      comment?: string;
      unsafeOriginalName?: string;
    };
    if (
      containsPrivateProviderBrand(entry.name) ||
      containsPrivateProviderBrand(rawEntry.unsafeOriginalName || "") ||
      containsPrivateProviderBrand(rawEntry.comment || "")
    ) {
      throw new KnowledgeSnapshotPublicArchiveError();
    }
    if (entry.dir) continue;
    const bytes = await entry.async("nodebuffer");
    scannedBytes += bytes.length;
    if (
      scannedBytes > MAX_PUBLIC_ARCHIVE_SCAN_BYTES ||
      bufferContainsPrivateProviderBrand(bytes)
    ) {
      throw new KnowledgeSnapshotPublicArchiveError();
    }
  }
}

function sha256(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function normalizedSha256(value: string | null | undefined) {
  const normalized = String(value || "").toLowerCase();
  return /^[a-f0-9]{64}$/u.test(normalized) ? normalized : null;
}

/**
 * A snapshot is treated as Dashboard-owned only when its persisted publication
 * receipt still binds exactly to the immutable local package row. A build that
 * advertises the local output prefix may never fall back to the historical
 * archive reader: doing so would turn corrupt publication metadata into a
 * weaker download contract.
 */
export function resolveDashboardOwnedSnapshotDownloadBinding(input: {
  snapshot: SnapshotBindingFields;
  build: BuildBindingFields | null | undefined;
}): DashboardOwnedSnapshotDownloadBinding | null {
  const { snapshot, build } = input;
  if (!build || !isDashboardOwnedKnowledgePackageBuild(build)) return null;

  const archiveSha256 = normalizedSha256(build.packageArchiveSha256);
  const snapshotArchiveSha256 = normalizedSha256(snapshot.archiveHash);
  const sourceArtifactHash = normalizedSha256(snapshot.sourceArtifactHash);
  const expectedStorageKey = knowledgeBuildArtifactLocalPackageStorageKey({
    userId: build.userId,
    buildId: build.id,
    generation: build.generation,
    revision: build.revision,
  });
  const expectedOutputItemId = `dashboard-local:${build.id}:${build.revision}`;
  const expectedDescriptorHash = archiveSha256
    ? sha256(
        `dashboard-local:${build.id}:${build.generation}:${build.revision}:${archiveSha256}`,
      )
    : null;
  const writerTaskId = knowledgeBasePackageWriterTaskId(build);

  if (
    snapshot.userId !== build.userId ||
    snapshot.sourceBuildId !== build.id ||
    snapshot.sourceConversationId !== build.conversationId ||
    build.status !== "published" ||
    build.publishedSnapshotId !== snapshot.id ||
    !Number.isSafeInteger(build.generation) ||
    build.generation < 1 ||
    !Number.isSafeInteger(build.revision) ||
    build.revision < 0 ||
    snapshot.sourceBuildRevision !== build.revision ||
    build.packageRevision !== build.revision ||
    build.packageStatus !== "ready" ||
    !writerTaskId ||
    build.packageTaskId !== writerTaskId ||
    snapshot.sourceTaskId !== build.packageTaskId ||
    build.packageOutputItemId !== expectedOutputItemId ||
    build.packageStorageKey !== expectedStorageKey ||
    !archiveSha256 ||
    snapshotArchiveSha256 !== archiveSha256 ||
    sourceArtifactHash !== archiveSha256 ||
    knowledgeBasePublicationBindingHash(build) !== archiveSha256 ||
    !expectedDescriptorHash ||
    normalizedSha256(build.packageDescriptorHash) !== expectedDescriptorHash ||
    !Number.isSafeInteger(build.packageSizeBytes) ||
    (build.packageSizeBytes ?? 0) <= 0 ||
    snapshot.totalBytes !== build.packageSizeBytes ||
    !String(build.packageFilename || "").trim() ||
    snapshot.sourceFileName !== build.packageFilename ||
    !String(build.companyName || "").trim()
  ) {
    throw new KnowledgeSnapshotDownloadBindingError();
  }

  return {
    buildId: build.id,
    archiveSha256,
    archiveBytes: build.packageSizeBytes!,
    expected: {
      buildId: build.id,
      generation: build.generation,
      revision: build.revision,
      companyName: build.companyName,
    },
  };
}

function assertBoundArchiveBytes(input: {
  buffer: Buffer;
  expectedSha256: string;
  expectedBytes: number;
}) {
  const actualSha256 = createHash("sha256").update(input.buffer).digest("hex");
  if (
    input.buffer.length !== input.expectedBytes ||
    actualSha256 !== input.expectedSha256
  ) {
    throw new KnowledgeSnapshotDownloadBindingError(
      "知识库本地归档字节与已发布版本不一致",
    );
  }
}

export async function validateDashboardOwnedSnapshotArchiveForDownload(input: {
  buffer: Buffer;
  validation: Extract<
    KnowledgeSnapshotDownloadValidation,
    { kind: "dashboard_owned" }
  >;
}) {
  assertBoundArchiveBytes({
    buffer: input.buffer,
    expectedSha256: input.validation.archiveSha256,
    expectedBytes: input.validation.archiveBytes,
  });
  try {
    await readDashboardOwnedKnowledgePackage({
      buffer: input.buffer,
      expected: input.validation.expected,
      nodes: input.validation.nodes,
    });
  } catch {
    throw new KnowledgeSnapshotDownloadBindingError(
      "知识库本地归档内容与已发布节点不一致",
    );
  }
  // Parsing must never substitute for the immutable byte receipt. Re-check it
  // after CRC, structure, manifest and accepted-node validation completes.
  assertBoundArchiveBytes({
    buffer: input.buffer,
    expectedSha256: input.validation.archiveSha256,
    expectedBytes: input.validation.archiveBytes,
  });
}

export async function loadKnowledgeSnapshotDownloadValidation(
  snapshot: SnapshotBindingFields,
): Promise<KnowledgeSnapshotDownloadValidation> {
  if (!snapshot.sourceBuildId) return { kind: "historical" };
  const db = await getDb();
  if (!db) {
    throw new KnowledgeSnapshotDownloadBindingError(
      "数据库暂不可用，无法复核知识库本地归档绑定",
    );
  }
  const builds = await db
    .select()
    .from(knowledgeBaseBuilds)
    .where(eq(knowledgeBaseBuilds.id, snapshot.sourceBuildId))
    .limit(1);
  const binding = resolveDashboardOwnedSnapshotDownloadBinding({
    snapshot,
    build: builds[0],
  });
  if (!binding) return { kind: "historical" };
  const nodes = await db
    .select()
    .from(knowledgeBaseBuildNodes)
    .where(eq(knowledgeBaseBuildNodes.buildId, binding.buildId));
  return { kind: "dashboard_owned", ...binding, nodes };
}
