import { describe, expect, it } from "vitest";
import { generalChatDispatchSchema } from "./frontmind-general-chat-dispatch";

const newTask = {
  schemaVersion: 1,
  kind: "pending_user",
  clientRequestId: "request-1",
  providerPrompt: "建立企业资料包",
  localAssetIds: [],
  localTaskId: null,
  modelProfile: "frontmind-pro",
};
const contentProduction = {
  mode: "new_reference_pack",
  enterpriseName: "示例企业",
  knowledgeSource: "published",
};
describe("purpose-bound durable dispatch", () => {
  it("requires the production purpose and frozen workflow input together", () => {
    expect(
      generalChatDispatchSchema.safeParse({
        ...newTask,
        purpose: "content_production",
        contentProduction,
      }).success,
    ).toBe(true);
    expect(
      generalChatDispatchSchema.safeParse({
        ...newTask,
        purpose: "content_production",
      }).success,
    ).toBe(false);
    expect(
      generalChatDispatchSchema.safeParse({
        ...newTask,
        purpose: "enterprise_qa",
        contentProduction,
      }).success,
    ).toBe(false);
    expect(
      generalChatDispatchSchema.safeParse({
        ...newTask,
        purpose: "enterprise_qa",
      }).success,
    ).toBe(true);
  });
  it("uses frozen purpose on continuation and retains only its explicit workflow action", () => {
    const continuation = {
      ...newTask,
      localTaskId: "11111111-1111-4111-8111-111111111111",
      modelProfile: null,
    };
    expect(
      generalChatDispatchSchema.safeParse({
        ...continuation,
        contentProductionAction: {
          kind: "confirm_core_positioning",
          revision: 4,
        },
      }).success,
    ).toBe(true);
    expect(
      generalChatDispatchSchema.safeParse({
        ...continuation,
        purpose: "enterprise_qa",
      }).success,
    ).toBe(false);
    expect(
      generalChatDispatchSchema.safeParse({
        ...newTask,
        contentProductionAction: {
          kind: "confirm_core_positioning",
          revision: 4,
        },
      }).success,
    ).toBe(false);
  });
});
