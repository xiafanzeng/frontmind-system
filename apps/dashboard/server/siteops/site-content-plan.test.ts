import { describe, expect, it } from "vitest";

import {
  canonicalSiteContentPlanSha256,
  siteContentPlanRoutePathSchema,
  siteContentPlanV2FromWire,
  siteContentPlanWireV2Schema,
  SiteContentPlanValidationError,
  validateSiteContentPlanV2,
  type KnowledgeCoverageInventoryV1,
  type SiteContentPlanWireV2,
} from "../../shared/siteops-content-plan";
import {
  knowledgeCoverageInventoryAttachment,
  knowledgeCoverageInventoryFromSnapshot,
} from "./site-content-plan";

const snapshotId = "10000000-0000-4000-8000-000000000001";
const operationToken = "siteops-content-plan:operation-1:0";

type TestDocument = {
  id: string;
  title: string;
  content: string;
  kind?: string;
};

function snapshot(documents: readonly TestDocument[]) {
  return {
    id: snapshotId,
    userId: 7,
    version: 1,
    sourceFileName: "knowledge.zip",
    sourceConversationId: null,
    sourceBuildId: null,
    sourceBuildRevision: null,
    sourceTaskId: null,
    sourceArtifactHash: null,
    archiveHash: "a".repeat(64),
    maintenanceTicketId: null,
    documents: documents.map((document) => ({
      id: document.id,
      path: `${document.id}.md`,
      title: document.title,
      content: document.content,
      kind: document.kind ?? "leaf",
      evidenceStatus: "verified_first_party",
      customerVisible: true,
    })),
    assets: [],
    documentCount: documents.length,
    imageCount: 0,
    characterCount: documents.reduce(
      (total, document) => total + document.content.length,
      0,
    ),
    totalBytes: 0,
    status: "active",
    createdByUserId: 7,
    createdAt: new Date("2026-08-30T00:00:00.000Z"),
  } as never;
}

function wire(input: {
  inventory: KnowledgeCoverageInventoryV1;
  documents: readonly TestDocument[];
  routes: readonly {
    id: string;
    path: string;
    sourceDocumentIds: readonly string[];
    parentPath?: string | null;
    detailOfPath?: string | null;
  }[];
}): SiteContentPlanWireV2 {
  const contentById = new Map(
    input.documents.map((document) => [document.id, document.content]),
  );
  const routeIdsBySource = new Map<string, string[]>();
  for (const route of input.routes) {
    for (const sourceDocumentId of route.sourceDocumentIds) {
      const routeIds = routeIdsBySource.get(sourceDocumentId) ?? [];
      routeIds.push(route.id);
      routeIdsBySource.set(sourceDocumentId, routeIds);
    }
  }
  return siteContentPlanWireV2Schema.parse({
    wireSchemaVersion: 2,
    operationToken,
    inventorySha256: canonicalSiteContentPlanSha256(input.inventory),
    routes: input.routes.map((route) => ({
      routeId: route.id,
      path: route.path,
      title: route.id === "home" ? "首页" : `页面 ${route.id}`,
      navigation: route.id === "home" ? "primary" : "contextual",
      parentPath: route.parentPath ?? null,
      detailOfPath: route.detailOfPath ?? null,
      purpose: `回答 ${route.id} 页面对应的客户问题`,
      userQuestions: [`${route.id} 提供什么？`],
      h1: route.id === "home" ? "可信企业" : `可信 ${route.id}`,
      summary: `这是 ${route.id} 页面摘要。`,
      ctaLabel: null,
      ctaTargetPath: null,
    })),
    sections: input.routes.map((route) => ({
      routeId: route.id,
      sectionId: `${route.id}-overview`,
      blockKind: "prose",
      heading: `${route.id} 介绍`,
      purpose: "完整呈现有来源的企业资料",
      body: route.sourceDocumentIds
        .map((sourceDocumentId) => contentById.get(sourceDocumentId))
        .join("\n"),
      sourceDocumentIds: [...route.sourceDocumentIds],
      evidenceExcerpts: route.sourceDocumentIds.map(
        (sourceDocumentId) => contentById.get(sourceDocumentId)!,
      ),
      mediaIds: [],
      entityIds: [],
      faqIds: [],
    })),
    navigation: input.routes
      .filter((route) => route.id === "home")
      .map((route) => ({ label: "首页", targetPath: route.path })),
    coverage: input.inventory.documents.map((document) => ({
      sourceDocumentId: document.id,
      status: "used",
      routeIds: routeIdsBySource.get(document.id),
      omissionReason: null,
    })),
  });
}

function admit(input: {
  documents: readonly TestDocument[];
  routes: Parameters<typeof wire>[0]["routes"];
}) {
  const inventory = knowledgeCoverageInventoryFromSnapshot(
    snapshot(input.documents),
  );
  const plan = siteContentPlanV2FromWire(
    wire({ inventory, documents: input.documents, routes: input.routes }),
    {
      operationToken,
      inventorySha256: canonicalSiteContentPlanSha256(inventory),
    },
  );
  return {
    inventory,
    plan: validateSiteContentPlanV2({
      plan,
      inventory,
      documents: input.documents,
    }),
  };
}

describe("SiteOps dynamic information architecture 2.9", () => {
  it("admits a provider-owned single-page site without forcing legacy pages", () => {
    const documents = [
      {
        id: "company",
        title: "企业简介",
        content: "星河智造为制造企业提供可信的设备巡检服务。",
      },
    ];
    const result = admit({
      documents,
      routes: [{ id: "home", path: "/", sourceDocumentIds: ["company"] }],
    });

    expect(result.plan.routes.map((route) => route.path)).toEqual(["/"]);
    expect(result.plan.routes.map((route) => route.path)).not.toContain(
      "/cases/",
    );
    expect(result.plan.routes.map((route) => route.path)).not.toContain(
      "/news/",
    );
  });

  it("admits product collection and detail routes when the sources support them", () => {
    const documents = [
      {
        id: "company",
        title: "企业简介",
        content: "星河智造专注工业巡检。",
      },
      {
        id: "catalog",
        title: "产品目录",
        content: "巡检平台包含云端管理和边缘采集能力。",
      },
      {
        id: "edge-device",
        title: "边缘采集器",
        content: "边缘采集器支持连续振动数据采集。",
      },
    ];
    const result = admit({
      documents,
      routes: [
        { id: "home", path: "/", sourceDocumentIds: ["company"] },
        {
          id: "products",
          path: "/products/",
          sourceDocumentIds: ["catalog"],
          parentPath: "/",
        },
        {
          id: "edge-device",
          path: "/products/edge-device/",
          sourceDocumentIds: ["edge-device"],
          parentPath: "/products/",
          detailOfPath: "/products/",
        },
      ],
    });

    expect(result.plan.routes.map((route) => route.path)).toEqual([
      "/",
      "/products/",
      "/products/edge-device/",
    ]);
    expect(result.plan.routes[2]).toMatchObject({
      parentPath: "/products/",
      detailOfPath: "/products/",
    });
  });

  it("inventories and admits every one of 23 public documents without sampling", () => {
    const documents = Array.from({ length: 23 }, (_, index) => ({
      id: `doc-${index + 1}`,
      title: `资料 ${index + 1}`,
      content: `这是第 ${index + 1} 篇经过核验且必须被覆盖的资料。`,
    }));
    const result = admit({
      documents,
      routes: [
        {
          id: "home",
          path: "/",
          sourceDocumentIds: documents.map((document) => document.id),
        },
      ],
    });

    expect(result.inventory.documents).toHaveLength(23);
    expect(result.inventory.facts).toHaveLength(23);
    expect(result.plan.coverage).toHaveLength(23);
    expect(result.plan.routes[0]?.sections[0]?.sourceBindings).toHaveLength(23);
  });

  it("extracts explicit facts and FAQs and freezes the complete inventory hash", () => {
    const inventory = knowledgeCoverageInventoryFromSnapshot(
      snapshot([
        {
          id: "faq-source",
          title: "咨询说明",
          content: "我们提供工业巡检。 如何预约？ 请致电 13000000000。",
        },
      ]),
    );
    const attachment = knowledgeCoverageInventoryAttachment(inventory);

    expect(inventory.facts.map((fact) => fact.statement)).toEqual([
      "我们提供工业巡检。",
      "如何预约？",
      "请致电 13000000000。",
    ]);
    expect(inventory.faqs).toMatchObject([
      { question: "如何预约？", answer: "请致电 13000000000。" },
    ]);
    expect(attachment.inventorySha256).toBe(
      canonicalSiteContentPlanSha256(inventory),
    );
  });

  it("adds customer revision copy as a first-class, source-bound inventory document", () => {
    const inventory = knowledgeCoverageInventoryFromSnapshot(
      snapshot([
        { id: "company", title: "企业简介", content: "可信企业简介。" },
      ]),
      [
        {
          id: "customer-revision:operation-1",
          path: "customer-revision/operation-1.md",
          title: "本轮客户明确修订要求",
          content: "把首屏标题改为客户明确提供的新文案。",
          kind: "customer_revision",
          customerVisible: true,
        },
      ],
    );

    expect(inventory.documents).toMatchObject([
      { id: "company" },
      {
        id: "customer-revision:operation-1",
        kind: "customer_revision",
      },
    ]);
    expect(
      inventory.facts.some(
        (fact) =>
          fact.sourceDocumentId === "customer-revision:operation-1" &&
          fact.statement === "把首屏标题改为客户明确提供的新文案。",
      ),
    ).toBe(true);
  });

  it("keeps prior and current revision sources plus frozen media in one cumulative inventory", () => {
    const inventory = knowledgeCoverageInventoryFromSnapshot(
      snapshot([
        { id: "company", title: "企业简介", content: "可信企业简介。" },
      ]),
      [
        {
          id: "customer-revision:operation-1",
          path: "customer-revision/operation-1.md",
          title: "历史客户明确修订要求",
          content: "第一轮要求保留产品实拍图。",
          kind: "customer_revision",
          customerVisible: true,
        },
        {
          id: "customer-revision:operation-2",
          path: "customer-revision/operation-2.md",
          title: "本轮客户明确修订要求",
          content: "第二轮只调整首屏标题。",
          kind: "customer_revision",
          customerVisible: true,
        },
      ],
      [
        {
          id: "customer-media:product-photo",
          sha256: "b".repeat(64),
          path: `/frontmind-user-media/${"b".repeat(64)}.png`,
          mimeType: "image/png",
          caption: "产品实拍图.png",
          alt: "产品实拍图.png",
          size: 1024,
          width: 800,
          height: 600,
          sourceDocumentIds: ["customer-revision:operation-1"],
        },
      ],
    );

    expect(inventory.documents.map((document) => document.id)).toEqual([
      "company",
      "customer-revision:operation-1",
      "customer-revision:operation-2",
    ]);
    expect(inventory.media).toMatchObject([
      {
        id: "customer-media:product-photo",
        sha256: "b".repeat(64),
        sourceDocumentIds: ["customer-revision:operation-1"],
      },
    ]);
  });

  it("rejects reserved, non-canonical and dangling routes", () => {
    for (const path of [
      "/api/",
      "/dashboard/settings/",
      "/preview/build/",
      "/internal/jobs/",
      "/admin/",
      "/About/",
      "/missing-trailing-slash",
      "/../escape/",
    ]) {
      expect(siteContentPlanRoutePathSchema.safeParse(path).success).toBe(
        false,
      );
    }

    const documents = [
      { id: "company", title: "企业简介", content: "可信企业简介。" },
    ];
    const inventory = knowledgeCoverageInventoryFromSnapshot(
      snapshot(documents),
    );
    const dangling = wire({
      inventory,
      documents,
      routes: [{ id: "home", path: "/", sourceDocumentIds: ["company"] }],
    });
    dangling.navigation.push({ label: "悬空", targetPath: "/missing/" });

    expect(() => siteContentPlanV2FromWire(dangling)).toThrow();
  });

  it("requires exact operation coordinates and provider-authored omission reasons", () => {
    const documents = [
      { id: "company", title: "企业简介", content: "可信企业简介。" },
    ];
    const inventory = knowledgeCoverageInventoryFromSnapshot(
      snapshot(documents),
    );
    const candidate = wire({
      inventory,
      documents,
      routes: [{ id: "home", path: "/", sourceDocumentIds: ["company"] }],
    });

    expect(() =>
      siteContentPlanV2FromWire(candidate, {
        operationToken: "wrong-token",
        inventorySha256: candidate.inventorySha256,
      }),
    ).toThrow(SiteContentPlanValidationError);

    const missingReason = {
      ...candidate,
      coverage: [
        {
          sourceDocumentId: "company",
          status: "omitted",
          routeIds: [],
          omissionReason: null,
        },
      ],
    };
    expect(siteContentPlanWireV2Schema.safeParse(missingReason).success).toBe(
      false,
    );

    expect(
      siteContentPlanWireV2Schema.safeParse({
        ...candidate,
        routes: candidate.routes.map((route) => ({
          ...route,
          ctaLabel: "联系我们",
          ctaTargetPath: null,
        })),
      }).success,
    ).toBe(false);
  });

  it("rejects route graph cycles and duplicate navigation or coverage coordinates", () => {
    const documents = [
      { id: "one", title: "资料一", content: "第一份可信资料。" },
      { id: "two", title: "资料二", content: "第二份可信资料。" },
    ];
    const inventory = knowledgeCoverageInventoryFromSnapshot(
      snapshot(documents),
    );
    const candidate = wire({
      inventory,
      documents,
      routes: [
        {
          id: "home",
          path: "/",
          sourceDocumentIds: ["one"],
          parentPath: "/products/",
        },
        {
          id: "products",
          path: "/products/",
          sourceDocumentIds: ["two"],
          parentPath: "/",
        },
      ],
    });
    candidate.navigation.push({ label: "首页", targetPath: "/products/" });
    candidate.coverage[0]!.routeIds.push("home");

    expect(() => siteContentPlanV2FromWire(candidate)).toThrow();
  });

  it("rejects unknown section coordinates and omitted documents bound to content", () => {
    const documents = [
      { id: "company", title: "企业简介", content: "可信企业简介。" },
    ];
    const admitted = admit({
      documents,
      routes: [{ id: "home", path: "/", sourceDocumentIds: ["company"] }],
    });
    const invalid = JSON.parse(JSON.stringify(admitted.plan));
    invalid.routes[0].sections[0].entityIds = ["unknown-entity"];
    invalid.routes[0].sections[0].mediaIds = ["unknown-media"];
    invalid.routes[0].sections[0].faqIds = ["unknown-faq"];
    invalid.coverage[0] = {
      sourceDocumentId: "company",
      status: "omitted",
      routeIds: [],
      omissionReason: "This source is unrelated to the intended public site.",
    };

    expect(() =>
      validateSiteContentPlanV2({
        plan: invalid,
        inventory: admitted.inventory,
        documents,
      }),
    ).toThrowError(
      expect.objectContaining({
        issues: expect.arrayContaining([
          "CONTENT_PLAN_MEDIA_UNKNOWN",
          "CONTENT_PLAN_ENTITY_UNKNOWN",
          "CONTENT_PLAN_FAQ_UNKNOWN",
          "CONTENT_PLAN_OMITTED_DOCUMENT_RENDER_BOUND",
        ]),
      }),
    );
  });

  it("requires cumulative customer revisions and uploaded media to remain render-bound", () => {
    const documents = [
      { id: "company", title: "企业简介", content: "可信企业简介。" },
    ];
    const customerRevision = {
      id: "customer-revision:operation-1",
      path: "customer-revision/operation-1.md",
      title: "本轮客户明确修订要求",
      content: "请把首页行动按钮改成预约诊断。",
      kind: "customer_revision",
      customerVisible: true as const,
    };
    const customerMedia = {
      id: "customer-media:11111111111111111111111111111111",
      sha256: "b".repeat(64),
      path: `/frontmind-user-media/${"b".repeat(64)}.png`,
      mimeType: "image/png" as const,
      caption: "设备现场",
      alt: "设备现场",
      size: 128,
      width: 32,
      height: 32,
      sourceDocumentIds: [customerRevision.id],
    };
    const inventory = knowledgeCoverageInventoryFromSnapshot(
      snapshot(documents),
      [customerRevision],
      [customerMedia],
    );
    const candidate = siteContentPlanV2FromWire(
      wire({
        inventory,
        documents: [...documents, customerRevision],
        routes: [
          {
            id: "home",
            path: "/",
            sourceDocumentIds: ["company", customerRevision.id],
          },
        ],
      }),
    );
    const missingBindings = JSON.parse(JSON.stringify(candidate));
    missingBindings.routes[0].sections[0].mediaIds = [];
    missingBindings.routes[0].sections[0].sourceBindings =
      missingBindings.routes[0].sections[0].sourceBindings.filter(
        (binding: { sourceDocumentId: string }) =>
          binding.sourceDocumentId !== customerRevision.id,
      );
    missingBindings.coverage.find(
      (item: { sourceDocumentId: string }) =>
        item.sourceDocumentId === customerRevision.id,
    ).status = "omitted";
    const omittedRevision = missingBindings.coverage.find(
      (item: { sourceDocumentId: string }) =>
        item.sourceDocumentId === customerRevision.id,
    );
    omittedRevision.routeIds = [];
    omittedRevision.omissionReason =
      "The provider chose not to apply this customer revision request.";

    expect(() =>
      validateSiteContentPlanV2({
        plan: missingBindings,
        inventory,
        documents: [...documents, customerRevision],
        requiredDocumentIds: [customerRevision.id],
        requiredMediaIds: [customerMedia.id],
      }),
    ).toThrowError(
      expect.objectContaining({
        issues: expect.arrayContaining([
          "CONTENT_PLAN_REQUIRED_DOCUMENT_NOT_RENDER_BOUND",
          "CONTENT_PLAN_REQUIRED_MEDIA_UNBOUND",
        ]),
      }),
    );

    candidate.routes[0]!.sections[0]!.mediaIds = [customerMedia.id];
    expect(
      validateSiteContentPlanV2({
        plan: candidate,
        inventory,
        documents: [...documents, customerRevision],
        requiredDocumentIds: [customerRevision.id],
        requiredMediaIds: [customerMedia.id],
      }),
    ).toEqual(candidate);
  });
});
