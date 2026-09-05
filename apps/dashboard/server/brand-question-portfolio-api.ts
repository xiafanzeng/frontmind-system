import { createHash } from "node:crypto";

import { Router } from "express";
import { z } from "zod";

import { portfolioCandidates } from "../shared/brand-question-portfolio";
import {
  getCredentialForUpstreamResource,
  recordUpstreamResource,
} from "./auth-service";
import {
  BRAND_QUESTION_EVIDENCE_ATTACHMENT_FILENAME,
  BRAND_QUESTION_SKILL_ATTACHMENT_FILENAME,
  buildBrandQuestionPortfolioEvidenceArchive,
  buildBrandQuestionPortfolioPrompt,
  buildBrandQuestionPortfolioSkillArchive,
  BRAND_QUESTION_STRUCTURED_OUTPUT_SCHEMA,
  deriveBrandQuestionCandidateTargets,
  parseBrandQuestionPortfolioStructuredValue,
  type BrandQuestionPortfolioContext,
} from "./brand-question-portfolio-runtime";
import {
  BrandQuestionTaskContextError,
  classifyBrandQuestionTaskStatus,
  createBrandQuestionTaskContextToken,
  verifyBrandQuestionTaskContextToken,
} from "./brand-question-task-context";
import { getDashboardWorkspace } from "./dashboard-service";
import { getLatestAuthenticatedKnowledgeSnapshot } from "./authenticated-knowledge-service";
import {
  assertServiceCapability,
  replaceGeneratedQuestionCandidates,
  ServiceEntitlementError,
} from "./service-entitlement";
import {
  redactSensitivePayload,
  safeErrorForLog,
} from "./_core/sensitive-data";
import { getUpstreamBaseUrl, toUpstreamAgentProfile } from "./upstream-config";
import { assertUpstreamPromptBudget } from "./upstream-prompt-budget";
import {
  classifyManusV2StructuredResultEnvelope,
  latestManusV2TaskState,
  ManusV2ApiError,
  ManusV2Client,
} from "./manus-v2-client";

const router = Router();

function sendServiceError(
  res: import("express").Response,
  error: unknown,
  secret?: string,
) {
  if (error instanceof ServiceEntitlementError) {
    res.status(error.statusCode).json({
      error: { code: error.code, message: error.message },
    });
    return;
  }
  console.error(
    "[Brand Question Portfolio] request failed",
    safeErrorForLog(error, { secrets: [secret] }),
  );
  res.status(500).json({
    error: {
      code: "BRAND_QUESTION_PORTFOLIO_FAILED",
      message: "品牌全域词库暂时无法生成",
    },
  });
}

export function publicBrandQuestionTask(
  task: Record<string, unknown>,
  taskId: string,
  apiKey: string,
) {
  return redactSensitivePayload(
    {
      id: taskId,
      status: classifyBrandQuestionTaskStatus(task.status),
    },
    { secrets: [apiKey] },
  ) as {
    id: string;
    status: ReturnType<typeof classifyBrandQuestionTaskStatus>;
  };
}

export function brandQuestionTaskContextErrorResponse(
  error: BrandQuestionTaskContextError,
) {
  return {
    status: error.code === "BRAND_QUESTION_TASK_CONTEXT_EXPIRED" ? 410 : 409,
    body: {
      error: { code: error.code, message: error.message },
    },
  } as const;
}

async function currentContext(
  userId: number,
  modelProfile: BrandQuestionPortfolioContext["modelProfile"],
) {
  const portal = await assertServiceCapability(userId, "globalKeywords");
  if (
    (portal.service.planCode !== "advanced" &&
      portal.service.planCode !== "luxury") ||
    !portal.quotas
  ) {
    throw new ServiceEntitlementError(
      "CAPABILITY_UPGRADE_REQUIRED",
      "品牌全域词库仅对进阶版和豪华版开放。",
      403,
    );
  }
  if (!portal.service.validFrom) {
    throw new ServiceEntitlementError(
      "KNOWLEDGE_SNAPSHOT_NOT_FOUND",
      "当前高级套餐尚未生效，不能生成品牌全域候选词。",
      409,
    );
  }
  const [snapshot, workspace] = await Promise.all([
    getLatestAuthenticatedKnowledgeSnapshot({
      userId,
      notBefore: new Date(portal.service.validFrom),
    }),
    getDashboardWorkspace(userId),
  ]);
  if (!snapshot) {
    throw new ServiceEntitlementError(
      "KNOWLEDGE_SNAPSHOT_NOT_FOUND",
      "请先在知识库智能体中逐项完成 8–115 个节点并发布当前套餐使用的认证知识库，再生成品牌全域候选词。",
      409,
    );
  }
  const context: BrandQuestionPortfolioContext = {
    modelProfile,
    planCode: portal.service.planCode,
    quotaPeriodId: portal.quotas.periodId,
    quotaRevision: portal.quotas.revision,
    enterprise: {
      identityHash: createHash("sha256")
        .update(
          `${userId}\0${workspace.payload.brandName
            .normalize("NFKC")
            .trim()
            .toLowerCase()}`,
        )
        .digest("hex"),
      canonicalName: workspace.payload.brandName.trim(),
    },
    quota: {
      industry: portal.quotas.remaining.industry,
      competitorComparison: portal.quotas.remaining.competitorComparison,
      reputation: portal.quotas.remaining.reputation,
      productScenario: portal.quotas.remaining.productScenario,
    },
    snapshot: {
      id: snapshot.id,
      version: snapshot.version,
      archiveHash: snapshot.archiveHash,
      sourceFileName: snapshot.sourceFileName,
      documents: snapshot.documents,
    },
  };
  return { portal, snapshot, context };
}

function snapshotContextHash(
  snapshot: BrandQuestionPortfolioContext["snapshot"],
) {
  return (
    snapshot.archiveHash ??
    `snapshot:${snapshot.id}:version:${snapshot.version}`
  );
}

function hashedBrandQuestionDispatchKey(
  namespace: string,
  values: ReadonlyArray<string | number>,
) {
  return createHash("sha256")
    .update(JSON.stringify([namespace, ...values]), "utf8")
    .digest("hex");
}

export function createBrandQuestionTaskIdempotencyKey(input: {
  userId: number;
  prompt: string;
  skillContentHash: string;
  evidenceContentHash: string;
}) {
  return hashedBrandQuestionDispatchKey("frontmind-brand-question-task-v1", [
    input.userId,
    createHash("sha256").update(input.prompt, "utf8").digest("hex"),
    input.skillContentHash,
    input.evidenceContentHash,
  ]);
}

export function createBrandQuestionFileIdempotencyKey(input: {
  taskIdempotencyKey: string;
  role: "skill" | "evidence";
  contentHash: string;
}) {
  return hashedBrandQuestionDispatchKey("frontmind-brand-question-file-v1", [
    input.taskIdempotencyKey,
    input.role,
    input.contentHash,
  ]);
}

export async function createBrandQuestionUpstreamTask(input: {
  baseUrl: string;
  apiKey: string;
  prompt: string;
  attachments: Array<{ file_id: string; filename: string }>;
  idempotencyKey: string;
  agentProfile?: string;
  rateLimitScope?: string;
}) {
  const client = new ManusV2Client({
    baseUrl: input.baseUrl,
    apiKey: input.apiKey,
    rateLimitScope: input.rateLimitScope,
  });
  const operationToken = input.idempotencyKey;
  const title = `FrontMind brand questions ${operationToken.slice(0, 24)}`;
  const prompt = assertUpstreamPromptBudget(
    `${input.prompt}\n\nFRONTMIND_MANUS_V2_OPERATION_CONTRACT=${JSON.stringify({ operationToken })}`,
  );
  try {
    return await client.createTask({
      prompt,
      attachments: input.attachments,
      title,
      agentProfile: input.agentProfile,
      locale: "zh-CN",
      interactiveMode: false,
      structuredOutputSchema: BRAND_QUESTION_STRUCTURED_OUTPUT_SCHEMA,
    });
  } catch (error) {
    if (!(error instanceof ManusV2ApiError) || !error.outcomeUnknown) {
      throw error;
    }
    const reconciled = await client.findCreatedTask({
      title,
      operationToken,
    });
    if (!reconciled.unique) throw error;
    return {
      taskId: reconciled.unique.id,
      requestId: error.providerRequestId,
      raw: { ok: true, task_id: reconciled.unique.id, reconciled: true },
    };
  }
}

router.post("/start", async (req, res) => {
  try {
    const user = req.frontmindUser;
    if (!user) {
      res.status(401).json({
        error: { code: "UNAUTHORIZED", message: "请先登录" },
      });
      return;
    }
    if (!req.frontmindCredential) {
      res.status(428).json({
        error: {
          code: "CUSTOMER_KEY_REQUIRED",
          message: "当前客户账号尚未配置 API Key",
        },
      });
      return;
    }
    const { context } = await currentContext(
      user.id,
      req.frontmindCredential.agentProfile,
    );
    const baseUrl = getUpstreamBaseUrl(req);
    const apiKey = req.frontmindCredential.apiKey;
    const client = new ManusV2Client({
      baseUrl,
      apiKey,
      rateLimitScope: `managed-user:${user.id}`,
    });
    const [skillArchive, evidenceArchive, builtPrompt] = await Promise.all([
      buildBrandQuestionPortfolioSkillArchive(),
      buildBrandQuestionPortfolioEvidenceArchive(context),
      buildBrandQuestionPortfolioPrompt(context),
    ]);
    const prompt = assertUpstreamPromptBudget(builtPrompt);
    const taskIdempotencyKey = createBrandQuestionTaskIdempotencyKey({
      userId: user.id,
      prompt,
      skillContentHash: skillArchive.contentHash,
      evidenceContentHash: evidenceArchive.contentHash,
    });
    const generatedAttachments: Array<{
      attachment: { file_id: string; filename: string };
    }> = [];
    for (const attachment of [
      {
        role: "skill" as const,
        filename: BRAND_QUESTION_SKILL_ATTACHMENT_FILENAME,
        bytes: skillArchive.bytes,
        contentHash: skillArchive.contentHash,
      },
      {
        role: "evidence" as const,
        filename: BRAND_QUESTION_EVIDENCE_ATTACHMENT_FILENAME,
        bytes: evidenceArchive.bytes,
        contentHash: evidenceArchive.contentHash,
      },
    ]) {
      generatedAttachments.push(
        await client
          .uploadFile({
            filename: attachment.filename,
            bytes: attachment.bytes,
            contentType: "application/zip",
            observer: {
              onCandidateCreated: async ({ fileId }) => {
                await recordUpstreamResource({
                  userId: user.id,
                  apiCredentialId: req.frontmindCredential!.id,
                  kind: "file",
                  upstreamId: fileId,
                });
              },
            },
          })
          .then((uploaded) => ({
            attachment: {
              file_id: uploaded.fileId,
              filename: attachment.filename,
            },
          })),
      );
    }
    const created = await createBrandQuestionUpstreamTask({
      baseUrl,
      apiKey,
      prompt,
      attachments: generatedAttachments.map((item) => item.attachment),
      idempotencyKey: taskIdempotencyKey,
      agentProfile: toUpstreamAgentProfile(
        req.frontmindCredential.agentProfile,
      ),
      rateLimitScope: `managed-user:${user.id}`,
    });
    const taskId = created.taskId;
    if (!taskId) {
      throw new Error("候选词任务未返回任务标识");
    }
    try {
      await recordUpstreamResource({
        userId: user.id,
        apiCredentialId: req.frontmindCredential.id,
        kind: "task",
        upstreamId: taskId,
      });
    } catch (error) {
      // The task is already an irreversible usage fact. Generated inputs were
      // owned before upload and must remain available for idempotent recovery.
      throw error;
    }
    const contextToken = createBrandQuestionTaskContextToken({
      userId: user.id,
      taskId,
      snapshotId: context.snapshot.id,
      snapshotHash: snapshotContextHash(context.snapshot),
      quotaPeriodId: context.quotaPeriodId,
      planCode: context.planCode,
      quotaRevision: context.quotaRevision,
      candidateTargets: deriveBrandQuestionCandidateTargets(context),
      secret: req.frontmindCredential.apiKey,
    });
    res.json({
      task: publicBrandQuestionTask(
        { status: "running" },
        taskId,
        req.frontmindCredential.apiKey,
      ),
      contextToken,
      startedAt: Date.now(),
      knowledgeVersion: context.snapshot.version,
      knowledgeSnapshotId: context.snapshot.id,
      quotaPeriodId: context.quotaPeriodId,
      model: req.frontmindCredential.agentProfile,
    });
  } catch (error) {
    sendServiceError(res, error, req.frontmindCredential?.apiKey);
  }
});

router.post("/sync", async (req, res) => {
  let requestValidated = false;
  let logSecret = req.frontmindCredential?.apiKey;
  try {
    const user = req.frontmindUser;
    if (!user) {
      res.status(401).json({
        error: { code: "UNAUTHORIZED", message: "请先登录" },
      });
      return;
    }
    const { taskId, contextToken } = z
      .object({
        taskId: z.string().trim().min(1).max(255),
        contextToken: z.string().trim().min(1).max(4_096),
      })
      .strict()
      .parse(req.body || {});
    requestValidated = true;
    const credential = await getCredentialForUpstreamResource(
      user.id,
      "task",
      taskId,
    );
    if (!credential) {
      res.status(403).json({
        error: {
          code: "BRAND_QUESTION_TASK_FORBIDDEN",
          message: "当前候选词任务不属于此账号",
        },
      });
      return;
    }
    const { context } = await currentContext(user.id, credential.agentProfile);
    logSecret = credential.apiKey;
    verifyBrandQuestionTaskContextToken({
      token: contextToken,
      secret: credential.apiKey,
      expected: {
        userId: user.id,
        taskId,
        snapshotId: context.snapshot.id,
        snapshotHash: snapshotContextHash(context.snapshot),
        quotaPeriodId: context.quotaPeriodId,
        planCode: context.planCode,
        quotaRevision: context.quotaRevision,
        candidateTargets: deriveBrandQuestionCandidateTargets(context),
      },
    });
    const client = new ManusV2Client({
      baseUrl: getUpstreamBaseUrl(req),
      apiKey: credential.apiKey,
      rateLimitScope: `managed-user:${user.id}`,
    });
    const events = await client.listAllMessages({ taskId, order: "desc" });
    const taskStatus = latestManusV2TaskState(events);
    if (taskStatus === "error") {
      res.status(422).json({
        error: {
          code: "BRAND_QUESTION_TASK_FAILED",
          message: "品牌全域候选词生成失败，请重新生成",
        },
      });
      return;
    }
    if (
      taskStatus === null ||
      taskStatus === "running" ||
      taskStatus === "waiting"
    ) {
      res.status(202).json({
        status: "running",
        task: { id: taskId, status: "running" },
      });
      return;
    }
    if (taskStatus !== "stopped") {
      res.status(502).json({
        error: {
          code: "BRAND_QUESTION_TASK_STATUS_INVALID",
          message: "候选词任务返回了无法识别的 v2 状态",
        },
      });
      return;
    }
    let portfolio;
    try {
      const structuredEvent = [...events]
        .filter((event) => event.type === "structured_output_result")
        .sort(
          (left, right) =>
            right.timestamp - left.timestamp || right.id.localeCompare(left.id),
        )
        .find(
          (event) =>
            classifyManusV2StructuredResultEnvelope(
              event.structured_output_result,
            ).kind === "accepted",
        );
      if (!structuredEvent) {
        throw new Error("候选词任务没有有效 structured output");
      }
      const classified = classifyManusV2StructuredResultEnvelope(
        structuredEvent.structured_output_result,
      );
      if (classified.kind !== "accepted") {
        throw new Error("候选词 structured output 被 Provider 拒绝");
      }
      portfolio = parseBrandQuestionPortfolioStructuredValue(
        classified.value,
        context,
      );
    } catch (error) {
      console.error(
        "[Brand Question Portfolio] completed task returned invalid output",
        safeErrorForLog(error, { secrets: [logSecret] }),
      );
      res.status(422).json({
        error: {
          code: "BRAND_QUESTION_TASK_OUTPUT_INVALID",
          message: "候选词任务输出不符合企业知识库与额度约束，请重新生成",
        },
      });
      return;
    }
    const records = await replaceGeneratedQuestionCandidates({
      userId: user.id,
      quotaPeriodId: context.quotaPeriodId,
      sourceTaskId: taskId,
      knowledgeSnapshotId: context.snapshot.id,
      expectedQuotaContext: {
        revision: context.quotaRevision,
        remaining: context.quota,
      },
      candidates: portfolioCandidates(portfolio).map((candidate) => ({
        candidateKey: candidate.candidateId,
        category: candidate.category,
        question: candidate.question,
        intent: candidate.intent,
        rationale: candidate.rationale,
        evidence: candidate.evidence,
        risks: candidate.risks,
      })),
    });
    res.json({
      status: "ready",
      model: credential.agentProfile,
      knowledgeVersion: context.snapshot.version,
      quotaPeriodId: context.quotaPeriodId,
      records,
      risks: portfolio.risks,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(requestValidated ? 422 : 400).json({
        error: {
          code: requestValidated
            ? "BRAND_QUESTION_TASK_OUTPUT_INVALID"
            : "INVALID_BRAND_QUESTION_SYNC",
          message: requestValidated
            ? "候选词任务输出不符合企业知识库与额度约束，请重新生成"
            : "候选词任务标识无效",
        },
      });
      return;
    }
    if (error instanceof BrandQuestionTaskContextError) {
      const response = brandQuestionTaskContextErrorResponse(error);
      res.status(response.status).json(response.body);
      return;
    }
    sendServiceError(res, error, logSecret);
  }
});

export default router;
