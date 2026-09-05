import { describe, expect, it } from "vitest";

import {
  knowledgeBaseActiveTurnAgeBucket,
  knowledgeBaseInteractionTelemetryEvents,
} from "./knowledge-base-interaction-telemetry";

const NOW = new Date("2026-08-09T12:00:00.000Z").getTime();

describe("knowledge-base interaction telemetry", () => {
  it.each([
    [9, null],
    [10, 10],
    [29, 10],
    [30, 30],
    [119, 30],
    [120, 120],
    [500, 120],
  ] as const)(
    "maps a %i minute active turn to the %s bucket",
    (age, bucket) => {
      expect(
        knowledgeBaseActiveTurnAgeBucket({
          awaitingResponseSince: NOW - age * 60_000,
          now: NOW,
        }),
      ).toBe(bucket);
    },
  );

  it("emits only allowlisted status, local build identity and an age bucket", () => {
    expect(
      knowledgeBaseInteractionTelemetryEvents({
        buildId: "build-local-1",
        awaitingResponseSince: NOW - 31 * 60_000,
        upstreamStatus: "COLLECTING",
        now: NOW,
      }),
    ).toEqual([
      {
        kind: "active_turn_age_bucket",
        dedupeKey: "age_30",
        metadata: {
          buildId: "build-local-1",
          upstreamStatus: "collecting",
          waitBucketMinutes: 30,
        },
      },
    ]);
  });

  it("redacts arbitrary provider status and never copies it into age telemetry", () => {
    const secret = "collecting https://customer.example/secret customer body";
    const serialized = JSON.stringify(
      knowledgeBaseInteractionTelemetryEvents({
        buildId: "build-local-2",
        awaitingResponseSince: NOW - 121 * 60_000,
        upstreamStatus: secret,
        now: NOW,
      }),
    );

    expect(serialized).not.toContain(secret);
    expect(JSON.parse(serialized)).toEqual([
      {
        kind: "unknown_upstream_status",
        dedupeKey: "unknown",
        metadata: {
          buildId: "build-local-2",
          upstreamPhase: "unknown",
        },
      },
      {
        kind: "active_turn_age_bucket",
        dedupeKey: "age_120",
        metadata: {
          buildId: "build-local-2",
          upstreamStatus: "unknown",
          waitBucketMinutes: 120,
        },
      },
    ]);
  });

  it("does not report an age bucket without a valid active-turn timestamp", () => {
    expect(
      knowledgeBaseInteractionTelemetryEvents({
        buildId: "build-local-3",
        awaitingResponseSince: null,
        upstreamStatus: "running",
        now: NOW,
      }),
    ).toEqual([]);
    expect(
      knowledgeBaseActiveTurnAgeBucket({
        awaitingResponseSince: NOW + 1,
        now: NOW,
      }),
    ).toBeNull();
  });
});
