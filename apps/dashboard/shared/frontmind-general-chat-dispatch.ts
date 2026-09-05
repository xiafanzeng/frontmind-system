import { z } from "zod";

import { generalAgentModelProfileSchema } from "./manus-agent-profile";

/**
 * Browser-owned evidence for an ordinary-chat request whose task response has
 * not yet been acknowledged. It lives in the existing message JSON metadata;
 * no database column or migration is required.
 */
export const generalChatDispatchSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal("pending_user"),
    clientRequestId: z.string().min(1).max(128),
    providerPrompt: z.string().min(1).max(2_000_000),
    localAssetIds: z.array(z.string().min(1).max(36)).max(32),
    localTaskId: z.string().uuid().nullable(),
    modelProfile: generalAgentModelProfileSchema.nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    const sortedUnique = [...new Set(value.localAssetIds)].sort();
    if (
      sortedUnique.length !== value.localAssetIds.length ||
      sortedUnique.some(
        (assetId, index) => assetId !== value.localAssetIds[index],
      )
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["localAssetIds"],
        message: "localAssetIds must be sorted and unique",
      });
    }
    if (value.localTaskId === null && value.modelProfile === null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["modelProfile"],
        message: "a new task must freeze its model profile",
      });
    }
    if (value.localTaskId !== null && value.modelProfile !== null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["modelProfile"],
        message: "a continuation must use the task's frozen model profile",
      });
    }
  });

export type GeneralChatDispatchMetadata = z.infer<
  typeof generalChatDispatchSchema
>;
