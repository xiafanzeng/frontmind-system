import { describe, expect, it } from "vitest";

import {
  listMonitoringCitationsSchema,
  listMonitoringSampleCitationsSchema,
  listMonitoringSamplesSchema,
  monitoringCitationSummarySchema,
  monitoringFilterOptionsSchema,
  replaceMonitoringBatchSchema,
} from "../shared/monitoring";

function validBatch() {
  return {
    userId: 9,
    batchKey: "weekly-2026-30",
    sourceName: "引用分析数据.xlsx",
    collectedAt: "2026-07-24T08:00:00.000Z",
    samples: [
      {
        sourceRecordId: "answer-1",
        questionId: "question-1",
        platform: "DeepSeek",
      },
    ],
    citations: [],
  };
}

describe("monitoring API contracts", () => {
  it("does not let child records choose a tenant or batch", () => {
    const value = validBatch();
    const result = replaceMonitoringBatchSchema.safeParse({
      ...value,
      samples: [
        {
          ...value.samples[0],
          userId: 999,
          batchId: "forged-batch",
        },
      ],
    });

    expect(result.success).toBe(false);
  });

  it("rejects empty replacement batches and invalid collection dates", () => {
    expect(
      replaceMonitoringBatchSchema.safeParse({
        ...validBatch(),
        collectedAt: "not-a-date",
        samples: [],
      }).success,
    ).toBe(false);
  });

  it("applies bounded server-side pagination defaults", () => {
    expect(listMonitoringCitationsSchema.parse({})).toMatchObject({
      page: 1,
      pageSize: 25,
      sortBy: "collectedAt",
      sortOrder: "desc",
    });
    expect(
      listMonitoringCitationsSchema.safeParse({ pageSize: 101 }).success,
    ).toBe(false);
  });

  it("accepts sortable citation columns exposed by the SaaS table", () => {
    for (const sortBy of [
      "question",
      "model",
      "title",
      "media",
      "publishedAt",
    ]) {
      expect(listMonitoringCitationsSchema.parse({ sortBy }).sortBy).toBe(
        sortBy,
      );
    }
  });

  it("accepts an exact answer identifier for citation lookup", () => {
    expect(
      listMonitoringCitationsSchema.parse({
        sampleId: "answer-source-record-1",
        batchKey: "weekly-2026-30",
        questionId: "question-1",
      }),
    ).toMatchObject({
      sampleId: "answer-source-record-1",
      batchKey: "weekly-2026-30",
      questionId: "question-1",
    });
    expect(
      listMonitoringCitationsSchema.safeParse({ sampleId: "" }).success,
    ).toBe(false);
  });

  it("accepts canonical model filtering while retaining the legacy platform field", () => {
    expect(
      listMonitoringSamplesSchema.parse({
        model: "deepseek",
        from: "2026-07-01",
        to: "2026-07-31",
      }),
    ).toMatchObject({ model: "deepseek" });
    expect(
      listMonitoringSamplesSchema.parse({ platform: "DeepSeek" }),
    ).toMatchObject({ platform: "DeepSeek" });
  });

  it("requires both a batch and question for citation summaries", () => {
    expect(
      monitoringCitationSummarySchema.parse({
        batchKey: "weekly-2026-30",
        questionId: "question-1",
      }),
    ).toEqual({
      batchKey: "weekly-2026-30",
      questionId: "question-1",
    });
    expect(monitoringCitationSummarySchema.safeParse({}).success).toBe(false);
    expect(
      monitoringCitationSummarySchema.safeParse({
        batchKey: "weekly-2026-30",
      }).success,
    ).toBe(false);
    expect(
      monitoringCitationSummarySchema.safeParse({
        batchKey: "weekly-2026-30",
        questionId: "",
      }).success,
    ).toBe(false);
    expect(
      monitoringCitationSummarySchema.safeParse({
        batchKey: "weekly-2026-30",
        userId: 999,
      }).success,
    ).toBe(false);
  });

  it("scopes filter options and strict sample citations without accepting extra fields", () => {
    expect(
      monitoringFilterOptionsSchema.parse({
        batchKey: "weekly-2026-30",
        questionId: "question-1",
      }),
    ).toEqual({
      batchKey: "weekly-2026-30",
      questionId: "question-1",
    });
    expect(
      listMonitoringSampleCitationsSchema.parse({
        batchKey: "weekly-2026-30",
        questionId: "question-1",
        sampleId: "8cf64586-4aa7-4fb8-a93b-6f9ec91bc6b5",
      }),
    ).toMatchObject({
      limit: 50,
      sampleId: "8cf64586-4aa7-4fb8-a93b-6f9ec91bc6b5",
    });
    expect(
      listMonitoringSampleCitationsSchema.safeParse({
        batchKey: "weekly-2026-30",
        questionId: "question-1",
        sampleId: "answer-source-id",
      }).success,
    ).toBe(false);
  });
});
