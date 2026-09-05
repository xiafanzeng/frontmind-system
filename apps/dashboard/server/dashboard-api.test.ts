import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import axios from "axios";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildDashboardMonitoringImport,
  buildDashboardModuleImportPreview,
  buildAuthoritativeQuestionsImportPreview,
  buildMonitoringImportPreview,
  buildMonitoringCurrentTemplatePreview,
  assertKnowledgeArchiveEnterpriseIdentity,
  assertDashboardOwnedKnowledgePackageEnterpriseIdentity,
  assertDashboardImportModuleEnabled,
  assertDashboardImportPublishHash,
  assertDashboardImportRevision,
  assertOptimizationReportQuestionScope,
  buildResponseLogicImportPreview,
  buildOptimizationReportImportPreview,
  dashboardFromCsv,
  dashboardImportEnterpriseIdentityBinding,
  dashboardPayloadWithServiceQuestionCatalog,
  dashboardQuestionCatalogFromService,
  dashboardKnowledgePublishErrorForLog,
  downloadArchiveBytes,
  KnowledgeArchiveDownloadError,
  importDashboardPayload,
  mergeDashboardModule,
  monitoringPayloadFromTabularSources,
  monitoringImportFileHash,
  parseDashboardModuleTemplateMetadata,
  parseMonitoringCurrentTemplate,
  parseAuthoritativeQuestionsTemplate,
  parseOptimizationReportTemplate,
  removeUncommittedStoredKnowledgeAssets,
  runCommittedKnowledgeSnapshotSideEffects,
  responseLogicImportsFromTabularSources,
  validateProgressReportScreenshot,
} from "./dashboard-api";
import {
  recordPresalesFileDescriptor,
  stagePresalesFileContent,
} from "./presales-file-store";
import {
  collectKnowledgeArchiveDescriptors,
  knowledgeArchiveDescriptorHash,
} from "./knowledge-base-artifact";
import {
  createDefaultDashboardPayload,
  createDashboardOptimizationReportTemplate,
  createDashboardModuleTemplateMetadata,
  dashboardOptimizationReportSchema,
} from "../shared/dashboard";
import type { AuthenticatedUser } from "./auth-service";
import {
  assertDashboardEnterpriseIdentity,
  DashboardEnterpriseMismatchError,
  DashboardRevisionConflictError,
} from "./dashboard-service";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("knowledge publish error logging", () => {
  it("does not retain legacy Axios headers, body or the complete API key", () => {
    const secret = "legacy-publish-secret-value-123456789";
    const error = Object.assign(new Error(`legacy publish failed: ${secret}`), {
      name: "AxiosError",
      code: "ERR_BAD_RESPONSE",
      config: {
        headers: {
          Authorization: `Bearer ${secret}`,
          API_KEY: secret,
        },
        data: { prompt: secret, rawArchive: "private-body" },
      },
      request: { rawHeaders: ["Authorization", secret] },
      response: {
        status: 500,
        headers: { "x-request-id": "publish-request-1" },
        data: { API_KEY: secret, body: "private-response-body" },
      },
    });

    const safe = dashboardKnowledgePublishErrorForLog(error, [secret]);
    const serialized = JSON.stringify(safe);

    expect(safe).toEqual({
      name: "AxiosError",
      message: "legacy publish failed: [REDACTED]",
      code: "ERR_BAD_RESPONSE",
      status: 500,
      requestId: "publish-request-1",
    });
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain("Authorization");
    expect(serialized).not.toContain("API_KEY");
    expect(serialized).not.toContain("private-body");
    expect(serialized).not.toContain("private-response-body");
  });
});

describe("knowledge snapshot asset cleanup boundary", () => {
  it.each(["monitoring handoff", "workspace audit"])(
    "preserves committed snapshot assets when %s fails",
    async () => {
      const removeAssets = vi.fn().mockResolvedValue(undefined);

      await removeUncommittedStoredKnowledgeAssets({
        snapshotCommitted: true,
        storedAssetKeys: ["committed-image.webp"],
        removeAssets,
      });

      expect(removeAssets).not.toHaveBeenCalled();
    },
  );

  it("still removes staged assets when snapshot creation did not commit", async () => {
    const removeAssets = vi.fn().mockResolvedValue(undefined);

    await removeUncommittedStoredKnowledgeAssets({
      snapshotCommitted: false,
      storedAssetKeys: ["staged-image.webp"],
      removeAssets,
    });

    expect(removeAssets).toHaveBeenCalledWith(["staged-image.webp"]);
  });
});

describe("committed knowledge snapshot side effects", () => {
  it("keeps handoff and audit failures non-fatal after snapshot commit", async () => {
    const warn = vi.fn();
    const handoff = vi.fn().mockRejectedValue(new Error("handoff failed"));
    const audit = vi.fn().mockRejectedValue(new Error("audit failed"));

    await expect(
      runCommittedKnowledgeSnapshotSideEffects(
        [
          { name: "monitoring handoff", run: handoff },
          { name: "publication audit", run: audit },
        ],
        warn,
      ),
    ).resolves.toEqual(["monitoring handoff", "publication audit"]);

    expect(handoff).toHaveBeenCalledOnce();
    expect(audit).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledTimes(2);
  });
});

describe("dashboard enterprise identity", () => {
  const nextPayload = createDefaultDashboardPayload("验收企业");

  it("allows the first import and updates for the same enterprise", () => {
    expect(() =>
      assertDashboardEnterpriseIdentity(
        {
          enterpriseIdentityBoundAt: null,
          payload: createDefaultDashboardPayload("尚未配置"),
        },
        nextPayload,
      ),
    ).not.toThrow();

    expect(() =>
      assertDashboardEnterpriseIdentity(
        {
          enterpriseIdentityBoundAt: Date.parse("2026-07-01T00:00:00Z"),
          payload: createDefaultDashboardPayload(" 验收企业 "),
        },
        nextPayload,
      ),
    ).not.toThrow();
  });

  it("rejects replacing an existing account with another enterprise", () => {
    expect(() =>
      assertDashboardEnterpriseIdentity(
        {
          enterpriseIdentityBoundAt: Date.parse("2026-07-01T00:00:00Z"),
          payload: createDefaultDashboardPayload("验收企业"),
        },
        createDefaultDashboardPayload("另一家企业"),
      ),
    ).toThrow(DashboardEnterpriseMismatchError);
  });
});

describe("dashboard module enterprise identity migration", () => {
  const matchingKnowledgeSnapshot = {
    documents: [
      {
        path: "硅基流动知识库/README.md",
        title: "知识库说明",
        content: "# 硅基流动企业知识库",
      },
    ],
  };

  it("accepts a matching active knowledge snapshot and requests an atomic backfill", () => {
    expect(
      dashboardImportEnterpriseIdentityBinding({
        module: "keywords",
        enterpriseIdentityBoundAt: null,
        brandName: "硅基流动",
        knowledgeAuthenticatedForCurrentService: true,
        knowledgeSnapshot: matchingKnowledgeSnapshot,
      }),
    ).toBe(true);
  });

  it("keeps rejecting an unbound workspace without matching knowledge proof", () => {
    expect(() =>
      dashboardImportEnterpriseIdentityBinding({
        module: "keywords",
        enterpriseIdentityBoundAt: null,
        brandName: "硅基流动",
        knowledgeAuthenticatedForCurrentService: false,
        knowledgeSnapshot: null,
      }),
    ).toThrow("请先由管理员确认并发布当前账号的企业名称");

    expect(() =>
      dashboardImportEnterpriseIdentityBinding({
        module: "keywords",
        enterpriseIdentityBoundAt: null,
        brandName: "另一家企业",
        knowledgeAuthenticatedForCurrentService: true,
        knowledgeSnapshot: matchingKnowledgeSnapshot,
      }),
    ).toThrow("另一家企业");
  });

  it("does not need a backfill once the workspace identity is bound", () => {
    expect(
      dashboardImportEnterpriseIdentityBinding({
        module: "keywords",
        enterpriseIdentityBoundAt: Date.parse("2026-07-01T00:00:00Z"),
        brandName: "硅基流动",
        knowledgeAuthenticatedForCurrentService: false,
        knowledgeSnapshot: null,
      }),
    ).toBe(false);
  });

  it("does not use the knowledge bootstrap for unrelated modules", () => {
    expect(() =>
      dashboardImportEnterpriseIdentityBinding({
        module: "metrics",
        enterpriseIdentityBoundAt: null,
        brandName: "硅基流动",
        knowledgeAuthenticatedForCurrentService: true,
        knowledgeSnapshot: matchingKnowledgeSnapshot,
      }),
    ).toThrow("请先由管理员确认并发布当前账号的企业名称");
  });

  it("preserves the original profile import as the explicit binding path", () => {
    expect(
      dashboardImportEnterpriseIdentityBinding({
        module: "profile",
        enterpriseIdentityBoundAt: null,
        brandName: "硅基流动",
        knowledgeAuthenticatedForCurrentService: false,
        knowledgeSnapshot: null,
      }),
    ).toBe(true);
  });
});

describe("optimization report question scope", () => {
  const questions = [
    {
      id: "workspace-question-1",
      question: "企业官网如何成为 AI 可引用的权威信源？",
    },
  ];

  it("accepts question-bound baselines and progress reports for the current user", () => {
    const report = dashboardOptimizationReportSchema.parse({
      title: "企业 GEO 进度报告",
      questionBaselines: [
        {
          id: "workspace-question-1",
          questionId: "workspace-question-1",
          question: "企业官网如何成为 AI 可引用的权威信源？",
          title: "优化前基准",
        },
      ],
      questionReports: [
        {
          id: "workspace-question-1",
          question: "企业官网如何成为 AI 可引用的权威信源？",
        },
      ],
    });

    expect(() =>
      assertOptimizationReportQuestionScope(report, questions),
    ).not.toThrow();
  });

  it("rejects unknown question ids and mismatched question snapshots", () => {
    const unknown = dashboardOptimizationReportSchema.parse({
      title: "企业 GEO 进度报告",
      questionReports: [
        {
          id: "another-company-question",
          question: "其他企业的问题",
        },
      ],
    });
    expect(() =>
      assertOptimizationReportQuestionScope(unknown, questions),
    ).toThrow("不属于当前用户");

    const mismatch = dashboardOptimizationReportSchema.parse({
      title: "企业 GEO 进度报告",
      questionReports: [
        {
          id: "workspace-question-1",
          question: "被替换的问题文本",
        },
      ],
    });
    expect(() =>
      assertOptimizationReportQuestionScope(mismatch, questions),
    ).toThrow("题面与当前用户的问题不一致");
  });

  it("rejects duplicate reports for the same question", () => {
    expect(() =>
      dashboardOptimizationReportSchema.parse({
        title: "企业 GEO 进度报告",
        questionReports: [
          {
            id: "workspace-question-1",
            question: questions[0].question,
          },
          {
            id: "workspace-question-1",
            question: questions[0].question,
          },
        ],
      }),
    ).toThrow("同一问题只能发布一份报告");
  });
});

describe("optimization report current-content template", () => {
  const current = dashboardOptimizationReportSchema.parse({
    title: "当前报告",
    questionReports: [
      {
        id: "question-1",
        question: "当前问题",
        before: { content: "当前答案" },
      },
    ],
  });

  it("binds a downloaded report template to the dashboard revision", () => {
    const template = createDashboardOptimizationReportTemplate({
      revision: 7,
      report: current,
      exportedAt: "2026-07-28T00:00:00.000Z",
    });

    expect(
      parseOptimizationReportTemplate({
        raw: template,
        currentRevision: 7,
      }).optimizationReport,
    ).toEqual(current);
    expect(() =>
      parseOptimizationReportTemplate({
        raw: template,
        currentRevision: 8,
      }),
    ).toThrow("模板已过期");
  });

  it("rejects an unversioned legacy JSON file", () => {
    expect(() =>
      parseOptimizationReportTemplate({
        raw: { optimizationReport: current },
        currentRevision: 7,
      }),
    ).toThrow("不是当前内容模板");
  });

  it("builds a question-level difference preview before publication", () => {
    const incoming = dashboardOptimizationReportSchema.parse({
      title: "更新报告",
      questionReports: [
        {
          id: "question-1",
          question: "当前问题",
          before: { content: "更新后的答案" },
        },
        {
          id: "question-2",
          question: "新增问题",
          afterEffect: {
            released: true,
            totalScore: 88,
            platforms: [
              {
                platform: "DeepSeek",
                responseCount: 5,
                citationCount: 8,
              },
            ],
            gapFillSummary: "已填补核心事实差距。",
          },
        },
      ],
    });
    const preview = buildOptimizationReportImportPreview({
      current,
      incoming,
      fileHash: "a".repeat(64),
      sourceName: "progress-report.json",
      templateRevision: 7,
    });

    expect(preview.questionReports).toEqual({
      added: 1,
      updated: 1,
      removed: 0,
      unchanged: 0,
    });
    expect(preview.releasedAfterEffects).toBe(1);
    expect(preview.questions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "question-2",
          afterEffectReleased: true,
        }),
      ]),
    );
  });
});

describe("dashboard module template metadata", () => {
  it("accepts the matching module and current revision", () => {
    const template = {
      ...createDashboardModuleTemplateMetadata({
        module: "metrics",
        revision: 12,
        exportedAt: "2026-07-28T00:00:00.000Z",
      }),
      metrics: [],
    };
    expect(
      parseDashboardModuleTemplateMetadata({
        raw: template,
        expectedModule: "metrics",
        currentRevision: 12,
      }),
    ).toEqual(
      expect.objectContaining({
        module: "metrics",
        templateRevision: 12,
      }),
    );
  });

  it("rejects a mismatched module, stale revision, or legacy JSON", () => {
    const template = createDashboardModuleTemplateMetadata({
      module: "questions",
      revision: 12,
    });
    expect(() =>
      parseDashboardModuleTemplateMetadata({
        raw: template,
        expectedModule: "metrics",
        currentRevision: 12,
      }),
    ).toThrow("模板模块不匹配");
    expect(() =>
      parseDashboardModuleTemplateMetadata({
        raw: template,
        expectedModule: "questions",
        currentRevision: 13,
      }),
    ).toThrow("模板已过期");
    expect(() =>
      parseDashboardModuleTemplateMetadata({
        raw: { questions: [] },
        expectedModule: "questions",
        currentRevision: 12,
      }),
    ).toThrow("不是当前内容模板");
  });
});

describe("authoritative formal-question current-content template", () => {
  const currentQuestions = [
    {
      id: "question-1",
      revision: 7,
      category: "industry" as const,
      question: "验收企业在专业服务行业中的真实位置是什么？",
      intent: "核验行业位置",
      rationale: "需要年度与产品口径",
    },
  ];

  it("uses the formal service catalog for question and response-logic templates", () => {
    expect(
      dashboardQuestionCatalogFromService({
        questions: currentQuestions,
        managedQuestions: [],
      }),
    ).toEqual([
      expect.objectContaining({
        id: "question-1",
        groupId: "ranking",
        groupTitle: "行业排名词",
        tone: "amber",
        question: currentQuestions[0].question,
        intent: "核验行业位置",
        summary: "需要年度与产品口径",
      }),
    ]);
  });

  it("replaces an empty or stale dashboard question copy before a question-bound import", () => {
    const payload = createDefaultDashboardPayload("企业");
    payload.questions = [
      {
        id: "stale-question",
        groupId: "brand",
        groupTitle: "旧问题",
        groupSubtitle: "",
        tone: "plum",
        question: "不再属于当前服务的问题",
        intent: "",
        summary: "",
      },
    ];

    expect(
      dashboardPayloadWithServiceQuestionCatalog({
        payload,
        questions: currentQuestions,
      }).questions,
    ).toEqual([
      expect.objectContaining({
        id: "question-1",
        question: currentQuestions[0].question,
      }),
    ]);
  });

  it("accepts only a complete revision-bound snapshot of formal questions", () => {
    const template = {
      ...createDashboardModuleTemplateMetadata({
        module: "questions",
        revision: 12,
        exportedAt: "2026-07-28T00:00:00.000Z",
      }),
      questions: [
        {
          id: "question-1",
          revision: 7,
          category: "industry",
          question: "更新后的正式题面",
          intent: "更新后的意图",
          rationale: "更新后的理由",
        },
      ],
    };
    const parsed = parseAuthoritativeQuestionsTemplate({
      raw: template,
      currentRevision: 12,
      currentQuestions,
    });
    expect(parsed.questions[0]).toMatchObject({
      id: "question-1",
      revision: 7,
      question: "更新后的正式题面",
    });
    expect(
      buildAuthoritativeQuestionsImportPreview({
        sourceName: "frontmind-questions-current-R12.json",
        fileHash: "a".repeat(64),
        templateRevision: 12,
        current: currentQuestions,
        incoming: parsed.questions,
      }).recordStats[0],
    ).toMatchObject({
      label: "正式问题目录",
      beforeCount: 1,
      afterCount: 1,
      updated: 1,
    });

    expect(() =>
      parseAuthoritativeQuestionsTemplate({
        raw: {
          ...template,
          questions: [{ ...template.questions[0], revision: 6 }],
        },
        currentRevision: 12,
        currentQuestions,
      }),
    ).toThrow("已更新到 R7");
    expect(() =>
      parseAuthoritativeQuestionsTemplate({
        raw: { ...template, questions: [] },
        currentRevision: 12,
        currentQuestions,
      }),
    ).toThrow("必须完整保留当前问题目录");
  });
});

describe("dashboard module import preflight", () => {
  const fileHash = "b".repeat(64);

  it("rejects a missing or stale dashboard revision before any file parser runs", () => {
    expect(() =>
      assertDashboardImportRevision({
        expectedRevision: undefined,
        currentRevision: 9,
      }),
    ).toThrow("缺少看板版本号");
    expect(() =>
      assertDashboardImportRevision({
        expectedRevision: 8,
        currentRevision: 9,
      }),
    ).toThrow(DashboardRevisionConflictError);
    expect(() =>
      assertDashboardImportRevision({
        expectedRevision: 9,
        currentRevision: 9,
      }),
    ).not.toThrow();
  });

  it("disables the legacy full-dashboard import endpoint path", () => {
    expect(() => assertDashboardImportModuleEnabled("full")).toThrow(
      "整份看板导入已停用",
    );
    expect(() => assertDashboardImportModuleEnabled("profile")).not.toThrow();
  });

  it("requires a same-file hash before every importable module can publish", () => {
    const modules = [
      "profile",
      "metrics",
      "sections",
      "section-table",
      "keywords",
      "questions",
      "monitoring",
      "response-logic",
      "content-assets",
      "optimization-report",
    ] as const;

    for (const module of modules) {
      expect(() =>
        assertDashboardImportPublishHash({
          module,
          fileHash,
          expectedFileHash: undefined,
        }),
      ).toThrow("必须先完成预检");
      expect(() =>
        assertDashboardImportPublishHash({
          module,
          fileHash,
          expectedFileHash: "c".repeat(64),
        }),
      ).toThrow("内容已发生变化");
      expect(() =>
        assertDashboardImportPublishHash({
          module,
          fileHash,
          expectedFileHash: fileHash,
        }),
      ).not.toThrow();
    }
  });

  it("builds readable field and record diffs without mutating either payload", () => {
    const current = createDefaultDashboardPayload("当前企业");
    const incoming = {
      ...current,
      headline: "更新后的标题",
      metrics: [
        {
          label: "提及率",
          value: "38",
          unit: "%",
          note: "本期监控",
        },
      ],
    };
    const currentBefore = JSON.stringify(current);
    const incomingBefore = JSON.stringify(incoming);

    const profilePreview = buildDashboardModuleImportPreview({
      module: "profile",
      current,
      incoming,
      sourceName: "profile.json",
      fileHash,
      templateRevision: 8,
    });
    const metricsPreview = buildDashboardModuleImportPreview({
      module: "metrics",
      current,
      incoming,
      sourceName: "metrics.xlsx",
      fileHash,
      templateRevision: 8,
    });

    expect(profilePreview).toEqual(
      expect.objectContaining({
        mode: "dashboard-module",
        module: "profile",
        templateRevision: 8,
        fileHash,
        changedFields: [
          expect.objectContaining({
            field: "headline",
            before: current.headline,
            after: incoming.headline,
          }),
        ],
      }),
    );
    expect(metricsPreview.recordStats[0]).toEqual({
      label: "看板指标",
      beforeCount: 0,
      afterCount: 1,
      added: 1,
      updated: 0,
      removed: 0,
      unchanged: 0,
    });
    expect(JSON.stringify(current)).toBe(currentBefore);
    expect(JSON.stringify(incoming)).toBe(incomingBefore);
  });

  it("compares response-logic records and reports the formal publish count", () => {
    const draft = {
      concern: "用户关心",
      conclusion: "结论",
      facts: "事实",
      pending: "",
      boundaries: "边界",
      references: "来源",
      images: [],
      attachments: [],
    };
    const preview = buildResponseLogicImportPreview({
      current: [
        {
          questionId: "question-1",
          question: "当前问题",
          draft,
          revision: 4,
        },
      ],
      incoming: [
        {
          questionId: "question-1",
          groupId: "industry",
          groupTitle: "行业问题",
          question: "当前问题",
          intent: "",
          summary: "",
          draft: { ...draft, conclusion: "更新结论" },
          publish: true,
          expectedRevision: 4,
        },
      ],
      sourceName: "response-logic.json",
      fileHash,
      templateRevision: 8,
    });

    expect(preview.module).toBe("response-logic");
    expect(preview.recordStats[0]).toEqual(
      expect.objectContaining({
        beforeCount: 1,
        afterCount: 1,
        updated: 1,
      }),
    );
    expect(preview.summary).toContain(
      "其中 1 条会发布为正式确认版本，其余保存为草稿。",
    );
  });

  it("rejects a response-logic preflight when any record version is stale", () => {
    const draft = {
      concern: "用户关心",
      conclusion: "结论",
      facts: "事实",
      pending: "",
      boundaries: "边界",
      references: "来源",
      images: [],
      attachments: [],
    };
    expect(() =>
      buildResponseLogicImportPreview({
        current: [
          {
            questionId: "question-1",
            question: "当前问题",
            draft,
            revision: 5,
          },
        ],
        incoming: [
          {
            questionId: "question-1",
            groupId: "industry",
            groupTitle: "行业问题",
            question: "当前问题",
            intent: "",
            summary: "",
            draft,
            publish: false,
            expectedRevision: 4,
          },
        ],
        sourceName: "response-logic.json",
        fileHash,
        templateRevision: 8,
      }),
    ).toThrow("已更新到 R5");
  });
});

describe("progress report screenshot validation", () => {
  it("accepts a real PNG and rejects content disguised as an image", () => {
    const png = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00,
    ]);
    expect(
      validateProgressReportScreenshot({
        filename: "answer.png",
        bytes: png,
      }),
    ).toEqual({ extension: ".png", mimeType: "image/png" });
    expect(() =>
      validateProgressReportScreenshot({
        filename: "answer.png",
        bytes: Buffer.from("<script>alert(1)</script>"),
      }),
    ).toThrow("内容与文件扩展名不一致");
  });
});

describe("knowledge archive enterprise identity", () => {
  it("binds Dashboard-owned package identity to build and manifest rather than node prose", () => {
    expect(() =>
      assertDashboardOwnedKnowledgePackageEnterpriseIdentity({
        brandName: "验收企业",
        buildCompanyName: " 验收 企业 ",
        manifestCompanyName: "验收企业",
      }),
    ).not.toThrow();

    expect(() =>
      assertDashboardOwnedKnowledgePackageEnterpriseIdentity({
        brandName: "验收企业",
        buildCompanyName: "验收企业",
        manifestCompanyName: "另一企业",
      }),
    ).toThrow("验收企业");
  });

  it("accepts a package that declares the account-bound enterprise", () => {
    expect(() =>
      assertKnowledgeArchiveEnterpriseIdentity({
        enterpriseIdentityConfirmed: true,
        brandName: "验收企业",
        documents: [
          {
            path: "验收企业知识库/README.md",
            title: "知识库说明",
            content: "# 验收企业知识库",
          },
        ],
      }),
    ).not.toThrow();
  });

  it("uses the account enterprise without requiring a published dashboard", () => {
    expect(() =>
      assertKnowledgeArchiveEnterpriseIdentity({
        enterpriseIdentityConfirmed: false,
        brandName: "验收企业",
        documents: [
          {
            path: "验收企业知识库/README.md",
            title: "知识库说明",
            content: "# 验收企业知识库",
          },
        ],
      }),
    ).not.toThrow();

    expect(() =>
      assertKnowledgeArchiveEnterpriseIdentity({
        enterpriseIdentityConfirmed: true,
        brandName: "验收企业",
        documents: [
          {
            path: "另一企业知识库/README.md",
            title: "知识库说明",
            content: "# 另一企业知识库",
          },
        ],
      }),
    ).toThrow("验收企业");
  });
});

describe("dashboard CSV normalization", () => {
  it("turns standard rows into metrics, sections and items", () => {
    const payload = dashboardFromCsv(
      [
        "type,section,title,value,unit,note,subtitle,description,meta,image_url",
        "brand,,,验收企业,,,,,,",
        "headline,,,企业知识中枢,,,,,,",
        "metric,,图片资产,128,张,全网与官网采集,,,,",
        "section,overview,企业概览,,,,标准化事实,机床制造企业,,",
        "item,overview,核心产品,,,,,数控机床,已核验,https://example.com/a.jpg",
      ].join("\n"),
      "默认企业",
    );

    expect(payload.brandName).toBe("验收企业");
    expect(payload.metrics).toEqual([
      {
        label: "图片资产",
        value: "128",
        unit: "张",
        note: "全网与官网采集",
      },
    ]);
    expect(payload.sections[0]).toMatchObject({
      id: "overview",
      title: "企业概览",
      subtitle: "标准化事实",
      body: "机床制造企业",
      items: [
        {
          title: "核心产品",
          description: "数控机床",
          meta: "已核验",
          imageUrl: "https://example.com/a.jpg",
        },
      ],
    });
  });

  it("supports commas escaped inside quoted CSV cells", () => {
    const payload = dashboardFromCsv(
      [
        "type,section,title,value,description",
        'summary,,,"研究,采集与核验",',
        'section,overview,"企业,概览",,"正文,包含逗号"',
      ].join("\n"),
      "企业",
    );

    expect(payload.summary).toBe("研究,采集与核验");
    expect(payload.sections[0]?.title).toBe("企业,概览");
    expect(payload.sections[0]?.body).toBe("正文,包含逗号");
  });

  it("imports administrator-managed response questions", () => {
    const payload = dashboardFromCsv(
      [
        "type,section,title,value,description,id,group_id,group_title,group_subtitle,tone,intent,summary",
        "question,,企业知识库怎么搭建？,,,,scenario,产品场景,应用需求与决策问答,teal,用户需要完整方法,解释采集到复测闭环",
      ].join("\n"),
      "企业",
    );

    expect(payload.questions).toEqual([
      {
        id: "question-1",
        groupId: "scenario",
        groupTitle: "产品场景",
        groupSubtitle: "应用需求与决策问答",
        tone: "teal",
        question: "企业知识库怎么搭建？",
        intent: "用户需要完整方法",
        summary: "解释采集到复测闭环",
      },
    ]);
  });

  it("imports display tables without turning rows into summary cards", () => {
    const payload = dashboardFromCsv(
      [
        "type,section,id,title,columns,table_id,values",
        'table,products,product-ledger,产品参数,"型号|功率|状态",,',
        'table_row,products,,,,product-ledger,"H100|100W|在售"',
        'table_row,products,,,,product-ledger,"H200|200W|待发布"',
      ].join("\n"),
      "企业",
    );

    expect(payload.sections).toEqual([
      expect.objectContaining({
        id: "products",
        tables: [
          {
            id: "product-ledger",
            title: "产品参数",
            columns: ["型号", "功率", "状态"],
            rows: [
              ["H100", "100W", "在售"],
              ["H200", "200W", "待发布"],
            ],
          },
        ],
      }),
    ]);
  });
});

describe("dashboard module merging", () => {
  it("replaces only the selected module and preserves every other module", () => {
    const existing = {
      ...createDefaultDashboardPayload("验收企业"),
      headline: "原标题",
      questions: [
        {
          id: "q-original",
          groupId: "brand",
          groupTitle: "品牌",
          groupSubtitle: "",
          tone: "plum" as const,
          question: "原问题",
          intent: "",
          summary: "",
        },
      ],
      keywordTables: [
        {
          id: "keywords",
          title: "原词库",
          columns: ["关键词"],
          rows: [["数控机床"]],
        },
      ],
    };
    const incoming = {
      ...createDefaultDashboardPayload("不会覆盖企业名"),
      questions: [
        {
          id: "q-new",
          groupId: "product",
          groupTitle: "产品",
          groupSubtitle: "",
          tone: "teal" as const,
          question: "新问题",
          intent: "",
          summary: "",
        },
      ],
    };

    const merged = mergeDashboardModule({
      existing,
      incoming,
      module: "questions",
    });

    expect(merged.brandName).toBe("验收企业");
    expect(merged.headline).toBe("原标题");
    expect(merged.keywordTables).toEqual(existing.keywordTables);
    expect(merged.questions).toEqual(incoming.questions);
  });
});

describe("monitoring current-content template", () => {
  const currentBatches = [
    {
      batchKey: "batch-2026-07-24",
      revision: 3,
      sourceName: "正式监控数据.xlsx",
      collectedAt: "2026-07-24T08:00:00.000Z",
      samples: [
        {
          sourceRecordId: "answer-1",
          questionId: "question-1",
          platform: "DeepSeek",
          answerNo: 1,
          content: "正式回答",
          citationCount: 1,
          screenshotUrl: "",
          collectedAt: "2026-07-24T08:00:00.000Z",
        },
      ],
      citations: [
        {
          sourceRecordId: "citation-1",
          questionId: "question-1",
          sampleSourceRecordId: "answer-1",
          model: "DeepSeek",
          title: "正式信源",
          url: "https://example.com/source",
          media: "行业媒体",
          domain: "example.com",
          collectedAt: "2026-07-24T08:00:00.000Z",
        },
      ],
    },
  ];

  it("round-trips the authoritative normalized batches and previews changed rows", () => {
    const raw = {
      ...createDashboardModuleTemplateMetadata({
        module: "monitoring",
        revision: 9,
      }),
      workspaceUserId: 42,
      batches: [
        {
          ...currentBatches[0],
          samples: [
            {
              ...currentBatches[0]!.samples[0],
              content: "管理员修订后的正式回答",
            },
          ],
        },
      ],
    };
    const parsed = parseMonitoringCurrentTemplate({
      raw,
      currentRevision: 9,
      workspaceUserId: 42,
      currentBatches,
    });
    expect(parsed.changedBatchCount).toBe(1);
    expect(
      buildMonitoringCurrentTemplatePreview({
        template: parsed.template,
        changedBatchCount: parsed.changedBatchCount,
        sourceName: "frontmind-monitoring-current-42-R9.json",
        fileHash: "a".repeat(64),
        templateRevision: 9,
      }),
    ).toMatchObject({
      currentTemplate: true,
      changedBatchCount: 1,
      sampleCount: 1,
      citationCount: 1,
      exactLinked: 1,
    });
  });

  it("rejects a stale batch revision instead of overwriting formal monitoring data", () => {
    expect(() =>
      parseMonitoringCurrentTemplate({
        raw: {
          ...createDashboardModuleTemplateMetadata({
            module: "monitoring",
            revision: 9,
          }),
          workspaceUserId: 42,
          batches: [
            {
              ...currentBatches[0],
              revision: 2,
              sourceName: "过期模板.xlsx",
            },
          ],
        },
        currentRevision: 9,
        workspaceUserId: 42,
        currentBatches,
      }),
    ).toThrow("已更新到 R3");
  });
});

describe("dashboard monitoring normalization", () => {
  const question = {
    id: "question-1",
    groupId: "brand",
    groupTitle: "品牌认知",
    groupSubtitle: "",
    tone: "plum" as const,
    question: "验收企业是一家什么样的公司？",
    intent: "",
    summary: "",
  };

  function payloadWithMonitoring() {
    return {
      ...createDefaultDashboardPayload("验收企业"),
      questions: [question],
      monitoringAnswers: [
        {
          id: "answer-1",
          questionId: "question-1",
          platform: "DeepSeek",
          collectedAt: "不是日期",
          answerNo: 1,
          content: "验收企业专注于企业知识服务。",
          citationCount: 1,
          monitorRank: 2,
          screenshotUrl: "",
          citations: [
            {
              title: "验收企业官网",
              url: "https://example.com/company",
              media: "官网",
            },
          ],
        },
      ],
      citations: [
        {
          id: "citation-standalone-1",
          questionId: "",
          model: "豆包",
          question: question.question,
          title: "行业报道",
          url: "https://news.example.com/article",
          media: "行业媒体",
          domain: "news.example.com",
          date: "2026-07-23",
        },
      ],
    };
  }

  it("recognizes a Chinese multi-sheet citation export and keeps raw records only", () => {
    const existing = {
      ...createDefaultDashboardPayload("验收企业"),
      questions: [question],
    };
    const payload = monitoringPayloadFromTabularSources({
      existing,
      sources: [
        {
          title: "媒体引用分析",
          rows: [
            ["域名", "媒体名称", "引用次数", "引用占比"],
            ["example.com", "行业媒体", "99", "12%"],
          ],
        },
        {
          title: "问题引用分析",
          rows: [
            [
              "模型",
              "监控问题",
              "文章标题",
              "文章链接",
              "媒体名称",
              "引用日期",
            ],
            [
              "deepseek",
              question.question,
              "验收企业方案中心",
              "https://www.example.com/product",
              "企业官网",
              "2026-07-23",
            ],
          ],
        },
      ],
    });

    expect(payload?.citations).toEqual([
      expect.objectContaining({
        question: question.question,
        model: "deepseek",
        title: "验收企业方案中心",
        url: "https://www.example.com/product",
        media: "企业官网",
        domain: "example.com",
        date: "2026-07-23",
      }),
    ]);
    expect(payload?.monitoringAnswers).toEqual([]);
  });

  it("recognizes answer details and binds citation rows by exact answer ID", () => {
    const existing = {
      ...createDefaultDashboardPayload("验收企业"),
      questions: [question],
    };
    const payload = monitoringPayloadFromTabularSources({
      existing,
      sources: [
        {
          title: "问题引用分析",
          rows: [
            [
              "引用ID",
              "答案ID",
              "问题ID",
              "文章标题",
              "文章链接",
              "媒体名称",
              "引用日期",
            ],
            [
              "citation-1",
              "answer-1",
              "question-1",
              "产品中心",
              "https://example.com/product",
              "企业官网",
              "2026-07-23",
            ],
          ],
        },
        {
          title: "答案明细",
          rows: [
            ["答案ID", "问题ID", "问题原文", "模型", "采集时间", "答案正文"],
            [
              "answer-1",
              "question-1",
              question.question,
              "DeepSeek",
              "2026-07-24 09:30:00",
              "模型回答正文",
            ],
          ],
        },
      ],
    });

    expect(payload?.monitoringAnswers).toEqual([
      expect.objectContaining({
        id: "answer-1",
        questionId: "question-1",
        platform: "DeepSeek",
        content: "模型回答正文",
        citationCount: 1,
        citations: [
          expect.objectContaining({
            id: "citation-1",
            title: "产品中心",
            url: "https://example.com/product",
            media: "企业官网",
            publishedAt: "2026-07-23",
          }),
        ],
      }),
    ]);
    expect(payload?.citations).toEqual([]);
  });

  it("rejects an unknown answer ID or a citation linked across questions", () => {
    const anotherQuestion = {
      ...question,
      id: "question-2",
      question: "验收企业有哪些核心服务？",
    };
    const existing = {
      ...createDefaultDashboardPayload("验收企业"),
      questions: [question, anotherQuestion],
    };
    const answerSheet = {
      title: "答案明细",
      rows: [
        ["答案ID", "问题ID", "问题原文", "模型", "采集时间", "答案正文"],
        [
          "answer-1",
          "question-1",
          question.question,
          "DeepSeek",
          "2026-07-24",
          "模型回答正文",
        ],
      ],
    };
    expect(() =>
      monitoringPayloadFromTabularSources({
        existing,
        sources: [
          answerSheet,
          {
            title: "问题引用分析",
            rows: [
              [
                "引用ID",
                "答案ID",
                "问题ID",
                "文章标题",
                "文章链接",
                "媒体名称",
                "引用日期",
              ],
              [
                "citation-1",
                "missing-answer",
                "question-1",
                "产品中心",
                "https://example.com/product",
                "企业官网",
                "2026-07-23",
              ],
            ],
          },
        ],
      }),
    ).toThrow("不存在的答案 ID");

    expect(() =>
      monitoringPayloadFromTabularSources({
        existing,
        sources: [
          answerSheet,
          {
            title: "问题引用分析",
            rows: [
              [
                "引用ID",
                "答案ID",
                "问题ID",
                "文章标题",
                "文章链接",
                "媒体名称",
                "引用日期",
              ],
              [
                "citation-1",
                "answer-1",
                "question-2",
                "产品中心",
                "https://example.com/product",
                "企业官网",
                "2026-07-23",
              ],
            ],
          },
        ],
      }),
    ).toThrow("答案 ID 与问题不一致");
  });

  it("rejects duplicate IDs, invalid dates, and answer-model mismatches with row context", () => {
    const existing = {
      ...createDefaultDashboardPayload("验收企业"),
      questions: [question],
    };
    const answerHeader = [
      "答案ID",
      "问题ID",
      "问题原文",
      "模型",
      "采集时间",
      "答案正文",
    ];
    const answerRow = [
      "answer-1",
      "question-1",
      question.question,
      "DeepSeek",
      "2026-07-24 09:30:00",
      "模型回答正文",
    ];
    const citationHeader = [
      "引用ID",
      "答案ID",
      "问题ID",
      "模型",
      "文章标题",
      "文章链接",
      "媒体名称",
      "引用日期",
    ];
    const citationRow = [
      "citation-1",
      "answer-1",
      "question-1",
      "DeepSeek",
      "产品中心",
      "https://example.com/product",
      "企业官网",
      "2026-07-23",
    ];

    expect(() =>
      monitoringPayloadFromTabularSources({
        existing,
        sources: [
          { title: "答案明细", rows: [answerHeader, answerRow, answerRow] },
        ],
      }),
    ).toThrow("重复的答案 ID");

    expect(() =>
      monitoringPayloadFromTabularSources({
        existing,
        sources: [
          {
            title: "答案明细",
            rows: [
              answerHeader,
              answerRow.map((value, index) =>
                index === 4 ? "不是日期" : value,
              ),
            ],
          },
        ],
      }),
    ).toThrow("答案明细 第 2 行的日期无效");

    expect(() =>
      monitoringPayloadFromTabularSources({
        existing,
        sources: [
          { title: "答案明细", rows: [answerHeader, answerRow] },
          {
            title: "问题引用分析",
            rows: [citationHeader, citationRow, citationRow],
          },
        ],
      }),
    ).toThrow("重复的引用 ID");

    expect(() =>
      monitoringPayloadFromTabularSources({
        existing,
        sources: [
          { title: "答案明细", rows: [answerHeader, answerRow] },
          {
            title: "问题引用分析",
            rows: [
              citationHeader,
              citationRow.map((value, index) => (index === 3 ? "豆包" : value)),
            ],
          },
        ],
      }),
    ).toThrow("模型与答案 ID 不一致");
  });

  it("keeps all 705 rows from the legacy six-column question-level export without inventing answer links", () => {
    const secondQuestion = {
      ...question,
      id: "question-2",
      question: "验收企业有哪些核心服务？",
    };
    const rows = Array.from({ length: 705 }, (_, index) => {
      const currentQuestion = index % 2 === 0 ? question : secondQuestion;
      return [
        ["DeepSeek", "豆包", "通义千问", "百度 AI", "腾讯元宝"][index % 5]!,
        currentQuestion.question,
        `引用内容 ${index + 1}`,
        `https://example.com/articles/${index % 137}`,
        `媒体 ${index % 17}`,
        "2026-07-27",
      ];
    });
    const payload = monitoringPayloadFromTabularSources({
      existing: {
        ...createDefaultDashboardPayload("验收企业"),
        questions: [question, secondQuestion],
      },
      sources: [
        {
          title: "问题引用分析",
          rows: [
            [
              "模型",
              "监控问题",
              "文章标题",
              "文章链接",
              "媒体名称",
              "引用日期",
            ],
            ...rows,
          ],
        },
      ],
    });

    expect(payload?.monitoringAnswers).toHaveLength(0);
    expect(payload?.citations).toHaveLength(705);
    expect(
      new Set(payload?.citations.map((citation) => citation.questionId)),
    ).toEqual(new Set(["question-1", "question-2"]));
  });

  it("imports the legacy five-answer workbook as samples and keeps its matching citation workbook question-scoped", () => {
    const existing = {
      ...createDefaultDashboardPayload("匿名企业乙"),
      questions: [question],
    };
    const answerPayload = monitoringPayloadFromTabularSources({
      existing,
      sources: [
        {
          title: "百度文心",
          rows: [
            [
              "品牌名称",
              "问题核心词",
              "问题",
              "日期",
              "答案1",
              "答案1",
              "答案1",
              "答案1",
              "答案2",
              "答案2",
              "答案2",
              "答案2",
            ],
            [
              "品牌名称",
              "问题核心词",
              "问题",
              "日期",
              "内容",
              "截图链接",
              "排名",
              "监控词排名",
              "内容",
              "截图链接",
              "排名",
              "监控词排名",
            ],
            [
              "匿名企业乙",
              "匿名企业乙",
              question.question,
              "2026-07-24",
              "第一条真实回答",
              "https://img.example.com/answer-1.png",
              "",
              "1",
              "第二条真实回答",
              "https://img.example.com/answer-2.png",
              "",
              "2",
            ],
          ],
        },
      ],
    });
    expect(answerPayload?.monitoringAnswers).toHaveLength(2);
    expect(answerPayload?.monitoringAnswers[0]).toMatchObject({
      questionId: question.id,
      platform: "baiduai",
      answerNo: 1,
      content: "第一条真实回答",
      screenshotUrl: "https://img.example.com/answer-1.png",
      citations: [],
    });
    expect(answerPayload?.monitoringAnswers[0]?.id).toMatch(
      /^legacy-answer-[a-f0-9]{40}$/,
    );

    const citationPayload = monitoringPayloadFromTabularSources({
      existing,
      sources: [
        {
          title: "问题引用分析",
          rows: [
            [
              "模型",
              "监控问题",
              "文章标题",
              "文章链接",
              "媒体名称",
              "引用日期",
            ],
            [
              "baiduai",
              question.question,
              "引用文章",
              "https://example.com/source",
              "示例媒体",
              "2026-07-24",
            ],
          ],
        },
      ],
    });
    expect(citationPayload?.monitoringAnswers).toHaveLength(0);
    expect(citationPayload?.citations).toEqual([
      expect.objectContaining({
        questionId: question.id,
        model: "baiduai",
        title: "引用文章",
      }),
    ]);

    const answerBatch = buildDashboardMonitoringImport({
      targetUserId: 42,
      payload: answerPayload!,
      sourceFileName: "匿名企业乙_数据表格.xlsx",
    })!;
    const citationBatch = buildDashboardMonitoringImport({
      targetUserId: 42,
      payload: citationPayload!,
      sourceFileName: "引用分析数据导出.xlsx",
    })!;
    expect(
      buildMonitoringImportPreview({
        payload: answerPayload!,
        batch: answerBatch,
        sourceName: "匿名企业乙_数据表格.xlsx",
        fileHash: "a".repeat(64),
      }).mode,
    ).toBe("answer-only");
    expect(
      buildMonitoringImportPreview({
        payload: citationPayload!,
        batch: citationBatch,
        sourceName: "引用分析数据导出.xlsx",
        fileHash: "b".repeat(64),
      }),
    ).toMatchObject({
      mode: "question-only",
      targetBatchRequired: true,
      citationCount: 1,
    });
  });

  it("builds a deterministic preflight for linked and legacy monitoring files", () => {
    const linkedPayload = payloadWithMonitoring();
    linkedPayload.citations = [];
    const fileHash = monitoringImportFileHash(
      Buffer.from("monitoring-workbook-v2"),
    );
    const linkedBatch = buildDashboardMonitoringImport({
      targetUserId: 42,
      payload: linkedPayload,
      sourceFileName: "monitoring-v2.xlsx",
      sourceHash: fileHash,
      now: new Date("2026-07-24T08:00:00.000Z"),
    })!;
    const linkedPreview = buildMonitoringImportPreview({
      payload: linkedPayload,
      batch: linkedBatch,
      sourceName: "monitoring-v2.xlsx",
      fileHash,
    });
    expect(linkedBatch.batchKey).toBe(`dashboard-import:sha256:${fileHash}`);
    expect(linkedPreview).toMatchObject({
      mode: "answer-linked",
      fileHash,
      targetBatchRequired: false,
      sampleCount: 1,
      citationCount: 1,
      exactLinked: 1,
    });

    const legacyPayload = {
      ...createDefaultDashboardPayload("验收企业"),
      questions: [question],
      citations: [
        {
          id: "legacy-citation",
          questionId: question.id,
          model: "DeepSeek",
          question: question.question,
          title: "行业报道",
          url: "https://example.com/story",
          media: "行业媒体",
          domain: "example.com",
          date: "2026-07-23",
        },
      ],
    };
    const legacyBatch = buildDashboardMonitoringImport({
      targetUserId: 42,
      payload: legacyPayload,
      sourceFileName: "legacy.xlsx",
    })!;
    const legacyPreview = buildMonitoringImportPreview({
      payload: legacyPayload,
      batch: legacyBatch,
      sourceName: "legacy.xlsx",
      fileHash: "a".repeat(64),
      availableBatches: [
        {
          batchKey: "answer-batch",
          sourceName: "answers.xlsx",
          collectedAt: 0,
          revision: 1,
          sampleCount: 20,
          citationCount: 0,
        },
      ],
    });
    expect(legacyPreview).toMatchObject({
      mode: "question-only",
      targetBatchRequired: true,
      suggestedBatchKey: "answer-batch",
      sampleCount: 0,
      citationCount: 1,
      exactLinked: 0,
    });
    expect(legacyPreview.issues[0]?.code).toBe(
      "MONITORING_TARGET_BATCH_REQUIRED",
    );
  });

  it("builds a stable normalized batch and links embedded citations to samples", () => {
    const payload = payloadWithMonitoring();
    const first = buildDashboardMonitoringImport({
      targetUserId: 42,
      payload,
      sourceFileName: "/tmp/引用分析数据导出_20260723.csv",
      now: new Date("2026-07-24T08:00:00.000Z"),
    });
    const second = buildDashboardMonitoringImport({
      targetUserId: 42,
      payload,
      sourceFileName: "/another/引用分析数据导出_20260723.csv",
      now: new Date("2030-01-01T00:00:00.000Z"),
    });

    expect(first).not.toBeNull();
    expect(first?.batchKey).toBe(second?.batchKey);
    expect(first?.batchKey.length).toBeLessThanOrEqual(191);
    expect(first?.collectedAt).toBe("2026-07-23T00:00:00.000Z");
    expect(first?.samples).toEqual([
      {
        sourceRecordId: "answer-1",
        questionId: "question-1",
        platform: "DeepSeek",
        answerNo: 1,
        content: "验收企业专注于企业知识服务。",
        citationCount: 1,
        monitorRank: 2,
        screenshotUrl: "",
        collectedAt: undefined,
      },
    ]);
    expect(first?.citations[0]).toMatchObject({
      questionId: "question-1",
      sampleSourceRecordId: "answer-1",
      model: "DeepSeek",
      title: "验收企业官网",
    });
    expect(first?.citations[0]?.sourceRecordId).toMatch(
      /^embedded-citation:[a-f0-9]{40}$/,
    );
    expect(first?.citations[1]).toMatchObject({
      sourceRecordId: "citation-standalone-1",
      questionId: "question-1",
      model: "豆包",
      collectedAt: "2026-07-23T00:00:00.000Z",
      publishedAt: "2026-07-23T00:00:00.000Z",
    });
  });

  it("uses the provided current time when every imported date is invalid", () => {
    const payload = payloadWithMonitoring();
    payload.citations[0]!.date = "无效日期";
    const result = buildDashboardMonitoringImport({
      targetUserId: 42,
      payload,
      sourceFileName: "monitoring.json",
      now: new Date("2026-07-24T08:30:00.000Z"),
    });

    expect(result?.collectedAt).toBe("2026-07-24T08:30:00.000Z");
    expect(result?.citations[1]).toMatchObject({
      collectedAt: undefined,
      publishedAt: undefined,
    });
  });

  it("rejects unknown question ids and non-exact standalone question text", () => {
    const unknownIdPayload = payloadWithMonitoring();
    unknownIdPayload.monitoringAnswers[0]!.questionId = "unknown";
    expect(() =>
      buildDashboardMonitoringImport({
        targetUserId: 42,
        payload: unknownIdPayload,
        sourceFileName: "monitoring.json",
      }),
    ).toThrow("未配置的问题");

    const inexactPayload = payloadWithMonitoring();
    inexactPayload.citations[0]!.question = `${question.question}（补充）`;
    expect(() =>
      buildDashboardMonitoringImport({
        targetUserId: 42,
        payload: inexactPayload,
        sourceFileName: "monitoring.json",
      }),
    ).toThrow("无法在问题目录中精确匹配");
  });

  it("stores a lightweight dashboard and publishes monitoring only when present", async () => {
    const actor = {
      id: 7,
      role: "admin",
    } as AuthenticatedUser;
    const updateWorkspace = vi.fn(async ({ payload }) => ({
      payload,
      sourceName: "monitoring.json",
      updatedAt: null,
      knowledgeUpdatedAt: null,
    }));
    const replaceMonitoring = vi.fn(async () => ({
      batchId: "batch-1",
      batchKey: "dashboard-import:test",
      revision: 1,
      sampleCount: 1,
      citationCount: 2,
      collectedAt: 0,
    }));
    const payload = payloadWithMonitoring();

    await importDashboardPayload({
      actor,
      targetUserId: 42,
      payload,
      sourceFileName: "monitoring.json",
      expectedRevision: 6,
      now: new Date("2026-07-24T08:00:00.000Z"),
      dependencies: { updateWorkspace, replaceMonitoring },
    });

    expect(updateWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 42,
        actorUserId: 7,
        expectedRevision: 6,
        payload: expect.objectContaining({
          questions: [question],
          monitoringAnswers: [],
          citations: [],
        }),
      }),
    );
    expect(replaceMonitoring).toHaveBeenCalledWith(
      expect.objectContaining({
        actor,
        value: expect.objectContaining({
          userId: 42,
          samples: expect.arrayContaining([
            expect.objectContaining({ sourceRecordId: "answer-1" }),
          ]),
        }),
      }),
    );

    updateWorkspace.mockClear();
    replaceMonitoring.mockClear();
    await importDashboardPayload({
      actor,
      targetUserId: 42,
      payload: {
        ...createDefaultDashboardPayload("验收企业"),
        questions: [question],
      },
      sourceFileName: "dashboard.json",
      bindEnterpriseIdentity: true,
      dependencies: { updateWorkspace, replaceMonitoring },
    });
    expect(updateWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({ bindEnterpriseIdentity: true }),
    );
    expect(replaceMonitoring).not.toHaveBeenCalled();
  });

  it("passes the authoritative contract periods into a progress-report publication", async () => {
    const actor = { id: 7, role: "admin" } as AuthenticatedUser;
    const beforeWrite = vi.fn();
    const afterWrite = vi.fn();
    const updateWorkspace = vi.fn(async ({ payload }) => ({
      payload,
      sourceName: "progress-report.json",
      updatedAt: null,
      knowledgeUpdatedAt: null,
    }));
    const replaceMonitoring = vi.fn();
    const payload = {
      ...createDefaultDashboardPayload("验收企业"),
      optimizationReport: {
        period: "2026 年 7 月",
        title: "验收企业 GEO 进度报告",
        subtitle: "",
        executiveSummary: [],
        kpis: [],
        platforms: [],
        journeys: [],
        competitorTiers: [],
        sourceMix: [],
        risks: [],
        roadmap: [],
        reportRecords: [],
      },
    };

    await importDashboardPayload({
      actor,
      targetUserId: 42,
      payload,
      sourceFileName: "progress-report.json",
      expectedRevision: 9,
      progressReportPeriods: [
        { contractId: "contract-current", quotaPeriodId: "period-current" },
      ],
      beforeWrite,
      afterWrite,
      dependencies: { updateWorkspace, replaceMonitoring },
    });

    expect(updateWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({
        progressReportPeriods: [
          { contractId: "contract-current", quotaPeriodId: "period-current" },
        ],
        beforeWrite,
        afterWrite,
      }),
    );
    expect(replaceMonitoring).not.toHaveBeenCalled();
  });
});

describe("response logic module import", () => {
  it("binds imported logic to the authoritative dashboard question", () => {
    const existing = {
      ...createDefaultDashboardPayload("验收企业"),
      questions: [
        {
          id: "question-1",
          groupId: "product",
          groupTitle: "产品场景",
          groupSubtitle: "",
          tone: "teal" as const,
          question: "龙门加工中心适合哪些场景？",
          intent: "确认适用范围",
          summary: "说明材料、行程与精度边界",
        },
      ],
    };
    const records = responseLogicImportsFromTabularSources({
      existing,
      sources: [
        {
          title: "应答逻辑",
          rows: [
            [
              "question_id",
              "version",
              "用户真正关心",
              "核心结论/执行口径",
              "企业材料/官方依据",
              "企业待确认",
              "表达边界",
              "参考资料",
              "发布",
            ],
            [
              "question-1",
              "0",
              "设备是否适合大型工件",
              "先确认工件尺寸与加工精度",
              "产品参数表与检测报告",
              "最终选型",
              "不承诺未验证精度",
              "产品手册",
              "true",
            ],
          ],
        },
      ],
    });

    expect(records).toEqual([
      expect.objectContaining({
        questionId: "question-1",
        groupId: "product",
        question: "龙门加工中心适合哪些场景？",
        intent: "确认适用范围",
        publish: true,
        expectedRevision: 0,
        draft: expect.objectContaining({
          concern: "设备是否适合大型工件",
          conclusion: "先确认工件尺寸与加工精度",
          attachments: [],
        }),
      }),
    ]);
  });

  it("rejects a response-logic row that is not in the user's question catalog", () => {
    expect(() =>
      responseLogicImportsFromTabularSources({
        existing: createDefaultDashboardPayload("验收企业"),
        sources: [
          {
            title: "应答逻辑",
            rows: [
              ["question_id", "核心结论/执行口径"],
              ["another-company-question", "不应写入"],
            ],
          },
        ],
      }),
    ).toThrow("未匹配到问题目录");
  });

  it("rejects an old response-logic row without a record version", () => {
    const existing = {
      ...createDefaultDashboardPayload("验收企业"),
      questions: [
        {
          id: "question-1",
          groupId: "product",
          groupTitle: "产品场景",
          groupSubtitle: "",
          tone: "teal" as const,
          question: "龙门加工中心适合哪些场景？",
          intent: "确认适用范围",
          summary: "说明材料、行程与精度边界",
        },
      ],
    };
    expect(() =>
      responseLogicImportsFromTabularSources({
        existing,
        sources: [
          {
            title: "应答逻辑",
            rows: [
              ["question_id", "核心结论/执行口径"],
              ["question-1", "不应覆盖新版内容"],
            ],
          },
        ],
      }),
    ).toThrow("缺少有效的 version");
  });
});

describe("knowledge archive selection", () => {
  it("selects ZIP output files and derives an authenticated file id from URLs", () => {
    const descriptors = collectKnowledgeArchiveDescriptors([
      {
        role: "assistant",
        type: "message",
        id: "message-1",
        content: [
          {
            type: "output_file",
            file_name: "knowledge-base.zip",
            mime_type: "application/zip",
            file_url: "https://api.example.com/v1/files/file-kb-42/content",
          },
          {
            type: "output_file",
            file_name: "interactive-research.html",
            mime_type: "text/html",
            file_url: "https://example.com/report.html",
          },
        ],
      },
    ]);

    expect(descriptors).toEqual([
      {
        outputItemId: "message-1:content:0",
        fileId: "file-kb-42",
        url: "https://api.example.com/v1/files/file-kb-42/content",
        filename: "knowledge-base.zip",
        mimeType: "application/zip",
      },
    ]);
  });

  it("rejects arbitrary nested ZIP metadata and user output", () => {
    const descriptors = collectKnowledgeArchiveDescriptors([
      {
        type: "metadata",
        nested: {
          type: "file",
          filename: "metadata.zip",
          fileId: "file-metadata",
        },
      },
      {
        role: "user",
        type: "output_file",
        filename: "user.zip",
        fileId: "file-user",
      },
    ]);

    expect(descriptors).toEqual([]);
  });

  it("creates a stable binding hash for the exact output item", () => {
    const descriptor = collectKnowledgeArchiveDescriptors([
      {
        type: "output_file",
        id: "output-7",
        filename: "revision-2.zip",
        fileId: "file-new",
      },
    ])[0]!;

    expect(knowledgeArchiveDescriptorHash(descriptor)).toMatch(
      /^[a-f0-9]{64}$/,
    );
    expect(descriptor).toMatchObject({
      outputItemId: "output-7",
      fileId: "file-new",
      filename: "revision-2.zip",
    });
  });
});

describe("knowledge archive byte download", () => {
  it("reads a Website formal ZIP from the durable Dashboard copy without requesting its PUT-only upload URL", async () => {
    const assetRoot = await mkdtemp(
      path.join(tmpdir(), "frontmind-dashboard-kb-download-"),
    );
    const previousAssetRoot = process.env.FRONTMIND_DASHBOARD_ASSET_DIR;
    process.env.FRONTMIND_DASHBOARD_ASSET_DIR = assetRoot;
    const fileId = "file-formal-zip-local";
    const bytes = Buffer.from("durable-website-formal-zip", "utf8");
    try {
      await recordPresalesFileDescriptor({
        fileId,
        filename: "website-lead-v3.zip",
        mimeType: "application/zip",
        sizeBytes: bytes.length,
      });
      const staged = await stagePresalesFileContent({
        fileId,
        stream: Readable.from([bytes]),
        maxBytes: 1024,
      });
      await staged.commit({});
      const get = vi.spyOn(axios, "get");

      const downloaded = await downloadArchiveBytes({
        descriptor: {
          outputItemId: "output-local",
          fileId,
          filename: "descriptor-name.zip",
          mimeType: "application/zip",
        },
        apiKey: "secret-test-key",
        baseUrl: "https://api.example.test",
      });

      expect(downloaded).toEqual({
        buffer: bytes,
        filename: "website-lead-v3.zip",
      });
      expect(get).not.toHaveBeenCalled();
    } finally {
      if (previousAssetRoot === undefined) {
        delete process.env.FRONTMIND_DASHBOARD_ASSET_DIR;
      } else {
        process.env.FRONTMIND_DASHBOARD_ASSET_DIR = previousAssetRoot;
      }
      await rm(assetRoot, { recursive: true, force: true });
    }
  });

  it("keeps a legacy fileId with no durable copy fail-closed and performs no Provider I/O", async () => {
    const assetRoot = await mkdtemp(
      path.join(tmpdir(), "frontmind-dashboard-kb-legacy-file-id-"),
    );
    const previousAssetRoot = process.env.FRONTMIND_DASHBOARD_ASSET_DIR;
    process.env.FRONTMIND_DASHBOARD_ASSET_DIR = assetRoot;
    const get = vi.spyOn(axios, "get");
    try {
      await expect(
        downloadArchiveBytes({
          descriptor: {
            outputItemId: "output-legacy-file-id",
            fileId: "legacy-provider-file-only",
            filename: "legacy-result.zip",
            mimeType: "application/zip",
          },
          apiKey: "secret-test-key",
          baseUrl: "https://api.example.test",
        }),
      ).rejects.toMatchObject({
        kind: "local_copy_missing",
        retryable: false,
      });
      expect(get).not.toHaveBeenCalled();
    } finally {
      if (previousAssetRoot === undefined) {
        delete process.env.FRONTMIND_DASHBOARD_ASSET_DIR;
      } else {
        process.env.FRONTMIND_DASHBOARD_ASSET_DIR = previousAssetRoot;
      }
      await rm(assetRoot, { recursive: true, force: true });
    }
  });

  it("downloads a fresh materialized candidate's unique Provider fileId when explicitly enabled", async () => {
    const assetRoot = await mkdtemp(
      path.join(tmpdir(), "frontmind-dashboard-kb-fallback-"),
    );
    const previousAssetRoot = process.env.FRONTMIND_DASHBOARD_ASSET_DIR;
    process.env.FRONTMIND_DASHBOARD_ASSET_DIR = assetRoot;
    const bytes = Buffer.from("provider-file-id-archive", "utf8");
    const get = vi.spyOn(axios, "get").mockResolvedValue({
      status: 200,
      headers: {
        "content-length": String(bytes.length),
        "content-disposition": "attachment; filename=provider-file-id.zip",
      },
      data: Readable.from([bytes]),
    });
    try {
      await expect(
        downloadArchiveBytes({
          descriptor: {
            outputItemId: "output-upstream",
            fileId: "file-output-only",
            filename: "descriptor-name.zip",
            mimeType: "application/zip",
          },
          apiKey: "secret-test-key",
          baseUrl: "https://api.example.test",
          allowProviderFileIdFallback: true,
        }),
      ).resolves.toEqual({ buffer: bytes, filename: "provider-file-id.zip" });
      expect(get).toHaveBeenCalledWith(
        "https://api.example.test/v1/files/file-output-only/content",
        expect.objectContaining({
          headers: {
            API_KEY: "secret-test-key",
            Authorization: "Bearer secret-test-key",
          },
        }),
      );
    } finally {
      if (previousAssetRoot === undefined) {
        delete process.env.FRONTMIND_DASHBOARD_ASSET_DIR;
      } else {
        process.env.FRONTMIND_DASHBOARD_ASSET_DIR = previousAssetRoot;
      }
      await rm(assetRoot, { recursive: true, force: true });
    }
  });

  it.each([
    [404, true],
    [408, true],
    [425, true],
    [429, true],
    [500, true],
    [599, true],
    [400, false],
    [403, false],
    [410, false],
  ])(
    "classifies HTTP %i with retryable=%s without retaining the URL",
    async (status, retryable) => {
      const secretUrl =
        "https://downloads.example.test/company.zip?signature=secret-url-value";
      vi.spyOn(axios, "get").mockResolvedValue({
        status,
        headers: {},
        data: Readable.from([]),
      });

      const failure = await downloadArchiveBytes({
        descriptor: {
          outputItemId: "output-remote",
          url: secretUrl,
          filename: "company.zip",
          mimeType: "application/zip",
        },
        apiKey: "secret-test-key",
        baseUrl: "https://api.example.test",
      }).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(KnowledgeArchiveDownloadError);
      expect(failure).toMatchObject({
        kind: "http_status",
        status,
        retryable,
      });
      expect(String(failure)).not.toContain("secret-url-value");
      expect(JSON.stringify(failure)).not.toContain("secret-url-value");
    },
  );

  it("preserves the successful remote ZIP download result", async () => {
    const bytes = Buffer.from("remote-archive-bytes", "utf8");
    vi.spyOn(axios, "get").mockResolvedValue({
      status: 200,
      headers: {
        "content-length": String(bytes.length),
        "content-disposition": "attachment; filename=provider-result.zip",
      },
      data: Readable.from([bytes]),
    });

    await expect(
      downloadArchiveBytes({
        descriptor: {
          outputItemId: "output-remote",
          url: "https://downloads.example.test/company.zip",
          filename: "company.zip",
          mimeType: "application/zip",
        },
        apiKey: "secret-test-key",
        baseUrl: "https://api.example.test",
      }),
    ).resolves.toEqual({
      buffer: bytes,
      filename: "provider-result.zip",
    });
  });

  it("classifies a missing download address as deterministic", async () => {
    const get = vi.spyOn(axios, "get");

    await expect(
      downloadArchiveBytes({
        descriptor: {
          outputItemId: "output-without-address",
          filename: "company.zip",
          mimeType: "application/zip",
        },
        apiKey: "secret-test-key",
        baseUrl: "https://api.example.test",
      }),
    ).rejects.toMatchObject({
      kind: "missing_url",
      status: null,
      retryable: false,
    });
    expect(get).not.toHaveBeenCalled();
  });

  it.each([
    ["ECONNABORTED", "timeout"],
    ["ETIMEDOUT", "timeout"],
    ["ECONNRESET", "transport"],
  ])("classifies %s as a retryable %s failure", async (code, kind) => {
    vi.spyOn(axios, "get").mockRejectedValue(
      Object.assign(new Error("signed-url=secret-response-value"), { code }),
    );

    const failure = await downloadArchiveBytes({
      descriptor: {
        outputItemId: "output-remote",
        url: "https://downloads.example.test/company.zip",
        filename: "company.zip",
        mimeType: "application/zip",
      },
      apiKey: "secret-test-key",
      baseUrl: "https://api.example.test",
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(KnowledgeArchiveDownloadError);
    expect(failure).toMatchObject({ kind, status: null, retryable: true });
    expect(String(failure)).not.toContain("secret-response-value");
    expect(failure).not.toHaveProperty("cause");
  });

  it("rejects an unsafe URL as a deterministic failure before transport", async () => {
    const get = vi.spyOn(axios, "get");

    await expect(
      downloadArchiveBytes({
        descriptor: {
          outputItemId: "output-unsafe",
          url: "http://127.0.0.1/private.zip",
          filename: "company.zip",
          mimeType: "application/zip",
        },
        apiKey: "secret-test-key",
        baseUrl: "https://api.example.test",
      }),
    ).rejects.toMatchObject({
      kind: "unsafe_url",
      status: null,
      retryable: false,
    });
    expect(get).not.toHaveBeenCalled();
  });

  it("classifies an empty successful response as deterministic", async () => {
    vi.spyOn(axios, "get").mockResolvedValue({
      status: 200,
      headers: {},
      data: Readable.from([]),
    });

    await expect(
      downloadArchiveBytes({
        descriptor: {
          outputItemId: "output-empty",
          url: "https://downloads.example.test/company.zip",
          filename: "company.zip",
          mimeType: "application/zip",
        },
        apiKey: "secret-test-key",
        baseUrl: "https://api.example.test",
      }),
    ).rejects.toMatchObject({
      kind: "empty",
      status: null,
      retryable: false,
    });
  });

  it("classifies an oversized declared response as deterministic", async () => {
    const data = Readable.from([]);
    const destroy = vi.spyOn(data, "destroy");
    vi.spyOn(axios, "get").mockResolvedValue({
      status: 200,
      headers: { "content-length": String(250 * 1024 * 1024 + 1) },
      data,
    });

    await expect(
      downloadArchiveBytes({
        descriptor: {
          outputItemId: "output-large",
          url: "https://downloads.example.test/company.zip",
          filename: "company.zip",
          mimeType: "application/zip",
        },
        apiKey: "secret-test-key",
        baseUrl: "https://api.example.test",
      }),
    ).rejects.toMatchObject({
      kind: "too_large",
      status: null,
      retryable: false,
    });
    expect(destroy).toHaveBeenCalled();
  });

  it.each([
    ["size", "local_size_mismatch"],
    ["sha256", "local_sha256_mismatch"],
  ])(
    "classifies a local %s mismatch as deterministic",
    async (corruption, kind) => {
      const assetRoot = await mkdtemp(
        path.join(tmpdir(), "frontmind-dashboard-kb-corrupt-"),
      );
      const previousAssetRoot = process.env.FRONTMIND_DASHBOARD_ASSET_DIR;
      process.env.FRONTMIND_DASHBOARD_ASSET_DIR = assetRoot;
      const fileId = `file-corrupt-${corruption}`;
      const bytes = Buffer.from("durable-local-archive", "utf8");
      try {
        await recordPresalesFileDescriptor({
          fileId,
          filename: "company.zip",
          mimeType: "application/zip",
          sizeBytes: bytes.length,
        });
        const staged = await stagePresalesFileContent({
          fileId,
          stream: Readable.from([bytes]),
          maxBytes: 1024,
        });
        await staged.commit({});
        const storageKey = createHash("sha256")
          .update(fileId, "utf8")
          .digest("hex");
        await writeFile(
          path.join(assetRoot, "presales-files", `${storageKey}.content`),
          corruption === "size"
            ? Buffer.from("short", "utf8")
            : Buffer.alloc(bytes.length, 0x78),
        );

        await expect(
          downloadArchiveBytes({
            descriptor: {
              outputItemId: "output-corrupt",
              fileId,
              filename: "company.zip",
              mimeType: "application/zip",
            },
            apiKey: "secret-test-key",
            baseUrl: "https://api.example.test",
          }),
        ).rejects.toMatchObject({
          kind,
          status: null,
          retryable: false,
        });
      } finally {
        if (previousAssetRoot === undefined) {
          delete process.env.FRONTMIND_DASHBOARD_ASSET_DIR;
        } else {
          process.env.FRONTMIND_DASHBOARD_ASSET_DIR = previousAssetRoot;
        }
        await rm(assetRoot, { recursive: true, force: true });
      }
    },
  );
});
