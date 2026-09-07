import { createHmac } from "node:crypto";
import type { Request, RequestHandler } from "express";
import {
  createMonitoringRuntime,
  type MonitoringRuntime,
} from "@frontmind/monitoring-api/runtime";
import { ensureDashboardAccountLink, syncDashboardMonitoringAccounts, runWithMonitoringEnterpriseScope } from "@frontmind/monitoring-db";
import { AuthServiceError, authenticateRequest } from "./auth-service";
import { requestEnterpriseProjectId } from "./enterprise-project-request";
import { resolveEnterpriseProjectScope } from "./enterprise-project-service";
import { getEnterpriseProjectScope, runWithEnterpriseProjectScope } from "./enterprise-project-scope";

let runtime: MonitoringRuntime | undefined;

export function monitoringEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const secret = env.MONITORING_SESSION_SECRET?.trim() ||
    (env.FRONTMIND_CREDENTIAL_ENCRYPTION_KEY
      ? createHmac("sha256", env.FRONTMIND_CREDENTIAL_ENCRYPTION_KEY)
          .update("frontmind-system:monitoring-capabilities:v1").digest("hex")
      : undefined);
  if (!secret && env.NODE_ENV === "production") {
    throw new Error("MONITORING_SESSION_SECRET or FRONTMIND_CREDENTIAL_ENCRYPTION_KEY is required");
  }
  const publicOrigin = env.MONITORING_PUBLIC_ORIGIN || env.FRONTMIND_PUBLIC_URL ||
    env.PUBLIC_ORIGIN || "http://localhost:3000";
  return {
    ...env,
    PUBLIC_ORIGIN: new URL(publicOrigin).origin,
    SESSION_SECRET: secret,
    // A website payment return URL must never be inherited by this module.
    FRONTMIND_PUBLIC_BASE_URL: env.FRONTMIND_ZPAY_PID || env.FRONTMIND_ZPAY_KEY
      ? new URL(publicOrigin).origin : undefined,
    BUILD_SHA: env.FRONTMIND_BUILD_SHA || env.BUILD_SHA,
    WEB_DIST_DIR: undefined,
  };
}

export async function resolveMonitoringIdentity(request: Request) {
  // This is a fresh server-side Dashboard session check on every request.
  // No browser-supplied UUID, role, cookie namespace or impersonation header
  // participates in mapping or tenant ownership.
  const dashboardUser = await authenticateRequest(request);
  if (!dashboardUser) return null;
  const services = getMonitoringRuntime();
  const scope = getEnterpriseProjectScope();
  const link = await ensureDashboardAccountLink(services.repository.db, scope?.ownerUserId ?? dashboardUser.id);
  const actorLink = scope && scope.ownerUserId !== dashboardUser.id ? await ensureDashboardAccountLink(services.repository.db, dashboardUser.id) : link;
  return {
    user: {
      id: link.monitoringUserId,
      username: dashboardUser.username,
      role: !scope && dashboardUser.role === "admin" && dashboardUser.adminAccessLevel === "system_admin"
        ? "admin" as const : "user" as const,
      status: "active" as const,
    },
    auditActor: { id: actorLink.monitoringUserId, role: dashboardUser.role === "admin" ? "admin" as const : "user" as const },
    session: null,
    tokenHash: null,
  };
}

export function getMonitoringRuntime(): MonitoringRuntime {
  runtime ??= createMonitoringRuntime({
    env: monitoringEnvironment(process.env),
    auth: {
      resolve: resolveMonitoringIdentity,
      syncAccounts: () => syncDashboardMonitoringAccounts(getMonitoringRuntime().repository.db),
    },
  });
  return runtime;
}

/** Mount before the Dashboard body parser: uploads and payment signatures own theirs. */
export const monitoringModule: RequestHandler = async (request, response, next) => {
  try {
    const projectId = requestEnterpriseProjectId(request);
    const actor = await authenticateRequest(request);
    if (!actor) { getMonitoringRuntime().app(request, response, next); return; }
    const projectScope = projectId ? await resolveEnterpriseProjectScope(actor, projectId) : null;
    const link = await ensureDashboardAccountLink(getMonitoringRuntime().repository.db, projectScope?.ownerUserId ?? actor.id);
    const dispatch = () => runWithMonitoringEnterpriseScope({ enterpriseProjectId: projectScope?.enterpriseProjectId ?? null, ownerId: link.monitoringUserId }, () => getMonitoringRuntime().app(request, response, next));
    if (projectScope) runWithEnterpriseProjectScope(projectScope, dispatch); else dispatch();
  } catch (error) {
    if (error instanceof AuthServiceError && error.code === "NOT_FOUND") { response.status(404).json({error:"企业项目不存在或无权访问"}); return; }
    if (error instanceof Error && (error.name === "ZodError" || error.message === "ENTERPRISE_PROJECT_SCOPE_CONFLICT")) { response.status(400).json({error:"企业项目参数无效"}); return; }
    console.error("[Monitoring] Module unavailable", error instanceof Error ? error.name : "configuration");
    response.status(503).json({ error: "问题监控与媒体发布服务暂不可用" });
  }
};
