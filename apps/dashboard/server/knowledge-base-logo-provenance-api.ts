import { Router, type Response } from "express";

import type { KnowledgeBaseObservationDto } from "../shared/knowledge-base-progress";
import { getCredentialForUpstreamResource } from "./auth-service";
import {
  normalizeKnowledgeBaseClientAttachmentManifest,
  normalizeKnowledgeBaseUserAttachments,
  type KnowledgeBaseAttachment,
} from "./knowledge-base-client-attachment-manifest";
import { loadKnowledgeBaseBuildRecord } from "./knowledge-base-final-turn-service";
import {
  KnowledgeBaseLogoProvenanceRepairError,
  repairKnowledgeBaseOfficialLogoProvenance,
  replayCompletedKnowledgeBaseLogoProvenanceRepair,
} from "./knowledge-base-logo-provenance-repair";
import { assertKnowledgeBaseWritable } from "./knowledge-base-reset-service";
import { logKnowledgeBaseRuntimeFailure } from "./knowledge-base-runtime-log";
import { KnowledgeBaseTurnReservationError } from "./knowledge-base-turn-service";

export function knowledgeBaseLogoRepairFileIsOwned(
  fileCredential: { id?: string } | null | undefined,
) {
  return Boolean(fileCredential);
}

type GetKnowledgeBaseObservation = (input: {
  userId: number;
  conversationId: string;
  upstreamStatus: "failed";
}) => Promise<KnowledgeBaseObservationDto | null>;

type LogoProvenanceRouteDependencies = {
  requireKnowledgeBuildCapability: (
    userId: number,
    response: Response,
  ) => Promise<boolean>;
  getKnowledgeBaseObservation: GetKnowledgeBaseObservation;
};

export function createKnowledgeBaseLogoProvenanceErrorResponder(
  getKnowledgeBaseObservation: GetKnowledgeBaseObservation,
) {
  return async (
    error: unknown,
    userId: number | undefined,
    conversationId: string,
    response: Response,
  ) => {
    if (!(error instanceof KnowledgeBaseLogoProvenanceRepairError))
      return false;
    const observation = userId
      ? await getKnowledgeBaseObservation({
          userId,
          conversationId,
          upstreamStatus: "failed",
        }).catch(() => null)
      : null;
    response.status(409).json({
      error: { code: error.code, message: error.message },
      ...(observation ? { observation } : {}),
    });
    return true;
  };
}

export function createKnowledgeBaseLogoProvenanceRouter(
  dependencies: LogoProvenanceRouteDependencies,
) {
  const router = Router();
  router.post("/logo-provenance/repair", async (req, res) => {
    const body = (req.body || {}) as {
      conversationId?: string;
      clientRequestId?: string;
      expectedGeneration?: number;
      expectedRevision?: number;
      expectedLeafId?: string;
      attachmentManifest?: unknown;
      attachment?: KnowledgeBaseAttachment;
    };
    const conversationId = String(body.conversationId || "").trim();
    const clientRequestId = String(body.clientRequestId || "").trim();
    const expectedLeafId = String(body.expectedLeafId || "").trim();
    if (
      !conversationId ||
      !clientRequestId ||
      clientRequestId.length > 128 ||
      !Number.isSafeInteger(body.expectedGeneration) ||
      Number(body.expectedGeneration) < 1 ||
      !Number.isSafeInteger(body.expectedRevision) ||
      Number(body.expectedRevision) < 0 ||
      !expectedLeafId
    ) {
      res.status(400).json({
        error: {
          code: "INVALID_KNOWLEDGE_BASE_LOGO_REPAIR",
          message: "Logo 来源修复坐标无效，请刷新知识库状态后重试。",
        },
      });
      return;
    }
    if (
      !req.frontmindUser ||
      !(await dependencies.requireKnowledgeBuildCapability(
        req.frontmindUser.id,
        res,
      ))
    ) {
      return;
    }

    try {
      await assertKnowledgeBaseWritable(req.frontmindUser.id);
      const manifest = normalizeKnowledgeBaseClientAttachmentManifest(
        body.attachmentManifest,
      );
      const attachments = normalizeKnowledgeBaseUserAttachments(
        body.attachment ? [body.attachment] : [],
      );
      if (
        manifest.length !== 1 ||
        attachments.length !== 1 ||
        manifest[0]!.filename !== attachments[0]!.filename
      ) {
        res.status(400).json({
          error: {
            code: "INVALID_KNOWLEDGE_BASE_LOGO_REPAIR",
            message: "请只上传一张用于来源修复的企业主 Logo 原图。",
          },
        });
        return;
      }
      const repairInput = {
        userId: req.frontmindUser.id,
        conversationId,
        clientRequestId,
        expectedGeneration: Number(body.expectedGeneration),
        expectedRevision: Number(body.expectedRevision),
        expectedLeafId,
        attachment: attachments[0]!,
        manifest: manifest[0]!,
      };
      const replay =
        await replayCompletedKnowledgeBaseLogoProvenanceRepair(repairInput);
      let idempotent = Boolean(replay);
      if (!replay) {
        const build = await loadKnowledgeBaseBuildRecord(
          req.frontmindUser.id,
          conversationId,
        );
        if (!build) {
          res.status(404).json({
            error: {
              code: "KNOWLEDGE_BASE_NOT_FOUND",
              message: "当前对话没有可修复的知识库构建。",
            },
          });
          return;
        }
        const fileCredential = await getCredentialForUpstreamResource(
          req.frontmindUser.id,
          "file",
          attachments[0]!.file_id,
        );
        if (!knowledgeBaseLogoRepairFileIsOwned(fileCredential)) {
          res.status(403).json({
            error: {
              code: "KNOWLEDGE_BASE_FILE_FORBIDDEN",
              message: "上传的 Logo 不属于当前账号。",
            },
          });
          return;
        }
        const repaired =
          await repairKnowledgeBaseOfficialLogoProvenance(repairInput);
        idempotent = repaired.idempotent;
      }
      const observation = await dependencies.getKnowledgeBaseObservation({
        userId: req.frontmindUser.id,
        conversationId,
        upstreamStatus: "failed",
      });
      if (!observation) {
        throw new Error(
          "Knowledge-base observation disappeared after Logo repair",
        );
      }
      res.json({
        repaired: true,
        idempotent,
        observation,
        progress: observation.interaction.progress,
        interaction: observation.interaction,
      });
    } catch (error) {
      const observation = await dependencies
        .getKnowledgeBaseObservation({
          userId: req.frontmindUser.id,
          conversationId,
          upstreamStatus: "failed",
        })
        .catch(() => null);
      if (error instanceof KnowledgeBaseLogoProvenanceRepairError) {
        const status =
          error.code === "KNOWLEDGE_BASE_LOGO_REPAIR_UPLOAD_INVALID"
            ? 422
            : 409;
        res.status(status).json({
          error: { code: error.code, message: error.message },
          ...(observation ? { observation } : {}),
        });
        return;
      }
      if (error instanceof KnowledgeBaseTurnReservationError) {
        res.status(400).json({
          error: {
            code: "INVALID_KNOWLEDGE_BASE_LOGO_REPAIR",
            message: error.message,
          },
          ...(observation ? { observation } : {}),
        });
        return;
      }
      logKnowledgeBaseRuntimeFailure({
        level: "error",
        event: "[KnowledgeBaseLogoProvenanceRepair] failed",
        error,
        additionalSecrets: [req.frontmindCredential?.apiKey],
      });
      res.status(500).json({
        error: {
          code: "KNOWLEDGE_BASE_LOGO_REPAIR_FAILED",
          message: "企业主 Logo 来源修复失败，请稍后重试。",
        },
        ...(observation ? { observation } : {}),
      });
    }
  });
  return router;
}
