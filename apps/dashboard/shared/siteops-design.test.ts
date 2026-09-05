import { describe, expect, it } from "vitest";

import {
  assertVisualBlueprintDiversityV4,
  canonicalSiteOpsSha256,
  composeBuildContractV4,
  composeBuildContractV3,
  composeBuildPlanContractV4,
  composeBuildPlanContractV3,
  composeBuildContractV2,
  FRONTMIND_VISUAL_FAMILIES_V3,
  referenceBlueprintForVisualCandidate,
  referenceBlueprintV3ForFamily,
  referenceBlueprintV4ForFamily,
  referenceBlueprintV2Schema,
  referenceBlueprintV3Schema,
  referenceBlueprintV4Schema,
  trustedVisualPreviewBlueprintV3,
  trustedVisualPreviewBlueprintV4,
  visualBlueprintDiversityReportV4,
  visualStyleSignatureV4,
  pageContentResultV1Schema,
  pageContentSpecV2Schema,
  siteDesignResultV1Schema,
  siteDesignResultV2Schema,
  validateDesignAndContentBindings,
} from "./siteops-design";

const H = (value: string) => canonicalSiteOpsSha256(value);

function design() {
  return {
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
    routeCompositions: [
      {
        routeId: "home",
        slots: [
          { slotId: "proof", variant: "proof" as const },
          { slotId: "contact", variant: "cta" as const },
        ],
      },
    ],
    seoPlan: {
      siteTitle: "FrontMind",
      description: "基于已验证企业知识的官网。",
      organizationType: "Organization" as const,
    },
  };
}

describe("SiteOps Manus design and content contracts", () => {
  it("accepts only allowlisted structured design and rejects executable output", () => {
    expect(
      siteDesignResultV1Schema.parse({
        operationToken: "siteops-design:1",
        designSpec: design(),
      }).designSpec.layoutArchetype,
    ).toBe("asymmetric");
    expect(() =>
      siteDesignResultV1Schema.parse({
        operationToken: "siteops-design:1",
        designSpec: {
          ...design(),
          astro: "<script>fetch('/secret')</script>",
        },
      }),
    ).toThrow();
  });

  it("binds every PageContentSpec route and slot to phase one in order", () => {
    const pageContent = pageContentResultV1Schema.parse({
      operationToken: "siteops-content:1",
      pageContent: {
        schemaVersion: 1,
        routes: [
          {
            routeId: "home",
            heading: "可靠的企业官网",
            summary: "严格引用企业知识。",
            sections: [
              {
                slotId: "proof",
                heading: "可信能力",
                paragraphs: ["所有事实均有来源。"],
                sourceDocumentIds: ["overview"],
              },
              {
                slotId: "contact",
                heading: "联系团队",
                paragraphs: ["通过已验证联系方式沟通。"],
                sourceDocumentIds: ["overview"],
              },
            ],
          },
        ],
      },
    }).pageContent;
    expect(() =>
      validateDesignAndContentBindings({
        routeIds: ["home"],
        paletteSize: 3,
        designSpec: design(),
        pageContent,
      }),
    ).not.toThrow();
    expect(() =>
      validateDesignAndContentBindings({
        routeIds: ["home"],
        paletteSize: 3,
        designSpec: design(),
        pageContent: {
          ...pageContent,
          routes: [
            {
              ...pageContent.routes[0]!,
              sections: [...pageContent.routes[0]!.sections].reverse(),
            },
          ],
        },
      }),
    ).toThrow("SITEOPS_CONTENT_SLOT_SET_MISMATCH");
  });

  it("bounds a legacy empty taxonomy to one trusted neutral palette slot", () => {
    const referenceBlueprint = referenceBlueprintV3ForFamily({
      candidateId: "candidate-legacy-empty-palette",
      providerItemKey: "s:frontmind:centered_dual_cta",
      previewLocalAssetId: "00000000-0000-4000-8000-000000000089",
      previewSha256: H("legacy-empty-palette-preview"),
      heroFamily: "centered_dual_cta",
      inspirationEvidenceIds: [H("legacy-empty-palette-evidence")],
    });
    const trustedDesign = siteDesignResultV2Schema.parse({
      operationToken: "siteops-native-fallback:legacy-empty-palette",
      designSpec: {
        schemaVersion: 2,
        referenceBlueprint,
        layoutArchetype: "hero_led",
        density: referenceBlueprint.density,
        surfaceStyle: referenceBlueprint.cardStyle,
        typeScale: "restrained",
        imageTreatment: "none",
        motionLevel: "subtle",
        colorRoles: {
          backgroundPaletteIndex: 0,
          textPaletteIndex: 0,
          accentPaletteIndex: 0,
        },
        routeCompositions: [
          {
            routeId: "home",
            slots: [{ slotId: "overview", variant: "statement" }],
          },
        ],
        seoPlan: {
          siteTitle: "FrontMind",
          description: "基于冻结视觉蓝图的可信基础预览。",
          organizationType: "Organization",
        },
      },
    }).designSpec;

    expect(() =>
      validateDesignAndContentBindings({
        routeIds: ["home"],
        paletteSize: 0,
        designSpec: trustedDesign,
      }),
    ).not.toThrow();
    expect(() =>
      validateDesignAndContentBindings({
        routeIds: ["home"],
        paletteSize: 0,
        designSpec: {
          ...trustedDesign,
          colorRoles: {
            ...trustedDesign.colorRoles,
            accentPaletteIndex: 1,
          },
        },
      }),
    ).toThrow("SITEOPS_DESIGN_PALETTE_INDEX_INVALID");
    expect(() =>
      validateDesignAndContentBindings({
        routeIds: ["home"],
        paletteSize: 0,
        designSpec: {
          ...trustedDesign,
          colorRoles: {
            ...trustedDesign.colorRoles,
            accentPaletteIndex: -1,
          },
        },
      }),
    ).toThrow("SITEOPS_DESIGN_PALETTE_INDEX_INVALID");
    expect(() =>
      validateDesignAndContentBindings({
        routeIds: ["home"],
        paletteSize: 0,
        designSpec: design(),
      }),
    ).toThrow("SITEOPS_DESIGN_PALETTE_INDEX_INVALID");
  });

  it("accepts typed content records and only the host-owned news empty state", () => {
    const typed = {
      schemaVersion: 2,
      routes: [
        {
          routeId: "home",
          heading: "可信企业官网",
          summary: "仅使用冻结知识库。",
          sections: [
            {
              slotId: "services",
              blockType: "entity_grid",
              heading: "服务",
              paragraphs: ["已确认的服务。"],
              items: [],
              entityIds: ["service-one"],
              faqIds: [],
              sourceDocumentIds: ["kb-service-poison-001"],
            },
          ],
        },
        {
          routeId: "news",
          heading: "企业动态",
          summary: "当前知识库暂无可公开的企业动态。",
          emptyState: "company_news_unavailable",
          sections: [],
        },
      ],
      entities: [
        {
          entityId: "service-one",
          entityType: "service",
          slug: "service-one",
          title: "服务一",
          summary: "已确认的服务。",
          body: ["服务正文。"],
          tags: [],
          publishedAt: null,
          modifiedAt: null,
          author: null,
          sourceName: null,
          sourceUrl: null,
          sourceDocumentIds: ["kb-service-poison-001"],
          relatedEntityIds: [],
        },
      ],
      faqs: [],
      officialLinks: [],
    } as const;
    expect(pageContentSpecV2Schema.parse(typed).routes[1]).toMatchObject({
      routeId: "news",
      emptyState: "company_news_unavailable",
      sections: [],
    });
    expect(() =>
      pageContentSpecV2Schema.parse({
        ...typed,
        entities: [],
      }),
    ).toThrow("Typed content block references an absent entity or FAQ");
    expect(() =>
      pageContentSpecV2Schema.parse({
        ...typed,
        routes: [typed.routes[0], { ...typed.routes[1], routeId: "blog" }],
      }),
    ).toThrow("Only the company-news route may use the host-owned empty state");
  });

  it("pins visual evidence, design and trusted host coordinates in BuildContractV2", () => {
    const contract = composeBuildContractV2({
      schemaVersion: 2,
      source: {
        knowledgeSnapshotId: "11111111-1111-4111-8111-111111111111",
        archiveSha256: H("archive"),
        sourceBuildId: null,
        sourceBuildRevision: null,
      },
      workflow: {
        upstreamSha256: H("upstream"),
        version: "1.2.0",
        manifestSha256: H("manifest"),
        starterVersion: "1.2.0",
        starterSha256: H("starter"),
        componentLibraryVersion: "1.0.0",
        materializerVersion: "1.0.0",
        materializerSha256: H("materializer"),
      },
      identity: {
        companyName: "FrontMind",
        primaryLanguage: "zh-CN",
        verifiedContacts: [],
      },
      visual: {
        queryHash: H("query"),
        selectedCandidateId: "candidate-B",
        providerItemKey: "n:143",
        visualEvidenceSha256: H("evidence"),
        previewSha256: H("preview"),
        supportEvidenceSha256s: [],
        taxonomy: {
          role: "foundation",
          palette: ["#10212B", "#EF6C45", "#F5F2EA"],
          typography: [],
          layout: [],
          motion: [],
          accessibility: [],
        },
        designSpecHash: canonicalSiteOpsSha256(design()),
        componentLibraryVersion: "1.0.0",
      },
      routes: [
        {
          id: "home",
          slug: "/",
          title: "首页",
          sourceDocumentIds: ["overview"],
        },
      ],
      assets: [],
      seo: {
        ...design().seoPlan,
        environment: "preview",
        canonicalPolicy: "forbidden",
      },
      target: { environment: "preview", canonicalOrigin: null },
      qaPolicyVersion: "siteops-qa-v1",
    });
    expect(contract.specHash).toHaveLength(64);
    expect(JSON.stringify(contract)).not.toContain("promptSha");
  });

  it("freezes the selected F catalog item to the floating-orbit React family", () => {
    const blueprint = referenceBlueprintForVisualCandidate({
      candidateId: "candidate-F",
      providerItemKey: "n:8435",
      previewSha256: H("preview-f"),
      title: "Hero Section 7",
      sourceUrl: "https://21st.dev/example/hero-section-7",
      heroEligibility: { variant: "centered_statement" },
    });
    expect(blueprint).toMatchObject({
      heroFamily: "floating_orbit",
      alignment: "center",
      mediaRegion: "surround",
      backgroundStyle: "warm_light",
      containerStyle: "contained",
      motionLevel: "floating_subtle",
      mediaStrategy: "procedural_brand_svg",
    });
    expect(() =>
      referenceBlueprintV2Schema.parse({
        ...blueprint,
        heroFamily: "centered_dual_cta",
      }),
    ).toThrow("Reference blueprint hash does not match");
  });

  it("freezes exactly nine distinct FrontMind-owned V3 visual families", () => {
    const blueprints = FRONTMIND_VISUAL_FAMILIES_V3.map((heroFamily, index) =>
      referenceBlueprintV3ForFamily({
        candidateId: `candidate-${index + 1}`,
        providerItemKey: `s:frontmind:${heroFamily}`,
        previewLocalAssetId: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
        previewSha256: H(`preview-${heroFamily}`),
        heroFamily,
        inspirationEvidenceIds: [H("safe-21st-inspiration")],
      }),
    );
    expect(blueprints).toHaveLength(9);
    expect(new Set(blueprints.map((item) => item.heroFamily)).size).toBe(9);
    expect(
      blueprints.every((item) =>
        item.componentManifest.includes(`hero:${item.heroFamily}`),
      ),
    ).toBe(true);
    expect(() =>
      referenceBlueprintV3Schema.parse({
        ...blueprints[0],
        heroFamily: "proof_grid",
      }),
    ).toThrow();
  });

  it("projects only allowlisted inspiration taxonomy into the frozen V3 blueprint", () => {
    const darkEditorialPreview = trustedVisualPreviewBlueprintV3(
      "split_media",
      [
        {
          palette: ["#241238", "dark-canvas", "high-contrast"],
          typography: ["serif-editorial"],
          layout: ["editorial-rhythm", "premium-restrained"],
          motion: ["short-transition"],
          accessibility: ["reduced-motion-required"],
        },
      ],
    );
    const lightTechnicalPreview = trustedVisualPreviewBlueprintV3(
      "split_media",
      [
        {
          palette: ["#dbeafe", "light-canvas", "high-contrast"],
          typography: ["condensed-technical"],
          layout: ["modular-grid", "technical-precise"],
          motion: ["short-transition"],
          accessibility: ["reduced-motion-required"],
        },
      ],
    );

    expect(darkEditorialPreview).toMatchObject({
      heroFamily: "split_media",
      typeSystem: "editorial_serif",
      typographyStyle: "editorial",
      density: "spacious",
      decorationStyle: "editorial_lines",
      backgroundStyle: "dark",
      gradientStyle: "spotlight",
    });
    expect(lightTechnicalPreview).toMatchObject({
      heroFamily: "split_media",
      typeSystem: "technical_sans",
      typographyStyle: "technical",
      density: "compact",
      decorationStyle: "grid",
      backgroundStyle: "cool_light",
    });
    expect(darkEditorialPreview.palette).not.toEqual(
      lightTechnicalPreview.palette,
    );
    expect(Object.values(darkEditorialPreview.palette)).not.toContain(
      "#241238",
    );

    const common = {
      candidateId: "candidate-inspired",
      providerItemKey: "s:frontmind:split_media",
      previewLocalAssetId: "00000000-0000-4000-8000-000000000099",
      previewSha256: H("inspired-preview"),
      heroFamily: "split_media" as const,
      inspirationEvidenceIds: [H("safe-21st-inspiration")],
    };
    const darkFrozen = referenceBlueprintV3ForFamily({
      ...common,
      previewBlueprint: darkEditorialPreview,
    });
    const lightFrozen = referenceBlueprintV3ForFamily({
      ...common,
      previewBlueprint: lightTechnicalPreview,
    });
    expect(darkFrozen.blueprintHash).not.toBe(lightFrozen.blueprintHash);
    expect(darkFrozen.palette).toEqual(darkEditorialPreview.palette);
    expect(lightFrozen.palette).toEqual(lightTechnicalPreview.palette);
  });

  it("uses the family baseline when inspiration contains no qualifying safe tokens", () => {
    const baseline = trustedVisualPreviewBlueprintV3("floating_orbit");
    const unqualified = trustedVisualPreviewBlueprintV3("floating_orbit", [
      {
        palette: ["provider-secret-palette", "javascript:alert(1)"],
        typography: ["download-this-provider-font"],
        layout: ["copy-third-party-component"],
        motion: ["run-provider-animation-code"],
        accessibility: ["unknown-provider-directive"],
      },
    ]);

    expect(unqualified).toEqual(baseline);
    expect(baseline).toMatchObject({
      heroFamily: "floating_orbit",
      palette: {
        canvas: "#f7f1e8",
        ink: "#1f2937",
        accent: "#a34805",
        muted: "#eadfce",
      },
      typeSystem: "humanist_sans",
      density: "spacious",
      decorationStyle: "orbital",
      backgroundStyle: "warm_light",
    });
    expect(JSON.stringify(unqualified)).not.toContain("provider");
  });

  it("rejects a low-contrast V3 palette before the candidate blueprint is frozen", () => {
    const previewBlueprint = trustedVisualPreviewBlueprintV3("split_media");
    expect(() =>
      referenceBlueprintV3ForFamily({
        candidateId: "candidate-low-contrast",
        providerItemKey: "s:frontmind:split_media",
        previewLocalAssetId: "00000000-0000-4000-8000-000000000088",
        previewSha256: H("low-contrast-preview"),
        heroFamily: "split_media",
        inspirationEvidenceIds: [H("safe-21st-inspiration")],
        previewBlueprint: {
          ...previewBlueprint,
          palette: {
            canvas: "#ffffff",
            ink: "#eeeeee",
            accent: "#dddddd",
            muted: "#ffffff",
          },
        },
      }),
    ).toThrow("SITEOPS_VISUAL_PALETTE_CONTRAST_INVALID");
  });

  it("freezes nine materially different V4 visual languages", () => {
    const blueprints = FRONTMIND_VISUAL_FAMILIES_V3.map((heroFamily) =>
      trustedVisualPreviewBlueprintV4(heroFamily),
    );
    const report = visualBlueprintDiversityReportV4(blueprints);

    expect(report).toMatchObject({
      candidateCount: 9,
      uniqueFamilies: 9,
      uniqueStyleSignatures: 9,
      uniqueBackgrounds: 4,
      uniqueTypeSystems: 4,
      uniquePalettes: 9,
      uniqueCompositions: 5,
      violations: [],
      isDiverse: true,
    });
    expect(() => assertVisualBlueprintDiversityV4(blueprints)).not.toThrow();
    expect(() =>
      assertVisualBlueprintDiversityV4(blueprints.map(() => blueprints[0]!)),
    ).toThrow("SITEOPS_VISUAL_DIVERSITY_INVALID");
  });

  it("lets one inspiration taxonomy influence only its assigned V4 family", () => {
    const taxonomy = {
      role: "foundation" as const,
      palette: ["#241238", "dark-canvas", "high-contrast"],
      typography: ["serif-editorial"],
      layout: ["editorial-rhythm", "premium-restrained"],
      motion: ["short-transition"],
      accessibility: ["reduced-motion-required"],
    };
    const baselines = FRONTMIND_VISUAL_FAMILIES_V3.map((heroFamily) =>
      trustedVisualPreviewBlueprintV4(heroFamily),
    );
    const independentlyProjected = FRONTMIND_VISUAL_FAMILIES_V3.map(
      (heroFamily) =>
        trustedVisualPreviewBlueprintV4(
          heroFamily,
          heroFamily === "split_media" ? taxonomy : undefined,
        ),
    );
    expect(
      independentlyProjected
        .map((blueprint, index) =>
          blueprint === baselines[index] ||
          JSON.stringify(blueprint) === JSON.stringify(baselines[index])
            ? null
            : blueprint.heroFamily,
        )
        .filter(Boolean),
    ).toEqual(["split_media"]);

    const frozen = referenceBlueprintV4ForFamily({
      candidateId: "candidate-v4",
      providerItemKey: "n:9281",
      referencePreviewLocalAssetId: "00000000-0000-4000-8000-000000000041",
      referencePreviewSha256: H("21st-reference"),
      realizationPreviewLocalAssetId: "00000000-0000-4000-8000-000000000042",
      realizationPreviewSha256: H("frontmind-realization"),
      heroFamily: "split_media",
      inspirationEvidenceId: H("reference-evidence"),
      inspirationTaxonomy: taxonomy,
      previewBlueprint: independentlyProjected[1],
    });
    expect(frozen).toMatchObject({
      schemaVersion: 4,
      referencePreviewSha256: H("21st-reference"),
      previewSha256: H("frontmind-realization"),
      inspirationTaxonomySha256: canonicalSiteOpsSha256(taxonomy),
      styleSignature: visualStyleSignatureV4(independentlyProjected[1]!),
      inspirationEvidenceIds: [H("reference-evidence")],
    });
    expect(referenceBlueprintV4Schema.parse(frozen)).toEqual(frozen);
  });

  it("includes every render-authoritative V4 coordinate in the style signature", () => {
    const baseline = trustedVisualPreviewBlueprintV4("split_media");
    const mutations = [
      { palette: { ...baseline.palette, accent: "#702018" } },
      { typeSystem: "display_sans" as const },
      { alignment: "right" as const },
      { mediaRegion: "surround" as const },
      { navStyle: "floating" as const },
      { ctaStyle: "text_link" as const },
      { containerStyle: "contained" as const },
      { cardStyle: "layered" as const },
      { backgroundStyle: "dark" as const },
      { gradientStyle: "mesh" as const },
      { decorationStyle: "glow" as const },
    ];
    const signature = visualStyleSignatureV4(baseline);
    for (const mutation of mutations) {
      expect(visualStyleSignatureV4({ ...baseline, ...mutation })).not.toBe(
        signature,
      );
    }
  });

  it("keeps pre-materialization plans distinct from final BuildContractV3", () => {
    const referenceBlueprint = referenceBlueprintForVisualCandidate({
      candidateId: "candidate-F",
      providerItemKey: "n:8435",
      previewSha256: H("preview-f"),
    });
    const base = {
      schemaVersion: 3 as const,
      source: {
        knowledgeSnapshotId: "11111111-1111-4111-8111-111111111111",
        archiveSha256: H("archive"),
        sourceBuildId: null,
        sourceBuildRevision: null,
      },
      workflow: {
        upstreamSha256: H("upstream"),
        version: "2.0.0",
        manifestSha256: H("manifest"),
        starterVersion: "2.0.0",
        starterSha256: H("starter"),
        componentLibraryVersion: "2.0.0",
        materializerVersion: "2.0.0",
        materializerSha256: H("materializer"),
      },
      renderer: {
        kind: "react_static_v1" as const,
        reactVersion: "19.2.1",
        componentLibraryVersion: "2.0.0" as const,
        materializerVersion: "2.0.0" as const,
      },
      identity: {
        companyName: "FrontMind",
        primaryLanguage: "zh-CN",
        verifiedContacts: [],
      },
      visual: {
        queryHash: H("query"),
        selectedCandidateId: "candidate-F",
        providerItemKey: "n:8435",
        visualEvidenceSha256: H("visual-evidence"),
        previewSha256: H("preview-f"),
        supportEvidenceSha256s: [],
        taxonomy: {
          role: "foundation" as const,
          palette: ["#F7F1E6", "#17201B", "#C96C3B"],
          typography: [],
          layout: [],
          motion: [],
          accessibility: [],
        },
      },
      referenceBlueprint,
      designSpecHash: H("design"),
      routes: [
        {
          id: "home",
          slug: "/",
          title: "首页",
          sourceDocumentIds: ["overview"],
        },
      ],
      assets: [],
      seo: {
        siteTitle: "FrontMind",
        description: "可信企业官网",
        organizationType: "Organization" as const,
        environment: "preview" as const,
        canonicalPolicy: "forbidden" as const,
      },
      target: { environment: "preview" as const, canonicalOrigin: null },
      qaPolicyVersion: "siteops-react-static-qa-v3",
    };
    const plan = composeBuildPlanContractV3({
      ...base,
      contractKind: "build_plan",
    });
    expect(plan).not.toHaveProperty("sourceHash");
    expect(plan.contractKind).toBe("build_plan");

    const contract = composeBuildContractV3({
      ...base,
      contractKind: "build_contract",
      sourceHash: H("canonical-source-entries"),
      distHash: H("dist"),
    });
    expect(contract.contractKind).toBe("build_contract");
    expect(contract.sourceHash).toHaveLength(64);
    expect(contract.specHash).not.toBe(plan.specHash);
  });

  it("pins the typed inventory and exact React Static coordinates in BuildContractV4", () => {
    const referenceBlueprint = referenceBlueprintForVisualCandidate({
      candidateId: "candidate-F",
      providerItemKey: "n:8435",
      previewSha256: H("preview-v4"),
    });
    const base = {
      schemaVersion: 4 as const,
      source: {
        knowledgeSnapshotId: "11111111-1111-4111-8111-111111111111",
        archiveSha256: H("archive-v4"),
        sourceBuildId: null,
        sourceBuildRevision: null,
      },
      workflow: {
        upstreamSha256: H("upstream-v4"),
        version: "2.2.0",
        manifestSha256: H("manifest-v4"),
        starterVersion: "2.2.0",
        starterSha256: H("starter-v4"),
        componentLibraryVersion: "2.2.0",
        materializerVersion: "2.2.0",
        materializerSha256: H("materializer-v4"),
      },
      renderer: {
        kind: "react_static_v2" as const,
        reactVersion: "19.2.1" as const,
        componentLibraryVersion: "2.2.0" as const,
        materializerVersion: "2.2.0" as const,
      },
      identity: {
        companyName: "FrontMind",
        primaryLanguage: "zh-CN",
        verifiedContacts: [],
      },
      visual: {
        queryHash: H("query-v4"),
        selectedCandidateId: "candidate-F",
        providerItemKey: "n:8435",
        visualEvidenceSha256: H("visual-evidence-v4"),
        previewSha256: H("preview-v4"),
        supportEvidenceSha256s: [],
        taxonomy: {
          role: "foundation" as const,
          palette: ["#F7F1E6", "#17201B", "#C96C3B"],
          typography: [],
          layout: [],
          motion: [],
          accessibility: [],
        },
      },
      referenceBlueprint,
      designSpecHash: H("design-v4"),
      routes: [
        {
          id: "home",
          slug: "/",
          title: "首页",
          sourceDocumentIds: ["kb-overview-poison-001"],
        },
      ],
      assets: [],
      seo: {
        siteTitle: "FrontMind",
        description: "可信企业官网",
        organizationType: "Organization" as const,
        environment: "preview" as const,
        canonicalPolicy: "forbidden" as const,
      },
      target: { environment: "preview" as const, canonicalOrigin: null },
      qaPolicyVersion: "siteops-qa-v4",
      content: {
        schemaVersion: 2 as const,
        inventoryHash: H("frozen-content-inventory"),
        routePolicyVersion: "snapshot-conditional-v1" as const,
        sourcePolicy: "frozen_snapshot_only" as const,
        externalAcquisitionAllowed: false as const,
        publicSourceLabels: "forbidden" as const,
      },
    };
    const plan = composeBuildPlanContractV4({
      ...base,
      contractKind: "build_plan",
    });
    expect(plan).toMatchObject({
      schemaVersion: 4,
      renderer: { kind: "react_static_v2" },
      content: {
        sourcePolicy: "frozen_snapshot_only",
        externalAcquisitionAllowed: false,
        publicSourceLabels: "forbidden",
      },
    });
    expect(plan).not.toHaveProperty("contentSpecHash");
    const contract = composeBuildContractV4({
      ...base,
      contractKind: "build_contract",
      contentSpecHash: H("typed-page-content"),
      sourceHash: H("canonical-source-entries-v4"),
      distHash: H("dist-v4"),
    });
    expect(contract.contentSpecHash).toHaveLength(64);
    expect(contract.specHash).not.toBe(plan.specHash);
    expect(() =>
      composeBuildPlanContractV4({
        ...base,
        workflow: { ...base.workflow, componentLibraryVersion: "2.1.0" },
        contractKind: "build_plan",
      } as never),
    ).toThrow(
      "BuildContractV4 requires complete, matching immutable workflow and QA coordinates",
    );
  });
});
