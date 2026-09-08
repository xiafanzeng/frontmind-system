import { createHash, randomBytes } from "node:crypto";
import type {
  PrivateObjectReader,
  PrivateObjectStore,
} from "@frontmind/monitoring-object-store";
import {
  ObjectStoreError,
  RemoteMediaFetchError,
  RemoteMediaRejectedError,
} from "@frontmind/monitoring-object-store";
import {
  DocxSafetyError,
  createPublisherMediaFallbackMark,
  importPublisherDocx,
  nextPublicationPollAt,
  PublisherContentError,
  PublisherImageError,
  normalizePublisherImage,
  safePublishedUrl,
} from "@frontmind/monitoring-publisher";
import {
  isKolProviderError,
  KolSubmissionUnknownError,
} from "@frontmind/monitoring-provider-kol";
import type { PublisherRuntimeConfig } from "../config.js";
import {
  DeferPublisherJobError,
  PublisherSubmissionPersistenceError,
  safePublisherError,
} from "./errors.js";
import { publisherPayloadId, type PublisherJob } from "./job-types.js";
import { publisherLogoSearchQueryHash } from "./logo-search.js";
import { PublisherLogoArchiveCache } from "./logo-archive-cache.js";
import type {
  PublisherLogoSearchAudit,
  PublisherLogoSearchCandidate,
  PublisherWorkerDependencies,
} from "./ports.js";

const SUBMISSION_LEASE_MS = 10 * 60_000;
const UNKNOWN_RECONCILIATION_LOOKBACK_MS = 24 * 60 * 60_000;
const MAX_CATALOG_RESOURCES = 100_000;
const CATALOG_SYNC_LEASE_MS = 5 * 60_000;
const CATALOG_STAGING_RETENTION_MS = 7 * 24 * 60 * 60_000;
const CATALOG_STAGING_CLEANUP_LIMIT = 500;
const MAX_STAGED_DOCX_IMAGE_BYTES = 100 * 1024 * 1024;
const DOCX_IMAGE_OBJECT_LEASE_MS = 24 * 60 * 60_000;
const MAX_PUBLISHER_LOGO_BYTES = 2 * 1_024 * 1_024;

export class PublisherWorkerProcessor {
  private readonly now: () => Date;
  private readonly logoArchiveCache: PublisherLogoArchiveCache;

  constructor(
    private readonly dependencies: PublisherWorkerDependencies,
    private readonly config: PublisherRuntimeConfig,
  ) {
    this.now = dependencies.now ?? (() => new Date());
    this.logoArchiveCache = new PublisherLogoArchiveCache(dependencies.objectStore, dependencies.mediaFetcher, () => this.now().valueOf());
  }

  async handle(job: PublisherJob, signal?: AbortSignal): Promise<void> {
    if (this.config.providerEnabled === false && !["import_docx", "purge_publisher_assets"].includes(job.type)) {
      throw new DeferPublisherJobError("Media publishing provider is not configured", new Date(this.now().valueOf() + 30 * 60_000));
    }
    switch (job.type) {
      case "import_docx":
        await this.importDocx(
          publisherPayloadId(job.payload, "importId"),
          job.attemptCount + 1 >= job.maxAttempts,
          signal,
        );
        return;
      case "sync_kol_catalog":
        await this.syncCatalog(job, signal);
        return;
      case "archive_publisher_media_logo":
        await this.archiveMediaLogo(job, signal);
        return;
      case "submit_publication_item":
        await this.submitItem(
          publisherPayloadId(job.payload, "itemId"),
          signal,
        );
        return;
      case "poll_publication_item":
        await this.pollItem(publisherPayloadId(job.payload, "itemId"), signal);
        return;
      case "reconcile_publication_unknown":
        await this.reconcileUnknown(
          publisherPayloadId(job.payload, "itemId"),
          signal,
        );
        return;
      case "purge_publisher_assets":
        await this.purgeAsset(
          publisherPayloadId(job.payload, "assetId"),
          signal,
        );
    }
  }

  async cleanupExpiredObjectLeases(
    signal?: AbortSignal,
  ): Promise<{ claimed: number; deleted: number }> {
    const now = this.now();
    const candidates =
      await this.dependencies.repository.claimExpiredPublisherObjectLeases({
        now,
        claimUntil: new Date(now.valueOf() + 5 * 60_000),
        limit: 50,
      });
    let deleted = 0;
    for (const candidate of candidates) {
      if (signal?.aborted) break;
      try {
        const stillUnreferenced =
          await this.dependencies.repository.confirmPublisherObjectLeaseCleanup(
            {
              leaseId: candidate.leaseId,
              storageKey: candidate.storageKey,
              now: this.now(),
            },
          );
        if (!stillUnreferenced) continue;
        await this.dependencies.objectStore.delete(
          candidate.storageKey,
          signal,
        );
        await this.dependencies.repository.completePublisherObjectLeaseCleanup({
          leaseId: candidate.leaseId,
          storageKey: candidate.storageKey,
          completedAt: this.now(),
        });
        deleted += 1;
      } catch (error) {
        // Keep the claimed lease. Its short claim expiry makes cleanup
        // recoverable, while never treating an object-store failure as proof
        // that the object is gone.
        this.dependencies.logger.warn(
          "Publisher object-lease cleanup deferred",
          {
            leaseId: candidate.leaseId,
            error: safePublisherError(error),
          },
        );
      }
    }
    return { claimed: candidates.length, deleted };
  }

  private async submitItem(
    itemId: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const now = this.now();
    const prepared =
      await this.dependencies.repository.preparePublisherSubmission({
        itemId,
        workerId: this.config.workerId,
        now,
        leaseExpiresAt: new Date(now.valueOf() + SUBMISSION_LEASE_MS),
        minimumIntervalMs: this.config.submissionIntervalMs,
        runtime: {
          mode: this.config.mode,
          realEnabled: this.config.realEnabled,
          publishEnabled: this.config.publishEnabled,
          imageEnabled: this.config.imageEnabled,
        },
      });
    if (prepared.status === "terminal" || prepared.status === "blocked") return;
    if (prepared.status === "deferred") {
      throw new DeferPublisherJobError(
        `Publisher submission deferred: ${prepared.reason}`,
        prepared.retryAt,
      );
    }

    let accepted;
    try {
      accepted = await this.dependencies.provider.createOrder(
        {
          resourceId: prepared.item.resourceId,
          title: prepared.item.title,
          html: prepared.item.canonicalHtml,
        },
        signal,
      );
    } catch (error) {
      try {
        if (
          error instanceof KolSubmissionUnknownError ||
          (isKolProviderError(error) && error.submissionMayHaveSucceeded)
        ) {
          await this.dependencies.repository.markPublisherSubmissionUnknown({
            itemId,
            attemptId: prepared.attemptId,
            reason: safePublisherError(error),
            observedAt: this.now(),
            blockCredentialGate: isKolPostAuthenticationUnknown(error),
          });
          return;
        }
        if (isKolProviderError(error) && error.code === "order_rejected") {
          await this.dependencies.repository.markPublisherSubmissionRejected({
            itemId,
            attemptId: prepared.attemptId,
            reason: error.message,
            settledAt: this.now(),
          });
          return;
        }
        const authenticationFailure =
          isKolProviderError(error) &&
          ["authentication_failed", "authentication_blocked"].includes(
            error.code,
          );
        await this.dependencies.repository.markPublisherSubmissionBlocked({
          itemId,
          attemptId: prepared.attemptId,
          status: authenticationFailure ? "auth_blocked" : "action_required",
          reason: safePublisherError(error),
          observedAt: this.now(),
        });
        return;
      } catch (persistenceError) {
        throw new PublisherSubmissionPersistenceError(
          "Could not durably record the provider submission outcome",
          { cause: persistenceError },
        );
      }
    }

    try {
      if (
        accepted.resourceId !== prepared.item.resourceId ||
        !accepted.orderId.trim()
      ) {
        await this.dependencies.repository.markPublisherSubmissionUnknown({
          itemId,
          attemptId: prepared.attemptId,
          reason:
            "Provider create-order response did not match the requested resource",
          providerRaw: redactProviderPayload(accepted.raw),
          observedAt: this.now(),
          blockCredentialGate: false,
        });
        return;
      }
      const acceptedAt = this.now();
      await this.dependencies.repository.markPublisherSubmissionAccepted({
        itemId,
        attemptId: prepared.attemptId,
        providerOrderId: accepted.orderId,
        providerPaidAt: accepted.paidAt,
        providerRaw: redactProviderPayload(accepted.raw),
        acceptedAt,
        nextPollAt: nextPublicationPollAt(acceptedAt, acceptedAt),
      });
    } catch (persistenceError) {
      throw new PublisherSubmissionPersistenceError(
        "Provider returned an order id, but its local transition could not be confirmed",
        { cause: persistenceError },
      );
    }
  }

  private async pollItem(itemId: string, signal?: AbortSignal): Promise<void> {
    const item =
      await this.dependencies.repository.getPublisherItemForPolling(itemId);
    if (
      !item ||
      (item.status !== "processing" && item.status !== "action_required")
    )
      return;
    const observedAt = this.now();
    let order;
    try {
      order = await this.dependencies.provider.getOrderByOrderId(
        item.providerOrderId,
        signal,
      );
    } catch (error) {
      if (isKolProviderError(error)) {
        if (isKolAuthenticationError(error)) {
          await this.dependencies.repository.markKolCredentialAuthBlocked({
            failedAt: observedAt,
          });
        }
        throw new DeferPublisherJobError(
          `Authoritative provider polling is temporarily unavailable: ${safePublisherError(error)}`,
          nextPublicationPollAt(item.submittedAt, observedAt),
        );
      }
      throw error;
    }
    if (!order) {
      throw new DeferPublisherJobError(
        "Provider order is not visible yet",
        nextPublicationPollAt(item.submittedAt, observedAt),
      );
    }
    const publishedUrl = safePublishedUrl(
      order.publishedUrl ?? order.responseMessage,
    );
    const providerStatus =
      order.status === "success" && !publishedUrl ? "unknown" : order.status;
    const nextPollAt =
      providerStatus === "processing" || providerStatus === "unknown"
        ? nextPublicationPollAt(item.submittedAt, observedAt)
        : undefined;
    await this.dependencies.repository.applyPublisherOrderObservation({
      itemId,
      providerOrderId: item.providerOrderId,
      providerStatus,
      publishedUrl,
      failureReason:
        order.status === "failed"
          ? (order.failureReason ?? order.responseMessage)
          : undefined,
      actionRequiredReason:
        providerStatus === "unknown"
          ? order.status === "success"
            ? "Provider reported success without an authoritative HTTP(S) publication URL"
            : `Provider returned unknown order status ${order.providerStatus}`
          : undefined,
      reportedPrice: order.reportedPrice,
      manuscriptId: order.manuscriptId,
      providerRaw: redactProviderPayload(order.raw),
      observedAt,
      nextPollAt,
    });
    if (nextPollAt) {
      throw new DeferPublisherJobError(
        providerStatus === "processing"
          ? "Provider order remains processing"
          : "Provider order remains non-terminal and requires authoritative polling",
        nextPollAt,
      );
    }
  }

  private async syncCatalog(
    job: PublisherJob,
    signal?: AbortSignal,
  ): Promise<void> {
    const startedAt = this.now();
    try {
      await this.dependencies.repository.cleanupExpiredKolCatalogSyncStaging?.({
        completedBefore: new Date(
          startedAt.getTime() - CATALOG_STAGING_RETENTION_MS,
        ),
        limit: CATALOG_STAGING_CLEANUP_LIMIT,
      });
    } catch (error) {
      // Retention is bounded maintenance, not a reason to suppress a fresh
      // catalog. The next sync retries it and the warning contains no rows or
      // provider payload.
      this.dependencies.logger.warn("KOL catalog staging cleanup deferred", {
        error: safePublisherError(error),
      });
    }
    const syncOperationId = publisherOptionalPayloadString(
      job.payload,
      "syncRunId",
    );
    const runId =
      syncOperationId && isUuid(syncOperationId)
        ? syncOperationId
        : deterministicUuid(
            `publisher-catalog-sync:${syncOperationId ?? job.id}`,
          );
    const leaseToken = `${runId}:${randomBytes(16).toString("hex")}`;
    const syncRun = await this.dependencies.repository.beginKolCatalogSync({
      runId,
      leaseToken,
      startedAt,
      leaseExpiresAt: new Date(startedAt.getTime() + CATALOG_SYNC_LEASE_MS),
    });
    if (syncRun?.alreadyComplete) return;
    if (syncRun?.acquired === false) {
      throw new DeferPublisherJobError(
        "Another Worker owns the KOL catalog synchronization lease",
        syncRun.retryAt ??
          new Date(startedAt.getTime() + CATALOG_SYNC_LEASE_MS),
      );
    }
    let pagesFetched = 0;
    let recordsSeen = 0;
    try {
      let page = 1;
      let expectedLastPage: number | undefined;
      let expectedPerPage: number | undefined;
      while (true) {
        const result = await this.dependencies.provider.listResources(
          page,
          signal,
        );
        pagesFetched += 1;
        recordsSeen += result.resources.length;
        if (expectedLastPage === undefined) {
          expectedLastPage = result.pagination.lastPage;
          expectedPerPage = result.pagination.perPage;
          if (result.pagination.total > MAX_CATALOG_RESOURCES) {
            throw new Error(
              "KOL catalog exceeds the 100,000-resource safety limit",
            );
          }
          // The real catalog has 50 rows/page and more than 1,800 pages.
          // Bound work by the existing resource limit, not an unrelated page cap.
          if (
            !Number.isSafeInteger(expectedLastPage) ||
            !Number.isSafeInteger(expectedPerPage) ||
            expectedPerPage < 1 ||
            (expectedLastPage - 1) * expectedPerPage + 1 > MAX_CATALOG_RESOURCES
          ) {
            throw new Error("KOL catalog pagination exceeds the 100,000-resource safety limit");
          }
        }
        if (
          result.pagination.currentPage !== page ||
          result.pagination.lastPage !== expectedLastPage ||
          result.pagination.perPage !== expectedPerPage ||
          expectedLastPage < 1
        ) {
          throw new Error("KOL catalog pagination changed during a full sync");
        }
        if (
          result.resources.length === 0 ||
          result.resources.length > result.pagination.perPage ||
          (page < expectedLastPage &&
            result.resources.length !== result.pagination.perPage)
        ) {
          throw new Error(
            page < expectedLastPage
              ? "KOL catalog returned an empty or short non-final page"
              : "KOL catalog returned an invalid final page size",
          );
        }
        if (recordsSeen > MAX_CATALOG_RESOURCES) {
          throw new Error(
            "KOL catalog exceeds the 100,000-resource safety limit",
          );
        }
        const stagedAt = this.now();
        const staged = await this.dependencies.repository.stageKolCatalogPage({
          runId,
          leaseToken,
          page,
          expectedLastPage,
          resources: result.resources,
          stagedAt,
          leaseExpiresAt: new Date(stagedAt.getTime() + CATALOG_SYNC_LEASE_MS),
        });
        if (staged.crossKindDuplicateRecords > 0) {
          throw new Error(
            "KOL catalog contains one resource id in multiple media categories",
          );
        }
        if (page >= expectedLastPage) break;
        page += 1;
      }
      if (expectedLastPage === undefined || page < expectedLastPage) {
        throw new Error("KOL catalog exceeded the 1,000-page safety limit");
      }
      if (recordsSeen === 0) {
        throw new Error("KOL catalog full sync returned no resources");
      }
      // The provider's documented total/per-page examples are internally
      // inconsistent. Completion follows last_page plus the rows actually
      // returned; total remains only a safety hint and is never authoritative.
      const syncedAt = this.now();
      await this.dependencies.repository.finalizeKolCatalogSync({
        runId,
        leaseToken,
        expectedLastPage,
        syncedAt,
        leaseExpiresAt: new Date(syncedAt.getTime() + CATALOG_SYNC_LEASE_MS),
      });
    } catch (error) {
      const failedAt = this.now();
      await this.dependencies.repository.failKolCatalogSync({
        runId,
        leaseToken,
        failedAt,
        pagesFetched,
        recordsSeen,
        reason: safePublisherError(error),
      });
      if (isKolAuthenticationError(error)) {
        await this.dependencies.repository.markKolCredentialAuthBlocked({
          failedAt,
        });
      }
      throw error;
    }
  }

  private async archiveMediaLogo(
    job: PublisherJob,
    signal?: AbortSignal,
  ): Promise<void> {
    const mediaResourceId = publisherPayloadId(job.payload, "mediaResourceId");
    const requestedCandidateHash = publisherOptionalPayloadString(
      job.payload,
      "candidateHash",
    );
    const candidate =
      await this.dependencies.repository.getKolMediaLogoCandidate(
        mediaResourceId,
      );
    if (
      !candidate ||
      (requestedCandidateHash &&
        requestedCandidateHash !== candidate.candidateHash)
    ) {
      return;
    }
    const approvedCandidate = publisherApprovedLogoCandidate(job.payload);
    let failure: unknown = new Error("KOL media has no usable logo candidate");
    let encounteredFetchFailure = false;
    const archive = async (source: {
      kind:
        | "logo"
        | "icon"
        | "site_favicon"
        | "web_search_verified"
        | "manual_verified";
      url: string;
      reviewAudit?: PublisherLogoSearchAudit;
    }) => {
      const file = await this.logoArchiveCache.resolve(source.url, signal);
      await this.dependencies.repository.completeKolMediaLogoArchive({
        mediaResourceId: candidate.mediaResourceId,
        syncRunId: candidate.syncRunId, catalogRevision: candidate.catalogRevision,
        candidateHash: candidate.candidateHash, sourceKind: source.kind,
        ...file, checkedAt: this.now(),
        ...(source.reviewAudit ? { reviewAudit: source.reviewAudit } : {}),
      });
    };
    const persist = async (
      normalized: Awaited<ReturnType<typeof normalizePublisherImage>>,
      sourceKind:
        | "logo"
        | "icon"
        | "site_favicon"
        | "web_search_verified"
        | "manual_verified"
        | "generated_fallback",
      sourceUrl: string,
      reviewAudit?: PublisherLogoSearchAudit,
    ) => {
      if (normalized.bytes.byteLength > MAX_PUBLISHER_LOGO_BYTES) {
        throw new PublisherImageError(
          "logo_too_large",
          "Normalized publisher media logo exceeds 2 MiB",
          413,
        );
      }
      const extension = normalized.mimeType === "image/png" ? "png" : "jpg";
      const objectKey = `publisher/media-logos/${normalized.sha256}.${extension}`;
      await this.dependencies.objectStore.put(
        {
          key: objectKey,
          body: normalized.bytes,
          contentType: normalized.mimeType,
          contentSha256: normalized.sha256,
          cacheControl: "private, max-age=31536000, immutable",
          metadata: { kind: "publisher-media-logo" },
        },
        signal,
      );
      await this.dependencies.repository.completeKolMediaLogoArchive({
        mediaResourceId: candidate.mediaResourceId,
        syncRunId: candidate.syncRunId,
        catalogRevision: candidate.catalogRevision,
        candidateHash: candidate.candidateHash,
        sourceKind,
        sourceUrl,
        objectKey,
        contentType: normalized.mimeType,
        sizeBytes: normalized.bytes.byteLength,
        sha256: normalized.sha256,
        checkedAt: this.now(),
        ...(reviewAudit ? { reviewAudit } : {}),
      });
    };
    if (approvedCandidate) {
      if (
        !candidate.reviewAudit ||
        approvedCandidate.url !== candidate.reviewAudit.candidateImageUrl ||
        approvedCandidate.audit.queryHash !== candidate.reviewAudit.queryHash ||
        approvedCandidate.audit.candidateImageUrl !==
          candidate.reviewAudit.candidateImageUrl
      ) {
        throw new Error(
          "Approved logo candidate no longer matches the catalog review record",
        );
      }
      try {
        await archive({
          kind: "manual_verified",
          url: approvedCandidate.url,
          reviewAudit: approvedCandidate.audit,
        });
        return;
      } catch (error) {
        if (signal?.aborted) throw error;
        failure = error;
        encounteredFetchFailure = true;
      }
    }
    const providerCandidates = candidate.candidates.filter(
      (source) => source.kind !== "site_favicon",
    );
    const faviconCandidates = candidate.candidates.filter(
      (source) => source.kind === "site_favicon",
    );
    for (const source of providerCandidates) {
      try {
        await archive(source);
        return;
      } catch (error) {
        if (signal?.aborted) throw error;
        failure = error;
        encounteredFetchFailure = true;
      }
    }

    const searchInput = {
      name: candidate.mediaName,
      externalResourceId: candidate.externalResourceId,
      platform: candidate.platform,
      area: candidate.area,
      trustedDomains: candidate.trustedDomains,
    };
    const queryHash = publisherLogoSearchQueryHash(searchInput);
    let pendingReview: PublisherLogoSearchAudit | undefined;
    if (this.dependencies.logoSearch) {
      try {
        const results = await this.dependencies.logoSearch.search({
          ...searchInput,
          queryHash,
          signal,
        });
        for (const result of results) {
          const verification = verifiedLogoSearchCandidate(
            result,
            candidate.trustedDomains,
            candidate.mediaName,
            this.dependencies.logoSearch.trustedEvidenceDomains,
          );
          const audit: PublisherLogoSearchAudit = {
            searchProvider: this.dependencies.logoSearch.providerName,
            queryHash,
            candidateImageUrl: result.imageUrl,
            pageUrl: result.pageUrl,
            evidenceUrl: result.evidenceUrl,
            officialDomain: result.officialDomain,
            matchedName: result.matchedName,
            verification: verification ?? "unverified",
            observedAt: this.now().toISOString(),
          };
          if (!verification) {
            pendingReview ??= audit;
            continue;
          }
          try {
            await archive({
              kind: "web_search_verified",
              url: result.imageUrl,
              reviewAudit: { ...audit, verification },
            });
            return;
          } catch (error) {
            if (signal?.aborted) throw error;
            failure = error;
            encounteredFetchFailure = true;
          }
        }
      } catch (error) {
        if (signal?.aborted) throw error;
        failure = error;
        encounteredFetchFailure = true;
      }
    }

    const hasArchivedFavicon =
      candidate.archiveStatus === "archived" &&
      candidate.sourceKind === "site_favicon";
    const hasArchivedGeneratedFallback =
      candidate.archiveStatus === "archived" &&
      candidate.sourceKind === "generated_fallback";
    if (!hasArchivedFavicon) {
      for (const source of faviconCandidates) {
        try {
          await archive({
            ...source,
            ...(pendingReview ? { reviewAudit: pendingReview } : {}),
          });
          return;
        } catch (error) {
          if (signal?.aborted) throw error;
          failure = error;
          encounteredFetchFailure = true;
        }
      }
    }

    // A previously archived site icon remains a visual fallback while every
    // later catalog run retries the provider images and verified name search.
    // Transient lookup failures get the normal bounded retries, but the final
    // attempt never erases an already safe local favicon asset.
    if (hasArchivedFavicon) {
      if (encounteredFetchFailure && job.attemptCount + 1 < job.maxAttempts) {
        throw failure;
      }
      await this.dependencies.repository.carryForwardKolMediaLogoArchive({
        mediaResourceId: candidate.mediaResourceId,
        syncRunId: candidate.syncRunId,
        candidateHash: candidate.candidateHash,
        checkedAt: this.now(),
      });
      return;
    }
    if (hasArchivedGeneratedFallback) {
      if (encounteredFetchFailure && job.attemptCount + 1 < job.maxAttempts) {
        throw failure;
      }
      await this.dependencies.repository.carryForwardKolMediaLogoArchive({
        mediaResourceId: candidate.mediaResourceId,
        syncRunId: candidate.syncRunId,
        candidateHash: candidate.candidateHash,
        checkedAt: this.now(),
      });
      return;
    }
    if (encounteredFetchFailure && job.attemptCount + 1 < job.maxAttempts) {
      throw failure;
    }
    try {
      const generated = await createPublisherMediaFallbackMark({
        name: candidate.mediaName,
        stableId: candidate.externalResourceId,
      });
      await persist(
        generated,
        "generated_fallback",
        `generated://frontmind/publisher-media-mark/v1/${encodeURIComponent(candidate.externalResourceId)}`,
        pendingReview,
      );
    } catch (error) {
      if (job.attemptCount + 1 >= job.maxAttempts) {
        await this.dependencies.repository.failKolMediaLogoArchive({
          mediaResourceId: candidate.mediaResourceId,
          syncRunId: candidate.syncRunId,
          candidateHash: candidate.candidateHash,
          errorCode: publisherMediaLogoErrorCode(error),
          checkedAt: this.now(),
        });
      }
      throw error;
    }
  }

  private async importDocx(
    importId: string,
    finalAttempt: boolean,
    signal?: AbortSignal,
  ): Promise<void> {
    const source =
      await this.dependencies.repository.getPublisherDocxImport(importId);
    if (
      !source ||
      ["ready", "rejected", "failed", "completed"].includes(source.status)
    )
      return;
    try {
      const bytes = await readPrivateObject(
        this.dependencies.objectStore,
        source.objectKey,
        this.dependencies.fetch ?? globalThis.fetch,
        signal,
      );
      const ownerPath = createHash("sha256")
        .update(source.ownerId)
        .digest("hex")
        .slice(0, 24);
      const stagedImages: Array<{
        storageKey: string;
        assetId: string;
        bytes: Uint8Array;
        contentType: "image/jpeg" | "image/png";
        sha256: string;
      }> = [];
      let stagedImageBytes = 0;
      const report = await importPublisherDocx({
        bytes,
        fileName: source.fileName,
        contentType: source.contentType,
        persistImage: async (image) => {
          if (
            stagedImageBytes + image.bytes.byteLength >
            MAX_STAGED_DOCX_IMAGE_BYTES
          ) {
            throw new PublisherImageError(
              "docx_image_total_too_large",
              "Normalized DOCX images exceed the 100 MiB aggregate safety limit",
              413,
            );
          }
          stagedImageBytes += image.bytes.byteLength;
          const extension = image.mimeType === "image/png" ? "png" : "jpg";
          const assetId = deterministicUuid(
            `publisher-import:${importId}:${image.ordinal}:${image.sha256}`,
          );
          const capability = randomBytes(32).toString("base64url");
          const storageKey = `publisher-assets/${ownerPath}/${assetId}/${image.sha256}.${extension}`;
          stagedImages.push({
            storageKey,
            assetId,
            bytes: image.bytes,
            contentType: image.mimeType,
            sha256: image.sha256,
          });
          const src = new URL(
            `/api/monitoring/publisher/public-assets/${encodeURIComponent(assetId)}/${encodeURIComponent(capability)}`,
            this.config.publicOrigin,
          ).toString();
          return { assetId, capability, storageKey, src };
        },
      });
      if (report.blockingIssues.length === 0) {
        await persistPublisherDocxImages({
          repository: this.dependencies.repository,
          objectStore: this.dependencies.objectStore,
          importId,
          ownerId: source.ownerId,
          ownerPath,
          images: stagedImages,
          leasedAt: this.now(),
          signal,
        });
      }
      await this.dependencies.repository.completePublisherDocxImport({
        importId,
        ownerId: source.ownerId,
        report,
        completedAt: this.now(),
      });
    } catch (error) {
      if (!finalAttempt && !permanentDocxImportError(error)) throw error;
      await this.dependencies.repository.failPublisherDocxImport({
        importId,
        reason: safePublisherError(error),
        failedAt: this.now(),
      });
    }
  }

  private async reconcileUnknown(
    itemId: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const observedAt = this.now();
    const orders = [];
    try {
      for (let page = 1; page <= 5; page += 1) {
        const result = await this.dependencies.provider.listOrders(
          { page },
          signal,
        );
        orders.push(
          ...result.orders.filter((order) => {
            if (order.createdAt === undefined) return true;
            return (
              order.createdAt * 1_000 >=
              observedAt.valueOf() - UNKNOWN_RECONCILIATION_LOOKBACK_MS
            );
          }),
        );
        if (!result.pagination || page >= result.pagination.lastPage) break;
      }
    } catch (error) {
      if (isKolProviderError(error)) {
        throw new DeferPublisherJobError(
          `UNKNOWN reconciliation is temporarily unavailable: ${safePublisherError(error)}`,
          new Date(observedAt.valueOf() + 10 * 60_000),
        );
      }
      throw error;
    }
    // Candidate discovery is intentionally read-only. An administrator must bind
    // one exact order or authorize a new attempt after checking provider state.
    await this.dependencies.repository.recordPublisherReconciliationCandidates({
      itemId,
      orders,
      observedAt,
    });
  }

  private async purgeAsset(
    assetId: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const candidate =
      await this.dependencies.repository.getPublisherAssetPurgeCandidate(
        assetId,
      );
    if (!candidate) return;
    for (const key of candidate.objectKeys) {
      await this.dependencies.objectStore.delete(key, signal);
    }
    await this.dependencies.repository.finalizePublisherAssetPurge(
      assetId,
      this.now(),
    );
  }
}

export async function persistPublisherDocxImages(input: {
  repository: Pick<
    PublisherWorkerDependencies["repository"],
    "leasePublisherDocxImportImages"
  >;
  objectStore: PrivateObjectStore;
  importId: string;
  ownerId: string;
  ownerPath: string;
  images: ReadonlyArray<{
    storageKey: string;
    assetId: string;
    bytes: Uint8Array;
    contentType: "image/jpeg" | "image/png";
    sha256: string;
  }>;
  leasedAt: Date;
  signal?: AbortSignal;
}): Promise<void> {
  if (!input.images.length) return;
  await input.repository.leasePublisherDocxImportImages({
    importId: input.importId,
    ownerId: input.ownerId,
    storageKeys: input.images.map(({ storageKey }) => storageKey),
    leasedAt: input.leasedAt,
    expiresAt: new Date(input.leasedAt.getTime() + DOCX_IMAGE_OBJECT_LEASE_MS),
  });
  for (const image of input.images) {
    await input.objectStore.put(
      {
        key: image.storageKey,
        body: image.bytes,
        contentType: image.contentType,
        contentSha256: image.sha256,
        cacheControl: "private, max-age=31536000, immutable",
        metadata: { owner: input.ownerPath, asset: image.assetId },
      },
      input.signal,
    );
  }
}

function deterministicUuid(value: string): string {
  const bytes = createHash("sha256").update(value).digest().subarray(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
    value,
  );
}

function publisherOptionalPayloadString(
  payload: unknown,
  key: string,
): string | undefined {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return undefined;
  }
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function publisherApprovedLogoCandidate(
  payload: unknown,
): { url: string; audit: PublisherLogoSearchAudit } | undefined {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return undefined;
  }
  const value = (payload as Record<string, unknown>).manualCandidate;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const url = safeHttpPayloadUrl(record.url);
  const auditValue = record.audit;
  if (
    !url ||
    !auditValue ||
    typeof auditValue !== "object" ||
    Array.isArray(auditValue)
  ) {
    throw new TypeError("Publisher job payload.manualCandidate is invalid");
  }
  const audit = auditValue as Record<string, unknown>;
  const verification = audit.verification;
  const observedAt =
    typeof audit.observedAt === "string" ? new Date(audit.observedAt) : null;
  const parsed: PublisherLogoSearchAudit = {
    searchProvider: boundedPayloadString(audit.searchProvider, 255),
    queryHash: boundedPayloadHash(audit.queryHash),
    candidateImageUrl: requiredHttpPayloadUrl(audit.candidateImageUrl),
    pageUrl: requiredHttpPayloadUrl(audit.pageUrl),
    evidenceUrl:
      audit.evidenceUrl === null
        ? null
        : requiredHttpPayloadUrl(audit.evidenceUrl),
    officialDomain:
      audit.officialDomain === null
        ? null
        : boundedPayloadString(audit.officialDomain, 253),
    matchedName: boundedPayloadString(audit.matchedName, 255),
    verification:
      verification === "unverified" ||
      verification === "case_domain" ||
      verification === "official_registry"
        ? verification
        : (() => {
            throw new TypeError(
              "Publisher job payload.manualCandidate.audit.verification is invalid",
            );
          })(),
    observedAt:
      observedAt && Number.isFinite(observedAt.getTime())
        ? observedAt.toISOString()
        : (() => {
            throw new TypeError(
              "Publisher job payload.manualCandidate.audit.observedAt is invalid",
            );
          })(),
  };
  if (parsed.candidateImageUrl !== url) {
    throw new TypeError(
      "Publisher job payload.manualCandidate URL does not match its audit",
    );
  }
  return { url, audit: parsed };
}

function boundedPayloadString(value: unknown, maximum: number): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.trim().length > maximum
  ) {
    throw new TypeError("Publisher manual logo audit string is invalid");
  }
  return value.trim();
}

function boundedPayloadHash(value: unknown): string {
  const normalized = boundedPayloadString(value, 64).toLowerCase();
  if (!/^[a-f0-9]{64}$/u.test(normalized)) {
    throw new TypeError("Publisher manual logo audit hash is invalid");
  }
  return normalized;
}

function requiredHttpPayloadUrl(value: unknown): string {
  const url = safeHttpPayloadUrl(value);
  if (!url) throw new TypeError("Publisher manual logo audit URL is invalid");
  return url;
}

function safeHttpPayloadUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim() || value.length > 2_048) {
    return undefined;
  }
  try {
    const url = new URL(value.trim());
    if (
      (url.protocol !== "https:" && url.protocol !== "http:") ||
      url.username ||
      url.password
    ) {
      return undefined;
    }
    url.hash = "";
    return url.toString();
  } catch {
    return undefined;
  }
}

function permanentDocxImportError(error: unknown): boolean {
  if (
    error instanceof DocxSafetyError ||
    error instanceof PublisherContentError ||
    error instanceof PublisherImageError
  ) {
    return true;
  }
  const message = safePublisherError(error);
  return /source object does not exist|source exceeds 20 MiB/iu.test(message);
}

export function publisherMediaLogoErrorCode(error: unknown): string {
  if (error instanceof RemoteMediaRejectedError) return "remote_rejected";
  if (error instanceof RemoteMediaFetchError) return "remote_fetch_failed";
  if (error instanceof PublisherImageError)
    return error.code === "logo_too_large"
      ? "normalized_logo_too_large"
      : "image_normalization_failed";
  if (error instanceof ObjectStoreError) return "object_store_failed";
  if (/configured logo search/iu.test(safePublisherError(error))) {
    return "logo_search_failed";
  }
  return "logo_archive_failed";
}

export function verifiedLogoSearchCandidate(
  candidate: PublisherLogoSearchCandidate,
  trustedDomains: readonly string[],
  expectedMediaName: string,
  trustedEvidenceDomains: readonly string[],
): "case_domain" | "official_registry" | null {
  if (
    normalizedMediaIdentity(candidate.matchedName) !==
    normalizedMediaIdentity(expectedMediaName)
  ) {
    return null;
  }
  const pageDomain = publisherLogoHostname(candidate.pageUrl);
  if (!pageDomain) return null;
  if (
    candidate.verification === "case_domain" &&
    trustedDomains.some((trusted) => logoDomainsRelated(pageDomain, trusted))
  ) {
    return "case_domain";
  }
  if (
    candidate.verification === "official_registry" &&
    candidate.officialDomain &&
    candidate.evidenceUrl &&
    logoDomainsRelated(pageDomain, candidate.officialDomain) &&
    trustedDomains.some(
      (trusted) =>
        logoDomainsRelated(candidate.officialDomain!, trusted) ||
        logoDomainsRelated(pageDomain, trusted),
    ) &&
    trustedEvidenceDomains.some((trusted) =>
      logoDomainsRelated(
        publisherLogoHostname(candidate.evidenceUrl!) ?? "",
        trusted,
      ),
    )
  ) {
    return "official_registry";
  }
  return null;
}

function normalizedMediaIdentity(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s·•()（）[\]【】_—–-]/gu, "");
}

function publisherLogoHostname(value: string): string | null {
  try {
    return new URL(value).hostname
      .toLowerCase()
      .replace(/\.$/u, "")
      .replace(/^www\./u, "");
  } catch {
    return null;
  }
}

function logoDomainsRelated(left: string, right: string): boolean {
  const normalizedLeft = left
    .toLowerCase()
    .replace(/\.$/u, "")
    .replace(/^www\./u, "");
  const normalizedRight = right
    .toLowerCase()
    .replace(/\.$/u, "")
    .replace(/^www\./u, "");
  return (
    normalizedLeft === normalizedRight ||
    normalizedLeft.endsWith(`.${normalizedRight}`) ||
    normalizedRight.endsWith(`.${normalizedLeft}`)
  );
}

async function readPrivateObject(
  store: PrivateObjectStore,
  key: string,
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const metadata = await store.head(key, signal);
  if (!metadata.exists)
    throw new Error("Publisher source object does not exist");
  if (metadata.size !== undefined && metadata.size > 20 * 1024 * 1024) {
    throw new Error("Publisher source exceeds 20 MiB");
  }
  const reader = store as PrivateObjectStore & Partial<PrivateObjectReader>;
  if (typeof reader.read === "function") {
    const value = await reader.read(key, signal);
    if (!value) throw new Error("Publisher source object does not exist");
    if (value.byteLength > 20 * 1024 * 1024) {
      throw new Error("Publisher source exceeds 20 MiB");
    }
    return value;
  }
  const response = await fetchImpl(store.signedGetUrl(key, 300), {
    signal,
    redirect: "error",
  });
  if (!response.ok)
    throw new Error(
      `Publisher source read failed with HTTP ${response.status}`,
    );
  const advertised = Number(response.headers.get("content-length"));
  if (Number.isFinite(advertised) && advertised > 20 * 1024 * 1024) {
    throw new Error("Publisher source exceeds 20 MiB");
  }
  return readResponseBytes(response, 20 * 1024 * 1024);
}

async function readResponseBytes(
  response: Response,
  maximumBytes: number,
): Promise<Uint8Array> {
  const stream = response.body;
  if (!stream) return new Uint8Array();
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      total += result.value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel("publisher source size limit exceeded");
        throw new Error("Publisher source exceeds 20 MiB");
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function redactProviderPayload(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[TRUNCATED]";
  if (Array.isArray(value))
    return value
      .slice(0, 500)
      .map((item) => redactProviderPayload(item, depth + 1));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
        key,
        /token|password|authorization|api[_-]?key|content|html/iu.test(key)
          ? "[REDACTED]"
          : redactProviderPayload(entry, depth + 1),
      ]),
    );
  }
  if (typeof value === "string") return value.slice(0, 10_000);
  return value;
}

function isKolAuthenticationError(error: unknown): boolean {
  return (
    isKolProviderError(error) &&
    (error.code === "authentication_failed" ||
      error.code === "authentication_blocked")
  );
}

function isKolPostAuthenticationUnknown(error: unknown): boolean {
  return (
    isKolProviderError(error) &&
    error.submissionMayHaveSucceeded &&
    error.details.operation === "create_order" &&
    (error.details.httpStatus === 401 || isKolAuthenticationError(error))
  );
}
