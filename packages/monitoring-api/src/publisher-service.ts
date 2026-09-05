import { createHash, createHmac, randomUUID } from "node:crypto";
import type { PublishingRepository } from "@frontmind/monitoring-db";
import type {
  PrivateObjectReader,
  PrivateObjectStore,
} from "@frontmind/monitoring-object-store";
import { normalizePublisherImage } from "@frontmind/monitoring-publisher";
import type {
  PublisherHttpService,
  PublisherUpload,
} from "./publisher-http.js";

export type PublisherServiceDependencies = {
  repository: PublishingRepository;
  writer?: PrivateObjectStore;
  reader: PrivateObjectReader;
  capabilitySecret: string;
  publicOrigin: string;
};

const MAX_PUBLISHER_LOGO_BYTES = 2 * 1_024 * 1_024;

/**
 * Same-origin binary boundary for publisher files. The database stores only
 * immutable private object keys; public reads remain capability-gated by a
 * frozen article-version association in PublishingRepository.
 */
export function createPublisherHttpService(
  dependencies: PublisherServiceDependencies,
): PublisherHttpService {
  return {
    async isCustomerFeatureEnabled() {
      const runtime = await dependencies.repository.getPublisherRuntimeState();
      return runtime?.featureEnabled === true;
    },

    async createDocxImport({ ownerId, upload }) {
      const writer = requirePublisherWriter(dependencies.writer);
      const sha256 = digest(upload.body);
      const operationId = randomUUID();
      const objectKey = [
        "publisher",
        "owners",
        ownerId,
        "imports",
        sha256,
        `${operationId}.docx`,
      ].join("/");
      const leaseId = await dependencies.repository.createPublisherObjectLease(
        ownerId,
        {
          operationId,
          storageKey: objectKey,
          kind: "docx_import",
          expiresAt: new Date(Date.now() + 24 * 60 * 60_000),
        },
      );
      await writer.put({
        key: objectKey,
        body: upload.body,
        contentType:
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        contentSha256: sha256,
        cacheControl: "private, no-store",
      });
      const created = await dependencies.repository.createDocxImport(ownerId, {
        originalName: upload.originalName,
        size: upload.size,
        sha256,
        objectKey,
        contentType:
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      });
      await dependencies.repository.releasePublisherObjectLease(
        ownerId,
        leaseId,
      );
      return { importId: created.id, status: "queued" as const };
    },

    async createArticleAsset({ ownerId, articleId, upload, altText }) {
      const writer = requirePublisherWriter(dependencies.writer);
      const normalized = await normalizePublisherImage({
        bytes: upload.body,
        sourceMimeType: upload.contentType,
      });
      const extension = normalized.mimeType === "image/png" ? "png" : "jpg";
      const objectKey = [
        "publisher",
        "owners",
        ownerId,
        "articles",
        articleId,
        `${normalized.sha256}.${extension}`,
      ].join("/");
      const operationId = randomUUID();
      const leaseId = await dependencies.repository.createPublisherObjectLease(
        ownerId,
        {
          operationId,
          storageKey: objectKey,
          kind: "article_asset",
          expiresAt: new Date(Date.now() + 24 * 60 * 60_000),
        },
      );
      await writer.put({
        key: objectKey,
        body: normalized.bytes,
        contentType: normalized.mimeType,
        contentSha256: normalized.sha256,
        cacheControl: "private, max-age=31536000, immutable",
      });
      const capability = derivePublisherAssetCapability({
        secret: dependencies.capabilitySecret,
        ownerId,
        articleId,
        assetSha256: normalized.sha256,
      });
      const asset = await dependencies.repository.createArticleAsset(
        ownerId,
        articleId,
        {
          sha256: normalized.sha256,
          objectKey,
          contentType: normalized.mimeType,
          width: normalized.width,
          height: normalized.height,
          size: normalized.bytes.byteLength,
          capability,
          ...(altText ? { altText } : {}),
        },
      );
      await dependencies.repository.releasePublisherObjectLease(
        ownerId,
        leaseId,
      );
      return {
        assetId: asset.id,
        contentType: normalized.mimeType,
        width: normalized.width,
        height: normalized.height,
        publicPath: new URL(
          `/api/monitoring/publisher/public-assets/${asset.id}/${capability}`,
          dependencies.publicOrigin,
        ).toString(),
      };
    },

    async getBatchCsv({ ownerId, batchId }) {
      const rows = await dependencies.repository.listBatchCsvRows(
        ownerId,
        batchId,
      );
      const header = [
        "item_id",
        "media_name",
        "submission_title",
        "publication_status",
        "funds_status",
        "customer_price_1_10000_cny",
        "published_url",
        "failure_reason",
        "submitted_at",
        "completed_at",
        "media_kind",
      ];
      const body = [
        header,
        ...rows.map((row) => [
          row.itemId,
          row.mediaName,
          row.submissionTitle,
          row.publicationStatus,
          row.fundsStatus,
          row.priceTenThousandths,
          row.publishedUrl ?? "",
          row.failureReason ?? "",
          row.submittedAt?.toISOString() ?? "",
          row.completedAt?.toISOString() ?? "",
          row.mediaKind,
        ]),
      ]
        .map((row) => row.map(csvCell).join(","))
        .join("\r\n");
      return {
        filename: `frontmind-publishing-${batchId}.csv`,
        body: Uint8Array.from(Buffer.from(`\uFEFF${body}\r\n`, "utf8")),
      };
    },

    async getMediaLogo({ mediaResourceId, sha256 }) {
      const logo = await dependencies.repository.getPublisherMediaLogo(
        mediaResourceId,
        sha256,
      );
      if (!logo) return undefined;
      const declaredSize = Number(logo.sizeBytes);
      if (
        !Number.isSafeInteger(declaredSize) ||
        declaredSize < 1 ||
        declaredSize > MAX_PUBLISHER_LOGO_BYTES
      ) {
        return undefined;
      }
      const body = await dependencies.reader.read(
        logo.objectKey,
        undefined,
        MAX_PUBLISHER_LOGO_BYTES,
      );
      if (
        !body ||
        body.byteLength !== declaredSize ||
        digest(body) !== logo.sha256
      ) {
        return undefined;
      }
      return {
        body,
        contentType: logo.contentType,
        contentSha256: logo.sha256,
      };
    },

    async getPublicAsset({ assetId, capability }) {
      const asset = await dependencies.repository.getPublicPublisherAsset(
        assetId,
        capability,
      );
      if (!asset) return undefined;
      if (asset.mimeType !== "image/jpeg" && asset.mimeType !== "image/png") {
        return undefined;
      }
      const body = await dependencies.reader.read(asset.storageKey);
      if (!body) return undefined;
      if (digest(body) !== asset.sha256) return undefined;
      return {
        body,
        contentType: asset.mimeType,
        contentSha256: asset.sha256,
      };
    },

    async getPrivateArticleAsset({ ownerId, articleId, assetId }) {
      const asset = await dependencies.repository.getOwnedPublisherArticleAsset(
        ownerId,
        articleId,
        assetId,
      );
      if (asset.mimeType !== "image/jpeg" && asset.mimeType !== "image/png") {
        return undefined;
      }
      const body = await dependencies.reader.read(asset.storageKey);
      if (!body || digest(body) !== asset.sha256) return undefined;
      return {
        body,
        contentType: asset.mimeType,
        contentSha256: asset.sha256,
      };
    },
  };
}

export function derivePublisherAssetCapability(input: {
  secret: string;
  ownerId: string;
  articleId: string;
  assetSha256: string;
}): string {
  if (input.secret.length < 32) {
    throw new Error(
      "Publisher asset capability secret must be at least 32 characters",
    );
  }
  return createHmac("sha256", input.secret)
    .update(
      JSON.stringify([
        "frontmind:publisher-asset-capability:v1",
        input.ownerId,
        input.articleId,
        input.assetSha256,
      ]),
      "utf8",
    )
    .digest("base64url");
}

function requirePublisherWriter(
  writer: PrivateObjectStore | undefined,
): PrivateObjectStore {
  if (!writer) {
    throw new Error("Publisher uploads are disabled on this API instance");
  }
  return writer;
}

function digest(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function csvCell(value: unknown): string {
  let normalized = value instanceof Date ? value.toISOString() : String(value);
  // Prevent spreadsheet formula execution without altering visible content.
  if (/^[=+@-]/u.test(normalized)) normalized = `'${normalized}`;
  return `"${normalized.replaceAll('"', '""')}"`;
}

export function uploadBodyForTest(input: {
  name: string;
  contentType: string;
  body: Uint8Array;
}): PublisherUpload {
  return {
    originalName: input.name,
    contentType: input.contentType,
    body: input.body,
    size: input.body.byteLength,
  };
}
