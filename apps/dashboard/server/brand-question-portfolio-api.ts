import { createHash } from "node:crypto";

import axios from "axios";
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
  parseBrandQuestionPortfolioOutput,
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
import { uploadUpstreamTaskAttachment } from "./upstream-task-attachment";

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

async function currentContext(userId: number) {
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
    planCode: portal.service.planCode,
    quotaPeriodId: portal.quotas.periodId,
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

router.post("/start", async (req, res) => {
  try {
    const user = req.frontmindUser;
    if (!user) {
      res.status(401).json({
        error: { code: "UNAUTHORIZED", message: "请先登录" },
      });
      return;
    }
    const { context } = await currentContext(user.id);
    if (!req.frontmindCredential) {
      res.status(428).json({
        error: {
          code: "API_CREDENTIAL_REQUIRED",
          message: "当前账号尚未由管理员配置 API Key",
        },
      });
      return;
    }
    const baseUrl = getUpstreamBaseUrl(req);
    const apiKey = req.frontmindCredential.apiKey;
    const generatedAttachments: Array<
      Awaited<ReturnType<typeof uploadUpstreamTaskAttachment>>
    > = [];
    try {
      const [skillArchive, evidenceArchive] = await Promise.all([
        buildBrandQuestionPortfolioSkillArchive(),
        buildBrandQuestionPortfolioEvidenceArchive(context),
      ]);
      for (const attachment of [
        {
          filename: BRAND_QUESTION_SKILL_ATTACHMENT_FILENAME,
          bytes: skillArchive.bytes,
        },
        {
          filename: BRAND_QUESTION_EVIDENCE_ATTACHMENT_FILENAME,
          bytes: evidenceArchive.bytes,
        },
      ]) {
        generatedAttachments.push(
          await uploadUpstreamTaskAttachment({
            baseUrl,
            apiKey,
            ...attachment,
          }),
        );
      }
    } catch (error) {
      await Promise.allSettled(
        generatedAttachments.map((attachment) => attachment.removeOrphan()),
      );
      throw error;
    }
    const response = await axios.post(
      `${baseUrl}/v1/tasks`,
      {
        prompt: await buildBrandQuestionPortfolioPrompt(context),
        agentProfile: toUpstreamAgentProfile("frontmind-pro"),
        taskMode: "agent",
        attachments: generatedAttachments.map((item) => item.attachment),
      },
      {
        headers: {
          "Content-Type": "application/json",
          API_KEY: apiKey,
          Authorization: `Bearer ${apiKey}`,
        },
        timeout: 120_000,
        validateStatus: () => true,
      },
    );
    if (response.status < 200 || response.status >= 300) {
      await Promise.allSettled(
        generatedAttachments.map((attachment) => attachment.removeOrphan()),
      );
      res.status(response.status).json({
        error: {
          code: "BRAND_QUESTION_TASK_FAILED",
          message: "品牌全域候选词任务创建失败，请稍后重试",
        },
      });
      return;
    }
    const task = response.data || {};
    const taskId = String(task.id || task.task_id || "");
    if (!taskId) {
      await Promise.allSettled(
        generatedAttachments.map((attachment) => attachment.removeOrphan()),
      );
      throw new Error("候选词任务未返回任务标识");
    }
    if (classifyBrandQuestionTaskStatus(task.status) === "failed") {
      await Promise.allSettled(
        generatedAttachments.map((attachment) => attachment.removeOrphan()),
      );
      res.status(502).json({
        error: {
          code: "BRAND_QUESTION_TASK_FAILED",
          message: "品牌全域候选词任务未能启动，请重新生成",
        },
      });
      return;
    }
    try {
      for (const attachment of generatedAttachments) {
        await recordUpstreamResource({
          userId: user.id,
          apiCredentialId: req.frontmindCredential.id,
          kind: "file",
          upstreamId: attachment.fileId,
        });
      }
      await recordUpstreamResource({
        userId: user.id,
        apiCredentialId: req.frontmindCredential.id,
        kind: "task",
        upstreamId: taskId,
      });
    } catch (error) {
      // Preserve the task as a permanent usage fact even when local ownership
      // persistence fails. Generated temporary files may still be reclaimed.
      await Promise.allSettled(
        generatedAttachments.map((attachment) => attachment.removeOrphan()),
      );
      throw error;
    }
    const contextToken = createBrandQuestionTaskContextToken({
      userId: user.id,
      taskId,
      snapshotId: context.snapshot.id,
      snapshotHash: snapshotContextHash(context.snapshot),
      quotaPeriodId: context.quotaPeriodId,
      planCode: context.planCode,
      secret: req.frontmindCredential.apiKey,
    });
    res.json({
      task: publicBrandQuestionTask(
        task,
        taskId,
        req.frontmindCredential.apiKey,
      ),
      contextToken,
      startedAt: Date.now(),
      knowledgeVersion: context.snapshot.version,
      knowledgeSnapshotId: context.snapshot.id,
      quotaPeriodId: context.quotaPeriodId,
      model: "frontmind-pro",
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
    const { context } = await currentContext(user.id);
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
      },
    });
    const response = await axios.get(
      `${getUpstreamBaseUrl(req)}/v1/tasks/${encodeURIComponent(taskId)}`,
      {
        headers: {
          API_KEY: credential.apiKey,
          Authorization: `Bearer ${credential.apiKey}`,
        },
        timeout: 120_000,
        validateStatus: () => true,
      },
    );
    if (response.status !== 200) {
      res.status(response.status).json({
        error: {
          code: "BRAND_QUESTION_TASK_READ_FAILED",
          message: "读取品牌全域候选词任务失败",
        },
      });
      return;
    }
    const task = response.data?.task || response.data || {};
    const returnedTaskId = String(task.id || task.task_id || "");
    if (returnedTaskId !== taskId) {
      res.status(409).json({
        error: {
          code: "BRAND_QUESTION_TASK_MISMATCH",
          message: "读取到的候选词任务与当前任务不匹配",
        },
      });
      return;
    }
    const taskStatus = classifyBrandQuestionTaskStatus(task.status);
    if (taskStatus === "failed") {
      res.status(422).json({
        error: {
          code: "BRAND_QUESTION_TASK_FAILED",
          message: "品牌全域候选词生成失败，请重新生成",
        },
      });
      return;
    }
    if (taskStatus === "running") {
      res.status(202).json({
        status: "running",
        task: { id: taskId, status: "running" },
      });
      return;
    }
    let portfolio;
    try {
      portfolio = parseBrandQuestionPortfolioOutput(task.output, context);
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
      model: "frontmind-pro",
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
      res
        .status(
          error.code === "BRAND_QUESTION_TASK_CONTEXT_EXPIRED" ? 410 : 409,
        )
        .json({
          error: { code: error.code, message: error.message },
        });
      return;
    }
    sendServiceError(res, error, logSecret);
  }
});

export default router;
