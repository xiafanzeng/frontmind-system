import { describe, expect, it } from "vitest";

import type { SiteBrief } from "../../shared/siteops";
import { siteOpsGeneratedContentV2Schema } from "./build-runtime";
import {
  canonicalPreviewModelV1Schema,
  canonicalPreviewToGeneratedContent,
  canonicalizeSiteContentDraft,
  draftFromPageContentWire,
} from "./site-content-draft";

const token = "siteops-content:10000000-0000-4000-8000-000000000001";
const seo = {
  siteTitle: "可信企业",
  description: "可信企业官网",
  organizationType: "Organization" as const,
};

function brief(): SiteBrief {
  return {
    companyName: "可信企业",
    primaryLanguage: "zh-CN",
    contacts: [],
    offerings: ["可信服务"],
    audience: ["企业客户"],
    conversionGoal: "联系企业",
    contentInventory: {
      schemaVersion: 1,
      source: "frozen_knowledge_snapshot",
      entries: [],
    },
    routes: [
      {
        id: "home",
        slug: "/",
        title: "首页",
        sourceDocumentIds: ["doc-home"],
      },
      {
        id: "news",
        slug: "/news",
        title: "企业动态",
        sourceDocumentIds: [],
      },
    ],
    verifiedFacts: [
      {
        statement: "这是来自冻结资料的可信介绍。",
        sourceDocumentIds: ["doc-home"],
      },
    ],
    publicAssetIds: [],
    unknowns: [],
  };
}

describe("site content draft canonicalizer", () => {
  it("keeps frozen routes, drops unknown coordinates and injects the news empty state", () => {
    const result = canonicalizeSiteContentDraft({
      operationToken: token,
      brief: brief(),
      seo,
      draft: {
        operationToken: token,
        routes: [
          {
            routeId: "unknown",
            heading: "不得扩展路由",
          },
          {
            routeId: "home",
            heading: " 可信\u0000首页 ",
            summary: "依据资料形成的首页摘要",
            ignored: "drop me",
            sections: [
              {
                heading: "能力 <script>alert(1)</script>",
                paragraphs: ["可信正文"],
                bullets: ["可信要点"],
                sourceIds: ["doc-home", "other-project-document"],
                ignored: true,
              },
            ],
          },
        ],
      },
    });

    expect(canonicalPreviewModelV1Schema.parse(result)).toEqual(result);
    expect(siteOpsGeneratedContentV2Schema.parse(result)).toEqual(result);
    expect(result.routes.map((route) => route.routeId)).toEqual([
      "home",
      "news",
    ]);
    expect(result).toMatchObject({
      schemaVersion: 2,
      seo,
      entities: [],
      faqs: [],
      officialLinks: [],
    });
    expect(result.routes[0]).toMatchObject({
      heading: "可信 首页",
      sections: [
        {
          heading: "能力 alert(1)",
          sourceDocumentIds: ["doc-home"],
          slotId: "overview",
          blockType: "prose",
        },
      ],
    });
    expect(result.routes[1]).toMatchObject({
      heading: "企业动态",
      summary: "当前知识库暂无可公开的企业动态。",
      emptyState: "company_news_unavailable",
    });
    expect(JSON.stringify(result)).not.toContain("other-project-document");
    expect(JSON.stringify(result)).not.toContain("<script>");
  });

  it("discards one ungrounded section and completes missing routes from the frozen brief", () => {
    const result = canonicalizeSiteContentDraft({
      operationToken: token,
      brief: brief(),
      seo,
      draft: {
        operationToken: token,
        routes: [
          {
            routeId: "home",
            heading: "没有来源的模型标题",
            summary: "没有来源的模型摘要",
            sections: [
              {
                heading: "无来源内容",
                paragraphs: ["不得采用"],
                sourceIds: ["wrong-source"],
              },
            ],
          },
        ],
      },
    });

    expect(result.routes[0]?.summary).toBe("这是来自冻结资料的可信介绍。");
    expect(result.routes[0]?.sections[0]).toMatchObject({
      paragraphs: ["这是来自冻结资料的可信介绍。"],
      slotId: "overview",
      blockType: "prose",
      sourceDocumentIds: ["doc-home"],
    });
    expect(JSON.stringify(result)).not.toContain("不得采用");
    expect(JSON.stringify(result)).not.toContain("没有来源的模型");
  });

  it("produces a complete brief fallback when the provider has no usable content", () => {
    const result = canonicalizeSiteContentDraft({
      operationToken: token,
      brief: brief(),
      seo,
      draft: null,
    });

    expect(result.routes).toHaveLength(2);
  });

  it("renders a fixed non-factual host placeholder for an ordinary route with no sources", () => {
    const input = brief();
    input.routes[0]!.sourceDocumentIds = [];
    input.verifiedFacts = [];

    const result = canonicalizeSiteContentDraft({
      operationToken: token,
      brief: input,
      seo,
      draft: null,
    });

    expect(result.routes[0]).toMatchObject({
      routeId: "home",
      summary: "本页面暂无可由已验证资料公开展示的内容。",
      sections: [
        {
          grounding: "host_placeholder",
          sourceDocumentIds: [],
          paragraphs: ["本页面暂无可由已验证资料公开展示的内容。"],
        },
      ],
    });
    expect(siteOpsGeneratedContentV2Schema.parse(result)).toEqual(result);
  });

  it("replaces a route title that normalizes to empty with a trusted host label", () => {
    const input = brief();
    input.routes[0]!.title = "<b>";

    const result = canonicalizeSiteContentDraft({
      operationToken: token,
      brief: input,
      seo,
      draft: null,
    });

    expect(result.routes[0]).toMatchObject({
      heading: "页面",
      sections: [{ heading: "页面" }],
    });
    expect(siteOpsGeneratedContentV2Schema.parse(result)).toEqual(result);
  });

  it("never reintroduces a raw frozen title through a source-bound provider section", () => {
    const input = brief();
    input.routes[0]!.title = "<b>";

    const result = canonicalizeSiteContentDraft({
      operationToken: token,
      brief: input,
      seo,
      draft: {
        operationToken: token,
        routes: [
          {
            routeId: "home",
            heading: "<u>",
            sections: [
              {
                heading: "<i>",
                paragraphs: ["可信正文"],
                sourceIds: ["doc-home"],
              },
            ],
          },
        ],
      },
    });

    expect(result.routes[0]).toMatchObject({
      heading: "页面",
      sections: [{ heading: "页面", paragraphs: ["可信正文"] }],
    });
    expect(JSON.stringify(result)).not.toMatch(/<[/]?[biu]>/u);
  });

  it("never launders a missing or cross-task token into the trusted model", () => {
    for (const draft of [
      { routes: [] },
      { operationToken: "siteops-content:other", routes: [] },
    ]) {
      expect(() =>
        canonicalizeSiteContentDraft({
          operationToken: token,
          brief: brief(),
          seo,
          draft,
        }),
      ).toThrow("SITE_CONTENT_DRAFT_TOKEN_MISMATCH");
    }
  });

  it("extracts the usable subset of current V3 wire blocks", () => {
    const draft = draftFromPageContentWire(
      {
        operationToken: token,
        routes: [
          {
            routeId: "home",
            heading: "模型首页",
            summary: "模型摘要",
            ignored: true,
          },
        ],
        blocks: [
          {
            routeId: "home",
            heading: "服务能力",
            paragraphs: ["可信说明", 123],
            items: ["能力一"],
            sourceDocumentIds: ["doc-home"],
            blockType: "unknown-provider-choice",
          },
          { routeId: 42, paragraphs: ["drop"] },
        ],
      },
      token,
    );

    expect(draft).toEqual({
      operationToken: token,
      routes: [
        {
          routeId: "home",
          heading: "模型首页",
          summary: "模型摘要",
          sections: [
            {
              heading: "服务能力",
              paragraphs: ["可信说明"],
              bullets: ["能力一"],
              sourceIds: ["doc-home"],
            },
          ],
        },
      ],
    });
    expect(() =>
      draftFromPageContentWire(
        { operationToken: "siteops-content:other", routes: [] },
        token,
      ),
    ).toThrow("SITE_CONTENT_DRAFT_TOKEN_MISMATCH");
  });

  it("fills every server-owned design slot with source-bound V2 content", () => {
    const canonical = canonicalizeSiteContentDraft({
      operationToken: token,
      brief: brief(),
      seo,
      draft: {
        operationToken: token,
        routes: [
          {
            routeId: "home",
            heading: "模型首页",
            summary: "模型摘要",
            sections: [
              {
                heading: "能力",
                paragraphs: ["说明"],
                bullets: ["能力一", "能力二"],
                sourceIds: ["doc-home"],
              },
            ],
          },
        ],
      },
    });
    const generated = canonicalPreviewToGeneratedContent({
      canonical,
      designRouteCompositions: [
        {
          routeId: "home",
          slots: [
            { slotId: "overview", variant: "statement" },
            { slotId: "features", variant: "cards" },
          ],
        },
        {
          routeId: "news",
          slots: [{ slotId: "news-empty", variant: "statement" }],
        },
      ],
      fallbackSourceDocumentIds: { home: ["doc-home"], news: [] },
    });

    expect(generated.routes[0]?.sections).toMatchObject([
      {
        slotId: "overview",
        blockType: "prose",
        paragraphs: ["说明"],
        sourceDocumentIds: ["doc-home"],
      },
      {
        slotId: "features",
        blockType: "feature_list",
        items: ["能力一", "能力二"],
        sourceDocumentIds: ["doc-home"],
      },
    ]);
    expect(generated.routes[1]).toMatchObject({
      routeId: "news",
      emptyState: "company_news_unavailable",
      sections: [],
    });
    expect(siteOpsGeneratedContentV2Schema.parse(generated)).toEqual(generated);
  });
});
