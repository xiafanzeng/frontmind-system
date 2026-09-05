import { createHash } from "node:crypto";
import { z } from "zod";

export const SITEOPS_CONTENT_PLAN_V2_FILENAME =
  "frontmind-site-content-plan-v2.json" as const;

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const sourceIdSchema = z.string().trim().min(1).max(191);
const RESERVED_ROUTE_PREFIXES = [
  "/api/",
  "/dashboard/",
  "/preview/",
  "/internal/",
  "/_frontmind/",
  "/admin/",
] as const;

/** Routes are deliberately language-neutral transport coordinates. Human
 * labels may use any language, while paths stay deterministic and safe for
 * static output, preview proxying and direct reloads. */
export const siteContentPlanRoutePathSchema = z
  .string()
  .trim()
  .min(1)
  .max(191)
  .refine(
    (value) =>
      value === "/" ||
      (/^\/(?:[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?\/)+$/u.test(value) &&
        !value.includes("//") &&
        !value.includes("..") &&
        !RESERVED_ROUTE_PREFIXES.some((prefix) => value.startsWith(prefix))),
    "Route paths must be canonical lowercase ASCII paths with a trailing slash",
  );

export const knowledgeCoverageInventoryV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    source: z.literal("frozen_knowledge_snapshot"),
    snapshotId: z.string().uuid(),
    archiveSha256: sha256Schema,
    documents: z
      .array(
        z
          .object({
            id: sourceIdSchema,
            path: z.string().trim().min(1).max(512),
            title: z.string().trim().min(1).max(255),
            kind: z.string().trim().min(1).max(64),
            contentSha256: sha256Schema,
            characterCount: z.number().int().nonnegative(),
            evidenceUnitCount: z.number().int().nonnegative(),
            topics: z
              .array(
                z.enum([
                  "company",
                  "product",
                  "service",
                  "application",
                  "case_study",
                  "knowledge",
                  "company_news",
                  "faq",
                  "contact",
                  "other",
                ]),
              )
              .min(1)
              .max(10),
          })
          .strict(),
      )
      .min(1)
      .max(10_000),
    entities: z
      .array(
        z
          .object({
            id: z.string().trim().min(1).max(191),
            label: z.string().trim().min(1).max(255),
            kind: z.string().trim().min(1).max(64),
            sourceDocumentIds: z.array(sourceIdSchema).min(1).max(100),
          })
          .strict(),
      )
      .max(10_000),
    facts: z
      .array(
        z
          .object({
            id: z.string().trim().min(1).max(191),
            statement: z.string().trim().min(1).max(2_000),
            sourceDocumentId: sourceIdSchema,
          })
          .strict(),
      )
      .max(50_000),
    faqs: z
      .array(
        z
          .object({
            id: z.string().trim().min(1).max(191),
            question: z.string().trim().min(1).max(1_000),
            answer: z.string().trim().min(1).max(4_000),
            sourceDocumentIds: z.array(sourceIdSchema).min(1).max(100),
          })
          .strict(),
      )
      .max(10_000),
    contacts: z
      .array(
        z
          .object({
            kind: z.enum(["email", "phone", "address"]),
            value: z.string().trim().min(1).max(512),
            sourceDocumentIds: z.array(sourceIdSchema).min(1).max(100),
          })
          .strict(),
      )
      .max(2_000),
    media: z
      .array(
        z
          .object({
            id: sourceIdSchema,
            sha256: sha256Schema,
            path: z.string().trim().min(1).max(1_024),
            mimeType: z.string().trim().min(1).max(191).nullable(),
            caption: z.string().trim().min(1).max(1_000).nullable(),
            alt: z.string().trim().min(1).max(500).nullable(),
            size: z
              .number()
              .int()
              .positive()
              .max(8 * 1024 * 1024),
            width: z.number().int().positive().max(20_000).nullable(),
            height: z.number().int().positive().max(20_000).nullable(),
            sourceDocumentIds: z.array(sourceIdSchema).max(100),
          })
          .strict(),
      )
      .max(10_000),
  })
  .strict()
  .superRefine((value, context) => {
    const ids = value.documents.map((document) => document.id);
    if (new Set(ids).size !== ids.length) {
      context.addIssue({
        code: "custom",
        path: ["documents"],
        message: "Knowledge inventory document IDs must be unique",
      });
    }
    for (const [key, values] of [
      ["entities", value.entities.map((item) => item.id)],
      ["facts", value.facts.map((item) => item.id)],
      ["faqs", value.faqs.map((item) => item.id)],
      ["media", value.media.map((item) => item.id)],
    ] as const) {
      if (new Set(values).size !== values.length) {
        context.addIssue({
          code: "custom",
          path: [key],
          message: `Knowledge inventory ${key} IDs must be unique`,
        });
      }
    }
  });

const siteContentPlanSourceBindingV2Schema = z
  .object({
    sourceDocumentId: sourceIdSchema,
    evidenceExcerpt: z.string().trim().min(1).max(2_000),
  })
  .strict();

const siteContentPlanSectionV2Schema = z
  .object({
    id: z.string().trim().min(1).max(96),
    blockKind: z.enum([
      "hero",
      "prose",
      "feature_list",
      "steps",
      "metrics",
      "entity_grid",
      "faq",
      "quote",
      "media",
      "cta",
    ]),
    heading: z.string().trim().min(1).max(300),
    purpose: z.string().trim().min(1).max(1_000),
    body: z.string().trim().min(1).max(20_000),
    sourceBindings: z
      .array(siteContentPlanSourceBindingV2Schema)
      .min(1)
      .max(200),
    mediaIds: z.array(sourceIdSchema).max(100).default([]),
    entityIds: z.array(z.string().trim().min(1).max(191)).max(200).default([]),
    faqIds: z.array(z.string().trim().min(1).max(191)).max(200).default([]),
  })
  .strict();

const siteContentPlanRouteV2Schema = z
  .object({
    id: z.string().trim().min(1).max(64),
    path: siteContentPlanRoutePathSchema,
    title: z.string().trim().min(1).max(255),
    navigation: z.enum(["primary", "footer", "contextual", "hidden"]),
    parentPath: siteContentPlanRoutePathSchema.nullable(),
    detailOfPath: siteContentPlanRoutePathSchema.nullable().default(null),
    purpose: z.string().trim().min(1).max(1_000),
    userQuestions: z.array(z.string().trim().min(1).max(1_000)).max(30),
    h1: z.string().trim().min(1).max(500),
    summary: z.string().trim().min(1).max(4_000),
    cta: z
      .object({
        label: z.string().trim().min(1).max(160),
        targetPath: siteContentPlanRoutePathSchema.nullable(),
      })
      .strict()
      .nullable(),
    sections: z.array(siteContentPlanSectionV2Schema).min(1).max(40),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.cta && !value.cta.targetPath) {
      context.addIssue({
        code: "custom",
        path: ["cta", "targetPath"],
        message: "CTA labels must point to a route in the manifest",
      });
    }
  });

export const siteContentPlanV2Schema = z
  .object({
    schemaVersion: z.literal(2),
    inventorySha256: sha256Schema,
    routes: z.array(siteContentPlanRouteV2Schema).min(1).max(30),
    navigation: z
      .array(
        z
          .object({
            label: z.string().trim().min(1).max(160),
            targetPath: siteContentPlanRoutePathSchema,
          })
          .strict(),
      )
      .max(60),
    coverage: z
      .array(
        z.discriminatedUnion("status", [
          z
            .object({
              sourceDocumentId: sourceIdSchema,
              status: z.literal("used"),
              routeIds: z
                .array(z.string().trim().min(1).max(64))
                .min(1)
                .max(30),
              omissionReason: z.null(),
            })
            .strict(),
          z
            .object({
              sourceDocumentId: sourceIdSchema,
              status: z.literal("omitted"),
              routeIds: z.array(z.never()).length(0),
              omissionReason: z.string().trim().min(8).max(1_000),
            })
            .strict(),
        ]),
      )
      .min(1)
      .max(10_000),
  })
  .strict()
  .superRefine((value, context) => {
    const routeIds = value.routes.map((route) => route.id);
    const routePaths = value.routes.map((route) => route.path);
    if (!routePaths.includes("/")) {
      context.addIssue({
        code: "custom",
        path: ["routes"],
        message: "The content plan must contain the root route",
      });
    }
    if (new Set(routeIds).size !== routeIds.length) {
      context.addIssue({
        code: "custom",
        path: ["routes"],
        message: "Content plan route IDs must be unique",
      });
    }
    if (new Set(routePaths).size !== routePaths.length) {
      context.addIssue({
        code: "custom",
        path: ["routes"],
        message: "Content plan route paths must be unique",
      });
    }
    const pathSet = new Set(routePaths);
    const routeIdSet = new Set(routeIds);
    const parentByPath = new Map(
      value.routes.map((route) => [route.path, route.parentPath] as const),
    );
    const detailByPath = new Map(
      value.routes.map((route) => [route.path, route.detailOfPath] as const),
    );
    const graphHasCycle = (graph: ReadonlyMap<string, string | null>) =>
      [...graph.keys()].some((start) => {
        const visited = new Set<string>();
        let current: string | null | undefined = start;
        while (current) {
          if (visited.has(current)) return true;
          visited.add(current);
          current = graph.get(current);
        }
        return false;
      });
    if (graphHasCycle(parentByPath)) {
      context.addIssue({
        code: "custom",
        path: ["routes"],
        message: "Parent route relationships must be acyclic",
      });
    }
    if (graphHasCycle(detailByPath)) {
      context.addIssue({
        code: "custom",
        path: ["routes"],
        message: "Detail route relationships must be acyclic",
      });
    }
    value.routes.forEach((route, routeIndex) => {
      if (route.parentPath && !pathSet.has(route.parentPath)) {
        context.addIssue({
          code: "custom",
          path: ["routes", routeIndex, "parentPath"],
          message: "Parent route is absent from the route manifest",
        });
      }
      if (route.detailOfPath && !pathSet.has(route.detailOfPath)) {
        context.addIssue({
          code: "custom",
          path: ["routes", routeIndex, "detailOfPath"],
          message: "Detail collection route is absent from the route manifest",
        });
      }
      if (route.cta?.targetPath && !pathSet.has(route.cta.targetPath)) {
        context.addIssue({
          code: "custom",
          path: ["routes", routeIndex, "cta", "targetPath"],
          message: "CTA target is absent from the route manifest",
        });
      }
      const sectionIds = route.sections.map((section) => section.id);
      if (new Set(sectionIds).size !== sectionIds.length) {
        context.addIssue({
          code: "custom",
          path: ["routes", routeIndex, "sections"],
          message: "Section IDs must be unique within a route",
        });
      }
      if (route.parentPath === route.path) {
        context.addIssue({
          code: "custom",
          path: ["routes", routeIndex, "parentPath"],
          message: "A route cannot be its own parent",
        });
      }
      if (route.detailOfPath === route.path) {
        context.addIssue({
          code: "custom",
          path: ["routes", routeIndex, "detailOfPath"],
          message: "A route cannot be its own detail collection",
        });
      }
    });
    value.navigation.forEach((item, index) => {
      if (!pathSet.has(item.targetPath)) {
        context.addIssue({
          code: "custom",
          path: ["navigation", index, "targetPath"],
          message: "Navigation target is absent from the route manifest",
        });
      }
    });
    const navigationTargets = value.navigation.map((item) => item.targetPath);
    const navigationLabels = value.navigation.map((item) => item.label);
    if (new Set(navigationTargets).size !== navigationTargets.length) {
      context.addIssue({
        code: "custom",
        path: ["navigation"],
        message: "Navigation route coordinates must be unique",
      });
    }
    if (new Set(navigationLabels).size !== navigationLabels.length) {
      context.addIssue({
        code: "custom",
        path: ["navigation"],
        message: "Navigation labels cannot point to conflicting routes",
      });
    }
    value.coverage.forEach((item, index) => {
      if (new Set(item.routeIds).size !== item.routeIds.length) {
        context.addIssue({
          code: "custom",
          path: ["coverage", index, "routeIds"],
          message: "Coverage route IDs must be unique",
        });
      }
      if (
        item.status === "used" &&
        item.routeIds.some((routeId) => !routeIdSet.has(routeId))
      ) {
        context.addIssue({
          code: "custom",
          path: ["coverage", index, "routeIds"],
          message: "Coverage references an absent route",
        });
      }
    });
  });

export type KnowledgeCoverageInventoryV1 = z.infer<
  typeof knowledgeCoverageInventoryV1Schema
>;
export type SiteContentPlanV2 = z.infer<typeof siteContentPlanV2Schema>;

/** Flat transport keeps Manus Structured Output below its five-level limit;
 * the host immediately projects it into the strict nested V2 contract. */
export const siteContentPlanWireV2Schema = z
  .object({
    wireSchemaVersion: z.literal(2),
    operationToken: z.string().trim().min(1).max(512),
    inventorySha256: sha256Schema,
    routes: z
      .array(
        z
          .object({
            routeId: z.string().trim().min(1).max(64),
            path: siteContentPlanRoutePathSchema,
            title: z.string().trim().min(1).max(255),
            navigation: z.enum(["primary", "footer", "contextual", "hidden"]),
            parentPath: siteContentPlanRoutePathSchema.nullable(),
            detailOfPath: siteContentPlanRoutePathSchema.nullable(),
            purpose: z.string().trim().min(1).max(1_000),
            userQuestions: z.array(z.string().trim().min(1).max(1_000)).max(30),
            h1: z.string().trim().min(1).max(500),
            summary: z.string().trim().min(1).max(4_000),
            ctaLabel: z.string().trim().min(1).max(160).nullable(),
            ctaTargetPath: siteContentPlanRoutePathSchema.nullable(),
          })
          .strict(),
      )
      .min(1)
      .max(30),
    sections: z
      .array(
        z
          .object({
            routeId: z.string().trim().min(1).max(64),
            sectionId: z.string().trim().min(1).max(96),
            blockKind: siteContentPlanSectionV2Schema.shape.blockKind,
            heading: z.string().trim().min(1).max(300),
            purpose: z.string().trim().min(1).max(1_000),
            body: z.string().trim().min(1).max(20_000),
            sourceDocumentIds: z.array(sourceIdSchema).min(1).max(200),
            evidenceExcerpts: z
              .array(z.string().trim().min(1).max(2_000))
              .min(1)
              .max(200),
            mediaIds: z.array(sourceIdSchema).max(100),
            entityIds: z.array(z.string().trim().min(1).max(191)).max(200),
            faqIds: z.array(z.string().trim().min(1).max(191)).max(200),
          })
          .strict()
          .refine(
            (value) =>
              value.sourceDocumentIds.length === value.evidenceExcerpts.length,
            "Every source document must have one evidence excerpt",
          ),
      )
      .min(1)
      .max(1_200),
    navigation: z
      .array(
        z
          .object({
            label: z.string().trim().min(1).max(160),
            targetPath: siteContentPlanRoutePathSchema,
          })
          .strict(),
      )
      .max(60),
    coverage: z
      .array(
        z
          .object({
            sourceDocumentId: sourceIdSchema,
            status: z.enum(["used", "omitted"]),
            routeIds: z.array(z.string().trim().min(1).max(64)).max(30),
            omissionReason: z.string().trim().min(8).max(1_000).nullable(),
          })
          .strict(),
      )
      .min(1)
      .max(10_000),
  })
  .strict()
  .superRefine((value, context) => {
    const routeIds = new Set(value.routes.map((route) => route.routeId));
    value.routes.forEach((route, index) => {
      if (Boolean(route.ctaLabel) !== Boolean(route.ctaTargetPath)) {
        context.addIssue({
          code: "custom",
          path: ["routes", index, "ctaLabel"],
          message: "CTA label and target path must both be present or absent",
        });
      }
    });
    value.sections.forEach((section, index) => {
      if (!routeIds.has(section.routeId)) {
        context.addIssue({
          code: "custom",
          path: ["sections", index, "routeId"],
          message: "Section references an absent route",
        });
      }
    });
    value.routes.forEach((route, index) => {
      if (
        !value.sections.some((section) => section.routeId === route.routeId)
      ) {
        context.addIssue({
          code: "custom",
          path: ["routes", index, "routeId"],
          message: "Every route must own at least one section",
        });
      }
    });
    value.coverage.forEach((item, index) => {
      const valid =
        item.status === "used"
          ? item.routeIds.length > 0 && item.omissionReason === null
          : item.routeIds.length === 0 && item.omissionReason !== null;
      if (!valid) {
        context.addIssue({
          code: "custom",
          path: ["coverage", index],
          message: "Coverage status, routes and omission reason disagree",
        });
      }
    });
  });

export type SiteContentPlanWireV2 = z.infer<typeof siteContentPlanWireV2Schema>;

export function siteContentPlanV2FromWire(
  value: unknown,
  expected?: { operationToken: string; inventorySha256: string },
) {
  const wire = siteContentPlanWireV2Schema.parse(value);
  if (
    expected &&
    (wire.operationToken !== expected.operationToken ||
      wire.inventorySha256 !== expected.inventorySha256)
  ) {
    throw new SiteContentPlanValidationError([
      "CONTENT_PLAN_WIRE_COORDINATES_MISMATCH",
    ]);
  }
  return siteContentPlanV2Schema.parse({
    schemaVersion: 2,
    inventorySha256: wire.inventorySha256,
    routes: wire.routes.map((route) => ({
      id: route.routeId,
      path: route.path,
      title: route.title,
      navigation: route.navigation,
      parentPath: route.parentPath,
      detailOfPath: route.detailOfPath,
      purpose: route.purpose,
      userQuestions: route.userQuestions,
      h1: route.h1,
      summary: route.summary,
      cta:
        route.ctaLabel === null
          ? null
          : { label: route.ctaLabel, targetPath: route.ctaTargetPath },
      sections: wire.sections
        .filter((section) => section.routeId === route.routeId)
        .map((section) => ({
          id: section.sectionId,
          blockKind: section.blockKind,
          heading: section.heading,
          purpose: section.purpose,
          body: section.body,
          sourceBindings: section.sourceDocumentIds.map(
            (sourceDocumentId, index) => ({
              sourceDocumentId,
              evidenceExcerpt: section.evidenceExcerpts[index]!,
            }),
          ),
          mediaIds: section.mediaIds,
          entityIds: section.entityIds,
          faqIds: section.faqIds,
        })),
    })),
    navigation: wire.navigation,
    coverage: wire.coverage.map((item) =>
      item.status === "used"
        ? {
            sourceDocumentId: item.sourceDocumentId,
            status: "used" as const,
            routeIds: item.routeIds,
            omissionReason: null,
          }
        : {
            sourceDocumentId: item.sourceDocumentId,
            status: "omitted" as const,
            routeIds: [],
            omissionReason: item.omissionReason,
          },
    ),
  });
}

export function canonicalSiteContentPlanSha256(value: unknown) {
  return createHash("sha256")
    .update(JSON.stringify(value), "utf8")
    .digest("hex");
}

function normalizedEvidence(value: string) {
  return value.normalize("NFKC").replace(/\s+/gu, " ").trim();
}

export class SiteContentPlanValidationError extends Error {
  readonly code = "SITEOPS_CONTENT_PLAN_V2_INVALID";

  constructor(readonly issues: readonly string[]) {
    super(issues[0] ?? "Site content plan is invalid");
    this.name = "SiteContentPlanValidationError";
  }
}

/** Cross-validates the provider-owned information architecture against the
 * complete host-owned snapshot. This is intentionally the only semantic
 * admission boundary: the host verifies provenance and graph integrity but
 * never invents, renames, merges or splits a provider route. */
export function validateSiteContentPlanV2(input: {
  plan: unknown;
  inventory: KnowledgeCoverageInventoryV1;
  documents: readonly { id: string; content: string }[];
  requiredDocumentIds?: readonly string[];
  requiredMediaIds?: readonly string[];
}) {
  const plan = siteContentPlanV2Schema.parse(input.plan);
  const inventory = knowledgeCoverageInventoryV1Schema.parse(input.inventory);
  const issues: string[] = [];
  const expectedInventorySha256 = canonicalSiteContentPlanSha256(inventory);
  if (plan.inventorySha256 !== expectedInventorySha256) {
    issues.push("CONTENT_PLAN_INVENTORY_HASH_MISMATCH");
  }
  const documentById = new Map(
    input.documents.map((document) => [document.id, document.content]),
  );
  const inventoryIds = inventory.documents.map((document) => document.id);
  const inventoryIdSet = new Set(inventoryIds);
  const mediaIdSet = new Set(inventory.media.map((item) => item.id));
  const entityIdSet = new Set(inventory.entities.map((item) => item.id));
  const faqIdSet = new Set(inventory.faqs.map((item) => item.id));
  const coverageIds = plan.coverage.map((item) => item.sourceDocumentId);
  if (
    coverageIds.length !== inventoryIds.length ||
    new Set(coverageIds).size !== coverageIds.length ||
    inventoryIds.some((id) => !coverageIds.includes(id))
  ) {
    issues.push("CONTENT_PLAN_COVERAGE_INCOMPLETE");
  }
  const usedSourcesByRoute = new Map<string, Set<string>>();
  const usedMediaIds = new Set<string>();
  for (const route of plan.routes) {
    const used = new Set<string>();
    for (const section of route.sections) {
      if (section.mediaIds.some((id) => !mediaIdSet.has(id))) {
        issues.push("CONTENT_PLAN_MEDIA_UNKNOWN");
      }
      if (section.entityIds.some((id) => !entityIdSet.has(id))) {
        issues.push("CONTENT_PLAN_ENTITY_UNKNOWN");
      }
      if (section.faqIds.some((id) => !faqIdSet.has(id))) {
        issues.push("CONTENT_PLAN_FAQ_UNKNOWN");
      }
      for (const mediaId of section.mediaIds) usedMediaIds.add(mediaId);
      for (const binding of section.sourceBindings) {
        if (!inventoryIdSet.has(binding.sourceDocumentId)) {
          issues.push("CONTENT_PLAN_SOURCE_UNKNOWN");
          continue;
        }
        const source = documentById.get(binding.sourceDocumentId);
        if (
          !source ||
          !normalizedEvidence(source).includes(
            normalizedEvidence(binding.evidenceExcerpt),
          )
        ) {
          issues.push("CONTENT_PLAN_EVIDENCE_NOT_VERBATIM");
        }
        used.add(binding.sourceDocumentId);
      }
    }
    usedSourcesByRoute.set(route.id, used);
  }
  const requiredMediaIds = input.requiredMediaIds ?? [];
  if (
    new Set(requiredMediaIds).size !== requiredMediaIds.length ||
    requiredMediaIds.some(
      (mediaId) => !mediaIdSet.has(mediaId) || !usedMediaIds.has(mediaId),
    )
  ) {
    issues.push("CONTENT_PLAN_REQUIRED_MEDIA_UNBOUND");
  }
  for (const item of plan.coverage) {
    if (
      item.status === "used" &&
      item.routeIds.some(
        (routeId) =>
          !usedSourcesByRoute.get(routeId)?.has(item.sourceDocumentId),
      )
    ) {
      issues.push("CONTENT_PLAN_USED_DOCUMENT_NOT_RENDER_BOUND");
    }
    if (
      item.status === "omitted" &&
      [...usedSourcesByRoute.values()].some((ids) =>
        ids.has(item.sourceDocumentId),
      )
    ) {
      issues.push("CONTENT_PLAN_OMITTED_DOCUMENT_RENDER_BOUND");
    }
  }
  const requiredDocumentIds = input.requiredDocumentIds ?? [];
  const coverageByDocumentId = new Map(
    plan.coverage.map((item) => [item.sourceDocumentId, item] as const),
  );
  if (
    new Set(requiredDocumentIds).size !== requiredDocumentIds.length ||
    requiredDocumentIds.some((sourceDocumentId) => {
      const coverage = coverageByDocumentId.get(sourceDocumentId);
      return (
        !inventoryIdSet.has(sourceDocumentId) ||
        !coverage ||
        coverage.status !== "used" ||
        coverage.routeIds.length < 1 ||
        coverage.routeIds.some(
          (routeId) =>
            !usedSourcesByRoute.get(routeId)?.has(sourceDocumentId),
        )
      );
    })
  ) {
    issues.push("CONTENT_PLAN_REQUIRED_DOCUMENT_NOT_RENDER_BOUND");
  }
  if (issues.length > 0) {
    throw new SiteContentPlanValidationError([...new Set(issues)]);
  }
  return plan;
}

export function siteContentPlanRoutes(plan: SiteContentPlanV2) {
  return plan.routes.map((route) => ({
    id: route.id,
    slug: route.path,
    title: route.title,
    sourceDocumentIds: [
      ...new Set(
        route.sections.flatMap((section) =>
          section.sourceBindings.map((binding) => binding.sourceDocumentId),
        ),
      ),
    ],
  }));
}
