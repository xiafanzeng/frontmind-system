import { describe, expect, it } from "vitest";

import {
  isAcceptedSelectVisualAck,
  matchesSelectVisualCommittedObservation,
  newestSiteOpsObservation,
  SITEOPS_SELECT_VISUAL_OBSERVE_SCHEDULE_MS,
  shouldPollSiteOpsObservation,
  siteOpsClientRequestId,
  siteOpsPollIntervalMs,
  siteOpsRevisionAttempt,
} from "./ConnectedSiteOpsConversationPanel";

describe("connected SiteOps request identity", () => {
  it("uses the delivery-compatible UUID form without a namespace prefix", () => {
    const requestId = siteOpsClientRequestId();

    expect(requestId).toHaveLength(36);
    expect(requestId).toMatch(
      /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u,
    );
    expect(requestId).not.toContain("siteops-");
  });

  it("reuses the request id and uploaded asset coordinates for an exact retry", async () => {
    const file = new File([new Uint8Array([1, 2, 3])], "product.png", {
      type: "image/png",
      lastModified: 7,
    });
    const first = await siteOpsRevisionAttempt(null, {
      text: "加入产品页",
      files: [file],
      expectedProjectRevision: 9,
    });
    first.localAssetIds.set(0, "asset_uploaded_once");
    const retry = await siteOpsRevisionAttempt(first, {
      text: "加入产品页",
      files: [file],
      expectedProjectRevision: 10,
    });
    expect(retry).toBe(first);
    expect(retry.clientRequestId).toBe(first.clientRequestId);
    expect(retry.expectedProjectRevision).toBe(9);
    expect(retry.contentSha256s).toEqual(first.contentSha256s);
    expect(retry.localAssetIds.get(0)).toBe("asset_uploaded_once");
    expect(retry.inFlightUploads).toBe(first.inFlightUploads);

    const changed = await siteOpsRevisionAttempt(first, {
      text: "加入关于页",
      files: [file],
      expectedProjectRevision: 10,
    });
    expect(changed.clientRequestId).not.toBe(first.clientRequestId);
    expect(changed.localAssetIds.size).toBe(0);

    const sameMetadataDifferentBytes = new File(
      [new Uint8Array([3, 2, 1])],
      "product.png",
      { type: "image/png", lastModified: 7 },
    );
    const replaced = await siteOpsRevisionAttempt(first, {
      text: "加入产品页",
      files: [sameMetadataDifferentBytes],
      expectedProjectRevision: 10,
    });
    expect(replaced.clientRequestId).not.toBe(first.clientRequestId);
    expect(replaced.localAssetIds.size).toBe(0);
  });

  it("accepts select_visual only with an operation, building state and an advanced revision", () => {
    const ack = {
      schemaVersion: 1,
      accepted: true,
      clientRequestId: "11111111-1111-4111-8111-111111111111",
      operationId: "22222222-2222-4222-8222-222222222222",
      projectRevision: 4,
      latestSequence: 3,
      interactionState: "building",
    } as const;
    const input = {
      clientRequestId: ack.clientRequestId,
      expectedRevision: 3,
    };

    expect(isAcceptedSelectVisualAck(ack, input)).toBe(true);
    expect(
      isAcceptedSelectVisualAck({ ...ack, operationId: null }, input),
    ).toBe(false);
    expect(
      isAcceptedSelectVisualAck(
        { ...ack, interactionState: "awaiting_visual_selection" },
        input,
      ),
    ).toBe(false);
    expect(
      isAcceptedSelectVisualAck({ ...ack, projectRevision: 3 }, input),
    ).toBe(false);
    expect(SITEOPS_SELECT_VISUAL_OBSERVE_SCHEDULE_MS).toEqual([
      1_000, 2_000, 5_000,
    ]);
  });

  it("matches the ACK operation's building projection and rejects old or late projections", () => {
    const ack = {
      schemaVersion: 1,
      accepted: true,
      clientRequestId: "11111111-1111-4111-8111-111111111111",
      operationId: "22222222-2222-4222-8222-222222222222",
      projectRevision: 4,
      latestSequence: 3,
      interactionState: "building",
    } as const;
    const old = {
      project: { revision: 3 },
      latestSequence: 1,
      interactionState: "awaiting_visual_selection",
      messages: [],
    } as never;
    const building = {
      project: { revision: 4 },
      latestSequence: 3,
      interactionState: "building",
      messages: [
        {
          metadata: {
            siteOps: {
              kind: "build_progress",
              subjectId: ack.operationId,
              revision: 4,
            },
          },
        },
      ],
    } as never;
    const wrongOperation = {
      ...building,
      messages: [
        {
          metadata: {
            siteOps: {
              kind: "build_progress",
              subjectId: "33333333-3333-4333-8333-333333333333",
              revision: 4,
            },
          },
        },
      ],
    } as never;

    expect(matchesSelectVisualCommittedObservation(old, ack)).toBe(false);
    expect(matchesSelectVisualCommittedObservation(wrongOperation, ack)).toBe(
      false,
    );
    expect(matchesSelectVisualCommittedObservation(building, ack)).toBe(true);
    expect(
      matchesSelectVisualCommittedObservation(
        {
          ...building,
          project: { revision: 4 },
          interactionState: "preview_ready",
        } as never,
        ack,
      ),
    ).toBe(true);
    expect(newestSiteOpsObservation(old, building)).toBe(building);
    expect(newestSiteOpsObservation(building, old)).toBe(building);
  });

  it("keeps polling while an approved reset is unpublishing the old site", () => {
    expect(
      shouldPollSiteOpsObservation({
        interactionState: "attention_required",
        rebuildRequest: { resetPending: true },
        visualGeneration: { status: "idle" },
        deployments: [],
        domainState: null,
        socialPackages: [],
      } as never),
    ).toBe(true);
  });

  it.each(["submitted", "scheduled", "in_progress"] as const)(
    "keeps polling while rebuild request status is %s",
    (status) => {
      expect(
        shouldPollSiteOpsObservation({
          interactionState: "attention_required",
          rebuildRequest: { status, resetPending: false },
          visualGeneration: { status: "idle" },
          deployments: [],
          domainState: null,
          socialPackages: [],
        } as never),
      ).toBe(true);
    },
  );

  it("polls the initial domain sync from the current customer-facing card", () => {
    const pending = {
      interactionState: "approved",
      project: { revision: 9 },
      rebuildRequest: { status: null, resetPending: false },
      visualGeneration: { status: "idle" },
      deployments: [],
      messages: [
        {
          metadata: {
            siteOps: {
              kind: "domain_status",
              status: "active",
              revision: 9,
              payload: { action: "domain_sync" },
            },
          },
        },
      ],
      domainState: null,
      socialPackages: [],
    } as never;

    expect(shouldPollSiteOpsObservation(pending)).toBe(true);
    expect(
      shouldPollSiteOpsObservation({
        ...pending,
        project: { revision: 10 },
      } as never),
    ).toBe(false);
  });

  it("accepts only forward rebuild transitions at an equal cursor", () => {
    const observation = (status: "submitted" | "scheduled" | "in_progress") =>
      ({
        project: { revision: 8 },
        latestSequence: 12,
        rebuildRequest: {
          status,
          resetPending: status !== "submitted",
          resetApplied: false,
        },
        visualGeneration: { status: "idle" },
      }) as never;
    const submitted = observation("submitted");
    const scheduled = observation("scheduled");
    const running = observation("in_progress");

    expect(newestSiteOpsObservation(submitted, scheduled)).toBe(scheduled);
    expect(newestSiteOpsObservation(scheduled, running)).toBe(running);
    expect(newestSiteOpsObservation(running, submitted)).toBe(running);
  });

  it("backs active polling off progressively and reconciles fallback at one minute", () => {
    const active = {
      interactionState: "building",
      rebuildRequest: { status: null, resetPending: false },
      visualGeneration: { status: "idle" },
      builds: [],
      deployments: [],
      messages: [],
      domainState: null,
      socialPackages: [],
    } as never;
    expect(siteOpsPollIntervalMs(active, 0)).toBe(5_000);
    expect(siteOpsPollIntervalMs(active, 60_000)).toBe(10_000);
    expect(siteOpsPollIntervalMs(active, 5 * 60_000)).toBe(20_000);
    expect(siteOpsPollIntervalMs(active, 30 * 60_000)).toBe(30_000);

    expect(
      siteOpsPollIntervalMs(
        {
          ...active,
          builds: [
            {
              buildDelivery: { renderMode: "trusted_fallback" },
              recoverable: true,
            },
          ],
        } as never,
        0,
      ),
    ).toBe(60_000);
    expect(
      siteOpsPollIntervalMs(
        {
          ...active,
          builds: [
            {
              buildDelivery: { renderMode: "trusted_fallback" },
              recoverable: false,
            },
          ],
        } as never,
        0,
      ),
    ).toBe(false);
  });

  it("accepts equal-cursor fallback progress and rejects its late predecessor", () => {
    const base = {
      project: {
        revision: 8,
        updatedAt: "2026-08-27T04:00:00.000Z",
      },
      latestSequence: 12,
      interactionState: "building",
      rebuildRequest: {
        status: null,
        resetPending: false,
        resetApplied: false,
      },
      visualGeneration: { status: "idle" },
      deployments: [],
    };
    const validating = {
      ...base,
      builds: [
        {
          id: "build-1",
          buildPhase: "source_validating",
          buildDelivery: null,
          updatedAt: "2026-08-27T04:00:05.000Z",
        },
      ],
    } as never;
    const fallback = {
      ...base,
      builds: [
        {
          id: "build-1",
          buildPhase: "provider_sync_delayed",
          buildDelivery: { renderMode: "trusted_fallback" },
          updatedAt: "2026-08-27T04:00:06.000Z",
        },
      ],
    } as never;

    expect(newestSiteOpsObservation(validating, fallback)).toBe(fallback);
    expect(newestSiteOpsObservation(fallback, validating)).toBe(fallback);
  });
});
