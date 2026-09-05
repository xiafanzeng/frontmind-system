import { Router, type Request, type Response } from "express";

import type { FrontMindRequest } from "./_core/express-auth";
import type { AuthenticatedUser } from "./auth-service";
import { toBrandTrackingPublicEvent } from "./brand-tracking-public-projection";
import {
  JenovaBrandTrackingError,
  jenovaBrandTrackingHttpStatus,
  sendJenovaBrandTrackingMessage,
  startJenovaBrandTrackingSession,
  type BrandTrackingSseEvent,
} from "./jenova-brand-tracking-service";
import {
  assertServiceCapability,
  ServiceEntitlementError,
} from "./service-entitlement";

const router = Router();

function requestOriginMatchesHost(req: Request) {
  const origin = req.get("origin");
  const host = req.get("host");
  if (!origin || !host) return false;
  try {
    const parsed = new URL(origin);
    return (
      parsed.protocol === `${req.protocol}:` &&
      parsed.host.toLowerCase() === host.toLowerCase()
    );
  } catch {
    return false;
  }
}

function rejectUnsafePaidPost(req: Request, res: Response) {
  if (!req.is("application/json")) {
    res.status(415).json({
      error: {
        code: "UNSUPPORTED_MEDIA_TYPE",
        message: "品牌追踪请求必须使用 JSON",
      },
    });
    return true;
  }
  const fetchSite = req.get("sec-fetch-site");
  if (
    !requestOriginMatchesHost(req) ||
    (fetchSite !== undefined && fetchSite !== "same-origin")
  ) {
    res.status(403).json({
      error: {
        code: "CROSS_SITE_REQUEST_FORBIDDEN",
        message: "品牌追踪请求必须来自当前站点",
      },
    });
    return true;
  }
  return false;
}

function sendJsonError(res: Response, error: unknown) {
  const known = error instanceof JenovaBrandTrackingError;
  const status = jenovaBrandTrackingHttpStatus(error);
  if (known && error.retryAfterMs) {
    res.setHeader("Retry-After", String(Math.ceil(error.retryAfterMs / 1_000)));
  }
  const projected = toBrandTrackingPublicEvent({
    event: "error",
    data: {
      code: known ? error.code : "INTERNAL_ERROR",
      message: known ? error.message : "品牌追踪服务暂时不可用，请稍后重试",
      recoverable: status >= 500,
    },
  });
  res.status(status).json({
    error: {
      code: projected.data.code,
      message: projected.data.message,
    },
  });
}

async function requireBrandTrackingCapability(
  actor: AuthenticatedUser,
  response: Response,
) {
  try {
    await assertServiceCapability(actor.id, "brandTracking");
    return true;
  } catch (error) {
    if (error instanceof ServiceEntitlementError) {
      response.status(error.statusCode).json({
        error: { code: error.code, message: error.message },
      });
      return false;
    }
    response.status(503).json({
      error: {
        code: "SERVICE_UNAVAILABLE",
        message: "品牌追踪服务暂时不可用，请稍后重试",
      },
    });
    return false;
  }
}

function createSseChannel(res: Response) {
  let initialized = false;
  let disconnected = false;
  let heartbeat: ReturnType<typeof setInterval> | null = null;

  const initialize = () => {
    if (initialized) return;
    initialized = true;
    res.status(200);
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();
    heartbeat = setInterval(() => {
      if (!disconnected && !res.writableEnded && !res.destroyed) {
        res.write(": keep-alive\n\n");
      }
    }, 15_000);
    heartbeat.unref?.();
  };
  res.on("close", () => {
    disconnected = true;
    if (heartbeat) clearInterval(heartbeat);
  });

  return {
    get initialized() {
      return initialized;
    },
    emit(event: BrandTrackingSseEvent) {
      initialize();
      if (disconnected || res.writableEnded || res.destroyed) return;
      const projected = toBrandTrackingPublicEvent(event);
      res.write(`event: ${projected.event}\n`);
      res.write(`data: ${JSON.stringify(projected.data)}\n\n`);
    },
    finish() {
      if (heartbeat) clearInterval(heartbeat);
      if (!disconnected && !res.writableEnded && !res.destroyed) res.end();
    },
  };
}

router.post("/sessions", async (request, response) => {
  const req = request as FrontMindRequest;
  const actor = req.frontmindUser;
  if (!actor) {
    response.status(401).json({
      error: { code: "UNAUTHORIZED", message: "请先登录" },
    });
    return;
  }
  if (rejectUnsafePaidPost(request, response)) return;
  if (!(await requireBrandTrackingCapability(actor, response))) return;
  const channel = createSseChannel(response);
  try {
    await startJenovaBrandTrackingSession({
      actor,
      clientRequestId: String(req.body?.clientRequestId ?? ""),
      emit: channel.emit,
    });
    channel.finish();
  } catch (error) {
    if (!channel.initialized) {
      sendJsonError(response, error);
      return;
    }
    channel.emit({
      event: "error",
      data: {
        code:
          error instanceof JenovaBrandTrackingError
            ? error.code
            : "INTERNAL_ERROR",
        message:
          error instanceof JenovaBrandTrackingError
            ? error.message
            : "品牌追踪服务暂时不可用，请稍后刷新会话",
        recoverable: true,
      },
    });
    channel.finish();
  }
});

router.post("/sessions/:sessionId/messages", async (request, response) => {
  const req = request as FrontMindRequest;
  const actor = req.frontmindUser;
  if (!actor) {
    response.status(401).json({
      error: { code: "UNAUTHORIZED", message: "请先登录" },
    });
    return;
  }
  if (rejectUnsafePaidPost(request, response)) return;
  if (!(await requireBrandTrackingCapability(actor, response))) return;
  const channel = createSseChannel(response);
  try {
    await sendJenovaBrandTrackingMessage({
      actor,
      sessionId: req.params.sessionId,
      content: String(req.body?.content ?? ""),
      clientRequestId: String(req.body?.clientRequestId ?? ""),
      emit: channel.emit,
    });
    channel.finish();
  } catch (error) {
    if (!channel.initialized) {
      sendJsonError(response, error);
      return;
    }
    channel.emit({
      event: "error",
      data: {
        code:
          error instanceof JenovaBrandTrackingError
            ? error.code
            : "INTERNAL_ERROR",
        message:
          error instanceof JenovaBrandTrackingError
            ? error.message
            : "品牌追踪服务暂时不可用，请稍后刷新会话",
        recoverable: true,
      },
    });
    channel.finish();
  }
});

export default router;
