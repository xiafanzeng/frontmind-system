import { createHash } from "node:crypto";
import { z } from "zod";

import type { ManusV2StructuredOutputSchema } from "../manus-v2-client";
import { canonicalJson } from "../../shared/siteops-workflow";
import {
  boundedSiteDesignPaletteSize,
  canonicalSiteContentEntitySlug,
  pageContentResultV2Schema,
  pageContentResultV1Schema,
  siteDesignResultV1Schema,
  siteDesignResultV2Schema,
  type ReferenceBlueprint,
} from "../../shared/siteops-design";

const layoutArchetypes = [
  "hero_led",
  "editorial",
  "modular",
  "split",
  "asymmetric",
] as const;
const heroVariants = [
  "split_media",
  "centered_statement",
  "editorial_lede",
  "proof_grid",
] as const;
const sectionVariants = [
  "statement",
  "split",
  "cards",
  "timeline",
  "faq",
  "proof",
  "cta",
] as const;
const contentBlockTypes = [
  "prose",
  "feature_list",
  "steps",
  "metrics",
  "quote",
  "entity_grid",
  "faq_preview",
  "cta",
] as const;
const contentEntityTypes = [
  "product",
  "service",
  "application",
  "case_study",
  "blog",
  "company_news",
] as const;
const schemaRecord = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const SITEOPS_SLOT_ID = /^[a-z][a-z0-9_-]{0,63}$/u;

function assertedHostOwnedEmptyRoutes(
  routeIds: readonly string[],
  hostOwnedEmptyRouteIds: readonly string[],
) {
  const expected = new Set(routeIds);
  const empty = new Set(hostOwnedEmptyRouteIds);
  if (
    empty.size !== hostOwnedEmptyRouteIds.length ||
    [...empty].some((routeId) => routeId !== "news" || !expected.has(routeId))
  ) {
    throw new Error("SITEOPS_HOST_EMPTY_ROUTE_SET_INVALID");
  }
  return empty;
}

/**
 * Slot ids and route grouping are host-owned technical coordinates. Normalize
 * those two coordinates deterministically while leaving all semantic design
 * choices and every unknown field untouched for the strict Zod boundary.
 */
export function normalizeSiteDesignWire(
  value: unknown,
  routeIds: readonly string[],
  paletteSize = 12,
) {
  const paletteCardinality = boundedSiteDesignPaletteSize(paletteSize);
  const record = schemaRecord(value);
  if (!record || !Array.isArray(record.routeSlots)) return value;
  const routeRank = new Map(routeIds.map((routeId, index) => [routeId, index]));
  const seenSlots = new Set<string>();
  const slots = record.routeSlots.flatMap((rawSlot) => {
    const slot = schemaRecord(rawSlot);
    if (!slot) return [rawSlot];
    const routeId =
      typeof slot.routeId === "string" ? slot.routeId.trim() : slot.routeId;
    if (typeof routeId !== "string") return [rawSlot];
    // Unknown model-owned routes are not allowed to expand the frozen site
    // map. Drop them before canonical grouping; the host fills only routes
    // already frozen in SiteBrief.
    if (!routeRank.has(routeId)) return [];
    const variant =
      typeof slot.variant === "string" ? slot.variant.trim() : null;
    const supplied = typeof slot.slotId === "string" ? slot.slotId.trim() : "";
    if (
      !SITEOPS_SLOT_ID.test(supplied) ||
      !variant ||
      !sectionVariants.includes(variant as (typeof sectionVariants)[number])
    ) {
      return [];
    }
    const slotKey = `${routeId}\0${supplied}`;
    // A repeated technical coordinate is not a second semantic section.
    // Preserve the first stable slot and drop later duplicates so content can
    // bind exactly to the frozen design coordinate.
    if (seenSlots.has(slotKey)) return [];
    seenSlots.add(slotKey);
    return [{ ...slot, routeId, slotId: supplied, variant }];
  });
  const ordered = slots
    .map((slot, originalIndex) => ({ slot, originalIndex }))
    .sort((left, right) => {
      const leftRecord = schemaRecord(left.slot);
      const rightRecord = schemaRecord(right.slot);
      const leftRank =
        typeof leftRecord?.routeId === "string"
          ? (routeRank.get(leftRecord.routeId) ?? Number.MAX_SAFE_INTEGER)
          : Number.MAX_SAFE_INTEGER;
      const rightRank =
        typeof rightRecord?.routeId === "string"
          ? (routeRank.get(rightRecord.routeId) ?? Number.MAX_SAFE_INTEGER)
          : Number.MAX_SAFE_INTEGER;
      return leftRank - rightRank || left.originalIndex - right.originalIndex;
    })
    .map(({ slot }) => slot);
  const paletteFallbacks = {
    backgroundPaletteIndex: 0,
    textPaletteIndex: 1,
    accentPaletteIndex: 2,
  } as const;
  const normalizedPalette = Object.fromEntries(
    Object.entries(paletteFallbacks).map(([key, fallback]) => {
      const index = record[key];
      const fallbackIndex = Math.min(fallback, paletteCardinality - 1);
      return [
        key,
        index === undefined ||
        (Number.isInteger(index) &&
          ((index as number) < 0 || (index as number) >= paletteCardinality))
          ? fallbackIndex
          : index,
      ];
    }),
  );
  return { ...record, ...normalizedPalette, routeSlots: ordered };
}

const MANUS_STRUCTURED_SCHEMA_KEYS = new Set([
  "type",
  "enum",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "anyOf",
]);

/**
 * Enforce the documented structured-output subset before any SiteOps request
 * reaches the provider. Business constraints remain in the local Zod schemas;
 * they must not be encoded using provider-unsupported JSON Schema keywords.
 */
export function assertSiteOpsStructuredOutputSchema(
  schema: ManusV2StructuredOutputSchema,
) {
  const visit = (value: unknown, depth: number, coordinate: string) => {
    const record = schemaRecord(value);
    if (!record) {
      throw new Error(`SITEOPS_WIRE_SCHEMA_NODE_INVALID:${coordinate}`);
    }
    if (depth > 5) {
      throw new Error(`SITEOPS_WIRE_SCHEMA_DEPTH_EXCEEDED:${coordinate}`);
    }
    for (const key of Object.keys(record)) {
      if (!MANUS_STRUCTURED_SCHEMA_KEYS.has(key)) {
        throw new Error(
          `SITEOPS_WIRE_SCHEMA_KEY_UNSUPPORTED:${coordinate}.${key}`,
        );
      }
    }
    if (record.type === "object") {
      const properties = schemaRecord(record.properties);
      if (!properties || record.additionalProperties !== false) {
        throw new Error(`SITEOPS_WIRE_SCHEMA_OBJECT_OPEN:${coordinate}`);
      }
      const required = Array.isArray(record.required)
        ? record.required.filter(
            (item): item is string => typeof item === "string",
          )
        : [];
      const propertyNames = Object.keys(properties);
      if (
        required.length !== propertyNames.length ||
        propertyNames.some((property) => !required.includes(property))
      ) {
        throw new Error(`SITEOPS_WIRE_SCHEMA_REQUIRED_MISMATCH:${coordinate}`);
      }
      for (const [property, child] of Object.entries(properties)) {
        visit(child, depth + 1, `${coordinate}.properties.${property}`);
      }
    }
    if (record.type === "array") {
      visit(record.items, depth + 1, `${coordinate}.items`);
    }
    if (Array.isArray(record.anyOf)) {
      for (const [index, child] of record.anyOf.entries()) {
        visit(child, depth + 1, `${coordinate}.anyOf.${index}`);
      }
    }
  };
  const root = schemaRecord(schema);
  if (!root || root.type !== "object") {
    throw new Error("SITEOPS_WIRE_SCHEMA_ROOT_INVALID");
  }
  visit(schema, 1, "root");
  return schema;
}

export function siteDesignWireOutputSchema(input: {
  operationToken: string;
  routeIds: readonly string[];
  paletteSize: number;
}) {
  const paletteIndices = Array.from(
    { length: boundedSiteDesignPaletteSize(input.paletteSize) },
    (_, index) => index,
  );
  return assertSiteOpsStructuredOutputSchema({
    type: "object",
    properties: {
      operationToken: { type: "string", enum: [input.operationToken] },
      schemaVersion: { type: "number", enum: [2] },
      layoutArchetype: { type: "string", enum: [...layoutArchetypes] },
      heroVariant: { type: "string", enum: [...heroVariants] },
      density: {
        type: "string",
        enum: ["compact", "balanced", "spacious"],
      },
      surfaceStyle: {
        type: "string",
        enum: ["flat", "bordered", "soft_depth", "layered"],
      },
      typeScale: {
        type: "string",
        enum: ["restrained", "editorial", "display"],
      },
      imageTreatment: {
        type: "string",
        enum: ["contained", "wide", "masked", "none"],
      },
      motionLevel: { type: "string", enum: ["none", "subtle"] },
      backgroundPaletteIndex: { type: "number", enum: paletteIndices },
      textPaletteIndex: { type: "number", enum: paletteIndices },
      accentPaletteIndex: { type: "number", enum: paletteIndices },
      siteTitle: { type: "string" },
      description: { type: "string" },
      routeSlots: {
        type: "array",
        items: {
          type: "object",
          properties: {
            routeId: { type: "string", enum: [...input.routeIds] },
            slotId: { type: "string" },
            variant: { type: "string", enum: [...sectionVariants] },
          },
          required: ["routeId", "slotId", "variant"],
          additionalProperties: false,
        },
      },
    },
    required: [
      "operationToken",
      "schemaVersion",
      "layoutArchetype",
      "heroVariant",
      "density",
      "surfaceStyle",
      "typeScale",
      "imageTreatment",
      "motionLevel",
      "backgroundPaletteIndex",
      "textPaletteIndex",
      "accentPaletteIndex",
      "siteTitle",
      "description",
      "routeSlots",
    ],
    additionalProperties: false,
  });
}

const siteDesignWireV2Schema = z
  .object({
    operationToken: z.string().min(1).max(128),
    schemaVersion: z.literal(2),
    layoutArchetype: z.enum(layoutArchetypes),
    heroVariant: z.enum(heroVariants),
    density: z.enum(["compact", "balanced", "spacious"]),
    surfaceStyle: z.enum(["flat", "bordered", "soft_depth", "layered"]),
    typeScale: z.enum(["restrained", "editorial", "display"]),
    imageTreatment: z.enum(["contained", "wide", "masked", "none"]),
    motionLevel: z.enum(["none", "subtle"]),
    backgroundPaletteIndex: z.number().int().nonnegative().max(11),
    textPaletteIndex: z.number().int().nonnegative().max(11),
    accentPaletteIndex: z.number().int().nonnegative().max(11),
    siteTitle: z.string().trim().min(1).max(80),
    description: z.string().trim().min(1).max(200),
    routeSlots: z
      .array(
        z
          .object({
            routeId: z.string().trim().min(1).max(64),
            slotId: z
              .string()
              .trim()
              .regex(/^[a-z][a-z0-9_-]{0,63}$/u),
            variant: z.enum(sectionVariants),
          })
          .strict(),
      )
      .max(480),
  })
  .strict();

export function siteDesignResultFromWire(
  value: unknown,
  routeIds: readonly string[],
  hostOwnedEmptyRouteIds: readonly string[] = [],
  paletteSize = 12,
) {
  const emptyRoutes = assertedHostOwnedEmptyRoutes(
    routeIds,
    hostOwnedEmptyRouteIds,
  );
  const providerRouteIds = routeIds.filter(
    (routeId) => !emptyRoutes.has(routeId),
  );
  const wire = siteDesignWireV2Schema.parse(
    normalizeSiteDesignWire(value, providerRouteIds, paletteSize),
  );
  const expectedRouteIds = new Set(providerRouteIds);
  if (
    wire.routeSlots.some((slot) => !expectedRouteIds.has(slot.routeId)) ||
    new Set(providerRouteIds).size !== providerRouteIds.length
  ) {
    throw new Error("SITEOPS_DESIGN_ROUTE_SET_MISMATCH");
  }
  // Wire V2 removes the redundant `order` field. The array itself is the
  // canonical order: routes form contiguous groups in frozen SiteBrief order,
  // and the order within each group becomes the trusted section order.
  const canonicalSlots = providerRouteIds.flatMap((routeId) =>
    wire.routeSlots.filter((slot) => slot.routeId === routeId),
  );
  if (
    canonicalSlots.length !== wire.routeSlots.length ||
    canonicalSlots.some((slot, index) => slot !== wire.routeSlots[index])
  ) {
    throw new Error("SITEOPS_DESIGN_SLOT_ORDER_INVALID");
  }
  const providerCompositions = providerRouteIds.map((routeId) => ({
    routeId,
    slots: (() => {
      const slots = wire.routeSlots
        .filter((slot) => slot.routeId === routeId)
        .map(({ slotId, variant }) => ({ slotId, variant }));
      return slots.length > 0
        ? slots
        : [{ slotId: "overview", variant: "statement" as const }];
    })(),
  }));
  const routeCompositions = routeIds.map((routeId) =>
    emptyRoutes.has(routeId)
      ? {
          routeId,
          slots: [{ slotId: "news-empty", variant: "statement" as const }],
        }
      : providerCompositions.find((route) => route.routeId === routeId)!,
  );
  return siteDesignResultV1Schema.parse({
    operationToken: wire.operationToken,
    designSpec: {
      schemaVersion: 1,
      layoutArchetype: wire.layoutArchetype,
      heroVariant: wire.heroVariant,
      density: wire.density,
      surfaceStyle: wire.surfaceStyle,
      typeScale: wire.typeScale,
      imageTreatment: wire.imageTreatment,
      motionLevel: wire.motionLevel,
      colorRoles: canonicalPaletteRoles(wire, paletteSize),
      routeCompositions,
      seoPlan: {
        siteTitle: wire.siteTitle,
        description: wire.description,
        // Organization type is a Dashboard-owned SEO policy, not model input.
        organizationType: "Organization",
      },
    },
  });
}

/** React Static 2.0 wire contract deliberately omits Hero family and all
 * reference geometry. Those coordinates are frozen by Dashboard before the
 * task is created and injected after provider output validation. */
export function siteDesignWireV3OutputSchema(input: {
  operationToken: string;
  routeIds: readonly string[];
  paletteSize: number;
}) {
  const paletteIndices = Array.from(
    { length: boundedSiteDesignPaletteSize(input.paletteSize) },
    (_, index) => index,
  );
  return assertSiteOpsStructuredOutputSchema({
    type: "object",
    properties: {
      operationToken: { type: "string", enum: [input.operationToken] },
      schemaVersion: { type: "number", enum: [3] },
      layoutArchetype: { type: "string", enum: [...layoutArchetypes] },
      density: { type: "string", enum: ["compact", "balanced", "spacious"] },
      surfaceStyle: {
        type: "string",
        enum: ["flat", "bordered", "soft_depth", "layered"],
      },
      typeScale: {
        type: "string",
        enum: ["restrained", "editorial", "display"],
      },
      imageTreatment: {
        type: "string",
        enum: ["contained", "wide", "masked", "none"],
      },
      motionLevel: { type: "string", enum: ["none", "subtle"] },
      backgroundPaletteIndex: { type: "number", enum: paletteIndices },
      textPaletteIndex: { type: "number", enum: paletteIndices },
      accentPaletteIndex: { type: "number", enum: paletteIndices },
      siteTitle: { type: "string" },
      description: { type: "string" },
      routeSlots: {
        type: "array",
        items: {
          type: "object",
          properties: {
            routeId: { type: "string", enum: [...input.routeIds] },
            slotId: { type: "string" },
            variant: { type: "string", enum: [...sectionVariants] },
          },
          required: ["routeId", "slotId", "variant"],
          additionalProperties: false,
        },
      },
    },
    required: [
      "operationToken",
      "schemaVersion",
      "layoutArchetype",
      "density",
      "surfaceStyle",
      "typeScale",
      "imageTreatment",
      "motionLevel",
      "backgroundPaletteIndex",
      "textPaletteIndex",
      "accentPaletteIndex",
      "siteTitle",
      "description",
      "routeSlots",
    ],
    additionalProperties: false,
  });
}

const siteDesignWireV3Schema = z
  .object({
    operationToken: z.string().min(1).max(128),
    schemaVersion: z.literal(3),
    layoutArchetype: z.enum(layoutArchetypes),
    density: z.enum(["compact", "balanced", "spacious"]),
    surfaceStyle: z.enum(["flat", "bordered", "soft_depth", "layered"]),
    typeScale: z.enum(["restrained", "editorial", "display"]),
    imageTreatment: z.enum(["contained", "wide", "masked", "none"]),
    motionLevel: z.enum(["none", "subtle"]),
    backgroundPaletteIndex: z.number().int().nonnegative().max(11),
    textPaletteIndex: z.number().int().nonnegative().max(11),
    accentPaletteIndex: z.number().int().nonnegative().max(11),
    siteTitle: z.string().trim().min(1).max(80),
    description: z.string().trim().min(1).max(200),
    routeSlots: siteDesignWireV2Schema.shape.routeSlots,
  })
  .strict();

function canonicalRouteCompositions(
  routeIds: readonly string[],
  routeSlots: Array<{
    routeId: string;
    slotId: string;
    variant: (typeof sectionVariants)[number];
  }>,
) {
  const expectedRouteIds = new Set(routeIds);
  if (
    routeSlots.some((slot) => !expectedRouteIds.has(slot.routeId)) ||
    new Set(routeIds).size !== routeIds.length
  ) {
    throw new Error("SITEOPS_DESIGN_ROUTE_SET_MISMATCH");
  }
  const canonicalSlots = routeIds.flatMap((routeId) =>
    routeSlots.filter((slot) => slot.routeId === routeId),
  );
  if (
    canonicalSlots.length !== routeSlots.length ||
    canonicalSlots.some((slot, index) => slot !== routeSlots[index])
  ) {
    throw new Error("SITEOPS_DESIGN_SLOT_ORDER_INVALID");
  }
  const routeCompositions = routeIds.map((routeId) => {
    const slots = routeSlots
      .filter((slot) => slot.routeId === routeId)
      .map(({ slotId, variant }) => ({ slotId, variant }));
    return {
      routeId,
      slots:
        slots.length > 0
          ? slots
          : [{ slotId: "overview", variant: "statement" as const }],
    };
  });
  return routeCompositions;
}

function canonicalPaletteRoles(
  wire: {
    backgroundPaletteIndex: number;
    textPaletteIndex: number;
    accentPaletteIndex: number;
  },
  paletteSize: number,
) {
  const boundedPaletteSize = boundedSiteDesignPaletteSize(paletteSize);
  const safe = (index: number, fallback: number) =>
    index < boundedPaletteSize
      ? index
      : Math.min(fallback, boundedPaletteSize - 1);
  return {
    backgroundPaletteIndex: safe(wire.backgroundPaletteIndex, 0),
    textPaletteIndex: safe(wire.textPaletteIndex, 1),
    accentPaletteIndex: safe(wire.accentPaletteIndex, 2),
  };
}

export function siteDesignResultV2FromWire(
  value: unknown,
  routeIds: readonly string[],
  referenceBlueprint: ReferenceBlueprint,
  hostOwnedEmptyRouteIds: readonly string[] = [],
  paletteSize = 12,
) {
  const emptyRoutes = assertedHostOwnedEmptyRoutes(
    routeIds,
    hostOwnedEmptyRouteIds,
  );
  const providerRouteIds = routeIds.filter(
    (routeId) => !emptyRoutes.has(routeId),
  );
  const wire = siteDesignWireV3Schema.parse(
    normalizeSiteDesignWire(value, providerRouteIds, paletteSize),
  );
  const providerCompositions = canonicalRouteCompositions(
    providerRouteIds,
    wire.routeSlots,
  );
  return siteDesignResultV2Schema.parse({
    operationToken: wire.operationToken,
    designSpec: {
      schemaVersion: 2,
      referenceBlueprint,
      layoutArchetype: wire.layoutArchetype,
      density: wire.density,
      surfaceStyle: wire.surfaceStyle,
      typeScale: wire.typeScale,
      imageTreatment: wire.imageTreatment,
      motionLevel: wire.motionLevel,
      colorRoles: canonicalPaletteRoles(wire, paletteSize),
      routeCompositions: routeIds.map((routeId) =>
        emptyRoutes.has(routeId)
          ? {
              routeId,
              slots: [{ slotId: "news-empty", variant: "statement" as const }],
            }
          : providerCompositions.find((route) => route.routeId === routeId)!,
      ),
      seoPlan: {
        siteTitle: wire.siteTitle,
        description: wire.description,
        organizationType: "Organization",
      },
    },
  });
}

export function pageContentWireOutputSchema(input: {
  operationToken: string;
  routeIds: readonly string[];
  sourceDocumentIds: readonly string[];
}) {
  void input.sourceDocumentIds;
  return assertSiteOpsStructuredOutputSchema({
    type: "object",
    properties: {
      operationToken: { type: "string", enum: [input.operationToken] },
      schemaVersion: { type: "number", enum: [2] },
      routes: {
        type: "array",
        items: {
          type: "object",
          properties: {
            routeId: { type: "string", enum: [...input.routeIds] },
            eyebrow: {
              anyOf: [{ type: "string" }, { type: "null" }],
            },
            heading: { type: "string" },
            summary: { type: "string" },
          },
          required: ["routeId", "eyebrow", "heading", "summary"],
          additionalProperties: false,
        },
      },
      sections: {
        type: "array",
        items: {
          type: "object",
          properties: {
            routeId: { type: "string", enum: [...input.routeIds] },
            slotId: { type: "string" },
            heading: { type: "string" },
            paragraphs: { type: "array", items: { type: "string" } },
            sourceDocumentIds: {
              type: "array",
              items: { type: "string" },
            },
          },
          required: [
            "routeId",
            "slotId",
            "heading",
            "paragraphs",
            "sourceDocumentIds",
          ],
          additionalProperties: false,
        },
      },
    },
    required: ["operationToken", "schemaVersion", "routes", "sections"],
    additionalProperties: false,
  });
}

const pageContentWireV2Schema = z
  .object({
    operationToken: z.string().min(1).max(128),
    schemaVersion: z.literal(2),
    routes: z
      .array(
        z
          .object({
            routeId: z.string().trim().min(1).max(64),
            eyebrow: z.string().trim().min(1).max(100).nullable(),
            heading: z.string().trim().min(1).max(180),
            summary: z.string().trim().min(1).max(600),
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
      .max(480),
  })
  .strict();

export function pageContentResultFromWire(
  value: unknown,
  routeIds: readonly string[],
  sourceDocumentIds: readonly string[],
) {
  const wire = pageContentWireV2Schema.parse(value);
  const expectedRouteIds = new Set(routeIds);
  const allowedSourceDocumentIds = new Set(sourceDocumentIds);
  if (
    wire.routes.length !== routeIds.length ||
    new Set(wire.routes.map((route) => route.routeId)).size !==
      routeIds.length ||
    wire.routes.some((route) => !expectedRouteIds.has(route.routeId)) ||
    wire.sections.some(
      (section) =>
        !expectedRouteIds.has(section.routeId) ||
        section.sourceDocumentIds.some(
          (documentId) => !allowedSourceDocumentIds.has(documentId),
        ),
    )
  ) {
    throw new Error("SITEOPS_CONTENT_SOURCE_OR_ROUTE_MISMATCH");
  }
  const routesById = new Map(
    wire.routes.map((route) => [route.routeId, route]),
  );
  return pageContentResultV1Schema.parse({
    operationToken: wire.operationToken,
    pageContent: {
      schemaVersion: 1,
      routes: routeIds.map((routeId) => {
        const route = routesById.get(routeId);
        if (!route) throw new Error("SITEOPS_CONTENT_ROUTE_SET_MISMATCH");
        return {
          routeId,
          ...(route.eyebrow ? { eyebrow: route.eyebrow } : {}),
          heading: route.heading,
          summary: route.summary,
          sections: wire.sections
            .filter((section) => section.routeId === routeId)
            .map(({ routeId: _routeId, ...section }) => section),
        };
      }),
    },
  });
}

/** React Static 2.2 provider wire. Arrays remain flat enough for Manus'
 * structured-output subset; Dashboard converts them into the canonical typed
 * content graph only after validating snapshot source bindings. */
export function pageContentWireV3OutputSchema(input: {
  operationToken: string;
  routeIds: readonly string[];
  sourceDocumentIds: readonly string[];
}) {
  void input.sourceDocumentIds;
  const sourceIds = { type: "array", items: { type: "string" } } as const;
  const nullableString = {
    anyOf: [{ type: "string" }, { type: "null" }],
  } as const;
  return assertSiteOpsStructuredOutputSchema({
    type: "object",
    properties: {
      operationToken: { type: "string", enum: [input.operationToken] },
      schemaVersion: { type: "number", enum: [3] },
      routes: {
        type: "array",
        items: {
          type: "object",
          properties: {
            routeId: { type: "string", enum: [...input.routeIds] },
            eyebrow: nullableString,
            heading: { type: "string" },
            summary: { type: "string" },
          },
          required: ["routeId", "eyebrow", "heading", "summary"],
          additionalProperties: false,
        },
      },
      blocks: {
        type: "array",
        items: {
          type: "object",
          properties: {
            routeId: { type: "string", enum: [...input.routeIds] },
            slotId: { type: "string" },
            blockType: { type: "string", enum: [...contentBlockTypes] },
            heading: { type: "string" },
            paragraphs: { type: "array", items: { type: "string" } },
            items: { type: "array", items: { type: "string" } },
            entityIds: { type: "array", items: { type: "string" } },
            faqIds: { type: "array", items: { type: "string" } },
            sourceDocumentIds: sourceIds,
          },
          required: [
            "routeId",
            "slotId",
            "blockType",
            "heading",
            "paragraphs",
            "items",
            "entityIds",
            "faqIds",
            "sourceDocumentIds",
          ],
          additionalProperties: false,
        },
      },
      entities: {
        type: "array",
        items: {
          type: "object",
          properties: {
            entityId: { type: "string" },
            entityType: { type: "string", enum: [...contentEntityTypes] },
            slug: { type: "string" },
            title: { type: "string" },
            summary: { type: "string" },
            body: { type: "array", items: { type: "string" } },
            tags: { type: "array", items: { type: "string" } },
            publishedAt: nullableString,
            modifiedAt: nullableString,
            author: nullableString,
            sourceName: nullableString,
            sourceUrl: nullableString,
            sourceDocumentIds: sourceIds,
            relatedEntityIds: { type: "array", items: { type: "string" } },
          },
          required: [
            "entityId",
            "entityType",
            "slug",
            "title",
            "summary",
            "body",
            "tags",
            "publishedAt",
            "modifiedAt",
            "author",
            "sourceName",
            "sourceUrl",
            "sourceDocumentIds",
            "relatedEntityIds",
          ],
          additionalProperties: false,
        },
      },
      faqs: {
        type: "array",
        items: {
          type: "object",
          properties: {
            faqId: { type: "string" },
            category: nullableString,
            question: { type: "string" },
            answers: { type: "array", items: { type: "string" } },
            sourceDocumentIds: sourceIds,
          },
          required: [
            "faqId",
            "category",
            "question",
            "answers",
            "sourceDocumentIds",
          ],
          additionalProperties: false,
        },
      },
      officialLinks: {
        type: "array",
        items: {
          type: "object",
          properties: {
            kind: { type: "string", enum: ["same_as", "reference"] },
            label: { type: "string" },
            url: { type: "string" },
            sourceDocumentIds: sourceIds,
          },
          required: ["kind", "label", "url", "sourceDocumentIds"],
          additionalProperties: false,
        },
      },
    },
    required: [
      "operationToken",
      "schemaVersion",
      "routes",
      "blocks",
      "entities",
      "faqs",
      "officialLinks",
    ],
    additionalProperties: false,
  });
}

const pageContentWireV3Schema = z
  .object({
    operationToken: z.string().min(1).max(128),
    schemaVersion: z.literal(3),
    routes: pageContentWireV2Schema.shape.routes,
    blocks: z
      .array(
        z
          .object({
            routeId: z.string().trim().min(1).max(64),
            slotId: z
              .string()
              .trim()
              .regex(/^[a-z][a-z0-9_-]{0,63}$/u),
            blockType: z.enum(contentBlockTypes),
            heading: z.string().trim().min(1).max(160),
            paragraphs: z.array(z.string().trim().min(1).max(2_000)).max(16),
            items: z.array(z.string().trim().min(1).max(500)).max(24),
            entityIds: z.array(z.string().trim().min(1).max(64)).max(24),
            faqIds: z.array(z.string().trim().min(1).max(64)).max(24),
            sourceDocumentIds: z
              .array(z.string().trim().min(1).max(191))
              .min(1)
              .max(50),
          })
          .strict(),
      )
      .min(1)
      .max(480),
    entities: z
      .array(
        z
          .object({
            entityId: z
              .string()
              .trim()
              .regex(/^[a-z][a-z0-9_-]{0,63}$/u),
            entityType: z.enum(contentEntityTypes),
            slug: z.string().trim().min(1).max(191),
            title: z.string().trim().min(1).max(180),
            summary: z.string().trim().min(1).max(600),
            body: z.array(z.string().trim().min(1).max(2_000)).min(1).max(24),
            tags: z.array(z.string().trim().min(1).max(80)).max(20),
            publishedAt: z.string().trim().min(1).max(64).nullable(),
            modifiedAt: z.string().trim().min(1).max(64).nullable(),
            author: z.string().trim().min(1).max(160).nullable(),
            sourceName: z.string().trim().min(1).max(255).nullable(),
            sourceUrl: z.string().url().max(2_048).nullable(),
            sourceDocumentIds: z
              .array(z.string().trim().min(1).max(191))
              .min(1)
              .max(50),
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
            sourceDocumentIds: z
              .array(z.string().trim().min(1).max(191))
              .min(1)
              .max(50),
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
            sourceDocumentIds: z
              .array(z.string().trim().min(1).max(191))
              .min(1)
              .max(50),
          })
          .strict(),
      )
      .max(30),
  })
  .strict();

export function pageContentResultV2FromWire(
  value: unknown,
  routeIds: readonly string[],
  sourceDocumentIds: readonly string[],
  emptyRouteIds: readonly string[] = [],
) {
  const wire = pageContentWireV3Schema.parse(value);
  const emptyRoutes = assertedHostOwnedEmptyRoutes(routeIds, emptyRouteIds);
  const providerRouteIds = routeIds.filter(
    (routeId) => !emptyRoutes.has(routeId),
  );
  const expectedRouteIds = new Set(providerRouteIds);
  const allowedSourceDocumentIds = new Set(sourceDocumentIds);
  const sourceSets = [
    ...wire.blocks.map((item) => item.sourceDocumentIds),
    ...wire.entities.map((item) => item.sourceDocumentIds),
    ...wire.faqs.map((item) => item.sourceDocumentIds),
    ...wire.officialLinks.map((item) => item.sourceDocumentIds),
  ];
  if (
    wire.routes.length !== providerRouteIds.length ||
    new Set(wire.routes.map((route) => route.routeId)).size !==
      providerRouteIds.length ||
    wire.routes.some((route) => !expectedRouteIds.has(route.routeId)) ||
    wire.blocks.some((block) => !expectedRouteIds.has(block.routeId)) ||
    (emptyRoutes.has("news") &&
      wire.entities.some((entity) => entity.entityType === "company_news")) ||
    sourceSets.some((ids) =>
      ids.some((documentId) => !allowedSourceDocumentIds.has(documentId)),
    )
  ) {
    throw new Error("SITEOPS_CONTENT_SOURCE_OR_ROUTE_MISMATCH");
  }
  const routesById = new Map(
    wire.routes.map((route) => [route.routeId, route]),
  );
  return pageContentResultV2Schema.parse({
    operationToken: wire.operationToken,
    pageContent: {
      schemaVersion: 2,
      routes: routeIds.map((routeId) => {
        if (emptyRoutes.has(routeId)) {
          return {
            routeId,
            heading: "企业动态",
            summary: "当前知识库暂无可公开的企业动态。",
            emptyState: "company_news_unavailable" as const,
            sections: [],
          };
        }
        const route = routesById.get(routeId);
        if (!route) throw new Error("SITEOPS_CONTENT_ROUTE_SET_MISMATCH");
        return {
          routeId,
          ...(route.eyebrow ? { eyebrow: route.eyebrow } : {}),
          heading: route.heading,
          summary: route.summary,
          sections: wire.blocks
            .filter((block) => block.routeId === routeId)
            .map(({ routeId: _routeId, ...block }) => block),
        };
      }),
      entities: wire.entities.map((entity) => ({
        ...entity,
        slug: canonicalSiteContentEntitySlug(entity.slug, entity.entityId),
      })),
      faqs: wire.faqs,
      officialLinks: wire.officialLinks,
    },
  });
}

export function socialWireOutputSchema(input: {
  operationToken: string;
  channel: "wechat" | "xiaohongshu";
  sourceDocumentIds: readonly string[];
}) {
  void input.channel;
  void input.sourceDocumentIds;
  return assertSiteOpsStructuredOutputSchema({
    type: "object",
    properties: {
      operationToken: { type: "string", enum: [input.operationToken] },
      companyName: { type: "string" },
      title: { type: "string" },
      deck: { type: "string" },
      sourceDocuments: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            title: { type: "string" },
          },
          required: ["id", "title"],
          additionalProperties: false,
        },
      },
      sections: {
        type: "array",
        items: {
          type: "object",
          properties: {
            heading: { type: "string" },
            paragraphs: { type: "array", items: { type: "string" } },
            sourceDocumentIds: {
              type: "array",
              items: { type: "string" },
            },
          },
          required: ["heading", "paragraphs", "sourceDocumentIds"],
          additionalProperties: false,
        },
      },
      hashtags: { type: "array", items: { type: "string" } },
    },
    required: [
      "operationToken",
      "companyName",
      "title",
      "deck",
      "sourceDocuments",
      "sections",
      "hashtags",
    ],
    additionalProperties: false,
  });
}

export type SiteOpsSourceDocument = {
  id: string;
  path: string;
  title: string;
  content: string;
  kind?: string;
  customerVisible: true;
};

function jsonAttachment(filename: string, value: unknown) {
  const bytes = Buffer.from(canonicalJson(value), "utf8");
  if (bytes.length < 1 || bytes.length > 16 * 1024 * 1024) {
    throw new Error("SITEOPS_SOURCE_DOSSIER_ATTACHMENT_TOO_LARGE");
  }
  return {
    filename,
    mime_type: "application/json",
    file_data: `data:application/json;base64,${bytes.toString("base64")}`,
  } as const;
}

function documentSegments(document: SiteOpsSourceDocument) {
  const originalContentSha256 = createHash("sha256")
    .update(document.content, "utf8")
    .digest("hex");
  // JSON escaping can expand control-heavy input by up to six bytes per
  // character. A 2 MiB raw segment therefore remains below the 16 MiB inline
  // attachment ceiling even in that worst case.
  const maxSegmentBytes = 2 * 1024 * 1024;
  if (Buffer.byteLength(document.content, "utf8") <= maxSegmentBytes) {
    return [
      {
        ...document,
        contentPartIndex: 1,
        contentPartCount: 1,
        contentSha256: originalContentSha256,
        originalContentSha256,
      },
    ];
  }
  const paragraphs = document.content.split(/(?<=\n\n)/u);
  const contents: string[] = [];
  let current = "";
  const flush = () => {
    if (current) contents.push(current);
    current = "";
  };
  for (const paragraph of paragraphs) {
    if (Buffer.byteLength(current + paragraph, "utf8") <= maxSegmentBytes) {
      current += paragraph;
      continue;
    }
    flush();
    let remainder = paragraph;
    while (Buffer.byteLength(remainder, "utf8") > maxSegmentBytes) {
      const characters = Array.from(remainder);
      let low = 1;
      let high = characters.length;
      while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        if (
          Buffer.byteLength(characters.slice(0, middle).join(""), "utf8") <=
          maxSegmentBytes
        ) {
          low = middle;
        } else {
          high = middle - 1;
        }
      }
      contents.push(characters.slice(0, low).join(""));
      remainder = characters.slice(low).join("");
    }
    current = remainder;
  }
  flush();
  return contents.map((content, index) => ({
    ...document,
    content,
    contentPartIndex: index + 1,
    contentPartCount: contents.length,
    contentSha256: createHash("sha256").update(content, "utf8").digest("hex"),
    originalContentSha256,
  }));
}

export function siteOpsSourceDossierAttachments(input: {
  operationToken: string;
  snapshot: {
    id: string;
    archiveSha256: string;
    sourceBuildId: string | null;
    sourceBuildRevision: number | null;
  };
  brief: unknown;
  visualEvidence: unknown;
  documents: readonly SiteOpsSourceDocument[];
}) {
  const documents = input.documents.map((document) => ({
    ...document,
    contentSha256: createHash("sha256")
      .update(document.content, "utf8")
      .digest("hex"),
  }));
  const payload = {
    schemaVersion: 1,
    operationToken: input.operationToken,
    snapshot: input.snapshot,
    brief: input.brief,
    visualEvidence: input.visualEvidence,
    documents,
  };
  const dossierSha256 = createHash("sha256")
    .update(canonicalJson(payload), "utf8")
    .digest("hex");
  const dossier = {
    ...payload,
    dossierSha256,
  };
  if (Buffer.byteLength(canonicalJson(dossier), "utf8") <= 16 * 1024 * 1024) {
    return [
      jsonAttachment("frontmind-siteops-source-dossier-v1.json", dossier),
    ];
  }

  const segments = input.documents.flatMap(documentSegments);
  const groups: (typeof segments)[] = [];
  let group: typeof segments = [];
  const partEnvelope = (
    items: typeof segments,
    index: number,
    count: number,
  ) => ({
    schemaVersion: 1,
    operationToken: input.operationToken,
    dossierSha256,
    partIndex: index,
    partCount: count,
    documents: items,
  });
  for (const segment of segments) {
    const candidate = [...group, segment];
    if (
      group.length > 0 &&
      Buffer.byteLength(
        canonicalJson(partEnvelope(candidate, 999, 999)),
        "utf8",
      ) >
        15 * 1024 * 1024
    ) {
      groups.push(group);
      group = [segment];
    } else {
      group = candidate;
    }
  }
  if (group.length > 0) groups.push(group);
  const partCount = groups.length;
  const partValues = groups.map((items, index) =>
    partEnvelope(items, index + 1, partCount),
  );
  const parts = partValues.map((part, index) => {
    const filename = `frontmind-siteops-source-dossier-part-${String(index + 1).padStart(2, "0")}.json`;
    const bytes = Buffer.from(canonicalJson(part), "utf8");
    return {
      filename,
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      documentParts: part.documents.map((document) => ({
        id: document.id,
        contentPartIndex: document.contentPartIndex,
        contentPartCount: document.contentPartCount,
        contentSha256: document.contentSha256,
        originalContentSha256: document.originalContentSha256,
      })),
    };
  });
  const manifest = {
    schemaVersion: 1,
    operationToken: input.operationToken,
    snapshot: input.snapshot,
    brief: input.brief,
    visualEvidence: input.visualEvidence,
    dossierSha256,
    split: true,
    documents: documents.map(({ content: _content, ...document }) => document),
    parts,
  };
  return [
    jsonAttachment("frontmind-siteops-source-dossier-v1.json", manifest),
    ...partValues.map((part, index) =>
      jsonAttachment(parts[index]!.filename, part),
    ),
  ];
}

export function siteOpsBuildContractAttachment(contract: unknown) {
  return jsonAttachment("frontmind-build-contract-v2.json", contract);
}

export function siteOpsBuildPlanContractV3Attachment(contract: unknown) {
  return jsonAttachment("frontmind-build-plan-contract-v3.json", contract);
}

export function siteOpsBuildPlanContractV4Attachment(contract: unknown) {
  return jsonAttachment("frontmind-build-plan-contract-v4.json", contract);
}

export function siteOpsCustomerFeedbackAttachment(feedback: string) {
  const value = {
    schemaVersion: 1,
    customerFeedback: feedback,
    feedbackSha256: createHash("sha256").update(feedback, "utf8").digest("hex"),
  };
  return jsonAttachment("frontmind-customer-feedback-v1.json", value);
}

export function siteOpsSocialSourceAttachment(input: {
  operationToken: string;
  documents: readonly SiteOpsSourceDocument[];
}) {
  const payload = {
    schemaVersion: 1,
    operationToken: input.operationToken,
    documents: input.documents.map((document) => ({
      ...document,
      contentSha256: createHash("sha256")
        .update(document.content, "utf8")
        .digest("hex"),
    })),
  };
  return jsonAttachment("frontmind-social-source-documents-v1.json", {
    ...payload,
    sourceSha256: createHash("sha256")
      .update(canonicalJson(payload), "utf8")
      .digest("hex"),
  });
}
