import { createHash } from "node:crypto";

import express from "express";
import { ZodError } from "zod";

import { websiteContentTemplateSchema } from "../shared/delivery-ticket";
import { AuthServiceError } from "./auth-service";
import type { FrontMindRequest } from "./_core/express-auth";
import { requireExpressAuth } from "./_core/express-auth";
import { DashboardImportPreflightError } from "./dashboard-import-preflight-service";
import { DeliveryTicketError } from "./delivery-ticket-error";
import { ServiceEntitlementError } from "./service-entitlement";
import {
  downloadWebsiteContentTemplate,
  previewWebsiteContentTemplate,
  publishWebsiteContentTemplate,
  WebsiteContentTemplateError,
} from "./website-content-template-service";

const router = express.Router();

class WebsiteContentTemplateApiError extends Error {
  constructor(
    readonly code:
      | "WEBSITE_CONTENT_TEMPLATE_BAD_REQUEST"
      | "WEBSITE_CONTENT_TEMPLATE_EMPTY"
      | "WEBSITE_CONTENT_TEMPLATE_INVALID_JSON"
      | "WEBSITE_CONTENT_TEMPLATE_PREVIEW_REQUIRED"
      | "WEBSITE_CONTENT_TEMPLATE_FILE_CHANGED",
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
    this.name = "WebsiteContentTemplateApiError";
  }
}

function workspaceUserId(value: string) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new WebsiteContentTemplateApiError(
      "WEBSITE_CONTENT_TEMPLATE_BAD_REQUEST",
      "用户 ID 无效。",
      400,
    );
  }
  return parsed;
}

function assertWebsiteTemplateExecutionActor(
  actor: NonNullable<FrontMindRequest["frontmindUser"]>,
) {
  if (actor.role === "admin" && actor.adminAccessLevel === "delivery_admin") {
    throw new AuthServiceError(
      "INVALID_CREDENTIAL",
      "交付管理员只能调度官网工单，不能上传或发布官网内容",
    );
  }
}

function requestBytes(req: express.Request) {
  if (Buffer.isBuffer(req.body)) return req.body;
  if (typeof req.body === "string") return Buffer.from(req.body, "utf8");
  return Buffer.alloc(0);
}

export function websiteContentTemplateFileHash(bytes: Buffer) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function assertWebsiteContentTemplatePublishHash(
  value: string | undefined,
  actual: string,
) {
  const expected = value?.trim().toLowerCase() || "";
  if (!/^[a-f0-9]{64}$/.test(expected)) {
    throw new WebsiteContentTemplateApiError(
      "WEBSITE_CONTENT_TEMPLATE_PREVIEW_REQUIRED",
      "发布前必须先预检同一份官网内容模板。",
      409,
    );
  }
  if (expected !== actual) {
    throw new WebsiteContentTemplateApiError(
      "WEBSITE_CONTENT_TEMPLATE_FILE_CHANGED",
      "文件内容在预检后发生变化，请重新预检。",
      409,
    );
  }
}

function responseError(error: unknown) {
  if (error instanceof WebsiteContentTemplateApiError) {
    return {
      status: error.statusCode,
      code: error.code,
      message: error.message,
    };
  }
  if (error instanceof WebsiteContentTemplateError) {
    return {
      status: error.statusCode,
      code: error.code,
      message: error.message,
    };
  }
  if (error instanceof DashboardImportPreflightError) {
    return {
      status: error.statusCode,
      code: error.code,
      message: error.message,
    };
  }
  if (error instanceof DeliveryTicketError) {
    return {
      status: error.statusCode,
      code: error.code,
      message: error.message,
    };
  }
  if (error instanceof ServiceEntitlementError) {
    return {
      status: error.statusCode,
      code: error.code,
      message: error.message,
    };
  }
  if (error instanceof AuthServiceError) {
    return {
      status:
        error.code === "NOT_FOUND"
          ? 404
          : error.code === "DATABASE_UNAVAILABLE"
            ? 503
            : 403,
      code: error.code,
      message:
        error.code === "NOT_FOUND"
          ? "企业工作台不存在或当前管理员无权访问。"
          : error.message,
    };
  }
  if (error instanceof ZodError) {
    return {
      status: 400,
      code: "WEBSITE_CONTENT_TEMPLATE_SCHEMA_INVALID",
      message:
        error.issues[0]?.message || "官网内容模板字段不符合当前格式要求。",
    };
  }
  return {
    status: 500,
    code: "WEBSITE_CONTENT_TEMPLATE_FAILED",
    message: "官网内容模板处理失败，请稍后重试。",
  };
}

router.use(requireExpressAuth);

router.get("/:userId", async (req: FrontMindRequest, res) => {
  try {
    const targetUserId = workspaceUserId(req.params.userId);
    const template = await downloadWebsiteContentTemplate({
      actor: req.frontmindUser!,
      workspaceUserId: targetUserId,
    });
    const bytes = Buffer.from(JSON.stringify(template, null, 2), "utf8");
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="frontmind-website-content-current-${targetUserId}.json"`,
    );
    res.send(bytes);
  } catch (error) {
    const response = responseError(error);
    res.status(response.status).json({ error: response });
  }
});

router.put(
  "/:userId",
  express.raw({ type: "application/octet-stream", limit: "16mb" }),
  async (req: FrontMindRequest, res) => {
    try {
      const targetUserId = workspaceUserId(req.params.userId);
      assertWebsiteTemplateExecutionActor(req.frontmindUser!);
      const bytes = requestBytes(req);
      if (bytes.length === 0) {
        throw new WebsiteContentTemplateApiError(
          "WEBSITE_CONTENT_TEMPLATE_EMPTY",
          "上传的官网内容模板为空。",
          400,
        );
      }
      let raw: unknown;
      try {
        raw = JSON.parse(bytes.toString("utf8"));
      } catch {
        throw new WebsiteContentTemplateApiError(
          "WEBSITE_CONTENT_TEMPLATE_INVALID_JSON",
          "官网内容模板不是有效的 JSON 文件。",
          400,
        );
      }
      const template = websiteContentTemplateSchema.parse(raw);
      const fileHash = websiteContentTemplateFileHash(bytes);
      const preview =
        String(req.header("x-import-preview") || "").toLowerCase() === "true";
      res.setHeader("Cache-Control", "private, no-store");
      if (preview) {
        const result = await previewWebsiteContentTemplate({
          actor: req.frontmindUser!,
          workspaceUserId: targetUserId,
          template,
          fileHash,
        });
        res.json({
          kind: "website-content-template-preview",
          preview: result,
        });
        return;
      }
      assertWebsiteContentTemplatePublishHash(
        req.header("x-import-file-hash"),
        fileHash,
      );
      const result = await publishWebsiteContentTemplate({
        actor: req.frontmindUser!,
        workspaceUserId: targetUserId,
        template,
        fileHash,
        preflightToken: req.header("x-import-preflight-token"),
      });
      res.json({ kind: "website-content-template", result });
    } catch (error) {
      const response = responseError(error);
      if (response.status >= 500) {
        console.error("[Website content template] Request failed", error);
      }
      res.status(response.status).json({ error: response });
    }
  },
);

export default router;
