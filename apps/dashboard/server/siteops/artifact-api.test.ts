import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import express from "express";
import JSZip from "jszip";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const buildId = "123e4567-e89b-42d3-a456-426614174000";
const oauthCredentialId = "223e4567-e89b-42d3-a456-426614174000";

const mocks = vi.hoisted(() => ({
  StaticTemplateCatalogError: class StaticTemplateCatalogError extends Error {
    constructor(public readonly code: string) {
      super(code);
      this.name = "StaticTemplateCatalogError";
    }
  },
  completeSiteOpsAliyunOAuth: vi.fn(),
  exchangeAliyunOAuthCode: vi.fn(),
  getDb: vi.fn(),
  openStaticTemplateCatalogVersionPreview: vi.fn(),
  readSiteOpsArtifact: vi.fn(),
}));

vi.mock("../db", () => ({ getDb: mocks.getDb }));
vi.mock("./artifact-store", () => ({
  readSiteOpsArtifact: mocks.readSiteOpsArtifact,
}));
vi.mock("./aliyun-platform-service", () => ({
  exchangeAliyunOAuthCode: mocks.exchangeAliyunOAuthCode,
}));
vi.mock("./service", () => ({
  completeSiteOpsAliyunOAuth: mocks.completeSiteOpsAliyunOAuth,
}));
vi.mock("./static-template-catalog", () => ({
  StaticTemplateCatalogError: mocks.StaticTemplateCatalogError,
  openStaticTemplateCatalogVersionPreview:
    mocks.openStaticTemplateCatalogVersionPreview,
}));

import {
  createSandboxedPreviewDocument,
  publicSiteOpsArtifactError,
  rewriteSiteOpsPreviewDocument,
  siteOpsArtifactApi,
} from "./artifact-api";
import {
  CUSTOMER_VISIBLE_STYLE_BATCH_STATUSES,
  customerVisibleStyleBatchStatusCondition,
} from "./visual-batch-visibility";

const servers: Server[] = [];
let distZip: Buffer;

beforeEach(async () => {
  const archive = new JSZip();
  archive.file(
    "index.html",
    `<!doctype html><html><head>
      <base href="/">
      <meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; base-uri 'self'">
      <link rel="icon" href="/favicon.svg">
      <link rel="stylesheet" href="/styles.css">
      <script type="module" src="/assets/app.js"></script>
      <style>.hero{background:url('/images/hero.png')}</style>
    </head><body>
      <a href="/">首页</a><a href="/about/">关于</a>
      <img src="/images/hero.png" srcset="/images/hero.png 1x, /images/hero@2x.png 2x">
      <a href="https://example.com/">外部链接</a>
    </body></html>`,
  );
  for (const route of [
    "about",
    "offerings",
    "applications",
    "cases",
    "contact",
  ]) {
    archive.file(
      `${route}/index.html`,
      `<!doctype html><a href="/">返回首页</a><h1>${route}</h1>`,
    );
  }
  archive.file(
    "styles.css",
    `.hero{background-image:url(/images/hero.png)}\n@import "/fonts/site.css";`,
  );
  archive.file("fonts/site.css", "body{font-family:system-ui}");
  archive.file("favicon.svg", '<svg xmlns="http://www.w3.org/2000/svg"></svg>');
  archive.file("images/hero.png", Buffer.from("preview-image"));
  archive.file("images/hero@2x.png", Buffer.from("preview-image-2x"));
  archive.file(
    "assets/app.js",
    'const marker="<script><\\/script>";const routes={"/":"home","/about/":"about"};const logo="/images/hero.png";const product=(slug)=>`/products/${slug}/`;document.body.dataset.route=routes[location.pathname]??"missing";document.body.dataset.logo=logo;document.body.dataset.product=product("demo");document.body.dataset.marker=marker;',
  );
  distZip = await archive.generateAsync({ type: "nodebuffer" });

  mocks.getDb.mockReset().mockResolvedValue({
    select: () => ({
      from: () => ({
        innerJoin: () => ({
          where: () => ({
            limit: async () => [
              {
                build: {
                  id: buildId,
                  userId: 42,
                  workflowVersion: "2.8.0",
                  distLocalAssetId: "dist-asset",
                  distHash: "a".repeat(64),
                },
                project: { id: "project-1", userId: 42 },
              },
            ],
          }),
        }),
      }),
    }),
  });
  mocks.readSiteOpsArtifact.mockReset().mockResolvedValue({
    row: {
      id: "dist-asset",
      mimeType: "application/zip",
      sizeBytes: distZip.length,
      contentSha256: "a".repeat(64),
      filename: "dist.zip",
    },
    stored: { createReadStream: () => Readable.from([distZip]) },
  });
  mocks.exchangeAliyunOAuthCode.mockReset().mockResolvedValue({
    credentialId: oauthCredentialId,
    projectId: "project-1",
    accountUid: "1234567890123456",
    refreshToken: "refresh-token-secret-sentinel",
  });
  mocks.completeSiteOpsAliyunOAuth.mockReset().mockResolvedValue(undefined);
  mocks.openStaticTemplateCatalogVersionPreview.mockReset();
});

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
          ),
      ),
  );
});

async function startApp(options: { authenticated?: boolean } = {}) {
  const app = express();
  app.use((req: any, _res, next) => {
    if (options.authenticated !== false) {
      req.frontmindUser = { id: 42, username: "site-owner", role: "user" };
    }
    next();
  });
  app.use("/api/site-ops", siteOpsArtifactApi);
  const server = createServer(app);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

function stylePreviewDatabase(
  localAssetId: string | null,
  sourceMetadata: unknown = {
    schemaVersion: 6,
    renderer: "twenty_first_native_template_v1",
    previewSha256: "b".repeat(64),
  },
  includeNullAssetRow = false,
) {
  return {
    select: () => ({
      from: () => ({
        innerJoin: () => ({
          where: () => ({
            limit: async () =>
              localAssetId === null && !includeNullAssetRow
                ? []
                : [{ localAssetId, sourceMetadata }],
          }),
        }),
      }),
    }),
  };
}

function expectSecureOAuthCompletionPage(
  response: Response,
  html: string,
  status: "success" | "cancelled" | "failed",
) {
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("text/html");
  expect(response.headers.get("cache-control")).toContain("no-store");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  expect(response.headers.get("referrer-policy")).toBe("no-referrer");

  const csp = response.headers.get("content-security-policy") ?? "";
  expect(csp).toContain("default-src 'none'");
  expect(csp).toContain("base-uri 'none'");
  expect(csp).toContain("frame-ancestors 'none'");
  const nonce = csp.match(/script-src 'nonce-([^']+)'/)?.[1];
  expect(nonce).toBeTruthy();
  expect(csp).toContain(`style-src 'nonce-${nonce}'`);
  expect(html).toContain(`<script nonce="${nonce}">`);
  expect(html).toContain(`<style nonce="${nonce}">`);
  expect(html).toContain('type: "frontmind:siteops:aliyun-oauth"');
  expect(html).toContain(`status: "${status}"`);
  expect(html).toContain(
    "window.opener.postMessage(message, window.location.origin)",
  );
  expect(html).toContain("window.close()");
  expect(html).toContain('if (message.status === "cancelled")');
  expect(html).toContain('href="/"');
}

describe("SiteOps Aliyun OAuth callback", () => {
  it("completes authorization and returns a secure same-origin success page", async () => {
    const origin = await startApp();
    const response = await fetch(
      `${origin}/api/site-ops/aliyun/oauth/callback?code=secret-code-sentinel&state=secret-state-sentinel`,
    );
    const html = await response.text();

    expectSecureOAuthCompletionPage(response, html, "success");
    expect(mocks.exchangeAliyunOAuthCode).toHaveBeenCalledWith({
      code: "secret-code-sentinel",
      state: "secret-state-sentinel",
      userId: 42,
    });
    expect(mocks.completeSiteOpsAliyunOAuth).toHaveBeenCalledWith({
      actor: { id: 42, username: "site-owner", role: "user" },
      credentialId: oauthCredentialId,
      projectId: "project-1",
      accountUid: "1234567890123456",
      refreshToken: "refresh-token-secret-sentinel",
    });
    expect(html).not.toContain("secret-code-sentinel");
    expect(html).not.toContain("secret-state-sentinel");
    expect(html).not.toContain('if (message.status !== "success")');
  });

  it("projects access_denied as a cancelled page without exposing provider input", async () => {
    const origin = await startApp();
    const response = await fetch(
      `${origin}/api/site-ops/aliyun/oauth/callback?error=access_denied&error_description=${encodeURIComponent("customer-secret-provider-description")}&state=secret-state-sentinel`,
    );
    const html = await response.text();

    expectSecureOAuthCompletionPage(response, html, "cancelled");
    expect(mocks.exchangeAliyunOAuthCode).not.toHaveBeenCalled();
    expect(mocks.completeSiteOpsAliyunOAuth).not.toHaveBeenCalled();
    expect(html).not.toContain("access_denied");
    expect(html).not.toContain("customer-secret-provider-description");
    expect(html).not.toContain("secret-state-sentinel");
  });

  it("projects other provider failures as a safe failed page", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    try {
      const origin = await startApp();
      const response = await fetch(
        `${origin}/api/site-ops/aliyun/oauth/callback?error=invalid_client&error_description=${encodeURIComponent("App not exists: client-id-secret-sentinel")}&state=secret-state-sentinel`,
      );
      const html = await response.text();

      expectSecureOAuthCompletionPage(response, html, "failed");
      expect(mocks.exchangeAliyunOAuthCode).not.toHaveBeenCalled();
      expect(mocks.completeSiteOpsAliyunOAuth).not.toHaveBeenCalled();
      expect(html).not.toContain("invalid_client");
      expect(html).not.toContain("client-id-secret-sentinel");
      expect(html).not.toContain("secret-state-sentinel");
      expect(consoleError).toHaveBeenCalledWith(
        "[SiteOps Aliyun OAuth] callback_stage_failed",
        expect.objectContaining({
          event: "siteops_aliyun_oauth_callback_stage_failed",
          stage: "provider_authorization",
          userId: 42,
          errorCode: "PROVIDER_AUTHORIZATION_FAILED",
          releaseSha: null,
        }),
      );
      expect(JSON.stringify(consoleError.mock.calls)).not.toContain(
        "client-id-secret-sentinel",
      );
      expect(JSON.stringify(consoleError.mock.calls)).not.toContain(
        "secret-state-sentinel",
      );
    } finally {
      consoleError.mockRestore();
    }
  });

  it("returns a safe failed page when the callback has no authenticated user", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    try {
      const origin = await startApp({ authenticated: false });
      const response = await fetch(
        `${origin}/api/site-ops/aliyun/oauth/callback?code=secret-code-sentinel&state=secret-state-sentinel`,
      );
      const html = await response.text();

      expectSecureOAuthCompletionPage(response, html, "failed");
      expect(mocks.exchangeAliyunOAuthCode).not.toHaveBeenCalled();
      expect(mocks.completeSiteOpsAliyunOAuth).not.toHaveBeenCalled();
      expect(html).not.toContain("secret-code-sentinel");
      expect(html).not.toContain("secret-state-sentinel");
      expect(consoleError).toHaveBeenCalledWith(
        "[SiteOps Aliyun OAuth] callback_stage_failed",
        expect.objectContaining({
          stage: "session",
          userId: null,
          errorCode: "UNAUTHENTICATED",
        }),
      );
      expect(JSON.stringify(consoleError.mock.calls)).not.toContain(
        "secret-code-sentinel",
      );
      expect(JSON.stringify(consoleError.mock.calls)).not.toContain(
        "secret-state-sentinel",
      );
    } finally {
      consoleError.mockRestore();
    }
  });

  it("classifies exchange and bind failures by safe stage without logging OAuth material", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    try {
      const exchangeError = Object.assign(
        new Error("secret-code-sentinel secret-state-sentinel"),
        { code: "INVALID_CREDENTIAL" },
      );
      mocks.exchangeAliyunOAuthCode.mockRejectedValueOnce(exchangeError);
      const exchangeOrigin = await startApp();
      const exchangeResponse = await fetch(
        `${exchangeOrigin}/api/site-ops/aliyun/oauth/callback?code=secret-code-sentinel&state=secret-state-sentinel`,
      );
      expectSecureOAuthCompletionPage(
        exchangeResponse,
        await exchangeResponse.text(),
        "failed",
      );
      expect(consoleError).toHaveBeenCalledWith(
        "[SiteOps Aliyun OAuth] callback_stage_failed",
        expect.objectContaining({
          stage: "oauth_exchange",
          errorCode: "INVALID_CREDENTIAL",
        }),
      );

      mocks.completeSiteOpsAliyunOAuth.mockRejectedValueOnce(
        Object.assign(new Error("account-uid-secret-sentinel"), {
          code: "STATE_CONFLICT",
        }),
      );
      const bindOrigin = await startApp();
      const bindResponse = await fetch(
        `${bindOrigin}/api/site-ops/aliyun/oauth/callback?code=secret-code-sentinel&state=secret-state-sentinel`,
      );
      expectSecureOAuthCompletionPage(
        bindResponse,
        await bindResponse.text(),
        "failed",
      );
      expect(consoleError).toHaveBeenCalledWith(
        "[SiteOps Aliyun OAuth] callback_stage_failed",
        expect.objectContaining({
          stage: "account_bind",
          errorCode: "STATE_CONFLICT",
        }),
      );

      const serializedLogs = JSON.stringify(consoleError.mock.calls);
      expect(serializedLogs).not.toContain("secret-code-sentinel");
      expect(serializedLogs).not.toContain("secret-state-sentinel");
      expect(serializedLogs).not.toContain("account-uid-secret-sentinel");
    } finally {
      consoleError.mockRestore();
    }
  });
});

describe("SiteOps private preview proxy", () => {
  it("never projects internal artifact codes to a customer response", () => {
    expect(
      publicSiteOpsArtifactError(
        new Error("SITEOPS_PREVIEW_PATH_INVALID:/private/storage"),
      ),
    ).toEqual({
      status: 409,
      body: { error: "文件暂时无法打开，请稍后重试。" },
    });
    expect(publicSiteOpsArtifactError(new Error("NOT_FOUND"))).toEqual({
      status: 404,
      body: { error: "NOT_FOUND" },
    });
  });

  it("serves one opaque-origin self-contained document without authenticated subresources", async () => {
    const origin = await startApp();
    const prefix = `/api/site-ops/builds/${buildId}/preview/`;
    const response = await fetch(`${origin}${prefix}`);

    expect(response.status).toBe(200);
    expect(response.headers.get("x-robots-tag")).toContain("noindex");
    expect(response.headers.get("cross-origin-opener-policy")).toBe(
      "same-origin",
    );
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    const html = await response.text();
    expect(html).toContain('href="data:image/svg+xml;base64,');
    expect(html).not.toContain(`href="${prefix}styles.css"`);
    expect(html).not.toContain(`src="${prefix}assets/app.js"`);
    expect(html).toContain('<script nonce="');
    expect(html).toContain('type="module"');
    expect(html).toContain("document.body.dataset.route");
    expect(html).toContain('const marker="<script><\\/script>"');
    expect(html).toContain(`href="${prefix}"`);
    expect(html).toContain(`href="${prefix}about/"`);
    expect(html).toContain('src="data:image/png;base64,');
    expect(html).toContain("url('data:image/png;base64,");
    expect(html).toContain("body{font-family:system-ui}");
    expect(html).toContain('href="https://example.com/"');
    expect(html).not.toMatch(/<base\b/iu);
    expect(html).not.toMatch(
      /<meta\b[^>]*http-equiv=["']Content-Security-Policy["']/iu,
    );

    const [cssResponse, faviconResponse, aboutResponse, jsResponse] =
      await Promise.all([
        fetch(`${origin}${prefix}styles.css`),
        fetch(`${origin}${prefix}favicon.svg`),
        fetch(`${origin}${prefix}about/`),
        fetch(`${origin}${prefix}assets/app.js`),
      ]);
    expect(cssResponse.status).toBe(404);
    expect(faviconResponse.status).toBe(404);
    expect(aboutResponse.status).toBe(200);
    expect(await aboutResponse.text()).toContain(`href="${prefix}"`);
    expect(jsResponse.status).toBe(404);
    const csp = response.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("sandbox allow-scripts");
    expect(csp).not.toContain("allow-same-origin");
    expect(csp).not.toContain("allow-forms");
    expect(csp).not.toContain("allow-top-navigation");
    expect(csp).toMatch(/script-src 'nonce-[A-Za-z0-9_-]+'/u);
    expect(csp).toMatch(/style-src 'nonce-[A-Za-z0-9_-]+'/u);
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("connect-src 'none'");
    expect(csp).toContain("worker-src 'none'");
    expect(csp).toContain("frame-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("base-uri 'none'");
  });

  it("serves every real route entry and never falls back unknown paths to the SPA shell", async () => {
    const origin = await startApp();
    const prefix = `/api/site-ops/builds/${buildId}/preview/`;
    const routes = [
      "",
      "about/",
      "offerings/",
      "applications/",
      "cases/",
      "contact/",
    ];

    const responses = await Promise.all(
      routes.map((route) => fetch(`${origin}${prefix}${route}`)),
    );
    expect(responses.map((response) => response.status)).toEqual(
      routes.map(() => 200),
    );
    expect((await fetch(`${origin}${prefix}not-a-real-route/`)).status).toBe(
      404,
    );
  });

  it("serves 2.9 HTML only when the frozen content-plan manifest allows it", async () => {
    const sourceDocumentId = "source-1";
    const section = (id: string, heading: string) => ({
      id,
      blockKind: "hero",
      heading,
      purpose: `${heading} purpose`,
      body: `${heading} verified body`,
      sourceBindings: [
        { sourceDocumentId, evidenceExcerpt: `${heading} evidence` },
      ],
      mediaIds: [],
      entityIds: [],
      faqIds: [],
    });
    const plan = {
      schemaVersion: 2,
      inventorySha256: "b".repeat(64),
      routes: [
        {
          id: "home",
          path: "/",
          title: "Home",
          navigation: "primary",
          parentPath: null,
          detailOfPath: null,
          purpose: "Home purpose",
          userQuestions: [],
          h1: "Home",
          summary: "Home summary",
          cta: { label: "About", targetPath: "/about/" },
          sections: [section("home-hero", "Home")],
        },
        {
          id: "about",
          path: "/about/",
          title: "About",
          navigation: "primary",
          parentPath: null,
          detailOfPath: null,
          purpose: "About purpose",
          userQuestions: [],
          h1: "About",
          summary: "About summary",
          cta: { label: "Home", targetPath: "/" },
          sections: [section("about-hero", "About")],
        },
      ],
      navigation: [
        { label: "Home", targetPath: "/" },
        { label: "About", targetPath: "/about/" },
      ],
      coverage: [
        {
          sourceDocumentId,
          status: "used",
          routeIds: ["home", "about"],
          omissionReason: null,
        },
      ],
    };
    const planBytes = Buffer.from(JSON.stringify(plan));
    const archive = new JSZip();
    archive.file("index.html", "<!doctype html><h1>Home</h1>");
    archive.file("about/index.html", "<!doctype html><h1>About</h1>");
    archive.file("extra/index.html", "<!doctype html><h1>Extra</h1>");
    const v29Dist = await archive.generateAsync({ type: "nodebuffer" });
    mocks.getDb.mockResolvedValue({
      select: () => ({
        from: () => ({
          innerJoin: () => ({
            where: () => ({
              limit: async () => [
                {
                  build: {
                    id: buildId,
                    userId: 42,
                    workflowVersion: "2.9.0",
                    contentPlanLocalAssetId: "plan-asset",
                    contentPlanSha256: "c".repeat(64),
                    distLocalAssetId: "dist-asset",
                    distHash: "a".repeat(64),
                  },
                  project: { id: "project-1", userId: 42 },
                },
              ],
            }),
          }),
        }),
      }),
    });
    mocks.readSiteOpsArtifact.mockImplementation(async ({ localAssetId }) =>
      localAssetId === "plan-asset"
        ? {
            row: {
              id: "plan-asset",
              mimeType: "application/json",
              sizeBytes: planBytes.length,
              contentSha256: "c".repeat(64),
              filename: "plan.json",
            },
            stored: { createReadStream: () => Readable.from([planBytes]) },
          }
        : {
            row: {
              id: "dist-asset",
              mimeType: "application/zip",
              sizeBytes: v29Dist.length,
              contentSha256: "a".repeat(64),
              filename: "dist.zip",
            },
            stored: { createReadStream: () => Readable.from([v29Dist]) },
          },
    );
    const origin = await startApp();
    const prefix = `/api/site-ops/builds/${buildId}/preview/`;

    expect((await fetch(`${origin}${prefix}`)).status).toBe(200);
    expect((await fetch(`${origin}${prefix}about/`)).status).toBe(200);
    expect((await fetch(`${origin}${prefix}extra/`)).status).toBe(404);
    expect((await fetch(`${origin}${prefix}unknown/`)).status).toBe(404);
  });

  it("executes minified legacy and canonical routers without a double preview prefix", async () => {
    const prefix = `/api/site-ops/builds/${buildId}/preview/`;
    const routes = [
      ["", "home"],
      ["about/", "about"],
      ["offerings/", "offerings"],
      ["applications/", "applications"],
      ["cases/", "cases"],
      ["contact/", "contact"],
    ] as const;
    const routeTable =
      '{"/":"home","/about/":"about","/offerings/":"offerings","/applications/":"applications","/cases/":"cases","/contact/":"contact"}';

    for (const previewRoutingMode of [
      "legacy_static_literals",
      "canonical_pathname",
    ] as const) {
      const archive = new JSZip();
      const pathnameExpression =
        previewRoutingMode === "canonical_pathname"
          ? "canonicalSitePathname()"
          : "location.pathname";
      archive.file(
        "assets/router.js",
        `(()=>{const r=${routeTable},p=${pathnameExpression},u=s=>\`/\${s}/\`;document.body.dataset.route=r[p]??"404";document.body.dataset.canonical=canonicalSitePathname();const a=document.createElement("a");a.id="dynamic-route";a.href=u("contact")+"?from=nav#form";a.textContent="contact";document.body.append(a);window.__routeTo=s=>history.pushState({},"",u(s)+"?from=history#section")})();`,
      );
      for (const [route] of routes) {
        archive.file(
          route ? `${route}index.html` : "index.html",
          '<!doctype html><html><head></head><body><script src="/assets/router.js"></script></body></html>',
        );
      }

      for (const [route, expected] of routes) {
        const document = await createSandboxedPreviewDocument({
          zip: archive,
          entryName: route ? `${route}index.html` : "index.html",
          previewPrefix: prefix,
          previewRoutingMode,
        });
        const html = document.bytes.toString("utf8");
        expect(html).not.toContain(`${prefix}${prefix}`);
        const dom = new JSDOM(html, {
          runScripts: "dangerously",
          url: `https://dashboard.frontmind.net${prefix}${route}`,
        });
        try {
          expect(dom.window.document.body.dataset.route).toBe(expected);
          expect(dom.window.document.body.dataset.canonical).toBe(
            route ? `/${route}` : "/",
          );

          const anchor =
            dom.window.document.querySelector<HTMLAnchorElement>(
              "#dynamic-route",
            );
          expect(anchor?.getAttribute("href")).toBe("/contact/?from=nav#form");
          anchor?.addEventListener("click", (event) => event.preventDefault());
          anchor?.dispatchEvent(
            new dom.window.MouseEvent("click", {
              bubbles: true,
              cancelable: true,
              button: 0,
            }),
          );
          expect(anchor?.getAttribute("href")).toBe(
            `${prefix}contact/?from=nav#form`,
          );

          (
            dom.window as unknown as { __routeTo: (slug: string) => void }
          ).__routeTo("cases");
          expect(dom.window.location.pathname).toBe(`${prefix}cases/`);
          expect(dom.window.location.search).toBe("?from=history");
          expect(dom.window.location.hash).toBe("#section");
        } finally {
          dom.window.close();
        }
      }
    }
  });

  it("keeps legacy static route keys scoped but leaves dynamic templates to the navigation bridge", () => {
    const prefix = `/api/site-ops/builds/${buildId}/preview/`;
    const source =
      'const routes={"/":"home","/about/":"about"};const route=(segment)=>`/${segment}/`;';
    const rewritten = rewriteSiteOpsPreviewDocument({
      bytes: Buffer.from(source),
      mimeType: "text/javascript; charset=utf-8",
      previewPrefix: prefix,
      previewRoutingMode: "legacy_static_literals",
    }).toString("utf8");

    expect(rewritten).toContain(`"${prefix}":"home"`);
    expect(rewritten).toContain(`"${prefix}about/":"about"`);
    expect(rewritten).toContain("`/${segment}/`");
    expect(rewritten).not.toContain(`${prefix}${prefix}`);
  });
});

describe("SiteOps visual sample preview", () => {
  const previewAssetId = "323e4567-e89b-42d3-a456-426614174000";
  const realizationAssetId = "423e4567-e89b-42d3-a456-426614174000";
  const previewBytes = Buffer.from("durable-preview-image");
  const referenceHash = "a".repeat(64);
  const realizationHash = "d".repeat(64);

  function v7StaticPreviewMetadata(
    overrides: Record<string, unknown> = {},
  ): Record<string, unknown> {
    const candidateId = "static-template-01-arfazrll-portfolio";
    return {
      schemaVersion: 7,
      renderer: "frontmind_static_template_catalog_v1",
      workflowVersion: "2.8.0",
      catalogVersion: "21st-included-recommended-20260828-v1",
      catalogPosition: 1,
      catalogCandidateId: candidateId,
      providerTemplateId: "827",
      providerSlug: "arfazrll-portfolio",
      sourceAssetId:
        "21st-included-recommended-20260828-v1/source/static-template-01-arfazrll-portfolio",
      sourceArchiveSha256: "d".repeat(64),
      previewAssetId:
        "21st-included-recommended-20260828-v1/preview/static-template-01-arfazrll-portfolio",
      previewLocalAssetId: previewAssetId,
      previewSha256: "c".repeat(64),
      previewMimeType: "image/png",
      previewWidth: 1440,
      previewHeight: 900,
      ...overrides,
    };
  }

  function v4DualPreviewMetadata(
    overrides: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return {
      referenceBlueprint: {
        schemaVersion: 4,
        referencePreviewLocalAssetId: previewAssetId,
        referencePreviewSha256: referenceHash,
        previewLocalAssetId: realizationAssetId,
        previewSha256: realizationHash,
      },
      realizationPreviewLocalAssetId: realizationAssetId,
      realizationPreviewSha256: realizationHash,
      ...overrides,
    };
  }

  it("shares one published-or-selected predicate with observation", () => {
    expect(CUSTOMER_VISIBLE_STYLE_BATCH_STATUSES).toEqual([
      "published",
      "selected",
    ]);
    expect(
      new MySqlDialect().sqlToQuery(customerVisibleStyleBatchStatusCondition()),
    ).toMatchObject({
      params: ["published", "selected"],
    });
  });

  it("serves a selected owner's preview after a fresh request without caching it", async () => {
    mocks.getDb.mockResolvedValueOnce(stylePreviewDatabase(previewAssetId));
    mocks.readSiteOpsArtifact.mockResolvedValueOnce({
      row: {
        id: previewAssetId,
        mimeType: "image/png",
        sizeBytes: previewBytes.length,
        contentSha256: "b".repeat(64),
        filename: "preview.png",
      },
      stored: { createReadStream: () => Readable.from([previewBytes]) },
    });
    const origin = await startApp();

    const response = await fetch(
      `${origin}/api/site-ops/style-previews/selected-sample`,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe(
      "private, no-store, max-age=0",
    );
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await response.arrayBuffer())).toEqual(previewBytes);
    expect(mocks.readSiteOpsArtifact).toHaveBeenCalledWith({
      userId: 42,
      localAssetId: previewAssetId,
      expectedSha256: "b".repeat(64),
      expectedMimeTypes: [
        "image/avif",
        "image/png",
        "image/jpeg",
        "image/webp",
      ],
    });
  });

  it("serves an authorized V7 preview from its frozen managed-user asset", async () => {
    const managedBytes = Buffer.from("managed-template-preview");
    const staticHash = "c".repeat(64);
    const metadata = v7StaticPreviewMetadata();
    mocks.getDb.mockResolvedValueOnce(
      stylePreviewDatabase(previewAssetId, metadata),
    );
    mocks.readSiteOpsArtifact.mockResolvedValueOnce({
      row: {
        id: previewAssetId,
        mimeType: "image/png",
        sizeBytes: managedBytes.length,
        contentSha256: staticHash,
        filename: "static-template-01.png",
      },
      stored: { createReadStream: () => Readable.from([managedBytes]) },
    });
    const origin = await startApp();

    const response = await fetch(
      `${origin}/api/site-ops/style-previews/v7-static-sample`,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("etag")).toBe(`"sha256:${staticHash}"`);
    expect(response.headers.get("cache-control")).toBe(
      "private, no-store, max-age=0",
    );
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await response.arrayBuffer())).toEqual(managedBytes);
    expect(
      mocks.openStaticTemplateCatalogVersionPreview,
    ).not.toHaveBeenCalled();
    expect(mocks.readSiteOpsArtifact).toHaveBeenCalledWith({
      userId: 42,
      localAssetId: previewAssetId,
      expectedSha256: staticHash,
      expectedMimeTypes: ["image/png"],
    });
  });

  it("serves a frozen V7 preview independently of later catalog mount changes", async () => {
    const candidateId = "static-template-01-arfazrll-portfolio";
    const catalogVersion = "21st-included-recommended-20260828-v2";
    const catalogPreviewAssetId = `${catalogVersion}/preview/${candidateId}`;
    const sourceAssetId = `${catalogVersion}/source/${candidateId}`;
    const metadata = v7StaticPreviewMetadata({
      catalogVersion,
      previewAssetId: catalogPreviewAssetId,
      sourceAssetId,
    });
    const staticBytes = Buffer.from("frozen-version-preview");
    mocks.getDb.mockResolvedValueOnce(
      stylePreviewDatabase(previewAssetId, metadata),
    );
    mocks.openStaticTemplateCatalogVersionPreview.mockRejectedValueOnce(
      new mocks.StaticTemplateCatalogError(
        "STATIC_TEMPLATE_CATALOG_VERSION_NOT_FOUND",
      ),
    );
    mocks.readSiteOpsArtifact.mockResolvedValueOnce({
      row: {
        id: previewAssetId,
        mimeType: "image/png",
        sizeBytes: staticBytes.length,
        contentSha256: "c".repeat(64),
        filename: "frozen-preview.png",
      },
      stored: { createReadStream: () => Readable.from([staticBytes]) },
    });
    const origin = await startApp();

    const response = await fetch(
      `${origin}/api/site-ops/style-previews/v7-frozen-version-sample`,
    );

    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(staticBytes);
    expect(
      mocks.openStaticTemplateCatalogVersionPreview,
    ).not.toHaveBeenCalled();
  });

  it("rejects a V7 row without its required frozen managed-user asset", async () => {
    const metadata = v7StaticPreviewMetadata({
      previewLocalAssetId: null,
    });
    mocks.getDb.mockResolvedValueOnce(
      stylePreviewDatabase(null, metadata, true),
    );
    const origin = await startApp();

    const response = await fetch(
      `${origin}/api/site-ops/style-previews/v7-historical-static-sample`,
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "NOT_FOUND" });
    expect(
      mocks.openStaticTemplateCatalogVersionPreview,
    ).not.toHaveBeenCalled();
    expect(mocks.readSiteOpsArtifact).not.toHaveBeenCalled();
  });

  it("returns 404 when a V7 row and its frozen managed-user asset coordinate disagree", async () => {
    mocks.getDb.mockResolvedValueOnce(
      stylePreviewDatabase(
        previewAssetId,
        v7StaticPreviewMetadata({
          previewLocalAssetId: realizationAssetId,
        }),
      ),
    );
    const origin = await startApp();

    const response = await fetch(
      `${origin}/api/site-ops/style-previews/v7-local-asset-mismatch`,
    );

    expect(response.status).toBe(404);
    expect(
      mocks.openStaticTemplateCatalogVersionPreview,
    ).not.toHaveBeenCalled();
    expect(mocks.readSiteOpsArtifact).not.toHaveBeenCalled();
  });

  it.each([
    "SITEOPS_ARTIFACT_HASH_MISMATCH",
    "SITEOPS_ARTIFACT_MIME_MISMATCH",
    "SITEOPS_ARTIFACT_BODY_MISMATCH",
  ])("projects V7 managed preview %s failures as 404", async (errorCode) => {
    const metadata = v7StaticPreviewMetadata();
    mocks.getDb.mockResolvedValueOnce(
      stylePreviewDatabase(previewAssetId, metadata),
    );
    mocks.readSiteOpsArtifact.mockRejectedValueOnce(new Error(errorCode));
    const origin = await startApp();

    const response = await fetch(
      `${origin}/api/site-ops/style-previews/v7-managed-integrity-failure`,
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "NOT_FOUND" });
    expect(mocks.readSiteOpsArtifact).toHaveBeenCalledWith({
      userId: 42,
      localAssetId: previewAssetId,
      expectedSha256: "c".repeat(64),
      expectedMimeTypes: ["image/png"],
    });
  });

  it("serves a V4 reference with its reference hash instead of the distinct realization hash", async () => {
    mocks.getDb.mockResolvedValueOnce(
      stylePreviewDatabase(previewAssetId, v4DualPreviewMetadata()),
    );
    mocks.readSiteOpsArtifact.mockResolvedValueOnce({
      row: {
        id: previewAssetId,
        mimeType: "image/png",
        sizeBytes: previewBytes.length,
        contentSha256: referenceHash,
        filename: "reference.png",
      },
      stored: { createReadStream: () => Readable.from([previewBytes]) },
    });
    const origin = await startApp();

    const response = await fetch(
      `${origin}/api/site-ops/style-previews/v4-reference`,
    );

    expect(response.status).toBe(200);
    expect(mocks.readSiteOpsArtifact).toHaveBeenCalledWith({
      userId: 42,
      localAssetId: previewAssetId,
      expectedSha256: referenceHash,
      expectedMimeTypes: [
        "image/avif",
        "image/png",
        "image/jpeg",
        "image/webp",
      ],
    });
  });

  it("uses the realization hash only when the sample explicitly points to the V4 realization asset", async () => {
    mocks.getDb.mockResolvedValueOnce(
      stylePreviewDatabase(realizationAssetId, v4DualPreviewMetadata()),
    );
    mocks.readSiteOpsArtifact.mockResolvedValueOnce({
      row: {
        id: realizationAssetId,
        mimeType: "image/webp",
        sizeBytes: previewBytes.length,
        contentSha256: realizationHash,
        filename: "realization.webp",
      },
      stored: { createReadStream: () => Readable.from([previewBytes]) },
    });
    const origin = await startApp();

    const response = await fetch(
      `${origin}/api/site-ops/style-previews/v4-realization`,
    );

    expect(response.status).toBe(200);
    expect(mocks.readSiteOpsArtifact).toHaveBeenCalledWith({
      userId: 42,
      localAssetId: realizationAssetId,
      expectedSha256: realizationHash,
      expectedMimeTypes: [
        "image/avif",
        "image/png",
        "image/jpeg",
        "image/webp",
      ],
    });
  });

  it("allows independently frozen V4 images to contain identical bytes", async () => {
    mocks.getDb.mockResolvedValueOnce(
      stylePreviewDatabase(
        previewAssetId,
        v4DualPreviewMetadata({
          referenceBlueprint: {
            schemaVersion: 4,
            referencePreviewLocalAssetId: previewAssetId,
            referencePreviewSha256: referenceHash,
            previewLocalAssetId: realizationAssetId,
            previewSha256: referenceHash,
          },
          realizationPreviewSha256: referenceHash,
        }),
      ),
    );
    mocks.readSiteOpsArtifact.mockResolvedValueOnce({
      row: {
        id: previewAssetId,
        mimeType: "image/png",
        sizeBytes: previewBytes.length,
        contentSha256: referenceHash,
        filename: "reference.png",
      },
      stored: { createReadStream: () => Readable.from([previewBytes]) },
    });
    const origin = await startApp();

    const response = await fetch(
      `${origin}/api/site-ops/style-previews/v4-identical-bytes`,
    );

    expect(response.status).toBe(200);
    expect(mocks.readSiteOpsArtifact).toHaveBeenCalledWith({
      userId: 42,
      localAssetId: previewAssetId,
      expectedSha256: referenceHash,
      expectedMimeTypes: [
        "image/avif",
        "image/png",
        "image/jpeg",
        "image/webp",
      ],
    });
  });

  it("fails closed when a V4 row points to neither frozen image coordinate", async () => {
    const unrelatedAssetId = "523e4567-e89b-42d3-a456-426614174000";
    mocks.getDb.mockResolvedValueOnce(
      stylePreviewDatabase(unrelatedAssetId, v4DualPreviewMetadata()),
    );
    const origin = await startApp();

    const response = await fetch(
      `${origin}/api/site-ops/style-previews/v4-coordinate-mismatch`,
    );

    expect(response.status).toBe(404);
    expect(mocks.readSiteOpsArtifact).not.toHaveBeenCalled();
  });

  it("fails closed when V4 realization metadata disagrees with its frozen blueprint", async () => {
    mocks.getDb.mockResolvedValueOnce(
      stylePreviewDatabase(
        previewAssetId,
        v4DualPreviewMetadata({ realizationPreviewSha256: "e".repeat(64) }),
      ),
    );
    const origin = await startApp();

    const response = await fetch(
      `${origin}/api/site-ops/style-previews/v4-metadata-mismatch`,
    );

    expect(response.status).toBe(404);
    expect(mocks.readSiteOpsArtifact).not.toHaveBeenCalled();
  });

  it("fails closed before reading a source-backed preview whose frozen hash is missing", async () => {
    mocks.getDb.mockResolvedValueOnce(
      stylePreviewDatabase(previewAssetId, {
        schemaVersion: 6,
        renderer: "twenty_first_native_template_v1",
      }),
    );
    const origin = await startApp();

    const response = await fetch(
      `${origin}/api/site-ops/style-previews/hash-missing`,
    );

    expect(response.status).toBe(404);
    expect(mocks.readSiteOpsArtifact).not.toHaveBeenCalled();
  });

  it("passes the frozen hash to storage and fails safely on a mismatch", async () => {
    mocks.getDb.mockResolvedValueOnce(
      stylePreviewDatabase(previewAssetId, {
        schemaVersion: 6,
        renderer: "twenty_first_native_template_v1",
        previewSha256: "c".repeat(64),
      }),
    );
    mocks.readSiteOpsArtifact.mockResolvedValueOnce(null);
    const origin = await startApp();

    const response = await fetch(
      `${origin}/api/site-ops/style-previews/hash-mismatch`,
    );

    expect(response.status).toBe(404);
    expect(mocks.readSiteOpsArtifact).toHaveBeenCalledWith({
      userId: 42,
      localAssetId: previewAssetId,
      expectedSha256: "c".repeat(64),
      expectedMimeTypes: [
        "image/avif",
        "image/png",
        "image/jpeg",
        "image/webp",
      ],
    });
  });

  it("rejects a non-image asset even if storage returns it", async () => {
    mocks.getDb.mockResolvedValueOnce(stylePreviewDatabase(previewAssetId));
    mocks.readSiteOpsArtifact.mockResolvedValueOnce({
      row: {
        id: previewAssetId,
        mimeType: "application/zip",
        sizeBytes: previewBytes.length,
        contentSha256: "b".repeat(64),
        filename: "preview.zip",
      },
      stored: { createReadStream: () => Readable.from([previewBytes]) },
    });
    const origin = await startApp();

    const response = await fetch(
      `${origin}/api/site-ops/style-previews/wrong-mime`,
    );

    expect(response.status).toBe(404);
  });

  it("keeps legacy rows without a frozen hash readable through MIME checks", async () => {
    mocks.getDb.mockResolvedValueOnce(
      stylePreviewDatabase(previewAssetId, { schemaVersion: 1 }),
    );
    mocks.readSiteOpsArtifact.mockResolvedValueOnce({
      row: {
        id: previewAssetId,
        mimeType: "image/png",
        sizeBytes: previewBytes.length,
        contentSha256: "b".repeat(64),
        filename: "preview.png",
      },
      stored: { createReadStream: () => Readable.from([previewBytes]) },
    });
    const origin = await startApp();

    const response = await fetch(
      `${origin}/api/site-ops/style-previews/legacy-sample`,
    );

    expect(response.status).toBe(200);
    expect(mocks.readSiteOpsArtifact).toHaveBeenCalledWith({
      userId: 42,
      localAssetId: previewAssetId,
      expectedSha256: undefined,
      expectedMimeTypes: [
        "image/avif",
        "image/png",
        "image/jpeg",
        "image/webp",
      ],
    });
  });

  it.each(["superseded batch", "cross-tenant sample"])(
    "returns 404 for a %s without reading artifact bytes",
    async () => {
      mocks.getDb.mockResolvedValueOnce(stylePreviewDatabase(null));
      const origin = await startApp();

      const response = await fetch(
        `${origin}/api/site-ops/style-previews/hidden-sample`,
      );

      expect(response.status).toBe(404);
      expect(mocks.readSiteOpsArtifact).not.toHaveBeenCalled();
    },
  );

  it("returns 404 before the database lookup when unauthenticated", async () => {
    const origin = await startApp({ authenticated: false });

    const response = await fetch(
      `${origin}/api/site-ops/style-previews/private-sample`,
    );

    expect(response.status).toBe(404);
    expect(mocks.getDb).not.toHaveBeenCalled();
    expect(mocks.readSiteOpsArtifact).not.toHaveBeenCalled();
  });

  it("returns 404 when an owned preview row has no durable body", async () => {
    mocks.getDb.mockResolvedValueOnce(stylePreviewDatabase(previewAssetId));
    mocks.readSiteOpsArtifact.mockResolvedValueOnce(null);
    const origin = await startApp();

    const response = await fetch(
      `${origin}/api/site-ops/style-previews/missing-body`,
    );

    expect(response.status).toBe(404);
  });
});
