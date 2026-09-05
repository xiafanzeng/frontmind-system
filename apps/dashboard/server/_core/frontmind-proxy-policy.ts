import type { NextFunction, Response } from "express";
import { hasExplicitAdminRole } from "../../shared/admin-access";

import type { FrontMindRequest } from "./express-auth";
import {
  assertServiceWriteAccess,
  ServiceEntitlementError,
} from "../service-entitlement";
import { assertDeliveryProjectContext } from "../delivery-role-service";

const ORDINARY_USER_SUPPORT_OPERATIONS = new Set([
  "POST /v2/assets",
  "POST /download-token",
  "POST /v1/files",
  "POST /v1/managed-uploads",
  "POST /v1/managed-uploads/recovery",
  "PUT /proxy-upload",
  "DELETE /v1/managed-uploads",
]);

function proxyPath(req: Pick<FrontMindRequest, "originalUrl">) {
  try {
    return new URL(req.originalUrl, "http://frontmind.local").pathname.replace(
      /^\/api\/frontmind/,
      "",
    );
  } catch {
    return "";
  }
}

/**
 * The generic proxy remains the administrator Agent workbench and the
 * read/download transport for resources created by dedicated customer
 * workflows. Customer accounts may upload attachments, but cannot create,
 * continue, cancel, or mutate model tasks through this escape hatch.
 */
export function ordinaryUserMayUseFrontMindProxy(
  req: Pick<FrontMindRequest, "method" | "originalUrl">,
) {
  const method = req.method.toUpperCase();
  const pathname = proxyPath(req);
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") {
    return true;
  }
  if (method === "DELETE" && /^\/v1\/files\/[^/]+\/discard$/u.test(pathname)) {
    return true;
  }
  if (
    method === "POST" &&
    /^\/v1\/files\/[^/]+\/upload-recovery$/u.test(pathname)
  ) {
    return true;
  }
  return ORDINARY_USER_SUPPORT_OPERATIONS.has(`${method} ${pathname}`);
}

export function ordinaryUserProxyWriteRequiresActiveService(
  req: Pick<FrontMindRequest, "method" | "originalUrl">,
) {
  const operation = `${req.method.toUpperCase()} ${proxyPath(req)}`;
  return (
    operation === "POST /v2/assets" ||
    operation === "POST /v1/files" ||
    operation === "POST /v1/managed-uploads" ||
    operation === "POST /v1/managed-uploads/recovery" ||
    operation === "PUT /proxy-upload" ||
    (req.method.toUpperCase() === "POST" &&
      /^\/v1\/files\/[^/]+\/upload-recovery$/u.test(proxyPath(req)))
  );
}

export function createFrontMindProxyAccessMiddleware(
  dependencies: {
    assertWriteAccess: typeof assertServiceWriteAccess;
    assertProjectContext?: typeof assertDeliveryProjectContext;
  } = { assertWriteAccess: assertServiceWriteAccess },
) {
  return async (req: FrontMindRequest, res: Response, next: NextFunction) => {
    const user = req.frontmindUser;
    if (!user) {
      res
        .status(401)
        .json({ error: { message: "请先登录", code: "UNAUTHORIZED" } });
      return;
    }
    if (user.role === "admin") {
      if (hasExplicitAdminRole(user)) {
        next();
      } else {
        res.status(403).json({
          error: {
            message: "管理员权限尚未配置",
            code: "ADMIN_ACCESS_LEVEL_REQUIRED",
          },
        });
      }
      return;
    }
    if (user.role === "delivery_member") {
      return createDeliveryProjectContextMiddleware({
        assertProjectContext: dependencies.assertProjectContext,
      })(req, res, next);
    }
    if (!ordinaryUserMayUseFrontMindProxy(req)) {
      res.status(403).json({
        error: {
          message:
            "用户看板只能通过对应服务流程调用模型；通用智能体操作仅向管理员开放",
          code: "GENERAL_AGENT_MUTATION_FORBIDDEN",
        },
      });
      return;
    }
    if (ordinaryUserProxyWriteRequiresActiveService(req)) {
      try {
        await dependencies.assertWriteAccess(user.id);
      } catch (error) {
        if (error instanceof ServiceEntitlementError) {
          res.status(error.statusCode).json({
            error: { message: error.message, code: error.code },
          });
          return;
        }
        throw error;
      }
    }
    next();
  };
}

export const enforceFrontMindProxyAccess =
  createFrontMindProxyAccessMiddleware();

function isDirectDownloadTokenRequest(req: FrontMindRequest) {
  if (req.method.toUpperCase() !== "GET") return false;
  return /^\/(?:assets\/)?download\/[^/]+$/.test(proxyPath(req));
}

export function createDeliveryProjectContextMiddleware(
  dependencies: {
    assertProjectContext?: typeof assertDeliveryProjectContext;
  } = {},
) {
  return async (req: FrontMindRequest, res: Response, next: NextFunction) => {
    const user = req.frontmindUser;
    if (!user || user.role !== "delivery_member") {
      next();
      return;
    }
    // Native browser downloads cannot attach a custom header. Their one-time
    // token carries the project assignment and is revalidated by the route.
    if (isDirectDownloadTokenRequest(req)) {
      next();
      return;
    }
    const projectAssignmentId = String(
      req.headers["x-delivery-project-assignment-id"] || "",
    ).trim();
    if (!projectAssignmentId) {
      res.status(400).json({
        error: {
          message: "请先选择当前客户项目",
          code: "DELIVERY_PROJECT_CONTEXT_REQUIRED",
        },
      });
      return;
    }
    try {
      req.frontmindDeliveryProjectContext = await (
        dependencies.assertProjectContext ?? assertDeliveryProjectContext
      )({
        actor: user,
        projectAssignmentId,
      });
    } catch {
      res.status(403).json({
        error: {
          message: "当前客户项目岗位不存在或已停用",
          code: "DELIVERY_PROJECT_CONTEXT_FORBIDDEN",
        },
      });
      return;
    }
    next();
  };
}

export const enforceDeliveryProjectContext =
  createDeliveryProjectContextMiddleware();

/**
 * Knowledge-base persistence is still account-scoped. Validate the selected
 * delivery project first, then stop before any account credential or KB row
 * can be read or written under an ambiguous null project scope.
 */
export function rejectDeliveryMemberKnowledgeBaseProjectScope(
  req: FrontMindRequest,
  res: Response,
  next: NextFunction,
) {
  if (req.frontmindUser?.role !== "delivery_member") {
    next();
    return;
  }
  res.status(403).json({
    error: {
      message: "当前知识库暂不支持工程师项目工作区，请由客户账号操作",
      code: "KNOWLEDGE_BASE_PROJECT_SCOPE_UNSUPPORTED",
    },
  });
}
