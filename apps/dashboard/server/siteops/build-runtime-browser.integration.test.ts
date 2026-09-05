import { createHash } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";

import JSZip from "jszip";
import { chromium } from "playwright";
import { describe, expect, it } from "vitest";

import { SITEOPS_WORKFLOW } from "../../shared/siteops";
import { referenceBlueprintForVisualCandidate } from "../../shared/siteops-design";
import {
  materializeAstroSite,
  type MaterializeAstroSiteInput,
  type SiteOpsQaReport,
} from "./build-runtime";
import { materializeNativeReactSource } from "./native-react-build-runtime";
import { validateNativeReactSourceArchive } from "./native-react-source";
import {
  createSandboxedPreviewDocument,
  sandboxedPreviewContentSecurityPolicy,
} from "./artifact-api";

const H = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");

function browserIntegrationInput(): MaterializeAstroSiteInput {
  const snapshotId = "70000000-0000-4000-8000-000000000007";
  const archiveHash = H("browser-integration-knowledge");
  const previewSha256 = H("browser-integration-preview");
  const referenceBlueprint = referenceBlueprintForVisualCandidate({
    candidateId: "candidate-F-browser-integration",
    providerItemKey: "n:8435",
    previewSha256,
    title: "Floating orbit life science hero",
  });
  return {
    build: {
      id: "71000000-0000-4000-8000-000000000007",
      projectId: "72000000-0000-4000-8000-000000000007",
      userId: 7,
      knowledgeSnapshotId: snapshotId,
      knowledgeArchiveHash: archiveHash,
      workflowUpstreamVersion: SITEOPS_WORKFLOW.upstreamVersion,
      workflowUpstreamHash: SITEOPS_WORKFLOW.upstreamSha256,
      workflowVersion: SITEOPS_WORKFLOW.frontMindVersion,
      workflowPackageHash: SITEOPS_WORKFLOW.runtimeManifestSha256,
      starterVersion: SITEOPS_WORKFLOW.starterVersion,
      selectionHash: H("browser-integration-selection"),
    },
    snapshot: {
      id: snapshotId,
      userId: 7,
      archiveHash,
      sourceBuildId: null,
      sourceBuildRevision: null,
      documents: [
        {
          id: "overview",
          path: "overview.md",
          title: "企业概览",
          content: "生命科学团队提供经过确认的研究与技术服务。",
          kind: "overview",
          customerVisible: true,
        },
      ],
    },
    brief: {
      companyName: "澄明生命科学",
      primaryLanguage: "zh-CN",
      contacts: [
        {
          kind: "email",
          value: "hello@chengming.example",
          sourceDocumentIds: ["overview"],
        },
      ],
      offerings: ["生命科学研究服务"],
      audience: ["研究与产业团队"],
      conversionGoal: "联系研究团队",
      routes: [
        {
          id: "home",
          slug: "/",
          title: "首页",
          sourceDocumentIds: ["overview"],
        },
      ],
      verifiedFacts: [
        {
          statement: "提供生命科学研究与技术服务",
          sourceDocumentIds: ["overview"],
        },
      ],
      publicAssetIds: [],
      unknowns: [],
    },
    visual: {
      schemaVersion: 2,
      queryHash: H("browser-integration-query"),
      selectedCandidateId: referenceBlueprint.candidateId,
      providerItemKey: referenceBlueprint.providerItemKey,
      visualEvidenceSha256: H("browser-integration-evidence"),
      previewSha256,
      supportEvidenceSha256s: [],
      taxonomy: {
        role: "foundation",
        // Regression for the production shape whose only valid hex color
        // leaves the selected semantic roles on their deterministic fallbacks.
        palette: ["#f8f8f8", "warm", "soft", "neutral"],
        typography: ["editorial display"],
        layout: ["centered orbit"],
        motion: ["subtle floating"],
        accessibility: ["high contrast"],
      },
      referenceBlueprint,
    },
    designSpec: {
      schemaVersion: 2,
      referenceBlueprint,
      layoutArchetype: "hero_led",
      density: "spacious",
      surfaceStyle: "soft_depth",
      typeScale: "display",
      imageTreatment: "none",
      motionLevel: "subtle",
      colorRoles: {
        backgroundPaletteIndex: 1,
        textPaletteIndex: 2,
        accentPaletteIndex: 3,
      },
      routeCompositions: [
        {
          routeId: "home",
          slots: [{ slotId: "research-proof", variant: "cta" }],
        },
      ],
      seoPlan: {
        siteTitle: "澄明生命科学",
        description: "面向研究与产业团队的生命科学研究与技术服务。",
        organizationType: "ProfessionalService",
      },
    },
    generatedContent: {
      seo: {
        siteTitle: "澄明生命科学",
        description: "面向研究与产业团队的生命科学研究与技术服务。",
        organizationType: "ProfessionalService",
      },
      routes: [
        {
          routeId: "home",
          eyebrow: "生命科学 · 可信研究",
          heading: "让复杂生命轨迹变得清晰",
          summary:
            "以经过确认的企业知识为基础，呈现研究能力、技术路径与合作方式。",
          sections: [
            {
              slotId: "research-proof",
              heading: "经过确认的研究能力",
              paragraphs: [
                "团队提供生命科学研究服务，并让每项公开表达保留知识来源。",
              ],
              sourceDocumentIds: ["overview"],
            },
          ],
        },
      ],
    },
    mode: "preview",
    canonicalOrigin: null,
    timeoutMs: 120_000,
  };
}

const browserIntegration =
  process.env.FRONTMIND_RUN_SITEOPS_BROWSER_INTEGRATION === "1"
    ? describe
    : describe.skip;

browserIntegration("SiteOps React static real-browser integration", () => {
  it("runs a native preview as an opaque document without Dashboard storage or API authority", async () => {
    const zip = new JSZip();
    zip.file(
      "index.html",
      '<!doctype html><html><head><base href="/"><meta http-equiv="Content-Security-Policy" content="default-src \'self\'; script-src \'self\'; base-uri \'self\'"></head><body><div id="root"></div><script type="module" src="/assets/app.js"></script></body></html>',
    );
    zip.file(
      "assets/app.js",
      `const scriptMarkup="<script><\\/script>";
const probe=(name,read)=>{try{read();document.body.dataset[name]="available"}catch{document.body.dataset[name]="blocked"}};
probe("cookie",()=>document.cookie);
probe("local",()=>localStorage.getItem("frontmind"));
probe("session",()=>sessionStorage.getItem("frontmind"));
fetch("/api/private-sentinel",{credentials:"include"}).then(()=>{document.body.dataset.api="available"}).catch(()=>{document.body.dataset.api="blocked"}).finally(()=>{document.getElementById("root").textContent="原生预览已渲染";document.body.dataset.markup=scriptMarkup;document.body.dataset.ready="yes"});`,
    );
    const previewDocument = await createSandboxedPreviewDocument({
      zip,
      entryName: "index.html",
      previewPrefix: "/preview/",
    });
    const previewHtml = previewDocument.bytes.toString("utf8");
    expect(previewHtml).not.toMatch(/<base\b/iu);
    expect(previewHtml).not.toMatch(
      /<meta\b[^>]*http-equiv=["']Content-Security-Policy["']/iu,
    );
    let privateApiHits = 0;
    const server = createServer((request, response) => {
      if (request.url === "/preview/") {
        response.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Content-Length": previewDocument.bytes.length,
          "Content-Security-Policy": sandboxedPreviewContentSecurityPolicy(
            previewDocument.nonce,
          ),
          "Set-Cookie":
            "frontmind_session=private-sentinel; Path=/; HttpOnly; SameSite=Lax",
        });
        response.end(previewDocument.bytes);
        return;
      }
      privateApiHits += 1;
      response.writeHead(200, { "Content-Type": "text/plain" });
      response.end("private-api-sentinel");
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") {
      server.close();
      throw new Error("PREVIEW_TEST_SERVER_UNAVAILABLE");
    }
    const browser = await chromium.launch({
      headless: true,
      chromiumSandbox: false,
    });
    try {
      const page = await browser.newPage();
      await page.goto(`http://127.0.0.1:${address.port}/preview/`);
      await page.waitForFunction(() => document.body.dataset.ready === "yes");
      expect(
        await page.evaluate(() => ({
          text: document.querySelector("#root")?.textContent,
          cookie: document.body.dataset.cookie,
          local: document.body.dataset.local,
          session: document.body.dataset.session,
          api: document.body.dataset.api,
          markup: document.body.dataset.markup,
        })),
      ).toEqual({
        text: "原生预览已渲染",
        cookie: "blocked",
        local: "blocked",
        session: "blocked",
        api: "blocked",
        markup: "<script></script>",
      });
      expect(privateApiHits).toBe(0);
    } finally {
      await browser.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 30_000);

  it("passes real Chromium, axe and Lighthouse QA at 390/768/1440", async () => {
    const built = await materializeAstroSite(browserIntegrationInput());
    const qa = JSON.parse(built.qaJson.toString("utf8")) as SiteOpsQaReport;
    expect(qa.browser.axeViolationCount).toBe(0);
    expect(qa.browser.screenshotFiles).toEqual([
      "screenshots/home-390.png",
      "screenshots/home-768.png",
      "screenshots/home-1440.png",
    ]);
    expect(qa.browser.lighthouse).toMatchObject({
      performance: expect.any(Number),
      accessibility: expect.any(Number),
      bestPractices: expect.any(Number),
      seo: expect.any(Number),
      cls: expect.any(Number),
    });
    expect(qa.browser.lighthouse.performance).toBeGreaterThanOrEqual(85);
    expect(qa.browser.lighthouse.accessibility).toBeGreaterThanOrEqual(95);
    expect(qa.browser.lighthouse.bestPractices).toBeGreaterThanOrEqual(90);
    expect(qa.browser.lighthouse.seo).toBeGreaterThanOrEqual(95);
    expect(qa.browser.lighthouse.cls).toBeLessThan(0.1);
  }, 180_000);

  it("keeps a real native React preview available when axe reports contrast warnings", async () => {
    const files = new Map<string, Buffer>([
      [
        "package.json",
        Buffer.from(
          JSON.stringify({
            type: "module",
            dependencies: { react: "19.2.1", "react-dom": "19.2.1" },
          }),
        ),
      ],
      [
        "index.html",
        Buffer.from(
          '<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>原生官网</title></head><body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body></html>',
        ),
      ],
      [
        "src/main.tsx",
        Buffer.from(`import React from "react";
import { createRoot } from "react-dom/client";
import "./style.css";
function App(){return <main><h1>原生 21st 企业官网</h1><p>经过核验的企业介绍内容</p><button>联系企业</button></main>}
createRoot(document.getElementById("root")!).render(<App />);`),
      ],
      [
        "src/style.css",
        Buffer.from(
          "body{margin:0;font-family:system-ui;background:#fff}main{min-height:100vh;display:grid;place-content:center}p,button{color:#eee;background:#fff}button{border:0;padding:16px}",
        ),
      ],
    ]);
    const archive = new JSZip();
    for (const [filename, bytes] of files) archive.file(filename, bytes);
    const sourceZip = await archive.generateAsync({ type: "nodebuffer" });
    const operationToken = "native-browser-integration-token";
    const baseSourceSha256 = H("native-browser-base-source");
    const validatedSource = await validateNativeReactSourceArchive({
      archive: sourceZip,
      receipt: {
        operationToken,
        baseSourceSha256,
        archiveSha256: H(sourceZip),
        fileCount: files.size,
      },
      expectedOperationToken: operationToken,
      expectedBaseSourceSha256: baseSourceSha256,
    });
    const input = browserIntegrationInput();
    const built = await materializeNativeReactSource({
      sourceZip,
      validatedSource,
      build: {
        id: input.build.id,
        projectId: input.build.projectId,
        knowledgeSnapshotId: input.build.knowledgeSnapshotId,
        workflowVersion: "2.5.0",
        selectionHash: input.build.selectionHash,
      },
      brief: input.brief,
      mode: "preview",
      lighthouseQa: false,
    });
    expect(built.sourceZip.equals(sourceZip)).toBe(true);
    expect(built.buildDelivery).toMatchObject({
      renderMode: "twenty_first_native",
      qaStatus: "passed_with_warnings",
    });
    expect(built.buildDelivery.warningCodes).toContain("NATIVE_AXE_WARNING");
    const qa = JSON.parse(built.qaJson.toString("utf8"));
    expect(qa.passed).toBe(true);
    expect(qa.browser.axeViolationIds).toContain("color-contrast");
    expect(qa.browser.screenshotFiles).toEqual([
      "screenshots/home-1440.png",
      "screenshots/home-390.png",
    ]);
  }, 120_000);
});
