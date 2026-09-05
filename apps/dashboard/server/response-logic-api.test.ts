import JSZip from "jszip";
import { describe, expect, it } from "vitest";

import {
  ResponseLogicTaskBindingError,
  RESPONSE_LOGIC_EVIDENCE_ATTACHMENT_FILENAME,
  RESPONSE_LOGIC_SKILL_ATTACHMENT_FILENAME,
  assertResponseLogicTaskBinding,
  buildResponseLogicPrompt,
  buildResponseLogicEvidenceArchive,
  buildResponseLogicSkillArchive,
  buildVerifiedResponseLogicAttachments,
  extractFinalResponseLogicAssistantReply,
  normalizeResponseLogicTaskStatus,
  parseCompletedResponseLogicTask,
  publicResponseLogicTask,
  responseLogicRecordMatchesConfiguredQuestion,
} from "./response-logic-api";
import { assertResponseLogicDraftPublishable } from "./response-logic-service";

const validStructuredReply = `## 用户真实关心
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
请确认案例是否可公开。`;

describe("response logic execution contract", () => {
  it("returns only a credential-free allowlisted task DTO", () => {
    const credential = "sentinel-response-logic-credential";
    const task = publicResponseLogicTask(
      {
        id: "task-response-1",
        status: "running",
        model: "upstream-model",
        API_KEY: credential,
        metadata: {
          task_url: "https://tasks.example/task-response-1",
          task_title: `Draft ${credential}`,
          Authorization: `Bearer ${credential}`,
          accessToken: "another-token",
          arbitrary: "must-not-pass",
        },
        output: [
          {
            type: "message",
            text: `safe ${credential}`,
            nested: { Cookie: credential },
          },
        ],
        rawUpstreamField: "must-not-pass",
      },
      "task-response-1",
      credential,
    );
    const serialized = JSON.stringify(task);

    expect(task).toEqual({
      id: "task-response-1",
      status: "running",
      model: "upstream-model",
      metadata: {
        task_url: "https://tasks.example/task-response-1",
        task_title: "Draft [REDACTED]",
      },
      output: [
        {
          type: "message",
          text: "safe [REDACTED]",
          nested: {},
        },
      ],
    });
    expect(serialized).not.toContain(credential);
    expect(serialized).not.toContain("rawUpstreamField");
    expect(serialized).not.toContain("arbitrary");
    expect(serialized.toLowerCase()).not.toContain("authorization");
    expect(serialized.toLowerCase()).not.toContain("cookie");
    expect(serialized.toLowerCase()).not.toContain("token");
    expect(serialized.toLowerCase()).not.toContain("api_key");
  });

  it("injects the selected question, current draft, knowledge base and output contract", async () => {
    const prompt = await buildResponseLogicPrompt({
      value: {
        conversationId: "conv-response-1",
        questionId: "scenario-source",
        groupId: "scenario",
        groupTitle: "产品场景",
        question: "企业官网怎样成为 AI 可引用的权威信源？",
        intent: "用户希望提升官网的机器可理解性。",
        summary: "用可验证的事实与证据解释完整路径。",
        userMessage: "请先给出第一版应答逻辑。",
        attachments: [{ file_id: "file-1", filename: "企业事实确认表.pdf" }],
        draft: {
          concern: "",
          conclusion: "",
          facts: "",
          pending: "",
          boundaries: "",
          references: "",
          images: [],
          attachments: [],
        },
      },
      knowledgeSnapshot: {
        version: 3,
        sourceFileName: "企业知识库_V3.zip",
        documents: [
          {
            path: "01_company/profile.md",
            title: "企业简介",
            content: "这里是已经确认的企业事实。",
          },
        ],
        assets: [
          { path: "images/company.webp", mimeType: "image/webp", size: 2048 },
        ],
      },
    });

    expect(prompt).toContain("response-logic-builder");
    expect(prompt).toContain("企业官网怎样成为 AI 可引用的权威信源");
    expect(prompt).toContain("知识库版本：V3");
    expect(prompt).toContain(RESPONSE_LOGIC_SKILL_ATTACHMENT_FILENAME);
    expect(prompt).toContain(RESPONSE_LOGIC_EVIDENCE_ATTACHMENT_FILENAME);
    expect(prompt).not.toContain("这里是已经确认的企业事实");
    expect(prompt).toContain("企业事实确认表.pdf");
    expect(prompt).toContain("## 核心结论/执行口径");
    expect(prompt).toContain("## 回答边界/禁止表达");
    expect(prompt).toContain("不得输出内部思考");

    const [skillArchive, evidenceArchive] = await Promise.all([
      buildResponseLogicSkillArchive(),
      buildResponseLogicEvidenceArchive({
        version: 3,
        sourceFileName: "企业知识库_V3.zip",
        documents: [
          {
            path: "01_company/profile.md",
            title: "企业简介",
            content: "这里是已经确认的企业事实。",
          },
        ],
        assets: [
          { path: "images/company.webp", mimeType: "image/webp", size: 2048 },
        ],
      }),
    ]);
    const skillZip = await JSZip.loadAsync(skillArchive.bytes);
    const evidenceZip = await JSZip.loadAsync(evidenceArchive.bytes);
    expect(Object.keys(skillZip.files).sort()).toEqual([
      "MANIFEST.json",
      "SKILL.md",
      "references/output-contract.md",
    ]);
    expect(await evidenceZip.file("knowledge.md")!.async("string")).toContain(
      "这里是已经确认的企业事实",
    );
  });

  it("accepts only a completed Pro assistant reply with all seven ordered sections", () => {
    const structured = parseCompletedResponseLogicTask({
      id: "task-1",
      status: "completed",
      output: [
        {
          type: "reasoning",
          text: "这段内部推理不能进入草稿。",
        },
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: validStructuredReply }],
        },
      ],
    });

    expect(structured).toEqual({
      concern: "采购方需要判断方案是否可信。",
      conclusion: "先给出结论，再按证据解释。",
      facts: "- 企业知识库 V3",
      pending: "- 客户案例公开授权",
      boundaries: "- 不使用绝对化排名",
      references: "- 企业事实确认表.pdf",
      roundConfirmation: "请确认案例是否可公开。",
    });
    expect(
      extractFinalResponseLogicAssistantReply({
        output: [
          { type: "reasoning", text: "不能使用" },
          {
            type: "message",
            role: "assistant",
            content: validStructuredReply,
          },
        ],
      }),
    ).toBe(validStructuredReply);
  });

  it("rejects missing, reordered, duplicate, extra and empty model sections", () => {
    const invalidOutputs = [
      validStructuredReply.replace(/## 本轮确认[\s\S]*$/, ""),
      validStructuredReply.replace(
        "## 核心结论/执行口径",
        "## 企业材料/官方依据",
      ),
      `${validStructuredReply}\n\n## 额外说明\n不允许`,
      validStructuredReply.replace(
        "## 待补充/待确认\n- 客户案例公开授权",
        "## 待补充/待确认\n",
      ),
      `模型前言\n${validStructuredReply}`,
    ];

    for (const output of invalidOutputs) {
      expect(() =>
        parseCompletedResponseLogicTask({
          status: "completed",
          output: [
            {
              type: "message",
              role: "assistant",
              content: output,
            },
          ],
        }),
      ).toThrow();
    }
  });

  it("normalizes only known upstream task states", () => {
    expect(normalizeResponseLogicTaskStatus("in-progress")).toBe("running");
    expect(normalizeResponseLogicTaskStatus("succeeded")).toBe("completed");
    expect(normalizeResponseLogicTaskStatus("cancelled")).toBe("failed");
    expect(normalizeResponseLogicTaskStatus("mystery")).toBe("unknown");
  });

  it("binds status reads to the authenticated workspace, question, conversation and latest task", () => {
    const record = {
      id: "record-1",
      questionId: "question-1",
      groupId: "group-1",
      groupTitle: "产品场景",
      question: "如何回答？",
      intent: "核验",
      summary: "形成口径",
      conversationId: "conversation-1",
      lastTaskId: "task-1",
      draft: {
        concern: "",
        conclusion: "",
        facts: "",
        pending: "",
        boundaries: "",
        references: "",
        images: [],
        attachments: [],
      },
      version: 0,
      createdAt: 1,
      updatedAt: 2,
    };
    const configuredQuestion = {
      questionId: record.questionId,
      groupId: record.groupId,
      groupTitle: record.groupTitle,
      question: record.question,
      intent: record.intent,
      summary: record.summary,
    };
    expect(
      responseLogicRecordMatchesConfiguredQuestion({
        record,
        configuredQuestion,
      }),
    ).toBe(true);
    expect(
      responseLogicRecordMatchesConfiguredQuestion({
        record,
        configuredQuestion: {
          ...configuredQuestion,
          question: "管理员更新后的问题",
        },
      }),
    ).toBe(false);
    expect(() =>
      assertResponseLogicTaskBinding({
        authenticatedUserId: 7,
        workspaceUserId: 7,
        questionId: "question-1",
        conversationId: "conversation-1",
        taskId: "task-1",
        record,
        configuredQuestion,
      }),
    ).not.toThrow();

    for (const invalid of [
      { workspaceUserId: 8 },
      { questionId: "question-2" },
      { conversationId: "conversation-2" },
      { taskId: "task-2" },
      {
        configuredQuestion: {
          ...configuredQuestion,
          question: "管理员更新后的问题",
        },
      },
    ]) {
      expect(() =>
        assertResponseLogicTaskBinding({
          authenticatedUserId: 7,
          workspaceUserId: 7,
          questionId: "question-1",
          conversationId: "conversation-1",
          taskId: "task-1",
          record,
          configuredQuestion,
          ...invalid,
        }),
      ).toThrow(ResponseLogicTaskBindingError);
    }
  });

  it("normalizes verified upload metadata without persisting browser URLs", () => {
    const attachments = buildVerifiedResponseLogicAttachments(
      [
        {
          file_id: "file-image",
          filename: "evidence.PNG",
          mime_type: "application/octet-stream",
        },
        {
          file_id: "file-sheet",
          filename: "facts.xlsx",
          mime_type:
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        },
      ],
      new Date("2026-07-23T10:00:00.000Z"),
    );

    expect(attachments).toEqual([
      {
        fileId: "file-image",
        filename: "evidence.PNG",
        mimeType: "image/png",
        kind: "image",
        uploadedAt: "2026-07-23T10:00:00.000Z",
      },
      {
        fileId: "file-sheet",
        filename: "facts.xlsx",
        mimeType:
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        kind: "file",
        uploadedAt: "2026-07-23T10:00:00.000Z",
      },
    ]);
  });

  it("projects the immutable server file deadline into response-logic attachments", () => {
    const uploadedAt = new Date("2026-07-01T00:00:00.000Z");
    const contentExpiresAt = new Date("2026-07-31T00:00:00.000Z");
    const attachments = buildVerifiedResponseLogicAttachments(
      [
        {
          file_id: " file/opaque?# ",
          filename: "证据.pdf",
          mime_type: "application/pdf",
        },
      ],
      new Map([
        [
          " file/opaque?# ",
          {
            uploadedAt,
            contentExpiresAt,
            contentDeletedAt: new Date("2026-07-31T01:00:00.000Z"),
          },
        ],
      ]),
    );

    expect(attachments).toEqual([
      expect.objectContaining({
        fileId: " file/opaque?# ",
        uploadedAt: uploadedAt.toISOString(),
        expiresAt: contentExpiresAt.getTime(),
        expired: true,
      }),
    ]);
  });

  it("does not publish an incomplete response logic draft", () => {
    expect(() =>
      assertResponseLogicDraftPublishable({
        concern: "用户需要判断服务是否适配",
        conclusion: "",
        facts: "",
        pending: "",
        boundaries: "",
        references: "",
        images: [],
        attachments: [],
      }),
    ).toThrow("请先补齐以下应答逻辑内容");
  });
});
