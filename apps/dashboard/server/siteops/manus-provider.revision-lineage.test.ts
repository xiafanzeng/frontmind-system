import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  siteOpsContentPlanMediaSelection,
  siteOpsRevisionLineageFromRows,
} from "./manus-provider";

const taskStartedAt = new Date("2026-08-30T01:00:00.000Z");
const projectId = "10000000-0000-4000-8000-000000000001";
const rootBuildId = "20000000-0000-4000-8000-000000000001";
const firstBuildId = "20000000-0000-4000-8000-000000000002";
const secondBuildId = "20000000-0000-4000-8000-000000000003";
const operationId = "30000000-0000-4000-8000-000000000001";
const secondOperationId = "30000000-0000-4000-8000-000000000002";
const sourceAssetId = "asset_source_first";
const stableAssetId = "40000000-0000-4000-8000-000000000001";
const snapshotId = "90000000-0000-4000-8000-000000000001";
const rootSourceId = "60000000-0000-4000-8000-000000000001";
const rootPlanId = "70000000-0000-4000-8000-000000000001";
const knowledgeInputEpochId = "a0000000-0000-4000-8000-000000000001";

function builds() {
  return [
    {
      id: rootBuildId,
      parentBuildId: null,
      projectId,
      userId: 7,
      knowledgeSnapshotId: snapshotId,
      knowledgeArchiveHash: "d".repeat(64),
      workflowVersion: "2.9.0",
      sourceLocalAssetId: rootSourceId,
      sourceHash: "a".repeat(64),
      contentPlanLocalAssetId: rootPlanId,
      contentPlanSha256: "b".repeat(64),
      createdAt: taskStartedAt,
    },
    {
      id: firstBuildId,
      parentBuildId: rootBuildId,
      projectId,
      userId: 7,
      knowledgeSnapshotId: snapshotId,
      knowledgeArchiveHash: "d".repeat(64),
      workflowVersion: "2.9.0",
      sourceLocalAssetId: "60000000-0000-4000-8000-000000000002",
      sourceHash: "e".repeat(64),
      contentPlanLocalAssetId: "70000000-0000-4000-8000-000000000002",
      contentPlanSha256: "f".repeat(64),
      createdAt: new Date("2026-08-30T01:01:00.000Z"),
    },
    {
      id: secondBuildId,
      parentBuildId: firstBuildId,
      projectId,
      userId: 7,
      knowledgeSnapshotId: snapshotId,
      knowledgeArchiveHash: "d".repeat(64),
      workflowVersion: "2.9.0",
      sourceLocalAssetId: null,
      sourceHash: null,
      contentPlanLocalAssetId: "70000000-0000-4000-8000-000000000002",
      contentPlanSha256: "f".repeat(64),
      createdAt: new Date("2026-08-30T01:02:00.000Z"),
    },
  ];
}

function operation() {
  return {
    id: operationId,
    buildId: firstBuildId,
    projectId,
    userId: 7,
    kind: "build_revision" as const,
    status: "succeeded" as const,
    createdAt: new Date("2026-08-30T01:01:00.000Z"),
    input: {
      credentialScope: "customer",
      manusCredentialId: "50000000-0000-4000-8000-000000000001",
      manusCredentialVersion: 1,
      buildId: rootBuildId,
      childBuildId: firstBuildId,
      parentBuildId: rootBuildId,
      feedback: "第一轮加入产品实拍图与客户提供的新文案。",
      revisionBaseline: {
        schemaVersion: 1,
        parentBuildId: rootBuildId,
        sourceLocalAssetId: rootSourceId,
        sourceSha256: "a".repeat(64),
        contentPlanLocalAssetId: rootPlanId,
        contentPlanSha256: "b".repeat(64),
      },
      revisionInputAssets: [
        {
          schemaVersion: 1,
          localAssetId: stableAssetId,
          filename: "产品实拍图.png",
          mimeType: "image/png",
          sizeBytes: 1024,
          contentSha256: "c".repeat(64),
          width: 800,
          height: 600,
          publicPath: `/frontmind-user-media/${"c".repeat(64)}.png`,
          siteOpsKnowledgeInputEpochId: knowledgeInputEpochId,
        },
      ],
    },
  };
}

function secondOperation() {
  return {
    ...operation(),
    id: secondOperationId,
    buildId: secondBuildId,
    createdAt: new Date("2026-08-30T01:02:00.000Z"),
    input: {
      ...operation().input,
      buildId: firstBuildId,
      childBuildId: secondBuildId,
      parentBuildId: firstBuildId,
      feedback: "第二轮只调整文案，继续保留第一轮产品实拍图。",
      revisionBaseline: {
        schemaVersion: 1,
        parentBuildId: firstBuildId,
        sourceLocalAssetId: "60000000-0000-4000-8000-000000000002",
        sourceSha256: "e".repeat(64),
        contentPlanLocalAssetId: "70000000-0000-4000-8000-000000000002",
        contentPlanSha256: "f".repeat(64),
      },
      revisionInputAssets: [],
    },
  };
}

function asset() {
  return {
    id: "80000000-0000-4000-8000-000000000001",
    buildId: firstBuildId,
    projectId,
    userId: 7,
    sourceAssetId,
    localAssetId: stableAssetId,
    ordinal: 1,
    filename: "产品实拍图.png",
    mimeType: "image/png",
    sizeBytes: 1024,
    contentSha256: "c".repeat(64),
    width: 800,
    height: 600,
    publicPath: `/frontmind-user-media/${"c".repeat(64)}.png`,
    siteOpsKnowledgeInputEpochId: knowledgeInputEpochId,
    taskStartedAt,
    createdAt: new Date("2026-08-30T01:01:00.000Z"),
  };
}

function resolve(
  overrides: {
    builds?: ReturnType<typeof builds>;
    operations?: ReturnType<typeof operation>[];
    assets?: ReturnType<typeof asset>[];
    includeCurrentBuild?: boolean;
  } = {},
) {
  return siteOpsRevisionLineageFromRows({
    currentBuild: {
      id: secondBuildId,
      parentBuildId: firstBuildId,
      projectId,
      userId: 7,
      knowledgeSnapshotId: snapshotId,
      knowledgeArchiveHash: "d".repeat(64),
    },
    projectId,
    userId: 7,
    taskStartedAt,
    knowledgeInputEpochId,
    builds: overrides.builds ?? builds(),
    operations: overrides.operations ?? [operation()],
    assets: overrides.assets ?? [asset()],
    includeCurrentBuild: overrides.includeCurrentBuild,
  });
}

describe("SiteOps cumulative revision lineage", () => {
  it("separates selected customer media from knowledge ZIP media and permits an explicit later removal", () => {
    const publicPath = `/frontmind-user-media/${"c".repeat(64)}.png`;
    const customerMediaId = `customer-media:${createHash("sha256")
      .update(publicPath, "utf8")
      .digest("hex")
      .slice(0, 32)}`;
    const plan = (mediaIds: string[]) =>
      ({
        routes: [
          {
            path: "/",
            sections: [{ mediaIds }],
          },
        ],
      }) as never;
    const asset = { publicPath, contentSha256: "c".repeat(64) };

    const selected = siteOpsContentPlanMediaSelection(
      plan([customerMediaId, "knowledge-photo"]),
      [asset],
    );
    expect(selected.selectedCustomerMedia).toEqual([asset]);
    expect([...selected.knowledgeRoutePaths]).toEqual([
      ["knowledge-photo", new Set(["/"])],
    ]);
    expect(selected.unknownCustomerMediaIds).toEqual([]);

    const removed = siteOpsContentPlanMediaSelection(plan([]), [asset]);
    expect(removed.selectedCustomerMedia).toEqual([]);
    expect(removed.knowledgeRoutePaths.size).toBe(0);

    const unknown = siteOpsContentPlanMediaSelection(
      plan([`customer-media:${"0".repeat(32)}`]),
      [asset],
    );
    expect(unknown.unknownCustomerMediaIds).toEqual([
      `customer-media:${"0".repeat(32)}`,
    ]);
  });

  it("carries the prior feedback source and frozen media into the second child", () => {
    const lineage = resolve();

    expect(lineage.documents).toEqual([
      expect.objectContaining({
        id: `customer-revision:${operationId}`,
        content: "第一轮加入产品实拍图与客户提供的新文案。",
      }),
    ]);
    expect(lineage.assets).toEqual([
      expect.objectContaining({
        sourceDocumentId: `customer-revision:${operationId}`,
        row: expect.objectContaining({
          localAssetId: stableAssetId,
          contentSha256: "c".repeat(64),
        }),
      }),
    ]);
  });

  it("replays the completed current child and cumulative first-child image for production", () => {
    const lineage = resolve({
      operations: [operation(), secondOperation()],
      includeCurrentBuild: true,
    });

    expect(lineage.documents.map((document) => document.id)).toEqual([
      `customer-revision:${operationId}`,
      `customer-revision:${secondOperationId}`,
    ]);
    expect(lineage.assets).toEqual([
      expect.objectContaining({
        sourceDocumentId: `customer-revision:${operationId}`,
        row: expect.objectContaining({
          buildId: firstBuildId,
          localAssetId: stableAssetId,
        }),
      }),
    ]);
  });

  it("fails closed when an ancestor crosses the tenant or task epoch", () => {
    expect(() =>
      resolve({
        builds: builds().map((build) =>
          build.id === firstBuildId ? { ...build, userId: 8 } : build,
        ),
      }),
    ).toThrow(
      expect.objectContaining({
        code: "FRONTMIND_BUILD_REVISION_LINEAGE_INVALID",
      }),
    );
    expect(() =>
      resolve({
        assets: [
          {
            ...asset(),
            taskStartedAt: new Date("2026-08-30T00:59:59.000Z"),
          },
        ],
      }),
    ).toThrow(
      expect.objectContaining({
        code: "FRONTMIND_BUILD_REVISION_LINEAGE_INVALID",
      }),
    );
  });

  it("fails closed when the immutable ancestor operation is missing or mismatched", () => {
    expect(() => resolve({ operations: [] })).toThrow(
      expect.objectContaining({
        code: "FRONTMIND_BUILD_REVISION_LINEAGE_INVALID",
      }),
    );
    expect(() =>
      resolve({
        operations: [
          {
            ...operation(),
            input: { ...operation().input, feedback: undefined },
          },
        ],
      }),
    ).toThrow(
      expect.objectContaining({
        code: "FRONTMIND_BUILD_REVISION_LINEAGE_INVALID",
      }),
    );
    expect(() =>
      resolve({
        operations: [
          {
            ...operation(),
            input: {
              ...operation().input,
              revisionBaseline: {
                ...operation().input.revisionBaseline,
                sourceSha256: "9".repeat(64),
              },
            },
          },
        ],
      }),
    ).toThrow(
      expect.objectContaining({
        code: "FRONTMIND_BUILD_REVISION_LINEAGE_INVALID",
      }),
    );
  });

  it("requires exact equality with every ancestor operation media descriptor", () => {
    expect(() => resolve({ assets: [] })).toThrow(
      expect.objectContaining({
        code: "FRONTMIND_BUILD_REVISION_LINEAGE_INVALID",
      }),
    );
    expect(() =>
      resolve({
        assets: [asset(), { ...asset(), id: `${asset().id}-2`, ordinal: 2 }],
      }),
    ).toThrow(
      expect.objectContaining({
        code: "FRONTMIND_BUILD_REVISION_LINEAGE_INVALID",
      }),
    );
    expect(() =>
      resolve({
        assets: [{ ...asset(), contentSha256: "8".repeat(64) }],
      }),
    ).toThrow(
      expect.objectContaining({
        code: "FRONTMIND_BUILD_REVISION_LINEAGE_INVALID",
      }),
    );
  });
});
