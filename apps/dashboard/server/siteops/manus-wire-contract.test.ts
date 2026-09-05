import { describe, expect, it } from "vitest";

import {
  assertSiteOpsStructuredOutputSchema,
  pageContentResultV2FromWire,
  pageContentResultFromWire,
  pageContentWireOutputSchema,
  pageContentWireV3OutputSchema,
  siteDesignResultFromWire,
  siteDesignResultV2FromWire,
  siteDesignWireOutputSchema,
  siteDesignWireV3OutputSchema,
  siteOpsSourceDossierAttachments,
  socialWireOutputSchema,
} from "./manus-wire-contract";
import { referenceBlueprintForVisualCandidate } from "../../shared/siteops-design";

function visitSchema(value: unknown, found = new Set<string>()) {
  if (!value || typeof value !== "object") return found;
  if (Array.isArray(value)) {
    for (const child of value) visitSchema(child, found);
    return found;
  }
  for (const [key, child] of Object.entries(value)) {
    found.add(key);
    visitSchema(child, found);
  }
  return found;
}

describe("SiteOps provider wire contracts", () => {
  it("uses only the provider-supported structured-output subset", () => {
    const schemas = [
      siteDesignWireOutputSchema({
        operationToken: "design-token",
        routeIds: ["home", "about"],
        paletteSize: 3,
      }),
      siteDesignWireV3OutputSchema({
        operationToken: "design-token-v3",
        routeIds: ["home", "about"],
        paletteSize: 3,
      }),
      pageContentWireOutputSchema({
        operationToken: "content-token",
        routeIds: ["home", "about"],
        sourceDocumentIds: ["overview", "about-source"],
      }),
      pageContentWireV3OutputSchema({
        operationToken: "content-token-v3",
        routeIds: ["home", "news"],
        sourceDocumentIds: ["kb-overview-poison-001"],
      }),
      socialWireOutputSchema({
        operationToken: "social-token",
        channel: "xiaohongshu",
        sourceDocumentIds: ["overview"],
      }),
    ];
    for (const schema of schemas) {
      expect(() => assertSiteOpsStructuredOutputSchema(schema)).not.toThrow();
      const keys = visitSchema(schema);
      for (const forbidden of [
        "pattern",
        "minimum",
        "maximum",
        "minItems",
        "maxItems",
        "minLength",
        "maxLength",
      ]) {
        expect(keys.has(forbidden)).toBe(false);
      }
    }
  });

  it("rejects an unsupported keyword before a request can be sent", () => {
    expect(() =>
      assertSiteOpsStructuredOutputSchema({
        type: "object",
        properties: { answer: { type: "string", pattern: "x" } },
        required: ["answer"],
        additionalProperties: false,
      }),
    ).toThrow("SITEOPS_WIRE_SCHEMA_KEY_UNSUPPORTED");
  });

  it("adapts flat design and content wire values back into strict host contracts", () => {
    const design = siteDesignResultFromWire(
      {
        operationToken: "design-token",
        schemaVersion: 2,
        layoutArchetype: "split",
        heroVariant: "split_media",
        density: "balanced",
        surfaceStyle: "bordered",
        typeScale: "display",
        imageTreatment: "contained",
        motionLevel: "subtle",
        backgroundPaletteIndex: 0,
        textPaletteIndex: 1,
        accentPaletteIndex: 2,
        siteTitle: "星河智造",
        description: "经过知识来源核验的企业官网。",
        routeSlots: [
          {
            routeId: "home",
            slotId: "statement",
            variant: "statement",
          },
          { routeId: "home", slotId: "cta", variant: "cta" },
        ],
      },
      ["home"],
    );
    expect(design.designSpec.routeCompositions[0]?.slots).toEqual([
      { slotId: "statement", variant: "statement" },
      { slotId: "cta", variant: "cta" },
    ]);
    expect(design.designSpec.seoPlan.organizationType).toBe("Organization");

    const content = pageContentResultFromWire(
      {
        operationToken: "content-token",
        schemaVersion: 2,
        routes: [
          {
            routeId: "home",
            eyebrow: null,
            heading: "可信制造服务",
            summary: "基于企业知识库生成。",
          },
        ],
        sections: [
          {
            routeId: "home",
            slotId: "statement",
            heading: "服务能力",
            paragraphs: ["提供经过来源核验的设备服务。"],
            sourceDocumentIds: ["overview"],
          },
          {
            routeId: "home",
            slotId: "cta",
            heading: "联系团队",
            paragraphs: ["欢迎进一步沟通。"],
            sourceDocumentIds: ["overview"],
          },
        ],
      },
      ["home"],
      ["overview"],
    );
    expect(content.pageContent.routes[0]).toMatchObject({
      routeId: "home",
      sections: [{ slotId: "statement" }, { slotId: "cta" }],
    });
    expect(content.pageContent.routes[0]).not.toHaveProperty("eyebrow");
  });

  it("normalizes host-owned design coordinates without accepting legacy semantic fields", () => {
    const base = {
      operationToken: "design-token",
      schemaVersion: 2,
      layoutArchetype: "split",
      heroVariant: "split_media",
      density: "balanced",
      surfaceStyle: "bordered",
      typeScale: "display",
      imageTreatment: "contained",
      motionLevel: "subtle",
      backgroundPaletteIndex: 0,
      textPaletteIndex: 1,
      accentPaletteIndex: 2,
      siteTitle: "星河智造",
      description: "经过知识来源核验的企业官网。",
    } as const;
    const normalized = siteDesignResultFromWire(
      {
        ...base,
        backgroundPaletteIndex: 99,
        textPaletteIndex: -2,
        accentPaletteIndex: 12,
        routeSlots: [
          { routeId: "about", slotId: "proof", variant: "proof" },
          { routeId: "unknown", slotId: "ignored", variant: "proof" },
          { routeId: "home", slotId: "hero-title", variant: "statement" },
          { routeId: "home", slotId: "hero-title", variant: "cta" },
          { routeId: "home", slotId: "Hero title", variant: "cta" },
          { routeId: "home", slotId: "ignored", variant: "invented" },
        ],
      },
      ["home", "about", "contact", "news"],
      ["news"],
      2,
    );
    expect(normalized.designSpec.routeCompositions).toEqual([
      {
        routeId: "home",
        slots: [{ slotId: "hero-title", variant: "statement" }],
      },
      { routeId: "about", slots: [{ slotId: "proof", variant: "proof" }] },
      {
        routeId: "contact",
        slots: [{ slotId: "overview", variant: "statement" }],
      },
      {
        routeId: "news",
        slots: [{ slotId: "news-empty", variant: "statement" }],
      },
    ]);
    expect(normalized.designSpec.colorRoles).toEqual({
      backgroundPaletteIndex: 0,
      textPaletteIndex: 1,
      accentPaletteIndex: 1,
    });
    expect(() =>
      siteDesignResultFromWire(
        {
          ...base,
          organizationType: "Corporation",
          routeSlots: [
            {
              routeId: "home",
              slotId: "statement",
              variant: "statement",
              order: 0,
            },
          ],
        },
        ["home"],
      ),
    ).toThrow();
    expect(
      siteDesignResultFromWire(
        {
          ...base,
          routeSlots: [
            { routeId: "home", slotId: "hero", variant: "invented" },
          ],
        },
        ["home"],
      ).designSpec.routeCompositions[0]?.slots,
    ).toEqual([{ slotId: "overview", variant: "statement" }]);
  });

  it("uses one bounded neutral coordinate for an empty historical palette", () => {
    const wire = {
      operationToken: "design-token-empty-palette",
      schemaVersion: 2,
      layoutArchetype: "hero_led",
      heroVariant: "centered_statement",
      density: "balanced",
      surfaceStyle: "bordered",
      typeScale: "restrained",
      imageTreatment: "none",
      motionLevel: "subtle",
      backgroundPaletteIndex: 0,
      textPaletteIndex: 1,
      accentPaletteIndex: 2,
      siteTitle: "FrontMind",
      description: "使用宿主可信默认色的历史官网。",
      routeSlots: [
        { routeId: "home", slotId: "overview", variant: "statement" },
      ],
    };
    expect(
      siteDesignResultFromWire(wire, ["home"], [], 0).designSpec.colorRoles,
    ).toEqual({
      backgroundPaletteIndex: 0,
      textPaletteIndex: 0,
      accentPaletteIndex: 0,
    });
    expect(
      siteDesignWireOutputSchema({
        operationToken: wire.operationToken,
        routeIds: ["home"],
        paletteSize: 0,
      }).properties.backgroundPaletteIndex,
    ).toEqual({ type: "number", enum: [0] });
    for (const invalidSize of [-1, 1.5, 13]) {
      expect(() =>
        siteDesignWireOutputSchema({
          operationToken: wire.operationToken,
          routeIds: ["home"],
          paletteSize: invalidSize,
        }),
      ).toThrow("SITEOPS_DESIGN_PALETTE_SIZE_INVALID");
    }
  });

  it("fills only missing or out-of-range historical palette coordinates", () => {
    const wire = {
      operationToken: "design-token-missing-palette-coordinates",
      schemaVersion: 2,
      layoutArchetype: "hero_led",
      heroVariant: "centered_statement",
      density: "balanced",
      surfaceStyle: "bordered",
      typeScale: "restrained",
      imageTreatment: "none",
      motionLevel: "subtle",
      siteTitle: "FrontMind",
      description: "使用宿主可信默认坐标的历史官网。",
      routeSlots: [
        { routeId: "home", slotId: "overview", variant: "statement" },
      ],
    };
    expect(
      siteDesignResultFromWire(wire, ["home"], [], 2).designSpec.colorRoles,
    ).toEqual({
      backgroundPaletteIndex: 0,
      textPaletteIndex: 1,
      accentPaletteIndex: 1,
    });

    for (const invalidCoordinate of [null, "1", 0.5, Number.NaN]) {
      expect(() =>
        siteDesignResultFromWire(
          {
            ...wire,
            backgroundPaletteIndex: invalidCoordinate,
          },
          ["home"],
          [],
          2,
        ),
      ).toThrow();
    }
  });

  it("injects the frozen Hero blueprint into SiteDesignSpecV2 and rejects provider overrides", () => {
    const blueprint = referenceBlueprintForVisualCandidate({
      candidateId: "candidate-F",
      providerItemKey: "n:8435",
      previewSha256: "a".repeat(64),
      title: "Hero Section 7",
    });
    const wire = {
      operationToken: "design-token-v3",
      schemaVersion: 3,
      layoutArchetype: "hero_led",
      density: "spacious",
      surfaceStyle: "soft_depth",
      typeScale: "display",
      imageTreatment: "wide",
      motionLevel: "subtle",
      backgroundPaletteIndex: 0,
      textPaletteIndex: 1,
      accentPaletteIndex: 2,
      siteTitle: "天印溯方",
      description: "可测量、可解释、可干预的健康服务。",
      routeSlots: [
        { routeId: "home", slotId: "proof", variant: "proof" },
        { routeId: "home", slotId: "cta", variant: "cta" },
      ],
    };
    const design = siteDesignResultV2FromWire(wire, ["home"], blueprint);
    expect(design.designSpec.referenceBlueprint).toEqual(blueprint);
    expect(design.designSpec.referenceBlueprint.heroFamily).toBe(
      "floating_orbit",
    );
    expect(() =>
      siteDesignResultV2FromWire(
        { ...wire, heroFamily: "centered_dual_cta" },
        ["home"],
        blueprint,
      ),
    ).toThrow();
  });

  it("rejects legacy PageContentWireV1 instead of weakening the V2 host boundary", () => {
    expect(() =>
      pageContentResultFromWire(
        {
          operationToken: "content-token",
          schemaVersion: 1,
          routes: [],
          sections: [],
        },
        ["home"],
        ["overview"],
      ),
    ).toThrow();
  });

  it("canonicalizes eight provider routes and injects host-owned empty news", () => {
    const providerRouteIds = [
      "home",
      "about",
      "products",
      "services",
      "solutions",
      "cases",
      "faq",
      "contact",
    ] as const;
    const wire = {
      operationToken: "content-token-v3",
      schemaVersion: 3,
      routes: providerRouteIds.map((routeId) => ({
        routeId,
        eyebrow: null,
        heading: `${routeId} 可信内容`,
        summary: "仅使用冻结知识库。",
      })),
      blocks: providerRouteIds.map((routeId) => ({
        routeId,
        slotId: `${routeId}-overview`,
        blockType: routeId === "home" ? "feature_list" : "prose",
        heading: `${routeId} 内容`,
        paragraphs: ["提供经过来源核验的内容。"],
        items: routeId === "home" ? ["设备巡检", "状态分析"] : [],
        entityIds: [],
        faqIds: [],
        sourceDocumentIds: ["kb-overview-poison-001"],
      })),
      entities: [],
      faqs: [],
      officialLinks: [],
    } as const;
    const result = pageContentResultV2FromWire(
      wire,
      [...providerRouteIds, "news"],
      ["kb-overview-poison-001"],
      ["news"],
    );
    expect(result.pageContent.schemaVersion).toBe(2);
    expect(result.pageContent.routes).toHaveLength(9);
    expect(
      result.pageContent.routes.find((route) => route.routeId === "home"),
    ).toMatchObject({ sections: [{ blockType: "feature_list" }] });
    expect(
      result.pageContent.routes.find((route) => route.routeId === "news"),
    ).toMatchObject({
      heading: "企业动态",
      summary: "当前知识库暂无可公开的企业动态。",
      emptyState: "company_news_unavailable",
      sections: [],
    });
    expect(() =>
      pageContentResultV2FromWire(
        {
          ...wire,
          blocks: [
            ...wire.blocks,
            {
              ...wire.blocks[0],
              routeId: "news",
              slotId: "invented-news",
            },
          ],
        },
        [...providerRouteIds, "news"],
        ["kb-overview-poison-001"],
        ["news"],
      ),
    ).toThrow("SITEOPS_CONTENT_SOURCE_OR_ROUTE_MISMATCH");
    expect(() =>
      pageContentResultV2FromWire(
        {
          ...wire,
          routes: [
            ...wire.routes,
            {
              routeId: "news",
              eyebrow: null,
              heading: "模型生成的新闻",
              summary: "不得接纳。",
            },
          ],
        },
        [...providerRouteIds, "news"],
        ["kb-overview-poison-001"],
        ["news"],
      ),
    ).toThrow("SITEOPS_CONTENT_SOURCE_OR_ROUTE_MISMATCH");
  });

  it("accepts item-driven blocks without duplicate prose and normalizes non-ASCII slugs", () => {
    const sourceDocumentId = "kb-overview-poison-001";
    const wire = {
      operationToken: "content-token-v3-data-blocks",
      schemaVersion: 3,
      routes: [
        {
          routeId: "home",
          eyebrow: null,
          heading: "可信制造服务",
          summary: "仅使用冻结知识库。",
        },
      ],
      blocks: [
        {
          routeId: "home",
          slotId: "features",
          blockType: "feature_list",
          heading: "服务能力",
          paragraphs: [],
          items: ["设备巡检", "状态分析"],
          entityIds: [],
          faqIds: [],
          sourceDocumentIds: [sourceDocumentId],
        },
        {
          routeId: "home",
          slotId: "process",
          blockType: "steps",
          heading: "服务步骤",
          paragraphs: [],
          items: ["需求确认", "方案实施"],
          entityIds: [],
          faqIds: [],
          sourceDocumentIds: [sourceDocumentId],
        },
        {
          routeId: "home",
          slotId: "metrics",
          blockType: "metrics",
          heading: "服务指标",
          paragraphs: [],
          items: ["7×24 小时状态监测"],
          entityIds: [],
          faqIds: [],
          sourceDocumentIds: [sourceDocumentId],
        },
        {
          routeId: "home",
          slotId: "services",
          blockType: "entity_grid",
          heading: "服务实体",
          paragraphs: [],
          items: [],
          entityIds: ["equipment-service"],
          faqIds: [],
          sourceDocumentIds: [sourceDocumentId],
        },
        {
          routeId: "home",
          slotId: "questions",
          blockType: "faq_preview",
          heading: "常见问题",
          paragraphs: [],
          items: [],
          entityIds: [],
          faqIds: ["service-faq"],
          sourceDocumentIds: [sourceDocumentId],
        },
      ],
      entities: [
        {
          entityId: "equipment-service",
          entityType: "service",
          slug: "设备巡检服务",
          title: "设备巡检服务",
          summary: "经过来源核验的设备巡检服务。",
          body: ["提供状态采集与巡检建议。"],
          tags: ["设备巡检"],
          publishedAt: null,
          modifiedAt: null,
          author: null,
          sourceName: null,
          sourceUrl: null,
          sourceDocumentIds: [sourceDocumentId],
          relatedEntityIds: [],
        },
      ],
      faqs: [
        {
          faqId: "service-faq",
          category: "服务",
          question: "如何开始？",
          answers: ["先核对需求与可用资料。"],
          sourceDocumentIds: [sourceDocumentId],
        },
      ],
      officialLinks: [],
    };

    const result = pageContentResultV2FromWire(
      wire,
      ["home"],
      [sourceDocumentId],
    );
    expect(result.pageContent.routes[0]?.sections).toHaveLength(5);
    expect(
      result.pageContent.routes[0]?.sections.every(
        (section) => section.paragraphs.length === 0,
      ),
    ).toBe(true);
    expect(result.pageContent.entities[0]?.slug).toBe("equipment-service");

    const ascii = structuredClone(wire);
    ascii.entities[0]!.slug = "verified-service";
    expect(
      pageContentResultV2FromWire(ascii, ["home"], [sourceDocumentId])
        .pageContent.entities[0]?.slug,
    ).toBe("verified-service");

    const emptyProse = structuredClone(wire);
    emptyProse.blocks[0] = {
      ...emptyProse.blocks[0]!,
      blockType: "prose",
      items: [],
    };
    expect(() =>
      pageContentResultV2FromWire(emptyProse, ["home"], [sourceDocumentId]),
    ).toThrow("Text-led content blocks require canonical paragraphs");

    const missingItems = structuredClone(wire);
    missingItems.blocks[0]!.items = [];
    expect(() =>
      pageContentResultV2FromWire(missingItems, ["home"], [sourceDocumentId]),
    ).toThrow("Item-led content blocks require canonical items");

    const collision = structuredClone(wire);
    collision.entities.push({
      ...collision.entities[0]!,
      entityId: "second-service",
      slug: "equipment-service",
      title: "第二项服务",
    });
    expect(() =>
      pageContentResultV2FromWire(collision, ["home"], [sourceDocumentId]),
    ).toThrow("Content entity ids and type/slug routes must be unique");
  });

  it("deterministically splits an oversized dossier without truncating document content", () => {
    const contents = ["甲", "乙", "丙"].map((character) =>
      character.repeat(3_000_000),
    );
    const attachments = siteOpsSourceDossierAttachments({
      operationToken: "design-token",
      snapshot: {
        id: "50000000-0000-4000-8000-000000000005",
        archiveSha256: "a".repeat(64),
        sourceBuildId: null,
        sourceBuildRevision: null,
      },
      brief: { companyName: "星河智造" },
      visualEvidence: { previewSha256: "b".repeat(64) },
      documents: contents.map((content, index) => ({
        id: `doc-${index + 1}`,
        path: `doc-${index + 1}.md`,
        title: `资料 ${index + 1}`,
        content,
        kind: "leaf",
        customerVisible: true as const,
      })),
    });
    expect(attachments.length).toBeGreaterThan(1);
    expect(attachments[0]?.filename).toBe(
      "frontmind-siteops-source-dossier-v1.json",
    );
    const decoded = attachments.map((attachment) =>
      Buffer.from(attachment.file_data.split(",", 2)[1]!, "base64"),
    );
    expect(decoded.every((bytes) => bytes.length <= 16 * 1024 * 1024)).toBe(
      true,
    );
    const parts = decoded.slice(1).flatMap((bytes) => {
      const value = JSON.parse(bytes.toString("utf8"));
      return value.documents as Array<{
        id: string;
        content: string;
        contentPartIndex: number;
      }>;
    });
    for (const [index, content] of contents.entries()) {
      expect(
        parts
          .filter((document) => document.id === `doc-${index + 1}`)
          .sort((left, right) => left.contentPartIndex - right.contentPartIndex)
          .map((document) => document.content)
          .join(""),
      ).toBe(content);
    }
  });
});
