import {
  generalChatDispatchSchema,
  type GeneralChatDispatchMetadata,
} from "../shared/frontmind-general-chat-dispatch";
import type { GeneralAgentModelProfile } from "../shared/manus-agent-profile";

type GeneralChatDispatchValidation =
  | { kind: "legacy" }
  | { kind: "valid"; dispatch: GeneralChatDispatchMetadata }
  | {
      kind: "invalid";
      code: "GENERAL_CHAT_DISPATCH_INVALID" | "GENERAL_CHAT_DISPATCH_CONFLICT";
    };

export function validateGeneralChatDispatchMetadata(input: {
  metadata: unknown;
  clientRequestId: string;
  providerPrompt: string;
  localAssetIds: readonly string[];
  originalLocalTaskId: string | null;
  modelProfile: GeneralAgentModelProfile | null;
}): GeneralChatDispatchValidation {
  const metadata =
    input.metadata && typeof input.metadata === "object"
      ? (input.metadata as Record<string, unknown>)
      : null;
  if (
    !metadata ||
    !Object.prototype.hasOwnProperty.call(metadata, "generalChatDispatch")
  ) {
    return { kind: "legacy" };
  }

  const parsed = generalChatDispatchSchema.safeParse(
    metadata.generalChatDispatch,
  );
  if (!parsed.success) {
    return { kind: "invalid", code: "GENERAL_CHAT_DISPATCH_INVALID" };
  }
  const dispatch = parsed.data;
  if (
    dispatch.clientRequestId !== input.clientRequestId ||
    dispatch.providerPrompt !== input.providerPrompt ||
    dispatch.localTaskId !== input.originalLocalTaskId ||
    dispatch.modelProfile !== input.modelProfile ||
    dispatch.localAssetIds.length !== input.localAssetIds.length ||
    input.localAssetIds.some(
      (assetId, index) => assetId !== dispatch.localAssetIds[index],
    )
  ) {
    return { kind: "invalid", code: "GENERAL_CHAT_DISPATCH_CONFLICT" };
  }
  return { kind: "valid", dispatch };
}
