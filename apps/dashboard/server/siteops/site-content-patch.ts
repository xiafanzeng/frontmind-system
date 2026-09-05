import {
  siteContentSlotPatchV1Schema,
  siteContentPatchV1Schema,
  type SiteContentPatchV1,
} from "../../shared/siteops-content-patch";
import { z } from "zod";
import {
  canonicalPreviewModelV1Schema,
  type CanonicalPreviewModelV1,
} from "./site-content-draft";

export type SiteContentPatchWarning = {
  code:
    | "patch_invalid"
    | "page_invalid"
    | "slot_schema_invalid"
    | "duplicate_route"
    | "duplicate_slot"
    | "unknown_route"
    | "unknown_slot"
    | "slot_kind_mismatch"
    | "source_binding_invalid"
    | "asset_binding_invalid"
    | "target_route_invalid"
    | "slot_kind_not_materialized";
  routeId: string;
  slotId?: string;
};

const MAX_PATCH_WIRE_BYTES = 1024 * 1024;

const patchPageEnvelopeSchema = z
  .object({
    routeId: z.string().trim().min(1).max(64),
    slots: z.array(z.unknown()).max(16),
  })
  .strict();

const patchEnvelopeSchema = z
  .object({
    schemaVersion: z.literal(1),
    operationToken: z.string().trim().min(1).max(191),
    baseSourceSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    pages: z.array(z.unknown()).max(30),
  })
  .strict();

function stripWholeJsonFence(value: string) {
  const trimmed = value.trim();
  if (!trimmed.startsWith("```") || !trimmed.endsWith("```")) {
    return trimmed;
  }
  const firstLineEnd = trimmed.indexOf("\n");
  if (firstLineEnd < 0) return trimmed;
  const language = trimmed.slice(3, firstLineEnd).trim().toLowerCase();
  if (language !== "" && language !== "json" && language !== "jsonc") {
    return trimmed;
  }
  return trimmed.slice(firstLineEnd + 1, -3).trim();
}

/** Remove only JSONC comments. Quoted content is copied byte-for-byte. */
function stripJsonComments(value: string) {
  let output = "";
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!;
    const next = value[index + 1];
    if (quoted) {
      output += character;
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') {
      quoted = true;
      output += character;
      continue;
    }
    if (character === "/" && next === "/") {
      index += 2;
      while (index < value.length && value[index] !== "\n") index += 1;
      output += "\n";
      continue;
    }
    if (character === "/" && next === "*") {
      index += 2;
      let closed = false;
      while (index < value.length) {
        if (value[index] === "\n") output += "\n";
        if (value[index] === "*" && value[index + 1] === "/") {
          index += 1;
          closed = true;
          break;
        }
        index += 1;
      }
      if (!closed) throw new Error("SITE_CONTENT_PATCH_JSONC_UNTERMINATED");
      continue;
    }
    output += character;
  }
  return output;
}

/** Remove commas only when the next non-space token closes an array/object. */
function stripJsonTrailingCommas(value: string) {
  let output = "";
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!;
    if (quoted) {
      output += character;
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') {
      quoted = true;
      output += character;
      continue;
    }
    if (character === ",") {
      let lookahead = index + 1;
      while (/\s/u.test(value[lookahead] ?? "")) lookahead += 1;
      if (value[lookahead] === "}" || value[lookahead] === "]") continue;
    }
    output += character;
  }
  return output;
}

function parseBoundedJson(value: string) {
  if (Buffer.byteLength(value, "utf8") > MAX_PATCH_WIRE_BYTES) {
    throw new Error("SITE_CONTENT_PATCH_WIRE_TOO_LARGE");
  }
  const withoutBom = value.charCodeAt(0) === 0xfeff ? value.slice(1) : value;
  return JSON.parse(
    stripJsonTrailingCommas(stripJsonComments(stripWholeJsonFence(withoutBom))),
  ) as unknown;
}

/**
 * Parse the deliberately small set of provider transport variations we own.
 * It permits one string-encoded JSON layer, but never guesses unknown escapes,
 * evaluates code, accepts JSON5 identifiers, or recursively unwraps strings.
 */
export function normalizeSiteContentPatchV1Wire(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const parsed = parseBoundedJson(value);
  return typeof parsed === "string" ? parseBoundedJson(parsed) : parsed;
}

function normalizedPatchText(value: string, maxLength: number) {
  return Array.from(
    value
      .normalize("NFKC")
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, " ")
      .replace(/<[^>]{1,256}>/gu, " ")
      .replace(/\s+/gu, " ")
      .trim(),
  )
    .slice(0, maxLength)
    .join("");
}

function exactCoordinate(actual: string, expected: string, code: string) {
  if (actual.length !== expected.length || actual !== expected) {
    throw new Error(code);
  }
}

/**
 * Apply a provider patch only to route/slot coordinates already owned by the
 * host baseline. Invalid children are ignored individually and leave the
 * trusted baseline value in place; task/hash mismatches reject the whole
 * patch because they cross an immutable build boundary.
 */
export function applySiteContentPatchV1(input: {
  patch: SiteContentPatchV1 | unknown;
  expectedOperationToken: string;
  expectedBaseSourceSha256: string;
  baseline: CanonicalPreviewModelV1;
  allowedSourceIdsByRoute: Readonly<Record<string, readonly string[]>>;
  allowedAssetIds?: readonly string[];
}) {
  const patch = siteContentPatchV1Schema.parse(input.patch);
  exactCoordinate(
    patch.operationToken,
    input.expectedOperationToken,
    "SITE_CONTENT_PATCH_TOKEN_MISMATCH",
  );
  exactCoordinate(
    patch.baseSourceSha256,
    input.expectedBaseSourceSha256,
    "SITE_CONTENT_PATCH_BASE_HASH_MISMATCH",
  );
  const baseline = canonicalPreviewModelV1Schema.parse(input.baseline);
  const routes = baseline.routes.map((route) => ({
    ...route,
    sections: route.sections.map((section) => ({ ...section })),
  }));
  const routeById = new Map(routes.map((route) => [route.routeId, route]));
  const knownRouteIds = new Set(routeById.keys());
  const allowedAssets = new Set(input.allowedAssetIds ?? []);
  const warnings: SiteContentPatchWarning[] = [];
  let appliedSlotCount = 0;

  for (const page of patch.pages) {
    const route = routeById.get(page.routeId);
    if (!route) {
      warnings.push({ code: "unknown_route", routeId: page.routeId });
      continue;
    }
    const slotById = new Map(
      route.sections.map((section) => [section.slotId, section]),
    );
    const allowedSources = new Set(
      input.allowedSourceIdsByRoute[page.routeId] ?? [],
    );
    for (const slotPatch of page.slots) {
      const slot = slotById.get(slotPatch.slotId);
      if (!slot) {
        warnings.push({
          code: "unknown_slot",
          routeId: page.routeId,
          slotId: slotPatch.slotId,
        });
        continue;
      }
      if (slotPatch.kind === "image") {
        warnings.push({
          code: allowedAssets.has(slotPatch.value.assetId)
            ? "slot_kind_not_materialized"
            : "asset_binding_invalid",
          routeId: page.routeId,
          slotId: slotPatch.slotId,
        });
        continue;
      }
      if (slotPatch.kind === "link") {
        warnings.push({
          code: knownRouteIds.has(slotPatch.value.targetRouteId)
            ? "slot_kind_not_materialized"
            : "target_route_invalid",
          routeId: page.routeId,
          slotId: slotPatch.slotId,
        });
        continue;
      }
      const expectedKind =
        slot.blockType === "feature_list" ? "list" : "richText";
      const normalizedKind =
        slotPatch.kind === "text" ? "richText" : slotPatch.kind;
      if (normalizedKind !== expectedKind) {
        warnings.push({
          code: "slot_kind_mismatch",
          routeId: page.routeId,
          slotId: slotPatch.slotId,
        });
        continue;
      }
      if (
        slotPatch.sourceIds.length < 1 ||
        slotPatch.sourceIds.some((sourceId) => !allowedSources.has(sourceId))
      ) {
        warnings.push({
          code: "source_binding_invalid",
          routeId: page.routeId,
          slotId: slotPatch.slotId,
        });
        continue;
      }
      if (
        slotPatch.kind === "text" ||
        slotPatch.kind === "richText"
      ) {
        const value = normalizedPatchText(slotPatch.value, 2_000);
        if (!value) {
          warnings.push({
            code: "source_binding_invalid",
            routeId: page.routeId,
            slotId: slotPatch.slotId,
          });
          continue;
        }
        slot.paragraphs = [value];
        slot.items = [];
        slot.blockType = "prose";
        slot.sourceDocumentIds = [...new Set(slotPatch.sourceIds)];
        delete slot.grounding;
        appliedSlotCount += 1;
        continue;
      }
      if (slotPatch.kind === "list") {
        const items = slotPatch.value
          .map((value) => normalizedPatchText(value, 500))
          .filter(Boolean)
          .slice(0, 24);
        if (items.length < 1) continue;
        slot.paragraphs = [];
        slot.items = items;
        slot.blockType = "feature_list";
        slot.sourceDocumentIds = [...new Set(slotPatch.sourceIds)];
        delete slot.grounding;
        appliedSlotCount += 1;
        continue;
      }
    }
  }

  return {
    canonical: canonicalPreviewModelV1Schema.parse({ ...baseline, routes }),
    warnings,
    appliedSlotCount,
  };
}

export type ResilientSiteContentPatchResult = {
  canonical: CanonicalPreviewModelV1;
  warnings: SiteContentPatchWarning[];
  renderMode: "content_patch" | "trusted_fallback";
  appliedSlotCount: number;
};

function fallbackResult(
  baseline: CanonicalPreviewModelV1,
  warnings: SiteContentPatchWarning[],
): ResilientSiteContentPatchResult {
  return {
    canonical: canonicalPreviewModelV1Schema.parse(baseline),
    warnings,
    renderMode: "trusted_fallback",
    appliedSlotCount: 0,
  };
}

/**
 * Provider-facing fail-soft entry point. A malformed envelope, timeout/null,
 * prose response, or immutable-coordinate mismatch yields the trusted
 * baseline. Malformed child slots are omitted individually so valid siblings
 * can still be shown.
 */
export function applySiteContentPatchV1Resilient(input: {
  patch: unknown | null;
  expectedOperationToken: string;
  expectedBaseSourceSha256: string;
  baseline: CanonicalPreviewModelV1;
  allowedSourceIdsByRoute: Readonly<Record<string, readonly string[]>>;
  allowedAssetIds?: readonly string[];
}): ResilientSiteContentPatchResult {
  const baseline = canonicalPreviewModelV1Schema.parse(input.baseline);
  let normalized: unknown;
  try {
    normalized = normalizeSiteContentPatchV1Wire(input.patch);
  } catch {
    return fallbackResult(baseline, [{ code: "patch_invalid", routeId: "*" }]);
  }
  const envelope = patchEnvelopeSchema.safeParse(normalized);
  if (!envelope.success) {
    return fallbackResult(baseline, [{ code: "patch_invalid", routeId: "*" }]);
  }
  if (
    envelope.data.operationToken !== input.expectedOperationToken ||
    envelope.data.baseSourceSha256 !== input.expectedBaseSourceSha256
  ) {
    return fallbackResult(baseline, [{ code: "patch_invalid", routeId: "*" }]);
  }

  const warnings: SiteContentPatchWarning[] = [];
  const pages: SiteContentPatchV1["pages"] = [];
  const routeIds = new Set<string>();
  for (const rawPage of envelope.data.pages) {
    const page = patchPageEnvelopeSchema.safeParse(rawPage);
    if (!page.success) {
      warnings.push({ code: "page_invalid", routeId: "*" });
      continue;
    }
    if (routeIds.has(page.data.routeId)) {
      warnings.push({ code: "duplicate_route", routeId: page.data.routeId });
      continue;
    }
    routeIds.add(page.data.routeId);
    const slots: SiteContentPatchV1["pages"][number]["slots"] = [];
    const slotIds = new Set<string>();
    for (const rawSlot of page.data.slots) {
      const slot = siteContentSlotPatchV1Schema.safeParse(rawSlot);
      if (!slot.success) {
        warnings.push({
          code: "slot_schema_invalid",
          routeId: page.data.routeId,
          ...(rawSlot &&
          typeof rawSlot === "object" &&
          !Array.isArray(rawSlot) &&
          typeof (rawSlot as Record<string, unknown>).slotId === "string"
            ? {
                slotId: String(
                  (rawSlot as Record<string, unknown>).slotId,
                ).slice(0, 64),
              }
            : {}),
        });
        continue;
      }
      if (slotIds.has(slot.data.slotId)) {
        warnings.push({
          code: "duplicate_slot",
          routeId: page.data.routeId,
          slotId: slot.data.slotId,
        });
        continue;
      }
      slotIds.add(slot.data.slotId);
      slots.push(slot.data);
    }
    pages.push({ routeId: page.data.routeId, slots });
  }

  const applied = applySiteContentPatchV1({
    patch: {
      schemaVersion: 1,
      operationToken: envelope.data.operationToken,
      baseSourceSha256: envelope.data.baseSourceSha256,
      pages,
    },
    expectedOperationToken: input.expectedOperationToken,
    expectedBaseSourceSha256: input.expectedBaseSourceSha256,
    baseline,
    allowedSourceIdsByRoute: input.allowedSourceIdsByRoute,
    allowedAssetIds: input.allowedAssetIds,
  });
  const combinedWarnings = [...warnings, ...applied.warnings];
  if (applied.appliedSlotCount === 0) {
    return fallbackResult(baseline, combinedWarnings);
  }
  return {
    ...applied,
    warnings: combinedWarnings,
    renderMode: "content_patch",
  };
}
