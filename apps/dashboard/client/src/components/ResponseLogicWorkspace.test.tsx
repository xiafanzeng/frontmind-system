import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import ResponseLogicWorkspace, {
  ResponseLogicConfirmationBoard,
  ResponseLogicConfirmationPanel,
  fetchResponseLogicStructuredDraft,
  isResponseLogicAttachmentExpired,
  mergeResponseLogicAttachmentsIntoDraft,
  parseResponseLogicReply,
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
        authorization: "待确认",
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
      screen.getByText("企业资料.pdf").closest('[role="button"]'),
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
    expect(screen.queryByRole("img", { name: "现场图" })).toBeNull();
  });

  it("maps the dedicated Skill output into the editable response fields", () => {
    expect(
      parseResponseLogicReply(`## 用户真实关心
采购方需要判断方案是否可信。

## 核心结论/执行口径
先给出结论，再按证据解释。

## 企业材料/官方依据
- 企业知识库 V3

## 待补充/待确认
- 客户案例公开授权

## 回答边界/禁止表达
- 不使用绝对化排名

## 引用与核验规则
- 企业事实确认表.pdf

## 本轮确认
请确认案例是否可公开。`),
    ).toEqual({
      concern: "采购方需要判断方案是否可信。",
      conclusion: "先给出结论，再按证据解释。",
      facts: "- 企业知识库 V3",
      pending: "- 客户案例公开授权",
      boundaries: "- 不使用绝对化排名",
      references: "- 企业事实确认表.pdf",
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

  it("loads a structured draft only from the dedicated authenticated status endpoint", async () => {
    const structuredDraft = {
      concern: "用户关心可信度",
      conclusion: "先结论后证据",
      facts: "企业知识库 V3",
      pending: "公开授权",
      boundaries: "禁止绝对化",
      references: "企业事实表",
      roundConfirmation: "请确认授权范围",
    };
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        status: "completed",
        taskId: "task/1",
        model: "frontmind-pro",
        structuredDraft,
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      fetchResponseLogicStructuredDraft({
        questionId: "question-1",
        conversationId: "conversation-1",
        taskId: "task/1",
      }),
    ).resolves.toEqual(structuredDraft);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/response-logic/tasks/task%2F1/status?questionId=question-1&conversationId=conversation-1",
      expect.objectContaining({
        method: "GET",
        credentials: "include",
      }),
    );
  });

  it("rejects malformed structured status payloads from the client boundary", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          status: "completed",
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
      }),
    ).rejects.toThrow("未通过七栏目校验");
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

    await waitFor(() => {
      expect(onPublished).toHaveBeenCalledWith("reputation-company");
    });
    expect(
      screen.queryByRole("region", { name: "当前已发布应答逻辑" }),
    ).toBeNull();
    expect(screen.getByText(/应答逻辑已更新，可在问题优化中查看/)).toBeTruthy();
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
        name: "进入应答逻辑智能体更新",
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
