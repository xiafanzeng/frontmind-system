import { createHash } from "node:crypto";

import JSZip from "jszip";
import sharp from "sharp";
import { beforeAll, describe, expect, it, vi } from "vitest";

const browserQaMocks = vi.hoisted(() => {
  const screenshot = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  );
  const goto = vi.fn(async (url: string) => {
    const response = await fetch(url);
    await response.arrayBuffer();
    return { ok: () => response.ok };
  });
  const page = {
    goto,
    setViewportSize: vi.fn(async () => undefined),
    screenshot: vi.fn(async () => screenshot),
  };
  const browserLaunch = vi.fn(async () => ({
    newContext: vi.fn(async () => ({
      newPage: vi.fn(async () => page),
    })),
    close: vi.fn(async () => undefined),
  }));
  const axeAnalyze = vi.fn(async () => ({ violations: [] }));
  const chromeLaunch = vi.fn(async () => ({
    port: 9222,
    kill: vi.fn(),
  }));
  const lighthouse = vi.fn(async (url: string) => {
    const response = await fetch(url);
    await response.arrayBuffer();
    return {
      lhr: {
        categories: {
          performance: { score: 0.95 },
          accessibility: { score: 1 },
          "best-practices": { score: 1 },
          seo: { score: 1 },
        },
        audits: {
          "cumulative-layout-shift": { numericValue: 0.01 },
        },
      },
    };
  });
  return {
    axeAnalyze,
    browserLaunch,
    chromeLaunch,
    goto,
    lighthouse,
  };
});

const buildProcessMocks = vi.hoisted(() => ({
  failNextReactBuild: false,
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const { EventEmitter } = await import("node:events");
  return {
    ...actual,
    spawn: ((...args: Parameters<typeof actual.spawn>) => {
      const commandArguments = args[1];
      const isReactRenderer =
        Array.isArray(commandArguments) &&
        commandArguments.some(
          (argument) =>
            typeof argument === "string" && argument.endsWith("/render.mjs"),
        );
      if (!buildProcessMocks.failNextReactBuild || !isReactRenderer) {
        return actual.spawn(...args);
      }
      buildProcessMocks.failNextReactBuild = false;
      const child = new EventEmitter() as ReturnType<typeof actual.spawn>;
      Object.assign(child, {
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
        kill: vi.fn(() => true),
      });
      queueMicrotask(() => child.emit("exit", 1, null));
      return child;
    }) as typeof actual.spawn,
  };
});

vi.mock("playwright", () => ({
  chromium: {
    executablePath: () => "/frontmind-test/chromium",
    launch: browserQaMocks.browserLaunch,
  },
}));

vi.mock("@axe-core/playwright", () => ({
  default: class MockAxeBuilder {
    withTags() {
      return this;
    }

    analyze() {
      return browserQaMocks.axeAnalyze();
    }
  },
}));

vi.mock("chrome-launcher", () => ({
  launch: browserQaMocks.chromeLaunch,
}));

vi.mock("lighthouse", () => ({
  default: browserQaMocks.lighthouse,
}));

import {
  SITEOPS_MATERIALIZER_V1_6,
  SITEOPS_MATERIALIZER_V2_0,
  SITEOPS_MATERIALIZER_V2_2,
  SITEOPS_MATERIALIZER_V2_3,
  SITEOPS_MATERIALIZER_V2_4_LEGACY,
  SITEOPS_MATERIALIZER_V2_5,
  SITEOPS_WORKFLOW,
} from "../../shared/siteops";
import { SITEOPS_CONTENT_PATCH_PARTIAL_DEFAULTS_WARNING_CODE } from "../../shared/siteops-contract";
import {
  FRONTMIND_VISUAL_FAMILIES_V3,
  referenceBlueprintForVisualCandidate,
  referenceBlueprintV3ForFamily,
  referenceBlueprintV4ForFamily,
  trustedVisualPreviewBlueprintV3,
  type SiteDesignSpecV2,
  type SiteOpsRuntimeVisualEvidenceV2,
} from "../../shared/siteops-design";
import {
  generateSocialPackage,
  materializeAstroSite,
  materializeNativeTrustedFallbackSite,
  materializeProductionSiteFromSource,
  siteOpsFrozenRuntimeInputSchema,
  SiteOpsMaterializationError,
  type MaterializeAstroSiteInput,
  type SocialPackageInput,
} from "./build-runtime";

const H = (value: string) => createHash("sha256").update(value).digest("hex");

function luminance(hex: string) {
  const channels = [1, 3, 5].map(
    (offset) => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255,
  );
  const linear = channels.map((channel) =>
    channel <= 0.04045
      ? channel / 12.92
      : Math.pow((channel + 0.055) / 1.055, 2.4),
  );
  return linear[0]! * 0.2126 + linear[1]! * 0.7152 + linear[2]! * 0.0722;
}

function ratio(left: string, right: string) {
  const leftLuminance = luminance(left);
  const rightLuminance = luminance(right);
  return (
    (Math.max(leftLuminance, rightLuminance) + 0.05) /
    (Math.min(leftLuminance, rightLuminance) + 0.05)
  );
}

function buildInput(
  mode: "preview" | "production" = "preview",
): MaterializeAstroSiteInput {
  const snapshotId = "10000000-0000-4000-8000-000000000001";
  const archiveHash = H("knowledge-archive");
  const previewSha256 = H("same-origin-preview");
  const referenceBlueprint = referenceBlueprintForVisualCandidate({
    candidateId: "candidate-F",
    providerItemKey: "n:8435",
    previewSha256,
    title: "Floating orbit life science hero",
  });
  return {
    build: {
      id: "20000000-0000-4000-8000-000000000002",
      projectId: "30000000-0000-4000-8000-000000000003",
      userId: 7,
      knowledgeSnapshotId: snapshotId,
      knowledgeArchiveHash: archiveHash,
      workflowUpstreamVersion: SITEOPS_WORKFLOW.upstreamVersion,
      workflowUpstreamHash: SITEOPS_WORKFLOW.upstreamSha256,
      workflowVersion: SITEOPS_WORKFLOW.frontMindVersion,
      workflowPackageHash: SITEOPS_WORKFLOW.runtimeManifestSha256,
      starterVersion: SITEOPS_WORKFLOW.starterVersion,
      selectionHash: H("selection"),
    },
    snapshot: {
      id: snapshotId,
      userId: 7,
      archiveHash,
      sourceBuildId: "40000000-0000-4000-8000-000000000004",
      sourceBuildRevision: 3,
      documents: [
        {
          id: "overview",
          path: "overview.md",
          title: "企业概览",
          content: "星河智造为制造企业提供经过确认的设备运维与数据服务。",
          kind: "overview",
          customerVisible: true,
        },
        {
          id: "service",
          path: "services/maintenance.md",
          title: "设备运维服务",
          content: "服务覆盖设备巡检、状态分析和维护建议。",
          kind: "leaf",
          customerVisible: true,
        },
      ],
    },
    brief: {
      companyName: "星河智造",
      primaryLanguage: "zh-CN",
      contacts: [
        {
          kind: "email",
          value: "hello@xinghe.example",
          sourceDocumentIds: ["overview"],
        },
      ],
      offerings: ["设备运维", "状态分析"],
      audience: ["制造企业"],
      conversionGoal: "联系业务团队",
      routes: [
        {
          id: "home",
          slug: "/",
          title: "首页",
          sourceDocumentIds: ["overview", "service"],
        },
        {
          id: "services",
          slug: "/services",
          title: "服务",
          sourceDocumentIds: ["service"],
        },
      ],
      verifiedFacts: [
        {
          statement: "提供设备运维与状态分析服务",
          sourceDocumentIds: ["overview", "service"],
        },
      ],
      publicAssetIds: [],
      unknowns: [],
    },
    visual: {
      schemaVersion: 2,
      queryHash: H("queries"),
      selectedCandidateId: "candidate-F",
      providerItemKey: "n:8435",
      visualEvidenceSha256: H("visual-evidence"),
      previewSha256,
      supportEvidenceSha256s: [],
      taxonomy: {
        role: "foundation",
        palette: ["#10212B", "#EF6C45", "#F5F2EA", "#DDE7E8"],
        typography: ["neutral sans"],
        layout: ["asymmetric grid"],
        motion: ["reduced motion"],
        accessibility: ["high contrast"],
      },
      referenceBlueprint,
    },
    designSpec: {
      schemaVersion: 2,
      referenceBlueprint,
      layoutArchetype: "asymmetric",
      density: "balanced",
      surfaceStyle: "bordered",
      typeScale: "display",
      imageTreatment: "contained",
      motionLevel: "subtle",
      colorRoles: {
        backgroundPaletteIndex: 2,
        textPaletteIndex: 0,
        accentPaletteIndex: 1,
      },
      routeCompositions: [
        {
          routeId: "home",
          slots: [
            { slotId: "service-proof", variant: "proof" },
            { slotId: "audience", variant: "split" },
          ],
        },
        {
          routeId: "services",
          slots: [{ slotId: "service-list", variant: "cards" }],
        },
      ],
      seoPlan: {
        siteTitle: "星河智造",
        description:
          "面向制造企业的设备运维与状态分析服务。\u2028</script><img onerror=alert(1)>",
        organizationType: "ProfessionalService",
      },
    },
    generatedContent: {
      seo: {
        siteTitle: "星河智造",
        description:
          "面向制造企业的设备运维与状态分析服务。\u2028</script><img onerror=alert(1)>",
        organizationType: "ProfessionalService",
      },
      routes: [
        {
          routeId: "home",
          eyebrow: "可靠的制造服务",
          heading: "让设备状态更清晰",
          summary: "基于确认的企业资料，展示设备运维与状态分析能力。",
          sections: [
            {
              slotId: "service-proof",
              heading: "设备运维",
              paragraphs: ["服务覆盖设备巡检、状态分析和维护建议。"],
              sourceDocumentIds: ["service"],
            },
            {
              slotId: "audience",
              heading: "面向制造企业",
              paragraphs: ["团队为制造企业提供经过确认的设备数据服务。"],
              sourceDocumentIds: ["overview"],
            },
          ],
        },
        {
          routeId: "services",
          heading: "设备服务",
          summary: "查看设备巡检、状态分析和维护建议。",
          sections: [
            {
              slotId: "service-list",
              heading: "服务范围",
              paragraphs: ["服务覆盖设备巡检、状态分析和维护建议。"],
              sourceDocumentIds: ["service"],
            },
          ],
        },
      ],
    },
    mode,
    canonicalOrigin:
      mode === "production" ? "https://www.xinghe.example" : null,
  };
}

const TYPED_SOURCE_IDS = {
  overview: "kb-overview-poison-001",
  service: "kb-service-poison-002",
  faq: "kb-faq-poison-003",
} as const;

function typedContentInput(): MaterializeAstroSiteInput {
  const input = buildInput();
  input.snapshot.documents = [
    {
      id: TYPED_SOURCE_IDS.overview,
      path: "company/overview.md",
      title: "企业概览",
      content: "星河智造为制造企业提供设备运维服务。",
      kind: "overview",
      customerVisible: true,
    },
    {
      id: TYPED_SOURCE_IDS.service,
      path: "services/equipment-maintenance.md",
      title: "设备运维服务",
      content: "服务覆盖设备巡检、状态分析和维护建议。",
      kind: "leaf",
      customerVisible: true,
    },
    {
      id: TYPED_SOURCE_IDS.faq,
      path: "faq/maintenance.md",
      title: "设备运维常见问题",
      content: "设备运维包含巡检、状态分析和维护建议。",
      kind: "leaf",
      customerVisible: true,
    },
  ];
  input.brief = {
    companyName: "星河智造",
    primaryLanguage: "zh-CN",
    contacts: [
      {
        kind: "email",
        value: "hello@xinghe.example",
        sourceDocumentIds: [TYPED_SOURCE_IDS.overview],
      },
    ],
    offerings: ["设备运维", "状态分析"],
    audience: ["制造企业"],
    conversionGoal: "联系业务团队",
    contentInventory: {
      schemaVersion: 1,
      source: "frozen_knowledge_snapshot",
      entries: [
        {
          kind: "service",
          sourceDocumentIds: [TYPED_SOURCE_IDS.service],
        },
        {
          kind: "faq",
          sourceDocumentIds: [TYPED_SOURCE_IDS.faq],
        },
      ],
    },
    routes: [
      {
        id: "home",
        slug: "/",
        title: "首页",
        sourceDocumentIds: [
          TYPED_SOURCE_IDS.overview,
          TYPED_SOURCE_IDS.service,
          TYPED_SOURCE_IDS.faq,
        ],
      },
      {
        id: "services",
        slug: "/services",
        title: "服务",
        sourceDocumentIds: [TYPED_SOURCE_IDS.service],
      },
      {
        id: "faq",
        slug: "/faq",
        title: "常见问题",
        sourceDocumentIds: [TYPED_SOURCE_IDS.faq],
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
        statement: "提供设备运维与状态分析服务",
        sourceDocumentIds: [
          TYPED_SOURCE_IDS.overview,
          TYPED_SOURCE_IDS.service,
        ],
      },
    ],
    publicAssetIds: [],
    unknowns: ["当前知识库暂无可公开的企业动态"],
  };
  (input.designSpec as SiteDesignSpecV2).routeCompositions = [
    {
      routeId: "home",
      slots: [
        { slotId: "capabilities", variant: "cards" },
        { slotId: "faq-preview", variant: "faq" },
      ],
    },
    {
      routeId: "services",
      slots: [{ slotId: "service-grid", variant: "cards" }],
    },
    {
      routeId: "faq",
      slots: [{ slotId: "faq-list", variant: "faq" }],
    },
    {
      routeId: "news",
      slots: [{ slotId: "news-empty", variant: "statement" }],
    },
  ];
  input.generatedContent = {
    schemaVersion: 2,
    seo: (input.designSpec as SiteDesignSpecV2).seoPlan,
    routes: [
      {
        routeId: "home",
        eyebrow: "可靠的制造服务",
        heading: "让设备状态更清晰",
        summary: "展示知识库中已确认的设备运维与状态分析能力。",
        sections: [
          {
            slotId: "capabilities",
            blockType: "feature_list",
            heading: "服务能力",
            paragraphs: ["服务覆盖设备巡检、状态分析和维护建议。"],
            items: ["设备巡检", "状态分析", "维护建议"],
            entityIds: [],
            faqIds: [],
            sourceDocumentIds: [
              TYPED_SOURCE_IDS.overview,
              TYPED_SOURCE_IDS.service,
            ],
          },
          {
            slotId: "faq-preview",
            blockType: "faq_preview",
            heading: "常见问题",
            paragraphs: ["了解设备运维服务的已确认信息。"],
            items: [],
            entityIds: [],
            faqIds: ["faq-maintenance"],
            sourceDocumentIds: [TYPED_SOURCE_IDS.faq],
          },
        ],
      },
      {
        routeId: "services",
        heading: "设备服务",
        summary: "查看知识库中已确认的设备运维服务。",
        sections: [
          {
            slotId: "service-grid",
            blockType: "entity_grid",
            heading: "服务范围",
            paragraphs: ["服务覆盖设备巡检、状态分析和维护建议。"],
            items: [],
            entityIds: ["service-maintenance"],
            faqIds: [],
            sourceDocumentIds: [TYPED_SOURCE_IDS.service],
          },
        ],
      },
      {
        routeId: "faq",
        heading: "常见问题",
        summary: "查看常见的设备运维问答。",
        sections: [
          {
            slotId: "faq-list",
            blockType: "faq_preview",
            heading: "设备运维问答",
            paragraphs: ["以下为常见设备运维问题。"],
            items: [],
            entityIds: [],
            faqIds: ["faq-maintenance"],
            sourceDocumentIds: [TYPED_SOURCE_IDS.faq],
          },
        ],
      },
      {
        routeId: "news",
        heading: "企业动态",
        summary: "暂无企业动态。",
        emptyState: "company_news_unavailable",
        sections: [],
      },
    ],
    entities: [
      {
        entityId: "service-maintenance",
        entityType: "service",
        slug: "equipment-maintenance",
        title: "设备运维服务",
        summary: "覆盖设备巡检、状态分析和维护建议。",
        body: ["团队依据设备状态提供巡检、分析与维护建议。"],
        tags: ["设备巡检", "状态分析"],
        publishedAt: null,
        modifiedAt: null,
        author: null,
        sourceName: null,
        sourceUrl: null,
        sourceDocumentIds: [TYPED_SOURCE_IDS.service],
        relatedEntityIds: [],
      },
    ],
    faqs: [
      {
        faqId: "faq-maintenance",
        category: "设备运维",
        question: "设备运维服务包含哪些内容？",
        answers: ["服务覆盖设备巡检、状态分析和维护建议。"],
        sourceDocumentIds: [TYPED_SOURCE_IDS.faq],
      },
    ],
    officialLinks: [],
  };
  return input;
}

const HERO_FAMILY_TITLES = {
  floating_orbit: "floating orbit",
  feature_grid: "feature grid hero",
  bento: "bento modular hero",
  split_media: "split two column hero",
  editorial: "editorial magazine hero",
  centered_dual_cta: "quiet centered hero",
  immersive_visual: "immersive spatial hero",
  product_stage: "product stage showcase",
  proof_grid: "proof grid trust hero",
  full_bleed_statement: "full bleed fullscreen hero",
} as const;

type HeroFamily = keyof typeof HERO_FAMILY_TITLES;

function useHeroFamily(
  input: MaterializeAstroSiteInput,
  family: HeroFamily,
  index: number,
) {
  const visual = input.visual as SiteOpsRuntimeVisualEvidenceV2;
  const blueprint = referenceBlueprintForVisualCandidate({
    candidateId: `candidate-${index}`,
    providerItemKey:
      family === "floating_orbit" ? "n:8435" : `n:${9000 + index}`,
    previewSha256: visual.previewSha256,
    title: HERO_FAMILY_TITLES[family],
  });
  expect(blueprint.heroFamily).toBe(family);
  input.visual = {
    ...visual,
    selectedCandidateId: blueprint.candidateId,
    providerItemKey: blueprint.providerItemKey,
    referenceBlueprint: blueprint,
  };
  (input.designSpec as SiteDesignSpecV2).referenceBlueprint = blueprint;
}

function useV4HeroFamily(
  input: MaterializeAstroSiteInput,
  family: (typeof FRONTMIND_VISUAL_FAMILIES_V3)[number],
  index: number,
) {
  const visual = input.visual as SiteOpsRuntimeVisualEvidenceV2;
  const referenceSha256 = H(`21st-reference-${family}`);
  const realizationSha256 = H(`frontmind-realization-${family}`);
  const evidenceSha256 = H(`visual-evidence-${family}`);
  const blueprint = referenceBlueprintV4ForFamily({
    candidateId: `candidate-v4-${family}`,
    providerItemKey: `n:${10_000 + index}`,
    referencePreviewLocalAssetId: `00000000-0000-4000-8000-${String(100_000_000_000 + index).slice(-12)}`,
    referencePreviewSha256: referenceSha256,
    realizationPreviewLocalAssetId: `00000000-0000-4000-8000-${String(200_000_000_000 + index).slice(-12)}`,
    realizationPreviewSha256: realizationSha256,
    heroFamily: family,
    inspirationEvidenceId: evidenceSha256,
    inspirationTaxonomy: {
      role: "foundation",
      palette: [],
      typography: [],
      layout: [`${family}-layout`],
      motion: [],
      accessibility: ["reduced-motion"],
    },
  });
  input.visual = {
    ...visual,
    selectedCandidateId: blueprint.candidateId,
    providerItemKey: blueprint.providerItemKey,
    previewSha256: referenceSha256,
    visualEvidenceSha256: evidenceSha256,
    referenceBlueprint: blueprint,
  };
  (input.designSpec as SiteDesignSpecV2).referenceBlueprint = blueprint;
  return blueprint;
}

async function legacyAstroV1_6Source() {
  const input = buildInput();
  const visualV2 = input.visual as SiteOpsRuntimeVisualEvidenceV2;
  const {
    schemaVersion: _schemaVersion,
    referenceBlueprint: _blueprint,
    ...visual
  } = visualV2;
  const legacyDesign = {
    schemaVersion: 1 as const,
    layoutArchetype: "asymmetric" as const,
    heroVariant: "split_media" as const,
    density: "balanced" as const,
    surfaceStyle: "bordered" as const,
    typeScale: "display" as const,
    imageTreatment: "contained" as const,
    motionLevel: "subtle" as const,
    colorRoles: {
      backgroundPaletteIndex: 2,
      textPaletteIndex: 0,
      accentPaletteIndex: 1,
    },
    routeCompositions: (input.designSpec as SiteDesignSpecV2).routeCompositions,
    seoPlan: (input.designSpec as SiteDesignSpecV2).seoPlan,
  };
  const frozen = siteOpsFrozenRuntimeInputSchema.parse({
    schemaVersion: 2,
    build: {
      ...input.build,
      workflowUpstreamVersion: SITEOPS_MATERIALIZER_V1_6.upstreamVersion,
      workflowUpstreamHash: SITEOPS_MATERIALIZER_V1_6.upstreamSha256,
      workflowVersion: SITEOPS_MATERIALIZER_V1_6.frontMindVersion,
      workflowPackageHash: SITEOPS_MATERIALIZER_V1_6.runtimeManifestSha256,
      starterVersion: SITEOPS_MATERIALIZER_V1_6.starterVersion,
    },
    host: {
      starterSha256: SITEOPS_MATERIALIZER_V1_6.starterSha256,
      componentLibraryVersion:
        SITEOPS_MATERIALIZER_V1_6.componentLibraryVersion,
      materializerVersion: SITEOPS_MATERIALIZER_V1_6.materializerVersion,
      materializerSha256: SITEOPS_MATERIALIZER_V1_6.materializerSha256,
      // Historical bundles did not carry a renderer discriminator.
    },
    snapshot: {
      id: input.snapshot.id,
      userId: input.snapshot.userId,
      archiveHash: input.snapshot.archiveHash,
      sourceBuildId: input.snapshot.sourceBuildId,
      sourceBuildRevision: input.snapshot.sourceBuildRevision,
      sourceDocumentIds: input.snapshot.documents.map(
        (document) => document.id,
      ),
    },
    brief: input.brief,
    visual,
    designSpec: legacyDesign,
    generatedContent: input.generatedContent,
    assetDecisions: [],
    brandAsset: null,
  });
  const zip = new JSZip();
  zip.file("frontmind-runtime-input.json", `${JSON.stringify(frozen)}\n`);
  return zip.generateAsync({ type: "nodebuffer" });
}

async function legacyReactV2_0Source() {
  const input = buildInput();
  const frozen = siteOpsFrozenRuntimeInputSchema.parse({
    schemaVersion: 2,
    build: {
      ...input.build,
      workflowUpstreamVersion: SITEOPS_MATERIALIZER_V2_0.upstreamVersion,
      workflowUpstreamHash: SITEOPS_MATERIALIZER_V2_0.upstreamSha256,
      workflowVersion: SITEOPS_MATERIALIZER_V2_0.frontMindVersion,
      workflowPackageHash: SITEOPS_MATERIALIZER_V2_0.runtimeManifestSha256,
      starterVersion: SITEOPS_MATERIALIZER_V2_0.starterVersion,
    },
    host: {
      starterSha256: SITEOPS_MATERIALIZER_V2_0.starterSha256,
      componentLibraryVersion:
        SITEOPS_MATERIALIZER_V2_0.componentLibraryVersion,
      materializerVersion: SITEOPS_MATERIALIZER_V2_0.materializerVersion,
      materializerSha256: SITEOPS_MATERIALIZER_V2_0.materializerSha256,
      renderer: "react_static_v1",
    },
    snapshot: {
      id: input.snapshot.id,
      userId: input.snapshot.userId,
      archiveHash: input.snapshot.archiveHash,
      sourceBuildId: input.snapshot.sourceBuildId,
      sourceBuildRevision: input.snapshot.sourceBuildRevision,
      sourceDocumentIds: input.snapshot.documents.map(
        (document) => document.id,
      ),
    },
    brief: input.brief,
    visual: input.visual,
    designSpec: input.designSpec,
    generatedContent: input.generatedContent,
    assetDecisions: [],
    brandAsset: null,
  });
  const zip = new JSZip();
  zip.file("frontmind-runtime-input.json", `${JSON.stringify(frozen)}\n`);
  return zip.generateAsync({ type: "nodebuffer" });
}

async function legacyReactV2_2Source() {
  const input = buildInput();
  const visual = input.visual as SiteOpsRuntimeVisualEvidenceV2;
  const referenceBlueprint = referenceBlueprintV3ForFamily({
    candidateId: "60000000-0000-4000-8000-000000000006",
    providerItemKey: visual.providerItemKey,
    previewLocalAssetId: "80000000-0000-4000-8000-000000000008",
    previewSha256: visual.previewSha256,
    heroFamily: "floating_orbit",
    inspirationEvidenceIds: [visual.visualEvidenceSha256],
  });
  const frozen = siteOpsFrozenRuntimeInputSchema.parse({
    schemaVersion: 2,
    build: {
      ...input.build,
      workflowUpstreamVersion: SITEOPS_MATERIALIZER_V2_2.upstreamVersion,
      workflowUpstreamHash: SITEOPS_MATERIALIZER_V2_2.upstreamSha256,
      workflowVersion: SITEOPS_MATERIALIZER_V2_2.frontMindVersion,
      workflowPackageHash: SITEOPS_MATERIALIZER_V2_2.runtimeManifestSha256,
      starterVersion: SITEOPS_MATERIALIZER_V2_2.starterVersion,
    },
    host: {
      starterSha256: SITEOPS_MATERIALIZER_V2_2.starterSha256,
      componentLibraryVersion:
        SITEOPS_MATERIALIZER_V2_2.componentLibraryVersion,
      materializerVersion: SITEOPS_MATERIALIZER_V2_2.materializerVersion,
      materializerSha256: SITEOPS_MATERIALIZER_V2_2.materializerSha256,
      renderer: "react_static_v2",
    },
    snapshot: {
      id: input.snapshot.id,
      userId: input.snapshot.userId,
      archiveHash: input.snapshot.archiveHash,
      sourceBuildId: input.snapshot.sourceBuildId,
      sourceBuildRevision: input.snapshot.sourceBuildRevision,
      sourceDocumentIds: input.snapshot.documents.map(
        (document) => document.id,
      ),
    },
    brief: input.brief,
    visual: {
      ...visual,
      selectedCandidateId: referenceBlueprint.candidateId,
      referenceBlueprint,
    },
    designSpec: {
      ...(input.designSpec as SiteDesignSpecV2),
      referenceBlueprint,
    },
    generatedContent: input.generatedContent,
    assetDecisions: [],
    brandAsset: null,
  });
  const zip = new JSZip();
  zip.file("frontmind-runtime-input.json", `${JSON.stringify(frozen)}\n`);
  return zip.generateAsync({ type: "nodebuffer" });
}

async function legacyReactV2_3Source() {
  const input = buildInput();
  const frozen = siteOpsFrozenRuntimeInputSchema.parse({
    schemaVersion: 2,
    build: {
      ...input.build,
      workflowUpstreamVersion: SITEOPS_MATERIALIZER_V2_3.upstreamVersion,
      workflowUpstreamHash: SITEOPS_MATERIALIZER_V2_3.upstreamSha256,
      workflowVersion: SITEOPS_MATERIALIZER_V2_3.frontMindVersion,
      workflowPackageHash: SITEOPS_MATERIALIZER_V2_3.runtimeManifestSha256,
      starterVersion: SITEOPS_MATERIALIZER_V2_3.starterVersion,
    },
    host: {
      starterSha256: SITEOPS_MATERIALIZER_V2_3.starterSha256,
      componentLibraryVersion:
        SITEOPS_MATERIALIZER_V2_3.componentLibraryVersion,
      materializerVersion: SITEOPS_MATERIALIZER_V2_3.materializerVersion,
      materializerSha256: SITEOPS_MATERIALIZER_V2_3.materializerSha256,
      renderer: "react_static_v2",
    },
    snapshot: {
      id: input.snapshot.id,
      userId: input.snapshot.userId,
      archiveHash: input.snapshot.archiveHash,
      sourceBuildId: input.snapshot.sourceBuildId,
      sourceBuildRevision: input.snapshot.sourceBuildRevision,
      sourceDocumentIds: input.snapshot.documents.map(
        (document) => document.id,
      ),
    },
    brief: input.brief,
    visual: input.visual,
    designSpec: input.designSpec,
    generatedContent: input.generatedContent,
    assetDecisions: [],
    brandAsset: null,
  });
  const zip = new JSZip();
  zip.file("frontmind-runtime-input.json", `${JSON.stringify(frozen)}\n`);
  return zip.generateAsync({ type: "nodebuffer" });
}

async function legacyReactV2_4Source() {
  const input = buildInput();
  const frozen = siteOpsFrozenRuntimeInputSchema.parse({
    schemaVersion: 2,
    build: {
      ...input.build,
      workflowUpstreamVersion: SITEOPS_MATERIALIZER_V2_4_LEGACY.upstreamVersion,
      workflowUpstreamHash: SITEOPS_MATERIALIZER_V2_4_LEGACY.upstreamSha256,
      workflowVersion: SITEOPS_MATERIALIZER_V2_4_LEGACY.frontMindVersion,
      workflowPackageHash:
        SITEOPS_MATERIALIZER_V2_4_LEGACY.runtimeManifestSha256,
      starterVersion: SITEOPS_MATERIALIZER_V2_4_LEGACY.starterVersion,
    },
    host: {
      starterSha256: SITEOPS_MATERIALIZER_V2_4_LEGACY.starterSha256,
      componentLibraryVersion:
        SITEOPS_MATERIALIZER_V2_4_LEGACY.componentLibraryVersion,
      materializerVersion: SITEOPS_MATERIALIZER_V2_4_LEGACY.materializerVersion,
      materializerSha256: SITEOPS_MATERIALIZER_V2_4_LEGACY.materializerSha256,
      renderer: "react_static_v2",
    },
    snapshot: {
      id: input.snapshot.id,
      userId: input.snapshot.userId,
      archiveHash: input.snapshot.archiveHash,
      sourceBuildId: input.snapshot.sourceBuildId,
      sourceBuildRevision: input.snapshot.sourceBuildRevision,
      sourceDocumentIds: input.snapshot.documents.map(
        (document) => document.id,
      ),
    },
    brief: input.brief,
    visual: input.visual,
    designSpec: input.designSpec,
    generatedContent: input.generatedContent,
    assetDecisions: [],
    brandAsset: null,
  });
  const zip = new JSZip();
  zip.file("frontmind-runtime-input.json", `${JSON.stringify(frozen)}\n`);
  return zip.generateAsync({ type: "nodebuffer" });
}

describe("SiteOps trusted React 19 static runtime", () => {
  let previewBuild: Awaited<ReturnType<typeof materializeAstroSite>>;
  let officialLogo: Buffer;

  beforeAll(async () => {
    officialLogo = await sharp({
      create: {
        width: 160,
        height: 80,
        channels: 4,
        background: { r: 16, g: 72, b: 105, alpha: 1 },
      },
    })
      .png()
      .toBuffer();
    const input = buildInput();
    input.assetDecisions = [
      { id: "official-logo", sha256: H(officialLogo), decision: "publish" },
      {
        id: "private-evidence",
        sha256: H("private-evidence"),
        decision: "quarantine",
      },
    ];
    input.brandAsset = {
      schemaVersion: 1,
      assetId: "official-logo",
      sha256: H(officialLogo),
      mimeType: "image/png",
      publicPath: "public/brand-logo.png",
      sizeBytes: officialLogo.length,
      width: 160,
      height: 80,
      bytes: officialLogo,
    };
    previewBuild = await materializeAstroSite(input);
  }, 90_000);

  it("builds complete React static HTML and a private noindex preview without runtime JavaScript", async () => {
    const built = previewBuild;
    expect(browserQaMocks.browserLaunch).toHaveBeenCalledTimes(1);
    expect(browserQaMocks.axeAnalyze).toHaveBeenCalled();
    expect(browserQaMocks.lighthouse).toHaveBeenCalledTimes(1);
    expect(browserQaMocks.goto).toHaveBeenCalledWith(
      expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\//u),
      expect.objectContaining({ waitUntil: "networkidle" }),
    );
    expect(built.sourceSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(built.distSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(built.contract.specHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(JSON.parse(built.qaJson.toString("utf8"))).toMatchObject({
      passed: true,
      mode: "preview",
      browser: {
        axeViolationCount: 0,
        lighthouse: {
          performance: expect.any(Number),
          accessibility: expect.any(Number),
          bestPractices: expect.any(Number),
          seo: expect.any(Number),
          cls: expect.any(Number),
        },
      },
    });
    expect(built.visualQaSha256).toMatch(/^[a-f0-9]{64}$/u);
    const visualQa = await JSZip.loadAsync(built.visualQaZip, {
      checkCRC32: true,
    });
    expect(visualQa.file("visual-qa/report.json")).not.toBeNull();
    expect(visualQa.file("screenshots/home-390.png")).not.toBeNull();
    expect(visualQa.file("screenshots/home-768.png")).not.toBeNull();
    expect(visualQa.file("screenshots/home-1440.png")).not.toBeNull();

    const source = await JSZip.loadAsync(built.sourceZip, { checkCRC32: true });
    const sourceNames = Object.keys(source.files);
    expect(sourceNames).not.toContain("astro.config.mjs");
    expect(sourceNames).toContain("package-lock.json");
    expect(sourceNames).toContain("src/component-library.mjs");
    expect(sourceNames).toContain("src/render.mjs");
    expect(sourceNames).toContain("frontmind-runtime-lock.json");
    expect(sourceNames).toContain("frontmind-runtime-input.json");
    expect(sourceNames).toContain("build-contract.json");
    expect(sourceNames).toContain("frontmind-component-manifest.json");
    expect(sourceNames).toContain("public/brand-logo.png");
    expect(sourceNames).not.toContain("node_modules/");
    expect(
      (await source.file("public/brand-logo.png")!.async("nodebuffer")).equals(
        officialLogo,
      ),
    ).toBe(true);
    expect(
      JSON.parse(await source.file("build-contract.json")!.async("string")),
    ).toMatchObject({
      schemaVersion: 4,
      contractKind: "build_contract",
      renderer: {
        kind: "react_static_v2",
        reactVersion: "19.2.1",
        componentLibraryVersion: "2.6.0",
        materializerVersion: "2.6.0",
      },
      content: {
        schemaVersion: 2,
        routePolicyVersion: "snapshot-conditional-v1",
        sourcePolicy: "frozen_snapshot_only",
        externalAcquisitionAllowed: false,
        publicSourceLabels: "forbidden",
      },
      referenceBlueprint: {
        providerItemKey: "n:8435",
        heroFamily: "floating_orbit",
      },
      assets: [
        {
          id: "official-logo",
          sha256: H(officialLogo),
          decision: "publish",
        },
        { id: "private-evidence", decision: "quarantine" },
      ],
    });
    const sourcePackage = JSON.parse(
      await source.file("package.json")!.async("string"),
    );
    expect(sourcePackage).toMatchObject({
      scripts: { build: "node ./src/render.mjs" },
      dependencies: { react: "19.2.1", "react-dom": "19.2.1" },
    });
    const sourceLock = JSON.parse(
      await source.file("package-lock.json")!.async("string"),
    );
    expect(sourceLock).toMatchObject({
      lockfileVersion: 3,
      packages: {
        "node_modules/react": { version: "19.2.1" },
        "node_modules/react-dom": { version: "19.2.1" },
        "node_modules/scheduler": { version: "0.27.0" },
      },
    });
    const componentCss = await source
      .file("public/styles.css")!
      .async("string");
    expect(componentCss).toContain(
      ".hero-orbit-stage{position:relative;min-height:",
    );
    expect(componentCss).toContain(".orbit-motif{position:absolute");
    expect(componentCss).toContain(
      ".container--contained .hero--floating_orbit .hero-orbit-stage",
    );
    expect(componentCss).toContain(
      ".media-strategy--procedural_brand_svg .orbit-motif",
    );
    expect(componentCss).toContain(".contact .eyebrow{color:var(--canvas)}");
    expect(componentCss).toContain(
      "@media(prefers-reduced-motion:reduce){.orbit-motif{animation:none!important}}",
    );

    const dist = await JSZip.loadAsync(built.distZip, { checkCRC32: true });
    const home = await dist.file("index.html")!.async("string");
    expect(home).toContain("让设备状态更清晰");
    expect(home).toContain(
      'class="hero hero--floating_orbit" data-hero-family="floating_orbit"',
    );
    expect(home).toContain('data-motif="dna"');
    expect(home).toContain('data-motif="molecule"');
    expect(home).toContain('data-motif="cell"');
    expect(home).toContain('data-motif="timeline"');
    expect(home).toContain(
      'class="section section--proof" data-slot="service-proof"',
    );
    expect(home).toContain(
      'class="section section--split" data-slot="audience"',
    );
    expect(home).toContain(
      "layout--asymmetric surface--bordered type--display image--contained motion--subtle align--center",
    );
    expect(home).toContain("media-strategy--procedural_brand_svg");
    expect(home).toContain("container--contained");
    expect(home).toContain('class="brand-logo"');
    expect(home).toContain('src="/brand-logo.png"');
    expect(
      (await dist.file("brand-logo.png")!.async("nodebuffer")).equals(
        officialLogo,
      ),
    ).toBe(true);
    expect(home).toContain('name="robots" content="noindex,nofollow"');
    expect(home).not.toContain('rel="canonical"');
    expect(home).not.toMatch(/<script\b/iu);
    expect(home).not.toMatch(/<div\s+id=["']root["'][^>]*>\s*<\/div>/iu);
    expect(home).not.toContain("知识来源");
    expect(home).not.toContain("内容依据已确认");
    expect(home).not.toContain("source-note");
    expect(Object.keys(dist.files)).not.toContain(
      expect.stringMatching(/\.(?:m?js)$/u),
    );
    expect(await dist.file("robots.txt")!.async("string")).toContain(
      "Disallow: /",
    );
    expect(dist.file("sitemap.xml")).toBeNull();
    expect(dist.file("llms.txt")).toBeNull();
  }, 90_000);

  it("renders ten allowlisted Hero families as distinct server-rendered DOM", async () => {
    const selectors: Record<HeroFamily, string> = {
      floating_orbit: 'class="shell hero-orbit-stage"',
      feature_grid: 'class="hero-feature-grid"',
      bento: 'class="shell hero-bento"',
      split_media: 'class="shell hero-split"',
      editorial: 'class="shell hero-editorial"',
      centered_dual_cta: 'class="shell hero-centered"',
      immersive_visual: 'class="hero-immersive__field"',
      product_stage: 'class="product-stage"',
      proof_grid: 'class="hero-proof__grid"',
      full_bleed_statement: 'class="hero-statement__rail"',
    };
    for (const [index, family] of Object.keys(HERO_FAMILY_TITLES).entries()) {
      const typedFamily = family as HeroFamily;
      const input = buildInput();
      useHeroFamily(input, typedFamily, index + 1);
      const built = await materializeAstroSite(input);
      const home = built.files.get("index.html")!.toString("utf8");
      expect(home).toContain(`data-hero-family="${typedFamily}"`);
      expect(home).toContain(selectors[typedFamily]);
      expect(home).toMatch(/^<!doctype html><html\b/u);
      expect(home).toContain("<head>");
      expect(home).toContain("<body");
      expect(home).toContain("<main>");
      expect(home).toContain("<footer");
    }
  }, 90_000);

  it("materializes all nine V4 candidate blueprints into matching formal source and dist", async () => {
    const visualLanguages: Record<
      (typeof FRONTMIND_VISUAL_FAMILIES_V3)[number],
      string
    > = {
      floating_orbit: "aurora-orbit",
      split_media: "atelier-editorial",
      editorial: "swiss-evidence",
      bento: "organic-human",
      feature_grid: "chrome-product",
      centered_dual_cta: "eastern-minimal",
      immersive_visual: "electric-brutalist",
      product_stage: "nocturne-luxury",
      full_bleed_statement: "neural-glass",
    };
    const renderedLanguages = new Set<string>();
    for (const [index, family] of FRONTMIND_VISUAL_FAMILIES_V3.entries()) {
      const input = buildInput();
      const blueprint = useV4HeroFamily(input, family, index + 1);
      const built = await materializeAstroSite(input);
      const source = await JSZip.loadAsync(built.sourceZip, {
        checkCRC32: true,
      });
      const manifest = JSON.parse(
        await source.file("frontmind-component-manifest.json")!.async("string"),
      );
      const page = JSON.parse(
        await source.file("src/data/route-001.json")!.async("string"),
      );
      const styles = await source.file("public/styles.css")!.async("string");
      const home = built.files.get("index.html")!.toString("utf8");
      const language = visualLanguages[family];

      expect(manifest).toMatchObject({
        componentLibraryVersion: "2.6.0",
        materializerVersion: "2.6.0",
        heroFamily: family,
        referenceBlueprint: {
          schemaVersion: 4,
          heroFamily: family,
          blueprintHash: blueprint.blueprintHash,
          styleSignature: blueprint.styleSignature,
        },
      });
      expect(page.visualContract).toMatchObject({
        schemaVersion: 4,
        heroFamily: family,
        blueprintHash: blueprint.blueprintHash,
        styleSignature: blueprint.styleSignature,
        alignment: blueprint.alignment,
        backgroundStyle: blueprint.backgroundStyle,
        gradientStyle: blueprint.gradientStyle,
        navStyle: blueprint.navStyle,
        ctaStyle: blueprint.ctaStyle,
        cardStyle: blueprint.cardStyle,
        typographyStyle: blueprint.typographyStyle,
        responsiveBehavior: blueprint.responsiveBehavior,
      });
      expect(home).toContain(`data-hero-family="${family}"`);
      expect(home).toContain(`data-visual-language="${language}"`);
      expect(home).toContain(
        `data-visual-blueprint="${blueprint.blueprintHash}"`,
      );
      expect(home).toContain(
        `data-visual-style-signature="${blueprint.styleSignature}"`,
      );
      expect(home).not.toMatch(/FrontMind|21st/iu);
      for (const coordinateClass of [
        `align--${blueprint.alignment}`,
        `background--${blueprint.backgroundStyle}`,
        `gradient--${blueprint.gradientStyle}`,
        `nav-style--${blueprint.navStyle}`,
        `cta-style--${blueprint.ctaStyle}`,
        `card-style--${blueprint.cardStyle}`,
        `typography--${blueprint.typographyStyle}`,
        `responsive--${blueprint.responsiveBehavior}`,
      ]) {
        expect(home).toContain(coordinateClass);
      }
      expect(styles).toContain(".preview-contract--v4.nav-style--floating");
      expect(styles).toContain(".preview-contract--v4.card-style--layered");
      expect(styles).toContain("body.preview-contract--v4 .hero{height:auto");
      expect(built.contract).toMatchObject({
        schemaVersion: 4,
        renderer: {
          componentLibraryVersion: "2.6.0",
          materializerVersion: "2.6.0",
        },
        referenceBlueprint: {
          heroFamily: family,
          blueprintHash: blueprint.blueprintHash,
          styleSignature: blueprint.styleSignature,
        },
      });
      renderedLanguages.add(language);
    }
    expect(renderedLanguages.size).toBe(9);
  }, 90_000);

  it("renders all seven section variants with differentiated semantic DOM", async () => {
    const input = buildInput();
    const variants = [
      "statement",
      "split",
      "cards",
      "timeline",
      "faq",
      "proof",
      "cta",
    ] as const;
    const design = input.designSpec as SiteDesignSpecV2;
    design.routeCompositions[0]!.slots = variants.map((variant, index) => ({
      slotId: `section-${index + 1}`,
      variant,
    }));
    const content = input.generatedContent as any;
    content.routes[0].sections = variants.map((variant, index) => ({
      slotId: `section-${index + 1}`,
      heading: `${variant} 结构`,
      paragraphs: [`${variant} 第一段`, `${variant} 第二段`],
      sourceDocumentIds: [index % 2 === 0 ? "overview" : "service"],
    }));
    const built = await materializeAstroSite(input);
    const home = built.files.get("index.html")!.toString("utf8");
    expect(home).toContain('<section class="section section--statement"');
    expect(home).toContain("<blockquote>");
    expect(home).toContain('class="section-split__header"');
    expect(home).toContain('class="mini-card-grid"');
    expect(home).toContain('<ol class="timeline-list">');
    expect(home).toContain('<section class="section section--faq"');
    expect(home).toContain("<dl>");
    expect(home).toContain('<section class="section section--proof"');
    expect(home).toContain("<figure>");
    expect(home).toContain('class="button button--inverse"');
  }, 90_000);

  it("allows a duplicate official-logo SHA only when the alias is omitted", async () => {
    const input = buildInput();
    const logoSha256 = H(officialLogo);
    input.assetDecisions = [
      { id: "official-logo", sha256: logoSha256, decision: "publish" },
      { id: "official-logo-alias", sha256: logoSha256, decision: "omit" },
    ];
    input.brandAsset = {
      schemaVersion: 1,
      assetId: "official-logo",
      sha256: logoSha256,
      mimeType: "image/png",
      publicPath: "public/brand-logo.png",
      sizeBytes: officialLogo.length,
      width: 160,
      height: 80,
      bytes: officialLogo,
    };

    const built = await materializeAstroSite(input);
    expect(built.contract.assets).toEqual([
      { id: "official-logo", sha256: logoSha256, decision: "publish" },
      { id: "official-logo-alias", sha256: logoSha256, decision: "omit" },
    ]);
  }, 90_000);

  it("rejects publish and quarantine decisions for the same physical bytes at asset projection", async () => {
    const input = buildInput();
    const logoSha256 = H(officialLogo);
    input.assetDecisions = [
      { id: "official-logo", sha256: logoSha256, decision: "publish" },
      {
        id: "official-logo-conflict",
        sha256: logoSha256,
        decision: "quarantine",
      },
    ];
    input.brandAsset = {
      schemaVersion: 1,
      assetId: "official-logo",
      sha256: logoSha256,
      mimeType: "image/png",
      publicPath: "public/brand-logo.png",
      sizeBytes: officialLogo.length,
      width: 160,
      height: 80,
      bytes: officialLogo,
    };

    await expect(materializeAstroSite(input)).rejects.toMatchObject({
      name: "SiteOpsMaterializationError",
      phase: "asset_projection",
      code: "SITEOPS_ASSET_DECISION_HASH_CONFLICT",
      retryClass: "host_deterministic",
      safeDetails: {
        assetDecisionCount: 2,
        publishedCount: 1,
        omittedDuplicateCount: 0,
        quarantineCount: 1,
      },
    });
  });

  it("keeps all provider/customer text in JSON data and renders syntax sentinels as inert text", async () => {
    const sentinels = [
      "{A}",
      "{{x}}",
      "${process.env.SECRET}",
      "孤立 { 和 }",
      "`反引号` ---",
      "<script>alert(1)</script>",
      "</section><img src=x onerror=alert(1)>",
      '\"><script>alert(2)</script>',
    ];
    const payload = sentinels.join(" | ");
    const sourceId = `source-${payload}`;
    const input = buildInput();
    input.snapshot.documents[1]!.id = sourceId;
    (input.brief as any).contacts = [
      {
        kind: "address",
        value: payload,
        sourceDocumentIds: ["overview"],
      },
    ];
    (input.brief as any).routes[0].sourceDocumentIds = ["overview", sourceId];
    (input.brief as any).routes[1].sourceDocumentIds = [sourceId];
    (input.brief as any).verifiedFacts[0].sourceDocumentIds = [
      "overview",
      sourceId,
    ];
    (input.generatedContent as any).routes[0].heading = payload;
    (input.generatedContent as any).routes[0].summary = payload;
    (input.generatedContent as any).routes[0].sections[0].heading = payload;
    (input.generatedContent as any).routes[0].sections[0].paragraphs = [
      payload,
    ];
    (input.generatedContent as any).routes[0].sections[0].sourceDocumentIds = [
      sourceId,
    ];
    (input.generatedContent as any).routes[1].sections[0].sourceDocumentIds = [
      sourceId,
    ];

    const built = await materializeAstroSite(input);
    const source = await JSZip.loadAsync(built.sourceZip, { checkCRC32: true });
    const trustedModules = await Promise.all(
      Object.values(source.files)
        .filter((entry) => !entry.dir && entry.name.endsWith(".mjs"))
        .map((entry) => entry.async("string")),
    );
    for (const sentinel of sentinels) {
      expect(trustedModules.join("\n")).not.toContain(sentinel);
    }
    const dataFiles = await Promise.all(
      Object.values(source.files)
        .filter(
          (entry) =>
            !entry.dir &&
            entry.name.startsWith("src/data/") &&
            entry.name.endsWith(".json"),
        )
        .map((entry) => entry.async("string")),
    );
    for (const sentinel of sentinels) {
      expect(dataFiles.join("\n")).toContain(sentinel);
    }
    const dist = await JSZip.loadAsync(built.distZip, { checkCRC32: true });
    const home = await dist.file("index.html")!.async("string");
    const body = home.slice(home.indexOf("<body"));
    expect(body).toContain("{A}");
    expect(body).toContain("{{x}}");
    expect(body).toContain("${process.env.SECRET}");
    expect(body).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(body).not.toContain("<script>alert(1)</script>");
    expect(body).not.toContain("<script>alert(2)</script>");
    expect(body).not.toContain("<img src=x onerror=alert(1)>");
  }, 90_000);

  it("materializes semantic colors that satisfy every text/background contrast contract", async () => {
    const input = buildInput();
    (input.visual as any).taxonomy.palette = [
      "#FFFFFF",
      "#111111",
      "#0066CC",
      "#888888",
    ];
    (input.designSpec as any).colorRoles = {
      backgroundPaletteIndex: 0,
      textPaletteIndex: 1,
      accentPaletteIndex: 2,
    };
    (input.designSpec as any).surfaceStyle = "layered";
    (input.designSpec as any).routeCompositions[0].slots[0].variant = "cta";
    const built = await materializeAstroSite(input);
    const source = await JSZip.loadAsync(built.sourceZip, { checkCRC32: true });
    const css = await source.file("public/styles.css")!.async("string");
    const variables = Object.fromEntries(
      [...css.matchAll(/--(ink|accent|canvas|muted):(#[A-Fa-f0-9]{6})/gu)].map(
        (match) => [match[1], match[2]],
      ),
    ) as Record<"ink" | "accent" | "canvas" | "muted", string>;
    expect(ratio(variables.ink, variables.canvas)).toBeGreaterThanOrEqual(7);
    expect(ratio(variables.accent, variables.canvas)).toBeGreaterThanOrEqual(
      4.5,
    );
    expect(ratio(variables.ink, variables.muted)).toBeGreaterThanOrEqual(4.5);
    expect(ratio(variables.accent, variables.muted)).toBeGreaterThanOrEqual(
      4.5,
    );
    expect(css).toContain(
      ".surface--soft_depth .section{background:var(--muted)",
    );
    expect(css).toContain(".source-note{color:var(--ink)");
    expect(css).toContain(
      ".section--cta .source-note,.section--cta .section-index{color:var(--inverse-text)}",
    );
    const semanticVariables = Object.fromEntries(
      [
        ...css.matchAll(
          /--(accent-text|inverse-surface|inverse-text|border|focus):(#[A-Fa-f0-9]{6})/gu,
        ),
      ].map((match) => [match[1], match[2]]),
    ) as Record<string, string>;
    expect(
      ratio(semanticVariables["accent-text"]!, variables.accent),
    ).toBeGreaterThanOrEqual(4.5);
    expect(
      ratio(
        semanticVariables["inverse-text"]!,
        semanticVariables["inverse-surface"]!,
      ),
    ).toBeGreaterThanOrEqual(4.5);
    expect(
      ratio(semanticVariables.focus!, variables.canvas),
    ).toBeGreaterThanOrEqual(3);
    expect(css).not.toMatch(/\.source-note\{[^}]*opacity/gu);
  }, 90_000);

  it("keeps the private preview when the browser QA runtime is unavailable", async () => {
    browserQaMocks.browserLaunch.mockRejectedValueOnce(
      new Error("TEST_BROWSER_QA_UNAVAILABLE"),
    );
    const built = await materializeAstroSite(buildInput());
    const qa = JSON.parse(built.qaJson.toString("utf8"));
    expect(built.buildDelivery).toEqual({
      renderMode: "primary",
      qaStatus: "partial",
      warningCodes: ["SITEOPS_BROWSER_QA_RUNTIME_UNAVAILABLE"],
    });
    expect(qa).toMatchObject({
      passed: true,
      browser: { available: false, axeViolationCount: 0 },
      buildDelivery: built.buildDelivery,
      warnings: [
        {
          phase: "browser_qa",
          code: "SITEOPS_BROWSER_QA_RUNTIME_UNAVAILABLE",
          checkId: "browser-qa:runtime",
        },
      ],
    });
    expect(built.files.get("index.html")?.toString("utf8")).toContain(
      "星河智造",
    );
  }, 90_000);

  it("preserves content-patch provenance through the trusted local renderer", async () => {
    const input = buildInput();
    input.renderModeOverride = "content_patch";
    const built = await materializeAstroSite(input);
    expect(built.buildDelivery).toEqual({
      renderMode: "content_patch",
      qaStatus: "passed",
      warningCodes: [],
    });
    expect(JSON.parse(built.qaJson.toString("utf8"))).toMatchObject({
      passed: true,
      buildDelivery: built.buildDelivery,
    });
    expect(built.files.get("index.html")?.toString("utf8")).toContain(
      "星河智造",
    );
  }, 90_000);

  it("persists partial content-patch defaults and restores their delivery on production rebuild", async () => {
    const input = buildInput();
    input.renderModeOverride = "content_patch";
    input.contentPatchUsesTrustedDefaults = true;
    const built = await materializeAstroSite(input);
    expect(built.buildDelivery).toEqual({
      renderMode: "content_patch",
      qaStatus: "passed_with_warnings",
      warningCodes: [SITEOPS_CONTENT_PATCH_PARTIAL_DEFAULTS_WARNING_CODE],
    });

    const source = await JSZip.loadAsync(built.sourceZip, {
      checkCRC32: true,
    });
    const frozen = JSON.parse(
      await source.file("frontmind-runtime-input.json")!.async("string"),
    );
    expect(frozen).toMatchObject({
      renderMode: "content_patch",
      contentPatchUsesTrustedDefaults: true,
    });
    const previewProvenance = JSON.parse(built.provenanceJson.toString("utf8"));
    expect(previewProvenance.buildDelivery).toEqual(built.buildDelivery);

    const production = await materializeProductionSiteFromSource({
      sourceZip: built.sourceZip,
      expectedSourceSha256: built.sourceSha256,
      canonicalOrigin: "https://content-patch.xinghe.example",
      target: "global_excluding_cn",
    });
    expect(production.buildDelivery).toEqual(built.buildDelivery);
    expect(
      JSON.parse(production.provenanceJson.toString("utf8")).buildDelivery,
    ).toEqual(built.buildDelivery);
  }, 90_000);

  it("reports production-shaped Axe contrast findings without discarding the preview", async () => {
    browserQaMocks.axeAnalyze.mockResolvedValueOnce({
      violations: [{ id: "color-contrast", impact: "serious" }],
    });
    const built = await materializeAstroSite(buildInput());
    const qa = JSON.parse(built.qaJson.toString("utf8"));
    expect(built.buildDelivery).toEqual({
      renderMode: "primary",
      qaStatus: "passed_with_warnings",
      warningCodes: ["SITEOPS_AXE_BLOCKING_VIOLATIONS"],
    });
    expect(qa.browser).toMatchObject({
      available: true,
      axeViolationCount: 1,
      axeViolationIds: ["color-contrast"],
    });
    expect(qa.warnings).toContainEqual({
      phase: "browser_qa",
      code: "SITEOPS_AXE_BLOCKING_VIOLATIONS",
      checkId: "axe:color-contrast",
    });
    expect(built.files.has("index.html")).toBe(true);
  }, 90_000);

  it("reports Lighthouse and CLS thresholds as non-blocking warnings", async () => {
    browserQaMocks.lighthouse.mockResolvedValueOnce({
      lhr: {
        categories: {
          performance: { score: 0.8 },
          accessibility: { score: 0.94 },
          "best-practices": { score: 0.89 },
          seo: { score: 0.94 },
        },
        audits: {
          "cumulative-layout-shift": { numericValue: 0.12, score: 0.5 },
        },
      },
    });
    const built = await materializeAstroSite(buildInput());
    const qa = JSON.parse(built.qaJson.toString("utf8"));
    expect(built.buildDelivery.qaStatus).toBe("passed_with_warnings");
    expect(built.buildDelivery.warningCodes).toEqual([
      "SITEOPS_LIGHTHOUSE_THRESHOLD_FAILED",
    ]);
    expect(qa.browser.lighthouse).toMatchObject({
      performance: 80,
      accessibility: 94,
      bestPractices: 89,
      seo: 94,
      cls: 0.12,
    });
    expect(qa.warnings).toContainEqual({
      phase: "lighthouse",
      code: "SITEOPS_LIGHTHOUSE_THRESHOLD_FAILED",
      checkId: "lighthouse:threshold",
    });
    expect(built.files.has("index.html")).toBe(true);
  }, 90_000);

  it("uses the trusted no-JavaScript fallback when the primary React renderer fails", async () => {
    buildProcessMocks.failNextReactBuild = true;
    const built = await materializeAstroSite(buildInput());
    expect(built.buildDelivery).toEqual({
      renderMode: "trusted_fallback",
      qaStatus: "partial",
      warningCodes: ["SITEOPS_REACT_STATIC_BUILD_FAILED"],
    });
    const source = await JSZip.loadAsync(built.sourceZip, { checkCRC32: true });
    expect(source.file("frontmind-trusted-fallback.json")).not.toBeNull();
    const dist = await JSZip.loadAsync(built.distZip, { checkCRC32: true });
    const home = await dist.file("index.html")!.async("string");
    expect(home).toContain("星河智造");
    expect(home).toContain('data-hero-family="floating_orbit"');
    expect(home).not.toContain("<script");
    expect(Object.keys(dist.files).some((name) => /\.m?js$/u.test(name))).toBe(
      false,
    );
    expect(JSON.parse(built.qaJson.toString("utf8"))).toMatchObject({
      passed: true,
      buildDelivery: built.buildDelivery,
      warnings: [
        {
          phase: "react_static_build",
          code: "SITEOPS_REACT_STATIC_BUILD_FAILED",
          checkId: "primary-render:fallback",
        },
      ],
    });
  }, 90_000);

  it("materializes a native 2.5 fallback with a legacy empty taxonomy palette", async () => {
    const input = buildInput();
    const heroFamily = "centered_dual_cta" as const;
    useV4HeroFamily(input, heroFamily, 9);
    Object.assign(input.build, {
      workflowUpstreamVersion: SITEOPS_MATERIALIZER_V2_5.upstreamVersion,
      workflowUpstreamHash: SITEOPS_MATERIALIZER_V2_5.upstreamSha256,
      workflowVersion: SITEOPS_MATERIALIZER_V2_5.frontMindVersion,
      workflowPackageHash: SITEOPS_MATERIALIZER_V2_5.runtimeManifestSha256,
      starterVersion: SITEOPS_MATERIALIZER_V2_5.starterVersion,
    });
    input.visual.taxonomy.palette = [];
    input.designSpec.colorRoles = {
      backgroundPaletteIndex: 0,
      textPaletteIndex: 0,
      accentPaletteIndex: 0,
    };

    const built = await materializeNativeTrustedFallbackSite({
      ...input,
      warningCode: "NATIVE_PROVIDER_SYNC_TRUSTED_FALLBACK",
    });

    expect(built.buildDelivery).toEqual({
      renderMode: "trusted_fallback",
      qaStatus: "partial",
      warningCodes: ["NATIVE_PROVIDER_SYNC_TRUSTED_FALLBACK"],
    });
    const source = await JSZip.loadAsync(built.sourceZip, { checkCRC32: true });
    expect(source.file("frontmind-runtime-input.json")).not.toBeNull();
    expect(source.file("frontmind-trusted-fallback.json")).not.toBeNull();
    expect(
      Object.keys(source.files).some((name) =>
        /selected-21st|native-source/iu.test(name),
      ),
    ).toBe(false);
    const dist = await JSZip.loadAsync(built.distZip, { checkCRC32: true });
    expect(await dist.file("index.html")!.async("string")).toContain(
      "星河智造",
    );
    expect(Object.keys(dist.files).some((name) => /\.m?js$/u.test(name))).toBe(
      false,
    );
  }, 90_000);

  it("emits exact production discovery metadata without false hreflang", async () => {
    const built = await materializeProductionSiteFromSource({
      sourceZip: previewBuild.sourceZip,
      expectedSourceSha256: previewBuild.sourceSha256,
      canonicalOrigin: "https://www.xinghe.example",
      target: "global_excluding_cn",
    });
    const dist = await JSZip.loadAsync(built.distZip, { checkCRC32: true });
    const home = await dist.file("index.html")!.async("string");
    const services = await dist.file("services/index.html")!.async("string");
    expect(home).toContain(
      'rel="canonical" href="https://www.xinghe.example/"',
    );
    expect(services).toContain(
      'rel="canonical" href="https://www.xinghe.example/services/"',
    );
    expect(home).toContain('type="application/ld+json"');
    expect(home).toContain(
      "\\u2028\\u003c/script>\\u003cimg onerror=alert(1)>",
    );
    expect(home).not.toContain("</script><img onerror=alert(1)>");
    expect(home).not.toContain("\u2028");
    expect(home).not.toContain("hreflang=");
    expect(await dist.file("sitemap.xml")!.async("string")).toContain(
      "https://www.xinghe.example/services/",
    );
    expect(await dist.file("llms.txt")!.async("string")).toContain("星河智造");
    expect(
      (await dist.file("brand-logo.png")!.async("nodebuffer")).equals(
        officialLogo,
      ),
    ).toBe(true);
  }, 90_000);

  it("materializes current typed content while keeping empty news and source coordinates out of discovery", async () => {
    const preview = await materializeAstroSite(typedContentInput());
    expect(preview.contract).toMatchObject({
      schemaVersion: 4,
      renderer: {
        kind: "react_static_v2",
        componentLibraryVersion: "2.6.0",
        materializerVersion: "2.6.0",
      },
      content: {
        schemaVersion: 2,
        routePolicyVersion: "snapshot-conditional-v1",
        sourcePolicy: "frozen_snapshot_only",
        externalAcquisitionAllowed: false,
        publicSourceLabels: "forbidden",
      },
      contentSpecHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
    const previewHome = preview.files.get("index.html")!.toString("utf8");
    const previewServices = preview.files
      .get("services/index.html")!
      .toString("utf8");
    const previewNews = preview.files.get("news/index.html")!.toString("utf8");
    expect(previewHome).toContain('data-block-type="feature_list"');
    expect(previewHome).toContain('data-block-type="faq_preview"');
    expect(previewServices).toContain(
      'href="/services/equipment-maintenance/"',
    );
    expect(preview.files.has("services/equipment-maintenance/index.html")).toBe(
      true,
    );
    expect(previewNews).toContain("新的企业动态将在这里发布");
    expect(previewNews).toContain('data-content-state="empty"');
    expect(previewNews).not.toContain("<button");
    expect(previewNews).not.toContain('type="application/ld+json"');
    expect(preview.files.has("sitemap.xml")).toBe(false);
    expect(preview.files.has("llms.txt")).toBe(false);

    const production = await materializeProductionSiteFromSource({
      sourceZip: preview.sourceZip,
      expectedSourceSha256: preview.sourceSha256,
      canonicalOrigin: "https://typed.xinghe.example",
      target: "global_excluding_cn",
    });
    const productionDist = await JSZip.loadAsync(production.distZip, {
      checkCRC32: true,
    });
    const sitemap = await productionDist.file("sitemap.xml")!.async("string");
    const llms = await productionDist.file("llms.txt")!.async("string");
    const productionNews = await productionDist
      .file("news/index.html")!
      .async("string");
    const faq = await productionDist.file("faq/index.html")!.async("string");
    const entity = await productionDist
      .file("services/equipment-maintenance/index.html")!
      .async("string");
    expect(productionNews).toContain(
      'rel="canonical" href="https://typed.xinghe.example/news/"',
    );
    expect(productionNews).not.toContain('type="application/ld+json"');
    expect(sitemap).not.toContain("https://typed.xinghe.example/news/");
    expect(llms).not.toContain("https://typed.xinghe.example/news/");
    expect(sitemap).toContain(
      "https://typed.xinghe.example/services/equipment-maintenance/",
    );
    expect(llms).toContain(
      "https://typed.xinghe.example/services/equipment-maintenance/",
    );
    expect(faq).toContain('"@type":"FAQPage"');
    expect(entity).toContain('"@type":"Service"');

    for (const [name, file] of Object.entries(productionDist.files)) {
      if (!/\.(?:html|xml|txt)$/u.test(name)) continue;
      const publiclyEmitted = await file.async("string");
      expect(publiclyEmitted).not.toMatch(
        /(?:sourceDocumentIds|source_document_ids|内部来源|来源文档\s*(?:ID|编号)|知识来源|内容依据已确认|当前知识库|冻结知识库)/iu,
      );
      for (const poisonId of Object.values(TYPED_SOURCE_IDS)) {
        expect(publiclyEmitted).not.toContain(poisonId);
      }
    }
  }, 90_000);

  it("keeps historical 1.6 source bundles on the read-only Astro replay path", async () => {
    const sourceZip = await legacyAstroV1_6Source();
    const rebuilt = await materializeProductionSiteFromSource({
      sourceZip,
      expectedSourceSha256: H(sourceZip),
      canonicalOrigin: "https://legacy.xinghe.example",
      target: "global_excluding_cn",
    });
    const source = await JSZip.loadAsync(rebuilt.sourceZip, {
      checkCRC32: true,
    });
    expect(source.file("astro.config.mjs")).not.toBeNull();
    expect(source.file("src/layouts/SiteLayout.astro")).not.toBeNull();
    expect(source.file("src/render.mjs")).toBeNull();
    const contract = JSON.parse(rebuilt.contractJson.toString("utf8"));
    expect(contract.schemaVersion).toBe(2);
    const dist = await JSZip.loadAsync(rebuilt.distZip, { checkCRC32: true });
    expect(await dist.file("index.html")!.async("string")).toContain(
      'rel="canonical" href="https://legacy.xinghe.example/"',
    );
  }, 90_000);

  it("keeps historical 2.0 source bundles on their frozen React coordinates", async () => {
    const sourceZip = await legacyReactV2_0Source();
    const rebuilt = await materializeProductionSiteFromSource({
      sourceZip,
      expectedSourceSha256: H(sourceZip),
      canonicalOrigin: "https://react20.xinghe.example",
      target: "global_excluding_cn",
    });
    const contract = JSON.parse(rebuilt.contractJson.toString("utf8"));
    expect(contract).toMatchObject({
      schemaVersion: 3,
      workflow: {
        version: "2.0.0",
        componentLibraryVersion: "2.0.0",
        materializerVersion: "2.0.0",
      },
      renderer: {
        kind: "react_static_v1",
        componentLibraryVersion: "2.0.0",
        materializerVersion: "2.0.0",
      },
    });
    const dist = await JSZip.loadAsync(rebuilt.distZip, { checkCRC32: true });
    expect(await dist.file("index.html")!.async("string")).toContain(
      'rel="canonical" href="https://react20.xinghe.example/"',
    );
  }, 90_000);

  it("keeps historical 2.2 production source bundles on exact 2.2 coordinates", async () => {
    const sourceZip = await legacyReactV2_2Source();
    const rebuilt = await materializeProductionSiteFromSource({
      sourceZip,
      expectedSourceSha256: H(sourceZip),
      canonicalOrigin: "https://react22.xinghe.example",
      target: "global_excluding_cn",
    });
    const contract = JSON.parse(rebuilt.contractJson.toString("utf8"));
    expect(contract).toMatchObject({
      schemaVersion: 4,
      workflow: {
        version: "2.2.0",
        componentLibraryVersion: "2.2.0",
        materializerVersion: "2.2.0",
      },
      renderer: {
        kind: "react_static_v2",
        componentLibraryVersion: "2.2.0",
        materializerVersion: "2.2.0",
      },
    });
    const source = await JSZip.loadAsync(rebuilt.sourceZip, {
      checkCRC32: true,
    });
    const frozen = JSON.parse(
      await source.file("frontmind-runtime-input.json")!.async("string"),
    );
    expect(frozen).toMatchObject({
      build: { workflowVersion: "2.2.0" },
      host: {
        componentLibraryVersion: "2.2.0",
        materializerVersion: "2.2.0",
      },
    });
    const frozenComponentSource = await source
      .file("src/component-library.mjs")!
      .async("string");
    expect(H(frozenComponentSource)).toBe(
      "b5778f2a5042f474e1ae649eb977358a91602185dc0d360daa3e630b33d5915f",
    );
    expect(frozenComponentSource).not.toContain("V4SiteHero");
    expect(
      await source.file("src/data/route-001.json")!.async("string"),
    ).not.toContain("visualContract");
    const dist = await JSZip.loadAsync(rebuilt.distZip, { checkCRC32: true });
    expect(await dist.file("index.html")!.async("string")).toContain(
      'rel="canonical" href="https://react22.xinghe.example/"',
    );
  }, 90_000);

  it("keeps historical 2.3 product CSS on its frozen pre-2.4 materializer", async () => {
    const sourceZip = await legacyReactV2_3Source();
    const rebuilt = await materializeProductionSiteFromSource({
      sourceZip,
      expectedSourceSha256: H(sourceZip),
      canonicalOrigin: "https://react23.xinghe.example",
      target: "global_excluding_cn",
    });
    const contract = JSON.parse(rebuilt.contractJson.toString("utf8"));
    expect(contract).toMatchObject({
      workflow: {
        version: "2.3.0",
        componentLibraryVersion: "2.3.0",
        materializerVersion: "2.3.0",
      },
      renderer: {
        kind: "react_static_v2",
        componentLibraryVersion: "2.3.0",
        materializerVersion: "2.3.0",
      },
    });
    const source = await JSZip.loadAsync(rebuilt.sourceZip, {
      checkCRC32: true,
    });
    const css = await source.file("public/styles.css")!.async("string");
    expect(css).toContain("color-mix(in srgb,var(--ink) 22%,transparent)");
    expect(css).not.toContain("--accent-text:");
    expect(css).not.toContain("--inverse-surface:");
  }, 90_000);

  it("rebuilds pre-content-patch 2.4 source bundles with their legacy immutable coordinates", async () => {
    const sourceZip = await legacyReactV2_4Source();
    const rebuilt = await materializeProductionSiteFromSource({
      sourceZip,
      expectedSourceSha256: H(sourceZip),
      canonicalOrigin: "https://react24-legacy.xinghe.example",
      target: "global_excluding_cn",
    });
    const contract = JSON.parse(rebuilt.contractJson.toString("utf8"));
    expect(contract).toMatchObject({
      workflow: {
        version: "2.4.0",
        componentLibraryVersion: "2.4.0",
        materializerVersion: "2.4.0",
      },
      renderer: {
        kind: "react_static_v2",
        componentLibraryVersion: "2.4.0",
        materializerVersion: "2.4.0",
      },
    });
    const source = await JSZip.loadAsync(rebuilt.sourceZip, {
      checkCRC32: true,
    });
    const currentSource = await JSZip.loadAsync(previewBuild.sourceZip, {
      checkCRC32: true,
    });
    const frozen = JSON.parse(
      await source.file("frontmind-runtime-input.json")!.async("string"),
    );
    expect(frozen).toMatchObject({
      build: {
        workflowPackageHash:
          SITEOPS_MATERIALIZER_V2_4_LEGACY.runtimeManifestSha256,
      },
      host: {
        materializerSha256: SITEOPS_MATERIALIZER_V2_4_LEGACY.materializerSha256,
      },
    });
    const historicalCss = await source
      .file("public/styles.css")!
      .async("string");
    const currentCss = await currentSource
      .file("public/styles.css")!
      .async("string");
    expect(historicalCss).toBe(currentCss);
    expect(historicalCss).toContain("--accent-text:");
    expect(historicalCss).toContain("--inverse-surface:");
    const historicalComponents = await source
      .file("src/component-library.mjs")!
      .async("string");
    const currentComponents = await currentSource
      .file("src/component-library.mjs")!
      .async("string");
    expect(historicalComponents).toBe(currentComponents);
    expect(historicalComponents).toContain(
      "/* frontmind-v4-component:start */",
    );
    const dist = await JSZip.loadAsync(rebuilt.distZip, { checkCRC32: true });
    expect(await dist.file("index.html")!.async("string")).toContain(
      'rel="canonical" href="https://react24-legacy.xinghe.example/"',
    );
  }, 90_000);

  it("stops production materialization when the deployment signal is aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      materializeProductionSiteFromSource({
        sourceZip: previewBuild.sourceZip,
        expectedSourceSha256: previewBuild.sourceSha256,
        canonicalOrigin: "https://www.xinghe.example",
        target: "global_excluding_cn",
        abortSignal: controller.signal,
      }),
    ).rejects.toMatchObject({
      phase: "input_validation",
      code: "SITEOPS_MATERIALIZATION_ABORTED",
      retryClass: "host_transient",
    });
  });

  it("rejects a source ZIP whose frozen official logo bytes were replaced", async () => {
    const source = await JSZip.loadAsync(previewBuild.sourceZip, {
      checkCRC32: true,
    });
    source.file("public/brand-logo.png", Buffer.from("not-the-logo", "utf8"));
    const tampered = await source.generateAsync({ type: "nodebuffer" });
    await expect(
      materializeProductionSiteFromSource({
        sourceZip: tampered,
        expectedSourceSha256: H(tampered),
        canonicalOrigin: "https://www.xinghe.example",
        target: "global_excluding_cn",
      }),
    ).rejects.toThrow("SITEOPS_BRAND_ASSET_HASH_MISMATCH");
  });

  it("rejects source-coordinate drift, unsafe slugs and ungrounded sections", async () => {
    await expect(
      materializeProductionSiteFromSource({
        sourceZip: previewBuild.sourceZip,
        expectedSourceSha256: H("wrong-source"),
        canonicalOrigin: "https://www.xinghe.example",
        target: "global_excluding_cn",
      }),
    ).rejects.toThrow("SITEOPS_PRODUCTION_SOURCE_HASH_MISMATCH");

    const drifted = buildInput();
    drifted.snapshot.archiveHash = H("different");
    await expect(materializeAstroSite(drifted)).rejects.toThrow(
      "SITEOPS_SNAPSHOT_COORDINATES_MISMATCH",
    );

    const traversal = buildInput();
    (traversal.brief as any).routes[1].slug = "/../secret";
    await expect(materializeAstroSite(traversal)).rejects.toThrow(
      "SITEOPS_ROUTE_SLUG_INVALID",
    );

    const ungrounded = buildInput();
    (
      ungrounded.generatedContent as any
    ).routes[1].sections[0].sourceDocumentIds = ["overview"];
    await expect(materializeAstroSite(ungrounded)).rejects.toThrow(
      "SITEOPS_GENERATED_SOURCE_MAPPING_INVALID",
    );
  });
});

function socialInput(channel: "wechat" | "xiaohongshu"): SocialPackageInput {
  const sections = Array.from(
    { length: channel === "xiaohongshu" ? 8 : 3 },
    (_, index) => ({
      heading: `知识要点 ${index + 1}`,
      paragraphs: [
        `这是从已确认企业资料整理的第 ${index + 1} 个要点，不包含未经证实的数据。`,
      ],
      sourceDocumentIds: [index % 2 === 0 ? "overview" : "service"],
    }),
  );
  return {
    channel,
    companyName: "星河智造",
    title: "如何建立可追溯的设备运维内容",
    deck: "把企业知识来源和每一条对外表达保持一致。",
    sourceDocuments: [
      { id: "overview", title: "企业概览", sha256: H("overview") },
      { id: "service", title: "设备运维服务", sha256: H("service") },
    ],
    sections,
    hashtags: ["设备运维", "企业知识库"],
  };
}

describe("SiteOps strict social packages", () => {
  it("creates the exact WeChat package with three 2.35:1 covers", async () => {
    const generated = await generateSocialPackage(socialInput("wechat"));
    const zip = await JSZip.loadAsync(generated.archive, { checkCRC32: true });
    expect(Object.keys(zip.files).sort()).toEqual(
      [
        "article.md",
        "covers/01.png",
        "covers/02.png",
        "covers/03.png",
        "manifest.json",
        "qa-report.json",
        "sources.json",
        "title.txt",
      ].sort(),
    );
    expect(generated.manifest.files).toHaveLength(7);
    for (const preview of generated.previews) {
      const metadata = await sharp(preview.buffer).metadata();
      expect(metadata).toMatchObject({
        width: 1410,
        height: 600,
        format: "png",
      });
      const manifestFile = generated.manifest.files.find(
        (file) => file.path === preview.filename,
      );
      expect(manifestFile).toMatchObject({
        mimeType: "image/png",
        bytes: preview.buffer.length,
        sha256: preview.sha256,
      });
    }
    const article = await zip.file("article.md")!.async("string");
    expect(article).not.toContain("来源：");
    expect(article).not.toContain("内容依据企业知识库");
    expect(await zip.file("sources.json")!.async("string")).toContain(
      '"sourceDocumentIds"',
    );
  }, 90_000);

  it("creates a branded 01–09 Xiaohongshu package and no publishing payload", async () => {
    const generated = await generateSocialPackage(socialInput("xiaohongshu"));
    const zip = await JSZip.loadAsync(generated.archive, { checkCRC32: true });
    const names = Object.keys(zip.files).sort();
    expect(names.filter((name) => name.startsWith("images/"))).toHaveLength(9);
    expect(names).toContain("images/01-cover.png");
    expect(names).toContain("images/09-section-08.png");
    expect(names).toContain("post-copy.md");
    expect(names).not.toContain("publish.json");
    expect(generated.qa).toMatchObject({
      passed: true,
      automatedPublishing: false,
      credentialsIncluded: false,
      imageCount: 9,
    });
    for (const preview of generated.previews) {
      const metadata = await sharp(preview.buffer).metadata();
      expect(metadata).toMatchObject({
        width: 1080,
        height: 1440,
        format: "png",
      });
    }
    const postCopy = await zip.file("post-copy.md")!.async("string");
    expect(postCopy).not.toContain("内容依据企业知识库");
    expect(await zip.file("sources.json")!.async("string")).toContain(
      '"sourceDocumentIds"',
    );
  }, 90_000);

  it("rejects unknown source mappings and a non-nine-page Xiaohongshu input", async () => {
    const unknown = socialInput("wechat");
    unknown.sections[0]!.sourceDocumentIds = ["missing"];
    await expect(generateSocialPackage(unknown)).rejects.toThrow(
      "SITEOPS_SOCIAL_SOURCE_MAPPING_INVALID",
    );

    const short = socialInput("xiaohongshu");
    short.sections.pop();
    await expect(generateSocialPackage(short)).rejects.toThrow(
      "SITEOPS_XIAOHONGSHU_EIGHT_SECTIONS_REQUIRED",
    );
  });
});
