import type { SQL } from "drizzle-orm";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import { describe, expect, it } from "vitest";

import {
  localAssets,
  siteBuildInputAssets,
  siteBuilds,
  visualCandidatePoolItems,
  visualCandidatePoolPages,
  visualCandidatePools,
  websiteStyleSampleBatches,
  websiteStyleSamples,
} from "../../drizzle/schema";
import { isSiteOpsArtifactReferenced } from "./artifact-retention";

function referenceDatabase(rowsByTable: Map<unknown, unknown[]>) {
  return {
    select: () => ({
      from: (table: unknown) => ({
        where: () => ({
          limit: async () => rowsByTable.get(table) ?? [],
        }),
      }),
    }),
  } as never;
}

describe("SiteOps artifact retention", () => {
  const assetId = "10000000-0000-4000-8000-000000000001";

  it("pins a persisted style preview while its sample references it", async () => {
    const database = referenceDatabase(
      new Map([
        [localAssets, [{ id: assetId }]],
        [websiteStyleSamples, [{ id: "sample-1" }]],
      ]),
    );

    await expect(isSiteOpsArtifactReferenced(database, assetId)).resolves.toBe(
      true,
    );
  });

  it("pins the V4 realization recorded in style metadata as well as the direct reference asset", async () => {
    let sampleReferenceWhere: SQL | null = null;
    let styleSampleQueryCount = 0;
    const database = {
      select: () => ({
        from: (table: unknown) => ({
          where: (condition: SQL) => ({
            limit: async () => {
              if (table === localAssets) return [{ id: assetId }];
              if (table === websiteStyleSamples) {
                styleSampleQueryCount += 1;
                if (styleSampleQueryCount === 1) return [];
                sampleReferenceWhere = condition;
                return [{ id: "sample-v4" }];
              }
              return [];
            },
          }),
        }),
      }),
    } as never;

    await expect(isSiteOpsArtifactReferenced(database, assetId)).resolves.toBe(
      true,
    );
    expect(sampleReferenceWhere).not.toBeNull();
    const query = new MySqlDialect().sqlToQuery(sampleReferenceWhere!);
    expect(query.sql).toContain("$.realizationPreviewLocalAssetId");
    expect(query.sql).toContain("$.referenceBlueprint.previewLocalAssetId");
    expect(query.sql).toContain(
      "$.referenceBlueprint.referencePreviewLocalAssetId",
    );
    expect(query.params.filter((value) => value === assetId)).toHaveLength(3);
  });

  it("pins selection bundles and every immutable build artifact", async () => {
    const bundleDatabase = referenceDatabase(
      new Map([
        [localAssets, [{ id: assetId }]],
        [websiteStyleSampleBatches, [{ id: "batch-1" }]],
      ]),
    );
    await expect(
      isSiteOpsArtifactReferenced(bundleDatabase, assetId),
    ).resolves.toBe(true);

    const buildDatabase = referenceDatabase(
      new Map([
        [localAssets, [{ id: assetId }]],
        [siteBuilds, [{ id: "build-1" }]],
      ]),
    );
    await expect(
      isSiteOpsArtifactReferenced(buildDatabase, assetId),
    ).resolves.toBe(true);
  });

  it("pins content plans and stable revision input media", async () => {
    let buildWhere: SQL | null = null;
    const contentPlanDatabase = {
      select: () => ({
        from: (table: unknown) => ({
          where: (condition: SQL) => ({
            limit: async () => {
              if (table === localAssets) return [{ id: assetId }];
              if (table === siteBuilds) {
                buildWhere = condition;
                return [{ id: "build-content-plan" }];
              }
              return [];
            },
          }),
        }),
      }),
    } as never;
    await expect(
      isSiteOpsArtifactReferenced(contentPlanDatabase, assetId),
    ).resolves.toBe(true);
    expect(new MySqlDialect().sqlToQuery(buildWhere!).sql).toContain(
      "content_plan_local_asset_id",
    );

    const inputMediaDatabase = referenceDatabase(
      new Map([
        [localAssets, [{ id: assetId }]],
        [siteBuildInputAssets, [{ id: "revision-input-1" }]],
      ]),
    );
    await expect(
      isSiteOpsArtifactReferenced(inputMediaDatabase, assetId),
    ).resolves.toBe(true);
  });

  it("pins active pool manifests, reserved page bundles, and page previews", async () => {
    const now = new Date("2026-08-27T13:00:00.000Z");
    const activePool = {
      id: "pool-1",
      status: "active",
      updatedAt: now,
    };
    const reservedPage = {
      id: "page-2",
      poolId: activePool.id,
      status: "reserved",
      updatedAt: now,
    };

    await expect(
      isSiteOpsArtifactReferenced(
        referenceDatabase(
          new Map([
            [localAssets, [{ id: assetId }]],
            [visualCandidatePools, [activePool]],
          ]),
        ),
        assetId,
        now,
      ),
    ).resolves.toBe(true);

    await expect(
      isSiteOpsArtifactReferenced(
        referenceDatabase(
          new Map([
            [localAssets, [{ id: assetId }]],
            [visualCandidatePoolPages, [reservedPage]],
            [visualCandidatePools, [activePool]],
          ]),
        ),
        assetId,
        now,
      ),
    ).resolves.toBe(true);

    await expect(
      isSiteOpsArtifactReferenced(
        referenceDatabase(
          new Map([
            [localAssets, [{ id: assetId }]],
            [visualCandidatePoolItems, [{ poolPageId: reservedPage.id }]],
            [visualCandidatePoolPages, [reservedPage]],
            [visualCandidatePools, [activePool]],
          ]),
        ),
        assetId,
        now,
      ),
    ).resolves.toBe(true);
  });

  it("retains published pool pages permanently and superseded pages for seven days", async () => {
    const now = new Date("2026-08-27T13:00:00.000Z");
    const siteOpsAsset = [localAssets, [{ id: assetId }]] as const;

    await expect(
      isSiteOpsArtifactReferenced(
        referenceDatabase(
          new Map([
            siteOpsAsset,
            [
              visualCandidatePoolPages,
              [
                {
                  id: "page-published",
                  poolId: "pool-1",
                  status: "published",
                  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
                },
              ],
            ],
          ]),
        ),
        assetId,
        now,
      ),
    ).resolves.toBe(true);

    await expect(
      isSiteOpsArtifactReferenced(
        referenceDatabase(
          new Map([
            siteOpsAsset,
            [
              visualCandidatePoolPages,
              [
                {
                  id: "page-recently-superseded",
                  poolId: "pool-1",
                  status: "superseded",
                  updatedAt: new Date("2026-08-21T13:00:00.000Z"),
                },
              ],
            ],
          ]),
        ),
        assetId,
        now,
      ),
    ).resolves.toBe(true);

    await expect(
      isSiteOpsArtifactReferenced(
        referenceDatabase(
          new Map([
            siteOpsAsset,
            [
              visualCandidatePoolPages,
              [
                {
                  id: "page-expired-superseded",
                  poolId: "pool-1",
                  status: "superseded",
                  updatedAt: new Date("2026-08-19T12:59:59.000Z"),
                },
              ],
            ],
          ]),
        ),
        assetId,
        now,
      ),
    ).resolves.toBe(false);
  });

  it("does not pin an unreferenced or non-SiteOps local file", async () => {
    await expect(
      isSiteOpsArtifactReferenced(referenceDatabase(new Map()), assetId),
    ).resolves.toBe(false);

    await expect(
      isSiteOpsArtifactReferenced(
        referenceDatabase(new Map([[localAssets, [{ id: assetId }]]])),
        assetId,
      ),
    ).resolves.toBe(false);
  });
});
