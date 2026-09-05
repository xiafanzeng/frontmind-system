import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  FRONTMIND_VISUAL_FAMILIES_V3,
  trustedVisualPreviewBlueprintV3,
  trustedVisualPreviewBlueprintV4,
} from "../../shared/siteops-design";
import {
  renderTrustedVisualCandidateHtml,
  renderTrustedVisualCandidatePreviews,
  TRUSTED_REACT_COMPONENT_LIBRARY_SOURCE,
  TRUSTED_REACT_COMPONENT_LIBRARY_SOURCE_V2_2,
} from "./react-static-runtime";

const brief = {
  schemaVersion: 1 as const,
  companyName: "天印溯方",
  primaryLanguage: "zh-CN",
  companySummary: "可信企业官网",
  offerings: ["检测服务", "专业解读", "健康管理"],
  targetAudiences: ["企业客户"],
  differentiators: ["可信交付"],
  conversionGoal: "预约咨询",
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
};

describe("trusted visual preview renderer", () => {
  it("keeps the exact 2.2 component source frozen while 2.3 owns V4", () => {
    expect(
      createHash("sha256")
        .update(TRUSTED_REACT_COMPONENT_LIBRARY_SOURCE_V2_2)
        .digest("hex"),
    ).toBe("b5778f2a5042f474e1ae649eb977358a91602185dc0d360daa3e630b33d5915f");
    expect(TRUSTED_REACT_COMPONENT_LIBRARY_SOURCE_V2_2).not.toContain(
      "V4SiteHero",
    );
    expect(TRUSTED_REACT_COMPONENT_LIBRARY_SOURCE_V2_2).not.toContain(
      "visualContract",
    );
    expect(TRUSTED_REACT_COMPONENT_LIBRARY_SOURCE).toContain("V4SiteHero");
    expect(TRUSTED_REACT_COMPONENT_LIBRARY_SOURCE).toContain(
      "page.visualContract",
    );
  });

  it("rejects an already-aborted render before launching Chromium", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      renderTrustedVisualCandidatePreviews({
        brief: {} as never,
        blueprints: [],
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it("renders the nine V4 families as nine explicit visual languages", () => {
    const rendered = FRONTMIND_VISUAL_FAMILIES_V3.map((heroFamily) =>
      renderTrustedVisualCandidateHtml({
        brief,
        blueprint: trustedVisualPreviewBlueprintV4(heroFamily),
      }),
    );
    expect(new Set(rendered).size).toBe(9);
    for (const html of rendered) {
      expect(html).not.toMatch(/FrontMind|21st/iu);
    }
    expect(
      rendered.map(
        (html) => html.match(/data-visual-language="([^"]+)"/u)?.[1] ?? null,
      ),
    ).toEqual([
      "aurora-orbit",
      "atelier-editorial",
      "swiss-evidence",
      "organic-human",
      "chrome-product",
      "eastern-minimal",
      "electric-brutalist",
      "nocturne-luxury",
      "neural-glass",
    ]);
  });

  it("projects every V4 blueprint coordinate into consumed preview CSS", () => {
    const blueprint = trustedVisualPreviewBlueprintV4("feature_grid");
    const html = renderTrustedVisualCandidateHtml({ brief, blueprint });
    for (const coordinateClass of [
      `align--${blueprint.alignment}`,
      `emphasis--${blueprint.contentEmphasis}`,
      `media-region--${blueprint.mediaRegion}`,
      `media-ratio--${blueprint.mediaRatio}`,
      `media-strategy--${blueprint.mediaStrategy}`,
      `composition--${blueprint.composition}`,
      `background--${blueprint.backgroundStyle}`,
      `gradient--${blueprint.gradientStyle}`,
      `border--${blueprint.borderStyle}`,
      `radius--${blueprint.radiusStyle}`,
      `decoration--${blueprint.decorationStyle}`,
      `nav-style--${blueprint.navStyle}`,
      `cta-style--${blueprint.ctaStyle}`,
      `card-style--${blueprint.cardStyle}`,
      `container--${blueprint.containerStyle}`,
      `typography--${blueprint.typographyStyle}`,
      `density--${blueprint.density}`,
      `responsive--${blueprint.responsiveBehavior}`,
      `motion--${blueprint.motionLevel}`,
    ]) {
      expect(html).toContain(coordinateClass);
    }
    expect(html).toContain(`type-system--${blueprint.typeSystem}`);
    for (const [role, value] of Object.entries(blueprint.palette)) {
      expect(html).toContain(`--${role}:${value}`);
    }
    expect(html).toContain(".preview-contract--v4.nav-style--floating");
    expect(html).toContain(".preview-contract--v4.cta-style--pill");
    expect(html).toContain(".preview-contract--v4.card-style--layered");
    expect(html).toContain(".preview-contract--v4.media-region--split");
  });

  it("keeps historical V3 preview inputs readable", () => {
    const html = renderTrustedVisualCandidateHtml({
      brief,
      blueprint: trustedVisualPreviewBlueprintV3("floating_orbit"),
    });
    expect(html).toContain('data-preview-contract="3"');
    expect(html).toContain('data-hero-family="floating_orbit"');
    expect(html).not.toContain('class="frame preview-contract--v4');
  });
});
