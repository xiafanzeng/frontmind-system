import { randomBytes } from "node:crypto";
import path from "node:path";
import { Readable } from "node:stream";
import express from "express";
import JSZip from "jszip";
import { and, eq } from "drizzle-orm";

import {
  siteBuilds,
  siteProjects,
  socialPackages,
  websiteStyleSampleBatches,
  websiteStyleSamples,
} from "../../drizzle/schema";
import { siteContentPlanV2Schema } from "../../shared/siteops-content-plan";
import { getDb } from "../db";
import { readSiteOpsArtifact } from "./artifact-store";
import { exchangeAliyunOAuthCode } from "./aliyun-platform-service";
import { completeSiteOpsAliyunOAuth } from "./service";
import { previewNavigationBridgeSource } from "./preview-routing";
import { customerVisibleStyleBatchStatusCondition } from "./visual-batch-visibility";

const MAX_ARCHIVE_BYTES = 100 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 2_000;
const MAX_CONTENT_PLAN_BYTES = 4 * 1024 * 1024;

type AliyunOAuthCompletionStatus = "success" | "cancelled" | "failed";
type AliyunOAuthCallbackStage =
  | "session"
  | "provider_authorization"
  | "oauth_exchange"
  | "account_bind";

const SAFE_ALIYUN_OAUTH_ERROR_CODES = new Set([
  "CREDENTIAL_ROTATED",
  "DATABASE_UNAVAILABLE",
  "FORBIDDEN",
  "INVALID_CALLBACK",
  "INVALID_CREDENTIAL",
  "NOT_FOUND",
  "PROVIDER_AUTHORIZATION_FAILED",
  "PROVIDER_NOT_CONFIGURED",
  "RATE_LIMITED",
  "STATE_CONFLICT",
  "UNAUTHENTICATED",
  "UPSTREAM_UNAVAILABLE",
]);

function safeAliyunOAuthErrorCode(error: unknown) {
  const code =
    error && typeof error === "object" && "code" in error
      ? (error as { code?: unknown }).code
      : null;
  return typeof code === "string" && SAFE_ALIYUN_OAUTH_ERROR_CODES.has(code)
    ? code
    : "UNEXPECTED_ERROR";
}

function logAliyunOAuthCallbackFailure(input: {
  correlationId: string;
  stage: AliyunOAuthCallbackStage;
  userId: number | null;
  errorCode: string;
  startedAt: number;
}) {
  const buildSha = process.env.FRONTMIND_BUILD_SHA?.trim() ?? "";
  console.error("[SiteOps Aliyun OAuth] callback_stage_failed", {
    event: "siteops_aliyun_oauth_callback_stage_failed",
    correlationId: input.correlationId,
    stage: input.stage,
    userId: input.userId,
    errorCode: SAFE_ALIYUN_OAUTH_ERROR_CODES.has(input.errorCode)
      ? input.errorCode
      : "UNEXPECTED_ERROR",
    latencyMs: Math.max(0, Date.now() - input.startedAt),
    releaseSha: /^[a-f0-9]{40}$/u.test(buildSha) ? buildSha : null,
  });
}

const ALIYUN_OAUTH_COMPLETION_COPY: Record<
  AliyunOAuthCompletionStatus,
  { title: string; description: string }
> = {
  success: {
    title: "阿里云授权已完成",
    description: "账号已经连接，可以返回 AI友好官网管理选择并配置域名。",
  },
  cancelled: {
    title: "已取消阿里云授权",
    description: "未保存新的客户账号连接，可以返回后重新发起授权。",
  },
  failed: {
    title: "阿里云授权暂时无法完成",
    description: "请返回 AI友好官网管理后重试，或联系 FrontMind 协助处理。",
  },
};

function sendAliyunOAuthCompletionPage(
  res: express.Response,
  status: AliyunOAuthCompletionStatus,
) {
  const nonce = randomBytes(18).toString("base64url");
  const copy = ALIYUN_OAUTH_COMPLETION_COPY[status];
  const html = `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${copy.title}</title>
    <style nonce="${nonce}">
      :root { color-scheme: light; font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
      body { min-height: 100vh; margin: 0; display: grid; place-items: center; background: #f7f5fb; color: #25222d; }
      main { width: min(32rem, calc(100vw - 3rem)); padding: 2rem; border: 1px solid #e4deed; border-radius: 1.25rem; background: #fff; box-shadow: 0 1rem 3rem rgba(43, 34, 59, .08); }
      h1 { margin: 0 0 .75rem; font-size: 1.35rem; }
      p { margin: 0 0 1.25rem; color: #625b6d; line-height: 1.65; }
      a { display: inline-flex; padding: .7rem 1rem; border-radius: .75rem; background: #493b64; color: #fff; text-decoration: none; }
    </style>
  </head>
  <body>
    <main>
      <h1>${copy.title}</h1>
      <p>${copy.description}</p>
      <a href="/">返回 AI友好官网管理</a>
    </main>
    <script nonce="${nonce}">
      (() => {
        const message = Object.freeze({
          type: "frontmind:siteops:aliyun-oauth",
          status: "${status}"
        });
        if (window.opener && !window.opener.closed) {
          window.opener.postMessage(message, window.location.origin);
          if (message.status === "cancelled") {
            window.close();
          }
        }
      })();
    </script>
  </body>
</html>`;

  res.status(200);
  res.setHeader("Cache-Control", "private, no-store, max-age=0");
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader(
    "Content-Security-Policy",
    `default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'`,
  );
  res.send(html);
}

function notFound(res: express.Response) {
  res.status(404).json({ error: "NOT_FOUND" });
}

export function publicSiteOpsArtifactError(error: unknown) {
  const code = error instanceof Error ? error.message : "";
  return code === "NOT_FOUND"
    ? { status: 404, body: { error: "NOT_FOUND" } }
    : {
        status: 409,
        body: { error: "文件暂时无法打开，请稍后重试。" },
      };
}

function sendError(res: express.Response, error: unknown) {
  const projected = publicSiteOpsArtifactError(error);
  res.status(projected.status).json(projected.body);
}

async function requireDb() {
  const db = await getDb();
  if (!db) throw new Error("DATABASE_UNAVAILABLE");
  return db;
}

async function streamToBuffer(stream: Readable, maxBytes: number) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const raw of stream) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    size += chunk.length;
    if (size > maxBytes) {
      stream.destroy();
      throw new Error("SITEOPS_ARTIFACT_TOO_LARGE");
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size);
}

function safePreviewPath(raw: string) {
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw || "");
  } catch {
    throw new Error("SITEOPS_PREVIEW_PATH_INVALID");
  }
  if (
    decoded.includes("\\") ||
    decoded.includes("\0") ||
    decoded.startsWith("/") ||
    decoded.split("/").some((part) => part === "." || part === "..")
  ) {
    throw new Error("SITEOPS_PREVIEW_PATH_INVALID");
  }
  const normalized = decoded.normalize("NFKC").replace(/^\/+|\/+$/gu, "");
  if (normalized.length > 1_024) {
    throw new Error("SITEOPS_PREVIEW_PATH_INVALID");
  }
  return normalized || "index.html";
}

function previewMimeType(filename: string) {
  const extension = path.posix.extname(filename).toLowerCase();
  return (
    (
      {
        ".avif": "image/avif",
        ".css": "text/css; charset=utf-8",
        ".gif": "image/gif",
        ".html": "text/html; charset=utf-8",
        ".ico": "image/x-icon",
        ".jpeg": "image/jpeg",
        ".jpg": "image/jpeg",
        ".js": "text/javascript; charset=utf-8",
        ".json": "application/json; charset=utf-8",
        ".png": "image/png",
        ".svg": "image/svg+xml; charset=utf-8",
        ".txt": "text/plain; charset=utf-8",
        ".webp": "image/webp",
        ".woff": "font/woff",
        ".woff2": "font/woff2",
        ".xml": "application/xml; charset=utf-8",
      } as Record<string, string>
    )[extension] ?? "application/octet-stream"
  );
}

function prefixPreviewRootUrl(value: string, prefix: string) {
  if (
    !value.startsWith("/") ||
    value.startsWith("//") ||
    value.startsWith(prefix)
  ) {
    return value;
  }
  return `${prefix}${value.slice(1)}`;
}

function rewriteCssRootUrls(value: string, prefix: string) {
  return value
    .replace(
      /url\(\s*(?:(["'])(\/(?!\/)[^"')]+)\1|(\/(?!\/)[^)\s]+))\s*\)/giu,
      (
        match,
        quote: string | undefined,
        quoted: string | undefined,
        bare: string | undefined,
      ) => {
        const url = quoted ?? bare;
        if (!url) return match;
        const rewritten = prefixPreviewRootUrl(url, prefix);
        return quote
          ? `url(${quote}${rewritten}${quote})`
          : `url(${rewritten})`;
      },
    )
    .replace(
      /(@import\s+)(["'])(\/(?!\/)[^"']+)\2/giu,
      (_match, keyword: string, quote: string, url: string) =>
        `${keyword}${quote}${prefixPreviewRootUrl(url, prefix)}${quote}`,
    );
}

function localPreviewAssetPath(raw: string, from: string) {
  const decoded = raw.trim();
  if (
    !decoded ||
    decoded.startsWith("#") ||
    /^(?:data:|blob:|mailto:|tel:|https?:|\/\/)/iu.test(decoded)
  ) {
    return null;
  }
  const withoutSuffix = decoded.split(/[?#]/u, 1)[0]!;
  const resolved = withoutSuffix.startsWith("/")
    ? withoutSuffix.slice(1)
    : path.posix.normalize(
        path.posix.join(path.posix.dirname(from), withoutSuffix),
      );
  if (
    !resolved ||
    resolved.startsWith("../") ||
    resolved.includes("\\") ||
    resolved.split("/").some((part) => part === "." || part === "..")
  ) {
    throw new Error("SITEOPS_PREVIEW_PATH_INVALID");
  }
  return resolved;
}

async function replaceAsync(
  value: string,
  expression: RegExp,
  replacer: (...groups: string[]) => Promise<string>,
) {
  const matches = [...value.matchAll(expression)];
  if (matches.length === 0) return value;
  const replacements = await Promise.all(
    matches.map((match) =>
      replacer(match[0], ...match.slice(1).map((part) => part ?? "")),
    ),
  );
  let cursor = 0;
  let result = "";
  matches.forEach((match, index) => {
    result += value.slice(cursor, match.index) + replacements[index];
    cursor = (match.index ?? 0) + match[0].length;
  });
  return result + value.slice(cursor);
}

function addPreviewExecutableNonces(html: string, nonce: string) {
  const openingTag = /<(script|style)\b[^>]*>/giu;
  let cursor = 0;
  let result = "";
  while (cursor < html.length) {
    openingTag.lastIndex = cursor;
    const match = openingTag.exec(html);
    if (!match || match.index === undefined) {
      result += html.slice(cursor);
      break;
    }
    const tagName = match[1]!.toLowerCase();
    const opening = match[0];
    result += html.slice(cursor, match.index);
    result += /\bnonce\s*=/iu.test(opening)
      ? opening
      : opening.replace(/>$/u, ` nonce="${nonce}">`);

    const contentStart = match.index + opening.length;
    const closingTag = new RegExp(`</${tagName}\\s*>`, "iu");
    const closing = closingTag.exec(html.slice(contentStart));
    if (!closing || closing.index === undefined) {
      result += html.slice(contentStart);
      break;
    }
    const contentEnd = contentStart + closing.index;
    const closingEnd = contentEnd + closing[0].length;
    result += html.slice(contentStart, closingEnd);
    cursor = closingEnd;
  }
  return result;
}

export type SiteOpsPreviewRoutingMode =
  | "legacy_static_literals"
  | "canonical_pathname";

function previewNavigationBridge(input: {
  nonce: string;
  previewPrefix: string;
}) {
  return `<script nonce="${input.nonce}">${previewNavigationBridgeSource(input.previewPrefix)}</script>`;
}

function injectPreviewNavigationBridge(input: {
  html: string;
  nonce: string;
  previewPrefix: string;
}) {
  const bridge = previewNavigationBridge(input);
  if (/<head\b[^>]*>/iu.test(input.html)) {
    return input.html.replace(/<head\b[^>]*>/iu, (head) => `${head}${bridge}`);
  }
  if (/<body\b[^>]*>/iu.test(input.html)) {
    return input.html.replace(/<body\b[^>]*>/iu, (body) => `${bridge}${body}`);
  }
  return `${bridge}${input.html}`;
}

export async function createSandboxedPreviewDocument(input: {
  zip: JSZip;
  entryName: string;
  previewPrefix: string;
  previewRoutingMode?: SiteOpsPreviewRoutingMode;
}) {
  const files = new Map(
    Object.values(input.zip.files)
      .filter((entry) => !entry.dir)
      .map((entry) => [entry.name, entry] as const),
  );
  const bytesCache = new Map<string, Buffer>();
  let expandedBytes = 0;
  const fileBytes = async (filename: string) => {
    const cached = bytesCache.get(filename);
    if (cached) return cached;
    const entry = files.get(filename);
    if (!entry || entry.name.includes("\\") || entry.name.includes("..")) {
      throw new Error("SITEOPS_PREVIEW_ASSET_MISSING");
    }
    const mode = Number(entry.unixPermissions ?? 0);
    if (mode && (mode & 0o170000) === 0o120000) {
      throw new Error("SITEOPS_DIST_SYMLINK_REJECTED");
    }
    const bytes = await entry.async("nodebuffer");
    expandedBytes += bytes.length;
    if (bytes.length > 20 * 1024 * 1024 || expandedBytes > MAX_ARCHIVE_BYTES) {
      throw new Error("SITEOPS_PREVIEW_FILE_TOO_LARGE");
    }
    bytesCache.set(filename, bytes);
    return bytes;
  };
  const dataUrl = async (filename: string) => {
    const mimeType = previewMimeType(filename).split(";", 1)[0];
    return `data:${mimeType};base64,${(await fileBytes(filename)).toString("base64")}`;
  };
  const embedCssUrls = async (css: string, filename: string) =>
    await replaceAsync(
      css,
      /url\(\s*(?:(["'])([^"']+)\1|([^)'"\s]+))\s*\)/giu,
      async (match, quote, quoted, bare) => {
        const raw = quoted || bare;
        const local = localPreviewAssetPath(raw, filename);
        if (!local) return match;
        const embedded = await dataUrl(local);
        return `url(${quote || '"'}${embedded}${quote || '"'})`;
      },
    );
  const inlineCss = async (filename: string, visiting = new Set<string>()) => {
    if (visiting.has(filename)) {
      throw new Error("SITEOPS_PREVIEW_STYLE_CYCLE");
    }
    const nextVisiting = new Set(visiting).add(filename);
    let css = (await fileBytes(filename)).toString("utf8");
    css = await replaceAsync(
      css,
      /@import\s+(?:url\(\s*)?(["'])([^"']+)\1\s*\)?\s*;/giu,
      async (_match, _quote, raw) => {
        const local = localPreviewAssetPath(raw, filename);
        if (!local) throw new Error("SITEOPS_PREVIEW_STYLE_INVALID");
        return await inlineCss(local, nextVisiting);
      },
    );
    return await embedCssUrls(css, filename);
  };
  const embedAssetReferences = async (text: string, from: string) => {
    const assetPaths = [...files.keys()]
      .filter((filename) => filename !== input.entryName)
      .sort((left, right) => right.length - left.length);
    let result = text;
    for (const filename of assetPaths) {
      const embedded = await dataUrl(filename);
      for (const reference of [
        `/${filename}`,
        path.posix.relative(path.posix.dirname(from), filename),
      ]) {
        if (reference && reference !== ".") {
          result = result.split(reference).join(embedded);
        }
      }
    }
    return result;
  };

  const nonce = randomBytes(18).toString("base64url");
  let html = (await fileBytes(input.entryName)).toString("utf8");
  // The immutable dist carries its production document policy and a root base
  // URL. The private preview is a self-contained, nonce-authorized sandbox at
  // a build-scoped path, so neither directive may be allowed to compose with
  // the response policy or change how relative navigation resolves.
  html = html
    .replace(
      /<meta\b(?=[^>]*\bhttp-equiv\s*=\s*["']Content-Security-Policy["'])[^>]*>/giu,
      "",
    )
    .replace(/<base\b[^>]*>/giu, "");
  html = injectPreviewNavigationBridge({
    html,
    nonce,
    previewPrefix: input.previewPrefix,
  });
  html = await replaceAsync(
    html,
    /<link\b(?=[^>]*\brel=["']stylesheet["'])[^>]*\bhref=["']([^"']+)["'][^>]*>/giu,
    async (_match, raw) => {
      const local = localPreviewAssetPath(raw, input.entryName);
      if (!local) throw new Error("SITEOPS_PREVIEW_STYLE_INVALID");
      return `<style nonce="${nonce}">${await inlineCss(local)}</style>`;
    },
  );
  html = html.replace(
    /<link\b(?=[^>]*\brel=["'](?:modulepreload|preload)["'])[^>]*>/giu,
    "",
  );
  html = await replaceAsync(
    html,
    /<script\b([^>]*)\bsrc=["']([^"']+)["']([^>]*)>\s*<\/script>/giu,
    async (_match, before, raw, after) => {
      const local = localPreviewAssetPath(raw, input.entryName);
      if (!local) throw new Error("SITEOPS_PREVIEW_SCRIPT_INVALID");
      const embeddedSource = await embedAssetReferences(
        (await fileBytes(local)).toString("utf8"),
        local,
      );
      const source = rewriteSiteOpsPreviewDocument({
        bytes: Buffer.from(embeddedSource, "utf8"),
        mimeType: "text/javascript; charset=utf-8",
        previewPrefix: input.previewPrefix,
        previewRoutingMode:
          input.previewRoutingMode ?? "legacy_static_literals",
      }).toString("utf8");
      const attributes = `${before} ${after}`
        .replace(/\s(?:crossorigin|integrity)(?:=["'][^"']*["'])?/giu, "")
        .trim();
      return `<script nonce="${nonce}"${attributes ? ` ${attributes}` : ""}>${source.replace(/<\/script/giu, "<\\/script")}</script>`;
    },
  );
  html = await replaceAsync(
    html,
    /\b(src|poster)(\s*=\s*)(["'])([^"']+)\3/giu,
    async (match, name, equals, quote, raw) => {
      const local = localPreviewAssetPath(raw, input.entryName);
      if (!local) return match;
      return `${name}${equals}${quote}${await dataUrl(local)}${quote}`;
    },
  );
  html = await replaceAsync(
    html,
    /\bsrcset(\s*=\s*)(["'])([^"']*)\2/giu,
    async (_match, equals, quote, value) => {
      const candidates = await Promise.all(
        value.split(",").map(async (candidate) => {
          const [raw, ...descriptor] = candidate.trim().split(/\s+/u);
          const local = raw
            ? localPreviewAssetPath(raw, input.entryName)
            : null;
          return [local ? await dataUrl(local) : raw, ...descriptor]
            .filter(Boolean)
            .join(" ");
        }),
      );
      return `srcset${equals}${quote}${candidates.join(", ")}${quote}`;
    },
  );
  html = await replaceAsync(
    html,
    /<link\b(?=[^>]*\brel=["']icon["'])[^>]*\bhref=["']([^"']+)["'][^>]*>/giu,
    async (match, raw) => {
      const local = localPreviewAssetPath(raw, input.entryName);
      if (!local) return match;
      return match.replace(raw, await dataUrl(local));
    },
  );
  html = await replaceAsync(
    html,
    /<style\b([^>]*)>([\s\S]*?)<\/style>/giu,
    async (_match, attributes, css) =>
      `<style${attributes}>${await embedCssUrls(css, input.entryName)}</style>`,
  );
  html = addPreviewExecutableNonces(html, nonce).replace(
    /\bhref(\s*=\s*)(["'])(\/(?!\/)[^"']*)\2/giu,
    (_match, equals: string, quote: string, url: string) =>
      `href${equals}${quote}${prefixPreviewRootUrl(url, input.previewPrefix)}${quote}`,
  );
  return { bytes: Buffer.from(html, "utf8"), nonce };
}

export function sandboxedPreviewContentSecurityPolicy(nonce: string) {
  if (!/^[A-Za-z0-9_-]{16,64}$/u.test(nonce)) {
    throw new Error("SITEOPS_PREVIEW_NONCE_INVALID");
  }
  return `sandbox allow-scripts; default-src 'none'; img-src data: blob:; font-src data:; style-src 'nonce-${nonce}'; style-src-attr 'unsafe-inline'; script-src 'nonce-${nonce}'; connect-src 'none'; worker-src 'none'; child-src 'none'; frame-src 'none'; object-src 'none'; media-src data: blob:; manifest-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`;
}

export function rewriteSiteOpsPreviewDocument(input: {
  bytes: Buffer;
  mimeType: string;
  previewPrefix: string;
  previewRoutingMode?: SiteOpsPreviewRoutingMode;
}) {
  const mediaType = input.mimeType.split(";", 1)[0]?.trim().toLowerCase();
  if (
    mediaType !== "text/html" &&
    mediaType !== "text/css" &&
    mediaType !== "text/javascript" &&
    mediaType !== "application/javascript"
  ) {
    return input.bytes;
  }
  let text = input.bytes.toString("utf8");
  if (mediaType === "text/html") {
    text = text
      .replace(
        /\b(href|src|action|poster|data|xlink:href)(\s*=\s*)(["'])(\/(?!\/)[^"'<>]*)\3/giu,
        (_match, name: string, equals: string, quote: string, url: string) =>
          `${name}${equals}${quote}${prefixPreviewRootUrl(url, input.previewPrefix)}${quote}`,
      )
      .replace(
        /\b(srcset)(\s*=\s*)(["'])([^"']*)\3/giu,
        (
          _match,
          name: string,
          equals: string,
          quote: string,
          value: string,
        ) => {
          const rewritten = value.replace(
            /(^|,\s*)(\/(?!\/)[^\s,]+)/gu,
            (_candidate, separator: string, url: string) =>
              `${separator}${prefixPreviewRootUrl(url, input.previewPrefix)}`,
          );
          return `${name}${equals}${quote}${rewritten}${quote}`;
        },
      );
  }
  if (
    (mediaType === "text/javascript" ||
      mediaType === "application/javascript") &&
    (input.previewRoutingMode ?? "legacy_static_literals") ===
      "legacy_static_literals"
  ) {
    // Historical 2.8 bundles commonly use literal route tables. Keep those
    // keys aligned with the build-scoped preview URL, but deliberately leave
    // dynamic template literals alone: prefixing `/${segment}/` here can
    // compose with an already-prefixed pathname and produce a double prefix.
    // The navigation bridge above scopes dynamic anchors and History API
    // calls at execution time instead.
    text = text.replace(
      /(["'])(\/(?!\/)[A-Za-z0-9._~!$&()*+,;=:@%/?#-]*)\1/gu,
      (_match, quote: string, url: string) =>
        `${quote}${prefixPreviewRootUrl(url, input.previewPrefix)}${quote}`,
    );
  }
  return Buffer.from(rewriteCssRootUrls(text, input.previewPrefix), "utf8");
}

async function ownedBuild(userId: number, buildId: string) {
  const db = await requireDb();
  const rows = await db
    .select({ build: siteBuilds, project: siteProjects })
    .from(siteBuilds)
    .innerJoin(siteProjects, eq(siteProjects.id, siteBuilds.projectId))
    .where(
      and(
        eq(siteBuilds.id, buildId),
        eq(siteBuilds.userId, userId),
        eq(siteProjects.userId, userId),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

async function frozenPreviewRouteEntries(input: {
  userId: number;
  build: typeof siteBuilds.$inferSelect;
}) {
  if (input.build.workflowVersion !== "2.9.0") return null;
  if (!input.build.contentPlanLocalAssetId || !input.build.contentPlanSha256) {
    return undefined;
  }
  const asset = await readSiteOpsArtifact({
    userId: input.userId,
    localAssetId: input.build.contentPlanLocalAssetId,
    expectedSha256: input.build.contentPlanSha256,
    expectedMimeTypes: ["application/json"],
  });
  if (!asset) return undefined;
  const bytes = await streamToBuffer(
    asset.stored.createReadStream(),
    MAX_CONTENT_PLAN_BYTES,
  );
  let candidate: unknown;
  try {
    candidate = JSON.parse(bytes.toString("utf8"));
  } catch {
    return undefined;
  }
  const plan = siteContentPlanV2Schema.safeParse(candidate);
  if (!plan.success) return undefined;
  return new Set(
    plan.data.routes.map((route) =>
      route.path === "/"
        ? "index.html"
        : `${route.path.replace(/^\/+|\/+$/gu, "")}/index.html`,
    ),
  );
}

async function sendOwnedAsset(input: {
  res: express.Response;
  userId: number;
  localAssetId: string;
  expectedSha256?: string | null;
  expectedMimeTypes?: string[];
  disposition?: "inline" | "attachment";
}) {
  const asset = await readSiteOpsArtifact({
    userId: input.userId,
    localAssetId: input.localAssetId,
    expectedSha256: input.expectedSha256,
    ...(input.expectedMimeTypes
      ? { expectedMimeTypes: input.expectedMimeTypes }
      : {}),
  });
  if (
    !asset ||
    (input.expectedMimeTypes &&
      !input.expectedMimeTypes.includes(asset.row.mimeType))
  ) {
    return notFound(input.res);
  }
  input.res.setHeader("Cache-Control", "private, no-store, max-age=0");
  input.res.setHeader("Content-Type", asset.row.mimeType);
  input.res.setHeader("Content-Length", String(asset.row.sizeBytes));
  input.res.setHeader("ETag", `"sha256:${asset.row.contentSha256}"`);
  input.res.setHeader(
    "Content-Disposition",
    `${input.disposition ?? "attachment"}; filename*=UTF-8''${encodeURIComponent(asset.row.filename)}`,
  );
  asset.stored.createReadStream().pipe(input.res);
}

const FAIL_CLOSED_ARTIFACT_ERRORS = new Set([
  "SITEOPS_ARTIFACT_BODY_MISMATCH",
  "SITEOPS_ARTIFACT_HASH_MISMATCH",
  "SITEOPS_ARTIFACT_MIME_MISMATCH",
]);

async function sendOwnedStylePreview(input: {
  res: express.Response;
  userId: number;
  localAssetId: string;
  expectedSha256?: string | null;
  expectedMimeTypes: string[];
}) {
  try {
    await sendOwnedAsset({
      ...input,
      disposition: "inline",
    });
  } catch (error) {
    if (
      error instanceof Error &&
      FAIL_CLOSED_ARTIFACT_ERRORS.has(error.message)
    ) {
      return notFound(input.res);
    }
    throw error;
  }
}

export const siteOpsArtifactApi = express.Router();

const STYLE_PREVIEW_MIME_TYPES = [
  "image/avif",
  "image/png",
  "image/jpeg",
  "image/webp",
] as const;

function normalizedSha256(value: unknown) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/iu.test(value.trim())) {
    return null;
  }
  return value.trim().toLowerCase();
}

function nonEmptyString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

/**
 * A V4 style sample freezes two independent images: the provider reference
 * shown on the selection board and FrontMind's realization of that reference.
 * The sample row decides which of those images is being served. Never choose a
 * digest merely because one hash field happens to be present in metadata.
 */
function frozenStylePreviewSha256(
  localAssetId: string,
  sourceMetadata: unknown,
) {
  if (
    !sourceMetadata ||
    typeof sourceMetadata !== "object" ||
    Array.isArray(sourceMetadata)
  ) {
    return { valid: true as const, value: undefined };
  }
  const metadata = sourceMetadata as Record<string, unknown>;
  const rawBlueprint = metadata.referenceBlueprint;
  const blueprint =
    rawBlueprint &&
    typeof rawBlueprint === "object" &&
    !Array.isArray(rawBlueprint)
      ? (rawBlueprint as Record<string, unknown>)
      : null;
  const v4Coordinates =
    metadata.schemaVersion === 4 || blueprint?.schemaVersion === 4;

  if (v4Coordinates) {
    if (!blueprint || blueprint.schemaVersion !== 4) {
      return { valid: false as const, value: undefined };
    }
    const referenceAssetId = nonEmptyString(
      blueprint.referencePreviewLocalAssetId,
    );
    const referenceHash = normalizedSha256(blueprint.referencePreviewSha256);
    const blueprintRealizationAssetId = nonEmptyString(
      blueprint.previewLocalAssetId,
    );
    const blueprintRealizationHash = normalizedSha256(blueprint.previewSha256);
    const metadataRealizationAssetId = nonEmptyString(
      metadata.realizationPreviewLocalAssetId,
    );
    const metadataRealizationHash = normalizedSha256(
      metadata.realizationPreviewSha256,
    );

    if (
      !referenceAssetId ||
      !referenceHash ||
      !blueprintRealizationAssetId ||
      !blueprintRealizationHash ||
      !metadataRealizationAssetId ||
      !metadataRealizationHash ||
      metadataRealizationAssetId !== blueprintRealizationAssetId ||
      metadataRealizationHash !== blueprintRealizationHash ||
      (referenceAssetId === blueprintRealizationAssetId &&
        referenceHash !== blueprintRealizationHash)
    ) {
      return { valid: false as const, value: undefined };
    }

    const topLevelReferenceAssetId =
      metadata.referencePreviewLocalAssetId === undefined
        ? null
        : nonEmptyString(metadata.referencePreviewLocalAssetId);
    const topLevelReferenceHash =
      metadata.referencePreviewSha256 === undefined
        ? null
        : normalizedSha256(metadata.referencePreviewSha256);
    if (
      (metadata.referencePreviewLocalAssetId !== undefined ||
        metadata.referencePreviewSha256 !== undefined) &&
      (topLevelReferenceAssetId !== referenceAssetId ||
        topLevelReferenceHash !== referenceHash)
    ) {
      return { valid: false as const, value: undefined };
    }

    if (
      localAssetId === referenceAssetId &&
      localAssetId === metadataRealizationAssetId
    ) {
      return referenceHash === metadataRealizationHash
        ? { valid: true as const, value: referenceHash }
        : { valid: false as const, value: undefined };
    }
    if (localAssetId === referenceAssetId) {
      return { valid: true as const, value: referenceHash };
    }
    if (localAssetId === metadataRealizationAssetId) {
      return { valid: true as const, value: metadataRealizationHash };
    }
    return { valid: false as const, value: undefined };
  }

  const strictSourceBackedPreview =
    metadata.schemaVersion === 5 ||
    metadata.schemaVersion === 6 ||
    metadata.renderer === "twenty_first_native_react_v1" ||
    metadata.renderer === "twenty_first_native_template_v1";
  const raw = metadata.previewSha256 ?? metadata.realizationPreviewSha256;
  if (raw === undefined || raw === null) {
    return strictSourceBackedPreview
      ? { valid: false as const, value: undefined }
      : { valid: true as const, value: undefined };
  }
  const normalized = normalizedSha256(raw);
  if (!normalized) {
    return { valid: false as const, value: undefined };
  }
  return { valid: true as const, value: normalized };
}

siteOpsArtifactApi.get("/aliyun/oauth/callback", async (req, res) => {
  const startedAt = Date.now();
  const correlationId = randomBytes(12).toString("hex");
  const actor = req.frontmindUser;
  const providerError =
    typeof req.query.error === "string" ? req.query.error : null;
  const code = typeof req.query.code === "string" ? req.query.code : null;
  const state = typeof req.query.state === "string" ? req.query.state : null;

  if (!actor) {
    logAliyunOAuthCallbackFailure({
      correlationId,
      stage: "session",
      userId: null,
      errorCode: "UNAUTHENTICATED",
      startedAt,
    });
    sendAliyunOAuthCompletionPage(res, "failed");
    return;
  }
  if (providerError) {
    if (providerError === "access_denied") {
      sendAliyunOAuthCompletionPage(res, "cancelled");
      return;
    }
    logAliyunOAuthCallbackFailure({
      correlationId,
      stage: "provider_authorization",
      userId: actor.id,
      errorCode: "PROVIDER_AUTHORIZATION_FAILED",
      startedAt,
    });
    sendAliyunOAuthCompletionPage(res, "failed");
    return;
  }
  if (!code || !state) {
    logAliyunOAuthCallbackFailure({
      correlationId,
      stage: "provider_authorization",
      userId: actor.id,
      errorCode: "INVALID_CALLBACK",
      startedAt,
    });
    sendAliyunOAuthCompletionPage(res, "failed");
    return;
  }
  let stage: AliyunOAuthCallbackStage = "oauth_exchange";
  try {
    const identity = await exchangeAliyunOAuthCode({
      code,
      state,
      userId: actor.id,
    });
    stage = "account_bind";
    await completeSiteOpsAliyunOAuth({
      actor,
      credentialId: identity.credentialId,
      projectId: identity.projectId,
      accountUid: identity.accountUid,
      refreshToken: identity.refreshToken,
    });
    sendAliyunOAuthCompletionPage(res, "success");
  } catch (error) {
    logAliyunOAuthCallbackFailure({
      correlationId,
      stage,
      userId: actor.id,
      errorCode: safeAliyunOAuthErrorCode(error),
      startedAt,
    });
    sendAliyunOAuthCompletionPage(res, "failed");
  }
});

siteOpsArtifactApi.get("/style-previews/:sampleId", async (req, res) => {
  try {
    const userId = req.frontmindUser?.id;
    if (!userId) return notFound(res);
    const db = await requireDb();
    const rows = await db
      .select({
        localAssetId: websiteStyleSamples.previewLocalAssetId,
        sourceMetadata: websiteStyleSamples.sourceMetadata,
      })
      .from(websiteStyleSamples)
      .innerJoin(
        websiteStyleSampleBatches,
        eq(websiteStyleSampleBatches.id, websiteStyleSamples.batchId),
      )
      .where(
        and(
          eq(websiteStyleSamples.id, req.params.sampleId),
          eq(websiteStyleSampleBatches.userId, userId),
          eq(websiteStyleSampleBatches.sourceKind, "siteops_21st"),
          customerVisibleStyleBatchStatusCondition(),
        ),
      )
      .limit(1);
    const row = rows[0];
    const metadata =
      row?.sourceMetadata &&
      typeof row.sourceMetadata === "object" &&
      !Array.isArray(row.sourceMetadata)
        ? (row.sourceMetadata as Record<string, unknown>)
        : null;
    if (
      metadata?.schemaVersion === 7 &&
      metadata.renderer === "frontmind_static_template_catalog_v1"
    ) {
      const catalogVersion = nonEmptyString(metadata.catalogVersion);
      const candidateId = nonEmptyString(metadata.catalogCandidateId);
      const previewAssetId = nonEmptyString(metadata.previewAssetId);
      const previewLocalAssetId = nonEmptyString(metadata.previewLocalAssetId);
      const previewSha256 = normalizedSha256(metadata.previewSha256);
      const previewMimeType = nonEmptyString(metadata.previewMimeType);
      const providerTemplateId = nonEmptyString(metadata.providerTemplateId);
      const providerSlug = nonEmptyString(metadata.providerSlug);
      const sourceAssetId = nonEmptyString(metadata.sourceAssetId);
      const sourceArchiveSha256 = normalizedSha256(
        metadata.sourceArchiveSha256,
      );
      const catalogPosition = Number(metadata.catalogPosition);
      const previewWidth = Number(metadata.previewWidth);
      const previewHeight = Number(metadata.previewHeight);
      const rowLocalAssetId = nonEmptyString(row?.localAssetId);
      if (
        !["2.8.0", "2.9.0"].includes(String(metadata.workflowVersion)) ||
        !catalogVersion ||
        !candidateId ||
        !previewAssetId ||
        !previewLocalAssetId ||
        !rowLocalAssetId ||
        rowLocalAssetId !== previewLocalAssetId ||
        !previewSha256 ||
        !previewMimeType ||
        !STYLE_PREVIEW_MIME_TYPES.includes(
          previewMimeType as (typeof STYLE_PREVIEW_MIME_TYPES)[number],
        ) ||
        !providerTemplateId ||
        !providerSlug ||
        !sourceAssetId ||
        !sourceArchiveSha256 ||
        !Number.isInteger(catalogPosition) ||
        !Number.isInteger(previewWidth) ||
        !Number.isInteger(previewHeight)
      ) {
        return notFound(res);
      }
      // The immutable catalog coordinates were independently verified before
      // this managed-user mirror was bound. Serving must now depend only on
      // the frozen row/metadata coordinate and the mirrored bytes, otherwise
      // a later catalog mount change would break an already published board.
      await sendOwnedStylePreview({
        res,
        userId,
        localAssetId: rowLocalAssetId,
        expectedSha256: previewSha256,
        expectedMimeTypes: [previewMimeType],
      });
      return;
    }
    const localAssetId = row?.localAssetId;
    const expectedHash = localAssetId
      ? frozenStylePreviewSha256(localAssetId, row?.sourceMetadata)
      : { valid: false as const, value: undefined };
    if (!localAssetId || !expectedHash.valid) return notFound(res);
    await sendOwnedStylePreview({
      res,
      userId,
      localAssetId,
      expectedSha256: expectedHash.value,
      expectedMimeTypes: [...STYLE_PREVIEW_MIME_TYPES],
    });
  } catch (error) {
    sendError(res, error);
  }
});

siteOpsArtifactApi.get("/builds/:buildId/source", async (req, res) => {
  try {
    const userId = req.frontmindUser?.id;
    if (!userId) return notFound(res);
    const owned = await ownedBuild(userId, req.params.buildId);
    if (!owned?.build.sourceLocalAssetId) return notFound(res);
    await sendOwnedAsset({
      res,
      userId,
      localAssetId: owned.build.sourceLocalAssetId,
      expectedSha256: owned.build.sourceHash,
    });
  } catch (error) {
    sendError(res, error);
  }
});

siteOpsArtifactApi.get("/builds/:buildId/qa", async (req, res) => {
  try {
    const userId = req.frontmindUser?.id;
    if (!userId) return notFound(res);
    const owned = await ownedBuild(userId, req.params.buildId);
    if (!owned?.build.qaLocalAssetId) return notFound(res);
    await sendOwnedAsset({
      res,
      userId,
      localAssetId: owned.build.qaLocalAssetId,
    });
  } catch (error) {
    sendError(res, error);
  }
});

siteOpsArtifactApi.get("/builds/:buildId/preview/*", async (req, res) => {
  try {
    const userId = req.frontmindUser?.id;
    if (!userId) return notFound(res);
    const owned = await ownedBuild(userId, req.params.buildId);
    if (!owned?.build.distLocalAssetId || !owned.build.distHash) {
      return notFound(res);
    }
    const allowedRouteEntries = await frozenPreviewRouteEntries({
      userId,
      build: owned.build,
    });
    if (owned.build.workflowVersion === "2.9.0" && !allowedRouteEntries) {
      return notFound(res);
    }
    const asset = await readSiteOpsArtifact({
      userId,
      localAssetId: owned.build.distLocalAssetId,
      expectedSha256: owned.build.distHash,
      expectedMimeTypes: ["application/zip"],
    });
    if (!asset) return notFound(res);
    const archive = await streamToBuffer(
      asset.stored.createReadStream(),
      MAX_ARCHIVE_BYTES,
    );
    const zip = await JSZip.loadAsync(archive, { checkCRC32: true });
    const entries = Object.values(zip.files).filter((entry) => !entry.dir);
    if (entries.length < 1 || entries.length > MAX_ARCHIVE_ENTRIES) {
      throw new Error("SITEOPS_DIST_STRUCTURE_INVALID");
    }
    const wildcard = (req.params as Record<string, string | undefined>)["0"];
    const requestPath = safePreviewPath(wildcard ?? "");
    const candidates = requestPath.endsWith("/")
      ? [`${requestPath}index.html`]
      : [requestPath, `${requestPath}/index.html`];
    const entry = candidates
      .filter(
        (candidate) =>
          allowedRouteEntries == null || allowedRouteEntries.has(candidate),
      )
      .map((candidate) => zip.file(candidate))
      .find(Boolean);
    if (
      !entry ||
      !entry.name.endsWith(".html") ||
      entry.name.includes("\\") ||
      entry.name.includes("..")
    ) {
      return notFound(res);
    }
    const mode = Number(entry.unixPermissions ?? 0);
    if (mode && (mode & 0o170000) === 0o120000) {
      throw new Error("SITEOPS_DIST_SYMLINK_REJECTED");
    }
    const document = await createSandboxedPreviewDocument({
      zip,
      entryName: entry.name,
      previewPrefix: `/api/site-ops/builds/${encodeURIComponent(req.params.buildId)}/preview/`,
      previewRoutingMode:
        owned.build.workflowVersion === "2.9.0"
          ? "canonical_pathname"
          : "legacy_static_literals",
    });
    res.setHeader("Cache-Control", "private, no-store, max-age=0");
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    res.setHeader(
      "Permissions-Policy",
      "camera=(), geolocation=(), microphone=()",
    );
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Robots-Tag", "noindex, nofollow, noarchive");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader(
      "Content-Security-Policy",
      sandboxedPreviewContentSecurityPolicy(document.nonce),
    );
    res.setHeader("Content-Length", String(document.bytes.length));
    res.send(document.bytes);
  } catch (error) {
    sendError(res, error);
  }
});

siteOpsArtifactApi.get(
  "/social-packages/:packageId/archive",
  async (req, res) => {
    try {
      const userId = req.frontmindUser?.id;
      if (!userId) return notFound(res);
      const db = await requireDb();
      const rows = await db
        .select()
        .from(socialPackages)
        .where(
          and(
            eq(socialPackages.id, req.params.packageId),
            eq(socialPackages.userId, userId),
            eq(socialPackages.status, "ready"),
          ),
        )
        .limit(1);
      const item = rows[0];
      if (!item?.archiveLocalAssetId || !item.archiveHash) return notFound(res);
      await db
        .update(socialPackages)
        .set({ downloadCount: item.downloadCount + 1 })
        .where(
          and(
            eq(socialPackages.id, item.id),
            eq(socialPackages.downloadCount, item.downloadCount),
          ),
        );
      await sendOwnedAsset({
        res,
        userId,
        localAssetId: item.archiveLocalAssetId,
        expectedSha256: item.archiveHash,
      });
    } catch (error) {
      sendError(res, error);
    }
  },
);

siteOpsArtifactApi.get(
  "/social-packages/:packageId/preview/:index",
  async (req, res) => {
    try {
      const userId = req.frontmindUser?.id;
      if (!userId) return notFound(res);
      const index = Number(req.params.index);
      if (!Number.isSafeInteger(index) || index < 0 || index > 8) {
        return notFound(res);
      }
      const db = await requireDb();
      const rows = await db
        .select()
        .from(socialPackages)
        .where(
          and(
            eq(socialPackages.id, req.params.packageId),
            eq(socialPackages.userId, userId),
            eq(socialPackages.status, "ready"),
          ),
        )
        .limit(1);
      const localAssetId = rows[0]?.previewLocalAssetIds[index];
      if (!localAssetId) return notFound(res);
      await sendOwnedAsset({
        res,
        userId,
        localAssetId,
        disposition: "inline",
      });
    } catch (error) {
      sendError(res, error);
    }
  },
);
