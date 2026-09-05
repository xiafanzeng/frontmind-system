import { describe, expect, it } from "vitest";

import { managedKnowledgeTurnBusinessFields } from "./admin-delivery-service";

describe("managed knowledge activity business projection", () => {
  it("reports a pre-create failure without counting generated files as customer uploads", () => {
    expect(
      managedKnowledgeTurnBusinessFields({
        upstreamTaskId: null,
        completedAt: new Date("2026-08-17T15:04:37.000Z"),
        metadata: {
          createAttemptState: "not_sent",
          providerAttemptState: "not_sent",
          failureStage: "provider_file_registration",
          userAttachmentCount: 9,
          expectedAttachmentCount: 11,
        },
      }),
    ).toEqual({
      taskCreationState: "not_attempted",
      failureStage: "provider_file_registration",
      retainedCustomerAttachmentCount: 9,
      generatedSystemAttachmentCount: 2,
      settledAt: Date.parse("2026-08-17T15:04:37.000Z"),
    });
  });

  it("never labels an acknowledged task as not attempted", () => {
    expect(
      managedKnowledgeTurnBusinessFields({
        upstreamTaskId: "provider-task-1",
        completedAt: null,
        metadata: {
          createAttemptState: "acknowledged",
          userAttachmentCount: 3,
          expectedAttachmentCount: 5,
        },
      }),
    ).toMatchObject({
      taskCreationState: "acknowledged",
      retainedCustomerAttachmentCount: 3,
      generatedSystemAttachmentCount: 2,
      settledAt: null,
    });
  });
});
