import { createHmac } from "node:crypto";
import type { Request, RequestHandler } from "express";
import {
  createMonitoringRuntime,
  type MonitoringRuntime,
} from "@frontmind/monitoring-api/runtime";
import { ensureDashboardAccountLink, syncDashboardMonitoringAccounts } from "@frontmind/monitoring-db";
import { authenticateRequest } from "./auth-service";

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
  const link = await ensureDashboardAccountLink(services.repository.db, dashboardUser.id);
  return {
    user: {
      id: link.monitoringUserId,
      username: dashboardUser.username,
      role: dashboardUser.role === "admin" && dashboardUser.adminAccessLevel === "system_admin"
        ? "admin" as const : "user" as const,
      status: "active" as const,
    },
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
export const monitoringModule: RequestHandler = (request, response, next) => {
  try {
    getMonitoringRuntime().app(request, response, next);
  } catch (error) {
    console.error("[Monitoring] Module unavailable", error instanceof Error ? error.name : "configuration");
    response.status(503).json({ error: "问题监控与媒体发布服务暂不可用" });
  }
};
