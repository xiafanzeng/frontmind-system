import { describe, expect, it } from "vitest";

import { siteContentPatchV1Schema } from "../../shared/siteops-content-patch";
import type { SiteBrief } from "../../shared/siteops";
import { siteOpsGeneratedContentV2Schema } from "./build-runtime";
import {
  canonicalPreviewModelV1Schema,
  canonicalizeSiteContentDraft,
} from "./site-content-draft";
import {
  applySiteContentPatchV1,
  applySiteContentPatchV1Resilient,
  normalizeSiteContentPatchV1Wire,
} from "./site-content-patch";

const operationToken = "siteops-patch:00000000-0000-4000-8000-000000000001";
const baseSourceSha256 = "a".repeat(64);

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
    ],
    verifiedFacts: [
      {
        statement: "冻结资料中的企业介绍。",
        sourceDocumentIds: ["doc-home"],
      },
    ],
    publicAssetIds: [],
    unknowns: [],
  };
}

function baseline() {
  return canonicalizeSiteContentDraft({
    draft: null,
    operationToken,
    brief: brief(),
    seo: {
      siteTitle: "可信企业",
      description: "可信企业官网",
      organizationType: "Organization",
    },
  });
}

function baselineWithListSlot() {
  const trusted = baseline();
  return canonicalPreviewModelV1Schema.parse({
    ...trusted,
    routes: trusted.routes.map((route) => ({
      ...route,
      sections: route.sections.map((section) =>
        section.slotId === "overview"
          ? {
              ...section,
              blockType: "feature_list" as const,
              paragraphs: [],
              items: ["冻结默认能力"],
            }
          : section,
      ),
    })),
  });
}

describe("SiteContentPatchV1", () => {
  it("applies only source-bound text/list values to frozen coordinates", () => {
    const result = applySiteContentPatchV1({
      patch: {
        schemaVersion: 1,
        operationToken,
        baseSourceSha256,
        pages: [
          {
            routeId: "home",
            slots: [
              {
                slotId: "overview",
                kind: "richText",
                value: "企业 <script>bad()</script> 可信介绍",
                sourceIds: ["doc-home"],
              },
            ],
          },
        ],
      },
      expectedOperationToken: operationToken,
      expectedBaseSourceSha256: baseSourceSha256,
      baseline: baseline(),
      allowedSourceIdsByRoute: { home: ["doc-home"] },
    });

    expect(result.warnings).toEqual([]);
    expect(result.canonical.routes[0]?.sections[0]).toMatchObject({
      slotId: "overview",
      paragraphs: ["企业 bad() 可信介绍"],
      sourceDocumentIds: ["doc-home"],
    });
    expect(JSON.stringify(result.canonical)).not.toContain("<script>");
  });

  it("preserves a valid list patch at the strict generated-content boundary without re-layout", () => {
    const result = applySiteContentPatchV1Resilient({
      patch: {
        schemaVersion: 1,
        operationToken,
        baseSourceSha256,
        pages: [
          {
            routeId: "home",
            slots: [
              {
                slotId: "overview",
                kind: "list",
                value: ["第一项可信能力", "第二项可信能力"],
                sourceIds: ["doc-home"],
              },
            ],
          },
        ],
      },
      expectedOperationToken: operationToken,
      expectedBaseSourceSha256: baseSourceSha256,
      baseline: baselineWithListSlot(),
      allowedSourceIdsByRoute: { home: ["doc-home"] },
    });

    const generated = siteOpsGeneratedContentV2Schema.parse(result.canonical);
    expect(result.renderMode).toBe("content_patch");
    expect(generated.routes[0]?.sections[0]).toMatchObject({
      slotId: "overview",
      blockType: "feature_list",
      paragraphs: [],
      items: ["第一项可信能力", "第二项可信能力"],
      sourceDocumentIds: ["doc-home"],
    });
  });

  it("keeps baseline values for unknown or ungrounded children", () => {
    const trusted = baseline();
    const result = applySiteContentPatchV1({
      patch: {
        schemaVersion: 1,
        operationToken,
        baseSourceSha256,
        pages: [
          {
            routeId: "unknown",
            slots: [],
          },
          {
            routeId: "home",
            slots: [
              {
                slotId: "overview",
                kind: "richText",
                value: "不得采用的无来源文本",
                sourceIds: ["other-document"],
              },
            ],
          },
        ],
      },
      expectedOperationToken: operationToken,
      expectedBaseSourceSha256: baseSourceSha256,
      baseline: trusted,
      allowedSourceIdsByRoute: { home: ["doc-home"] },
    });

    expect(result.canonical).toEqual(trusted);
    expect(result.warnings.map((warning) => warning.code)).toEqual([
      "unknown_route",
      "source_binding_invalid",
    ]);
  });

  it("does not let a patch change the frozen slot kind", () => {
    const trusted = baseline();
    const proseToList = applySiteContentPatchV1Resilient({
      patch: {
        schemaVersion: 1,
        operationToken,
        baseSourceSha256,
        pages: [
          {
            routeId: "home",
            slots: [
              {
                slotId: "overview",
                kind: "list",
                value: ["不得改变结构"],
                sourceIds: ["doc-home"],
              },
            ],
          },
        ],
      },
      expectedOperationToken: operationToken,
      expectedBaseSourceSha256: baseSourceSha256,
      baseline: trusted,
      allowedSourceIdsByRoute: { home: ["doc-home"] },
    });
    expect(proseToList.canonical).toEqual(trusted);
    expect(proseToList.warnings).toContainEqual({
      code: "slot_kind_mismatch",
      routeId: "home",
      slotId: "overview",
    });

    const listTrusted = baselineWithListSlot();
    const listToProse = applySiteContentPatchV1Resilient({
      patch: {
        schemaVersion: 1,
        operationToken,
        baseSourceSha256,
        pages: [
          {
            routeId: "home",
            slots: [
              {
                slotId: "overview",
                kind: "richText",
                value: "不得改变结构",
                sourceIds: ["doc-home"],
              },
            ],
          },
        ],
      },
      expectedOperationToken: operationToken,
      expectedBaseSourceSha256: baseSourceSha256,
      baseline: listTrusted,
      allowedSourceIdsByRoute: { home: ["doc-home"] },
    });
    expect(listToProse.canonical).toEqual(listTrusted);
    expect(listToProse.warnings).toContainEqual({
      code: "slot_kind_mismatch",
      routeId: "home",
      slotId: "overview",
    });
  });

  it("rejects task/hash mismatches and executable fields", () => {
    const common = {
      schemaVersion: 1 as const,
      operationToken,
      baseSourceSha256,
      pages: [],
    };
    expect(() =>
      applySiteContentPatchV1({
        patch: { ...common, operationToken: `${operationToken}:other` },
        expectedOperationToken: operationToken,
        expectedBaseSourceSha256: baseSourceSha256,
        baseline: baseline(),
        allowedSourceIdsByRoute: {},
      }),
    ).toThrow("SITE_CONTENT_PATCH_TOKEN_MISMATCH");
    expect(
      siteContentPatchV1Schema.safeParse({
        ...common,
        script: "alert(1)",
      }).success,
    ).toBe(false);
  });

  it("normalizes BOM, whole JSON fences, JSONC comments and trailing commas", () => {
    const wire = `\ufeff\`\`\`jsonc
    {
      // transport-only comment
      "schemaVersion": 1,
      "operationToken": "${operationToken}",
      "baseSourceSha256": "${baseSourceSha256}",
      "pages": [{
        "routeId": "home",
        "slots": [{
          "slotId": "overview",
          "kind": "text",
          "value": "可信 // 正文 /* 仍是正文 */",
          "sourceIds": ["doc-home",],
        },],
      },],
    }
    \`\`\``;
    expect(normalizeSiteContentPatchV1Wire(wire)).toMatchObject({
      schemaVersion: 1,
      pages: [
        {
          slots: [{ value: "可信 // 正文 /* 仍是正文 */" }],
        },
      ],
    });
  });

  it("unwraps exactly one double-encoded JSON layer", () => {
    const patch = {
      schemaVersion: 1,
      operationToken,
      baseSourceSha256,
      pages: [],
    };
    expect(
      normalizeSiteContentPatchV1Wire(JSON.stringify(JSON.stringify(patch))),
    ).toEqual(patch);
    expect(
      normalizeSiteContentPatchV1Wire(
        JSON.stringify(JSON.stringify(JSON.stringify(patch))),
      ),
    ).toBe(JSON.stringify(patch));
  });

  it("keeps the trusted baseline for prose, malformed JSON and timeout/null", () => {
    for (const patch of [
      "I finished the website.",
      '{"schemaVersion":1,"pages":',
      null,
    ]) {
      const result = applySiteContentPatchV1Resilient({
        patch,
        expectedOperationToken: operationToken,
        expectedBaseSourceSha256: baseSourceSha256,
        baseline: baseline(),
        allowedSourceIdsByRoute: { home: ["doc-home"] },
      });
      expect(result.canonical).toEqual(baseline());
      expect(result.renderMode).toBe("trusted_fallback");
      expect(result.appliedSlotCount).toBe(0);
      expect(result.warnings).toContainEqual({
        code: "patch_invalid",
        routeId: "*",
      });
    }
  });

  it("applies valid siblings while malformed and ungrounded slots use defaults", () => {
    const trusted = baseline();
    const result = applySiteContentPatchV1Resilient({
      patch: {
        schemaVersion: 1,
        operationToken,
        baseSourceSha256,
        pages: [
          {
            routeId: "home",
            slots: [
              {
                slotId: "overview",
                kind: "richText",
                value: "采用的可信内容",
                sourceIds: ["doc-home"],
              },
              {
                slotId: "bad-shape",
                kind: "text",
                value: 123,
                sourceIds: ["doc-home"],
              },
              {
                slotId: "unknown",
                kind: "text",
                value: "不存在的坐标",
                sourceIds: ["doc-home"],
              },
            ],
          },
        ],
      },
      expectedOperationToken: operationToken,
      expectedBaseSourceSha256: baseSourceSha256,
      baseline: trusted,
      allowedSourceIdsByRoute: { home: ["doc-home"] },
    });

    expect(result.renderMode).toBe("content_patch");
    expect(result.appliedSlotCount).toBe(1);
    expect(result.canonical.routes[0]?.sections[0]?.paragraphs).toEqual([
      "采用的可信内容",
    ]);
    expect(result.warnings.map((warning) => warning.code)).toEqual([
      "slot_schema_invalid",
      "unknown_slot",
    ]);
  });

  it("fails closed to the baseline on token/hash mismatch or executable fields", () => {
    const common = {
      schemaVersion: 1,
      operationToken,
      baseSourceSha256,
      pages: [],
    };
    for (const patch of [
      { ...common, operationToken: `${operationToken}:other` },
      { ...common, baseSourceSha256: "b".repeat(64) },
      { ...common, script: "alert(1)" },
    ]) {
      const result = applySiteContentPatchV1Resilient({
        patch,
        expectedOperationToken: operationToken,
        expectedBaseSourceSha256: baseSourceSha256,
        baseline: baseline(),
        allowedSourceIdsByRoute: { home: ["doc-home"] },
      });
      expect(result.renderMode).toBe("trusted_fallback");
      expect(result.canonical).toEqual(baseline());
    }
  });

  it("rejects oversized wire values without parsing them", () => {
    const result = applySiteContentPatchV1Resilient({
      patch: `"${"x".repeat(1024 * 1024)}"`,
      expectedOperationToken: operationToken,
      expectedBaseSourceSha256: baseSourceSha256,
      baseline: baseline(),
      allowedSourceIdsByRoute: { home: ["doc-home"] },
    });
    expect(result.renderMode).toBe("trusted_fallback");
    expect(result.warnings[0]?.code).toBe("patch_invalid");
  });
});
