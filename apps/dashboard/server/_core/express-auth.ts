import type { NextFunction, Request, Response } from "express";
import {
  AuthServiceError,
  authenticateRequest,
  getEffectiveDecryptedCredentialForAccount,
  type AuthenticatedUser,
  type DecryptedCredential,
} from "../auth-service";
import type { DeliveryRoleType } from "../../shared/delivery-roles";
import { enterpriseWorkspaceUserId } from "../enterprise-project-context";
import { requestEnterpriseProjectId } from "../enterprise-project-request";
import { resolveEnterpriseProjectScope } from "../enterprise-project-service";
import { runWithEnterpriseProjectScope } from "../enterprise-project-scope";

export type FrontMindRequest = Request & {
  frontmindUser?: AuthenticatedUser;
  frontmindCredential?: DecryptedCredential;
  frontmindDeliveryProjectContext?: {
    projectAssignmentId: string;
    customerUserId: number;
    roleType: DeliveryRoleType;
    customerName: string;
  };
};

function sendAuthError(
  res: Response,
  status: number,
  message: string,
  code: string,
) {
  res.status(status).json({ error: { message, code } });
}

export async function requireExpressAuth(
  req: FrontMindRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const user = await authenticateRequest(req);
    if (!user) {
      sendAuthError(res, 401, "请先登录", "UNAUTHORIZED");
      return;
    }
    req.frontmindUser = user;
    let projectId: string | null;
    try { projectId = requestEnterpriseProjectId(req); }
    catch { sendAuthError(res, 400, "企业项目参数无效", "INVALID_PROJECT"); return; }
    if (projectId) {
      const scope = await resolveEnterpriseProjectScope(user, projectId).catch(() => null);
      if (!scope) { sendAuthError(res, 404, "企业项目不存在或无权访问", "PROJECT_NOT_FOUND"); return; }
      runWithEnterpriseProjectScope(scope, next);
      return;
    }
    next();
  } catch (error) {
    console.error("[Auth] Express authentication failed", error);
    sendAuthError(res, 503, "登录服务暂不可用", "AUTH_UNAVAILABLE");
  }
}

export async function attachActiveCredential(
  req: FrontMindRequest,
  res: Response,
  next: NextFunction,
) {
  if (!req.frontmindUser) {
    sendAuthError(res, 401, "请先登录", "UNAUTHORIZED");
    return;
  }

  try {
    const credential = await getEffectiveDecryptedCredentialForAccount(
      enterpriseWorkspaceUserId(req.frontmindUser.id),
    );
    if (!credential) {
      const customerCredentialRequired = req.frontmindUser.role === "user";
      sendAuthError(
        res,
        428,
        customerCredentialRequired
          ? "当前客户账号尚未配置 API Key"
          : "当前账号尚未由管理员配置 API Key",
        customerCredentialRequired
          ? "CUSTOMER_KEY_REQUIRED"
          : "API_CREDENTIAL_REQUIRED",
      );
      return;
    }
    req.frontmindCredential = credential;
    next();
  } catch (error) {
    const invalidKey =
      error instanceof AuthServiceError && error.code === "INVALID_MASTER_KEY";
    console.error("[Credential] Failed to load account credential", error);
    sendAuthError(
      res,
      503,
      invalidKey ? "服务端凭据加密配置无效" : "API Key 暂不可用",
      invalidKey
        ? "CREDENTIAL_ENCRYPTION_UNAVAILABLE"
        : "CREDENTIAL_UNAVAILABLE",
    );
  }
}

/**
 * Loads the active credential when one exists, while allowing authenticated
 * routes that do not call the upstream API
 * to remain usable before a key is configured.
 */
export async function attachOptionalActiveCredential(
  req: FrontMindRequest,
  res: Response,
  next: NextFunction,
) {
  if (!req.frontmindUser) {
    sendAuthError(res, 401, "请先登录", "UNAUTHORIZED");
    return;
  }

  // These routes authenticate the actor/project but use the reservation's frozen
  // credential (or no provider at all). A newer broken key must not strand status or stop.
  const pathname=String(req.originalUrl ?? req.url ?? "").split("?")[0];
  if (/^\/api\/knowledge-base\/turn\/(?:upload-status|upload-control|upload-heartbeat|dispatch|attachments(?:\/|$))/u.test(pathname) ||
      (pathname === "/api/frontmind/v2/assets" && req.headers["x-frontmind-kb-turn-id"])) {
    next();return;
  }

  try {
    const credential = await getEffectiveDecryptedCredentialForAccount(
      enterpriseWorkspaceUserId(req.frontmindUser.id),
    );
    if (credential) req.frontmindCredential = credential;
    next();
  } catch (error) {
    const invalidKey =
      error instanceof AuthServiceError && error.code === "INVALID_MASTER_KEY";
    console.error("[Credential] Failed to load account credential", error);
    sendAuthError(
      res,
      503,
      invalidKey ? "服务端凭据加密配置无效" : "API Key 暂不可用",
      invalidKey
        ? "CREDENTIAL_ENCRYPTION_UNAVAILABLE"
        : "CREDENTIAL_UNAVAILABLE",
    );
  }
}
