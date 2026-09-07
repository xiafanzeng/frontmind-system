// @vitest-environment node
import { randomUUID, createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import mysql, { type Connection, type RowDataPacket } from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createDatabase } from "../../../packages/monitoring-db/src/client";
import { PublishingRepository } from "../../../packages/monitoring-db/src/publisher-repository";
import { PublisherWorkerRepository } from "../../../packages/monitoring-db/src/publisher-worker-repository";
import { runWithMonitoringEnterpriseScope } from "../../../packages/monitoring-db/src/enterprise-scope";
import {
  publisherBatches,
  publisherItems,
  publisherMediaResources,
  mediaPublishingItemPriceSnapshots,
} from "../../../packages/monitoring-db/src/schema";
import { createPublisherHttpService } from "../../../packages/monitoring-api/src/publisher-service";

// Uses an already bootstrapped, disposable operator acceptance database. Never
// drops tables, rewrites existing records, calls a provider, or writes media.
const url = process.env.FRONTMIND_PUBLISHER_PROJECT_TEST_MYSQL_URL;
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
(url ? describe : describe.skip)(
  "publisher enterprise boundaries on MySQL",
  () => {
    let connection: Connection;
    let domain: ReturnType<typeof createDatabase>;
    let repo: PublishingRepository;
    let worker: PublisherWorkerRepository;
    let owner: string;
    const projectA = randomUUID(),
      projectB = randomUUID(),
      marker = randomUUID();
    let articleA: string,
      articleB: string,
      versionA: string,
      versionB: string,
      draftA: string;
    const inProject = <T>(project: string, fn: () => T) =>
      runWithMonitoringEnterpriseScope(
        { ownerId: owner, enterpriseProjectId: project },
        fn,
      );
    async function rows(statement: string, values: unknown[] = []) {
      return (await connection.execute<RowDataPacket[]>(statement, values))[0];
    }
    beforeAll(async () => {
      if (
        !url ||
        !["127.0.0.1", "localhost"].includes(new URL(url).hostname) ||
        !new URL(url).pathname.includes("acceptance")
      )
        throw new Error("Local disposable acceptance database required");
      connection = await mysql.createConnection(url);
      const existing = await rows(
        "SHOW COLUMNS FROM publisher_articles LIKE 'enterprise_project_id'",
      );
      if (!existing.length) {
        const migration = await readFile(
          resolve(
            import.meta.dirname,
            "../drizzle/0065_publisher_enterprise_projects.sql",
          ),
          "utf8",
        );
        for (const statement of migration.split("--> statement-breakpoint"))
          if (statement.trim()) await connection.query(statement);
      }
      const [account] = await rows(
        "SELECT monitoringUserId FROM monitoring_account_links WHERE dashboardUserId=101",
      );
      if (!account)
        throw new Error("Bootstrap operator acceptance user 101 first");
      owner = String(account.monitoringUserId);
      await connection.execute(
        "INSERT INTO enterprise_projects(id,ownerUserId,name) VALUES(?,101,?),(?,101,?)",
        [projectA, `Publisher A ${marker}`, projectB, `Publisher B ${marker}`],
      );
      domain = createDatabase(url);
      repo = new PublishingRepository(domain.db);
      worker = new PublisherWorkerRepository(domain.db);
      async function create(project: string) {
        return inProject(project, async () => {
          const article = await repo.createPublisherArticle(
            owner,
            `Acceptance ${project}`,
          );
          const saved = await repo.savePublisherArticle(owner, {
            articleId: article.id,
            expectedRevision: article.revision,
            workingName: article.workingName,
            editorJson: { type: "doc" },
            canonicalHtml: "<p>Enterprise content</p>",
            plainText: "Enterprise content",
          });
          const version = await repo.freezePublisherArticle(owner, {
            articleId: article.id,
            expectedRevision: saved.revision,
            idempotencyKey: `same-freeze-${marker}`,
          });
          return { article, version };
        });
      }
      const a = await create(projectA),
        b = await create(projectB);
      articleA = a.article.id;
      articleB = b.article.id;
      versionA = a.version.id;
      versionB = b.version.id;
      draftA = (
        await inProject(projectA, () =>
          repo.savePublisherDraft(owner, {
            articleVersionId: versionA,
            expectedRevision: 0,
            items: [],
          }),
        )
      ).id;
    });
    afterAll(async () => {
      await domain?.pool.end();
      await connection?.end();
    });

    it("backfills historical publisher content and preserves additive project columns", async () => {
      const tables = [
        "articles",
        "docx_imports",
        "article_versions",
        "article_assets",
        "article_version_assets",
        "object_leases",
        "drafts",
        "preflights",
        "draft_items",
        "batches",
        "items",
        "jobs",
      ];
      for (const table of tables)
        expect(
          await rows(
            `SHOW COLUMNS FROM publisher_${table} LIKE 'enterprise_project_id'`,
          ),
        ).toHaveLength(1);
      expect(
        await rows(
          "SELECT t.id FROM publisher_articles t JOIN monitoring_account_links a ON a.monitoringUserId=t.owner_id JOIN enterprise_projects p ON p.ownerUserId=a.dashboardUserId AND p.isLegacyDefault=true WHERE t.enterprise_project_id IS NULL",
        ),
      ).toHaveLength(0);
    });
    it("isolates same-account article reads, writes, frozen versions and idempotency", async () => {
      expect(versionA).not.toBe(versionB);
      await inProject(projectB, async () => {
        expect(
          (await repo.listPublisherArticles(owner, {})).map((row) => row.id),
        ).toEqual([articleB]);
        await expect(
          repo.getPublisherArticle(owner, articleA),
        ).rejects.toMatchObject({ code: "NOT_FOUND" });
        await expect(
          repo.getPublisherArticleVersion(owner, versionA),
        ).rejects.toMatchObject({ code: "NOT_FOUND" });
        await expect(
          repo.savePublisherArticle(owner, {
            articleId: articleA,
            expectedRevision: 2,
            workingName: "foreign",
            editorJson: {},
            canonicalHtml: "x",
            plainText: "x",
          }),
        ).rejects.toMatchObject({ code: "NOT_FOUND" });
        await expect(
          repo.freezePublisherArticle(owner, {
            articleId: articleA,
            expectedRevision: 2,
            idempotencyKey: randomUUID(),
          }),
        ).rejects.toMatchObject({ code: "NOT_FOUND" });
        await expect(
          repo.savePublisherDraft(owner, {
            articleVersionId: versionA,
            expectedRevision: 0,
            items: [],
          }),
        ).rejects.toMatchObject({ code: "NOT_FOUND" });
        await expect(
          repo.getPublisherDraft(owner, draftA),
        ).rejects.toMatchObject({ code: "NOT_FOUND" });
      });
    });
    it("checks the supplied account identity before creating any project content", async () => {
      await expect(
        inProject(projectA, () =>
          repo.createPublisherArticle(randomUUID(), "foreign owner"),
        ),
      ).rejects.toThrow("MONITORING_PROJECT_OWNER_MISMATCH");
    });
    it("rejects foreign-project image upload before object writes and private image reads before object reads", async () => {
      const put = vi.fn(),
        read = vi.fn();
      const service = createPublisherHttpService({
        repository: repo,
        writer: { put } as never,
        reader: { read } as never,
        capabilitySecret: "acceptance-only-secret",
        publicOrigin: "https://acceptance.invalid",
      });
      const asset = await inProject(projectA, () =>
        repo.createArticleAsset(owner, articleA, {
          sha256: hash(marker),
          objectKey: `acceptance/${marker}.png`,
          contentType: "image/png",
          width: 1,
          height: 1,
          size: 1,
          capability: randomUUID(),
        }),
      );
      await inProject(projectB, async () => {
        await expect(
          service.createArticleAsset({
            ownerId: owner,
            articleId: articleA,
            upload: {
              body: new Uint8Array([1]),
              contentType: "image/png",
              originalName: "local.png",
              size: 1,
            },
          }),
        ).rejects.toMatchObject({ code: "NOT_FOUND" });
        await expect(
          service.getPrivateArticleAsset({
            ownerId: owner,
            articleId: articleA,
            assetId: asset.id,
          }),
        ).rejects.toMatchObject({ code: "NOT_FOUND" });
      });
      expect(put).not.toHaveBeenCalled();
      expect(read).not.toHaveBeenCalled();
    });
    it("pins queued DOCX jobs and all generated descendants to the original project while another project is active", async () => {
      const sourceHash = hash(`docx-${marker}`),
        assetId = randomUUID(),
        capability = randomUUID(),
        html = "<p>Imported project A</p>";
      const imported = await inProject(projectA, () =>
        repo.createDocxImport(owner, {
          originalName: "scope.docx",
          size: 1,
          sha256: sourceHash,
          objectKey: `acceptance/${marker}.docx`,
        }),
      );
      await inProject(projectB, async () => {
        await expect(
          repo.getPublisherDocxImport(owner, imported.id),
        ).rejects.toMatchObject({ code: "NOT_FOUND" });
        expect(await repo.listPublisherDocxImports(owner)).toHaveLength(0);
        await worker.completePublisherDocxImport({
          importId: imported.id,
          ownerId: owner,
          completedAt: new Date(),
          report: {
            fileName: "scope.docx",
            sourceSha256: sourceHash,
            suggestedTitle: "Project A imported",
            canonicalHtml: html,
            plainText: "Imported project A",
            contentHash: hash(html),
            containsImages: true,
            images: [
              {
                assetId,
                storageKey: `acceptance/${marker}-import.png`,
                capability,
                sha256: hash(assetId),
                mimeType: "image/png",
                width: 1,
                height: 1,
                sizeBytes: 1,
              },
            ],
            warnings: [],
            blockingIssues: [],
            stats: {},
          },
        });
      });
      const [job] = await rows(
        "SELECT enterprise_project_id FROM publisher_jobs WHERE aggregate_id=?",
        [imported.id],
      );
      expect(job?.enterprise_project_id).toBe(projectA);
      const [record] = await rows(
        "SELECT article_id FROM publisher_docx_imports WHERE id=?",
        [imported.id],
      );
      for (const [table, column, value] of [
        ["publisher_articles", "id", record?.article_id],
        ["publisher_article_versions", "article_id", record?.article_id],
        ["publisher_article_assets", "id", assetId],
        ["publisher_article_version_assets", "asset_id", assetId],
      ]) {
        const result = await rows(
          `SELECT enterprise_project_id FROM ${table} WHERE ${column}=?`,
          [value],
        );
        expect(result).toHaveLength(1);
        expect(result[0]?.enterprise_project_id).toBe(projectA);
      }
      expect(
        await inProject(projectB, () =>
          repo.getPublicPublisherAsset(assetId, capability),
        ),
      ).not.toBeNull(); // frozen provider capability remains usable independent of browser project
      expect(
        await repo.getPublicPublisherAsset(assetId, randomUUID()),
      ).toBeNull();
      await expect(
        inProject(projectB, () =>
          repo.getOwnedPublisherArticleAsset(
            owner,
            String(record?.article_id),
            assetId,
          ),
        ),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
    });
    it("separates object lease idempotency and shares the account wallet across projects", async () => {
      const input = {
        operationId: `same-operation-${marker}`,
        storageKey: `acceptance/${marker}`,
        kind: "article_asset" as const,
        expiresAt: new Date(Date.now() + 60_000),
      };
      const a = await inProject(projectA, () =>
          repo.createPublisherObjectLease(owner, input),
        ),
        b = await inProject(projectB, () =>
          repo.createPublisherObjectLease(owner, input),
        );
      expect(a).not.toBe(b);
      await inProject(projectB, () =>
        repo.releasePublisherObjectLease(owner, a),
      );
      expect(
        await rows("SELECT id FROM publisher_object_leases WHERE id=?", [a]),
      ).toHaveLength(1);
      const walletA = await inProject(projectA, () =>
          repo.getMediaPublishingBillingSummary(owner),
        ),
        walletB = await inProject(projectB, () =>
          repo.getMediaPublishingBillingSummary(owner),
        );
      expect(walletA).toEqual(walletB);
    });
    it("protects CSV batch downloads and rejects inconsistent async item provenance before provider submission", async () => {
      const mediaId = randomUUID(),
        batchId = randomUUID(),
        itemId = randomUUID();
      await domain.db
        .insert(publisherMediaResources)
        .values({
          id: mediaId,
          externalResourceId: mediaId,
          catalogRevision: hash(marker),
          name: "Local acceptance resource",
          mediaKind: "news",
          priceTenThousandths: 10000n,
          rawPayload: {},
          payloadHash: hash(marker),
          logoCandidateHash: hash(marker),
          lastSeenAt: new Date(),
        });
      await inProject(projectA, async () => {
        await domain.db
          .insert(publisherBatches)
          .values({
            id: batchId,
            ownerId: owner,
            draftId: draftA,
            articleVersionId: versionA,
            mode: "mock",
            quotedTotalTenThousandths: 10000n,
            quoteFingerprint: hash(marker),
            preflightRevision: randomUUID(),
            preflightSnapshot: {},
            idempotencyKey: randomUUID(),
          });
        await domain.db
          .insert(publisherItems)
          .values({
            id: itemId,
            ownerId: owner,
            batchId,
            mediaResourceId: mediaId,
            externalResourceId: mediaId,
            mediaNameSnapshot: "Local acceptance",
            mediaKindSnapshot: "news",
            mediaMetadataSnapshot: {},
            submissionTitle: "Local acceptance",
            articleContentHash: hash(marker),
            catalogRevision: hash(marker),
            preflightBlockers: [],
            preflightWarnings: [],
            submissionKey: randomUUID(),
          });
        await domain.db
          .insert(mediaPublishingItemPriceSnapshots)
          .values({
            itemId,
            ownerId: owner,
            mediaResourceId: mediaId,
            catalogRevision: hash(marker),
            externalResourceId: mediaId,
            amountTenThousandths: 10000n,
            providerPayloadHash: hash(marker),
          });
        expect(await repo.listBatchCsvRows(owner, batchId)).toHaveLength(1);
      });
      await inProject(projectB, async () => {
        await expect(
          repo.listBatchCsvRows(owner, batchId),
        ).rejects.toMatchObject({ code: "NOT_FOUND" });
        await expect(
          repo.getPublisherBatch(owner, batchId),
        ).rejects.toMatchObject({ code: "NOT_FOUND" });
      });
      await connection.execute(
        "UPDATE publisher_items SET enterprise_project_id=? WHERE id=?",
        [projectB, itemId],
      );
      await expect(
        worker.preparePublisherSubmission({
          itemId,
          workerId: "acceptance",
          now: new Date(),
          leaseExpiresAt: new Date(Date.now() + 60_000),
          minimumIntervalMs: 0,
          runtime: {
            mode: "mock",
            realEnabled: false,
            publishEnabled: false,
            imageEnabled: false,
          },
        }),
      ).rejects.toThrow("Publication project provenance mismatch");
      expect(
        (
          await rows(
            "SELECT status,attempt_count FROM publisher_items WHERE id=?",
            [itemId],
          )
        )[0],
      ).toMatchObject({ status: "queued", attempt_count: 0 });
    });
  },
);
