import axios from "axios";
import JSZip from "jszip";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  RESPONSE_LOGIC_CUSTOMER_ATTACHMENT_LIMIT,
  RESPONSE_LOGIC_TASK_STATUS_CACHE_CONTROL,
  ResponseLogicTaskBindingError,
  RESPONSE_LOGIC_SKILL_ATTACHMENT_FILENAME,
  RESPONSE_LOGIC_UPSTREAM_ATTACHMENT_LIMIT,
  assertResponseLogicAttachmentCapacity,
  assertResponseLogicTaskBinding,
  buildResponseLogicPrompt,
  buildResponseLogicEvidenceArchive,
  buildResponseLogicSkillArchive,
  buildResponseLogicTurnInputArchive,
  buildVerifiedResponseLogicAttachments,
  createResponseLogicFileIdempotencyKey,
  createResponseLogicTask,
  createResponseLogicTaskIdempotencyKey,
  normalizeResponseLogicTaskStatus,
  publicResponseLogicTask,
  responseLogicPostDispatchBindingFailure,
  responseLogicTaskResultFromCurrentV2Round,
  responseLogicStartFailureFromManusError,
  responseLogicTaskStatusEnvelopeRoundTrip,
  responseLogicEvidenceAttachmentFilename,
  responseLogicRecordMatchesConfiguredQuestion,
  responseLogicStructuredDraftFromV2Events,
  responseLogicTurnInputAttachmentFilename,
  setResponseLogicTaskStatusNoStore,
} from "./response-logic-api";
import { ManusV2ApiError, ManusV2Client } from "./manus-v2-client";
import { assertResponseLogicDraftPublishable } from "./response-logic-service";
import {
  normalizeResponseLogicPublicProvenance,
  projectResponseLogicAssistantMarkdown,
} from "@shared/response-logic";
import {
  FRONTMIND_UPSTREAM_PROMPT_MAX_CHARACTERS,
  upstreamPromptCharacterCount,
} from "./upstream-prompt-budget";

const legacyStructuredReply = `## 用户真实关心
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
  it("returns a typed 503 only when task start is known not to have dispatched", () => {
    const failure = responseLogicStartFailureFromManusError({
      error: new ManusV2ApiError(
        "file.upload",
        null,
        "TRANSPORT_PRE_DISPATCH_RETRY_EXHAUSTED",
        true,
        false,
        null,
        null,
        null,
        null,
        "dns_temporary",
        "dns",
        3,
        1_500,
        null,
      ),
      incidentId: "incident-safe-retry",
    });

    expect(failure).toEqual({
      status: 503,
      error: {
        code: "RESPONSE_LOGIC_UPSTREAM_UNAVAILABLE",
        message: "上游服务暂时不可用，任务尚未创建，请稍后重试",
        retryable: true,
        resetRequired: false,
        stage: "file_upload_intent",
        incidentId: "incident-safe-retry",
      },
    });
  });

  it("returns a reset-required 502 for an ambiguous file intent", () => {
    const failure = responseLogicStartFailureFromManusError({
      error: new ManusV2ApiError(
        "file.upload",
        null,
        "TRANSPORT_UNKNOWN",
        false,
        true,
        null,
        null,
        null,
        null,
        "connection_reset",
        "request",
        1,
        5_800,
        128,
      ),
      incidentId: "incident-unknown",
    });

    expect(failure).toEqual({
      status: 502,
      error: {
        code: "RESPONSE_LOGIC_START_OUTCOME_UNKNOWN",
        message: "附件处理结果无法确认，请申请重置后重新开始",
        retryable: false,
        resetRequired: true,
        stage: "file_upload_intent",
        incidentId: "incident-unknown",
      },
    });
  });

  it("requires reset when a created task loses the final local binding CAS", () => {
    expect(responseLogicPostDispatchBindingFailure("incident-binding")).toEqual(
      {
        status: 502,
        error: {
          code: "RESPONSE_LOGIC_TASK_BINDING_PENDING",
          message: "上游任务已创建，但本地绑定未完成；请申请重置后重新开始",
          retryable: false,
          resetRequired: true,
          stage: "task_binding",
          incidentId: "incident-binding",
        },
      },
    );
  });

  it("accepts only a successful Manus v2 structured result", () => {
    const value = {
      concern: "采购方关心落地风险。",
      conclusion: "先核验场景，再按证据给出方案。",
      facts: "企业事实引自知识库文档。",
      boundaries: "不得使用未经证明的绝对化排名。",
    };
    expect(
      responseLogicStructuredDraftFromV2Events([
        {
          id: "rejected",
          type: "structured_output_result",
          timestamp: 1,
          structured_output_result: {
            success: false,
            value,
            error: "schema extraction failed",
          },
        },
      ]),
    ).toBeNull();
    expect(
      responseLogicStructuredDraftFromV2Events([
        {
          id: "accepted",
          type: "structured_output_result",
          timestamp: 2,
          structured_output_result: { success: true, value, error: null },
        },
      ]),
    ).toEqual(value);
    expect(
      responseLogicStructuredDraftFromV2Events([
        {
          id: "accepted-json-string",
          type: "structured_output_result",
          timestamp: 3,
          structured_output_result: {
            success: true,
            value: JSON.stringify(value),
            error: null,
          },
        },
      ]),
    ).toEqual(value);
  });

  it("accepts only the newest operation round and never reuses an older success", () => {
    const oldValue = {
      concern: "旧关心",
      conclusion: "旧结论",
      facts: "旧事实",
      boundaries: "旧边界",
    };
    const currentMarkdown = `## 用户真实关心
当前关心

## 核心结论/执行口径
当前结论

## 企业材料/官方依据
当前事实（来源路径：knowledge/current.md）。

## 回答边界/禁止表达
当前边界`;
    const result = responseLogicTaskResultFromCurrentV2Round([
      {
        id: "old-user",
        type: "user_message",
        timestamp: 1,
        user_message: {
          content:
            'first\nFRONTMIND_MANUS_V2_OPERATION_CONTRACT={"operationToken":"old"}',
        },
      },
      {
        id: "old-result",
        type: "structured_output_result",
        timestamp: 2,
        structured_output_result: {
          success: true,
          value: oldValue,
          error: null,
        },
      },
      {
        id: "current-user",
        type: "user_message",
        timestamp: 3,
        user_message: {
          content:
            'second\nFRONTMIND_MANUS_V2_OPERATION_CONTRACT={"operationToken":"current"}',
        },
      },
      {
        id: "current-invalid-structured",
        type: "structured_output_result",
        timestamp: 4,
        structured_output_result: {
          success: true,
          value: { ...oldValue, extra: "forbidden" },
          error: null,
        },
      },
      {
        id: "current-assistant",
        type: "assistant_message",
        timestamp: 5,
        assistant_message: { content: currentMarkdown },
      },
    ]);

    expect(result).toEqual({
      resultId: "current-assistant",
      source: "assistant_markdown",
      structuredDraft: {
        concern: "当前关心",
        conclusion: "当前结论",
        facts: "当前事实（引自知识库文档）。",
        boundaries: "当前边界",
      },
    });
  });

  it("rejects legacy five/seven-section Markdown in the current operation", () => {
    expect(
      responseLogicTaskResultFromCurrentV2Round([
        {
          id: "current-user",
          type: "user_message",
          timestamp: 1,
          user_message: {
            content:
              'current\nFRONTMIND_MANUS_V2_OPERATION_CONTRACT={"operationToken":"current"}',
          },
        },
        {
          id: "legacy-assistant",
          type: "assistant_message",
          timestamp: 2,
          assistant_message: { content: legacyStructuredReply },
        },
      ]),
    ).toBeNull();
  });

  it("marks the authenticated status payload private and non-cacheable", () => {
    const setHeader = vi.fn();
    setResponseLogicTaskStatusNoStore({ setHeader });
    expect(setHeader).toHaveBeenCalledWith(
      "Cache-Control",
      RESPONSE_LOGIC_TASK_STATUS_CACHE_CONTROL,
    );
    expect(RESPONSE_LOGIC_TASK_STATUS_CACHE_CONTROL).toBe(
      "private, no-store, max-age=0",
    );
  });

  it("round-trips quotes, newlines, backslashes and emoji before transport", () => {
    const payload = responseLogicTaskStatusEnvelopeRoundTrip({
      status: "completed",
      taskId: "task-escape",
      operationRevision: 4,
      model: "frontmind-pro",
      resultId: "result-escape",
      source: "structured_output",
      structuredDraft: {
        concern: "客户问“为什么”\n第二行 \\ path 😀",
        conclusion: "结论's",
        facts: "事实\n- 一\n- 二",
        boundaries: "不得输出 `internal`",
      },
    });
    expect(payload.structuredDraft.concern).toBe(
      "客户问“为什么”\n第二行 \\ path 😀",
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

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
    });
    expect(serialized).not.toContain(credential);
    expect(serialized).not.toContain("rawUpstreamField");
    expect(serialized).not.toContain("arbitrary");
    expect(serialized.toLowerCase()).not.toContain("authorization");
    expect(serialized.toLowerCase()).not.toContain("cookie");
    expect(serialized.toLowerCase()).not.toContain("token");
    expect(serialized.toLowerCase()).not.toContain("api_key");
  });

  it("moves the selected question, draft and evidence identity into a deterministic input archive", async () => {
    const input = {
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
    };
    const evidenceArchive = await buildResponseLogicEvidenceArchive(
      input.knowledgeSnapshot,
    );
    const evidenceFilename = responseLogicEvidenceAttachmentFilename(
      evidenceArchive.contentHash,
    );
    const turnInputArchive = await buildResponseLogicTurnInputArchive({
      ...input,
      evidenceAttachmentFilename: evidenceFilename,
    });
    const turnInputFilename = responseLogicTurnInputAttachmentFilename(
      turnInputArchive.contentHash,
    );
    const prompt = await buildResponseLogicPrompt({
      ...input,
      delivery: {
        turnInputAttachmentFilename: turnInputFilename,
        evidenceAttachmentFilename: evidenceFilename,
      },
    });

    expect(prompt).toContain("response-logic-builder");
    expect(prompt).toContain(RESPONSE_LOGIC_SKILL_ATTACHMENT_FILENAME);
    expect(prompt).toContain(evidenceFilename);
    expect(prompt).toContain(turnInputFilename);
    expect(prompt).not.toContain("企业官网怎样成为 AI 可引用的权威信源");
    expect(prompt).not.toContain("知识库版本：V3");
    expect(prompt).not.toContain("这里是已经确认的企业事实");
    expect(prompt).not.toContain("企业事实确认表.pdf");
    expect(prompt).toContain("企业负责人能快速看懂的简体中文");
    expect(prompt).toContain("800–1600 个中文字符");
    expect(prompt).toContain("同一事实、建议或限制只在最合适的一栏出现一次");
    expect(prompt).toContain("企业材料/官方依据（引自知识库文档）");
    expect(prompt).toContain("四个字段正文均不得再写该来源短语");
    expect(prompt.match(/引自知识库文档/gu)).toHaveLength(1);
    expect(prompt).toContain("不得输出内部思考");
    expect(upstreamPromptCharacterCount(prompt)).toBeLessThanOrEqual(
      FRONTMIND_UPSTREAM_PROMPT_MAX_CHARACTERS,
    );

    const skillArchive = await buildResponseLogicSkillArchive();
    const skillZip = await JSZip.loadAsync(skillArchive.bytes);
    const evidenceZip = await JSZip.loadAsync(evidenceArchive.bytes);
    const turnInputZip = await JSZip.loadAsync(turnInputArchive.bytes);
    expect(Object.keys(skillZip.files).sort()).toEqual([
      "MANIFEST.json",
      "SKILL.md",
      "references/output-contract.md",
    ]);
    const skillText = await skillZip.file("SKILL.md")!.async("string");
    const outputContractText = await skillZip
      .file("references/output-contract.md")!
      .async("string");
    expect(skillText).toContain("企业负责人能够快速看懂并转述给客户");
    expect(skillText).toContain("800–1600 个中文字符");
    expect(skillText).toContain("每个事实、建议和限制只放在最合适的一个字段中");
    expect(skillText).toContain("企业材料/官方依据（引自知识库文档）");
    expect(skillText).toContain("任何正文内重复该来源短语");
    expect(skillText.match(/引自知识库文档/gu)).toHaveLength(1);
    expect(outputContractText).toContain(
      "each fact, recommendation, or limitation appears once",
    );
    expect(outputContractText).toContain(
      "Dashboard renders provenance once in the fixed title `企业材料/官方依据（引自知识库文档）`",
    );
    expect(outputContractText).toContain(
      "no provenance label, heading, prefix, or parenthetical note inside the body",
    );
    expect(outputContractText).toContain(
      "output attachments are never parsed as a fallback",
    );
    expect(await evidenceZip.file("knowledge.md")!.async("string")).toContain(
      "这里是已经确认的企业事实",
    );
    const authoritativeInput = JSON.parse(
      await turnInputZip.file("turn-input.json")!.async("string"),
    );
    expect(authoritativeInput).toMatchObject({
      schemaVersion: 1,
      kind: "frontmind.response-logic.turn-input",
      question: {
        id: "scenario-source",
        groupId: "scenario",
        groupTitle: "产品场景",
        text: "企业官网怎样成为 AI 可引用的权威信源？",
      },
      knowledgeSnapshot: {
        available: true,
        version: 3,
        sourceFileName: "企业知识库_V3.zip",
        evidenceAttachment: evidenceFilename,
      },
      customerAttachments: [
        {
          index: 1,
          fileId: "file-1",
          filename: "企业事实确认表.pdf",
        },
      ],
      customerMessage: "请先给出第一版应答逻辑。",
      outputContract: {
        format: "manus_v2_structured_output",
        requiredFields: ["concern", "conclusion", "facts", "boundaries"],
        everyFieldMustBeNonEmpty: true,
        extraFieldsForbidden: true,
        publicProvenance:
          "由 Dashboard 固定标题“企业材料/官方依据（引自知识库文档）”统一展示；四字段正文不得添加来源标注。",
        followUpConfirmationForbidden: true,
      },
    });

    const replayArchive = await buildResponseLogicTurnInputArchive({
      ...input,
      evidenceAttachmentFilename: evidenceFilename,
    });
    const revisedArchive = await buildResponseLogicTurnInputArchive({
      ...input,
      evidenceAttachmentFilename: evidenceFilename,
      value: {
        ...input.value,
        userMessage: "请按新证据修订当前版本。",
      },
    });
    expect(replayArchive.bytes.equals(turnInputArchive.bytes)).toBe(true);
    expect(
      responseLogicTurnInputAttachmentFilename(replayArchive.contentHash),
    ).toBe(turnInputFilename);
    expect(
      responseLogicTurnInputAttachmentFilename(revisedArchive.contentHash),
    ).not.toBe(turnInputFilename);
  });

  it("keeps the outbound prompt below 3000 characters at the maximum dynamic text sizes", async () => {
    const huge = "界".repeat(200_000);
    const input = {
      value: {
        conversationId: "c".repeat(191),
        questionId: "q".repeat(191),
        groupId: "g".repeat(128),
        groupTitle: "类".repeat(255),
        question: "问".repeat(2_000),
        intent: "意".repeat(8_000),
        summary: "目".repeat(8_000),
        userMessage: huge,
        attachments: Array.from(
          { length: RESPONSE_LOGIC_CUSTOMER_ATTACHMENT_LIMIT },
          (_, index) => ({
            file_id: `file-${index}-${"i".repeat(200)}`,
            filename: `${"资".repeat(500)}-${index}.pdf`,
            mime_type: "application/pdf",
          }),
        ),
        draft: {
          concern: huge,
          conclusion: "结".repeat(500_000),
          facts: "事".repeat(500_000),
          pending: "待".repeat(300_000),
          boundaries: "边".repeat(300_000),
          references: "引".repeat(500_000),
          images: [],
          attachments: [],
        },
      },
      knowledgeSnapshot: {
        version: Number.MAX_SAFE_INTEGER,
        sourceFileName: `${"知识".repeat(100_000)}.zip`,
        documents: [],
        assets: [],
      },
    };

    const evidenceArchive = await buildResponseLogicEvidenceArchive(
      input.knowledgeSnapshot,
    );
    const evidenceFilename = responseLogicEvidenceAttachmentFilename(
      evidenceArchive.contentHash,
    );
    const turnInputArchive = await buildResponseLogicTurnInputArchive({
      ...input,
      evidenceAttachmentFilename: evidenceFilename,
    });
    const turnInputFilename = responseLogicTurnInputAttachmentFilename(
      turnInputArchive.contentHash,
    );
    const prompt = await buildResponseLogicPrompt({
      ...input,
      delivery: {
        turnInputAttachmentFilename: turnInputFilename,
        evidenceAttachmentFilename: evidenceFilename,
      },
    });
    expect(upstreamPromptCharacterCount(prompt)).toBeLessThanOrEqual(
      FRONTMIND_UPSTREAM_PROMPT_MAX_CHARACTERS,
    );
    expect(prompt).not.toContain(huge.slice(0, 10_000));
    expect(prompt).toContain(turnInputFilename);
    expect(prompt).toContain(evidenceFilename);

    const turnInputZip = await JSZip.loadAsync(turnInputArchive.bytes);
    const authoritativeInput = JSON.parse(
      await turnInputZip.file("turn-input.json")!.async("string"),
    );
    expect(authoritativeInput.customerMessage).toHaveLength(200_000);
    expect(authoritativeInput.currentDraft.references).toHaveLength(500_000);
    expect(authoritativeInput.customerAttachments).toHaveLength(
      RESPONSE_LOGIC_CUSTOMER_ATTACHMENT_LIMIT,
    );
    expect(authoritativeInput.knowledgeSnapshot.sourceFileName).toBe(
      input.knowledgeSnapshot.sourceFileName,
    );
  });

  it("uses stable opaque idempotency keys and reserves room for every generated attachment", async () => {
    const taskIdempotencyKey = createResponseLogicTaskIdempotencyKey({
      userId: 42,
      conversationId: "conversation-1",
      questionId: "question-1",
      turnInputContentHash: "a".repeat(64),
      prompt: "bounded prompt",
      initialSkillContentHash: "b".repeat(64),
    });
    const replayKey = createResponseLogicTaskIdempotencyKey({
      userId: 42,
      conversationId: "conversation-1",
      questionId: "question-1",
      turnInputContentHash: "a".repeat(64),
      prompt: "bounded prompt",
      initialSkillContentHash: "b".repeat(64),
    });
    const changedKey = createResponseLogicTaskIdempotencyKey({
      userId: 42,
      conversationId: "conversation-1",
      questionId: "question-1",
      turnInputContentHash: "c".repeat(64),
      prompt: "bounded prompt",
      initialSkillContentHash: "b".repeat(64),
    });
    const fileKey = createResponseLogicFileIdempotencyKey({
      taskIdempotencyKey,
      role: "turn_input",
      contentHash: "a".repeat(64),
    });
    expect(taskIdempotencyKey).toMatch(/^[a-f0-9]{64}$/);
    expect(replayKey).toBe(taskIdempotencyKey);
    expect(changedKey).not.toBe(taskIdempotencyKey);
    expect(fileKey).toMatch(/^[a-f0-9]{64}$/);
    expect(fileKey).not.toBe(taskIdempotencyKey);

    expect(RESPONSE_LOGIC_CUSTOMER_ATTACHMENT_LIMIT).toBe(99);
    expect(RESPONSE_LOGIC_UPSTREAM_ATTACHMENT_LIMIT).toBe(102);
    expect(() =>
      assertResponseLogicAttachmentCapacity({
        generatedAttachmentCount: 3,
        customerAttachmentCount: 99,
      }),
    ).not.toThrow();
    expect(() =>
      assertResponseLogicAttachmentCapacity({
        generatedAttachmentCount: 3,
        customerAttachmentCount: 100,
      }),
    ).toThrow("attachment limit exceeded");

    const post = vi.spyOn(axios.Axios.prototype, "post").mockResolvedValue({
      status: 200,
      data: {
        ok: true,
        request_id: "request-response-idempotent",
        task_id: "task-response-idempotent",
      },
    });
    await createResponseLogicTask({
      baseUrl: "https://api.example.test",
      apiKey: "secret-test-key",
      prompt: "bounded prompt",
      attachments: [],
      idempotencyKey: taskIdempotencyKey,
      agentProfile: "manus-1.6-max",
    });
    expect(post).toHaveBeenCalledWith(
      "https://api.example.test/v2/task.create",
      expect.objectContaining({
        agent_profile: "manus-1.6-max",
        message: expect.objectContaining({
          content: expect.arrayContaining([
            expect.objectContaining({
              type: "text",
              text: expect.stringContaining("bounded prompt"),
            }),
          ]),
        }),
        structured_output_schema: expect.objectContaining({
          required: ["concern", "conclusion", "facts", "boundaries"],
        }),
      }),
      expect.objectContaining({
        headers: expect.objectContaining({
          "Content-Type": "application/json",
        }),
      }),
    );

    post.mockClear();
    await expect(
      createResponseLogicTask({
        baseUrl: "https://api.example.test",
        apiKey: "secret-test-key",
        prompt: "界".repeat(3_001),
        attachments: [],
        idempotencyKey: taskIdempotencyKey,
        agentProfile: "manus-1.6-max",
      }),
    ).rejects.toThrow("UPSTREAM_PROMPT_EXCEEDS_3000_CHARACTERS");
    expect(post).not.toHaveBeenCalled();
  });

  it("preserves an ambiguous task.create when its reconciliation read fails", async () => {
    const original = new ManusV2ApiError(
      "task.create",
      null,
      "TRANSPORT_UNKNOWN",
      false,
      true,
    );
    const createTask = vi
      .spyOn(ManusV2Client.prototype, "createTask")
      .mockRejectedValueOnce(original);
    const findCreatedTask = vi
      .spyOn(ManusV2Client.prototype, "findCreatedTask")
      .mockRejectedValueOnce(
        new ManusV2ApiError(
          "task.list",
          503,
          "UPSTREAM_UNAVAILABLE",
          true,
          false,
        ),
      );

    const result = await createResponseLogicTask({
      baseUrl: "https://api.example.test",
      apiKey: "secret-test-key",
      prompt: "bounded prompt",
      attachments: [],
      idempotencyKey: "task-create-unknown",
      agentProfile: "manus-1.6-max",
    });

    expect(result).toMatchObject({ ok: false, upstreamError: original });
    expect(createTask).toHaveBeenCalledTimes(1);
    expect(findCreatedTask).toHaveBeenCalledTimes(1);
  });

  it("preserves an ambiguous task message when its reconciliation read fails", async () => {
    const original = new ManusV2ApiError(
      "task.sendMessage",
      null,
      "TRANSPORT_UNKNOWN",
      false,
      true,
    );
    const sendMessage = vi
      .spyOn(ManusV2Client.prototype, "sendMessage")
      .mockRejectedValueOnce(original);
    const listAllMessages = vi
      .spyOn(ManusV2Client.prototype, "listAllMessages")
      .mockRejectedValueOnce(
        new ManusV2ApiError(
          "task.listMessages",
          503,
          "UPSTREAM_UNAVAILABLE",
          true,
          false,
        ),
      );

    const result = await createResponseLogicTask({
      baseUrl: "https://api.example.test",
      apiKey: "secret-test-key",
      prompt: "bounded prompt",
      attachments: [],
      taskId: "existing-task",
      idempotencyKey: "task-message-unknown",
      agentProfile: "manus-1.6-max",
    });

    expect(result).toMatchObject({ ok: false, upstreamError: original });
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(listAllMessages).toHaveBeenCalledTimes(1);
  });

  it("sanitizes every public field without deleting facts after a source marker", () => {
    const publicDraft = normalizeResponseLogicPublicProvenance({
      concern: "先查看 FINAL.zip，再判断用户需求。",
      conclusion: "产品口径见 knowledge_base/products/3.2.md。",
      facts:
        "- 来源文件：FINAL.zip；平台支持 **200 个模型**。\n- 产品手册：硅基流动产品介绍.pdf 证明公司拥有五条产品线。\n- 支持 AI/ML、API/SDK 工作负载，同比增长 1.1/2.3。",
      boundaries:
        "不要公开 sources/private.json 或 https://example.com/spec.md?rev=1。",
      references: "引用文档：products/3.2.md",
    });

    const serialized = JSON.stringify(publicDraft);
    expect(publicDraft.facts).toContain("平台支持 **200 个模型**");
    expect(publicDraft.facts).toContain("证明公司拥有五条产品线");
    expect(publicDraft.facts).toContain(
      "支持 AI/ML、API/SDK 工作负载，同比增长 1.1/2.3",
    );
    expect(publicDraft.references).toBe("");
    expect(serialized).not.toMatch(
      /FINAL\.zip|knowledge_base|products\/3\.2\.md|private\.json|example\.com|产品介绍\.pdf/u,
    );
  });

  it("projects a legacy assistant bubble to four public sections", () => {
    const projected = projectResponseLogicAssistantMarkdown(
      legacyStructuredReply,
    );

    expect(projected).toContain("## 用户真实关心");
    expect(projected).not.toContain("引用与核验规则");
    expect(projected).not.toContain("待补充/待确认");
    expect(projected).not.toContain("本轮确认");
    expect(projected).not.toContain("企业事实确认表.pdf");
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
      revision: 4,
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
        operationRevision: 4,
        record,
        configuredQuestion,
      }),
    ).not.toThrow();

    const releasedRecord = { ...record, lastTaskId: undefined };
    expect(() =>
      assertResponseLogicTaskBinding({
        authenticatedUserId: 7,
        workspaceUserId: 7,
        questionId: "question-1",
        conversationId: "conversation-1",
        taskId: "task-1",
        operationRevision: 4,
        record: releasedRecord,
        configuredQuestion,
      }),
    ).toThrow(ResponseLogicTaskBindingError);
    expect(() =>
      assertResponseLogicTaskBinding({
        authenticatedUserId: 7,
        workspaceUserId: 7,
        questionId: "question-1",
        conversationId: "conversation-1",
        taskId: "task-new",
        operationRevision: 4,
        record,
        configuredQuestion,
      }),
    ).toThrow(ResponseLogicTaskBindingError);
    expect(() =>
      assertResponseLogicTaskBinding({
        authenticatedUserId: 7,
        workspaceUserId: 7,
        questionId: "question-1",
        conversationId: "conversation-1",
        taskId: "task-1",
        operationRevision: 3,
        record,
        configuredQuestion,
      }),
    ).toThrow(ResponseLogicTaskBindingError);

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
          operationRevision: 4,
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

  it("publishes a complete four-section draft without legacy references", () => {
    expect(() =>
      assertResponseLogicDraftPublishable({
        concern: "用户需要判断服务是否适配",
        conclusion: "先给出可核验结论",
        facts: "企业事实引自知识库文档",
        pending: "",
        boundaries: "不使用绝对化表达",
        references: "",
        images: [],
        attachments: [],
      }),
    ).not.toThrow();
  });
});
