import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  siteOpsObservationV1Schema,
  siteOpsVisualGenerationProjectionSchema,
  type SiteOpsObservationV1,
} from "@shared/siteops-contract";
import { newestSiteOpsObservation } from "./ConnectedSiteOpsConversationPanel";
import SiteOpsConversationPanel from "./SiteOpsConversationPanel";

type SiteOpsBuildFixture = Omit<
  SiteOpsObservationV1["builds"][number],
  "buildDelivery"
> & {
  buildDelivery?: SiteOpsObservationV1["builds"][number]["buildDelivery"];
};

type SiteOpsObservationFixtureInput = Omit<
  Partial<SiteOpsObservationV1>,
  "builds"
> & {
  builds?: SiteOpsBuildFixture[];
};

function observation(
  input: SiteOpsObservationFixtureInput = {},
): SiteOpsObservationV1 {
  const { builds, ...overrides } = input;
  return {
    schemaVersion: 1,
    executionKind: "site_ops",
    serviceReadiness: {
      visuals: { status: "configured" },
      website: { status: "configured" },
      publishing: { status: "configured" },
      domain: { status: "not_configured" },
    },
    aliyunConnection: {
      configured: false,
      status: "not_connected",
      verifiedAt: null,
      canDisconnect: true,
    },
    domainState: null,
    project: {
      id: "11111111-1111-4111-8111-111111111111",
      conversationId: "siteops:1",
      revision: 3,
      status: "awaiting_visual_selection",
      currentKnowledgeSnapshotId: "22222222-2222-4222-8222-222222222222",
      primaryLanguage: "zh-CN",
      canonicalHostname: null,
      updatedAt: "2026-08-22T00:00:00.000Z",
    },
    brief: null,
    knowledgeSnapshots: [
      {
        id: "22222222-2222-4222-8222-222222222222",
        label: "知识库 ZIP · 第 3 版",
        sourceProfile: "dashboard-core-v1",
        createdAt: "2026-08-22T00:00:00.000Z",
        active: true,
      },
    ],
    messages: [
      {
        id: "message-1",
        role: "assistant",
        content: "已根据知识库准备好 2 个真实视觉候选，请选择一个方向。",
        sequence: 1,
        metadata: {
          siteOps: {
            kind: "visual_board",
            subjectId: "batch-1",
            revision: 3,
            status: "active",
            payload: {},
          },
        },
        sentAt: "2026-08-22T00:00:00.000Z",
      },
    ],
    visualCandidates: [
      {
        id: "candidate-a",
        label: "A",
        title: "克制的编辑式布局",
        previewUrl: "/api/local-assets/preview-a",
        note: "克制的编辑式布局",
        visualFamily: "editorial",
        selected: false,
      },
      {
        id: "candidate-b",
        label: "B",
        title: "精密技术型布局",
        previewUrl: "/api/local-assets/preview-b",
        note: "精密技术型布局",
        visualFamily: "split_media",
        selected: false,
      },
    ],
    visualCandidatePages: [],
    visualGeneration: {
      status: "idle",
      targetPage: null,
      generatedPages: 0,
      availablePages: 3,
      reservedPages: 2,
      maxPages: 3,
      canGenerateMore: true,
      canSelectExisting: true,
    },
    executionSteps: [],
    builds: [],
    deployments: [],
    socialPackages: [],
    rebuildRequest: {
      allowed: false,
      ticketId: null,
      status: null,
      resetApplied: false,
      resetSourceBuildId: null,
    },
    interactionState: "awaiting_visual_selection",
    latestSequence: 1,
    ...overrides,
    ...(builds
      ? {
          builds: builds.map((build) => ({
            buildDelivery: null,
            ...build,
          })),
        }
      : {}),
  };
}

function visualPage(page: 1 | 2 | 3) {
  return {
    batchId: `batch-${page}`,
    page,
    candidates: Array.from({ length: 9 }, (_, index) => {
      const letter = String.fromCharCode(65 + index);
      return {
        id: `candidate-${page}-${letter}`,
        label: `P${page}-${letter}`,
        title: `第 ${page} 组 ${letter}`,
        previewUrl: `/api/local-assets/page-${page}-${letter}`,
        note: null,
        visualFamily: null,
        selected: false,
      };
    }),
  } as const;
}

function staticCatalogPage(page: 1 | 2 | 3 | 4) {
  return {
    batchId: `static-catalog-page-${page}`,
    page,
    candidates: Array.from({ length: 8 }, (_, index) => {
      const letter = String.fromCharCode(65 + index);
      return {
        id: `static-candidate-${page}-${letter}`,
        label: letter,
        title: `固定目录第 ${page} 页 ${letter}`,
        previewUrl: `/api/site-ops/style-previews/static-${page}-${letter}`,
        note: null,
        visualFamily: null,
        selected: false,
      };
    }),
  } as const;
}

describe("SiteOpsConversationPanel", () => {
  it("renders one accessible workspace title without the removed stage strip", () => {
    render(<SiteOpsConversationPanel observation={observation()} />);

    const titles = screen.getAllByRole("heading", {
      name: "AI友好官网管理",
    });
    expect(titles).toHaveLength(1);
    expect(titles[0]?.tagName).toBe("H2");
    expect(document.querySelector(".siteops-panel-header p")).toBeNull();
    expect(screen.queryByText("当前阶段")).not.toBeInTheDocument();
  });

  it("defaults legacy visual generation observations to the idle selectable state", () => {
    expect(
      siteOpsVisualGenerationProjectionSchema.parse({
        generatedPages: 1,
        maxPages: 3,
        canGenerateMore: true,
      }),
    ).toEqual({
      status: "idle",
      targetPage: null,
      generatedPages: 1,
      maxPages: 3,
      canGenerateMore: true,
      canSelectExisting: true,
    });
  });

  it("uses the concise static catalog entry label", () => {
    render(
      <SiteOpsConversationPanel
        observation={observation({
          serviceReadiness: {
            visuals: { status: "not_configured" },
            website: { status: "configured" },
            publishing: { status: "configured" },
            domain: { status: "not_configured" },
          },
          project: {
            ...observation().project,
            status: "collecting_brief",
          },
          interactionState: "collecting_brief",
          visualCandidates: [],
          visualCandidatePages: [],
          visualGeneration: {
            status: "idle",
            targetPage: null,
            generatedPages: 0,
            availablePages: 4,
            reservedPages: 0,
            maxPages: 4,
            canGenerateMore: false,
            canSelectExisting: false,
            retryAction: null,
            failureCategory: null,
            workflowVersion: "2.8.0",
            catalogVersion: "twenty-first-static-32-v1",
            pageSize: 8,
            pageCount: 4,
          },
        })}
        onAction={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: "查看建站模板" })).toBeEnabled();
    expect(screen.queryByText(/视觉参考服务尚未配置/u)).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /查看 32 个 Template/u }),
    ).not.toBeInTheDocument();
  });

  it("accepts the public retry action and compatible visual failure categories", () => {
    expect(
      siteOpsVisualGenerationProjectionSchema.parse({
        status: "retryable_error",
        targetPage: null,
        generatedPages: 0,
        maxPages: 3,
        canGenerateMore: true,
        canSelectExisting: false,
        retryAction: "start",
        failureCategory: "compile_failed",
      }),
    ).toMatchObject({
      retryAction: "start",
      failureCategory: "compile_failed",
    });

    expect(
      siteOpsVisualGenerationProjectionSchema.parse({
        status: "retryable_error",
        targetPage: null,
        generatedPages: 0,
        maxPages: 3,
        canGenerateMore: true,
        canSelectExisting: false,
        retryAction: "start",
        failureCategory: "catalog_unavailable",
      }),
    ).toMatchObject({
      retryAction: "start",
      failureCategory: "catalog_unavailable",
    });

    expect(
      siteOpsVisualGenerationProjectionSchema.parse({
        status: "retryable_error",
        targetPage: null,
        generatedPages: 0,
        maxPages: 3,
        canGenerateMore: true,
        canSelectExisting: false,
        retryAction: "start",
        failureCategory: "source_incomplete",
      }),
    ).toMatchObject({ failureCategory: "source_incomplete" });

    expect(
      siteOpsVisualGenerationProjectionSchema.parse({
        status: "retryable_error",
        targetPage: null,
        generatedPages: 0,
        maxPages: 4,
        canGenerateMore: false,
        canSelectExisting: false,
        retryAction: "start",
        failureCategory: "persistence_failed",
      }),
    ).toMatchObject({ failureCategory: "persistence_failed" });
  });

  it("binds visual page cardinality to the projected workflow version", () => {
    const legacyPage = visualPage(1);
    const catalogPage = staticCatalogPage(1);
    const legacyObservation = observation({
      visualCandidatePages: [
        {
          ...legacyPage,
          batchId: "00000000-0000-4000-8000-000000000091",
          candidates: legacyPage.candidates.map((candidate, index) => ({
            ...candidate,
            label: String.fromCharCode(65 + index),
          })),
        },
      ],
    });
    const catalogObservation = observation({
      visualCandidatePages: [
        {
          ...catalogPage,
          batchId: "00000000-0000-4000-8000-000000000081",
          candidates: catalogPage.candidates.slice(),
        },
      ],
      visualGeneration: {
        status: "idle",
        targetPage: null,
        generatedPages: 1,
        availablePages: 4,
        reservedPages: 0,
        maxPages: 4,
        workflowVersion: "2.8.0",
        catalogVersion: "twenty-first-static-32-v1",
        pageSize: 8,
        pageCount: 4,
        canGenerateMore: false,
        canSelectExisting: true,
      },
    });

    const parsedLegacy =
      siteOpsObservationV1Schema.safeParse(legacyObservation);
    const parsedCatalog =
      siteOpsObservationV1Schema.safeParse(catalogObservation);
    expect(
      parsedLegacy.success,
      parsedLegacy.success ? "" : JSON.stringify(parsedLegacy.error.issues),
    ).toBe(true);
    expect(
      parsedCatalog.success,
      parsedCatalog.success ? "" : JSON.stringify(parsedCatalog.error.issues),
    ).toBe(true);
    expect(
      siteOpsObservationV1Schema.safeParse({
        ...catalogObservation,
        visualCandidatePages: legacyObservation.visualCandidatePages,
      }).success,
    ).toBe(false);
    expect(
      siteOpsObservationV1Schema.safeParse({
        ...legacyObservation,
        visualCandidatePages: catalogObservation.visualCandidatePages,
      }).success,
    ).toBe(false);
  });

  it("accepts observations monotonically by project revision then message sequence", () => {
    const current = observation({
      project: { ...observation().project, revision: 5 },
      latestSequence: 10,
    });
    const olderRevision = observation({
      project: { ...observation().project, revision: 4 },
      latestSequence: 100,
    });
    const olderSequence = observation({
      project: { ...observation().project, revision: 5 },
      latestSequence: 9,
    });
    const equalCursor = observation({
      project: { ...observation().project, revision: 5 },
      latestSequence: 10,
      interactionState: "failed",
    });
    const newerRevision = observation({
      project: { ...observation().project, revision: 6 },
      latestSequence: 1,
    });

    expect(newestSiteOpsObservation(current, olderRevision)).toBe(current);
    expect(newestSiteOpsObservation(current, olderSequence)).toBe(current);
    expect(newestSiteOpsObservation(current, equalCursor)).toBe(current);
    expect(newestSiteOpsObservation(current, newerRevision)).toBe(
      newerRevision,
    );
  });

  it("accepts only the terminal visual transition at an equal project and message cursor", () => {
    const generating = observation({
      project: { ...observation().project, revision: 5 },
      latestSequence: 10,
      visualGeneration: {
        status: "generating",
        targetPage: 2,
        generatedPages: 1,
        maxPages: 3,
        canGenerateMore: false,
        canSelectExisting: false,
      },
    });
    const finalized = observation({
      project: { ...observation().project, revision: 5 },
      latestSequence: 10,
      visualGeneration: {
        status: "idle",
        targetPage: null,
        generatedPages: 2,
        maxPages: 3,
        canGenerateMore: true,
        canSelectExisting: true,
      },
    });

    expect(newestSiteOpsObservation(generating, finalized)).toBe(finalized);
    expect(newestSiteOpsObservation(finalized, generating)).toBe(finalized);
  });

  it("uses structured workflow actions without a persistent conversation composer", () => {
    render(
      <SiteOpsConversationPanel
        observation={observation()}
        onAction={vi.fn()}
      />,
    );

    expect(screen.queryByText("继续对话")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("textbox", { name: "继续对话" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /^发送$/u }),
    ).not.toBeInTheDocument();
  });

  it("does not surface the cancelled failed build after a confirmed reset", () => {
    render(
      <SiteOpsConversationPanel
        observation={observation({
          project: {
            ...observation().project,
            status: "draft",
            currentKnowledgeSnapshotId: null,
          },
          interactionState: "select_snapshot",
          visualCandidates: [],
          builds: [
            {
              id: "33333333-3333-4333-8333-333333333333",
              ordinal: 1,
              parentBuildId: null,
              status: "cancelled",
              previewUrl: null,
              sourceUrl: null,
              needsHelp: true,
              createdAt: "2026-08-22T00:00:00.000Z",
              updatedAt: "2026-08-22T00:01:00.000Z",
            },
          ],
        })}
      />,
    );
    expect(screen.queryByText(/官网版本 1/u)).toBeNull();
  });

  it("requires confirmation before submitting a fresh-root reset request", async () => {
    const onAction = vi.fn().mockResolvedValue(undefined);
    render(
      <SiteOpsConversationPanel
        observation={observation({
          rebuildRequest: {
            allowed: true,
            ticketId: null,
            status: null,
            resetApplied: false,
            resetSourceBuildId: null,
          },
        })}
        onAction={onAction}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "申请重置并全新开始" }));
    expect(
      screen.getByRole("alertdialog", { name: "申请重置并全新开始" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("批准后，当前线上官网会进入下线流程。"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("当前企业知识库会保留，并作为全新建站的资料来源。"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("旧视觉方案和生成任务不会继续使用。"),
    ).toBeInTheDocument();
    expect(onAction).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    await waitFor(() =>
      expect(
        screen.queryByRole("alertdialog", {
          name: "申请重置并全新开始",
        }),
      ).not.toBeInTheDocument(),
    );
    expect(onAction).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "申请重置并全新开始" }));
    fireEvent.click(screen.getByRole("button", { name: "提交重置申请" }));
    await waitFor(() =>
      expect(onAction).toHaveBeenCalledWith({
        action: "request_rebuild",
        input: {},
      }),
    );
    await waitFor(() =>
      expect(
        screen.queryByRole("alertdialog", {
          name: "申请重置并全新开始",
        }),
      ).not.toBeInTheDocument(),
    );
  });

  it("keeps a pending reset request visible and disabled", () => {
    render(
      <SiteOpsConversationPanel
        observation={observation({
          rebuildRequest: {
            allowed: false,
            ticketId: "77777777-7777-4777-8777-777777777777",
            status: "submitted",
            resetApplied: false,
            resetSourceBuildId: null,
          },
        })}
        onAction={vi.fn()}
      />,
    );

    expect(
      screen.getByRole("button", { name: "重置申请处理中" }),
    ).toBeDisabled();
    expect(screen.queryByText("高级选项")).not.toBeInTheDocument();
  });

  it("keeps the fresh local build action enabled while old external cleanup is pending", () => {
    render(
      <SiteOpsConversationPanel
        observation={observation({
          project: {
            ...observation().project,
            status: "draft",
          },
          interactionState: "select_snapshot",
          rebuildRequest: {
            allowed: false,
            ticketId: "77777777-7777-4777-8777-777777777777",
            status: "in_progress",
            resetApplied: true,
            resetPending: true,
            resetSourceBuildId: "33333333-3333-4333-8333-333333333333",
          },
        })}
        onAction={vi.fn()}
      />,
    );

    expect(
      screen.getByRole("button", { name: "从知识库开始建站" }),
    ).toBeEnabled();
    expect(
      screen.getByRole("button", { name: "正在下线旧官网" }),
    ).toBeDisabled();
  });

  it("sanitizes technical reset request failures", async () => {
    const onAction = vi
      .fn()
      .mockRejectedValue(
        new Error(
          "canonical hostname 的 RAM Role 与 global_excluding_cn 归档哈希不一致",
        ),
      );
    render(
      <SiteOpsConversationPanel
        observation={observation({
          rebuildRequest: {
            allowed: true,
            ticketId: null,
            status: null,
            resetApplied: false,
            resetSourceBuildId: null,
          },
        })}
        onAction={onAction}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "申请重置并全新开始" }));
    fireEvent.click(screen.getByRole("button", { name: "提交重置申请" }));
    await waitFor(() =>
      expect(
        screen.getAllByText(
          "FrontMind 正在处理当前任务；如长时间未完成，请提交工单获取协助。",
        ).length,
      ).toBeGreaterThan(0),
    );
    expect(document.body.textContent).not.toMatch(
      /canonical hostname|RAM Role|global_excluding_cn|归档哈希/iu,
    );
  });

  it("hides internal error codes and operation ids from customers", () => {
    render(
      <SiteOpsConversationPanel
        observation={observation({
          project: {
            ...observation().project,
            status: "failed",
          },
          interactionState: "failed",
          messages: [
            {
              id: "message-recovery",
              role: "assistant",
              content: "视觉检索任务合同不一致，请重置后重新开始。",
              sequence: 2,
              metadata: {
                siteOps: {
                  kind: "qa_failed",
                  subjectId: "operation-safe-id",
                  revision: 3,
                  status: "active",
                  payload: {
                    errorCode: "VISUAL_OPERATION_CONTRACT_MISMATCH",
                  },
                },
              },
              sentAt: "2026-08-22T00:01:00.000Z",
            },
          ],
          visualCandidates: [],
        })}
      />,
    );

    expect(
      screen.queryByText(/VISUAL_OPERATION_CONTRACT_MISMATCH/u),
    ).toBeNull();
    expect(screen.queryByText(/operation-safe-id/u)).toBeNull();
  });

  it("shows customer-facing visual candidates and submits only the selection", async () => {
    const onAction = vi.fn().mockResolvedValue(undefined);
    render(
      <SiteOpsConversationPanel
        observation={observation()}
        onAction={onAction}
      />,
    );

    expect(
      screen.getByRole("heading", { name: "AI友好官网管理" }),
    ).toBeInTheDocument();
    expect(screen.getByAltText("A：编辑杂志式")).toHaveAttribute(
      "src",
      "/api/local-assets/preview-a",
    );
    expect(screen.getByText("首页 · 编辑杂志式")).toBeInTheDocument();
    expect(screen.queryByText(/匹配度/u)).toBeNull();
    expect(
      screen.getByRole("heading", { name: "9 个视觉候选" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/示例图片与文案不会复制到官网/u),
    ).toBeInTheDocument();
    expect(screen.queryByText(/相同的企业资料真实渲染/u)).toBeNull();
    expect(document.body.textContent).not.toMatch(/API Key|Base|Pro|Hero/iu);
    const regenerateButton = screen.getByRole("button", {
      name: "显示下一组 9 个视觉候选",
    });
    expect(regenerateButton).toHaveClass("siteops-primary-button");
    expect(regenerateButton).not.toHaveClass("siteops-secondary-button");
    expect(
      screen.queryByRole("button", { name: "让 FrontMind 推荐" }),
    ).not.toBeInTheDocument();
    fireEvent.click(regenerateButton);
    await waitFor(() =>
      expect(onAction).toHaveBeenCalledWith({
        action: "reselect_visual",
        input: {},
        messageId: "message-1",
        cardKind: "visual_board",
      }),
    );
    onAction.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "选择 B" }));
    await waitFor(() =>
      expect(onAction).toHaveBeenCalledWith({
        action: "select_visual",
        input: { sampleId: "candidate-b" },
        messageId: "message-1",
        cardKind: "visual_board",
      }),
    );
  });

  it("keeps three complete visual pages navigable and allows a choice from any page", async () => {
    const onAction = vi.fn().mockResolvedValue(undefined);
    const pages = [visualPage(1), visualPage(2), visualPage(3)];
    render(
      <SiteOpsConversationPanel
        observation={observation({
          visualCandidates: pages[2].candidates.slice(),
          visualCandidatePages: pages.map((page) => ({
            ...page,
            candidates: page.candidates.slice(),
          })),
          visualGeneration: {
            status: "idle",
            targetPage: null,
            generatedPages: 3,
            availablePages: 3,
            reservedPages: 0,
            maxPages: 3,
            canGenerateMore: false,
            canSelectExisting: true,
          },
        })}
        onAction={onAction}
      />,
    );

    expect(
      screen.getByRole("heading", { name: "27 个视觉候选" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "已冻结全部 27 个候选" }),
    ).toBeDisabled();
    expect(screen.getByText("27 选 1")).toBeInTheDocument();
    expect(screen.getByAltText("P3-A：第 3 组 A")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "第 1 组" }));
    expect(screen.getByAltText("P1-A：第 1 组 A")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "选择 P1-A" }));
    await waitFor(() =>
      expect(onAction).toHaveBeenCalledWith({
        action: "select_visual",
        input: { sampleId: "candidate-1-A" },
        messageId: "message-1",
        cardKind: "visual_board",
      }),
    );
  });

  it("routes the exact page-one and page-four F samples from the fixed 32-template catalog", async () => {
    const onAction = vi.fn().mockResolvedValue(undefined);
    const pages = [
      staticCatalogPage(1),
      staticCatalogPage(2),
      staticCatalogPage(3),
      staticCatalogPage(4),
    ];
    const { container } = render(
      <SiteOpsConversationPanel
        observation={observation({
          visualCandidates: pages[0].candidates.slice(),
          visualCandidatePages: pages.map((page) => ({
            ...page,
            candidates: page.candidates.slice(),
          })),
          visualGeneration: {
            status: "idle",
            targetPage: null,
            generatedPages: 4,
            availablePages: 4,
            reservedPages: 0,
            maxPages: 4,
            canGenerateMore: false,
            canSelectExisting: true,
            workflowVersion: "2.8.0",
            catalogVersion: "twenty-first-static-32-v1",
            pageSize: 8,
            pageCount: 4,
          },
        })}
        onAction={onAction}
      />,
    );

    expect(
      screen.getByRole("heading", { name: "32 个 Template 候选" }),
    ).toBeInTheDocument();
    expect(screen.getByText("第 1 / 4 页 · 共 32 个")).toBeInTheDocument();
    expect(screen.getByAltText("A：固定目录第 1 页 A")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "显示下一组 9 个视觉候选" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /获取并冻结下一组/u }),
    ).not.toBeInTheDocument();
    expect(
      container.querySelector(
        '.siteops-visual-grid[data-catalog-layout="static-32"]',
      ),
    ).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "选择 F" }));
    await waitFor(() =>
      expect(onAction).toHaveBeenCalledWith({
        action: "select_visual",
        input: { sampleId: "static-candidate-1-F" },
        messageId: "message-1",
        cardKind: "visual_board",
      }),
    );
    onAction.mockClear();

    fireEvent.click(screen.getByRole("button", { name: "第 4 页" }));
    expect(screen.getByAltText("A：固定目录第 4 页 A")).toBeInTheDocument();
    expect(screen.getByText("第 4 / 4 页 · 共 32 个")).toBeInTheDocument();
    expect(onAction).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "选择 F" }));
    await waitFor(() =>
      expect(onAction).toHaveBeenCalledWith({
        action: "select_visual",
        input: { sampleId: "static-candidate-4-F" },
        messageId: "message-1",
        cardKind: "visual_board",
      }),
    );
  });

  it("keeps an unadmitted catalog template visible while disabling selection with its reason", () => {
    const onAction = vi.fn();
    const page = staticCatalogPage(1);
    const unavailableReason =
      "该模板尚未完成 FrontMind 受控 Vite 构建与浏览器验收，当前不可选择。";
    const candidates = page.candidates.map((candidate, index) =>
      index === 0
        ? {
            ...candidate,
            executionAdmitted: false,
            executionUnavailableReason: unavailableReason,
          }
        : candidate,
    );
    render(
      <SiteOpsConversationPanel
        observation={observation({
          visualCandidates: candidates,
          visualCandidatePages: [{ ...page, candidates }],
          visualGeneration: {
            status: "idle",
            targetPage: null,
            generatedPages: 4,
            availablePages: 4,
            reservedPages: 0,
            maxPages: 4,
            canGenerateMore: false,
            canSelectExisting: true,
            workflowVersion: "2.8.0",
            catalogVersion: "21st-included-recommended-20260828-v2",
            pageSize: 8,
            pageCount: 4,
          },
        })}
        onAction={onAction}
      />,
    );

    expect(screen.getByText(unavailableReason)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "暂不可选择" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "暂不可选择" }));
    expect(onAction).not.toHaveBeenCalled();
  });

  it("locks every template choice around the selected item and renders an adjacent explicit retry", async () => {
    const pages = [
      staticCatalogPage(1),
      staticCatalogPage(2),
      staticCatalogPage(3),
      staticCatalogPage(4),
    ];
    const currentObservation = observation({
      visualCandidates: pages[0].candidates.slice(),
      visualCandidatePages: pages.map((page) => ({
        ...page,
        candidates: page.candidates.slice(),
      })),
      visualGeneration: {
        status: "idle",
        targetPage: null,
        generatedPages: 4,
        availablePages: 4,
        reservedPages: 0,
        maxPages: 4,
        canGenerateMore: false,
        canSelectExisting: true,
        workflowVersion: "2.8.0",
        catalogVersion: "twenty-first-static-32-v1",
        pageSize: 8,
        pageCount: 4,
      },
    });
    const onRetrySelectVisual = vi.fn().mockResolvedValue(undefined);
    const { rerender } = render(
      <SiteOpsConversationPanel
        observation={currentObservation}
        onAction={vi.fn()}
        onRetrySelectVisual={onRetrySelectVisual}
        selectVisual={{
          sampleId: "static-candidate-1-F",
          label: "F",
          clientRequestId: "11111111-1111-4111-8111-111111111111",
          phase: "observing",
          ack: {
            schemaVersion: 1,
            accepted: true,
            clientRequestId: "11111111-1111-4111-8111-111111111111",
            operationId: "22222222-2222-4222-8222-222222222222",
            projectRevision: 4,
            latestSequence: 3,
            interactionState: "building",
          },
        }}
      />,
    );

    expect(screen.getByRole("button", { name: "正在选择 F" })).toBeDisabled();
    expect(
      screen
        .getAllByRole("button", { name: /^选择 [A-H]$/u })
        .every((button) => button.hasAttribute("disabled")),
    ).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "第 4 页" }));
    const fourthPageButtons = screen.getAllByRole("button", {
      name: /^选择 [A-H]$/u,
    });
    expect(fourthPageButtons).toHaveLength(8);
    expect(
      fourthPageButtons.every((button) => button.hasAttribute("disabled")),
    ).toBe(true);

    rerender(
      <SiteOpsConversationPanel
        observation={currentObservation}
        onAction={vi.fn()}
        onRetrySelectVisual={onRetrySelectVisual}
        selectVisual={{
          sampleId: "static-candidate-1-F",
          label: "F",
          clientRequestId: "11111111-1111-4111-8111-111111111111",
          phase: "failed",
          ack: null,
        }}
      />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent(
      "建站任务未能创建，所选模板尚未生效。无需重新载入模板，请重试选择 F。",
    );
    fireEvent.click(screen.getByRole("button", { name: "第 1 页" }));
    expect(screen.getByRole("button", { name: "选择 F" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "选择 G" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "重试选择 F" }));
    await waitFor(() => expect(onRetrySelectVisual).toHaveBeenCalledOnce());
  });

  it.each([
    { pageCount: 1 as const, candidateCount: 9 },
    { pageCount: 2 as const, candidateCount: 18 },
  ])(
    "does not promise an unfrozen future page when only $candidateCount candidates exist",
    ({ pageCount, candidateCount }) => {
      const pages = [visualPage(1), visualPage(2)].slice(0, pageCount);
      render(
        <SiteOpsConversationPanel
          observation={observation({
            visualCandidates: pages[pages.length - 1]!.candidates.slice(),
            visualCandidatePages: pages.map((page) => ({
              ...page,
              candidates: page.candidates.slice(),
            })),
            visualGeneration: {
              status: "idle",
              targetPage: null,
              generatedPages: pageCount,
              availablePages: pageCount,
              reservedPages: 0,
              maxPages: 3,
              canGenerateMore: false,
              canSelectExisting: true,
            },
          })}
          onAction={vi.fn()}
        />,
      );

      expect(
        screen.getByRole("button", {
          name: `已冻结全部 ${candidateCount} 个候选`,
        }),
      ).toBeDisabled();
      expect(screen.getByText(`${candidateCount} 选 1`)).toBeInTheDocument();
      expect(screen.queryByText(/27 选 1/u)).toBeNull();
    },
  );

  it("keeps existing visual pages visible but locked while a supplemental page generates", () => {
    const page = visualPage(1);
    const progressMessage = {
      id: "visual-progress-2",
      role: "assistant" as const,
      content: "正在生成第 2 组全新视觉候选；前面展示过的参考不会重复。",
      sequence: 2,
      metadata: {
        siteOps: {
          kind: "build_progress" as const,
          subjectId: "visual-operation-2",
          revision: 3,
          status: "active" as const,
          payload: { stage: "visual_searching" },
        },
      },
      sentAt: "2026-08-22T00:01:00.000Z",
    };

    render(
      <SiteOpsConversationPanel
        observation={observation({
          messages: [...observation().messages, progressMessage],
          visualCandidates: page.candidates.slice(),
          visualCandidatePages: [
            { ...page, candidates: page.candidates.slice() },
          ],
          visualGeneration: {
            status: "generating",
            targetPage: 2,
            generatedPages: 1,
            maxPages: 3,
            canGenerateMore: true,
            canSelectExisting: false,
          },
        })}
        onAction={vi.fn()}
      />,
    );

    expect(
      screen.getByRole("heading", { name: "9 个视觉候选" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "第 1 组" })).toBeEnabled();
    expect(screen.getByAltText("P1-A：第 1 组 A")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "选择 P1-A" })).toBeDisabled();
    const generatingButton = screen.getByRole("button", {
      name: "正在生成第 2 组",
    });
    expect(generatingButton).toBeDisabled();
    expect(generatingButton.querySelector(".siteops-spin")).not.toBeNull();
    expect(screen.getByText(progressMessage.content)).toBeInTheDocument();
  });

  it("unlocks existing candidates after a retryable supplemental failure and hides stale progress", () => {
    const page = visualPage(1);
    const progressMessage = {
      id: "visual-progress-failed",
      role: "assistant" as const,
      content: "正在生成第 2 组全新视觉候选；前面展示过的参考不会重复。",
      sequence: 2,
      metadata: {
        siteOps: {
          kind: "build_progress" as const,
          subjectId: "visual-operation-failed",
          revision: 3,
          status: "active" as const,
          payload: { stage: "visual_searching" },
        },
      },
      sentAt: "2026-08-22T00:01:00.000Z",
    };

    render(
      <SiteOpsConversationPanel
        observation={observation({
          messages: [...observation().messages, progressMessage],
          visualCandidates: page.candidates.slice(),
          visualCandidatePages: [
            { ...page, candidates: page.candidates.slice() },
          ],
          visualGeneration: {
            status: "retryable_error",
            targetPage: null,
            generatedPages: 1,
            maxPages: 3,
            canGenerateMore: true,
            canSelectExisting: true,
          },
        })}
        onAction={vi.fn()}
      />,
    );

    expect(screen.queryByText(progressMessage.content)).toBeNull();
    expect(screen.getByRole("alert").textContent).toContain(
      "本次未能生成完整的新一组",
    );
    expect(screen.getByRole("button", { name: "选择 P1-A" })).toBeEnabled();
    expect(
      screen.getByRole("button", { name: "获取并冻结下一组视觉候选" }),
    ).toBeEnabled();
  });

  it("retries a terminal first-page visual failure without resetting the project", async () => {
    const onAction = vi.fn().mockResolvedValue(undefined);
    const progressMessage = {
      id: "visual-progress-first-failed",
      role: "assistant" as const,
      content: "正在生成 9 个视觉候选，完成后会一次展示。",
      sequence: 2,
      metadata: {
        siteOps: {
          kind: "build_progress" as const,
          subjectId: "visual-operation-first-failed",
          revision: 3,
          status: "active" as const,
          payload: { stage: "visual_searching" },
        },
      },
      sentAt: "2026-08-22T00:01:00.000Z",
    };

    render(
      <SiteOpsConversationPanel
        observation={observation({
          project: {
            ...observation().project,
            status: "attention_required",
          },
          interactionState: "attention_required",
          messages: [...observation().messages, progressMessage],
          visualCandidates: [],
          visualCandidatePages: [],
          visualGeneration: {
            status: "retryable_error",
            targetPage: null,
            generatedPages: 0,
            maxPages: 3,
            canGenerateMore: true,
            canSelectExisting: false,
            retryAction: "start",
            failureCategory: "insufficient_live_templates",
          },
        })}
        onAction={onAction}
      />,
    );

    expect(screen.queryByText(progressMessage.content)).toBeNull();
    expect(
      screen.getByRole("heading", { name: "视觉候选生成未完成" }),
    ).toBeInTheDocument();
    expect(screen.getByText(/无需重置/u)).toBeInTheDocument();
    expect(
      screen.getByText(/未能凑齐 9 个互不重复的完整官网源码模板/u),
    ).toBeInTheDocument();
    const retryButton = screen.getByRole("button", {
      name: "重新生成 9 个视觉候选",
    });
    expect(retryButton).toHaveClass("siteops-primary-button");
    expect(retryButton).toBeEnabled();
    fireEvent.click(retryButton);
    await waitFor(() =>
      expect(onAction).toHaveBeenCalledWith({
        action: "reselect_visual",
        input: {},
      }),
    );
  });

  it("surfaces a 2.8 local catalog failure with a local-only retry", async () => {
    const onAction = vi.fn().mockResolvedValue(undefined);
    render(
      <SiteOpsConversationPanel
        observation={observation({
          project: {
            ...observation().project,
            status: "attention_required",
          },
          interactionState: "attention_required",
          visualCandidates: [],
          visualCandidatePages: [],
          visualGeneration: {
            status: "retryable_error",
            targetPage: null,
            generatedPages: 0,
            availablePages: 0,
            reservedPages: 0,
            maxPages: 4,
            canGenerateMore: false,
            canSelectExisting: false,
            retryAction: "supplemental",
            failureCategory: "catalog_unavailable",
            workflowVersion: "2.8.0",
            catalogVersion: "twenty-first-static-32-v1",
            pageSize: 8,
            pageCount: 4,
          },
          rebuildRequest: {
            allowed: true,
            ticketId: null,
            status: null,
            resetApplied: false,
            resetSourceBuildId: null,
          },
        })}
        onAction={onAction}
      />,
    );

    expect(
      screen.getByRole("heading", {
        name: "建站模板目录暂时不可用",
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/本地资产尚未就绪或未通过完整性校验/u),
    ).toBeInTheDocument();
    expect(screen.getByText(/刷新页面只会更新当前状态/u)).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /重新生成 9 个/u }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /下一组 9 个/u }),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "重新载入建站模板" }));
    await waitFor(() =>
      expect(onAction).toHaveBeenCalledWith({
        action: "reselect_visual",
        input: {},
      }),
    );
  });

  it("labels a 2.8 persistence failure without blaming local catalog assets", async () => {
    const onAction = vi.fn().mockResolvedValue(undefined);
    render(
      <SiteOpsConversationPanel
        observation={observation({
          project: {
            ...observation().project,
            status: "attention_required",
          },
          interactionState: "attention_required",
          visualCandidates: [],
          visualCandidatePages: [],
          visualGeneration: {
            status: "retryable_error",
            targetPage: null,
            generatedPages: 0,
            availablePages: 0,
            reservedPages: 0,
            maxPages: 4,
            canGenerateMore: false,
            canSelectExisting: false,
            retryAction: "start",
            failureCategory: "persistence_failed",
            workflowVersion: "2.8.0",
            catalogVersion: "twenty-first-static-32-v1",
            pageSize: 8,
            pageCount: 4,
          },
        })}
        onAction={onAction}
      />,
    );

    expect(
      screen.getByRole("heading", { name: "建站模板列表保存失败" }),
    ).toBeInTheDocument();
    expect(screen.getByText(/建站模板资产已经就绪/u)).toBeInTheDocument();
    expect(screen.getByText(/无需重置知识库/u)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "重新载入建站模板" }));
    await waitFor(() =>
      expect(onAction).toHaveBeenCalledWith({
        action: "reselect_visual",
        input: {},
      }),
    );
  });

  it("switches to a newly completed visual page and unlocks its candidates", () => {
    const first = visualPage(1);
    const second = visualPage(2);
    const { rerender } = render(
      <SiteOpsConversationPanel
        observation={observation({
          visualCandidates: first.candidates.slice(),
          visualCandidatePages: [
            { ...first, candidates: first.candidates.slice() },
          ],
          visualGeneration: {
            status: "generating",
            targetPage: 2,
            generatedPages: 1,
            maxPages: 3,
            canGenerateMore: true,
            canSelectExisting: false,
          },
        })}
        onAction={vi.fn()}
      />,
    );

    rerender(
      <SiteOpsConversationPanel
        observation={observation({
          project: { ...observation().project, revision: 4 },
          visualCandidates: second.candidates.slice(),
          visualCandidatePages: [
            { ...first, candidates: first.candidates.slice() },
            { ...second, candidates: second.candidates.slice() },
          ],
          visualGeneration: {
            status: "idle",
            targetPage: null,
            generatedPages: 2,
            maxPages: 3,
            canGenerateMore: true,
            canSelectExisting: true,
          },
        })}
        onAction={vi.fn()}
      />,
    );

    expect(screen.getByAltText("P2-A：第 2 组 A")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "选择 P2-A" })).toBeEnabled();
  });

  it("renders Markdown messages with timestamps and freezes completed stage durations", () => {
    render(
      <SiteOpsConversationPanel
        observation={observation({
          messages: [
            {
              id: "markdown-message",
              role: "assistant",
              content: "已完成 **质量校验**。",
              sequence: 2,
              metadata: null,
              sentAt: "2026-08-22T00:01:05.000Z",
            },
          ],
          executionSteps: [
            {
              id: "build-operation:qa_running",
              operationKind: "site_build",
              buildId: "33333333-3333-4333-8333-333333333333",
              stage: "qa_running",
              label: "质量校验",
              status: "succeeded",
              startedAt: "2026-08-22T00:00:00.000Z",
              completedAt: "2026-08-22T00:01:05.000Z",
            },
          ],
        })}
      />,
    );

    expect(
      document.querySelector(".siteops-message-markdown strong"),
    ).toHaveTextContent("质量校验");
    expect(
      screen.getByRole("button", { name: "复制消息" }),
    ).toBeInTheDocument();
    expect(screen.getByText("1 分 5 秒")).toBeInTheDocument();
    expect(screen.getByText("08/22 08:00")).toBeInTheDocument();
    expect(screen.getByText("08/22 08:01")).toBeInTheDocument();
    expect(
      document.querySelector(".siteops-message-footer time"),
    ).toHaveAttribute("datetime", "2026-08-22T00:01:05.000Z");
    expect(
      document.querySelector(".siteops-execution-timeline time"),
    ).toHaveAttribute("datetime", "2026-08-22T00:00:00.000Z");
  });

  it("updates a running stage timer every second", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-08-22T00:00:05.000Z"));
      render(
        <SiteOpsConversationPanel
          observation={observation({
            executionSteps: [
              {
                id: "build-operation:design_compiling",
                operationKind: "site_build",
                buildId: "33333333-3333-4333-8333-333333333333",
                stage: "design_compiling",
                label: "设计合同生成",
                status: "running",
                startedAt: "2026-08-22T00:00:00.000Z",
                completedAt: null,
              },
            ],
          })}
        />,
      );
      expect(screen.getByText("5 秒")).toBeInTheDocument();
      act(() => vi.advanceTimersByTime(1_000));
      expect(screen.getByText("6 秒")).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not attach a stale action card after the worker advances revision", async () => {
    const onAction = vi.fn().mockResolvedValue(undefined);
    const stale = observation();
    stale.messages[0]!.metadata!.siteOps!.revision = 2;
    render(
      <SiteOpsConversationPanel observation={stale} onAction={onAction} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "选择 A" }));
    await waitFor(() =>
      expect(onAction).toHaveBeenCalledWith({
        action: "select_visual",
        input: { sampleId: "candidate-a" },
      }),
    );
  });

  it("keeps a completed visual board read-only while a build is running", () => {
    render(
      <SiteOpsConversationPanel
        observation={observation({
          project: { ...observation().project, status: "building" },
          interactionState: "building",
        })}
        onAction={vi.fn()}
      />,
    );

    expect(
      screen.getByRole("heading", { name: "已选择的视觉方案" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "选择 A" })).toBeDisabled();
    expect(
      screen.queryByRole("button", { name: "让 FrontMind 推荐" }),
    ).toBeNull();
    expect(document.body.textContent).not.toMatch(
      /已随官网版本锁定|Base|Pro/iu,
    );
  });

  it("does not expose a build-frozen AI mode after refresh", () => {
    render(
      <SiteOpsConversationPanel
        observation={observation({
          project: { ...observation().project, status: "building" },
          interactionState: "building",
          builds: [
            {
              id: "33333333-3333-4333-8333-333333333333",
              ordinal: 1,
              parentBuildId: null,
              status: "building",
              previewUrl: null,
              sourceUrl: null,
              needsHelp: false,
              createdAt: "2026-08-22T00:00:00.000Z",
              updatedAt: "2026-08-22T00:01:00.000Z",
            },
          ],
        })}
        onAction={vi.fn()}
      />,
    );

    expect(document.body.textContent).not.toMatch(/API Key|Base|Pro/iu);
  });

  it("uses a customer-safe service message when building is not configured", () => {
    render(
      <SiteOpsConversationPanel
        observation={observation({
          serviceReadiness: {
            ...observation().serviceReadiness,
            website: {
              status: "not_configured",
              reason: "Upstream provider credential is missing.",
            },
          },
        })}
        onAction={vi.fn()}
      />,
    );

    expect(
      screen.getByText("AI 建站服务尚未就绪，请联系 FrontMind。"),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "选择 A" })).toBeDisabled();
    const regenerateButton = screen.getByRole("button", {
      name: "显示下一组 9 个视觉候选",
    });
    expect(regenerateButton).toBeDisabled();
    expect(regenerateButton).toHaveClass("siteops-primary-button");
    expect(
      screen.queryByRole("button", { name: "让 FrontMind 推荐" }),
    ).not.toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(
      /21st|Manus|Upstream|API Key/iu,
    );
  });

  it("starts from the current knowledge base without exposing version controls", async () => {
    const onAction = vi.fn().mockResolvedValue(undefined);
    render(
      <SiteOpsConversationPanel
        observation={observation({
          project: {
            ...observation().project,
            currentKnowledgeSnapshotId: null,
            status: "draft",
          },
          knowledgeSnapshots: [
            ...observation().knowledgeSnapshots,
            {
              id: "99999999-9999-4999-8999-999999999999",
              label: "知识库 ZIP · 第 4 版",
              sourceProfile: "dashboard-core-v1",
              createdAt: "2026-08-22T01:00:00.000Z",
              active: false,
            },
          ],
          messages: [],
          visualCandidates: [],
          interactionState: "select_snapshot",
        })}
        onAction={onAction}
      />,
    );

    expect(
      screen.getByRole("heading", { name: "从知识库开始建站" }),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText("知识库 ZIP 版本")).not.toBeInTheDocument();
    expect(
      screen.queryByLabelText("更换知识库 ZIP 版本"),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/知识库 ZIP · 第/u)).not.toBeInTheDocument();
    const startButton = screen.getByRole("button", {
      name: "从知识库开始建站",
    });
    expect(startButton).toHaveClass("siteops-primary-button");
    fireEvent.click(startButton);
    await waitFor(() =>
      expect(onAction).toHaveBeenCalledWith({
        action: "select_snapshot",
        input: {},
      }),
    );
  });

  it("keeps a reset task actionable while the observation projection is empty", async () => {
    const onAction = vi.fn().mockResolvedValue(undefined);
    render(
      <SiteOpsConversationPanel
        observation={observation({
          project: {
            ...observation().project,
            currentKnowledgeSnapshotId: null,
            status: "draft",
          },
          knowledgeSnapshots: [],
          messages: [],
          visualCandidates: [],
          rebuildRequest: {
            allowed: true,
            ticketId: null,
            status: null,
            resetApplied: true,
            resetPending: false,
            resetSourceBuildId: "33333333-3333-4333-8333-333333333333",
          },
          interactionState: "select_snapshot",
        })}
        onAction={onAction}
      />,
    );

    expect(
      screen.getByText(
        "FrontMind 将自动读取当前企业知识库，无需选择或重新上传版本。",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText("知识库 ZIP 版本")).not.toBeInTheDocument();
    expect(
      screen.queryByLabelText("更换知识库 ZIP 版本"),
    ).not.toBeInTheDocument();
    const startButton = screen.getByRole("button", {
      name: "从知识库开始建站",
    });
    expect(startButton).toBeEnabled();
    fireEvent.click(startButton);
    await waitFor(() =>
      expect(onAction).toHaveBeenCalledWith({
        action: "select_snapshot",
        input: {},
      }),
    );
  });

  it("starts a reset task from the current server-selected snapshot", async () => {
    const onAction = vi.fn().mockResolvedValue(undefined);
    render(
      <SiteOpsConversationPanel
        observation={observation({
          project: {
            ...observation().project,
            currentKnowledgeSnapshotId: null,
            status: "draft",
          },
          knowledgeSnapshots: [
            {
              id: "88888888-8888-4888-8888-888888888888",
              label: "v8 · 全新知识库.zip",
              sourceProfile: null,
              createdAt: "2026-08-30T01:00:00.000Z",
              active: false,
            },
          ],
          rebuildRequest: {
            allowed: true,
            ticketId: null,
            status: null,
            resetApplied: true,
            resetPending: false,
            resetSourceBuildId: "33333333-3333-4333-8333-333333333333",
          },
          interactionState: "select_snapshot",
        })}
        onAction={onAction}
      />,
    );

    const startButton = screen.getByRole("button", {
      name: "从知识库开始建站",
    });
    expect(startButton).toBeEnabled();
    fireEvent.click(startButton);
    await waitFor(() =>
      expect(onAction).toHaveBeenCalledWith({
        action: "select_snapshot",
        input: {},
      }),
    );
  });

  it("keeps the start action available for a legacy reset that retained the workflow snapshot pointer", async () => {
    const onAction = vi.fn().mockResolvedValue(undefined);
    render(
      <SiteOpsConversationPanel
        observation={observation({
          project: {
            ...observation().project,
            status: "draft",
          },
          messages: [],
          visualCandidates: [],
          interactionState: "select_snapshot",
        })}
        onAction={onAction}
      />,
    );

    const startButton = screen.getByRole("button", {
      name: "从知识库开始建站",
    });
    expect(startButton).toBeEnabled();
    fireEvent.click(startButton);
    await waitFor(() =>
      expect(onAction).toHaveBeenCalledWith({
        action: "select_snapshot",
        input: {},
      }),
    );
  });

  it("keeps provider configuration failures visible without inventing candidates", () => {
    render(
      <SiteOpsConversationPanel
        observation={observation({
          serviceReadiness: {
            ...observation().serviceReadiness,
            visuals: {
              status: "not_configured",
              reason: "请让系统管理员配置 21st API Key。",
            },
          },
          visualCandidates: [],
        })}
      />,
    );
    expect(
      screen.getByText("视觉参考服务尚未配置，暂时不能检索视觉方向。"),
    ).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/21st/iu);
    expect(screen.queryByRole("button", { name: /^选择 [A-I]$/u })).toBeNull();
  });

  it("severs opener before navigating and focusing the reusable preview tab", () => {
    const focus = vi.fn();
    const replace = vi.fn();
    const previewWindow = {
      opener: window,
      location: { replace },
      focus,
      close: vi.fn(),
    } as unknown as Window;
    const open = vi.spyOn(window, "open").mockReturnValue(previewWindow);
    render(
      <SiteOpsConversationPanel
        observation={observation({
          builds: [
            {
              id: "33333333-3333-4333-8333-333333333333",
              ordinal: 2,
              parentBuildId: null,
              status: "preview_ready",
              previewUrl:
                "/api/site-ops/builds/33333333-3333-4333-8333-333333333333/preview/",
              sourceUrl:
                "/api/site-ops/builds/33333333-3333-4333-8333-333333333333/source",
              needsHelp: false,
              createdAt: "2026-08-22T00:00:00.000Z",
              updatedAt: "2026-08-22T00:01:00.000Z",
            },
          ],
          interactionState: "preview_ready",
        })}
        onAction={vi.fn()}
      />,
    );
    const previewButton = screen.getByRole("button", {
      name: "在新标签页打开预览",
    });
    fireEvent.click(previewButton);
    fireEvent.click(previewButton);
    expect(open).toHaveBeenNthCalledWith(
      1,
      "about:blank",
      "frontmind-siteops-preview",
    );
    expect(open).toHaveBeenNthCalledWith(
      2,
      "about:blank",
      "frontmind-siteops-preview",
    );
    expect(previewWindow.opener).toBeNull();
    expect(replace).toHaveBeenNthCalledWith(
      1,
      "/api/site-ops/builds/33333333-3333-4333-8333-333333333333/preview/",
    );
    expect(replace).toHaveBeenNthCalledWith(
      2,
      "/api/site-ops/builds/33333333-3333-4333-8333-333333333333/preview/",
    );
    expect(focus).toHaveBeenCalledTimes(2);
    expect(
      screen.getByRole("link", { name: "下载网站源码" }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/QA 报告|批准这个版本/u)).toBeNull();
    open.mockRestore();
  });

  it("shows future blog and industry publishing as disabled on a completed website", () => {
    const onAction = vi.fn();
    render(
      <SiteOpsConversationPanel
        observation={observation({
          builds: [
            {
              id: "33333333-3333-4333-8333-333333333333",
              ordinal: 2,
              parentBuildId: null,
              status: "preview_ready",
              previewUrl:
                "/api/site-ops/builds/33333333-3333-4333-8333-333333333333/preview/",
              sourceUrl: null,
              needsHelp: false,
              createdAt: "2026-08-22T00:00:00.000Z",
              updatedAt: "2026-08-22T00:01:00.000Z",
            },
          ],
          interactionState: "preview_ready",
        })}
        onAction={onAction}
      />,
    );

    const futurePublishing = screen.getByRole("button", {
      name: "发布博客与行业近况（即将上线）",
    });
    expect(futurePublishing).toBeDisabled();
    fireEvent.click(futurePublishing);
    expect(onAction).not.toHaveBeenCalled();
  });

  it("shows a safe retry link when the private preview popup is blocked", () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    render(
      <SiteOpsConversationPanel
        observation={observation({
          builds: [
            {
              id: "33333333-3333-4333-8333-333333333333",
              ordinal: 2,
              parentBuildId: null,
              status: "preview_ready",
              previewUrl:
                "/api/site-ops/builds/33333333-3333-4333-8333-333333333333/preview/",
              sourceUrl: null,
              needsHelp: false,
              createdAt: "2026-08-22T00:00:00.000Z",
              updatedAt: "2026-08-22T00:01:00.000Z",
            },
          ],
          interactionState: "preview_ready",
        })}
        onAction={vi.fn()}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", {
        name: "在新标签页打开预览",
      }),
    );
    expect(
      screen.getByText("预览标签页被浏览器阻止，请允许此站点打开弹窗后重试。"),
    ).toBeInTheDocument();

    const retryLink = screen.getByRole("link", {
      name: "重试打开预览",
    });
    expect(retryLink).toHaveAttribute(
      "href",
      "/api/site-ops/builds/33333333-3333-4333-8333-333333333333/preview/",
    );
    expect(retryLink).toHaveAttribute("target", "frontmind-siteops-preview");
    fireEvent.click(retryLink);
    expect(open).toHaveBeenCalledTimes(2);
    open.mockRestore();
  });

  it("does not expose renderer details or historical comparisons", () => {
    render(
      <SiteOpsConversationPanel
        observation={observation({
          builds: [
            {
              id: "33333333-3333-4333-8333-333333333333",
              ordinal: 4,
              parentBuildId: null,
              status: "approved",
              previewUrl:
                "/api/site-ops/builds/33333333-3333-4333-8333-333333333333/preview/",
              sourceUrl: null,
              needsHelp: false,
              createdAt: "2026-08-22T00:00:00.000Z",
              updatedAt: "2026-08-22T00:01:00.000Z",
            },
            {
              id: "44444444-4444-4444-8444-444444444444",
              ordinal: 5,
              parentBuildId: "33333333-3333-4333-8333-333333333333",
              status: "preview_ready",
              previewUrl:
                "/api/site-ops/builds/44444444-4444-4444-8444-444444444444/preview/",
              sourceUrl: null,
              needsHelp: false,
              createdAt: "2026-08-23T00:00:00.000Z",
              updatedAt: "2026-08-23T00:01:00.000Z",
            },
          ],
          interactionState: "preview_ready",
        })}
        onAction={vi.fn()}
      />,
    );

    expect(document.body.textContent).not.toMatch(/Astro|React|历史版本对比/iu);
  });

  it("keeps the last successful preview available when a child rebuild fails", () => {
    const replace = vi.fn();
    const open = vi.spyOn(window, "open").mockReturnValue({
      opener: window,
      location: { replace },
      focus: vi.fn(),
      close: vi.fn(),
    } as unknown as Window);
    const currentPreview =
      "/api/site-ops/builds/33333333-3333-4333-8333-333333333333/preview/";
    render(
      <SiteOpsConversationPanel
        observation={observation({
          builds: [
            {
              id: "33333333-3333-4333-8333-333333333333",
              ordinal: 4,
              parentBuildId: null,
              status: "approved",
              previewUrl: currentPreview,
              sourceUrl: null,
              needsHelp: false,
              createdAt: "2026-08-22T00:00:00.000Z",
              updatedAt: "2026-08-22T00:01:00.000Z",
            },
            {
              id: "44444444-4444-4444-8444-444444444444",
              ordinal: 5,
              parentBuildId: "33333333-3333-4333-8333-333333333333",
              status: "failed",
              previewUrl: null,
              sourceUrl: null,
              needsHelp: true,
              createdAt: "2026-08-23T00:00:00.000Z",
              updatedAt: "2026-08-23T00:01:00.000Z",
            },
          ],
          rebuildRequest: {
            allowed: true,
            ticketId: null,
            status: null,
            resetApplied: false,
            resetSourceBuildId: null,
          },
          interactionState: "failed",
        })}
        onAction={vi.fn()}
      />,
    );

    expect(
      screen.getByText(
        "重置申请尚未完成；在批准并执行下线前，当前官网仍可继续预览和使用。",
      ),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "在新标签页打开预览" }));
    expect(open).toHaveBeenCalledWith(
      "about:blank",
      "frontmind-siteops-preview",
    );
    expect(replace).toHaveBeenCalledWith(currentPreview);
    open.mockRestore();
  });

  it("keeps a recoverable first build in progress and still offers a reset", () => {
    const buildId = "33333333-3333-4333-8333-333333333333";
    render(
      <SiteOpsConversationPanel
        observation={observation({
          project: {
            ...observation().project,
            status: "attention_required",
          },
          interactionState: "attention_required",
          builds: [
            {
              id: buildId,
              ordinal: 1,
              parentBuildId: null,
              status: "attention_required",
              previewUrl: null,
              sourceUrl: null,
              buildPhase: "provider_sync_delayed",
              recoverable: true,
              previewWarning:
                "AI 建站结果正在同步，系统会继续读取同一任务，不会重复创建或重复计费。",
              needsHelp: true,
              createdAt: "2026-08-23T00:00:00.000Z",
              updatedAt: "2026-08-23T00:01:00.000Z",
            },
          ],
          rebuildRequest: {
            allowed: true,
            ticketId: null,
            status: null,
            resetApplied: false,
            resetSourceBuildId: null,
          },
        })}
        onAction={vi.fn()}
      />,
    );

    expect(
      screen.getByRole("heading", { name: "正在同步建站结果" }),
    ).toBeInTheDocument();
    expect(screen.getByText(/不会重复创建或重复计费/u)).toBeInTheDocument();
    expect(screen.queryByText(/本次没有生成可安全展示的版本/u)).toBeNull();
    expect(
      screen.getByRole("button", { name: "申请重置并全新开始" }),
    ).toBeEnabled();
  });

  it("submits a fresh reset for a recoverable service-unavailable build", async () => {
    const onAction = vi.fn().mockResolvedValue(undefined);
    render(
      <SiteOpsConversationPanel
        observation={observation({
          project: { ...observation().project, status: "failed" },
          interactionState: "failed",
          builds: [
            {
              id: "33333333-3333-4333-8333-333333333333",
              ordinal: 1,
              parentBuildId: null,
              status: "failed",
              previewUrl: null,
              sourceUrl: null,
              buildPhase: "provider_sync_delayed",
              recoverable: true,
              previewWarning:
                "AI 建站任务仍可恢复，但也可以申请重置后全新开始。",
              needsHelp: true,
              createdAt: "2026-08-23T00:00:00.000Z",
              updatedAt: "2026-08-23T00:01:00.000Z",
            },
          ],
          rebuildRequest: {
            allowed: true,
            ticketId: null,
            status: null,
            resetApplied: false,
            resetSourceBuildId: null,
          },
        })}
        onAction={onAction}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "申请重置并全新开始" }));
    fireEvent.click(screen.getByRole("button", { name: "提交重置申请" }));

    await waitFor(() =>
      expect(onAction).toHaveBeenCalledWith({
        action: "request_rebuild",
        input: {},
      }),
    );
  });

  it("shows the previous preview while a recoverable revision keeps reconciling", () => {
    const currentPreview =
      "/api/site-ops/builds/33333333-3333-4333-8333-333333333333/preview/";
    render(
      <SiteOpsConversationPanel
        observation={observation({
          builds: [
            {
              id: "33333333-3333-4333-8333-333333333333",
              ordinal: 4,
              parentBuildId: null,
              status: "approved",
              previewUrl: currentPreview,
              sourceUrl: null,
              needsHelp: false,
              createdAt: "2026-08-22T00:00:00.000Z",
              updatedAt: "2026-08-22T00:01:00.000Z",
            },
            {
              id: "44444444-4444-4444-8444-444444444444",
              ordinal: 5,
              parentBuildId: "33333333-3333-4333-8333-333333333333",
              status: "attention_required",
              previewUrl: null,
              sourceUrl: null,
              buildPhase: "source_repairing",
              recoverable: true,
              previewWarning:
                "首次源码未通过安全检查，系统正在同一任务内自动修复；已选视觉参考仍会保留。",
              needsHelp: true,
              createdAt: "2026-08-23T00:00:00.000Z",
              updatedAt: "2026-08-23T00:01:00.000Z",
            },
          ],
          rebuildRequest: {
            allowed: true,
            ticketId: null,
            status: null,
            resetApplied: false,
            resetSourceBuildId: null,
          },
          interactionState: "attention_required",
        })}
        onAction={vi.fn()}
      />,
    );

    expect(screen.getByText(/同一任务内自动修复/u)).toHaveTextContent(
      "上一版成功预览仍可继续查看和使用",
    );
    expect(
      screen.getByRole("button", { name: "在新标签页打开预览" }),
    ).toBeEnabled();
    expect(
      screen.getByRole("button", { name: "申请重置并全新开始" }),
    ).toBeEnabled();
  });

  it("offers only an approved fresh reset after a hard build failure", async () => {
    const buildId = "33333333-3333-4333-8333-333333333333";
    const onAction = vi.fn().mockResolvedValue(undefined);
    render(
      <SiteOpsConversationPanel
        observation={observation({
          project: { ...observation().project, status: "failed" },
          interactionState: "failed",
          builds: [
            {
              id: buildId,
              ordinal: 1,
              parentBuildId: null,
              status: "failed",
              previewUrl: null,
              sourceUrl: null,
              needsHelp: true,
              createdAt: "2026-08-23T00:00:00.000Z",
              updatedAt: "2026-08-23T00:01:00.000Z",
            },
          ],
          rebuildRequest: {
            allowed: true,
            ticketId: null,
            status: null,
            resetApplied: false,
            resetSourceBuildId: null,
          },
        })}
        onAction={onAction}
      />,
    );

    expect(screen.getByText(/本次没有生成可安全展示的版本/u)).toHaveTextContent(
      "可从当前企业知识库重新开始建站",
    );
    expect(screen.queryByRole("button", { name: "继续生成官网" })).toBeNull();
    expect(screen.queryByRole("button", { name: "重置建站流程" })).toBeNull();
    const resetButtons = screen.getAllByRole("button", {
      name: "申请重置并全新开始",
    });
    fireEvent.click(resetButtons.at(-1)!);
    fireEvent.click(screen.getByRole("button", { name: "提交重置申请" }));
    await waitFor(() =>
      expect(onAction).toHaveBeenCalledWith({
        action: "request_rebuild",
        input: {},
      }),
    );
  });

  it("shows a trusted fallback preview as usable without exposing warning codes", () => {
    const buildId = "33333333-3333-4333-8333-333333333333";
    render(
      <SiteOpsConversationPanel
        observation={observation({
          project: { ...observation().project, status: "preview_ready" },
          interactionState: "preview_ready",
          builds: [
            {
              id: buildId,
              ordinal: 1,
              parentBuildId: null,
              status: "preview_ready",
              previewUrl: `/api/site-ops/builds/${buildId}/preview/`,
              sourceUrl: null,
              buildDelivery: {
                renderMode: "trusted_fallback",
                qaStatus: "partial",
                warningCodes: ["SITEOPS_REACT_STATIC_BUILD_FAILED"],
              },
              needsHelp: false,
              createdAt: "2026-08-23T00:00:00.000Z",
              updatedAt: "2026-08-23T00:01:00.000Z",
            },
          ],
        })}
        onAction={vi.fn()}
      />,
    );

    expect(
      screen.getByText(/基础预览已生成，可以查看并继续完善/u),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "在新标签页打开预览" }),
    ).toBeEnabled();
    expect(document.body.textContent).not.toContain(
      "SITEOPS_REACT_STATIC_BUILD_FAILED",
    );
    expect(screen.queryByText(/请重置后重新开始/u)).toBeNull();
  });

  it("shows fixed partial-default copy for a successful content-patch preview", () => {
    const buildId = "33333333-3333-4333-8333-333333333333";
    render(
      <SiteOpsConversationPanel
        observation={observation({
          project: { ...observation().project, status: "preview_ready" },
          interactionState: "preview_ready",
          builds: [
            {
              id: buildId,
              ordinal: 1,
              parentBuildId: null,
              status: "preview_ready",
              previewUrl: `/api/site-ops/builds/${buildId}/preview/`,
              sourceUrl: null,
              buildDelivery: {
                renderMode: "content_patch",
                qaStatus: "passed_with_warnings",
                warningCodes: ["SITEOPS_CONTENT_PATCH_PARTIAL_DEFAULTS"],
              },
              buildPhase: null,
              recoverable: false,
              previewWarning:
                "官网预览已生成，部分内容使用企业资料中的可信默认值。",
              needsHelp: false,
              createdAt: "2026-08-23T00:00:00.000Z",
              updatedAt: "2026-08-23T00:01:00.000Z",
            },
          ],
        })}
        onAction={vi.fn()}
      />,
    );

    expect(
      screen.getByText("官网预览已生成，部分内容使用企业资料中的可信默认值。"),
    ).toBeInTheDocument();
    expect(document.body.textContent).not.toContain(
      "SITEOPS_CONTENT_PATCH_PARTIAL_DEFAULTS",
    );
  });

  it("shows primary QA findings as non-blocking preview advice", () => {
    const buildId = "33333333-3333-4333-8333-333333333333";
    render(
      <SiteOpsConversationPanel
        observation={observation({
          project: { ...observation().project, status: "preview_ready" },
          interactionState: "preview_ready",
          builds: [
            {
              id: buildId,
              ordinal: 1,
              parentBuildId: null,
              status: "preview_ready",
              previewUrl: `/api/site-ops/builds/${buildId}/preview/`,
              sourceUrl: null,
              buildDelivery: {
                renderMode: "primary",
                qaStatus: "passed_with_warnings",
                warningCodes: ["SITEOPS_AXE_BLOCKING_VIOLATIONS"],
              },
              needsHelp: false,
              createdAt: "2026-08-23T00:00:00.000Z",
              updatedAt: "2026-08-23T00:01:00.000Z",
            },
          ],
        })}
        onAction={vi.fn()}
      />,
    );

    expect(
      screen.getByText(/质量检查中的非阻断建议已记录/u),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "在新标签页打开预览" }),
    ).toBeEnabled();
    expect(document.body.textContent).not.toContain(
      "SITEOPS_AXE_BLOCKING_VIOLATIONS",
    );
  });

  it("shows native React QA findings as non-blocking preview advice", () => {
    const buildId = "33333333-3333-4333-8333-333333333333";
    render(
      <SiteOpsConversationPanel
        observation={observation({
          project: { ...observation().project, status: "preview_ready" },
          interactionState: "preview_ready",
          builds: [
            {
              id: buildId,
              ordinal: 1,
              parentBuildId: null,
              status: "preview_ready",
              previewUrl: `/api/site-ops/builds/${buildId}/preview/`,
              sourceUrl: null,
              buildDelivery: {
                renderMode: "twenty_first_native",
                qaStatus: "passed_with_warnings",
                warningCodes: ["NATIVE_AXE_FINDINGS"],
              },
              needsHelp: false,
              createdAt: "2026-08-23T00:00:00.000Z",
              updatedAt: "2026-08-23T00:01:00.000Z",
            },
          ],
        })}
        onAction={vi.fn()}
      />,
    );

    expect(
      screen.getByText(/质量检查中的非阻断建议已记录/u),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "在新标签页打开预览" }),
    ).toBeEnabled();
    expect(document.body.textContent).not.toContain("NATIVE_AXE_FINDINGS");
  });

  it("does not offer a duplicate publish while the same target is pending", () => {
    const approvedBuild = {
      id: "33333333-3333-4333-8333-333333333333",
      ordinal: 2,
      parentBuildId: null,
      status: "approved" as const,
      previewUrl: null,
      sourceUrl: null,
      needsHelp: false,
      createdAt: "2026-08-22T00:00:00.000Z",
      updatedAt: "2026-08-22T00:01:00.000Z",
    };
    render(
      <SiteOpsConversationPanel
        observation={observation({
          builds: [approvedBuild],
          deployments: [
            {
              id: "55555555-5555-4555-8555-555555555555",
              buildId: approvedBuild.id,
              target: "global_excluding_cn",
              status: "deploying",
              publicUrl: null,
              createdAt: "2026-08-22T00:02:00.000Z",
            },
          ],
          interactionState: "approved",
        })}
        onAction={vi.fn()}
      />,
    );

    expect(
      screen.getByRole("button", { name: "海外站点发布中" }),
    ).toBeDisabled();
  });

  it("enables the final publish click only after DNS and mainland ICP are ready", () => {
    const approvedBuild = {
      id: "33333333-3333-4333-8333-333333333333",
      ordinal: 2,
      parentBuildId: null,
      status: "approved" as const,
      previewUrl: null,
      sourceUrl: null,
      needsHelp: false,
      createdAt: "2026-08-22T00:00:00.000Z",
      updatedAt: "2026-08-22T00:01:00.000Z",
    };
    const domainState = {
      domain: "example.com",
      displayDomain: "example.com",
      revision: 4,
      ownershipStatus: "verified",
      dnsStatus: "pending",
      icpStatus: "not_submitted" as const,
      icpDomainRevision: null,
      icpVerifiedAt: null,
    };
    const view = render(
      <SiteOpsConversationPanel
        observation={observation({
          builds: [approvedBuild],
          interactionState: "approved",
          domainState,
        })}
        onAction={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: "发布海外站点" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "发布大陆站点" })).toBeDisabled();

    view.rerender(
      <SiteOpsConversationPanel
        observation={observation({
          builds: [approvedBuild],
          interactionState: "approved",
          domainState: { ...domainState, dnsStatus: "active" },
        })}
        onAction={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: "发布海外站点" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "发布大陆站点" })).toBeDisabled();

    view.rerender(
      <SiteOpsConversationPanel
        observation={observation({
          builds: [approvedBuild],
          interactionState: "approved",
          domainState: {
            ...domainState,
            dnsStatus: "active",
            icpStatus: "approved",
            icpDomainRevision: 4,
            icpVerifiedAt: "2026-08-22T00:02:00.000Z",
          },
        })}
        onAction={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: "发布大陆站点" })).toBeEnabled();
  });

  it("submits a rebuild ticket instead of directly reselecting visuals", async () => {
    const onAction = vi.fn().mockResolvedValue(undefined);
    render(
      <SiteOpsConversationPanel
        observation={observation({
          builds: [
            {
              id: "33333333-3333-4333-8333-333333333333",
              ordinal: 2,
              parentBuildId: null,
              status: "approved",
              previewUrl: null,
              sourceUrl: null,
              needsHelp: false,
              createdAt: "2026-08-22T00:00:00.000Z",
              updatedAt: "2026-08-22T00:01:00.000Z",
            },
          ],
          project: { ...observation().project, status: "live" },
          interactionState: "live",
          rebuildRequest: {
            allowed: true,
            ticketId: null,
            status: null,
            resetApplied: false,
            resetSourceBuildId: null,
          },
        })}
        onAction={onAction}
      />,
    );

    expect(screen.queryByRole("button", { name: "重置建站流程" })).toBeNull();
    fireEvent.click(
      screen.getAllByRole("button", { name: "申请重置并全新开始" })[0]!,
    );
    fireEvent.change(screen.getByLabelText("重置原因与期望（选填）"), {
      target: { value: "希望调整品牌风格" },
    });
    fireEvent.click(screen.getByRole("button", { name: "提交重置申请" }));
    await waitFor(() =>
      expect(onAction).toHaveBeenCalledWith({
        action: "request_rebuild",
        input: { reason: "希望调整品牌风格" },
      }),
    );
  });

  it("does not present a completed reset coordinate as an active reset", () => {
    render(
      <SiteOpsConversationPanel
        observation={observation({
          rebuildRequest: {
            allowed: true,
            ticketId: null,
            status: null,
            resetApplied: true,
            resetPending: false,
            resetSourceBuildId: "33333333-3333-4333-8333-333333333333",
          },
        })}
        onAction={vi.fn()}
      />,
    );

    expect(
      screen.getByRole("button", { name: "申请重置并全新开始" }),
    ).toBeEnabled();
    expect(
      screen.queryByRole("button", {
        name: "重置已批准，可从当前知识库重新开始",
      }),
    ).toBeNull();
  });

  it("hides the previous website surface after an approved rebuild reset", () => {
    render(
      <SiteOpsConversationPanel
        observation={observation({
          project: {
            ...observation().project,
            status: "draft",
            currentKnowledgeSnapshotId: null,
          },
          knowledgeSnapshots: [],
          builds: [
            {
              id: "33333333-3333-4333-8333-333333333333",
              ordinal: 2,
              parentBuildId: null,
              status: "approved",
              previewUrl:
                "/api/site-ops/builds/33333333-3333-4333-8333-333333333333/preview/",
              sourceUrl:
                "/api/site-ops/builds/33333333-3333-4333-8333-333333333333/source",
              needsHelp: false,
              createdAt: "2026-08-22T00:00:00.000Z",
              updatedAt: "2026-08-22T00:01:00.000Z",
            },
          ],
          rebuildRequest: {
            allowed: true,
            ticketId: "77777777-7777-4777-8777-777777777777",
            status: "in_progress",
            resetApplied: true,
            resetSourceBuildId: "33333333-3333-4333-8333-333333333333",
          },
          interactionState: "select_snapshot",
        })}
        onAction={vi.fn()}
      />,
    );

    expect(
      screen.getByRole("heading", { name: "从知识库开始建站" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("当前阶段")).not.toBeInTheDocument();
    expect(screen.queryByText("官网版本 2")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "在新标签页打开预览" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: "下载网站源码" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", {
        name: "重置已批准，可从当前知识库重新开始",
      }),
    ).toBeEnabled();
    expect(screen.queryByText("重置申请处理中")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", {
        name: "发布博客与行业近况（即将上线）",
      }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("继续对话")).not.toBeInTheDocument();
  });

  it.each([
    "visual_searching",
    "awaiting_visual_selection",
    "building",
  ] as const)(
    "allows a reset request while the first workflow is %s",
    (status) => {
      render(
        <SiteOpsConversationPanel
          observation={observation({
            project: { ...observation().project, status },
            builds:
              status === "building"
                ? [
                    {
                      id: "33333333-3333-4333-8333-333333333333",
                      ordinal: 1,
                      parentBuildId: null,
                      status: "building",
                      previewUrl: null,
                      sourceUrl: null,
                      needsHelp: false,
                      createdAt: "2026-08-22T00:00:00.000Z",
                      updatedAt: "2026-08-22T00:01:00.000Z",
                    },
                  ]
                : [],
            interactionState: status,
            rebuildRequest: {
              allowed: true,
              ticketId: null,
              status: null,
              resetApplied: false,
              resetSourceBuildId: null,
            },
          })}
          onAction={vi.fn()}
        />,
      );

      expect(
        screen.getByRole("button", { name: "申请重置并全新开始" }),
      ).toBeEnabled();
    },
  );

  it("submits a reset request before a completed website exists", async () => {
    const onAction = vi.fn().mockResolvedValue(undefined);
    render(
      <SiteOpsConversationPanel
        observation={observation({
          builds: [],
          rebuildRequest: {
            allowed: true,
            ticketId: null,
            status: null,
            resetApplied: false,
            resetSourceBuildId: null,
          },
        })}
        onAction={onAction}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "申请重置并全新开始" }));
    fireEvent.click(screen.getByRole("button", { name: "提交重置申请" }));

    await waitFor(() =>
      expect(onAction).toHaveBeenCalledWith({
        action: "request_rebuild",
        input: {},
      }),
    );
  });

  it("keeps the existing website visible before a submitted rebuild is approved", () => {
    render(
      <SiteOpsConversationPanel
        observation={observation({
          project: { ...observation().project, status: "live" },
          builds: [
            {
              id: "33333333-3333-4333-8333-333333333333",
              ordinal: 2,
              parentBuildId: null,
              status: "approved",
              previewUrl:
                "/api/site-ops/builds/33333333-3333-4333-8333-333333333333/preview/",
              sourceUrl:
                "/api/site-ops/builds/33333333-3333-4333-8333-333333333333/source",
              needsHelp: false,
              createdAt: "2026-08-22T00:00:00.000Z",
              updatedAt: "2026-08-22T00:01:00.000Z",
            },
          ],
          rebuildRequest: {
            allowed: false,
            ticketId: "77777777-7777-4777-8777-777777777777",
            status: "submitted",
            resetApplied: false,
            resetSourceBuildId: null,
          },
          interactionState: "live",
        })}
        onAction={vi.fn()}
      />,
    );

    expect(screen.queryByText("官网版本 2")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "在新标签页打开预览" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "下载网站源码" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", {
        name: "发布博客与行业近况（即将上线）",
      }),
    ).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "重置申请处理中" })).toEqual(
      expect.arrayContaining([expect.any(HTMLButtonElement)]),
    );
    expect(
      screen
        .getAllByRole("button", { name: "重置申请处理中" })
        .every((button) => button.hasAttribute("disabled")),
    ).toBe(true);
  });

  it("keeps a newly completed replacement visible while a second reset request awaits approval", () => {
    render(
      <SiteOpsConversationPanel
        observation={observation({
          project: { ...observation().project, status: "approved" },
          builds: [
            {
              id: "33333333-3333-4333-8333-333333333333",
              ordinal: 2,
              parentBuildId: null,
              status: "approved",
              previewUrl:
                "/api/site-ops/builds/33333333-3333-4333-8333-333333333333/preview/",
              sourceUrl: null,
              needsHelp: false,
              createdAt: "2026-08-22T00:00:00.000Z",
              updatedAt: "2026-08-22T00:01:00.000Z",
            },
            {
              id: "44444444-4444-4444-8444-444444444444",
              ordinal: 3,
              parentBuildId: "33333333-3333-4333-8333-333333333333",
              status: "approved",
              previewUrl:
                "/api/site-ops/builds/44444444-4444-4444-8444-444444444444/preview/",
              sourceUrl:
                "/api/site-ops/builds/44444444-4444-4444-8444-444444444444/source",
              needsHelp: false,
              createdAt: "2026-08-23T00:00:00.000Z",
              updatedAt: "2026-08-23T00:01:00.000Z",
            },
          ],
          rebuildRequest: {
            allowed: false,
            ticketId: "77777777-7777-4777-8777-777777777777",
            status: "submitted",
            resetApplied: true,
            resetSourceBuildId: "33333333-3333-4333-8333-333333333333",
          },
          interactionState: "approved",
        })}
        onAction={vi.fn()}
      />,
    );

    expect(screen.queryByText("官网版本 3")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "在新标签页打开预览" }),
    ).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "重置申请处理中" })).toEqual(
      expect.arrayContaining([expect.any(HTMLButtonElement)]),
    );
  });

  it("restores the completed replacement website after the rebuild ticket completes", () => {
    render(
      <SiteOpsConversationPanel
        observation={observation({
          project: { ...observation().project, status: "approved" },
          builds: [
            {
              id: "33333333-3333-4333-8333-333333333333",
              ordinal: 2,
              parentBuildId: null,
              status: "approved",
              previewUrl:
                "/api/site-ops/builds/33333333-3333-4333-8333-333333333333/preview/",
              sourceUrl: null,
              needsHelp: false,
              createdAt: "2026-08-22T00:00:00.000Z",
              updatedAt: "2026-08-22T00:01:00.000Z",
            },
            {
              id: "44444444-4444-4444-8444-444444444444",
              ordinal: 3,
              parentBuildId: "33333333-3333-4333-8333-333333333333",
              status: "approved",
              previewUrl:
                "/api/site-ops/builds/44444444-4444-4444-8444-444444444444/preview/",
              sourceUrl:
                "/api/site-ops/builds/44444444-4444-4444-8444-444444444444/source",
              needsHelp: false,
              createdAt: "2026-08-23T00:00:00.000Z",
              updatedAt: "2026-08-23T00:01:00.000Z",
            },
          ],
          rebuildRequest: {
            allowed: true,
            ticketId: "77777777-7777-4777-8777-777777777777",
            status: "completed",
            resetApplied: true,
            resetSourceBuildId: "33333333-3333-4333-8333-333333333333",
          },
          interactionState: "approved",
        })}
        onAction={vi.fn()}
      />,
    );

    expect(screen.queryByText("官网版本 3")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "在新标签页打开预览" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "下载网站源码" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", {
        name: "发布博客与行业近况（即将上线）",
      }),
    ).toBeInTheDocument();
  });

  it.each([
    "collecting_brief",
    "visual_searching",
    "awaiting_visual_selection",
  ] as const)(
    "does not render the removed current-stage strip while an approved rebuild is %s",
    (interactionState) => {
      render(
        <SiteOpsConversationPanel
          observation={observation({
            project: {
              ...observation().project,
              status: interactionState,
            },
            builds: [
              {
                id: "33333333-3333-4333-8333-333333333333",
                ordinal: 2,
                parentBuildId: null,
                status: "approved",
                previewUrl:
                  "/api/site-ops/builds/33333333-3333-4333-8333-333333333333/preview/",
                sourceUrl: null,
                needsHelp: false,
                createdAt: "2026-08-22T00:00:00.000Z",
                updatedAt: "2026-08-22T00:01:00.000Z",
              },
            ],
            rebuildRequest: {
              allowed: false,
              ticketId: "77777777-7777-4777-8777-777777777777",
              status: "in_progress",
              resetApplied: true,
              resetSourceBuildId: "33333333-3333-4333-8333-333333333333",
            },
            interactionState,
          })}
          onAction={vi.fn()}
        />,
      );

      expect(screen.queryByText("当前阶段")).not.toBeInTheDocument();
    },
  );

  it("keeps deployment rollback out of the customer workspace", () => {
    const onAction = vi.fn().mockResolvedValue(undefined);
    render(
      <SiteOpsConversationPanel
        observation={observation({
          deployments: [
            {
              id: "55555555-5555-4555-8555-555555555555",
              buildId: "33333333-3333-4333-8333-333333333333",
              target: "global_excluding_cn",
              status: "superseded",
              publicUrl: "https://example.com",
              createdAt: "2026-08-22T00:00:00.000Z",
            },
          ],
          interactionState: "live",
        })}
        onAction={onAction}
      />,
    );

    expect(screen.queryByText("历史发布与回滚")).toBeNull();
    expect(screen.queryByRole("button", { name: /回滚海外版本/u })).toBeNull();
    expect(onAction).not.toHaveBeenCalled();
  });

  it("opens official Alibaba authorization without exposing technical fields", async () => {
    const onBeginAliyun = vi.fn().mockResolvedValue({
      authorizationUrl: "https://signin.aliyun.com/oauth/authorize",
      expiresAt: "2026-08-23T01:00:00.000Z",
    });
    const authorizationWindow = {
      location: { href: "" },
      focus: vi.fn(),
      close: vi.fn(),
    };
    const open = vi
      .spyOn(window, "open")
      .mockReturnValue(authorizationWindow as unknown as Window);
    render(
      <SiteOpsConversationPanel
        observation={observation()}
        onBeginAliyun={onBeginAliyun}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "一键连接阿里云" }));
    await waitFor(() => expect(onBeginAliyun).toHaveBeenCalledOnce());
    expect(authorizationWindow.location.href).toBe(
      "https://signin.aliyun.com/oauth/authorize",
    );
    expect(document.body.textContent).toContain(
      "FrontMind 只管理域名解析，不会购买、续费或从阿里云账号扣款。",
    );
    expect(document.body.textContent).not.toMatch(
      /UID|ARN|ExternalId|AccessKey (?:ID|Secret)|RAM Role|STS/iu,
    );
    open.mockRestore();
  });

  it("shows a safe checking page synchronously while the authorization URL is prepared", async () => {
    const popupDocument = document.implementation.createHTMLDocument();
    const onBeginAliyun = vi.fn(
      () =>
        new Promise<{ authorizationUrl: string; expiresAt: string }>(() => {}),
    );
    const authorizationWindow = {
      document: popupDocument,
      location: { href: "" },
      focus: vi.fn(),
      close: vi.fn(),
    };
    const open = vi
      .spyOn(window, "open")
      .mockReturnValue(authorizationWindow as unknown as Window);
    render(
      <SiteOpsConversationPanel
        observation={observation()}
        onBeginAliyun={onBeginAliyun}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "一键连接阿里云" }));

    expect(onBeginAliyun).toHaveBeenCalledOnce();
    expect(popupDocument.title).toBe("正在检查阿里云授权配置");
    expect(popupDocument.body.textContent).toContain(
      "请稍候，FrontMind 正在确认安全的授权入口。",
    );
    expect(popupDocument.querySelector("main")?.getAttribute("aria-live")).toBe(
      "polite",
    );
    expect(popupDocument.querySelector("button")).toBeNull();
    open.mockRestore();
  });

  it("keeps the error on the Aliyun card when the popup is blocked", async () => {
    const onBeginAliyun = vi.fn();
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    render(
      <SiteOpsConversationPanel
        observation={observation()}
        onBeginAliyun={onBeginAliyun}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "一键连接阿里云" }));

    expect(onBeginAliyun).not.toHaveBeenCalled();
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(
      "阿里云授权页面被浏览器阻止，请允许此站点打开弹窗后重试。",
    );
    expect(alert).toHaveAttribute("aria-live", "assertive");
    expect(
      screen.getByRole("heading", { name: "连接阿里云" }).closest("section"),
    ).toContainElement(alert);
    open.mockRestore();
  });

  it("does not expose an upstream invalid_client response", async () => {
    const onBeginAliyun = vi
      .fn()
      .mockRejectedValue(
        new Error(
          "invalid_client: App not exists:5be78a96-6d64-42a0-b764-49474a8d5e04",
        ),
      );
    const popupDocument = document.implementation.createHTMLDocument();
    const authorizationWindow = {
      document: popupDocument,
      location: { href: "" },
      focus: vi.fn(),
      close: vi.fn(),
    };
    const open = vi
      .spyOn(window, "open")
      .mockReturnValue(authorizationWindow as unknown as Window);
    render(
      <SiteOpsConversationPanel
        observation={observation()}
        onBeginAliyun={onBeginAliyun}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "一键连接阿里云" }));

    expect(
      await screen.findByText("阿里云连接配置需要 FrontMind 管理员更新。"),
    ).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("invalid_client");
    expect(document.body.textContent).not.toContain(
      "5be78a96-6d64-42a0-b764-49474a8d5e04",
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "阿里云连接配置需要 FrontMind 管理员更新。",
    );
    expect(popupDocument.title).toBe("暂时无法打开阿里云授权");
    expect(popupDocument.body.textContent).not.toMatch(
      /invalid_client|5be78a96|AppId|Secret/iu,
    );
    expect(authorizationWindow.close).not.toHaveBeenCalled();
    const closeButton = popupDocument.querySelector("button");
    expect(closeButton?.textContent).toBe("关闭窗口");
    closeButton?.click();
    expect(authorizationWindow.close).toHaveBeenCalledOnce();
    open.mockRestore();
  });

  it("completes OAuth in the same popup and refreshes the connected account", async () => {
    const onBeginAliyun = vi.fn().mockResolvedValue({
      authorizationUrl: "https://signin.aliyun.com/oauth/authorize",
      expiresAt: "2026-08-23T01:00:00.000Z",
    });
    const onRefresh = vi.fn().mockResolvedValue(undefined);
    const authorizationWindow = {
      location: { href: "" },
      focus: vi.fn(),
      close: vi.fn(),
    };
    const open = vi
      .spyOn(window, "open")
      .mockReturnValue(authorizationWindow as unknown as Window);
    render(
      <SiteOpsConversationPanel
        observation={observation()}
        onBeginAliyun={onBeginAliyun}
        onRefresh={onRefresh}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "一键连接阿里云" }));
    await waitFor(() => expect(onBeginAliyun).toHaveBeenCalledOnce());
    act(() => {
      window.dispatchEvent(
        new MessageEvent("message", {
          origin: window.location.origin,
          source: authorizationWindow as unknown as Window,
          data: {
            type: "frontmind:siteops:aliyun-oauth",
            status: "success",
          },
        }),
      );
    });

    await waitFor(() => expect(onRefresh).toHaveBeenCalledOnce());
    expect(authorizationWindow.close).toHaveBeenCalledOnce();
    expect(document.body.textContent).not.toMatch(/ROS|RAM Role|ExternalId/u);
    open.mockRestore();
  });

  it("ignores OAuth completion messages from another origin or window", async () => {
    const onBeginAliyun = vi.fn().mockResolvedValue({
      authorizationUrl: "https://signin.aliyun.com/oauth/authorize",
      expiresAt: "2026-08-23T01:00:00.000Z",
    });
    const onRefresh = vi.fn().mockResolvedValue(undefined);
    const authorizationWindow = {
      location: { href: "" },
      focus: vi.fn(),
      close: vi.fn(),
    };
    const open = vi
      .spyOn(window, "open")
      .mockReturnValue(authorizationWindow as unknown as Window);
    render(
      <SiteOpsConversationPanel
        observation={observation()}
        onBeginAliyun={onBeginAliyun}
        onRefresh={onRefresh}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "一键连接阿里云" }));
    await waitFor(() => expect(onBeginAliyun).toHaveBeenCalledOnce());
    act(() => {
      window.dispatchEvent(
        new MessageEvent("message", {
          origin: "https://attacker.example",
          source: authorizationWindow as unknown as Window,
          data: {
            type: "frontmind:siteops:aliyun-oauth",
            status: "success",
          },
        }),
      );
      window.dispatchEvent(
        new MessageEvent("message", {
          origin: window.location.origin,
          source: window,
          data: {
            type: "frontmind:siteops:aliyun-oauth",
            status: "success",
          },
        }),
      );
    });

    expect(onRefresh).not.toHaveBeenCalled();
    expect(authorizationWindow.close).not.toHaveBeenCalled();
    open.mockRestore();
  });

  it("projects OAuth cancellation and configuration failure without internals", async () => {
    const onBeginAliyun = vi.fn().mockResolvedValue({
      authorizationUrl: "https://signin.aliyun.com/oauth/authorize",
      expiresAt: "2026-08-23T01:00:00.000Z",
    });
    const firstWindow = {
      location: { href: "" },
      focus: vi.fn(),
      close: vi.fn(),
    };
    const secondWindow = {
      location: { href: "" },
      focus: vi.fn(),
      close: vi.fn(),
    };
    const open = vi
      .spyOn(window, "open")
      .mockReturnValueOnce(firstWindow as unknown as Window)
      .mockReturnValueOnce(secondWindow as unknown as Window);
    render(
      <SiteOpsConversationPanel
        observation={observation()}
        onBeginAliyun={onBeginAliyun}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "一键连接阿里云" }));
    await waitFor(() => expect(onBeginAliyun).toHaveBeenCalledTimes(1));
    act(() => {
      window.dispatchEvent(
        new MessageEvent("message", {
          origin: window.location.origin,
          source: firstWindow as unknown as Window,
          data: {
            type: "frontmind:siteops:aliyun-oauth",
            status: "cancelled",
          },
        }),
      );
    });
    expect(
      await screen.findByText("你已取消阿里云授权，未产生任何连接。"),
    ).toBeInTheDocument();
    expect(firstWindow.close).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "一键连接阿里云" }));
    await waitFor(() => expect(onBeginAliyun).toHaveBeenCalledTimes(2));
    act(() => {
      window.dispatchEvent(
        new MessageEvent("message", {
          origin: window.location.origin,
          source: secondWindow as unknown as Window,
          data: {
            type: "frontmind:siteops:aliyun-oauth",
            status: "failed",
          },
        }),
      );
    });
    expect(
      await screen.findByText("阿里云连接配置需要 FrontMind 管理员更新。"),
    ).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(
      /invalid_client|AppId|Secret/iu,
    );
    expect(secondWindow.close).not.toHaveBeenCalled();
    open.mockRestore();
  });

  it("offers one OAuth reauthorization action without RAM or manual setup", () => {
    render(
      <SiteOpsConversationPanel
        observation={observation({
          aliyunConnection: {
            configured: false,
            status: "attention_required",
            verifiedAt: null,
            canDisconnect: true,
          },
        })}
        onBeginAliyun={vi.fn()}
      />,
    );

    expect(
      screen.getByRole("button", { name: "重新授权阿里云" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "阿里云授权已失效，请重新授权。域名无需重复购买或重新填写。",
    );
    expect(document.body.textContent).not.toMatch(
      /手动配置|RAM 控制台|安全角色|ExternalId|ROS/u,
    );
  });

  it("sends customers with zero domains to Alibaba Cloud and refreshes without reconnecting", async () => {
    const onRefreshAliyunDomains = vi.fn().mockResolvedValue(undefined);
    render(
      <SiteOpsConversationPanel
        observation={observation({
          aliyunConnection: {
            configured: true,
            status: "active",
            verifiedAt: "2026-08-22T00:00:00.000Z",
            canDisconnect: true,
          },
        })}
        aliyunDomains={[]}
        onRefreshAliyunDomains={onRefreshAliyunDomains}
      />,
    );

    expect(
      screen.getByText("这个阿里云账号中还没有可接入的域名"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "前往阿里云购买域名" }),
    ).toHaveAttribute("href", "https://wanwang.aliyun.com/domain/");
    fireEvent.click(screen.getByRole("button", { name: "已购买，刷新域名" }));
    await waitFor(() => expect(onRefreshAliyunDomains).toHaveBeenCalledOnce());
    expect(screen.queryByRole("button", { name: "一键连接阿里云" })).toBeNull();
  });

  it("automatically connects the only domain exactly once", async () => {
    const onAction = vi.fn().mockResolvedValue(undefined);
    const view = render(
      <SiteOpsConversationPanel
        observation={observation({
          aliyunConnection: {
            configured: true,
            status: "active",
            verifiedAt: "2026-08-22T00:00:00.000Z",
            canDisconnect: true,
          },
        })}
        aliyunDomains={[
          { domain: "example.com", displayDomain: "example.com" },
        ]}
        onAction={onAction}
      />,
    );

    await waitFor(() =>
      expect(onAction).toHaveBeenCalledWith({
        action: "domain_sync",
        input: { domain: "example.com" },
      }),
    );
    view.rerender(
      <SiteOpsConversationPanel
        observation={observation({
          aliyunConnection: {
            configured: true,
            status: "active",
            verifiedAt: "2026-08-22T00:00:00.000Z",
            canDisconnect: true,
          },
        })}
        aliyunDomains={[
          { domain: "example.com", displayDomain: "example.com" },
        ]}
        onAction={onAction}
      />,
    );
    expect(onAction).toHaveBeenCalledOnce();
  });

  it("offers a safe retry when automatic single-domain connection fails", async () => {
    const onAction = vi
      .fn()
      .mockRejectedValueOnce(new Error("域名自动接入暂时不可用。"))
      .mockResolvedValueOnce(undefined);
    render(
      <SiteOpsConversationPanel
        observation={observation({
          aliyunConnection: {
            configured: true,
            status: "active",
            verifiedAt: "2026-08-22T00:00:00.000Z",
            canDisconnect: true,
          },
        })}
        aliyunDomains={[
          { domain: "example.com", displayDomain: "example.com" },
        ]}
        onAction={onAction}
      />,
    );

    expect(
      await screen.findByRole("button", { name: "重试接入" }),
    ).toBeEnabled();
    expect(onAction).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole("button", { name: "重试接入" }));
    await waitFor(() => expect(onAction).toHaveBeenCalledTimes(2));
    expect(onAction).toHaveBeenLastCalledWith({
      action: "domain_sync",
      input: { domain: "example.com" },
    });
  });

  it("lets the customer choose one of multiple purchased domains", async () => {
    const onAction = vi.fn().mockResolvedValue(undefined);
    render(
      <SiteOpsConversationPanel
        observation={observation({
          aliyunConnection: {
            configured: true,
            status: "active",
            verifiedAt: "2026-08-22T00:00:00.000Z",
            canDisconnect: true,
          },
        })}
        aliyunDomains={[
          { domain: "first.example", displayDomain: "first.example" },
          { domain: "xn--fiqs8s.example", displayDomain: "中国.example" },
        ]}
        onAction={onAction}
      />,
    );

    fireEvent.change(screen.getByLabelText("选择要上线的域名"), {
      target: { value: "xn--fiqs8s.example" },
    });
    fireEvent.click(screen.getByRole("button", { name: "连接并配置解析" }));
    await waitFor(() =>
      expect(onAction).toHaveBeenCalledWith({
        action: "domain_sync",
        input: { domain: "xn--fiqs8s.example" },
      }),
    );
    expect(
      screen.queryByRole("button", { name: /查询可注册性|购买报价|自动续费/u }),
    ).toBeNull();
  });

  it("shows only customer-facing domain and DNS state", () => {
    render(
      <SiteOpsConversationPanel
        observation={observation({
          domainState: {
            domain: "example.com",
            displayDomain: "example.com",
            revision: 4,
            ownershipStatus: "verified",
            dnsStatus: "active",
            icpStatus: "approved",
            icpDomainRevision: 4,
            icpVerifiedAt: "2026-08-22T00:00:00.000Z",
          },
        })}
        onAction={vi.fn()}
      />,
    );

    expect(screen.getByText(/解析：已生效/u)).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(
      /RecordId|CNAME|TXT|供应商快照|DNS 精确差异/u,
    );
  });

  it("submits the current domain through the existing ICP filing entry", async () => {
    const onSubmitIcpFiling = vi.fn().mockResolvedValue(undefined);
    render(
      <SiteOpsConversationPanel
        observation={observation({
          domainState: {
            domain: "example.com",
            displayDomain: "example.com",
            revision: 7,
            ownershipStatus: "verified",
            dnsStatus: "active",
            icpStatus: "not_submitted",
            icpDomainRevision: null,
            icpVerifiedAt: null,
          },
        })}
        onSubmitIcpFiling={onSubmitIcpFiling}
      />,
    );

    fireEvent.change(screen.getByLabelText("当前域名版本的 ICP 主体备案号"), {
      target: { value: "京ICP备12345678号" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "提交现有 ICP 核验工单" }),
    );
    await waitFor(() =>
      expect(onSubmitIcpFiling).toHaveBeenCalledWith({
        domain: "example.com",
        icpNumber: "京ICP备12345678号",
      }),
    );
  });

  it("keeps a failed 2.9 revision draft and retries text plus images", async () => {
    const onSubmitRevision = vi
      .fn()
      .mockRejectedValueOnce(new Error("上传暂时失败"))
      .mockResolvedValueOnce(undefined);
    const previewBuild = {
      id: "33333333-3333-4333-8333-333333333333",
      ordinal: 1,
      parentBuildId: null,
      status: "preview_ready" as const,
      previewUrl:
        "/api/site-ops/builds/33333333-3333-4333-8333-333333333333/preview/",
      sourceUrl: null,
      revisionInputs: [
        {
          filename: "上一版产品图.png",
          mimeType: "image/png" as const,
          sizeBytes: 128,
          publicPath: `/frontmind-user-media/${"a".repeat(64)}.png`,
        },
      ],
      needsHelp: false,
      createdAt: "2026-08-22T00:00:00.000Z",
      updatedAt: "2026-08-22T00:01:00.000Z",
    };
    render(
      <SiteOpsConversationPanel
        observation={observation({
          visualGeneration: {
            ...observation().visualGeneration,
            workflowVersion: "2.9.0",
          },
          builds: [previewBuild],
          interactionState: "preview_ready",
        })}
        onAction={vi.fn()}
        onSubmitRevision={onSubmitRevision}
      />,
    );

    const text = screen.getByLabelText("修改要求");
    const file = new File([new Uint8Array([1, 2, 3])], "产品图.png", {
      type: "image/png",
      lastModified: 1,
    });
    fireEvent.change(text, { target: { value: "把图片加入产品页" } });
    fireEvent.change(screen.getByLabelText("选择图片"), {
      target: { files: [file] },
    });
    fireEvent.click(screen.getByRole("button", { name: "生成修改版本" }));
    await screen.findByText("上传暂时失败");
    expect(text).toHaveValue("把图片加入产品页");
    expect(screen.getByText("产品图.png")).toBeInTheDocument();
    expect(screen.getByText(/第 1 版 · 上一版产品图.png/u)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "重试提交" }));
    await waitFor(() => expect(onSubmitRevision).toHaveBeenCalledTimes(2));
    expect(onSubmitRevision.mock.calls[1]?.[0]).toMatchObject({
      text: "把图片加入产品页",
      files: [file],
    });
    await waitFor(() => expect(text).toHaveValue(""));
  });

  it("keeps the parent preview visible while a child revision is building", () => {
    render(
      <SiteOpsConversationPanel
        observation={observation({
          builds: [
            {
              id: "44444444-4444-4444-8444-444444444444",
              ordinal: 2,
              parentBuildId: "33333333-3333-4333-8333-333333333333",
              status: "building",
              previewUrl: null,
              sourceUrl: null,
              needsHelp: false,
              createdAt: "2026-08-22T00:02:00.000Z",
              updatedAt: "2026-08-22T00:03:00.000Z",
            },
            {
              id: "33333333-3333-4333-8333-333333333333",
              ordinal: 1,
              parentBuildId: null,
              status: "preview_ready",
              previewUrl:
                "/api/site-ops/builds/33333333-3333-4333-8333-333333333333/preview/",
              sourceUrl: null,
              needsHelp: false,
              createdAt: "2026-08-22T00:00:00.000Z",
              updatedAt: "2026-08-22T00:01:00.000Z",
            },
          ],
          interactionState: "building",
        })}
        onAction={vi.fn()}
      />,
    );

    expect(
      screen.getByRole("button", { name: "在新标签页打开预览" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("修改版本正在生成；完成前继续保留并展示上一版预览。"),
    ).toBeInTheDocument();
  });
});
