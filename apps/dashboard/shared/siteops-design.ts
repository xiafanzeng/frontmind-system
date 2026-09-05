import { createHash } from "node:crypto";
import { z } from "zod";
import { siteBriefSchema, visualTaxonomySchema } from "./siteops";

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);

export const siteLayoutArchetypeSchema = z.enum([
  "hero_led",
  "editorial",
  "modular",
  "split",
  "asymmetric",
]);
export const siteHeroVariantSchema = z.enum([
  "split_media",
  "centered_statement",
  "editorial_lede",
  "proof_grid",
]);
export const siteHeroFamilySchema = z.enum([
  "floating_orbit",
  "feature_grid",
  "bento",
  "split_media",
  "editorial",
  "centered_dual_cta",
  "immersive_visual",
  "product_stage",
  "proof_grid",
  "full_bleed_statement",
]);

/** The current customer-facing board is intentionally narrower than the
 * historical React 2.0 component library. `proof_grid` remains readable for
 * immutable 2.0 builds, but is not a standalone visual family in V3. */
export const FRONTMIND_VISUAL_FAMILIES_V3 = [
  "floating_orbit",
  "split_media",
  "editorial",
  "bento",
  "feature_grid",
  "centered_dual_cta",
  "immersive_visual",
  "product_stage",
  "full_bleed_statement",
] as const satisfies readonly z.infer<typeof siteHeroFamilySchema>[];

export const frontMindVisualFamilyV3Schema = z.enum(
  FRONTMIND_VISUAL_FAMILIES_V3,
);
export const siteSectionVariantSchema = z.enum([
  "statement",
  "split",
  "cards",
  "timeline",
  "faq",
  "proof",
  "cta",
]);
export const siteSeoPlanSchema = z
  .object({
    siteTitle: z.string().trim().min(1).max(80),
    description: z.string().trim().min(1).max(200),
    organizationType: z.enum([
      "Organization",
      "Corporation",
      "ProfessionalService",
    ]),
  })
  .strict();

export const siteDesignSpecV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    layoutArchetype: siteLayoutArchetypeSchema,
    heroVariant: siteHeroVariantSchema,
    density: z.enum(["compact", "balanced", "spacious"]),
    surfaceStyle: z.enum(["flat", "bordered", "soft_depth", "layered"]),
    typeScale: z.enum(["restrained", "editorial", "display"]),
    imageTreatment: z.enum(["contained", "wide", "masked", "none"]),
    motionLevel: z.enum(["none", "subtle"]),
    colorRoles: z
      .object({
        backgroundPaletteIndex: z.number().int().nonnegative().max(11),
        textPaletteIndex: z.number().int().nonnegative().max(11),
        accentPaletteIndex: z.number().int().nonnegative().max(11),
      })
      .strict(),
    routeCompositions: z
      .array(
        z
          .object({
            routeId: z.string().trim().min(1).max(64),
            slots: z
              .array(
                z
                  .object({
                    slotId: z
                      .string()
                      .trim()
                      .regex(/^[a-z][a-z0-9_-]{0,63}$/u),
                    variant: siteSectionVariantSchema,
                  })
                  .strict(),
              )
              .min(1)
              .max(16),
          })
          .strict(),
      )
      .min(1)
      .max(30),
    seoPlan: siteSeoPlanSchema,
  })
  .strict();

const referenceBlueprintV2BaseSchema = z
  .object({
    schemaVersion: z.literal(2),
    candidateId: z.string().trim().min(1).max(191),
    providerItemKey: z
      .string()
      .trim()
      .min(3)
      .max(514)
      .regex(/^(?:n:[1-9]\d*|s:.+)$/u),
    previewSha256: sha256Schema,
    heroFamily: siteHeroFamilySchema,
    alignment: z.enum(["left", "center", "right"]),
    contentEmphasis: z.enum(["statement", "balanced", "product", "proof"]),
    mediaRegion: z.enum(["none", "inline", "split", "surround", "full_bleed"]),
    mediaRatio: z.enum(["none", "square", "portrait", "landscape", "wide"]),
    composition: z.enum([
      "centered",
      "split",
      "editorial",
      "modular",
      "immersive",
    ]),
    backgroundStyle: z.enum([
      "warm_light",
      "cool_light",
      "dark",
      "gradient",
      "image_stage",
    ]),
    gradientStyle: z.enum(["none", "soft_radial", "mesh", "spotlight"]),
    borderStyle: z.enum(["none", "subtle", "defined"]),
    radiusStyle: z.enum(["none", "soft", "rounded", "pill"]),
    decorationStyle: z.enum([
      "none",
      "orbital",
      "grid",
      "glow",
      "editorial_lines",
    ]),
    navStyle: z.enum(["minimal", "floating", "bordered"]),
    ctaStyle: z.enum(["single", "dual", "pill", "text_link"]),
    cardStyle: z.enum(["flat", "bordered", "soft_depth", "layered"]),
    containerStyle: z.enum(["contained", "wide", "edge_to_edge"]),
    typographyStyle: z.enum([
      "restrained",
      "editorial",
      "display",
      "technical",
    ]),
    density: z.enum(["compact", "balanced", "spacious"]),
    responsiveBehavior: z.enum(["stack", "reflow", "crop_safe"]),
    motionLevel: z.enum(["none", "subtle", "floating_subtle"]),
    mediaStrategy: z.enum(["customer_asset", "procedural_brand_svg", "none"]),
  })
  .strict();

export const referenceBlueprintV2Schema = referenceBlueprintV2BaseSchema
  .extend({ blueprintHash: sha256Schema })
  .strict()
  .superRefine((value, context) => {
    const { blueprintHash: _blueprintHash, ...coordinates } = value;
    if (blueprintHashForReference(coordinates) !== value.blueprintHash) {
      context.addIssue({
        code: "custom",
        path: ["blueprintHash"],
        message: "Reference blueprint hash does not match its coordinates",
      });
    }
  });

const visualPaletteV3Schema = z
  .object({
    canvas: z.string().regex(/^#[a-f0-9]{6}$/u),
    ink: z.string().regex(/^#[a-f0-9]{6}$/u),
    accent: z.string().regex(/^#[a-f0-9]{6}$/u),
    muted: z.string().regex(/^#[a-f0-9]{6}$/u),
  })
  .strict();

function visualRelativeLuminanceV3(hex: string) {
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

function visualContrastRatioV3(left: string, right: string) {
  const leftLuminance = visualRelativeLuminanceV3(left);
  const rightLuminance = visualRelativeLuminanceV3(right);
  return (
    (Math.max(leftLuminance, rightLuminance) + 0.05) /
    (Math.min(leftLuminance, rightLuminance) + 0.05)
  );
}

export function visualPaletteContrastFailuresV3(
  palette: z.infer<typeof visualPaletteV3Schema>,
) {
  return [
    ["ink/canvas", palette.ink, palette.canvas, 7],
    ["accent/canvas", palette.accent, palette.canvas, 4.5],
    ["ink/muted", palette.ink, palette.muted, 4.5],
    ["accent/muted", palette.accent, palette.muted, 4.5],
  ]
    .filter(
      ([, foreground, background, minimum]) =>
        visualContrastRatioV3(foreground as string, background as string) <
        (minimum as number),
    )
    .map(([name]) => name as string);
}

export function assertVisualPaletteContrastV3(
  palette: z.infer<typeof visualPaletteV3Schema>,
) {
  if (visualPaletteContrastFailuresV3(palette).length > 0) {
    throw new Error("SITEOPS_VISUAL_PALETTE_CONTRAST_INVALID");
  }
}

const referenceBlueprintV3BaseSchema = referenceBlueprintV2BaseSchema
  .omit({ schemaVersion: true })
  .extend({
    schemaVersion: z.literal(3),
    heroFamily: frontMindVisualFamilyV3Schema,
    previewLocalAssetId: z.string().uuid(),
    palette: visualPaletteV3Schema,
    typeSystem: z.enum([
      "display_sans",
      "editorial_serif",
      "technical_sans",
      "humanist_sans",
    ]),
    componentManifest: z.array(z.string().trim().min(1).max(96)).min(2).max(16),
    inspirationEvidenceIds: z.array(sha256Schema).min(1).max(3),
  })
  .strict();

/** V3 is a host-rendered, WYSIWYG visual contract. The provider evidence is
 * retained only as inspiration coordinates; the preview and component family
 * are both produced by FrontMind's trusted React host. */
export const referenceBlueprintV3Schema = referenceBlueprintV3BaseSchema
  .extend({ blueprintHash: sha256Schema })
  .strict()
  .superRefine((value, context) => {
    const { blueprintHash: _blueprintHash, ...coordinates } = value;
    if (blueprintHashForReference(coordinates) !== value.blueprintHash) {
      context.addIssue({
        code: "custom",
        path: ["blueprintHash"],
        message: "Reference blueprint hash does not match its coordinates",
      });
    }
    const expectedHeroComponent = `hero:${value.heroFamily}`;
    if (!value.componentManifest.includes(expectedHeroComponent)) {
      context.addIssue({
        code: "custom",
        path: ["componentManifest"],
        message: "Reference blueprint does not freeze its trusted Hero family",
      });
    }
    const contrastFailures = visualPaletteContrastFailuresV3(value.palette);
    if (contrastFailures.length > 0) {
      context.addIssue({
        code: "custom",
        path: ["palette"],
        message: `Reference blueprint palette does not meet trusted contrast: ${contrastFailures.join(", ")}`,
      });
    }
  });

const TRUSTED_VISUAL_RENDER_COORDINATES_V4 = [
  "heroFamily",
  "palette",
  "typeSystem",
  "alignment",
  "contentEmphasis",
  "mediaRegion",
  "mediaRatio",
  "composition",
  "backgroundStyle",
  "gradientStyle",
  "borderStyle",
  "radiusStyle",
  "decorationStyle",
  "navStyle",
  "ctaStyle",
  "cardStyle",
  "containerStyle",
  "typographyStyle",
  "density",
  "responsiveBehavior",
  "motionLevel",
  "mediaStrategy",
] as const;

function visualStyleSignatureFromObjectV4(blueprint: Record<string, unknown>) {
  return canonicalSiteOpsSha256(
    Object.fromEntries(
      TRUSTED_VISUAL_RENDER_COORDINATES_V4.map((coordinate) => [
        coordinate,
        blueprint[coordinate],
      ]),
    ),
  );
}

const referenceBlueprintV4BaseSchema = referenceBlueprintV3BaseSchema
  .omit({ schemaVersion: true })
  .extend({
    schemaVersion: z.literal(4),
    /** The immutable provider image shown as the 21st reference. The inherited
     * `preview*` coordinates point to the separately rendered FrontMind
     * realization. Keeping both pairs in the blueprint prevents either image
     * from being silently substituted for the other. */
    referencePreviewLocalAssetId: z.string().uuid(),
    referencePreviewSha256: sha256Schema,
    inspirationTaxonomySha256: sha256Schema,
    styleSignature: sha256Schema,
  })
  .strict();

/** V4 closes over one provider reference, one independently rendered
 * realization, and one taxonomy. V3 remains in the read union below for
 * immutable historical builds, while newly generated boards use V4. */
export const referenceBlueprintV4Schema = referenceBlueprintV4BaseSchema
  .extend({ blueprintHash: sha256Schema })
  .strict()
  .superRefine((value, context) => {
    const { blueprintHash: _blueprintHash, ...coordinates } = value;
    if (blueprintHashForReference(coordinates) !== value.blueprintHash) {
      context.addIssue({
        code: "custom",
        path: ["blueprintHash"],
        message: "Reference blueprint hash does not match its coordinates",
      });
    }
    if (!value.componentManifest.includes(`hero:${value.heroFamily}`)) {
      context.addIssue({
        code: "custom",
        path: ["componentManifest"],
        message: "Reference blueprint does not freeze its trusted Hero family",
      });
    }
    if (value.inspirationEvidenceIds.length !== 1) {
      context.addIssue({
        code: "custom",
        path: ["inspirationEvidenceIds"],
        message: "V4 reference blueprint must bind exactly one inspiration",
      });
    }
    if (
      value.referencePreviewLocalAssetId === value.previewLocalAssetId ||
      value.referencePreviewSha256 === value.previewSha256
    ) {
      context.addIssue({
        code: "custom",
        path: ["referencePreviewSha256"],
        message: "V4 reference and realization previews must be independent",
      });
    }
    const contrastFailures = visualPaletteContrastFailuresV3(value.palette);
    if (contrastFailures.length > 0) {
      context.addIssue({
        code: "custom",
        path: ["palette"],
        message: `Reference blueprint palette does not meet trusted contrast: ${contrastFailures.join(", ")}`,
      });
    }
    if (visualStyleSignatureFromObjectV4(value) !== value.styleSignature) {
      context.addIssue({
        code: "custom",
        path: ["styleSignature"],
        message: "V4 style signature does not match its render coordinates",
      });
    }
  });

export const referenceBlueprintSchema = z.union([
  referenceBlueprintV4Schema,
  referenceBlueprintV3Schema,
  referenceBlueprintV2Schema,
]);

function immutableReferencePreviewSha256(
  blueprint: z.infer<typeof referenceBlueprintSchema>,
) {
  return blueprint.schemaVersion === 4
    ? blueprint.referencePreviewSha256
    : blueprint.previewSha256;
}

export const siteDesignSpecV2Schema = z
  .object({
    schemaVersion: z.literal(2),
    referenceBlueprint: referenceBlueprintSchema,
    layoutArchetype: siteLayoutArchetypeSchema,
    density: z.enum(["compact", "balanced", "spacious"]),
    surfaceStyle: z.enum(["flat", "bordered", "soft_depth", "layered"]),
    typeScale: z.enum(["restrained", "editorial", "display"]),
    imageTreatment: z.enum(["contained", "wide", "masked", "none"]),
    motionLevel: z.enum(["none", "subtle"]),
    colorRoles: z
      .object({
        backgroundPaletteIndex: z.number().int().nonnegative().max(11),
        textPaletteIndex: z.number().int().nonnegative().max(11),
        accentPaletteIndex: z.number().int().nonnegative().max(11),
      })
      .strict(),
    routeCompositions: z
      .array(
        z
          .object({
            routeId: z.string().trim().min(1).max(64),
            slots: z
              .array(
                z
                  .object({
                    slotId: z
                      .string()
                      .trim()
                      .regex(/^[a-z][a-z0-9_-]{0,63}$/u),
                    variant: siteSectionVariantSchema,
                  })
                  .strict(),
              )
              .min(1)
              .max(16),
          })
          .strict(),
      )
      .min(1)
      .max(30),
    seoPlan: siteSeoPlanSchema,
  })
  .strict();

export const pageContentSpecV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    routes: z
      .array(
        z
          .object({
            routeId: z.string().trim().min(1).max(64),
            eyebrow: z.string().trim().min(1).max(100).optional(),
            heading: z.string().trim().min(1).max(180),
            summary: z.string().trim().min(1).max(600),
            sections: z
              .array(
                z
                  .object({
                    slotId: z
                      .string()
                      .trim()
                      .regex(/^[a-z][a-z0-9_-]{0,63}$/u),
                    heading: z.string().trim().min(1).max(160),
                    paragraphs: z
                      .array(z.string().trim().min(1).max(2_000))
                      .min(1)
                      .max(8),
                    sourceDocumentIds: z
                      .array(z.string().trim().min(1).max(191))
                      .min(1)
                      .max(30),
                  })
                  .strict(),
              )
              .min(1)
              .max(16),
          })
          .strict(),
      )
      .min(1)
      .max(30),
  })
  .strict();

export const siteContentBlockTypeSchema = z.enum([
  "prose",
  "feature_list",
  "steps",
  "metrics",
  "quote",
  "entity_grid",
  "faq_preview",
  "cta",
]);

export const siteContentEntityTypeSchema = z.enum([
  "product",
  "service",
  "application",
  "case_study",
  "blog",
  "company_news",
]);

export const siteContentEntitySlugSchema = z
  .string()
  .trim()
  .regex(/^[a-z0-9](?:[a-z0-9_-]{0,62})$/u);

export function canonicalSiteContentEntitySlug(slug: string, entityId: string) {
  const parsed = siteContentEntitySlugSchema.safeParse(slug);
  return parsed.success ? parsed.data : entityId;
}

const sourceBoundIdsSchema = z
  .array(z.string().trim().min(1).max(191))
  .min(1)
  .max(50);
const optionalSourceBoundIdsSchema = z
  .array(z.string().trim().min(1).max(191))
  .max(50);

const nullableContentDateSchema = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z)?$/u)
  .nullable();

/** React Static 2.2 canonical content. Semantic block types and knowledge
 * entities are kept separate from the frozen visual slot variants, so the
 * provider cannot turn a content choice into an arbitrary component name. */
export const pageContentSpecV2Schema = z
  .object({
    schemaVersion: z.literal(2),
    routes: z
      .array(
        z
          .object({
            routeId: z.string().trim().min(1).max(64),
            eyebrow: z.string().trim().min(1).max(100).optional(),
            heading: z.string().trim().min(1).max(180),
            summary: z.string().trim().min(1).max(600),
            emptyState: z.literal("company_news_unavailable").optional(),
            sections: z
              .array(
                z
                  .object({
                    slotId: z
                      .string()
                      .trim()
                      .regex(/^[a-z][a-z0-9_-]{0,63}$/u),
                    blockType: siteContentBlockTypeSchema,
                    heading: z.string().trim().min(1).max(160),
                    paragraphs: z
                      .array(z.string().trim().min(1).max(2_000))
                      .max(16),
                    items: z.array(z.string().trim().min(1).max(500)).max(24),
                    entityIds: z
                      .array(z.string().trim().min(1).max(64))
                      .max(24),
                    faqIds: z.array(z.string().trim().min(1).max(64)).max(24),
                    sourceDocumentIds: optionalSourceBoundIdsSchema,
                    grounding: z.literal("host_placeholder").optional(),
                  })
                  .strict(),
              )
              .min(0)
              .max(16),
          })
          .strict(),
      )
      .min(1)
      .max(30),
    entities: z
      .array(
        z
          .object({
            entityId: z
              .string()
              .trim()
              .regex(/^[a-z][a-z0-9_-]{0,63}$/u),
            entityType: siteContentEntityTypeSchema,
            slug: siteContentEntitySlugSchema,
            title: z.string().trim().min(1).max(180),
            summary: z.string().trim().min(1).max(600),
            body: z.array(z.string().trim().min(1).max(2_000)).min(1).max(24),
            tags: z.array(z.string().trim().min(1).max(80)).max(20),
            publishedAt: nullableContentDateSchema,
            modifiedAt: nullableContentDateSchema,
            author: z.string().trim().min(1).max(160).nullable(),
            sourceName: z.string().trim().min(1).max(255).nullable(),
            sourceUrl: z.string().url().max(2_048).nullable(),
            sourceDocumentIds: sourceBoundIdsSchema,
            relatedEntityIds: z.array(z.string().trim().min(1).max(64)).max(20),
          })
          .strict(),
      )
      .max(120),
    faqs: z
      .array(
        z
          .object({
            faqId: z
              .string()
              .trim()
              .regex(/^[a-z][a-z0-9_-]{0,63}$/u),
            category: z.string().trim().min(1).max(100).nullable(),
            question: z.string().trim().min(1).max(300),
            answers: z.array(z.string().trim().min(1).max(2_000)).min(1).max(8),
            sourceDocumentIds: sourceBoundIdsSchema,
          })
          .strict(),
      )
      .max(120),
    officialLinks: z
      .array(
        z
          .object({
            kind: z.enum(["same_as", "reference"]),
            label: z.string().trim().min(1).max(120),
            url: z.string().url().max(2_048),
            sourceDocumentIds: sourceBoundIdsSchema,
          })
          .strict(),
      )
      .max(30),
  })
  .strict()
  .superRefine((value, context) => {
    const routeIds = new Set(value.routes.map((route) => route.routeId));
    if (routeIds.size !== value.routes.length) {
      context.addIssue({
        code: "custom",
        path: ["routes"],
        message: "Content route ids must be unique",
      });
    }
    for (const [routeIndex, route] of value.routes.entries()) {
      const emptyNews = route.emptyState === "company_news_unavailable";
      if (
        (emptyNews &&
          (route.routeId !== "news" || route.sections.length > 0)) ||
        (!emptyNews && route.sections.length < 1)
      ) {
        context.addIssue({
          code: "custom",
          path: ["routes", routeIndex],
          message:
            "Only the company-news route may use the host-owned empty state",
        });
      }
      if (
        new Set(route.sections.map((section) => section.slotId)).size !==
        route.sections.length
      ) {
        context.addIssue({
          code: "custom",
          path: ["routes", routeIndex, "sections"],
          message: "Content block slot ids must be unique within a route",
        });
      }
      if (
        route.sections.some((section) => {
          if (emptyNews) return false;
          if (section.grounding !== "host_placeholder") {
            return section.sourceDocumentIds.length < 1;
          }
          return !(
            section.sourceDocumentIds.length === 0 &&
            section.blockType === "prose" &&
            section.heading === route.heading &&
            section.paragraphs.length === 1 &&
            section.paragraphs[0] ===
              "本页面暂无可由已验证资料公开展示的内容。" &&
            section.items.length === 0 &&
            section.entityIds.length === 0 &&
            section.faqIds.length === 0
          );
        })
      ) {
        context.addIssue({
          code: "custom",
          path: ["routes", routeIndex, "sections", "sourceDocumentIds"],
          message:
            "Every factual content block must bind to snapshot sources; host placeholders must use the fixed non-factual form",
        });
      }
      for (const [sectionIndex, section] of route.sections.entries()) {
        if (
          ["prose", "quote", "cta"].includes(section.blockType) &&
          section.paragraphs.length < 1
        ) {
          context.addIssue({
            code: "custom",
            path: [
              "routes",
              routeIndex,
              "sections",
              sectionIndex,
              "paragraphs",
            ],
            message: "Text-led content blocks require canonical paragraphs",
          });
        }
        if (
          ["feature_list", "steps", "metrics"].includes(section.blockType) &&
          section.items.length < 1
        ) {
          context.addIssue({
            code: "custom",
            path: ["routes", routeIndex, "sections", sectionIndex, "items"],
            message: "Item-led content blocks require canonical items",
          });
        }
      }
    }
    const entityIds = new Set(value.entities.map((entity) => entity.entityId));
    const routeKeys = new Set(
      value.entities.map((entity) => `${entity.entityType}:${entity.slug}`),
    );
    if (
      entityIds.size !== value.entities.length ||
      routeKeys.size !== value.entities.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["entities"],
        message: "Content entity ids and type/slug routes must be unique",
      });
    }
    if (
      value.entities.some((entity) =>
        entity.relatedEntityIds.some((id) => !entityIds.has(id)),
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["entities", "relatedEntityIds"],
        message: "Related content entity is absent",
      });
    }
    const faqIds = new Set(value.faqs.map((faq) => faq.faqId));
    if (faqIds.size !== value.faqs.length) {
      context.addIssue({
        code: "custom",
        path: ["faqs"],
        message: "FAQ ids must be unique",
      });
    }
    if (
      value.routes.some((route) =>
        route.sections.some(
          (section) =>
            section.entityIds.some((id) => !entityIds.has(id)) ||
            section.faqIds.some((id) => !faqIds.has(id)),
        ),
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["routes", "sections"],
        message: "Typed content block references an absent entity or FAQ",
      });
    }
    if (
      value.routes.some((route) =>
        route.sections.some(
          (section) =>
            (section.blockType === "entity_grid" &&
              section.entityIds.length < 1) ||
            (section.blockType === "faq_preview" && section.faqIds.length < 1),
        ),
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["routes", "sections", "blockType"],
        message:
          "Typed collection blocks must reference their canonical records",
      });
    }
  });

export const siteDesignResultV1Schema = z
  .object({
    operationToken: z.string().min(1).max(128),
    designSpec: siteDesignSpecV1Schema,
  })
  .strict();
export const siteDesignResultV2Schema = z
  .object({
    operationToken: z.string().min(1).max(128),
    designSpec: siteDesignSpecV2Schema,
  })
  .strict();
export const pageContentResultV1Schema = z
  .object({
    operationToken: z.string().min(1).max(128),
    pageContent: pageContentSpecV1Schema,
  })
  .strict();
export const pageContentResultV2Schema = z
  .object({
    operationToken: z.string().min(1).max(128),
    pageContent: pageContentSpecV2Schema,
  })
  .strict();

export const siteOpsRuntimeVisualEvidenceV1Schema = z
  .object({
    queryHash: sha256Schema,
    selectedCandidateId: z.string().trim().min(1).max(191),
    providerItemKey: z.string().trim().min(1).max(512),
    visualEvidenceSha256: sha256Schema,
    previewSha256: sha256Schema,
    supportEvidenceSha256s: z.array(sha256Schema).max(2).default([]),
    taxonomy: visualTaxonomySchema,
  })
  .strict();

export const siteOpsRuntimeVisualEvidenceV2Schema =
  siteOpsRuntimeVisualEvidenceV1Schema
    .extend({
      schemaVersion: z.literal(2),
      referenceBlueprint: referenceBlueprintSchema,
    })
    .strict()
    .superRefine((value, context) => {
      if (
        value.selectedCandidateId !== value.referenceBlueprint.candidateId ||
        value.providerItemKey !== value.referenceBlueprint.providerItemKey ||
        value.previewSha256 !==
          immutableReferencePreviewSha256(value.referenceBlueprint)
      ) {
        context.addIssue({
          code: "custom",
          path: ["referenceBlueprint"],
          message: "Reference blueprint does not match frozen visual evidence",
        });
      }
    });

export const buildContractV2Schema = z
  .object({
    schemaVersion: z.literal(2),
    source: z
      .object({
        knowledgeSnapshotId: z.string().uuid(),
        archiveSha256: sha256Schema,
        sourceBuildId: z.string().max(191).nullable(),
        sourceBuildRevision: z.number().int().nonnegative().nullable(),
      })
      .strict(),
    workflow: z
      .object({
        upstreamSha256: sha256Schema,
        version: z.string().max(32),
        manifestSha256: sha256Schema,
        starterVersion: z.string().max(32),
        starterSha256: sha256Schema,
        componentLibraryVersion: z.string().max(32),
        materializerVersion: z.string().max(32),
        materializerSha256: sha256Schema,
      })
      .strict(),
    identity: z
      .object({
        companyName: z.string().min(1).max(255),
        primaryLanguage: z.string().min(2).max(32),
        verifiedContacts: z.array(z.string().max(512)).max(20),
      })
      .strict(),
    visual: siteOpsRuntimeVisualEvidenceV1Schema
      .extend({
        designSpecHash: sha256Schema,
        componentLibraryVersion: z.string().max(32),
      })
      .strict(),
    routes: siteBriefSchema.shape.routes,
    assets: z
      .array(
        z
          .object({
            id: z.string().max(191),
            sha256: sha256Schema,
            decision: z.enum(["publish", "omit", "quarantine"]),
          })
          .strict(),
      )
      .max(500),
    seo: siteSeoPlanSchema
      .extend({
        environment: z.enum(["preview", "production"]),
        canonicalPolicy: z.enum(["forbidden", "exact_https_origin"]),
      })
      .strict(),
    target: z
      .object({
        environment: z.enum(["preview", "global_excluding_cn", "mainland_cn"]),
        canonicalOrigin: z.string().url().nullable(),
      })
      .strict(),
    qaPolicyVersion: z.string().max(64),
    specHash: sha256Schema,
  })
  .strict();

const buildPlanContractV3BaseSchema = z
  .object({
    schemaVersion: z.literal(3),
    contractKind: z.literal("build_plan"),
    source: buildContractV2Schema.shape.source,
    workflow: buildContractV2Schema.shape.workflow,
    renderer: z
      .object({
        kind: z.literal("react_static_v1"),
        reactVersion: z.string().trim().min(1).max(32),
        componentLibraryVersion: z.enum(["2.0.0", "2.1.0"]),
        materializerVersion: z.enum(["2.0.0", "2.1.0"]),
      })
      .strict(),
    identity: buildContractV2Schema.shape.identity,
    visual: siteOpsRuntimeVisualEvidenceV1Schema,
    referenceBlueprint: referenceBlueprintSchema,
    designSpecHash: sha256Schema,
    routes: buildContractV2Schema.shape.routes,
    assets: buildContractV2Schema.shape.assets,
    seo: buildContractV2Schema.shape.seo,
    target: buildContractV2Schema.shape.target,
    qaPolicyVersion: z.string().max(64),
    specHash: sha256Schema,
  })
  .strict();

function validateBuildContractV3Coordinates(
  value: Pick<
    z.infer<typeof buildPlanContractV3BaseSchema>,
    "visual" | "referenceBlueprint" | "workflow" | "renderer"
  >,
  context: z.RefinementCtx,
) {
  if (
    value.visual.selectedCandidateId !== value.referenceBlueprint.candidateId ||
    value.visual.providerItemKey !== value.referenceBlueprint.providerItemKey ||
    value.visual.previewSha256 !==
      immutableReferencePreviewSha256(value.referenceBlueprint)
  ) {
    context.addIssue({
      code: "custom",
      path: ["referenceBlueprint"],
      message: "Build contract blueprint does not match visual evidence",
    });
  }
  if (
    value.workflow.componentLibraryVersion !==
      value.renderer.componentLibraryVersion ||
    value.workflow.materializerVersion !== value.renderer.materializerVersion
  ) {
    context.addIssue({
      code: "custom",
      path: ["renderer"],
      message: "Renderer coordinates do not match workflow coordinates",
    });
  }
}

/** Pre-materialization projection sent to the content phase of the same AI
 * task. It is deliberately not named BuildContract: artifact digests do not
 * exist yet. */
export const buildPlanContractV3Schema =
  buildPlanContractV3BaseSchema.superRefine(validateBuildContractV3Coordinates);

/** Final immutable host contract. `sourceHash` is the digest of canonical
 * source entries excluding build-contract.json, so the contract cannot hash
 * itself. */
export const buildContractV3Schema = buildPlanContractV3BaseSchema
  .omit({ contractKind: true })
  .extend({
    contractKind: z.literal("build_contract"),
    sourceHash: sha256Schema,
    distHash: sha256Schema,
  })
  .strict()
  .superRefine(validateBuildContractV3Coordinates);

const contentContractCoordinatesV4Schema = z
  .object({
    schemaVersion: z.literal(2),
    inventoryHash: sha256Schema,
    routePolicyVersion: z.literal("snapshot-conditional-v1"),
    sourcePolicy: z.literal("frozen_snapshot_only"),
    externalAcquisitionAllowed: z.literal(false),
    publicSourceLabels: z.literal("forbidden"),
  })
  .strict();

const buildPlanContractV4BaseSchema = buildPlanContractV3BaseSchema
  .omit({ schemaVersion: true, renderer: true })
  .extend({
    schemaVersion: z.literal(4),
    renderer: z
      .object({
        kind: z.literal("react_static_v2"),
        reactVersion: z.literal("19.2.1"),
        componentLibraryVersion: z.enum(["2.2.0", "2.3.0", "2.4.0", "2.6.0"]),
        materializerVersion: z.enum(["2.2.0", "2.3.0", "2.4.0", "2.6.0"]),
      })
      .strict(),
    content: contentContractCoordinatesV4Schema,
  })
  .strict();

function validateBuildContractV4Coordinates(
  value: Pick<
    z.infer<typeof buildPlanContractV4BaseSchema>,
    | "visual"
    | "referenceBlueprint"
    | "workflow"
    | "renderer"
    | "qaPolicyVersion"
  >,
  context: z.RefinementCtx,
) {
  if (
    value.visual.selectedCandidateId !== value.referenceBlueprint.candidateId ||
    value.visual.providerItemKey !== value.referenceBlueprint.providerItemKey ||
    value.visual.previewSha256 !==
      immutableReferencePreviewSha256(value.referenceBlueprint)
  ) {
    context.addIssue({
      code: "custom",
      path: ["referenceBlueprint"],
      message: "Build contract blueprint does not match visual evidence",
    });
  }
  const workflowVersion = value.workflow.version;
  const expectedQaPolicyVersion =
    workflowVersion === "2.4.0" || workflowVersion === "2.6.0"
      ? "siteops-qa-v5"
      : "siteops-qa-v4";
  if (
    !["2.2.0", "2.3.0", "2.4.0", "2.6.0"].includes(workflowVersion) ||
    value.workflow.starterVersion !== workflowVersion ||
    value.workflow.componentLibraryVersion !== workflowVersion ||
    value.workflow.materializerVersion !== workflowVersion ||
    value.renderer.componentLibraryVersion !== workflowVersion ||
    value.renderer.materializerVersion !== workflowVersion ||
    value.qaPolicyVersion !== expectedQaPolicyVersion
  ) {
    context.addIssue({
      code: "custom",
      path: ["workflow"],
      message:
        "BuildContractV4 requires complete, matching immutable workflow and QA coordinates",
    });
  }
}

/** React Static 2.2 build plan. The frozen inventory hash exists before the
 * provider content phase; the final content-spec hash is added only after the
 * typed graph has validated and materialization has completed. */
export const buildPlanContractV4Schema =
  buildPlanContractV4BaseSchema.superRefine(validateBuildContractV4Coordinates);

export const buildContractV4Schema = buildPlanContractV4BaseSchema
  .omit({ contractKind: true })
  .extend({
    contractKind: z.literal("build_contract"),
    contentSpecHash: sha256Schema,
    sourceHash: sha256Schema,
    distHash: sha256Schema,
  })
  .strict()
  .superRefine(validateBuildContractV4Coordinates);

export type SiteDesignSpecV1 = z.infer<typeof siteDesignSpecV1Schema>;
export type SiteHeroFamily = z.infer<typeof siteHeroFamilySchema>;
export type ReferenceBlueprintV2 = z.infer<typeof referenceBlueprintV2Schema>;
export type ReferenceBlueprintV3 = z.infer<typeof referenceBlueprintV3Schema>;
export type ReferenceBlueprintV4 = z.infer<typeof referenceBlueprintV4Schema>;
export type ReferenceBlueprint = z.infer<typeof referenceBlueprintSchema>;
export type SiteDesignSpecV2 = z.infer<typeof siteDesignSpecV2Schema>;
export type SiteDesignSpec = SiteDesignSpecV1 | SiteDesignSpecV2;
export type PageContentSpecV1 = z.infer<typeof pageContentSpecV1Schema>;
export type PageContentSpecV2 = z.infer<typeof pageContentSpecV2Schema>;
export type PageContentSpec = PageContentSpecV1 | PageContentSpecV2;
export type SiteOpsRuntimeVisualEvidenceV1 = z.infer<
  typeof siteOpsRuntimeVisualEvidenceV1Schema
>;
export type SiteOpsRuntimeVisualEvidenceV2 = z.infer<
  typeof siteOpsRuntimeVisualEvidenceV2Schema
>;
export type BuildContractV2 = z.infer<typeof buildContractV2Schema>;
export type BuildPlanContractV3 = z.infer<typeof buildPlanContractV3Schema>;
export type BuildContractV3 = z.infer<typeof buildContractV3Schema>;
export type BuildPlanContractV4 = z.infer<typeof buildPlanContractV4Schema>;
export type BuildContractV4 = z.infer<typeof buildContractV4Schema>;

function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean")
    return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Non-finite number");
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (!value || typeof value !== "object")
    throw new TypeError("Unsupported canonical JSON value");
  return `{${Object.entries(value)
    .sort(([a], [b]) => a.localeCompare(b, "en"))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
    .join(",")}}`;
}

export function canonicalSiteOpsSha256(value: unknown) {
  return createHash("sha256")
    .update(canonicalJson(value), "utf8")
    .digest("hex");
}

function blueprintHashForReference(value: object) {
  return canonicalSiteOpsSha256(value);
}

export function composeReferenceBlueprintV2(
  input: z.infer<typeof referenceBlueprintV2BaseSchema>,
): ReferenceBlueprintV2 {
  return referenceBlueprintV2Schema.parse({
    ...input,
    blueprintHash: blueprintHashForReference(input),
  });
}

export function composeReferenceBlueprintV3(
  input: z.infer<typeof referenceBlueprintV3BaseSchema>,
): ReferenceBlueprintV3 {
  return referenceBlueprintV3Schema.parse({
    ...input,
    blueprintHash: blueprintHashForReference(input),
  });
}

export function composeReferenceBlueprintV4(
  input: z.infer<typeof referenceBlueprintV4BaseSchema>,
): ReferenceBlueprintV4 {
  return referenceBlueprintV4Schema.parse({
    ...input,
    blueprintHash: blueprintHashForReference(input),
  });
}

type FrozenHeroEligibility = {
  variant?:
    | "centered_statement"
    | "split_media"
    | "editorial_modular"
    | "immersive_visual";
};

export function referenceBlueprintForVisualCandidate(input: {
  candidateId: string;
  providerItemKey: string;
  previewSha256: string;
  title?: string | null;
  sourceUrl?: string | null;
  heroEligibility?: FrozenHeroEligibility | null;
}) {
  const evidence = `${input.title ?? ""} ${input.sourceUrl ?? ""}`
    .normalize("NFKC")
    .toLowerCase();
  const heroFamily = (() => {
    if (input.providerItemKey === "n:8435") return "floating_orbit" as const;
    if (/(?:floating|orbit|hero[-_ ]section[-_ ]7)/u.test(evidence))
      return "floating_orbit" as const;
    if (/(?:bento|masonry|modular)/u.test(evidence)) return "bento" as const;
    if (/(?:feature[-_ ]?(?:grid|hero)|features)/u.test(evidence))
      return "feature_grid" as const;
    if (/(?:full[-_ ]?bleed|fullscreen|full[-_ ]?screen)/u.test(evidence))
      return "full_bleed_statement" as const;
    if (/(?:immersive|cinematic|spatial|\b3d\b)/u.test(evidence))
      return "immersive_visual" as const;
    if (/(?:product[-_ ]?(?:stage|visual)|showcase)/u.test(evidence))
      return "product_stage" as const;
    if (/(?:proof[-_ ]?grid|trust[-_ ]?grid)/u.test(evidence))
      return "proof_grid" as const;
    if (/(?:split|two[-_ ]column|side[-_ ]by[-_ ]side)/u.test(evidence))
      return "split_media" as const;
    if (/(?:editorial|magazine|asymmetric)/u.test(evidence))
      return "editorial" as const;
    if (input.heroEligibility?.variant === "split_media")
      return "split_media" as const;
    if (input.heroEligibility?.variant === "editorial_modular")
      return "editorial" as const;
    if (input.heroEligibility?.variant === "immersive_visual")
      return "immersive_visual" as const;
    return "centered_dual_cta" as const;
  })();

  const familyCoordinates: Record<
    z.infer<typeof siteHeroFamilySchema>,
    Omit<
      z.infer<typeof referenceBlueprintV2BaseSchema>,
      | "schemaVersion"
      | "candidateId"
      | "providerItemKey"
      | "previewSha256"
      | "heroFamily"
    >
  > = {
    floating_orbit: {
      alignment: "center",
      contentEmphasis: "statement",
      mediaRegion: "surround",
      mediaRatio: "square",
      composition: "centered",
      backgroundStyle: "warm_light",
      gradientStyle: "soft_radial",
      borderStyle: "subtle",
      radiusStyle: "rounded",
      decorationStyle: "orbital",
      navStyle: "minimal",
      ctaStyle: "dual",
      cardStyle: "soft_depth",
      containerStyle: "contained",
      typographyStyle: "display",
      density: "spacious",
      responsiveBehavior: "reflow",
      motionLevel: "floating_subtle",
      mediaStrategy: "procedural_brand_svg",
    },
    feature_grid: {
      alignment: "left",
      contentEmphasis: "balanced",
      mediaRegion: "inline",
      mediaRatio: "landscape",
      composition: "modular",
      backgroundStyle: "cool_light",
      gradientStyle: "soft_radial",
      borderStyle: "subtle",
      radiusStyle: "rounded",
      decorationStyle: "grid",
      navStyle: "bordered",
      ctaStyle: "dual",
      cardStyle: "bordered",
      containerStyle: "contained",
      typographyStyle: "technical",
      density: "balanced",
      responsiveBehavior: "stack",
      motionLevel: "subtle",
      mediaStrategy: "procedural_brand_svg",
    },
    bento: {
      alignment: "left",
      contentEmphasis: "balanced",
      mediaRegion: "inline",
      mediaRatio: "landscape",
      composition: "modular",
      backgroundStyle: "cool_light",
      gradientStyle: "mesh",
      borderStyle: "subtle",
      radiusStyle: "rounded",
      decorationStyle: "grid",
      navStyle: "minimal",
      ctaStyle: "single",
      cardStyle: "layered",
      containerStyle: "wide",
      typographyStyle: "display",
      density: "balanced",
      responsiveBehavior: "reflow",
      motionLevel: "subtle",
      mediaStrategy: "procedural_brand_svg",
    },
    split_media: {
      alignment: "left",
      contentEmphasis: "product",
      mediaRegion: "split",
      mediaRatio: "portrait",
      composition: "split",
      backgroundStyle: "warm_light",
      gradientStyle: "soft_radial",
      borderStyle: "none",
      radiusStyle: "soft",
      decorationStyle: "none",
      navStyle: "minimal",
      ctaStyle: "dual",
      cardStyle: "flat",
      containerStyle: "wide",
      typographyStyle: "display",
      density: "spacious",
      responsiveBehavior: "stack",
      motionLevel: "subtle",
      mediaStrategy: "customer_asset",
    },
    editorial: {
      alignment: "left",
      contentEmphasis: "statement",
      mediaRegion: "inline",
      mediaRatio: "wide",
      composition: "editorial",
      backgroundStyle: "warm_light",
      gradientStyle: "none",
      borderStyle: "subtle",
      radiusStyle: "none",
      decorationStyle: "editorial_lines",
      navStyle: "minimal",
      ctaStyle: "text_link",
      cardStyle: "flat",
      containerStyle: "wide",
      typographyStyle: "editorial",
      density: "spacious",
      responsiveBehavior: "reflow",
      motionLevel: "none",
      mediaStrategy: "procedural_brand_svg",
    },
    centered_dual_cta: {
      alignment: "center",
      contentEmphasis: "statement",
      mediaRegion: "none",
      mediaRatio: "none",
      composition: "centered",
      backgroundStyle: "warm_light",
      gradientStyle: "soft_radial",
      borderStyle: "none",
      radiusStyle: "pill",
      decorationStyle: "glow",
      navStyle: "minimal",
      ctaStyle: "dual",
      cardStyle: "flat",
      containerStyle: "contained",
      typographyStyle: "display",
      density: "spacious",
      responsiveBehavior: "stack",
      motionLevel: "subtle",
      mediaStrategy: "none",
    },
    immersive_visual: {
      alignment: "center",
      contentEmphasis: "statement",
      mediaRegion: "full_bleed",
      mediaRatio: "wide",
      composition: "immersive",
      backgroundStyle: "image_stage",
      gradientStyle: "spotlight",
      borderStyle: "none",
      radiusStyle: "none",
      decorationStyle: "glow",
      navStyle: "floating",
      ctaStyle: "dual",
      cardStyle: "layered",
      containerStyle: "edge_to_edge",
      typographyStyle: "display",
      density: "spacious",
      responsiveBehavior: "crop_safe",
      motionLevel: "subtle",
      mediaStrategy: "procedural_brand_svg",
    },
    product_stage: {
      alignment: "center",
      contentEmphasis: "product",
      mediaRegion: "inline",
      mediaRatio: "landscape",
      composition: "centered",
      backgroundStyle: "gradient",
      gradientStyle: "spotlight",
      borderStyle: "subtle",
      radiusStyle: "rounded",
      decorationStyle: "glow",
      navStyle: "floating",
      ctaStyle: "dual",
      cardStyle: "soft_depth",
      containerStyle: "wide",
      typographyStyle: "technical",
      density: "spacious",
      responsiveBehavior: "reflow",
      motionLevel: "subtle",
      mediaStrategy: "customer_asset",
    },
    proof_grid: {
      alignment: "left",
      contentEmphasis: "proof",
      mediaRegion: "inline",
      mediaRatio: "landscape",
      composition: "modular",
      backgroundStyle: "cool_light",
      gradientStyle: "none",
      borderStyle: "defined",
      radiusStyle: "soft",
      decorationStyle: "grid",
      navStyle: "bordered",
      ctaStyle: "single",
      cardStyle: "bordered",
      containerStyle: "contained",
      typographyStyle: "technical",
      density: "balanced",
      responsiveBehavior: "stack",
      motionLevel: "none",
      mediaStrategy: "none",
    },
    full_bleed_statement: {
      alignment: "center",
      contentEmphasis: "statement",
      mediaRegion: "full_bleed",
      mediaRatio: "wide",
      composition: "immersive",
      backgroundStyle: "dark",
      gradientStyle: "spotlight",
      borderStyle: "none",
      radiusStyle: "none",
      decorationStyle: "glow",
      navStyle: "floating",
      ctaStyle: "single",
      cardStyle: "flat",
      containerStyle: "edge_to_edge",
      typographyStyle: "display",
      density: "spacious",
      responsiveBehavior: "crop_safe",
      motionLevel: "subtle",
      mediaStrategy: "procedural_brand_svg",
    },
  };
  return composeReferenceBlueprintV2({
    schemaVersion: 2,
    candidateId: input.candidateId,
    providerItemKey: input.providerItemKey,
    previewSha256: input.previewSha256,
    heroFamily,
    ...familyCoordinates[heroFamily],
  });
}

export const FRONTMIND_VISUAL_FAMILY_LABELS_V3: Record<
  (typeof FRONTMIND_VISUAL_FAMILIES_V3)[number],
  string
> = {
  floating_orbit: "浮动轨道式",
  split_media: "分屏媒体式",
  editorial: "编辑杂志式",
  bento: "Bento 模块式",
  feature_grid: "功能网格式",
  centered_dual_cta: "极简双按钮式",
  immersive_visual: "沉浸视觉式",
  product_stage: "产品舞台式",
  full_bleed_statement: "全幅宣言式",
};

const FRONTMIND_VISUAL_PALETTES_V3: Record<
  (typeof FRONTMIND_VISUAL_FAMILIES_V3)[number],
  z.infer<typeof visualPaletteV3Schema>
> = {
  floating_orbit: {
    canvas: "#f7f1e8",
    ink: "#1f2937",
    accent: "#a34805",
    muted: "#eadfce",
  },
  split_media: {
    canvas: "#f5f7ff",
    ink: "#111827",
    accent: "#4338ca",
    muted: "#e0e7ff",
  },
  editorial: {
    canvas: "#f4efe5",
    ink: "#171717",
    accent: "#991b1b",
    muted: "#e7dccb",
  },
  bento: {
    canvas: "#eff9f4",
    ink: "#10382e",
    accent: "#047451",
    muted: "#d5eee2",
  },
  feature_grid: {
    canvas: "#f1f5f9",
    ink: "#0f172a",
    accent: "#0369a1",
    muted: "#dbeafe",
  },
  centered_dual_cta: {
    canvas: "#fff7ed",
    ink: "#2d1b14",
    accent: "#c2410c",
    muted: "#ffedd5",
  },
  immersive_visual: {
    canvas: "#070b1b",
    ink: "#f8fafc",
    accent: "#a78bfa",
    muted: "#1e1b4b",
  },
  product_stage: {
    canvas: "#f8fafc",
    ink: "#0b132b",
    accent: "#1d4ed8",
    muted: "#dbeafe",
  },
  full_bleed_statement: {
    canvas: "#14110f",
    ink: "#fff7ed",
    accent: "#fb7185",
    muted: "#3f2d32",
  },
};

type VisualInspirationTaxonomyV3 = Pick<
  z.infer<typeof visualTaxonomySchema>,
  "palette" | "typography" | "layout" | "motion" | "accessibility"
>;

export type TrustedVisualPreviewBlueprintV3 = Pick<
  ReferenceBlueprintV3,
  | "heroFamily"
  | "palette"
  | "typeSystem"
  | "density"
  | "decorationStyle"
  | "backgroundStyle"
  | "gradientStyle"
  | "typographyStyle"
  | "radiusStyle"
  | "motionLevel"
>;

/** Every V4 preview coordinate is render-authoritative. Identifiers, hashes,
 * evidence pointers and component manifests are deliberately excluded. */
export type TrustedVisualPreviewBlueprintV4 = Pick<
  ReferenceBlueprintV4,
  (typeof TRUSTED_VISUAL_RENDER_COORDINATES_V4)[number]
>;

export type VisualInspirationTaxonomyV4 = z.infer<typeof visualTaxonomySchema>;

/** A semantic signature of the complete visual language. Asset ids, provider
 * ids and evidence hashes cannot make two otherwise identical styles appear
 * distinct. */
export function visualStyleSignatureV4(
  blueprint: TrustedVisualPreviewBlueprintV4,
) {
  return visualStyleSignatureFromObjectV4(blueprint);
}

export const FRONTMIND_VISUAL_DIVERSITY_MINIMUMS_V4 = {
  backgrounds: 3,
  typeSystems: 3,
  palettes: 4,
  compositions: 4,
} as const;

function paletteSignatureV4(
  palette: TrustedVisualPreviewBlueprintV4["palette"],
) {
  return [palette.canvas, palette.ink, palette.accent, palette.muted].join(":");
}

/** Returns diagnostics suitable for both the provider boundary and tests.
 * This helper intentionally evaluates semantic coordinates, not PNG hashes. */
export function visualBlueprintDiversityReportV4(
  blueprints: readonly TrustedVisualPreviewBlueprintV4[],
) {
  const uniqueFamilies = new Set(
    blueprints.map((blueprint) => blueprint.heroFamily),
  ).size;
  const uniqueStyleSignatures = new Set(blueprints.map(visualStyleSignatureV4))
    .size;
  const uniqueBackgrounds = new Set(
    blueprints.map((blueprint) => blueprint.backgroundStyle),
  ).size;
  const uniqueTypeSystems = new Set(
    blueprints.map((blueprint) => blueprint.typeSystem),
  ).size;
  const uniquePalettes = new Set(
    blueprints.map((blueprint) => paletteSignatureV4(blueprint.palette)),
  ).size;
  const uniqueCompositions = new Set(
    blueprints.map((blueprint) => blueprint.composition),
  ).size;
  const violations: string[] = [];
  if (blueprints.length !== FRONTMIND_VISUAL_FAMILIES_V3.length) {
    violations.push("candidate_count");
  }
  if (uniqueFamilies !== blueprints.length) violations.push("hero_family");
  if (uniqueStyleSignatures !== blueprints.length) {
    violations.push("style_signature");
  }
  if (uniqueBackgrounds < FRONTMIND_VISUAL_DIVERSITY_MINIMUMS_V4.backgrounds) {
    violations.push("background_style");
  }
  if (uniqueTypeSystems < FRONTMIND_VISUAL_DIVERSITY_MINIMUMS_V4.typeSystems) {
    violations.push("type_system");
  }
  if (uniquePalettes < FRONTMIND_VISUAL_DIVERSITY_MINIMUMS_V4.palettes) {
    violations.push("palette");
  }
  if (
    uniqueCompositions < FRONTMIND_VISUAL_DIVERSITY_MINIMUMS_V4.compositions
  ) {
    violations.push("composition");
  }
  return {
    candidateCount: blueprints.length,
    uniqueFamilies,
    uniqueStyleSignatures,
    uniqueBackgrounds,
    uniqueTypeSystems,
    uniquePalettes,
    uniqueCompositions,
    violations,
    isDiverse: violations.length === 0,
  };
}

export function assertVisualBlueprintDiversityV4(
  blueprints: readonly TrustedVisualPreviewBlueprintV4[],
) {
  const report = visualBlueprintDiversityReportV4(blueprints);
  if (!report.isDiverse) {
    throw new Error(
      `SITEOPS_VISUAL_DIVERSITY_INVALID:${report.violations.join(",")}`,
    );
  }
  return report;
}

/** The nine locally approved directions, expressed as complete coordinates
 * rather than a shared theme plus nine superficial layout names. */
const FRONTMIND_TRUSTED_VISUAL_BASELINES_V4 = {
  floating_orbit: {
    heroFamily: "floating_orbit",
    palette: {
      canvas: "#050916",
      ink: "#f4f6ff",
      accent: "#5eead4",
      muted: "#172554",
    },
    typeSystem: "display_sans",
    alignment: "center",
    contentEmphasis: "statement",
    mediaRegion: "surround",
    mediaRatio: "square",
    composition: "centered",
    backgroundStyle: "dark",
    gradientStyle: "mesh",
    borderStyle: "subtle",
    radiusStyle: "rounded",
    decorationStyle: "orbital",
    navStyle: "floating",
    ctaStyle: "pill",
    cardStyle: "soft_depth",
    containerStyle: "contained",
    typographyStyle: "display",
    density: "spacious",
    responsiveBehavior: "reflow",
    motionLevel: "floating_subtle",
    mediaStrategy: "procedural_brand_svg",
  },
  split_media: {
    heroFamily: "split_media",
    palette: {
      canvas: "#f0e8da",
      ink: "#1a1612",
      accent: "#8f2019",
      muted: "#e8ddcc",
    },
    typeSystem: "editorial_serif",
    alignment: "left",
    contentEmphasis: "balanced",
    mediaRegion: "split",
    mediaRatio: "portrait",
    composition: "split",
    backgroundStyle: "warm_light",
    gradientStyle: "none",
    borderStyle: "defined",
    radiusStyle: "none",
    decorationStyle: "editorial_lines",
    navStyle: "bordered",
    ctaStyle: "dual",
    cardStyle: "flat",
    containerStyle: "wide",
    typographyStyle: "editorial",
    density: "spacious",
    responsiveBehavior: "stack",
    motionLevel: "none",
    mediaStrategy: "procedural_brand_svg",
  },
  editorial: {
    heroFamily: "editorial",
    palette: {
      canvas: "#f7f7f2",
      ink: "#11110f",
      accent: "#b9250c",
      muted: "#e5e5df",
    },
    typeSystem: "technical_sans",
    alignment: "left",
    contentEmphasis: "proof",
    mediaRegion: "inline",
    mediaRatio: "landscape",
    composition: "modular",
    backgroundStyle: "cool_light",
    gradientStyle: "none",
    borderStyle: "defined",
    radiusStyle: "none",
    decorationStyle: "grid",
    navStyle: "bordered",
    ctaStyle: "dual",
    cardStyle: "bordered",
    containerStyle: "edge_to_edge",
    typographyStyle: "technical",
    density: "compact",
    responsiveBehavior: "stack",
    motionLevel: "none",
    mediaStrategy: "procedural_brand_svg",
  },
  bento: {
    heroFamily: "bento",
    palette: {
      canvas: "#e5efe4",
      ink: "#19332a",
      accent: "#83351f",
      muted: "#f1ddcd",
    },
    typeSystem: "humanist_sans",
    alignment: "left",
    contentEmphasis: "balanced",
    mediaRegion: "surround",
    mediaRatio: "portrait",
    composition: "modular",
    backgroundStyle: "warm_light",
    gradientStyle: "soft_radial",
    borderStyle: "subtle",
    radiusStyle: "rounded",
    decorationStyle: "orbital",
    navStyle: "minimal",
    ctaStyle: "pill",
    cardStyle: "soft_depth",
    containerStyle: "wide",
    typographyStyle: "restrained",
    density: "spacious",
    responsiveBehavior: "reflow",
    motionLevel: "subtle",
    mediaStrategy: "procedural_brand_svg",
  },
  feature_grid: {
    heroFamily: "feature_grid",
    palette: {
      canvas: "#e9e8ff",
      ink: "#19182b",
      accent: "#5038ce",
      muted: "#f8f7ff",
    },
    typeSystem: "technical_sans",
    alignment: "left",
    contentEmphasis: "product",
    mediaRegion: "split",
    mediaRatio: "landscape",
    composition: "split",
    backgroundStyle: "gradient",
    gradientStyle: "mesh",
    borderStyle: "subtle",
    radiusStyle: "rounded",
    decorationStyle: "glow",
    navStyle: "floating",
    ctaStyle: "pill",
    cardStyle: "layered",
    containerStyle: "wide",
    typographyStyle: "technical",
    density: "balanced",
    responsiveBehavior: "reflow",
    motionLevel: "subtle",
    mediaStrategy: "customer_asset",
  },
  centered_dual_cta: {
    heroFamily: "centered_dual_cta",
    palette: {
      canvas: "#fbfaf5",
      ink: "#25211c",
      accent: "#922a20",
      muted: "#eeeae0",
    },
    typeSystem: "editorial_serif",
    alignment: "left",
    contentEmphasis: "statement",
    mediaRegion: "surround",
    mediaRatio: "square",
    composition: "editorial",
    backgroundStyle: "warm_light",
    gradientStyle: "none",
    borderStyle: "subtle",
    radiusStyle: "none",
    decorationStyle: "editorial_lines",
    navStyle: "minimal",
    ctaStyle: "text_link",
    cardStyle: "flat",
    containerStyle: "contained",
    typographyStyle: "editorial",
    density: "spacious",
    responsiveBehavior: "reflow",
    motionLevel: "none",
    mediaStrategy: "procedural_brand_svg",
  },
  immersive_visual: {
    heroFamily: "immersive_visual",
    palette: {
      canvas: "#1738d1",
      ink: "#ffffff",
      accent: "#f2fa00",
      muted: "#0b1b64",
    },
    typeSystem: "display_sans",
    alignment: "left",
    contentEmphasis: "statement",
    mediaRegion: "split",
    mediaRatio: "landscape",
    composition: "immersive",
    backgroundStyle: "gradient",
    gradientStyle: "spotlight",
    borderStyle: "defined",
    radiusStyle: "none",
    decorationStyle: "grid",
    navStyle: "bordered",
    ctaStyle: "dual",
    cardStyle: "bordered",
    containerStyle: "edge_to_edge",
    typographyStyle: "display",
    density: "compact",
    responsiveBehavior: "crop_safe",
    motionLevel: "subtle",
    mediaStrategy: "procedural_brand_svg",
  },
  product_stage: {
    heroFamily: "product_stage",
    palette: {
      canvas: "#0d0c0b",
      ink: "#f4ecd9",
      accent: "#d6ad5d",
      muted: "#281b0d",
    },
    typeSystem: "editorial_serif",
    alignment: "left",
    contentEmphasis: "product",
    mediaRegion: "split",
    mediaRatio: "square",
    composition: "split",
    backgroundStyle: "dark",
    gradientStyle: "spotlight",
    borderStyle: "subtle",
    radiusStyle: "pill",
    decorationStyle: "orbital",
    navStyle: "floating",
    ctaStyle: "pill",
    cardStyle: "layered",
    containerStyle: "wide",
    typographyStyle: "editorial",
    density: "spacious",
    responsiveBehavior: "crop_safe",
    motionLevel: "floating_subtle",
    mediaStrategy: "procedural_brand_svg",
  },
  full_bleed_statement: {
    heroFamily: "full_bleed_statement",
    palette: {
      canvas: "#eafcff",
      ink: "#082c36",
      accent: "#006374",
      muted: "#d4f1f4",
    },
    typeSystem: "display_sans",
    alignment: "left",
    contentEmphasis: "balanced",
    mediaRegion: "split",
    mediaRatio: "landscape",
    composition: "immersive",
    backgroundStyle: "cool_light",
    gradientStyle: "soft_radial",
    borderStyle: "subtle",
    radiusStyle: "pill",
    decorationStyle: "grid",
    navStyle: "floating",
    ctaStyle: "pill",
    cardStyle: "soft_depth",
    containerStyle: "edge_to_edge",
    typographyStyle: "display",
    density: "balanced",
    responsiveBehavior: "reflow",
    motionLevel: "subtle",
    mediaStrategy: "procedural_brand_svg",
  },
} as const satisfies Record<
  (typeof FRONTMIND_VISUAL_FAMILIES_V3)[number],
  TrustedVisualPreviewBlueprintV4
>;

const INSPIRATION_PALETTE_PACKS_V3 = {
  light: {
    warm: {
      canvas: "#fff7ed",
      ink: "#2d1b14",
      accent: "#a34805",
      muted: "#ffedd5",
    },
    cool: {
      canvas: "#f5f7ff",
      ink: "#111827",
      accent: "#4338ca",
      muted: "#e0e7ff",
    },
    green: {
      canvas: "#f0fdf4",
      ink: "#102a22",
      accent: "#047857",
      muted: "#d1fae5",
    },
    violet: {
      canvas: "#faf5ff",
      ink: "#2e1065",
      accent: "#7e22ce",
      muted: "#f3e8ff",
    },
    neutral: {
      canvas: "#f8fafc",
      ink: "#0f172a",
      accent: "#334155",
      muted: "#e2e8f0",
    },
  },
  dark: {
    warm: {
      canvas: "#18110f",
      ink: "#fff7ed",
      accent: "#fb923c",
      muted: "#3f261d",
    },
    cool: {
      canvas: "#071426",
      ink: "#f8fafc",
      accent: "#60a5fa",
      muted: "#172554",
    },
    green: {
      canvas: "#061a14",
      ink: "#ecfdf5",
      accent: "#34d399",
      muted: "#12372d",
    },
    violet: {
      canvas: "#100b24",
      ink: "#f5f3ff",
      accent: "#c4b5fd",
      muted: "#2e1a5e",
    },
    neutral: {
      canvas: "#0f172a",
      ink: "#f8fafc",
      accent: "#94a3b8",
      muted: "#1e293b",
    },
  },
} as const;

type InspirationHueV3 = keyof (typeof INSPIRATION_PALETTE_PACKS_V3)["light"];

function hexHueBucketV3(value: string): InspirationHueV3 {
  const channels = [1, 3, 5].map(
    (offset) => Number.parseInt(value.slice(offset, offset + 2), 16) / 255,
  );
  const maximum = Math.max(...channels);
  const minimum = Math.min(...channels);
  const delta = maximum - minimum;
  if (delta < 0.12) return "neutral";
  let hue = 0;
  if (maximum === channels[0]) {
    hue = 60 * (((channels[1]! - channels[2]!) / delta) % 6);
  } else if (maximum === channels[1]) {
    hue = 60 * ((channels[2]! - channels[0]!) / delta + 2);
  } else {
    hue = 60 * ((channels[0]! - channels[1]!) / delta + 4);
  }
  if (hue < 0) hue += 360;
  if (hue < 45 || hue >= 330) return "warm";
  if (hue < 160) return "green";
  if (hue < 250) return "cool";
  return "violet";
}

function hexIsDarkV3(value: string) {
  const channels = [1, 3, 5].map(
    (offset) => Number.parseInt(value.slice(offset, offset + 2), 16) / 255,
  );
  const luminance =
    channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722;
  return luminance < 0.42;
}

function projectTrustedInspirationTokensV3(
  taxonomies: readonly VisualInspirationTaxonomyV3[],
) {
  const paletteValues = taxonomies.flatMap((taxonomy) => taxonomy.palette);
  const typographyValues = new Set(
    taxonomies.flatMap((taxonomy) => taxonomy.typography),
  );
  const layoutValues = new Set(
    taxonomies.flatMap((taxonomy) => taxonomy.layout),
  );
  const dominantHex = paletteValues.find((value) =>
    /^#[a-f0-9]{6}$/u.test(value),
  );
  const paletteTokens = new Set(
    paletteValues.filter((value) =>
      [
        "dark-canvas",
        "light-canvas",
        "muted-palette",
        "high-contrast",
        "single-accent",
      ].includes(value),
    ),
  );
  const hasTypographySignal = [
    "display-led-hierarchy",
    "condensed-technical",
    "serif-editorial",
    "neutral-sans",
  ].some((value) => typographyValues.has(value));
  const hasLayoutSignal = [
    "asymmetric-grid",
    "modular-grid",
    "editorial-rhythm",
    "border-defined",
    "soft-shadow-depth",
    "glass-like-layering",
    "rounded-containers",
    "illustration-led",
    "technical-precise",
    "warm-human",
    "premium-restrained",
    "bold-graphic",
  ].some((value) => layoutValues.has(value));
  if (
    !dominantHex &&
    paletteTokens.size === 0 &&
    !hasTypographySignal &&
    !hasLayoutSignal
  ) {
    return null;
  }

  const hasColorSignal =
    Boolean(dominantHex) ||
    paletteTokens.size > 0 ||
    layoutValues.has("warm-human") ||
    layoutValues.has("technical-precise") ||
    layoutValues.has("bold-graphic");

  const dark = paletteTokens.has("dark-canvas")
    ? true
    : paletteTokens.has("light-canvas")
      ? false
      : dominantHex
        ? hexIsDarkV3(dominantHex)
        : false;
  const hue: InspirationHueV3 = dominantHex
    ? hexHueBucketV3(dominantHex)
    : layoutValues.has("warm-human")
      ? "warm"
      : layoutValues.has("technical-precise")
        ? "cool"
        : layoutValues.has("bold-graphic")
          ? "violet"
          : "neutral";
  const typeSystem = typographyValues.has("serif-editorial")
    ? ("editorial_serif" as const)
    : typographyValues.has("condensed-technical") ||
        layoutValues.has("technical-precise")
      ? ("technical_sans" as const)
      : layoutValues.has("warm-human")
        ? ("humanist_sans" as const)
        : hasTypographySignal
          ? ("display_sans" as const)
          : null;
  const density =
    layoutValues.has("modular-grid") || layoutValues.has("technical-precise")
      ? ("compact" as const)
      : layoutValues.has("editorial-rhythm") ||
          layoutValues.has("premium-restrained") ||
          layoutValues.has("warm-human")
        ? ("spacious" as const)
        : null;
  const decorationStyle = layoutValues.has("editorial-rhythm")
    ? ("editorial_lines" as const)
    : layoutValues.has("modular-grid") || layoutValues.has("technical-precise")
      ? ("grid" as const)
      : dark || layoutValues.has("bold-graphic")
        ? ("glow" as const)
        : layoutValues.has("illustration-led") || layoutValues.has("warm-human")
          ? ("orbital" as const)
          : null;
  return {
    palette: hasColorSignal
      ? INSPIRATION_PALETTE_PACKS_V3[dark ? "dark" : "light"][hue]
      : null,
    backgroundStyle: hasColorSignal
      ? dark
        ? ("dark" as const)
        : hue === "warm"
          ? ("warm_light" as const)
          : ("cool_light" as const)
      : null,
    gradientStyle: hasColorSignal && dark ? ("spotlight" as const) : null,
    typographyStyle: typeSystem
      ? typeSystem === "editorial_serif"
        ? ("editorial" as const)
        : typeSystem === "technical_sans"
          ? ("technical" as const)
          : typeSystem === "humanist_sans"
            ? ("restrained" as const)
            : ("display" as const)
      : null,
    typeSystem,
    density,
    decorationStyle,
  };
}

export function trustedVisualPreviewBlueprintV3(
  heroFamily: (typeof FRONTMIND_VISUAL_FAMILIES_V3)[number],
  inspirationTaxonomies: readonly VisualInspirationTaxonomyV3[] = [],
): TrustedVisualPreviewBlueprintV3 {
  const baselineTypeSystem =
    heroFamily === "editorial"
      ? ("editorial_serif" as const)
      : heroFamily === "feature_grid" || heroFamily === "product_stage"
        ? ("technical_sans" as const)
        : heroFamily === "floating_orbit" || heroFamily === "bento"
          ? ("humanist_sans" as const)
          : ("display_sans" as const);
  const baseline = referenceBlueprintForVisualCandidate({
    candidateId: "frontmind-baseline",
    providerItemKey: "s:frontmind:baseline",
    previewSha256: "0".repeat(64),
    title: heroFamily,
  });
  const projected = projectTrustedInspirationTokensV3(inspirationTaxonomies);
  const previewBlueprint = {
    heroFamily,
    palette: projected?.palette ?? FRONTMIND_VISUAL_PALETTES_V3[heroFamily],
    typeSystem: projected?.typeSystem ?? baselineTypeSystem,
    density: projected?.density ?? baseline.density,
    decorationStyle: projected?.decorationStyle ?? baseline.decorationStyle,
    backgroundStyle: projected?.backgroundStyle ?? baseline.backgroundStyle,
    gradientStyle: projected?.gradientStyle ?? baseline.gradientStyle,
    typographyStyle: projected?.typographyStyle ?? baseline.typographyStyle,
    radiusStyle: baseline.radiusStyle,
    motionLevel: baseline.motionLevel,
  };
  assertVisualPaletteContrastV3(previewBlueprint.palette);
  return previewBlueprint;
}

/** Projects one safe taxonomy into one family baseline. The singular argument
 * is intentional: V4 removed the V3 board-wide taxonomy merge that could turn
 * nine structures into one repeated visual theme. */
export function trustedVisualPreviewBlueprintV4(
  heroFamily: (typeof FRONTMIND_VISUAL_FAMILIES_V3)[number],
  inspirationTaxonomy?: VisualInspirationTaxonomyV4,
): TrustedVisualPreviewBlueprintV4 {
  const baseline = FRONTMIND_TRUSTED_VISUAL_BASELINES_V4[heroFamily];
  const projected = inspirationTaxonomy
    ? projectTrustedInspirationTokensV3([inspirationTaxonomy])
    : null;
  const previewBlueprint: TrustedVisualPreviewBlueprintV4 = {
    ...baseline,
    // The family baseline is the trusted diversity floor. A provider
    // reference may refine decorative treatment, but it must not collapse
    // nine independently designed families into one shared colour, type and
    // density system (the production V3 failure mode).
    palette: { ...baseline.palette },
    typeSystem: baseline.typeSystem,
    density: baseline.density,
    decorationStyle: projected?.decorationStyle ?? baseline.decorationStyle,
    backgroundStyle: baseline.backgroundStyle,
    gradientStyle: projected?.gradientStyle ?? baseline.gradientStyle,
    typographyStyle: projected?.typographyStyle ?? baseline.typographyStyle,
  };
  assertVisualPaletteContrastV3(previewBlueprint.palette);
  return previewBlueprint;
}

/** Freezes a real provider reference and its host-rendered realization. The
 * provider taxonomy is required and hashed here, so the factory cannot accept
 * a board-wide theme or an unbound styling summary. */
export function referenceBlueprintV4ForFamily(input: {
  candidateId: string;
  providerItemKey: string;
  referencePreviewLocalAssetId: string;
  referencePreviewSha256: string;
  realizationPreviewLocalAssetId: string;
  realizationPreviewSha256: string;
  heroFamily: (typeof FRONTMIND_VISUAL_FAMILIES_V3)[number];
  inspirationEvidenceId: string;
  inspirationTaxonomy: VisualInspirationTaxonomyV4;
  previewBlueprint?: TrustedVisualPreviewBlueprintV4;
}) {
  const previewBlueprint =
    input.previewBlueprint ??
    trustedVisualPreviewBlueprintV4(
      input.heroFamily,
      input.inspirationTaxonomy,
    );
  if (previewBlueprint.heroFamily !== input.heroFamily) {
    throw new Error("SITEOPS_VISUAL_PREVIEW_FAMILY_MISMATCH");
  }
  assertVisualPaletteContrastV3(previewBlueprint.palette);
  const styleSignature = visualStyleSignatureV4(previewBlueprint);
  return composeReferenceBlueprintV4({
    schemaVersion: 4,
    candidateId: input.candidateId,
    providerItemKey: input.providerItemKey,
    referencePreviewLocalAssetId: input.referencePreviewLocalAssetId,
    referencePreviewSha256: input.referencePreviewSha256,
    previewLocalAssetId: input.realizationPreviewLocalAssetId,
    previewSha256: input.realizationPreviewSha256,
    ...previewBlueprint,
    componentManifest: [
      `hero:${input.heroFamily}`,
      `navigation:${previewBlueprint.navStyle}`,
      `sections:${previewBlueprint.cardStyle}`,
      `cta:${previewBlueprint.ctaStyle}`,
      `container:${previewBlueprint.containerStyle}`,
      `media:${previewBlueprint.mediaRegion}`,
    ],
    inspirationEvidenceIds: [input.inspirationEvidenceId],
    inspirationTaxonomySha256: canonicalSiteOpsSha256(
      input.inspirationTaxonomy,
    ),
    styleSignature,
  });
}

/** Freezes the exact trusted family used to render a V3 candidate preview.
 * Provider metadata can influence the inspiration ledger but cannot change
 * this family or supply executable components. */
export function referenceBlueprintV3ForFamily(input: {
  candidateId: string;
  providerItemKey: string;
  previewLocalAssetId: string;
  previewSha256: string;
  heroFamily: (typeof FRONTMIND_VISUAL_FAMILIES_V3)[number];
  inspirationEvidenceIds: string[];
  previewBlueprint?: TrustedVisualPreviewBlueprintV3;
}) {
  const mapped = referenceBlueprintForVisualCandidate({
    candidateId: input.candidateId,
    providerItemKey: input.providerItemKey,
    previewSha256: input.previewSha256,
    title: input.heroFamily,
  });
  const {
    schemaVersion: _schemaVersion,
    blueprintHash: _blueprintHash,
    ...v2
  } = mapped;
  const previewBlueprint =
    input.previewBlueprint ?? trustedVisualPreviewBlueprintV3(input.heroFamily);
  if (previewBlueprint.heroFamily !== input.heroFamily) {
    throw new Error("SITEOPS_VISUAL_PREVIEW_FAMILY_MISMATCH");
  }
  assertVisualPaletteContrastV3(previewBlueprint.palette);
  return composeReferenceBlueprintV3({
    schemaVersion: 3,
    ...v2,
    heroFamily: input.heroFamily,
    previewLocalAssetId: input.previewLocalAssetId,
    palette: previewBlueprint.palette,
    typeSystem: previewBlueprint.typeSystem,
    density: previewBlueprint.density,
    decorationStyle: previewBlueprint.decorationStyle,
    backgroundStyle: previewBlueprint.backgroundStyle,
    gradientStyle: previewBlueprint.gradientStyle,
    typographyStyle: previewBlueprint.typographyStyle,
    radiusStyle: previewBlueprint.radiusStyle,
    motionLevel: previewBlueprint.motionLevel,
    componentManifest: [
      `hero:${input.heroFamily}`,
      `navigation:${mapped.navStyle}`,
      `sections:${mapped.cardStyle}`,
      `cta:${mapped.ctaStyle}`,
    ],
    inspirationEvidenceIds: input.inspirationEvidenceIds,
  });
}

export function composeBuildContractV2(
  input: Omit<BuildContractV2, "specHash">,
): BuildContractV2 {
  return buildContractV2Schema.parse({
    ...input,
    specHash: canonicalSiteOpsSha256(input),
  });
}
export function composeBuildPlanContractV3(
  input: Omit<BuildPlanContractV3, "specHash">,
): BuildPlanContractV3 {
  return buildPlanContractV3Schema.parse({
    ...input,
    specHash: canonicalSiteOpsSha256(input),
  });
}
export function composeBuildContractV3(
  input: Omit<BuildContractV3, "specHash">,
): BuildContractV3 {
  return buildContractV3Schema.parse({
    ...input,
    specHash: canonicalSiteOpsSha256(input),
  });
}
export function composeBuildPlanContractV4(
  input: Omit<BuildPlanContractV4, "specHash">,
): BuildPlanContractV4 {
  return buildPlanContractV4Schema.parse({
    ...input,
    specHash: canonicalSiteOpsSha256(input),
  });
}
export function composeBuildContractV4(
  input: Omit<BuildContractV4, "specHash">,
): BuildContractV4 {
  return buildContractV4Schema.parse({
    ...input,
    specHash: canonicalSiteOpsSha256(input),
  });
}

/** Empty historical taxonomies render through one host-owned neutral color
 * coordinate. Keep that virtual coordinate bounded exactly like the wire
 * schemas; malformed sizes never reach a renderer or get silently clamped. */
export function boundedSiteDesignPaletteSize(paletteSize: number) {
  if (
    !Number.isSafeInteger(paletteSize) ||
    paletteSize < 0 ||
    paletteSize > 12
  ) {
    throw new Error("SITEOPS_DESIGN_PALETTE_SIZE_INVALID");
  }
  return Math.max(1, paletteSize);
}

export function validateDesignAndContentBindings(input: {
  routeIds: readonly string[];
  paletteSize: number;
  designSpec: SiteDesignSpec;
  pageContent?: PageContentSpec;
}) {
  const expectedRoutes = new Set(input.routeIds);
  const compositions = new Map(
    input.designSpec.routeCompositions.map((route) => [route.routeId, route]),
  );
  if (
    input.designSpec.routeCompositions.length !== expectedRoutes.size ||
    compositions.size !== expectedRoutes.size ||
    [...compositions.keys()].some((id) => !expectedRoutes.has(id))
  ) {
    throw new Error("SITEOPS_DESIGN_ROUTE_SET_MISMATCH");
  }
  const paletteSize = boundedSiteDesignPaletteSize(input.paletteSize);
  if (
    Object.values(input.designSpec.colorRoles).some(
      (index) =>
        !Number.isSafeInteger(index) || index < 0 || index >= paletteSize,
    )
  ) {
    throw new Error("SITEOPS_DESIGN_PALETTE_INDEX_INVALID");
  }
  for (const route of compositions.values()) {
    if (
      new Set(route.slots.map((slot) => slot.slotId)).size !==
      route.slots.length
    ) {
      throw new Error("SITEOPS_DESIGN_SLOT_DUPLICATE");
    }
  }
  if (!input.pageContent) return;
  const contentByRoute = new Map(
    input.pageContent.routes.map((route) => [route.routeId, route]),
  );
  if (
    input.pageContent.routes.length !== expectedRoutes.size ||
    contentByRoute.size !== expectedRoutes.size ||
    [...contentByRoute.keys()].some((id) => !expectedRoutes.has(id))
  ) {
    throw new Error("SITEOPS_CONTENT_ROUTE_SET_MISMATCH");
  }
  for (const [routeId, composition] of compositions) {
    const content = contentByRoute.get(routeId);
    if (!content) throw new Error("SITEOPS_CONTENT_ROUTE_SET_MISMATCH");
    if (
      "emptyState" in content &&
      content.emptyState === "company_news_unavailable"
    ) {
      if (routeId !== "news" || content.sections.length !== 0) {
        throw new Error("SITEOPS_CONTENT_EMPTY_STATE_INVALID");
      }
      continue;
    }
    const slots = content.sections.map((section) => section.slotId);
    if (
      composition.slots.length !== slots.length ||
      composition.slots.some((slot, index) => slot.slotId !== slots[index])
    ) {
      throw new Error("SITEOPS_CONTENT_SLOT_SET_MISMATCH");
    }
  }
}
