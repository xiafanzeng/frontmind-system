import type { NextFunction, Response } from "express";
import {
  AuthServiceError,
  credentialsUseSameUpstreamApiKey,
  getEffectiveDecryptedCredentialForAccount,
  getCredentialForUpstreamResource,
} from "../auth-service";
import type { FrontMindRequest } from "./express-auth";

type ResourceRef = { kind: "task" | "file"; id: string };

function pathWithoutQuery(req: FrontMindRequest) {
  return req.originalUrl.replace(/^\/api\/frontmind/, "").split("?")[0] || "/";
}

function getPrimaryResource(req: FrontMindRequest): ResourceRef | null {
  const path = pathWithoutQuery(req);
  const taskMatch = path.match(/^\/v1\/(?:tasks|responses)\/([^/]+)/);
  if (taskMatch) return { kind: "task", id: decodeURIComponent(taskMatch[1]) };

  const fileMatch = path.match(/^\/v1\/files\/([^/]+)/);
  if (fileMatch) return { kind: "file", id: decodeURIComponent(fileMatch[1]) };

  if (path === "/download-token" && typeof req.body?.fileId === "string") {
    return { kind: "file", id: req.body.fileId };
  }

  if (req.method === "POST" && path === "/v1/tasks") {
    const continuationId = req.body?.taskId ?? req.body?.previous_response_id;
    if (typeof continuationId === "string" && continuationId) {
      return { kind: "task", id: continuationId };
    }
  }
  return null;
}

function getAttachmentFileIds(req: FrontMindRequest) {
  if (req.method !== "POST") return [];
  if (!Array.isArray(req.body?.attachments)) return [];
  return req.body.attachments
    .map((item: unknown) =>
      item && typeof item === "object"
        ? String(
            (item as { file_id?: unknown; fileId?: unknown }).file_id ??
              (item as { fileId?: unknown }).fileId ??
              "",
          )
        : "",
    )
    .filter(Boolean);
}

function sendCredentialError(
  res: Response,
  status: number,
  message: string,
  code: string,
) {
  res.status(status).json({ error: { message, code } });
}

/**
 * Selects the credential version for a proxy request. Existing task/file IDs
 * must already be present in the ownership ledger; new resource creation uses
 * the account's active credential.
 */
export async function resolveUpstreamCredential(
  req: FrontMindRequest,
  res: Response,
  next: NextFunction,
) {
  const user = req.frontmindUser;
  if (!user) {
    sendCredentialError(res, 401, "请先登录", "UNAUTHORIZED");
    return;
  }

  try {
    // A one-time download token already carries the credential version chosen
    // when it was issued. The route itself binds that token to the logged-in
    // user, so requiring a currently active key here would break downloads for
    // historical conversations after key rotation.
    const requestPath = pathWithoutQuery(req);
    // Existing managed-upload intents and knowledge-base scoped replacement
    // intents freeze the exact credential version in the durable reservation.
    // their durable manifest. Requiring a *currently active* credential here
    // would strand a sealed local copy after A -> B rotation followed by
    // deletion of B. These three operations authenticate the actor/project and
    // the mi1 ticket at the intent service, which then resolves frozen A. Only
    // Generic creation still requires the active credential. The scoped POST
    // is deliberately deferred to the route, which re-proves the exact owner,
    // project, turn, item and pinned active/retired credential before writing.
    const isKnowledgeBaseScopedManagedUploadCreation =
      req.method === "POST" &&
      requestPath === "/v1/managed-uploads" &&
      req.body?.resumeScope?.kind === "knowledge_base";
    const isExistingManagedUploadIntentOperation =
      (req.method === "PUT" &&
        requestPath === "/proxy-upload" &&
        typeof req.query.upload_intent_id === "string" &&
        req.query.upload_intent_id.length > 0) ||
      (req.method === "POST" &&
        requestPath === "/v1/managed-uploads/recovery") ||
      (req.method === "GET" && requestPath === "/v1/managed-uploads") ||
      (req.method === "DELETE" && requestPath === "/v1/managed-uploads");
    if (
      isExistingManagedUploadIntentOperation ||
      isKnowledgeBaseScopedManagedUploadCreation
    ) {
      next();
      return;
    }
    if (
      requestPath === "/proxy-download" ||
      /^\/download\/[^/]+$/.test(requestPath)
    ) {
      next();
      return;
    }

    const primaryResource = getPrimaryResource(req);
    const projectAssignmentId =
      user.role === "delivery_member"
        ? req.frontmindDeliveryProjectContext?.projectAssignmentId
        : undefined;
    const allowExpiredFileContent =
      primaryResource?.kind === "file" &&
      ((["GET", "HEAD"].includes(req.method) &&
        /^\/v1\/files\/[^/]+(?:\/content)?$/.test(requestPath)) ||
        (req.method === "POST" && requestPath === "/download-token"));
    const credential = primaryResource
      ? await getCredentialForUpstreamResource(
          user.id,
          primaryResource.kind,
          primaryResource.id,
          projectAssignmentId,
          allowExpiredFileContent
            ? { allowExpiredFileContent: true }
            : undefined,
        )
      : await getEffectiveDecryptedCredentialForAccount(user.id);

    if (!credential) {
      sendCredentialError(
        res,
        primaryResource ? 403 : 428,
        primaryResource
          ? "该任务或文件不属于当前账号，或其原 API Key 已删除"
          : user.role === "delivery_member"
            ? "当前工具凭据尚未配置，请联系负责该项目的交付管理员"
            : "当前账号尚未由管理员配置 API Key",
        primaryResource
          ? "UPSTREAM_RESOURCE_FORBIDDEN"
          : "API_CREDENTIAL_REQUIRED",
      );
      return;
    }

    for (const fileId of getAttachmentFileIds(req)) {
      const ownedFile = await getCredentialForUpstreamResource(
        user.id,
        "file",
        fileId,
        projectAssignmentId,
      );
      if (
        !ownedFile ||
        !credentialsUseSameUpstreamApiKey(ownedFile, credential)
      ) {
        sendCredentialError(
          res,
          403,
          "附件不属于当前账号，或与当前任务使用的 API Key 不一致",
          "ATTACHMENT_FORBIDDEN",
        );
        return;
      }
    }

    req.frontmindCredential = credential;
    next();
  } catch (error) {
    const configurationError =
      error instanceof AuthServiceError && error.code === "INVALID_MASTER_KEY";
    console.error("[Credential] Failed to resolve upstream credential", error);
    sendCredentialError(
      res,
      503,
      configurationError ? "服务端凭据加密配置无效" : "API Key 暂不可用",
      configurationError
        ? "CREDENTIAL_ENCRYPTION_UNAVAILABLE"
        : "CREDENTIAL_UNAVAILABLE",
    );
  }
}
