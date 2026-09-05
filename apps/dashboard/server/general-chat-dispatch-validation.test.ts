import { describe, expect, it } from "vitest";

import { validateGeneralChatDispatchMetadata } from "./general-chat-dispatch-validation";

const assetId = "asset_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const localTaskId = "22222222-2222-4222-8222-222222222222";

function dispatch(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    kind: "pending_user",
    clientRequestId: "msg-request",
    providerPrompt: "展示正文\nZIP reference",
    localAssetIds: [assetId],
    localTaskId: null,
    modelProfile: "frontmind-base",
    ...overrides,
  };
}

describe("durable ordinary-chat dispatch validation", () => {
  it("accepts exact first-create prompt, assets, request id and model", () => {
    expect(
      validateGeneralChatDispatchMetadata({
        metadata: { generalChatDispatch: dispatch() },
        clientRequestId: "msg-request",
        providerPrompt: "展示正文\nZIP reference",
        localAssetIds: [assetId],
        originalLocalTaskId: null,
        modelProfile: "frontmind-base",
      }),
    ).toMatchObject({ kind: "valid" });
  });

  it("accepts an exact continuation coordinate without a model override", () => {
    expect(
      validateGeneralChatDispatchMetadata({
        metadata: {
          generalChatDispatch: dispatch({
            localAssetIds: [],
            localTaskId,
            modelProfile: null,
          }),
        },
        clientRequestId: "msg-request",
        providerPrompt: "展示正文\nZIP reference",
        localAssetIds: [],
        originalLocalTaskId: localTaskId,
        modelProfile: null,
      }),
    ).toMatchObject({ kind: "valid" });
  });

  it("rejects any prompt, asset or original-task coordinate fork", () => {
    const base = {
      metadata: { generalChatDispatch: dispatch() },
      clientRequestId: "msg-request",
      providerPrompt: "展示正文\nZIP reference",
      localAssetIds: [assetId],
      originalLocalTaskId: null,
      modelProfile: "frontmind-base" as const,
    };
    expect(
      validateGeneralChatDispatchMetadata({
        ...base,
        providerPrompt: "展示正文",
      }),
    ).toEqual({ kind: "invalid", code: "GENERAL_CHAT_DISPATCH_CONFLICT" });
    expect(
      validateGeneralChatDispatchMetadata({ ...base, localAssetIds: [] }),
    ).toEqual({ kind: "invalid", code: "GENERAL_CHAT_DISPATCH_CONFLICT" });
    expect(
      validateGeneralChatDispatchMetadata({
        ...base,
        originalLocalTaskId: localTaskId,
        modelProfile: null,
      }),
    ).toEqual({ kind: "invalid", code: "GENERAL_CHAT_DISPATCH_CONFLICT" });
  });

  it("uses legacy fallback only when the metadata key is absent", () => {
    const input = {
      clientRequestId: "msg-request",
      providerPrompt: "展示正文",
      localAssetIds: [] as string[],
      originalLocalTaskId: null,
      modelProfile: "frontmind-pro" as const,
    };
    expect(
      validateGeneralChatDispatchMetadata({ metadata: {}, ...input }),
    ).toEqual({ kind: "legacy" });
    expect(
      validateGeneralChatDispatchMetadata({
        metadata: { generalChatDispatch: { malformed: true } },
        ...input,
      }),
    ).toEqual({ kind: "invalid", code: "GENERAL_CHAT_DISPATCH_INVALID" });
  });
});
