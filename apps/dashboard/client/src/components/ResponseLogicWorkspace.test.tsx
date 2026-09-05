import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/components/QuestionMaintenanceRequestDialog", () => ({
  default: ({ disabled }: { disabled?: boolean }) => (
    <button type="button" disabled={disabled}>
      提交应答逻辑修改需求
    </button>
  ),
}));

import ResponseLogicWorkspace, {
  ResponseLogicConfirmationBoard,
  ResponseLogicConfirmationPanel,
  authoritativeResponseLogicTaskMatches,
  canRequestResponseLogicReset,
  canReloadResponseLogicTask,
  durableResponseLogicResetBarrier,
  fetchResponseLogicStructuredDraft,
  fetchResponseLogicTaskStatus,
  isAuthoritativeResponseLogicAssistantMessage,
  isResponseLogicAttachmentExpired,
  isResponseLogicBindingForbiddenCode,
  mergeResponseLogicAttachmentsIntoDraft,
  parseResponseLogicReply,
  projectResponseLogicConversationMessage,
  ResponseLogicTaskStatusError,
  reconcileResponseLogicDrafts,
  responseLogicPersistenceAvailability,
  responseLogicContinuationRevision,
  scopedResponseLogicTaskStartFailure,
  responseLogicTaskStatusIsRetryable,
  shouldHydrateResponseLogicTask,
  shouldUseResponseLogicInitialPrompt,
  useResponseLogicWorkspaceState,
  type IntentQuestionGroup,
} from "./ResponseLogicWorkspace";

const intentQuestionGroups = [
  {
    id: "reputation",
    title: "美誉舆情",
    subtitle: "信任证据与品牌口碑",
    tone: "plum",
    questions: [
      {
        id: "reputation-company",
        question: "示例企业是一家什么样的公司？",
        intent: "用户希望判断企业身份、能力与可信度。",
        summary: "基于已核验的企业事实和证据回答。",
      },
    ],
  },
  {
    id: "scenario",
    title: "产品场景",
    subtitle: "应用需求与决策问答",
    tone: "teal",
    questions: [
      {
        id: "scenario-kb",
        question: "企业如何系统搭建可被 AI 理解的知识库？",
        intent: "用户希望建立可检索、可理解、可引用的企业事实底座。",
        summary: "说明采集、核验、结构化、交付和持续更新流程。",
      },
      {
        id: "scenario-scattered",
        question: "品牌资料分散时如何开展 GEO 优化？",
        intent: "用户需要从分散资料中建立权威事实口径。",
        summary: "先建立资料清单与权威层级，再补齐缺口。",
      },
      {
        id: "scenario-source",
        question: "企业官网怎样成为 AI 可引用的权威信源？",
        intent: "用户希望提升官网内容的可理解性和证据密度。",
        summary: "从展示页面升级为事实清晰、证据完整的权威信息源。",
      },
    ],
  },
] satisfies IntentQuestionGroup[];

function WorkspaceHarness({
  onPublished,
}: {
  onPublished?: (questionId: string) => void;
}) {
  const workspaceState = useResponseLogicWorkspaceState(intentQuestionGroups);
  return (
    <ResponseLogicWorkspace
      preview
      workspaceState={workspaceState}
      questionGroups={intentQuestionGroups}
      onPublished={onPublished}
    />
  );
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("ResponseLogicWorkspace", () => {
  it("has no built-in tenant questions when no server or preview data is injected", () => {
    render(<ResponseLogicWorkspace preview />);

    expect(
      screen.getByRole("heading", { name: "当前周期尚无服务问题" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("示例企业是一家什么样的公司？")).toBeNull();
  });

  it("keeps an explicit empty question list empty instead of loading preview samples", () => {
    render(<ResponseLogicWorkspace preview questionGroups={[]} />);

    expect(
      screen.getByRole("heading", { name: "当前周期尚无服务问题" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("企业资料.pdf")).toBeNull();
    expect(screen.queryByText("现场 图.png")).toBeNull();
    expect(
      screen.queryByText("FrontMind 超前智能是一家什么样的公司？"),
    ).toBeNull();
  });

  it("merges server-verified uploads into the current draft and image evidence", () => {
    const result = mergeResponseLogicAttachmentsIntoDraft(
      {
        concern: "",
        conclusion: "",
        facts: "",
        pending: "",
        boundaries: "",
        references: "",
        images: [],
        attachments: [],
      },
      [
        {
          fileId: "file/image 1",
          filename: "现场照片.png",
          mimeType: "image/png",
          kind: "image",
          uploadedAt: "2026-07-23T10:00:00.000Z",
        },
        {
          fileId: "file-sheet",
          filename: "企业事实.xlsx",
          mimeType:
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          kind: "file",
          uploadedAt: "2026-07-23T10:00:00.000Z",
        },
      ],
    );

    expect(result.attachments).toHaveLength(2);
    expect(result.images).toEqual([
      expect.objectContaining({
        name: "现场照片.png",
        url: "/api/frontmind/v1/files/file%2Fimage%201",
        source: "企业交流上传：现场照片.png",
        section: "图文依据",
        authorization: "本次应答可用",
      }),
    ]);
  });

  it("keeps authoritative expiry metadata and removes expired upload images", () => {
    const expiredAt = Date.now() - 1;
    const result = mergeResponseLogicAttachmentsIntoDraft(
      {
        concern: "",
        conclusion: "",
        facts: "",
        pending: "",
        boundaries: "",
        references: "",
        images: [
          {
            id: "response-logic-upload-file-old-image",
            name: "旧图片.png",
            url: "/api/frontmind/v1/files/file-old-image",
            caption: "旧图片",
            source: "企业交流上传：旧图片.png",
            section: "事实依据",
            authorization: "待确认",
          },
        ],
        attachments: [],
      },
      [
        {
          fileId: "file-old-image",
          filename: "旧图片.png",
          mimeType: "image/png",
          kind: "image",
          uploadedAt: "2026-07-01T00:00:00.000Z",
          expiresAt: expiredAt,
          expired: true,
        },
      ],
    );

    expect(result.images).toEqual([]);
    expect(result.attachments[0]).toMatchObject({
      expiresAt: expiredAt,
      expired: true,
    });
    expect(isResponseLogicAttachmentExpired(result.attachments[0]!)).toBe(true);
  });

  it("uses owned-file previews and unloads an uploaded image at its hard deadline", async () => {
    const now = Date.parse("2026-08-04T00:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const fetchMock = vi.fn().mockResolvedValue(
      new Response("image", {
        status: 200,
        headers: { "Content-Type": "image/png" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    render(
      <ResponseLogicConfirmationPanel
        group={intentQuestionGroups[0]}
        question={intentQuestionGroups[0].questions[0]}
        logic={{
          concern: "可信度",
          conclusion: "结论",
          facts: "事实",
          pending: "待补充",
          boundaries: "边界",
          references: "引用",
          version: 1,
          updatedAt: "2026-08-04T00:00:00.000Z",
          images: [
            {
              id: "response-logic-upload-image/中文 #1",
              name: "现场 图.png",
              url: "/legacy-url-must-not-be-used",
              caption: "现场图",
              source: "企业交流上传",
              section: "事实依据",
              authorization: "待确认",
            },
          ],
          attachments: [
            {
              fileId: "image/中文 #1",
              filename: "现场 图.png",
              mimeType: "image/png",
              kind: "image",
              uploadedAt: "2026-08-04T00:00:00.000Z",
              expiresAt: now + 1_000,
            },
            {
              fileId: "document/中文 #1",
              filename: "企业资料.pdf",
              mimeType: "application/pdf",
              kind: "file",
              uploadedAt: "2026-08-04T00:00:00.000Z",
              expiresAt: now + 10_000,
            },
          ],
        }}
      />,
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/frontmind/v1/files/image%2F%E4%B8%AD%E6%96%87%20%231",
      expect.objectContaining({ credentials: "include" }),
    );
    expect(
      screen.getByText("用户上传资料").closest('[role="button"]'),
    ).toBeInTheDocument();
    expect(
      document.querySelector('a[href*="/api/frontmind/v1/files/"]'),
    ).toBeNull();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(
      screen.getByText("文件已超过 30 天，请重新上传"),
    ).toBeInTheDocument();
    expect(screen.queryByRole("img", { name: "用户上传图片" })).toBeNull();
  });

  it("maps the four-section Skill output into the editable response fields", () => {
    expect(
      parseResponseLogicReply(`## 用户真实关心
采购方需要判断方案是否可信。

## 核心结论/执行口径
先给出结论，再按证据解释。

## 企业材料/官方依据
- 企业定位（来源路径：knowledge_base/company.md）来自已核验资料。

## 回答边界/禁止表达
- 不使用绝对化排名`),
    ).toEqual({
      concern: "采购方需要判断方案是否可信。",
      conclusion: "先给出结论，再按证据解释。",
      facts: "- 企业定位（引自知识库文档）来自已核验资料。",
      pending: "",
      boundaries: "- 不使用绝对化排名",
      references: "",
    });
  });

  it("accepts an exact legacy five-section reply without retaining references", () => {
    expect(
      parseResponseLogicReply(`## 用户真实关心
采购方需要判断方案是否可信。

## 核心结论/执行口径
先给出结论。

## 企业材料/官方依据
- 企业知识库

## 回答边界/禁止表达
- 不使用绝对化表达

## 引用与核验规则
- 企业事实表.pdf`),
    ).toMatchObject({
      concern: "采购方需要判断方案是否可信。",
      pending: "",
      references: "",
    });
  });

  it("accepts an exact legacy seven-section reply without retaining confirmation prompts", () => {
    expect(
      parseResponseLogicReply(`## 用户真实关心
采购方需要判断方案是否可信。

## 核心结论/执行口径
先给出结论。

## 企业材料/官方依据
- 企业知识库

## 待补充/待确认
- 授权范围

## 回答边界/禁止表达
- 不使用绝对化表达

## 引用与核验规则
- 企业事实表.pdf

## 本轮确认
请确认。`),
    ).toMatchObject({
      concern: "采购方需要判断方案是否可信。",
      pending: "",
      references: "",
    });
  });

  it("never accepts arbitrary or partially structured model text", () => {
    expect(() => parseResponseLogicReply("这是一段任意回复。")).toThrow();
    expect(() =>
      parseResponseLogicReply(`## 用户真实关心
只有一个栏目。`),
    ).toThrow();
    expect(() =>
      parseResponseLogicReply(`## 用户真实关心
采购方需要判断方案是否可信。

## 核心结论/执行口径
先给出结论。

## 企业材料/官方依据
- 企业知识库

## 待补充/待确认
- 授权范围

## 回答边界/禁止表达
- 不使用绝对化表达

## 引用与核验规则
- 企业事实表

## 本轮确认
请确认。

## 额外说明
不允许。`),
    ).toThrow();
  });

  it("accepts provider-owned file-only outputs and rejects local error bubbles", () => {
    expect(
      isAuthoritativeResponseLogicAssistantMessage({
        id: "output-file",
        upstreamOutputId: "provider-output-file",
        role: "assistant",
        content: "",
        timestamp: 1,
        outputFiles: [
          {
            fileUrl: "/api/frontmind/v1/files/output-md",
            fileName: "用户真实关心.md",
            mimeType: "text/markdown",
          },
        ],
      }),
    ).toBe(true);
    expect(
      isAuthoritativeResponseLogicAssistantMessage({
        id: "provider-text-without-output-id",
        role: "assistant",
        content: "服务端返回的应答正文",
        responseStartedAt: 1,
        timestamp: 2,
      }),
    ).toBe(true);
    expect(
      isAuthoritativeResponseLogicAssistantMessage({
        id: "local-error",
        role: "assistant",
        content: "错误：请求未完成，请稍后手动重试。",
        timestamp: 2,
      }),
    ).toBe(false);
  });

  it("keeps the live editor mounted while records refresh in the background", () => {
    expect(
      responseLogicPersistenceAvailability({
        isLoading: false,
        isFetching: true,
        isSuccess: true,
        isError: false,
        hasData: true,
      }),
    ).toEqual({ loading: false, ready: true, error: undefined });
    expect(
      responseLogicPersistenceAvailability({
        isLoading: false,
        isFetching: false,
        isSuccess: false,
        isError: true,
        hasData: true,
        errorMessage: "后台刷新失败",
      }),
    ).toEqual({ loading: false, ready: true, error: undefined });
  });

  it("projects legacy assistant bubbles without mutating the stored message", () => {
    const message = {
      id: "legacy-response",
      role: "assistant" as const,
      content: `## 用户真实关心
查看 FINAL.zip 中的产品信息。

## 核心结论/执行口径
核心产品见 knowledge_base/products/3.2.md。

## 企业材料/官方依据
来源文件：FINAL.zip；平台支持 200 个模型。

## 待补充/待确认
请确认图片权限。

## 回答边界/禁止表达
不使用绝对排名。

## 引用与核验规则
引用文档：products/3.2.md

## 本轮确认
是否公开图片？`,
      outputFiles: [
        {
          fileUrl: "/api/files/internal-products.md",
          fileName: "internal-products.md",
          mimeType: "text/markdown",
        },
      ],
      stepGroups: [
        {
          id: "step-group",
          title: "读取 knowledge_base/products/3.2.md",
          description: "核验 FINAL.zip",
          steps: [
            {
              id: "step",
              type: "reasoning",
              label: "分析 sources/private.json",
              details: "保留 AI/ML 事实",
            },
          ],
        },
      ],
      timestamp: 1,
    };

    const projected = projectResponseLogicConversationMessage(message);

    expect(projected).not.toBe(message);
    expect(projected.content).toContain("平台支持 200 个模型");
    expect(projected.content).toContain("引自知识库文档");
    expect(projected.content).toContain(
      "## 企业材料/官方依据（引自知识库文档）",
    );
    expect(projected.content).not.toMatch(/^## 企业材料\/官方依据$/mu);
    expect(projected.content).not.toContain("引用与核验规则");
    expect(projected.content).not.toMatch(
      /FINAL\.zip|knowledge_base|待补充\/待确认|本轮确认/u,
    );
    expect(projected.outputFiles?.[0]?.fileName).toBe("模型输出资料.md");
    expect(projected.stepGroups?.[0]?.title).toBe("读取 知识库文档");
    expect(projected.stepGroups?.[0]?.description).toBe("核验 知识库文档");
    expect(projected.stepGroups?.[0]?.steps[0]?.label).toBe("分析 知识库文档");
    expect(projected.stepGroups?.[0]?.steps[0]?.details).toBe(
      "保留 AI/ML 事实",
    );
    expect(message.content).toContain("FINAL.zip");
  });

  it("preserves an unsaved draft on refresh and removes it after an external reset", () => {
    const serverDraft = {
      concern: "服务端原始内容",
      conclusion: "结论",
      facts: "事实",
      pending: "待补充",
      boundaries: "边界",
      references: "引用",
      images: [],
      attachments: [],
    };
    const localDraft = { ...serverDraft, concern: "尚未保存的本地修改" };
    const record = {
      id: "record-1",
      questionId: "question-1",
      groupId: "group-1",
      groupTitle: "产品场景",
      question: "硅基流动有什么核心产品？",
      intent: "了解产品线",
      summary: "基于企业事实回答",
      draft: serverDraft,
      revision: 2,
      version: 0,
      createdAt: 1,
      updatedAt: 2,
    };
    const previouslySynced = new Set(["question-1"]);

    expect(
      reconcileResponseLogicDrafts(
        { "question-1": localDraft },
        [record],
        previouslySynced,
      )["question-1"],
    ).toBe(localDraft);
    expect(
      reconcileResponseLogicDrafts(
        { "question-1": localDraft },
        [
          {
            ...record,
            version: 1,
            confirmed: {
              ...serverDraft,
              version: 1,
              updatedAt: "2026-08-07T12:00:00.000Z",
            },
          },
        ],
        previouslySynced,
      )["question-1"],
    ).toBe(serverDraft);
    expect(
      reconcileResponseLogicDrafts(
        { "question-1": localDraft },
        [],
        previouslySynced,
      ),
    ).toEqual({});
  });

  it("uses the fixed prompt only before the first user turn or task", () => {
    expect(
      shouldUseResponseLogicInitialPrompt(
        { messages: [], taskId: undefined, previousResponseId: undefined },
        false,
      ),
    ).toBe(true);
    expect(
      shouldUseResponseLogicInitialPrompt(
        {
          messages: [{ role: "user" }],
          taskId: undefined,
          previousResponseId: undefined,
        },
        false,
      ),
    ).toBe(false);
    expect(
      shouldUseResponseLogicInitialPrompt(
        { messages: [], taskId: "task-1", previousResponseId: "task-1" },
        false,
      ),
    ).toBe(false);
  });

  it("loads a structured draft only from the dedicated authenticated status endpoint", async () => {
    const structuredDraft = {
      concern: "用户关心可信度",
      conclusion: "先结论后证据",
      facts: "企业知识库 V3",
      boundaries: "禁止绝对化",
    };
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          status: "completed",
          taskId: "task/1",
          operationRevision: 7,
          model: "frontmind-pro",
          resultId: "result-1",
          source: "structured_output",
          structuredDraft,
        }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      fetchResponseLogicStructuredDraft({
        questionId: "question-1",
        conversationId: "conversation-1",
        taskId: "task/1",
        operationRevision: 7,
      }),
    ).resolves.toEqual(structuredDraft);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/response-logic/tasks/task%2F1/status?questionId=question-1&conversationId=conversation-1&operationRevision=7",
      expect.objectContaining({
        method: "GET",
        credentials: "include",
      }),
    );
  });

  it("observes the dedicated 202 → 202 → 200 lifecycle without assistant messages", async () => {
    const responses = [
      {
        status: "running",
        taskId: "task-sequence",
        operationRevision: 8,
        model: "frontmind-pro",
      },
      {
        status: "result_pending",
        taskId: "task-sequence",
        operationRevision: 8,
        model: "frontmind-pro",
      },
      {
        status: "completed",
        taskId: "task-sequence",
        operationRevision: 8,
        model: "frontmind-pro",
        resultId: "result-sequence",
        source: "structured_output",
        structuredDraft: {
          concern: "用户关心",
          conclusion: "核心结论",
          facts: "事实依据",
          boundaries: "回答边界",
        },
      },
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async () => {
        const payload = responses.shift()!;
        return {
          ok: true,
          status: payload.status === "completed" ? 200 : 202,
          text: async () => JSON.stringify(payload),
        };
      }),
    );
    const input = {
      questionId: "question-1",
      conversationId: "conversation-with-zero-assistant-messages",
      taskId: "task-sequence",
      operationRevision: 8,
    };

    await expect(fetchResponseLogicTaskStatus(input)).resolves.toMatchObject({
      status: "running",
    });
    await expect(fetchResponseLogicTaskStatus(input)).resolves.toMatchObject({
      status: "result_pending",
    });
    await expect(fetchResponseLogicTaskStatus(input)).resolves.toMatchObject({
      status: "completed",
      resultId: "result-sequence",
    });
    expect(
      canReloadResponseLogicTask({
        taskId: "task-sequence",
        readOnly: false,
        loading: false,
      }),
    ).toBe(true);
    expect(
      canReloadResponseLogicTask({
        taskId: "task-sequence",
        readOnly: false,
        loading: false,
        resetRequired: true,
      }),
    ).toBe(false);
  });

  it("scopes a delayed start failure to its exact question and conversation", () => {
    const failure = {
      code: "RESPONSE_LOGIC_START_OUTCOME_UNKNOWN",
      message: "任务结果未知",
      retryable: false,
      resetRequired: true,
      stage: "task_create" as const,
      questionId: "question-a",
      conversationId: "conversation-a",
    };

    expect(
      scopedResponseLogicTaskStartFailure({
        failure,
        questionId: "question-a",
        conversationId: "conversation-a",
      }),
    ).toBe(failure);
    expect(
      scopedResponseLogicTaskStartFailure({
        failure,
        questionId: "question-b",
        conversationId: "conversation-b",
      }),
    ).toBeNull();
  });

  it("restores a reset-required barrier from the durable conversation after remount", () => {
    const conversation = {
      id: "conversation-reset-required",
      status: "error" as const,
      messages: [
        {
          id: "msg-response-logic-reset-required-1787150000000",
          role: "assistant" as const,
          content: "任务创建结果无法确认，请先申请重置。",
          timestamp: 1,
        },
      ],
    };

    expect(
      durableResponseLogicResetBarrier({
        conversation,
        questionId: "question-1",
      }),
    ).toMatchObject({
      questionId: "question-1",
      conversationId: conversation.id,
      resetRequired: true,
    });
    expect(
      durableResponseLogicResetBarrier({
        conversation: { ...conversation, status: "running" },
        questionId: "question-1",
      }),
    ).toBeNull();
  });

  it("keeps a dedicated 401/403 observation retryable instead of declaring a model failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 403,
        text: async () =>
          JSON.stringify({
            error: { code: "FORBIDDEN", message: "会话权限正在刷新" },
          }),
      }),
    );
    const error = await fetchResponseLogicTaskStatus({
      questionId: "question-1",
      conversationId: "conversation-1",
      taskId: "task-1",
      operationRevision: 3,
    }).catch((caught) => caught);
    expect(error).toMatchObject({
      code: "FORBIDDEN",
      options: { status: 403, retryable: true, stage: "http" },
    });
  });

  it("terminates an exact binding-forbidden tuple but retries generic auth refreshes", async () => {
    expect(
      responseLogicTaskStatusIsRetryable(403, "RESPONSE_LOGIC_TASK_FORBIDDEN"),
    ).toBe(false);
    expect(
      isResponseLogicBindingForbiddenCode("RESPONSE_LOGIC_TASK_FORBIDDEN"),
    ).toBe(true);
    expect(
      responseLogicTaskStatusIsRetryable(
        403,
        "RESPONSE_LOGIC_OPERATION_FORBIDDEN",
      ),
    ).toBe(false);
    expect(responseLogicTaskStatusIsRetryable(403, "FORBIDDEN")).toBe(true);
    expect(responseLogicTaskStatusIsRetryable(401, "UNAUTHORIZED")).toBe(true);
    expect(responseLogicTaskStatusIsRetryable(503, "UPSTREAM_DOWN")).toBe(true);

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 403,
        text: async () =>
          JSON.stringify({
            error: {
              code: "RESPONSE_LOGIC_TASK_FORBIDDEN",
              message: "当前任务已被替换",
            },
          }),
      }),
    );
    const bindingError = await fetchResponseLogicTaskStatus({
      questionId: "question-1",
      conversationId: "conversation-1",
      taskId: "task-1",
      operationRevision: 3,
    }).catch((caught) => caught);
    expect(bindingError).toMatchObject({
      code: "RESPONSE_LOGIC_TASK_FORBIDDEN",
      options: { status: 403, retryable: false, stage: "http" },
    });
  });

  it("rejects a reset or T1→T2 replacement before applying a completed result", () => {
    expect(
      authoritativeResponseLogicTaskMatches({
        records: [],
        questionId: "question-1",
        taskId: "task-1",
        operationRevision: 3,
      }),
    ).toBe(false);
    expect(
      authoritativeResponseLogicTaskMatches({
        records: [
          { questionId: "question-1", lastTaskId: "task-2", revision: 3 },
        ],
        questionId: "question-1",
        taskId: "task-1",
        operationRevision: 3,
      }),
    ).toBe(false);
    expect(
      authoritativeResponseLogicTaskMatches({
        records: [
          { questionId: "question-1", lastTaskId: "task-1", revision: 4 },
        ],
        questionId: "question-1",
        taskId: "task-1",
        operationRevision: 3,
      }),
    ).toBe(false);
    expect(
      authoritativeResponseLogicTaskMatches({
        records: [
          { questionId: "question-1", lastTaskId: "task-1", revision: 3 },
        ],
        questionId: "question-1",
        taskId: "task-1",
        operationRevision: 3,
      }),
    ).toBe(true);
  });

  it("continues only with the latest persisted record revision", () => {
    expect(
      responseLogicContinuationRevision({
        persistedRevision: 9,
        activeTaskRevision: 8,
      }),
    ).toBe(9);
    expect(
      responseLogicContinuationRevision({
        persistedRevision: undefined,
        activeTaskRevision: 8,
      }),
    ).toBeUndefined();
  });

  it("allows reset for any persisted draft or failed record, not only a confirmation", () => {
    expect(
      canRequestResponseLogicReset({
        preview: false,
        record: { questionId: "question-draft" },
      }),
    ).toBe(true);
    expect(
      canRequestResponseLogicReset({
        preview: false,
        record: undefined,
      }),
    ).toBe(false);
    expect(
      canRequestResponseLogicReset({
        preview: true,
        record: { questionId: "question-preview" },
      }),
    ).toBe(false);
  });

  it("rejects malformed structured status payloads from the client boundary", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            status: "completed",
            taskId: "task-1",
            operationRevision: 3,
            model: "frontmind-pro",
            resultId: "result-invalid",
            source: "structured_output",
            structuredDraft: {
              concern: "only one field",
            },
          }),
      }),
    );

    await expect(
      fetchResponseLogicStructuredDraft({
        questionId: "question-1",
        conversationId: "conversation-1",
        taskId: "task-1",
        operationRevision: 3,
      }),
    ).rejects.toThrow("未通过传输协议校验");
  });

  it("distinguishes a truncated JSON delivery from an invalid model result", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => '{"status":"completed","structuredDraft":',
      }),
    );

    const error = await fetchResponseLogicStructuredDraft({
      questionId: "question-1",
      conversationId: "conversation-1",
      taskId: "task-1",
      operationRevision: 3,
    }).catch((caught) => caught);
    expect(error).toBeInstanceOf(ResponseLogicTaskStatusError);
    expect(error).toMatchObject({
      code: "RESPONSE_LOGIC_TASK_RESPONSE_INVALID_JSON",
      options: { retryable: true, stage: "response" },
    });
  });

  it("preserves the server task error code so only unavailable tasks reset the local pointer", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 422,
        text: async () =>
          JSON.stringify({
            error: {
              code: "RESPONSE_LOGIC_TASK_UNAVAILABLE",
              message: "原应答逻辑任务已不存在，请重新生成",
            },
          }),
      }),
    );

    const error = await fetchResponseLogicStructuredDraft({
      questionId: "question-1",
      conversationId: "conversation-1",
      taskId: "task-gone",
      operationRevision: 3,
    }).catch((caught) => caught);
    expect(error).toBeInstanceOf(ResponseLogicTaskStatusError);
    expect(error).toMatchObject({
      code: "RESPONSE_LOGIC_TASK_UNAVAILABLE",
      message: "原应答逻辑任务已不存在，请重新生成",
    });
  });

  it("does not restore a released task from stale records while its refetch completes", () => {
    const unavailableTaskIds = new Set(["task-gone"]);
    expect(
      shouldHydrateResponseLogicTask({
        authoritativeTaskId: "task-gone",
        unavailableTaskIds,
      }),
    ).toBe(false);
    expect(
      shouldHydrateResponseLogicTask({
        authoritativeTaskId: undefined,
        unavailableTaskIds,
      }),
    ).toBe(false);
    expect(
      shouldHydrateResponseLogicTask({
        authoritativeTaskId: "task-new",
        unavailableTaskIds,
      }),
    ).toBe(true);
    expect(
      shouldHydrateResponseLogicTask({
        authoritativeTaskId: "task-new",
        unavailableTaskIds,
        resetRequired: true,
      }),
    ).toBe(false);
  });

  it("keeps the editor as the only view and does not present a prefill as published", async () => {
    render(<WorkspaceHarness />);

    expect(
      await screen.findByRole("heading", { name: "应答逻辑智能体" }),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "应答逻辑确认" })).toBeNull();
    expect(
      screen.queryByRole("region", { name: "当前已发布应答逻辑" }),
    ).toBeNull();
  });

  it("expands and restores the complete workspace without remounting its inputs", async () => {
    document.body.style.overflow = "auto";
    document.documentElement.style.overflow = "scroll";
    const { container } = render(<WorkspaceHarness />);
    const composer =
      await screen.findByPlaceholderText("补充企业事实、修改意见或待核验资料…");
    const facts = screen.getByLabelText(/企业材料\/官方依据（引自知识库文档）/);
    const workspace = container.querySelector(".response-logic-workspace");
    const questionNavigator = container.querySelector(".rl-question-nav");
    const questionList = container.querySelector(".rl-question-list");
    const questionContext = container.querySelector(".rl-question-context");
    const dialogue = container.querySelector(".rl-dialogue-card");
    const editor = container.querySelector(".rl-editor-card");
    const editorScroll = container.querySelector(".rl-editor-scroll");
    fireEvent.change(composer, { target: { value: "尚未发送的修改内容" } });
    fireEvent.change(facts, { target: { value: "尚未确认的知识库事实" } });
    if (questionList) questionList.scrollTop = 31;
    if (editorScroll) editorScroll.scrollTop = 47;

    fireEvent.click(screen.getByRole("button", { name: "进入全屏" }));
    expect(workspace).toHaveClass("rl-workspace-expanded");
    expect(screen.getByRole("button", { name: "退出全屏" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(
      screen.getByRole("heading", { name: "应答逻辑智能体" }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "需求记录" })).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "提交应答逻辑修改需求" }),
    ).toBeTruthy();
    expect(screen.getByText("待优化问题")).toBeTruthy();
    expect(container.querySelector(".rl-question-nav")).toBe(questionNavigator);
    expect(container.querySelector(".rl-question-context")).toBe(
      questionContext,
    );
    expect(container.querySelector(".rl-dialogue-card")).toBe(dialogue);
    expect(container.querySelector(".rl-editor-card")).toBe(editor);
    expect(
      screen.getByPlaceholderText("补充企业事实、修改意见或待核验资料…"),
    ).toBe(composer);
    expect((composer as HTMLTextAreaElement).value).toBe("尚未发送的修改内容");
    expect(screen.getByLabelText(/企业材料\/官方依据（引自知识库文档）/)).toBe(
      facts,
    );
    expect((facts as HTMLTextAreaElement).value).toBe("尚未确认的知识库事实");
    expect(document.body.style.overflow).toBe("hidden");
    expect(document.documentElement.style.overflow).toBe("hidden");

    fireEvent.keyDown(document, { key: "Escape" });
    expect(workspace).not.toHaveClass("rl-workspace-expanded");
    expect(screen.getByRole("button", { name: "进入全屏" })).toBeTruthy();
    expect(document.body.style.overflow).toBe("auto");
    expect(document.documentElement.style.overflow).toBe("scroll");

    fireEvent.click(screen.getByRole("button", { name: "进入全屏" }));
    fireEvent.click(screen.getByRole("button", { name: "退出全屏" }));
    expect(workspace).not.toHaveClass("rl-workspace-expanded");
    expect(screen.getByRole("button", { name: "进入全屏" })).toBeTruthy();
    expect(screen.getByLabelText(/企业材料\/官方依据/)).toBe(facts);
    expect(questionList?.scrollTop).toBe(31);
    expect(editorScroll?.scrollTop).toBe(47);

    document.body.style.overflow = "";
    document.documentElement.style.overflow = "";
  });

  it("renders confirmed response logic as Markdown without pending or internal source details", () => {
    const { container } = render(
      <ResponseLogicConfirmationPanel
        group={intentQuestionGroups[0]}
        question={intentQuestionGroups[0].questions[0]}
        logic={{
          concern: "用户需要判断 **产品能力边界**。",
          conclusion: "**公有云服务**\n\n1. 无服务器词元服务\n2. 专属实例",
          facts:
            "- 产品体系（来源路径：knowledge_base/products/3.2.md）引自企业资料。",
          pending: "不应展示的待确认内容",
          boundaries: "- 不得使用 **行业第一** 等绝对表述。",
          references:
            "知识库版本：V1，来源文件：FINAL.zip\n引用文档：products/3.2.md",
          version: 1,
          updatedAt: "2026-08-07T00:00:00.000Z",
          images: [],
          attachments: [],
        }}
      />,
    );

    expect(
      [...container.querySelectorAll("strong")].some(
        (node) => node.textContent === "公有云服务",
      ),
    ).toBe(true);
    expect(container.querySelector("ol")).toBeTruthy();
    expect(screen.queryByText(/\*\*公有云服务\*\*/)).toBeNull();
    expect(screen.queryByText("待补充/待确认")).toBeNull();
    expect(screen.queryByText("不应展示的待确认内容")).toBeNull();
    expect(screen.queryByText("引用与核验规则及图文依据")).toBeNull();
    expect(screen.queryByText("图文依据")).toBeNull();
    expect(
      screen.getByRole("heading", {
        name: "企业材料/官方依据（引自知识库文档）",
      }),
    ).toBeInTheDocument();
    expect(container.textContent).not.toContain("FINAL.zip");
    expect(container.textContent).not.toContain("products/3.2.md");
  });

  it("publishes manually, reports the same question to the parent, and does not append output below the agent", async () => {
    const onPublished = vi.fn();
    render(<WorkspaceHarness onPublished={onPublished} />);

    const conclusion = await screen.findByLabelText(/核心结论/);
    fireEvent.change(conclusion, {
      target: { value: "这是企业交流后人工确认的新核心结论。" },
    });

    const composer =
      screen.getByPlaceholderText("补充企业事实、修改意见或待核验资料…");
    fireEvent.change(composer, {
      target: { value: "补充一份可公开的企业资质说明。" },
    });
    fireEvent.click(screen.getByRole("button", { name: "发送消息" }));
    expect(screen.getByText("补充一份可公开的企业资质说明。")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /载入最新回复/ }));
    expect(
      (screen.getByLabelText(/企业材料\/官方依据/) as HTMLTextAreaElement)
        .value,
    ).toContain("补充一份可公开的企业资质说明");

    fireEvent.click(screen.getByRole("button", { name: /更新应答逻辑/ }));
    expect(
      screen.getByRole("heading", { name: "确认当前应答逻辑？" }),
    ).toBeInTheDocument();
    expect(screen.getByText(/不能直接修改/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "确认并锁定" }));

    await waitFor(() => {
      expect(onPublished).toHaveBeenCalledWith("reputation-company");
    });
    expect(
      screen.queryByRole("region", { name: "当前已发布应答逻辑" }),
    ).toBeNull();
    expect(screen.getByText(/应答逻辑已确认，可在问题优化中查看/)).toBeTruthy();
    expect(screen.getByLabelText(/核心结论/)).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "应答逻辑已确认" }),
    ).toBeDisabled();
  });

  it("offers a direct update action for a confirmed question in Problem Optimization", async () => {
    const onOpenAgent = vi.fn();
    const targetQuestion = intentQuestionGroups[1].questions[1];

    render(
      <ResponseLogicConfirmationBoard
        preview
        previewPublished
        questionGroups={intentQuestionGroups}
        initialQuestionId={targetQuestion.id}
        onOpenAgent={onOpenAgent}
      />,
    );

    expect((await screen.findAllByText("应答逻辑")).length).toBeGreaterThan(0);
    expect(screen.queryByText("ANSWER LOGIC")).toBeNull();
    fireEvent.click(
      screen.getByRole("button", {
        name: "查看已确认应答逻辑",
      }),
    );
    expect(onOpenAgent).toHaveBeenCalledWith(targetQuestion.id);
  });

  it("filters and selects questions inside the single question list", async () => {
    render(<WorkspaceHarness />);

    expect(await screen.findByText("待优化问题")).toBeTruthy();
    expect(screen.queryByText(/20\s*个问题/)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /^产品场景$/ }));
    fireEvent.click(
      screen.getByRole("button", {
        name: /企业官网怎样成为 AI 可引用的权威信源/,
      }),
    );

    expect(
      screen.getByRole("heading", {
        name: "企业官网怎样成为 AI 可引用的权威信源？",
      }),
    ).toBeTruthy();
    expect(
      screen.getAllByText(/从展示页面升级为事实清晰/).length,
    ).toBeGreaterThan(0);
  });

  it("keeps one independent conversation per question without stacking switch notices", async () => {
    render(<WorkspaceHarness />);

    const composer =
      await screen.findByPlaceholderText("补充企业事实、修改意见或待核验资料…");
    fireEvent.change(composer, {
      target: { value: "第一个问题的专属补充。" },
    });
    fireEvent.click(screen.getByRole("button", { name: "发送消息" }));

    fireEvent.click(screen.getByRole("button", { name: /^产品场景$/ }));
    expect(screen.queryByText("第一个问题的专属补充。")).toBeNull();
    expect(
      screen.getByText(/当前只讨论“企业如何系统搭建可被 AI 理解的知识库？”/),
    ).toBeTruthy();

    fireEvent.change(
      screen.getByPlaceholderText("补充企业事实、修改意见或待核验资料…"),
      {
        target: { value: "第二个问题的专属补充。" },
      },
    );
    fireEvent.click(screen.getByRole("button", { name: "发送消息" }));

    fireEvent.click(screen.getByRole("button", { name: /^美誉舆情$/ }));
    expect(screen.getByText("第一个问题的专属补充。")).toBeTruthy();
    expect(screen.queryByText("第二个问题的专属补充。")).toBeNull();
    expect(
      screen.getAllByText(/当前只讨论“示例企业是一家什么样的公司？”/),
    ).toHaveLength(1);
  });

  it("keeps the message list as an internal scroll region and follows the latest message", async () => {
    const scrollHeight = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      "scrollHeight",
    );
    Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
      configurable: true,
      get: () => 480,
    });

    try {
      render(<WorkspaceHarness />);

      const messageLog = await screen.findByRole("log", {
        name: "当前问题对话记录",
      });
      await waitFor(() => {
        expect(messageLog.scrollTop).toBe(480);
      });

      fireEvent.change(
        screen.getByPlaceholderText("补充企业事实、修改意见或待核验资料…"),
        {
          target: { value: "触发新消息后仍定位到底部。" },
        },
      );
      fireEvent.click(screen.getByRole("button", { name: "发送消息" }));
      await waitFor(() => {
        expect(messageLog.scrollTop).toBe(480);
      });
    } finally {
      if (scrollHeight) {
        Object.defineProperty(
          HTMLElement.prototype,
          "scrollHeight",
          scrollHeight,
        );
      } else {
        Reflect.deleteProperty(HTMLElement.prototype, "scrollHeight");
      }
    }
  });
});
