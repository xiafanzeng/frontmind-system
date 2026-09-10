import { Router } from "express";
import { z } from "zod";
import { enterpriseWorkspaceUserId } from "./enterprise-project-context";
import {
  controlKnowledgeBaseUpload,
  getKnowledgeBaseUploadStatus,
  KnowledgeBaseTurnReservationError,
} from "./knowledge-base-turn-service";
import type { KnowledgeBaseObservationDto } from "../shared/knowledge-base-progress";
const coordinates = z.object({
  conversationId: z.string().trim().min(1).max(191),
  turnId: z.string().min(1).max(36),
  clientRequestId: z.string().min(1).max(128),
  expectedResetRevision: z.coerce.number().int().nonnegative(),
  uploadAttemptId: z.string().min(1).max(128).optional(),
});
export function createKnowledgeBaseUploadRouter(deps: {
  requireKnowledgeBuildCapability: (
    userId: number,
    res: any,
  ) => Promise<boolean>;
  getKnowledgeBaseObservation: (
    input: any,
    executor?: any,
  ) => Promise<KnowledgeBaseObservationDto | null>;
}) {
  const router = Router();
  const handler = (control: boolean) => async (req: any, res: any) => {
    res.setHeader("Cache-Control", "private, no-store");
    if (!req.frontmindUser) {
      res
        .status(401)
        .json({
          error: {
            code: "UNAUTHORIZED",
            message: "请重新登录，已接收的资料会保留",
          },
        });
      return;
    }
    const userId = enterpriseWorkspaceUserId(req.frontmindUser.id);
    if (!(await deps.requireKnowledgeBuildCapability(userId, res))) return;
    const parsed = (
      control
        ? coordinates.extend({ action: z.enum(["stop", "resume"]) })
        : coordinates.extend({ turnId: coordinates.shape.turnId.optional() })
    ).safeParse(control ? req.body : req.query);
    if (!parsed.success) {
      res
        .status(400)
        .json({
          error: {
            code: "INVALID_UPLOAD_CONTROL",
            message: "上传批次参数无效",
          },
        });
      return;
    }
    try {
      const input = {
        ...parsed.data,
        userId,
        projectAssignmentId:
          req.frontmindDeliveryProjectContext?.projectAssignmentId ?? null,
      };
      const readObservation = (tx: any) =>
        deps.getKnowledgeBaseObservation(
          {
            userId,
            conversationId: input.conversationId,
            upstreamStatus: "local",
          },
          tx,
        );
      const result = control
        ? await controlKnowledgeBaseUpload(
            input as typeof input & {
              turnId: string;
              action: "stop" | "resume";
            },
            undefined,
            readObservation,
          )
        : await getKnowledgeBaseUploadStatus(input, undefined, readObservation);
      res.json(result);
    } catch (error) {
      const known = error instanceof KnowledgeBaseTurnReservationError;
      res
        .status(
          known
            ? error.code === "RESERVATION_NOT_FOUND" ||
              error.code === "BUILD_NOT_FOUND"
              ? 404
              : 409
            : 503,
        )
        .json({
          error: {
            code: known ? error.code : "UPLOAD_STATUS_UNAVAILABLE",
            message: known
              ? error.message
              : "暂时无法读取上传状态，请保留资料后重试",
          },
        });
    }
  };
  router.get("/turn/upload-status", handler(false));
  router.post("/turn/upload-control", handler(true));
  return router;
}
