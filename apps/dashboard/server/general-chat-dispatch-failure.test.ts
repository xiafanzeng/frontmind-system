import { describe, expect, it } from "vitest";
import { AiBillingError, AiBillingPausedError } from "./ai-billing-service";
import { aiBillingHttpFailure } from "./ai-billing-http";
import { ManusV2ApiError } from "./manus-v2-client";
import {
  generalChatDispatchIsDefinitelyRejected,
  generalChatHasPersistedPreSendBalanceRefusal,
  generalChatHttpErrorMessage,
} from "./general-chat-dispatch-failure";

describe("general chat dispatch rejection evidence", () => {
  it("recovers only the persisted before-send balance refusal, never an uploaded-file or send uncertainty", () => {
    const unsent = {
      billingPause: {
        reason: "balance",
        stage: "before_send",
        commandKey: "initial",
        sessionId: "session",
      },
      dashboardManaged: {
        revision: 1,
        intentId: "operation",
        sessionId: "session",
        commands: [{ key: "initial", intentId: "operation" }],
        mutations: {},
      },
    };
    expect(generalChatHasPersistedPreSendBalanceRefusal(unsent)).toBe(true);
    for (const state of [
      "sending",
      "outcome_unknown",
      "acknowledged",
      "rejected",
    ]) {
      expect(
        generalChatHasPersistedPreSendBalanceRefusal({
          ...unsent,
          dashboardManaged: {
            ...unsent.dashboardManaged,
            mutations: { "message:initial": { state } },
          },
        }),
      ).toBe(false);
    }
    for (const invalid of [
      {
        ...unsent,
        billingPause: { ...unsent.billingPause, stage: "after_send" },
      },
      {
        ...unsent,
        billingPause: { ...unsent.billingPause, sessionId: "another-session" },
      },
      {
        ...unsent,
        dashboardManaged: { ...unsent.dashboardManaged, commands: [] },
      },
      {
        ...unsent,
        dashboardManaged: {
          ...unsent.dashboardManaged,
          commands: [
            { ...unsent.dashboardManaged.commands[0], eventId: "accepted" },
          ],
        },
      },
      {
        dashboardManaged: {
          revision: 1,
          commands: [],
          mutations: { "file:hash": { state: "outcome_unknown" } },
        },
      },
    ])
      expect(generalChatHasPersistedPreSendBalanceRefusal(invalid)).toBe(false);
  });
  it.each([
    ["AI_BALANCE_INSUFFICIENT", 402],
    ["AI_COST_PENDING", 503],
    ["AI_BILLING_PROJECT_OWNERSHIP", 403],
    ["AI_BILLING_NOT_ACTIVE", 503],
  ] as const)(
    "keeps pre-send %s out of unknown-send reconciliation",
    (code, status) => {
      const error = new AiBillingError(code);
      expect(generalChatDispatchIsDefinitelyRejected(error)).toBe(true);
      expect(aiBillingHttpFailure(error)?.status).toBe(status);
    },
  );
  it("never equates interrupted execution or a lost acknowledgement with an unsent command", () => {
    const errors = [
      new AiBillingPausedError({
        reason: "balance",
        stage: "after_send",
        commandKey: "initial",
        sessionId: "session",
        pausedAt: new Date().toISOString(),
      }),
      new ManusV2ApiError("task.create", null, "TRANSPORT_ERROR", false, true),
      new ManusV2ApiError(
        "task.sendMessage",
        503,
        "UPSTREAM_ERROR",
        false,
        true,
      ),
      new Error("database commit response lost"),
    ];
    for (const error of errors)
      expect(generalChatDispatchIsDefinitelyRejected(error)).toBe(false);
  });
  it("preserves definite rate limiting even during provider resource preparation", () => {
    for (const operation of [
      "task.create",
      "task.sendMessage",
      "file.upload",
    ]) {
      const error = new ManusV2ApiError(
        operation,
        429,
        "ZHIPU_HTTP_429",
        true,
        false,
      );
      expect(generalChatDispatchIsDefinitelyRejected(error)).toBe(true);
      expect(generalChatHttpErrorMessage(error.code, error.status!)).toContain(
        "请求频率受限",
      );
    }
    expect(
      generalChatHttpErrorMessage("CREATE_OUTCOME_UNRESOLVED", 409),
    ).toContain("请勿重复发送");
    expect(
      generalChatHttpErrorMessage("SEND_OUTCOME_UNRESOLVED", 409),
    ).not.toContain("刷新");
  });
});
