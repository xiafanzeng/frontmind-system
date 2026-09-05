import { z } from "zod";

import type { SiteBrief } from "../../shared/siteops";
import { pageContentSpecV2Schema } from "../../shared/siteops-design";

const draftTextSchema = z.string().min(1).max(2_000);
const sourceIdSchema = z.string().min(1).max(191);

export const siteContentDraftV1Schema = z
  .object({
    operationToken: z.string().min(1).max(128),
    routes: z
      .array(
        z
          .object({
            routeId: z.string().min(1).max(64),
            heading: z.string().min(1).max(255).optional(),
            summary: z.string().min(1).max(2_000).optional(),
            sections: z
              .array(
                z
                  .object({
                    heading: z.string().min(1).max(255).optional(),
                    paragraphs: z.array(draftTextSchema).max(16).optional(),
                    bullets: z
                      .array(z.string().min(1).max(500))
                      .max(24)
                      .optional(),
                    sourceIds: z.array(sourceIdSchema).max(100).optional(),
                  })
                  .strict(),
              )
              .max(48)
              .optional(),
          })
          .strict(),
      )
      .max(90),
  })
  .strict();

export type SiteContentDraftV1 = z.infer<typeof siteContentDraftV1Schema>;

const canonicalSeoSchema = z
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

/** A host-owned preview model that is directly assignable to the current
 * `siteOpsGeneratedContentV2Schema`. Keep the local refinement so this module
 * does not need to import the materializer and create a provider/runtime
 * dependency cycle. */
export const canonicalPreviewModelV1Schema = z
  .object({
    schemaVersion: z.literal(2),
    seo: canonicalSeoSchema,
    routes: pageContentSpecV2Schema.shape.routes,
    entities: pageContentSpecV2Schema.shape.entities,
    faqs: pageContentSpecV2Schema.shape.faqs,
    officialLinks: pageContentSpecV2Schema.shape.officialLinks,
  })
  .strict()
  .superRefine((value, context) => {
    const parsed = pageContentSpecV2Schema.safeParse({
      schemaVersion: 2,
      routes: value.routes,
      entities: value.entities,
      faqs: value.faqs,
      officialLinks: value.officialLinks,
    });
    if (!parsed.success) {
      context.addIssue({
        code: "custom",
        path: [],
        message: "Canonical preview does not satisfy PageContentSpecV2",
      });
    }
  });

export type CanonicalPreviewModelV1 = z.infer<
  typeof canonicalPreviewModelV1Schema
>;

type JsonObject = Record<string, unknown>;

function isRecord(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringArray(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

/** Project the current PageContentWireV3 transport shape into the deliberately
 * smaller draft contract. Invalid child coordinates are omitted and handled
 * by the canonicalizer, but the task token remains an exact hard boundary. */
export function draftFromPageContentWire(
  value: unknown,
  operationToken: string,
): SiteContentDraftV1 {
  if (!isRecord(value) || value.operationToken !== operationToken) {
    throw new Error("SITE_CONTENT_DRAFT_TOKEN_MISMATCH");
  }
  const routes = new Map<string, SiteContentDraftV1["routes"][number]>();
  const ensureRoute = (routeId: string) => {
    const existing = routes.get(routeId);
    if (existing) return existing;
    const created: SiteContentDraftV1["routes"][number] = {
      routeId,
      sections: [],
    };
    routes.set(routeId, created);
    return created;
  };
  if (Array.isArray(value.routes)) {
    for (const rawRoute of value.routes.slice(0, 90)) {
      if (!isRecord(rawRoute) || typeof rawRoute.routeId !== "string") continue;
      const routeId = rawRoute.routeId.trim();
      if (!routeId || routeId.length > 64) continue;
      const route = ensureRoute(routeId);
      if (typeof rawRoute.heading === "string" && route.heading === undefined) {
        route.heading = rawRoute.heading;
      }
      if (typeof rawRoute.summary === "string" && route.summary === undefined) {
        route.summary = rawRoute.summary;
      }
    }
  }
  const rawBlocks = Array.isArray(value.blocks)
    ? value.blocks
    : Array.isArray(value.sections)
      ? value.sections
      : [];
  for (const rawBlock of rawBlocks.slice(0, 480)) {
    if (!isRecord(rawBlock) || typeof rawBlock.routeId !== "string") continue;
    const routeId = rawBlock.routeId.trim();
    if (!routeId || routeId.length > 64) continue;
    const route = ensureRoute(routeId);
    if ((route.sections?.length ?? 0) >= 48) continue;
    route.sections ??= [];
    route.sections.push({
      ...(typeof rawBlock.heading === "string"
        ? { heading: rawBlock.heading }
        : {}),
      paragraphs: stringArray(rawBlock.paragraphs).slice(0, 16),
      bullets: stringArray(rawBlock.items ?? rawBlock.bullets).slice(0, 24),
      sourceIds: stringArray(
        rawBlock.sourceDocumentIds ?? rawBlock.sourceIds,
      ).slice(0, 100),
    });
  }
  return { operationToken, routes: [...routes.values()] };
}

function normalizedText(value: unknown, maxLength: number) {
  if (typeof value !== "string") return null;
  const normalized = value
    .normalize("NFKC")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, " ")
    // Canonical content is data, never markup. Removing tag-shaped fragments
    // gives both the React renderer and the no-JS fallback a safe invariant.
    .replace(/<[^>]{1,256}>/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  if (!normalized) return null;
  return Array.from(normalized).slice(0, maxLength).join("");
}

function uniqueStrings(values: readonly string[], limit: number) {
  return [...new Set(values)].slice(0, limit);
}

function allowedSourcesForRoute(route: SiteBrief["routes"][number]) {
  return new Set(route.sourceDocumentIds);
}

function intersectSources(value: unknown, allowed: ReadonlySet<string>) {
  if (!Array.isArray(value)) return [];
  return uniqueStrings(
    value.filter(
      (item): item is string =>
        typeof item === "string" && allowed.has(item) && item.length <= 191,
    ),
    50,
  );
}

function fallbackForRoute(
  brief: SiteBrief,
  route: SiteBrief["routes"][number],
) {
  const routeTitle = normalizedText(route.title, 160) ?? "页面";
  const allowed = allowedSourcesForRoute(route);
  const facts = brief.verifiedFacts
    .map((fact) => ({
      statement: normalizedText(fact.statement, 2_000),
      sourceDocumentIds: uniqueStrings(
        fact.sourceDocumentIds.filter((sourceId) => allowed.has(sourceId)),
        50,
      ),
    }))
    .filter(
      (fact): fact is { statement: string; sourceDocumentIds: string[] } =>
        fact.statement !== null && fact.sourceDocumentIds.length > 0,
    )
    .slice(0, 3);
  const summary =
    normalizedText(facts[0]?.statement, 600) ??
    `本页面内容依据已上传并验证的企业资料整理。`;
  const sourceDocumentIds = uniqueStrings(route.sourceDocumentIds, 50);
  const hostPlaceholder = sourceDocumentIds.length === 0;
  const placeholderText = "本页面暂无可由已验证资料公开展示的内容。";
  return {
    heading: routeTitle,
    summary: hostPlaceholder ? placeholderText : summary,
    section: {
      slotId: "overview",
      blockType: "prose" as const,
      heading: routeTitle,
      paragraphs:
        hostPlaceholder
          ? [placeholderText]
          : facts.length > 0
          ? facts.map((fact) => fact.statement).slice(0, 8)
          : ["本页面内容依据已上传并验证的企业资料整理。"],
      items: [],
      entityIds: [],
      faqIds: [],
      sourceDocumentIds,
      ...(hostPlaceholder
        ? ({ grounding: "host_placeholder" } as const)
        : {}),
    },
  };
}

/**
 * Convert a lossy provider draft into a complete host-owned preview model.
 * Unknown fields and malformed route fragments are ignored individually. A
 * non-null draft must still carry the exact operation token; callers must not
 * use this function to launder a cross-task payload into a trusted preview.
 */
export function canonicalizeSiteContentDraft(input: {
  draft: unknown | null;
  operationToken: string;
  brief: SiteBrief;
  seo: z.input<typeof canonicalSeoSchema>;
}): CanonicalPreviewModelV1 {
  if (input.draft !== null) {
    if (
      !isRecord(input.draft) ||
      input.draft.operationToken !== input.operationToken
    ) {
      throw new Error("SITE_CONTENT_DRAFT_TOKEN_MISMATCH");
    }
  }
  const rawRoutes =
    isRecord(input.draft) && Array.isArray(input.draft.routes)
      ? input.draft.routes
      : [];
  const routeFragments = new Map<string, JsonObject[]>();
  const allowedRouteIds = new Set(input.brief.routes.map((route) => route.id));
  for (const rawRoute of rawRoutes) {
    if (!isRecord(rawRoute) || typeof rawRoute.routeId !== "string") continue;
    const routeId = rawRoute.routeId.trim();
    if (!allowedRouteIds.has(routeId)) continue;
    const fragments = routeFragments.get(routeId) ?? [];
    fragments.push(rawRoute);
    routeFragments.set(routeId, fragments);
  }
  const hasCompanyNews = input.brief.contentInventory.entries.some(
    (entry) => entry.kind === "company_news",
  );
  const routes = input.brief.routes.map((route) => {
    if (route.id === "news" && !hasCompanyNews) {
      return {
        routeId: route.id,
        heading: "企业动态",
        summary: "当前知识库暂无可公开的企业动态。",
        emptyState: "company_news_unavailable" as const,
        sections: [],
      };
    }
    const fallback = fallbackForRoute(input.brief, route);
    const fragments = routeFragments.get(route.id) ?? [];
    const allowedSources = allowedSourcesForRoute(route);
    const heading = fragments
      .map((fragment) => normalizedText(fragment.heading, 180))
      .find((value): value is string => value !== null);
    const summary = fragments
      .map((fragment) => normalizedText(fragment.summary, 600))
      .find((value): value is string => value !== null);
    const sections: CanonicalPreviewModelV1["routes"][number]["sections"] = [];
    for (const fragment of fragments) {
      if (!Array.isArray(fragment.sections)) continue;
      for (const rawSection of fragment.sections) {
        if (!isRecord(rawSection) || sections.length >= 16) continue;
        const sourceDocumentIds = intersectSources(
          rawSection.sourceIds,
          allowedSources,
        );
        // Provider prose is usable only when it retains at least one frozen
        // source binding. Invalid bindings discard this section, not the site.
        if (sourceDocumentIds.length === 0) {
          continue;
        }
        const paragraphs = Array.isArray(rawSection.paragraphs)
          ? rawSection.paragraphs
              .map((value) => normalizedText(value, 2_000))
              .filter((value): value is string => value !== null)
              .slice(0, 8)
          : [];
        const bullets = Array.isArray(rawSection.bullets)
          ? rawSection.bullets
              .map((value) => normalizedText(value, 500))
              .filter((value): value is string => value !== null)
              .slice(0, 24)
          : [];
        if (paragraphs.length === 0 && bullets.length === 0) {
          continue;
        }
        const prose = paragraphs.length > 0 ? paragraphs : bullets.slice(0, 8);
        sections.push({
          slotId:
            sections.length === 0
              ? "overview"
              : `section-${sections.length + 1}`,
          blockType: "prose",
          heading:
            normalizedText(rawSection.heading, 160) ??
            heading ??
            fallback.heading,
          paragraphs: prose,
          items: bullets,
          entityIds: [],
          faqIds: [],
          sourceDocumentIds,
        });
      }
    }
    // Route-level provider copy has no independent source coordinate in the
    // intentionally small draft contract. Accept it only when the same route
    // also contributed at least one section bound to an allowed frozen source.
    const canUseRouteCopy = sections.length > 0;
    return {
      routeId: route.id,
      heading: canUseRouteCopy && heading ? heading : fallback.heading,
      summary: canUseRouteCopy && summary ? summary : fallback.summary,
      sections: sections.length > 0 ? sections : [fallback.section],
    };
  });
  return canonicalPreviewModelV1Schema.parse({
    schemaVersion: 2,
    seo: input.seo,
    routes,
    entities: [],
    faqs: [],
    officialLinks: [],
  });
}

export type CanonicalDesignRouteComposition = {
  routeId: string;
  slots: ReadonlyArray<{ slotId: string; variant?: string }>;
};

/**
 * Bind canonical copy to every server-owned design slot. This is the final
 * adapter used before materialization: it cannot create routes or source ids,
 * and its result satisfies the same V2 generated-content schema as the build
 * runtime.
 */
export function canonicalPreviewToGeneratedContent(input: {
  canonical: CanonicalPreviewModelV1;
  designRouteCompositions: readonly CanonicalDesignRouteComposition[];
  fallbackSourceDocumentIds: Readonly<Record<string, readonly string[]>>;
}): CanonicalPreviewModelV1 {
  const canonical = canonicalPreviewModelV1Schema.parse(input.canonical);
  const compositions = new Map(
    input.designRouteCompositions.map((composition) => [
      composition.routeId,
      composition,
    ]),
  );
  const routes = canonical.routes.map((route) => {
    if (route.emptyState === "company_news_unavailable") {
      return { ...route, sections: [] };
    }
    const composition = compositions.get(route.routeId);
    if (
      !composition ||
      composition.slots.length < 1 ||
      composition.slots.length > 16
    ) {
      throw new Error("SITE_CONTENT_DESIGN_ROUTE_MISSING");
    }
    const slotIds = new Set(composition.slots.map((slot) => slot.slotId));
    if (slotIds.size !== composition.slots.length) {
      throw new Error("SITE_CONTENT_DESIGN_SLOT_DUPLICATE");
    }
    const routeFallbackSources = uniqueStrings(
      input.fallbackSourceDocumentIds[route.routeId] ?? [],
      50,
    );
    const first = route.sections[0];
    const sections = composition.slots.map((slot, index) => {
      const source = route.sections[index] ?? first;
      const sourceDocumentIds = uniqueStrings(
        source?.sourceDocumentIds.length
          ? source.sourceDocumentIds
          : routeFallbackSources,
        50,
      );
      const sourceItems = source?.items ?? [];
      const useFeatureList = slot.variant === "cards" && sourceItems.length > 0;
      return {
        slotId: slot.slotId,
        blockType: useFeatureList
          ? ("feature_list" as const)
          : ("prose" as const),
        heading: source?.heading ?? route.heading,
        paragraphs: useFeatureList
          ? []
          : source?.paragraphs.length
            ? source.paragraphs
            : [route.summary],
        items: useFeatureList ? sourceItems : [],
        entityIds: [],
        faqIds: [],
        sourceDocumentIds,
        ...(source?.grounding === "host_placeholder"
          ? ({ grounding: "host_placeholder" } as const)
          : {}),
      };
    });
    return { ...route, sections };
  });
  return canonicalPreviewModelV1Schema.parse({ ...canonical, routes });
}
