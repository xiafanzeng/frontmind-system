import { z } from "zod";

const artifactBindingSchema = z
  .object({
    id: z.string().uuid(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/u),
    bytes: z.number().int().positive(),
    mimeType: z.enum(["application/json", "application/zip"]),
  })
  .strict();

export const siteOpsTrustedFallbackPreviewSchema = z
  .object({
    status: z.enum(["staged", "bound"]),
    trigger: z.enum([
      "initial_baseline",
      "repair_budget_exhausted",
      "provider_stopped_without_result",
      "provider_read_delayed",
      "provider_no_contract_progress",
    ]),
    createdAt: z.string().datetime(),
    reconcileUntilAt: z.string().datetime(),
    buildId: z.string().uuid(),
    // The deterministic first preview can be bound before a Provider task is
    // created. A later task remains fenced by buildId + operationToken and may
    // atomically upgrade this same baseline.
    taskId: z.string().trim().min(1).max(255).nullable(),
    operationToken: z
      .string()
      .regex(
        /^siteops-(?:native-fallback|content-baseline):[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu,
      ),
    selectedPreviewSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    selectedSourceTreeSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    artifactBindings: z
      .object({
        contract: artifactBindingSchema,
        source: artifactBindingSchema,
        dist: artifactBindingSchema,
        qa: artifactBindingSchema,
        provenance: artifactBindingSchema,
      })
      .strict(),
    buildDelivery: z
      .object({
        renderMode: z.literal("trusted_fallback"),
        qaStatus: z.literal("partial"),
        warningCodes: z
          .array(z.string().regex(/^(?:SITEOPS|NATIVE)_[A-Z0-9_]+$/u))
          .min(1)
          .max(20),
      })
      .strict(),
  })
  .strict()
  .superRefine((marker, context) => {
    const expectedMimeTypes = {
      contract: "application/json",
      source: "application/zip",
      dist: "application/zip",
      qa: "application/zip",
      provenance: "application/json",
    } as const;
    const ids = new Set<string>();
    for (const [kind, expectedMimeType] of Object.entries(expectedMimeTypes)) {
      const binding =
        marker.artifactBindings[kind as keyof typeof marker.artifactBindings];
      if (binding.mimeType !== expectedMimeType || ids.has(binding.id)) {
        context.addIssue({
          code: "custom",
          path: ["artifactBindings", kind],
          message: "Trusted fallback artifact coordinate is invalid",
        });
      }
      ids.add(binding.id);
    }
  });

export type SiteOpsTrustedFallbackPreview = z.infer<
  typeof siteOpsTrustedFallbackPreviewSchema
>;

export function siteOpsTrustedFallbackPreviewFromResult(result: unknown) {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return null;
  }
  const parsed = siteOpsTrustedFallbackPreviewSchema.safeParse(
    (result as Record<string, unknown>).fallbackPreview,
  );
  return parsed.success ? parsed.data : null;
}
