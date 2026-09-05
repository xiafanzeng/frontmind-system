import { z } from "zod";

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const slotIdSchema = z
  .string()
  .trim()
  .regex(/^[a-z][a-z0-9_-]{0,63}$/u);
const sourceIdsSchema = z
  .array(z.string().trim().min(1).max(191))
  .max(50)
  .default([]);

const textSlotPatchSchema = z
  .object({
    slotId: slotIdSchema,
    kind: z.enum(["text", "richText"]),
    value: z.string().trim().min(1).max(2_000),
    sourceIds: sourceIdsSchema,
  })
  .strict();

const listSlotPatchSchema = z
  .object({
    slotId: slotIdSchema,
    kind: z.literal("list"),
    value: z.array(z.string().trim().min(1).max(500)).min(1).max(24),
    sourceIds: sourceIdsSchema,
  })
  .strict();

const imageSlotPatchSchema = z
  .object({
    slotId: slotIdSchema,
    kind: z.literal("image"),
    value: z
      .object({
        assetId: z.string().uuid(),
        alt: z.string().trim().min(1).max(300),
      })
      .strict(),
    sourceIds: sourceIdsSchema,
  })
  .strict();

const linkSlotPatchSchema = z
  .object({
    slotId: slotIdSchema,
    kind: z.literal("link"),
    value: z
      .object({
        label: z.string().trim().min(1).max(120),
        targetRouteId: z.string().trim().min(1).max(64),
      })
      .strict(),
    sourceIds: sourceIdsSchema,
  })
  .strict();

export const siteContentSlotPatchV1Schema = z.discriminatedUnion("kind", [
  textSlotPatchSchema,
  listSlotPatchSchema,
  imageSlotPatchSchema,
  linkSlotPatchSchema,
]);

/**
 * Host-owned content patch for an immutable, precompiled site baseline.
 * It deliberately has no path, dependency, script, component, style or raw
 * URL fields, so accepting this wire shape cannot mutate executable source.
 */
export const siteContentPatchV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    operationToken: z.string().trim().min(1).max(191),
    baseSourceSha256: sha256Schema,
    pages: z
      .array(
        z
          .object({
            routeId: z.string().trim().min(1).max(64),
            slots: z.array(siteContentSlotPatchV1Schema).max(16),
          })
          .strict(),
      )
      .max(30),
  })
  .strict()
  .superRefine((value, context) => {
    const routeIds = new Set<string>();
    for (const [pageIndex, page] of value.pages.entries()) {
      if (routeIds.has(page.routeId)) {
        context.addIssue({
          code: "custom",
          path: ["pages", pageIndex, "routeId"],
          message: "Patch route ids must be unique",
        });
      }
      routeIds.add(page.routeId);
      const slotIds = new Set<string>();
      for (const [slotIndex, slot] of page.slots.entries()) {
        if (slotIds.has(slot.slotId)) {
          context.addIssue({
            code: "custom",
            path: ["pages", pageIndex, "slots", slotIndex, "slotId"],
            message: "Patch slot ids must be unique per route",
          });
        }
        slotIds.add(slot.slotId);
      }
    }
  });

export type SiteContentPatchV1 = z.infer<typeof siteContentPatchV1Schema>;
