import { getEnterpriseProjectScope } from "../enterprise-project-context";
import type { NextFunction, Response } from "express";
import { hasExplicitAdminRole } from "../../shared/admin-access";

import type { FrontMindRequest } from "./express-auth";
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

function ordinaryUserGeneralAgentWrite(
  req: Pick<FrontMindRequest, "method" | "originalUrl">,
) {
  if (req.method.toUpperCase() !== "POST") return false;
  const path = proxyPath(req);
  return (
    path === "/v2/tasks" ||
    /^\/v2\/tasks\/[^/]+\/messages$/u.test(path) ||
    /^\/v2\/tasks\/[^/]+\/actions\/[^/]+\/confirm$/u.test(path)
  );
}

/** Customer General Agent mutations use only the tenant-owned v2 contract.
 * Legacy generic provider task mutations remain administrator-only. */
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
  return (
    ordinaryUserGeneralAgentWrite(req) ||
    ORDINARY_USER_SUPPORT_OPERATIONS.has(`${method} ${pathname}`)
  );
}

export function createFrontMindProxyAccessMiddleware(
  dependencies: {
    assertProjectContext?: typeof assertDeliveryProjectContext;
  } = {},
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
          message: "当前账号不能通过通用转发接口执行此操作",
          code: "GENERAL_AGENT_MUTATION_FORBIDDEN",
        },
      });
      return;
    }
    // Tool operations are authorized by tenant ownership and their billing
    // command. Historical subscription status never gates the account agent.
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
    const enterpriseScope=getEnterpriseProjectScope();
    if (enterpriseScope?.actorUserId === user.id && !req.headers["x-delivery-project-assignment-id"]) {
      // resolveEnterpriseProjectScope already verified this engineer's owner assignment.
      next();return;
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
  const scope=getEnterpriseProjectScope();
  if(scope?.actorUserId === req.frontmindUser.id && (!req.frontmindDeliveryProjectContext || req.frontmindDeliveryProjectContext.customerUserId === scope.ownerUserId)) {
    next();return;
  }
  res.status(403).json({
    error: {
      message: "请先选择已授权的企业项目，再操作知识库",
      code: "KNOWLEDGE_BASE_PROJECT_SCOPE_UNSUPPORTED",
    },
  });
}
