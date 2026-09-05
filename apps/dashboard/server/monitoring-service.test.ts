import { describe, expect, it } from "vitest";

import { replaceMonitoringBatchSchema } from "../shared/monitoring";
import type { AuthenticatedUser } from "./auth-service";
import {
  assertMonitoringCitationSampleScope,
  assertQuestionOnlyCitationTargetCompatibility,
  buildMonitoringBatchRows,
  deriveMonitoringReadQuotaPeriodIds,
  latestMonitoringBatchesByBeijingDate,
  matchingMonitoringModelLabels,
  monitoringBeijingDate,
  monitoringModelKey,
  parseMonitoringDateBoundary,
  replaceMonitoringBatch,
  summarizeMonitoringCitations,
} from "./monitoring-service";

function actor(role: "user" | "admin"): AuthenticatedUser {
  const now = new Date("2026-07-24T08:00:00.000Z");
  return {
    id: 7,
    openId: null,
    username: role === "admin" ? "manager" : "tenant",
    displayName: "Tenant",
    name: null,
    email: null,
    loginMethod: "password",
    role,
    isActive: true,
    createdAt: now,
    updatedAt: now,
    lastSignedIn: now,
  };
}

function importValue() {
  return replaceMonitoringBatchSchema.parse({
    userId: 42,
    batchKey: "weekly-2026-30",
    sourceName: "引用分析数据.xlsx",
    collectedAt: "2026-07-24T08:00:00.000Z",
    samples: [
      {
        sourceRecordId: "answer-1",
        questionId: "question-1",
        platform: "DeepSeek",
        content: "模型回答全文",
      },
    ],
    citations: [
      {
        sourceRecordId: "citation-1",
        questionId: "question-1",
        sampleSourceRecordId: "answer-1",
        model: "deepseek",
        title: "参考资料",
        url: "https://Research.Example.com/article",
        media: "行业媒体",
      },
    ],
  });
}

describe("monitoring import normalization", () => {
  it("binds every row to the authoritative tenant, batch and question catalog", () => {
    let sequence = 0;
    const rows = buildMonitoringBatchRows({
      userId: 42,
      batchId: "batch-internal",
      value: importValue(),
      questions: [
        {
          id: "question-1",
          question: "管理员配置的企业问题",
        },
      ],
      idFactory: () => `generated-${++sequence}`,
    });

    expect(rows.samples[0]).toMatchObject({
      id: "generated-1",
      userId: 42,
      batchId: "batch-internal",
      question: "管理员配置的企业问题",
      citationCount: 1,
    });
    expect(rows.citations[0]).toMatchObject({
      id: "generated-2",
      userId: 42,
      batchId: "batch-internal",
      sampleId: "generated-1",
      question: "管理员配置的企业问题",
      domain: "research.example.com",
    });
  });

  it("rejects a citation that points across question identities", () => {
    const value = importValue();
    value.citations[0].questionId = "question-2";

    expect(() =>
      buildMonitoringBatchRows({
        userId: 42,
        batchId: "batch-internal",
        value,
        questions: [
          { id: "question-1", question: "问题一" },
          { id: "question-2", question: "问题二" },
        ],
      }),
    ).toThrow("与关联样本的问题不一致");
  });

  it("enforces administrator permission in the service before database access", async () => {
    await expect(
      replaceMonitoringBatch({
        actor: actor("user"),
        value: importValue(),
      }),
    ).rejects.toMatchObject({
      code: "INVALID_CREDENTIAL",
      message: "Administrator permission is required",
    });
  });
});

describe("monitoring model and Beijing date normalization", () => {
  it("provides stable model keys while keeping unknown model labels usable", () => {
    expect(monitoringModelKey("Deep Seek")).toBe("deepseek");
    expect(monitoringModelKey("豆包")).toBe("doubao");
    expect(monitoringModelKey("百度文心")).toBe("baiduai");
    expect(monitoringModelKey("baiduai")).toBe("baiduai");
    expect(monitoringModelKey("通义千问")).toBe("qianwen");
    expect(monitoringModelKey("qianwen")).toBe("qianwen");
    expect(monitoringModelKey("企业 专用模型")).toBe("企业-专用模型");
  });

  it("resolves canonical platform filters to every matching imported label", () => {
    const labels = [
      "DeepSeek",
      "Deep Seek",
      "豆包移动端",
      "企业 专用模型",
      "企业-专用模型",
    ];

    expect(matchingMonitoringModelLabels(labels, "deepseek")).toEqual([
      "DeepSeek",
      "Deep Seek",
    ]);
    expect(matchingMonitoringModelLabels(labels, "doubao")).toEqual([
      "豆包移动端",
    ]);
    expect(matchingMonitoringModelLabels(labels, "企业 专用模型")).toEqual([
      "企业 专用模型",
      "企业-专用模型",
    ]);
  });

  it("only merges a question-level citation workbook into the matching answer scope", () => {
    const samples = [
      {
        questionId: "question-1",
        platform: "百度文心",
        collectedAt: "2026-07-23T16:00:00.000Z",
      },
    ];
    expect(() =>
      assertQuestionOnlyCitationTargetCompatibility({
        samples,
        citations: [
          {
            questionId: "question-1",
            model: "baiduai",
            collectedAt: "2026-07-24",
          },
        ],
      }),
    ).not.toThrow();
    expect(() =>
      assertQuestionOnlyCitationTargetCompatibility({
        samples,
        citations: [
          {
            questionId: "question-1",
            model: "deepseek",
            collectedAt: "2026-07-24",
          },
        ],
      }),
    ).toThrow("引用文件与目标答案批次不匹配");
  });

  it("treats date-only filters as full Beijing calendar days", () => {
    expect(
      parseMonitoringDateBoundary("2026-07-24", "from").toISOString(),
    ).toBe("2026-07-23T16:00:00.000Z");
    expect(parseMonitoringDateBoundary("2026-07-24", "to").toISOString()).toBe(
      "2026-07-24T15:59:59.999Z",
    );
    expect(monitoringBeijingDate("2026-07-23T16:00:00.000Z")).toBe(
      "2026-07-24",
    );
  });

  it("selects only the latest published revision for each Beijing date", () => {
    const selected = latestMonitoringBatchesByBeijingDate([
      {
        batchKey: "older-publication",
        collectedAt: "2026-07-27T10:00:00.000Z",
        updatedAt: "2026-07-27T10:05:00.000Z",
        revision: 3,
      },
      {
        batchKey: "latest-publication",
        collectedAt: "2026-07-27T08:00:00.000Z",
        updatedAt: "2026-07-27T11:00:00.000Z",
        revision: 1,
      },
      {
        batchKey: "previous-date",
        collectedAt: "2026-07-26T08:00:00.000Z",
        updatedAt: "2026-07-26T09:00:00.000Z",
        revision: 1,
      },
    ]);

    expect(
      selected.map(([dateKey, batch]) => [dateKey, batch.batchKey]),
    ).toEqual([
      ["2026-07-27", "latest-publication"],
      ["2026-07-26", "previous-date"],
    ]);
  });
});

describe("monitoring citation reads", () => {
  const sample = {
    id: "sample-internal-1",
    sourceRecordId: "sample-external-1",
    userId: 42,
    batchId: "batch-1",
    questionId: "question-1",
    batchKey: "weekly-2026-30",
    quotaPeriodId: "period-1",
  };

  it("accepts either sample identity only inside the tenant's exact read scope", () => {
    for (const requestedSampleId of [sample.id, sample.sourceRecordId]) {
      expect(
        assertMonitoringCitationSampleScope({
          sample,
          requestedSampleId,
          userId: 42,
          batchKey: "weekly-2026-30",
          questionIds: ["question-1", "question-lineage-1"],
          quotaPeriodIds: ["period-1"],
        }),
      ).toBe(sample);
    }
  });

  it("rejects samples outside the tenant, batch, question or active quota period", () => {
    const validScope = {
      sample,
      requestedSampleId: sample.id,
      userId: 42,
      batchKey: "weekly-2026-30",
      questionIds: ["question-1"],
      quotaPeriodIds: ["period-1"],
    };
    for (const override of [
      { userId: 99 },
      { requestedSampleId: "another-sample" },
      { batchKey: "another-batch" },
      { questionIds: ["question-2"] },
      { quotaPeriodIds: ["period-expired"] },
      { sample: undefined },
    ]) {
      expect(() =>
        assertMonitoringCitationSampleScope({
          ...validScope,
          ...override,
        }),
      ).toThrow("不属于当前批次、问题及有效服务周期");
    }
  });

  it("normalizes channel domains and content URLs before aggregation", () => {
    const summary = summarizeMonitoringCitations([
      {
        title: "选购指南",
        url: "https://www.Example.com/article/?utm_source=monitor#answer",
        media: "行业媒体",
        domain: "HTTPS://WWW.EXAMPLE.COM/path",
      },
      {
        title: " 选购指南 ",
        url: "https://example.com/article?utm_medium=email",
        media: "行业媒体",
        domain: "example.com",
      },
      {
        title: "另一篇内容",
        url: "https://other.example/story",
        media: "",
        domain: "",
      },
      {
        title: "无链接内容",
        url: "",
        media: "社区",
        domain: "",
      },
      {
        title: " 无链接内容 ",
        url: "",
        media: "社区",
        domain: "",
      },
    ]);

    expect(summary.totalCitations).toBe(5);
    expect(summary.channels).toEqual(
      expect.arrayContaining([
        {
          name: "行业媒体",
          domain: "example.com",
          citationCount: 2,
          share: 0.4,
        },
        {
          name: "社区",
          domain: "",
          citationCount: 2,
          share: 0.4,
        },
        {
          name: "other.example",
          domain: "other.example",
          citationCount: 1,
          share: 0.2,
        },
      ]),
    );
    expect(summary.contents).toEqual(
      expect.arrayContaining([
        {
          title: "选购指南",
          url: "https://example.com/article",
          channelName: "行业媒体",
          domain: "example.com",
          citationCount: 2,
          share: 0.4,
        },
        {
          title: "无链接内容",
          url: "",
          channelName: "社区",
          domain: "",
          citationCount: 2,
          share: 0.4,
        },
      ]),
    );
    expect(summary.channels.map((row) => row.citationCount)).toEqual([2, 2, 1]);
    expect(summary.contents.map((row) => row.citationCount)).toEqual([2, 2, 1]);
  });
});

describe("monitoring read entitlement scope", () => {
  it("keeps compatibility users tenant-scoped without requiring classified periods", () => {
    expect(
      deriveMonitoringReadQuotaPeriodIds({
        serviceStatus: "unconfigured",
        capabilityAllowed: false,
        compatibilityMode: true,
        currentQuotaPeriodIds: [],
      }),
    ).toBeUndefined();
  });

  it("limits an active service to its current quota periods", () => {
    expect(
      deriveMonitoringReadQuotaPeriodIds({
        serviceStatus: "active",
        capabilityAllowed: true,
        compatibilityMode: false,
        currentQuotaPeriodIds: ["current-1", "current-1", "current-2"],
        historicalQuotaPeriodIds: ["expired-1"],
      }),
    ).toEqual(["current-1", "current-2"]);
  });

  it.each(["expired", "cancelled"] as const)(
    "keeps classified historical monitoring readable for a %s service",
    (serviceStatus) => {
      expect(
        deriveMonitoringReadQuotaPeriodIds({
          serviceStatus,
          capabilityAllowed: true,
          compatibilityMode: false,
          currentQuotaPeriodIds: [],
          historicalQuotaPeriodIds: ["period-1", "period-2", "period-1"],
        }),
      ).toEqual(["period-1", "period-2"]);
    },
  );

  it("retains tenant-owned legacy history while blocking unavailable plans", () => {
    expect(
      deriveMonitoringReadQuotaPeriodIds({
        serviceStatus: "expired",
        capabilityAllowed: true,
        compatibilityMode: false,
        currentQuotaPeriodIds: [],
        historicalQuotaPeriodIds: [null, "period-1"],
      }),
    ).toBeUndefined();
    expect(
      deriveMonitoringReadQuotaPeriodIds({
        serviceStatus: "suspended",
        capabilityAllowed: false,
        compatibilityMode: false,
        currentQuotaPeriodIds: ["period-1"],
      }),
    ).toEqual([]);
  });
});
