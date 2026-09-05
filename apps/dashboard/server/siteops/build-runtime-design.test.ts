import { describe, expect, it, vi } from "vitest";

vi.mock("@axe-core/playwright", () => ({ default: class MockAxeBuilder {} }));
vi.mock("chrome-launcher", () => ({ launch: vi.fn() }));
vi.mock("lighthouse", () => ({ default: vi.fn() }));
vi.mock("playwright", () => ({ chromium: {} }));

import {
  referenceBlueprintForVisualCandidate,
  referenceBlueprintV3ForFamily,
  trustedVisualPreviewBlueprintV3,
} from "../../shared/siteops-design";
import {
  siteDesignMaterializationProjection,
  siteOpsVisualCssTokens,
} from "./build-runtime";
import { renderTrustedVisualCandidateHtml } from "./react-static-runtime";

function design(overrides: Record<string, unknown> = {}) {
  const referenceBlueprint = referenceBlueprintForVisualCandidate({
    candidateId: "candidate-F",
    providerItemKey: "n:8435",
    previewSha256:
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    title: "Floating orbit",
  });
  return {
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
        slots: [{ slotId: "proof", variant: "proof" }],
      },
    ],
    seoPlan: {
      siteTitle: "FrontMind",
      description: "可信企业官网",
      organizationType: "Organization",
    },
    ...overrides,
  };
}

describe("trusted SiteOps component projection", () => {
  it("materializes distinct allowlisted layouts without accepting model code", () => {
    const asymmetric = siteDesignMaterializationProjection(design());
    const editorial = siteDesignMaterializationProjection(
      design({
        layoutArchetype: "editorial",
        surfaceStyle: "flat",
        typeScale: "editorial",
      }),
    );

    expect(asymmetric.bodyClass).toContain("layout--asymmetric");
    expect(asymmetric.heroClass).toBe("hero hero--floating_orbit");
    expect(asymmetric.heroFamily).toBe("floating_orbit");
    expect(asymmetric.bodyClass).toContain("decoration--orbital");
    expect(asymmetric.bodyClass).toContain("container--contained");
    expect(asymmetric.bodyClass).toContain(
      "media-strategy--procedural_brand_svg",
    );
    expect(asymmetric.componentManifest.routes[0]?.slots[0]).toEqual({
      slotId: "proof",
      variant: "proof",
    });
    expect(editorial.bodyClass).toContain("layout--editorial");
    expect(editorial.heroClass).toBe("hero hero--floating_orbit");
    expect(editorial.componentManifest).not.toEqual(
      asymmetric.componentManifest,
    );
    expect(() =>
      siteDesignMaterializationProjection({
        ...design(),
        source: "<script>fetch('/secret')</script>",
      }),
    ).toThrow();
  });

  it("keeps V3 candidate preview tokens authoritative in final CSS", () => {
    const previewBlueprint = trustedVisualPreviewBlueprintV3("floating_orbit");
    const referenceBlueprint = referenceBlueprintV3ForFamily({
      candidateId: "candidate-v3",
      providerItemKey: "s:frontmind:floating_orbit",
      previewLocalAssetId: "00000000-0000-4000-8000-000000000077",
      previewSha256:
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      heroFamily: "floating_orbit",
      inspirationEvidenceIds: [
        "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      ],
      previewBlueprint,
    });
    const modelDesign = design({
      referenceBlueprint,
      density: "compact",
      typeScale: "editorial",
      motionLevel: "none",
      colorRoles: {
        backgroundPaletteIndex: 0,
        textPaletteIndex: 1,
        accentPaletteIndex: 2,
      },
    });
    const tokens = siteOpsVisualCssTokens(
      {
        taxonomy: {
          palette: ["#ffffff", "#eeeeee", "#dddddd", "#cccccc"],
        },
      } as Parameters<typeof siteOpsVisualCssTokens>[0],
      modelDesign as Parameters<typeof siteOpsVisualCssTokens>[1],
    );
    const previewHtml = renderTrustedVisualCandidateHtml({
      brief: {
        schemaVersion: 1,
        companyName: "FrontMind",
        primaryLanguage: "zh-CN",
        companySummary: "可信企业官网",
        offerings: ["企业官网"],
        targetAudiences: ["企业客户"],
        differentiators: ["可信交付"],
        conversionGoal: "联系我们",
        pages: [
          {
            id: "home",
            slug: "/",
            title: "首页",
            sourceDocumentIds: ["overview"],
          },
        ],
        verifiedFacts: [],
        publicAssetIds: [],
        unknowns: [],
      },
      blueprint: previewBlueprint,
    });

    expect(tokens).toMatchObject({
      ...previewBlueprint.palette,
      typeSystem: previewBlueprint.typeSystem,
      density: previewBlueprint.density,
      radiusStyle: previewBlueprint.radiusStyle,
      motionLevel: previewBlueprint.motionLevel,
      radius: "22px",
      gap: "32px",
      sectionPadding: "56px",
    });
    for (const [role, value] of Object.entries(previewBlueprint.palette)) {
      expect(previewHtml).toContain(`--${role}:${value}`);
    }
    expect(previewHtml).toContain(
      `type-system--${previewBlueprint.typeSystem}`,
    );
    expect(previewHtml).toContain(`density--${previewBlueprint.density}`);
    expect(previewHtml).toContain(`radius--${previewBlueprint.radiusStyle}`);
    expect(previewHtml).toContain(`motion--${previewBlueprint.motionLevel}`);

    const projection = siteDesignMaterializationProjection(modelDesign);
    const finalClasses = projection.bodyClass.split(" ");
    expect(finalClasses).toContain(
      `type-system--${previewBlueprint.typeSystem}`,
    );
    expect(finalClasses).toContain(`density--${previewBlueprint.density}`);
    expect(finalClasses).toContain(`radius--${previewBlueprint.radiusStyle}`);
    expect(finalClasses).toContain(`motion--${previewBlueprint.motionLevel}`);
    expect(finalClasses).not.toContain("type--editorial");
    expect(finalClasses).not.toContain("motion--none");
  });

  it("fails final V3 CSS validation instead of silently replacing colors", () => {
    const previewBlueprint = trustedVisualPreviewBlueprintV3("split_media");
    const referenceBlueprint = referenceBlueprintV3ForFamily({
      candidateId: "candidate-v3",
      providerItemKey: "s:frontmind:split_media",
      previewLocalAssetId: "00000000-0000-4000-8000-000000000066",
      previewSha256:
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      heroFamily: "split_media",
      inspirationEvidenceIds: [
        "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      ],
      previewBlueprint,
    });
    const forgedDesign = design({
      referenceBlueprint: {
        ...referenceBlueprint,
        palette: {
          canvas: "#ffffff",
          ink: "#eeeeee",
          accent: "#dddddd",
          muted: "#ffffff",
        },
      },
    });
    expect(() =>
      siteOpsVisualCssTokens(
        { taxonomy: { palette: [] } } as Parameters<
          typeof siteOpsVisualCssTokens
        >[0],
        forgedDesign as Parameters<typeof siteOpsVisualCssTokens>[1],
      ),
    ).toThrow("SITEOPS_VISUAL_PALETTE_CONTRAST_INVALID");
  });
});
