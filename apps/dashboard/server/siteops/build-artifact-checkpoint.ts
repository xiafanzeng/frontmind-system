import { z } from "zod";

const SHA256 = /^[a-f0-9]{64}$/u;

/** Initial source delivery is attempt 0; three bounded same-task repairs are
 * available for independent compile, archive-integrity and browser-contract
 * failures. Keep every durable attempt coordinate aligned with this ceiling. */
export const NATIVE_SOURCE_MAX_REPAIR_ATTEMPTS = 3;

const buildArtifactBindingSchema = (
  mimeType: "application/json" | "application/zip",
) =>
  z
    .object({
      id: z.string().uuid(),
      sha256: z.string().regex(SHA256),
      bytes: z
        .number()
        .int()
        .positive()
        .max(100 * 1024 * 1024),
      mimeType: z.literal(mimeType),
    })
    .strict();

export const buildArtifactBindingsSchema = z
  .object({
    contract: buildArtifactBindingSchema("application/json"),
    source: buildArtifactBindingSchema("application/zip"),
    dist: buildArtifactBindingSchema("application/zip"),
    qa: buildArtifactBindingSchema("application/zip"),
    provenance: buildArtifactBindingSchema("application/json"),
  })
  .strict()
  .superRefine((bindings, context) => {
    const ids = Object.values(bindings).map((binding) => binding.id);
    if (new Set(ids).size !== ids.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "artifact ids must be unique",
      });
    }
  });

export const buildDeliveryCheckpointSchema = z
  .object({
    renderMode: z.enum([
      "primary",
      "content_patch",
      "trusted_fallback",
      "twenty_first_native",
    ]),
    qaStatus: z.enum(["passed", "passed_with_warnings", "partial"]),
    warningCodes: z.array(z.string().trim().min(1).max(128)).max(100),
  })
  .strict();

const formalBuildDeliveryCheckpointSchema = z
  .object({
    renderMode: z.literal("twenty_first_native"),
    qaStatus: z.enum(["passed", "passed_with_warnings"]),
    warningCodes: z.array(z.string().trim().min(1).max(128)).max(100),
  })
  .strict();

export const formalBuildArtifactStagingSchema = z
  .object({
    schemaVersion: z.literal(1),
    generation: z.literal("formal"),
    projectId: z.string().uuid(),
    buildId: z.string().uuid(),
    knowledgeSnapshotId: z.string().uuid(),
    taskId: z.string().min(1).max(255),
    operationToken: z
      .string()
      .regex(/^siteops-native-source:[a-f0-9-]{36}:[0-3]$/u),
    nativeRepairAttempt: z
      .number()
      .int()
      .min(0)
      .max(NATIVE_SOURCE_MAX_REPAIR_ATTEMPTS),
    artifactBindings: buildArtifactBindingsSchema,
    specHash: z.string().regex(SHA256),
    distHash: z.string().regex(SHA256),
    buildDelivery: formalBuildDeliveryCheckpointSchema,
    qaSummary: z
      .record(z.string(), z.unknown())
      .refine((value) => Object.keys(value).length <= 256),
    expiresAt: z.string().datetime(),
  })
  .strict();

export type BuildArtifactBindings = z.infer<typeof buildArtifactBindingsSchema>;
export type FormalBuildArtifactStaging = z.infer<
  typeof formalBuildArtifactStagingSchema
>;
