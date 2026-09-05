import { createHash } from "node:crypto";

import JSZip from "jszip";
import { describe, expect, it, vi } from "vitest";

import type { SiteBrief } from "../../shared/siteops";
import type { SiteContentPlanV2 } from "../../shared/siteops-content-plan";
import { canonicalJson } from "../../shared/siteops-workflow";
import {
  NATIVE_RUNTIME_CONTRACT_V1,
  NATIVE_RUNTIME_CONTRACT_V1_SHA256,
  NATIVE_RUNTIME_EXECUTION_SHELL_V1,
  NATIVE_RUNTIME_EXECUTION_SHELL_V1_SHA256,
  NATIVE_RUNTIME_ROUTE_MANIFEST_EXPORT,
  NATIVE_RUNTIME_ROUTE_MODULE,
  NATIVE_SOURCE_PREFLIGHT_V2_SHA256,
  NATIVE_SOURCE_PREFLIGHT_V2_VERSION,
  auditNativeRuntimeContractV1,
  validateNativeReactSourceArchive,
  type ValidatedNativeReactSource,
} from "./native-react-source";
import {
  auditSiteContentPlanRenderedRoutes,
  materializeNativeReactSource,
  NativeReactBuildError,
  rebuildNativeReactProductionFromSource,
  type NativeContentPlanDomSnapshot,
} from "./native-react-build-runtime";

const BUILD = {
  id: "11111111-1111-4111-8111-111111111111",
  projectId: "22222222-2222-4222-8222-222222222222",
  knowledgeSnapshotId: "33333333-3333-4333-8333-333333333333",
  workflowVersion: "2.5.0",
  selectionHash: "a".repeat(64),
} as const;

const BRIEF = {
  companyName: "示例企业",
  primaryLanguage: "zh-CN",
  contacts: [],
  offerings: ["企业服务"],
  audience: ["企业客户"],
  conversionGoal: "联系咨询",
  contentInventory: {
    schemaVersion: 1,
    source: "frozen_knowledge_snapshot",
    entries: [],
  },
  routes: [
    {
      id: "home",
      slug: "/",
      title: "首页",
      sourceDocumentIds: ["source-1"],
    },
    {
      id: "applications",
      slug: "/applications/",
      title: "应用场景",
      sourceDocumentIds: ["source-1"],
    },
  ],
  verifiedFacts: [
    { statement: "这是已核验的企业介绍。", sourceDocumentIds: ["source-1"] },
  ],
  publicAssetIds: [],
  unknowns: [],
} satisfies SiteBrief;

const BUILD_2_9 = { ...BUILD, workflowVersion: "2.9.0" } as const;
const CONTENT_PLAN = {
  schemaVersion: 2,
  inventorySha256: "d".repeat(64),
  routes: [
    {
      id: "home",
      path: "/",
      title: "首页",
      navigation: "primary",
      parentPath: null,
      detailOfPath: null,
      purpose: "解释企业能力",
      userQuestions: ["企业能解决什么问题？"],
      h1: "可信赖的企业服务",
      summary: "围绕客户真实业务问题提供可核验的专业服务。",
      cta: { label: "查看应用场景", targetPath: "/applications/" },
      sections: [
        {
          id: "home-capability",
          blockKind: "prose",
          heading: "核心能力",
          purpose: "介绍企业能力",
          body: "这是从完整知识快照组织出的首页核心能力说明。",
          sourceBindings: [
            {
              sourceDocumentId: "source-1",
              evidenceExcerpt: "这是已核验的企业介绍。",
            },
          ],
          mediaIds: [],
          entityIds: [],
          faqIds: [],
        },
      ],
    },
    {
      id: "applications",
      path: "/applications/",
      title: "应用场景",
      navigation: "primary",
      parentPath: null,
      detailOfPath: null,
      purpose: "回答解决方案如何落地",
      userQuestions: ["服务适合哪些场景？"],
      h1: "企业应用场景",
      summary: "把专业服务落到清晰、可执行的客户业务场景中。",
      cta: { label: "返回首页", targetPath: "/" },
      sections: [
        {
          id: "application-delivery",
          blockKind: "steps",
          heading: "落地路径",
          purpose: "解释交付步骤",
          body: "依据已核验资料梳理需求、方案与持续优化的交付路径。",
          sourceBindings: [
            {
              sourceDocumentId: "source-1",
              evidenceExcerpt: "这是已核验的企业介绍。",
            },
          ],
          mediaIds: [],
          entityIds: [],
          faqIds: [],
        },
      ],
    },
  ],
  navigation: [
    { label: "首页", targetPath: "/" },
    { label: "应用场景", targetPath: "/applications/" },
  ],
  coverage: [
    {
      sourceDocumentId: "source-1",
      status: "used",
      routeIds: ["home", "applications"],
      omissionReason: null,
    },
  ],
} satisfies SiteContentPlanV2;

function contentPlanSha256(plan: SiteContentPlanV2) {
  return sha256(Buffer.from(`${canonicalJson(plan)}\n`, "utf8"));
}

const KNOWLEDGE_MEDIA_ID = "knowledge-hero";
const KNOWLEDGE_MEDIA_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
const KNOWLEDGE_MEDIA_SHA256 = sha256(KNOWLEDGE_MEDIA_BYTES);
const KNOWLEDGE_MEDIA_PUBLIC_PATH =
  `/frontmind-knowledge-media/${KNOWLEDGE_MEDIA_SHA256}.png` as const;

function contentPlanWithKnowledgeMedia() {
  const plan = structuredClone(CONTENT_PLAN) as SiteContentPlanV2;
  plan.routes[0]!.sections[0]!.mediaIds = [KNOWLEDGE_MEDIA_ID];
  return plan;
}

function snapshotsForPlan(
  plan: SiteContentPlanV2,
): NativeContentPlanDomSnapshot[] {
  return plan.routes.map((route) => {
    const sectionText = route.sections
      .map((section) => `${section.heading} ${section.body}`)
      .join(" ");
    const navigationLinks = plan.navigation.map((navigation) => ({
      text: navigation.label,
      pathname: navigation.targetPath,
      protocol: "http:",
      sameOrigin: true,
      inGlobalNavigation: true,
    }));
    return {
      path: route.path,
      pageText: `${route.h1} ${route.summary} ${sectionText} ${route.cta?.label ?? ""}`,
      mainText: `${route.h1} ${route.summary} ${sectionText} ${route.cta?.label ?? ""}`,
      h1Texts: [route.h1],
      paragraphTexts: [
        route.summary,
        ...route.sections.map((item) => item.body),
      ],
      links: [
        ...navigationLinks,
        ...(route.cta?.targetPath
          ? [
              {
                text: route.cta.label,
                pathname: route.cta.targetPath,
                protocol: "http:",
                sameOrigin: true,
                inGlobalNavigation: false,
              },
            ]
          : []),
      ],
      sectionCandidates: route.sections.map((section) => ({
        id: section.id,
        text: `${section.heading} ${section.body}`,
      })),
    };
  });
}

const BASE_SOURCE_SHA256 = "b".repeat(64);
const OPERATION_TOKEN = "native-runtime-test-operation-token";
const FIXED_DATE = new Date("2000-01-01T00:00:00.000Z");
const browserIt =
  process.env.FRONTMIND_RUN_SITEOPS_BROWSER_INTEGRATION === "1" ? it : it.skip;
const currentRuntimeAudit = (input: {
  files: ReadonlyMap<string, Buffer>;
  expectedRoutePaths: readonly string[];
  requireCanonicalSitePathname?: boolean;
}) =>
  auditNativeRuntimeContractV1({
    ...input,
    contract: NATIVE_RUNTIME_CONTRACT_V1,
  });

function sha256(bytes: Buffer) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function validatedSource(overrides?: {
  main?: string;
  css?: string;
  additional?: Record<string, string | Buffer>;
  dependencies?: Record<string, string>;
}): Promise<ValidatedNativeReactSource> {
  const files = new Map<string, Buffer>([
    [
      "package.json",
      Buffer.from(
        JSON.stringify({
          type: "module",
          scripts: { build: "vite build --config vite.config.ts" },
          dependencies: {
            react: "19.2.1",
            "react-dom": "19.2.1",
            tailwindcss: "4.1.14",
            ...overrides?.dependencies,
          },
        }),
      ),
    ],
    [
      "index.html",
      Buffer.from(
        '<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body></html>',
      ),
    ],
    [
      "src/main.tsx",
      Buffer.from(
        overrides?.main ??
          `import React from "react";
import { createRoot } from "react-dom/client";
import "./style.css";
function App() { return <main className="hero"><h1>精美企业官网</h1><p>这是已核验的企业介绍。</p></main>; }
createRoot(document.getElementById("root")!).render(<App />);`,
      ),
    ],
    [
      "src/style.css",
      Buffer.from(
        overrides?.css ??
          "body{margin:0;font-family:system-ui;background:#fff;color:#111}.hero{min-height:100vh;display:grid;place-content:center}",
      ),
    ],
    [
      "vite.config.ts",
      Buffer.from(
        'throw new Error("PROVIDER_VITE_CONFIG_MUST_NEVER_EXECUTE");',
      ),
    ],
  ]);
  for (const [filename, content] of Object.entries(
    overrides?.additional ?? {},
  )) {
    files.set(filename, Buffer.from(content));
  }
  const archive = new JSZip();
  for (const [filename, bytes] of files) {
    archive.file(filename, bytes, {
      date: FIXED_DATE,
      createFolders: false,
      unixPermissions: 0o100644,
    });
  }
  const sourceZip = await archive.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 9 },
    platform: "UNIX",
  });
  return await validateNativeReactSourceArchive({
    archive: sourceZip,
    receipt: {
      operationToken: OPERATION_TOKEN,
      baseSourceSha256: BASE_SOURCE_SHA256,
      archiveSha256: sha256(sourceZip),
      fileCount: files.size,
    },
    expectedOperationToken: OPERATION_TOKEN,
    expectedBaseSourceSha256: BASE_SOURCE_SHA256,
  });
}

async function validatedRuntimeV2Source(routePaths: readonly string[]) {
  const files = new Map<string, Buffer>();
  for (const file of NATIVE_RUNTIME_EXECUTION_SHELL_V1.files) {
    files.set(file.path, Buffer.from(file.text, "utf8"));
  }
  files.set(
    NATIVE_RUNTIME_ROUTE_MODULE,
    Buffer.from(
      `import Home from "./home";\nimport Applications from "./applications";\nexport const ${NATIVE_RUNTIME_ROUTE_MANIFEST_EXPORT} = ${JSON.stringify(routePaths)} as const;\ntype PreviewWindow = Window & { canonicalSitePathname?: () => string };\nconst pathname = () => (window as PreviewWindow).canonicalSitePathname?.() ?? window.location.pathname;\nexport default function FrontMindRoutes() { return pathname() === "/applications/" ? <Applications /> : <Home />; }\n`,
    ),
  );
  files.set(
    "src/home.tsx",
    Buffer.from(
      "export default function Home() { return <main>Home</main>; }\n",
    ),
  );
  files.set(
    "src/applications.tsx",
    Buffer.from(
      "export default function Applications() { return <main>Applications</main>; }\n",
    ),
  );
  const archive = new JSZip();
  for (const [filename, bytes] of files) {
    archive.file(filename, bytes, {
      date: FIXED_DATE,
      createFolders: false,
      unixPermissions: 0o100644,
    });
  }
  const sourceZip = await archive.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 9 },
    platform: "UNIX",
  });
  return validateNativeReactSourceArchive({
    archive: sourceZip,
    receipt: {
      operationToken: OPERATION_TOKEN,
      baseSourceSha256: BASE_SOURCE_SHA256,
      archiveSha256: sha256(sourceZip),
      fileCount: files.size,
      preflightVersion: NATIVE_SOURCE_PREFLIGHT_V2_VERSION,
      preflightStatus: "passed",
      preflightSha256: NATIVE_SOURCE_PREFLIGHT_V2_SHA256,
      runtimeContractVersion: NATIVE_RUNTIME_CONTRACT_V1.contractVersion,
      runtimeContractSha256: NATIVE_RUNTIME_CONTRACT_V1_SHA256,
      executionShellSha256: NATIVE_RUNTIME_EXECUTION_SHELL_V1_SHA256,
      executionBaselineSha256: "c".repeat(64),
    },
    expectedOperationToken: OPERATION_TOKEN,
    expectedBaseSourceSha256: BASE_SOURCE_SHA256,
    expectedExecutionBaselineSha256: "c".repeat(64),
    requiredReceiptVersion: 2,
  });
}

describe("native React build runtime", () => {
  it("accepts a single-page dynamic information architecture and issues a private receipt", () => {
    const plan = structuredClone(CONTENT_PLAN) as SiteContentPlanV2;
    plan.routes = [
      {
        ...plan.routes[0]!,
        cta: { label: "联系咨询", targetPath: null },
      },
    ];
    plan.navigation = [{ label: "首页", targetPath: "/" }];
    plan.coverage = [
      {
        sourceDocumentId: "source-1",
        status: "used",
        routeIds: ["home"],
        omissionReason: null,
      },
    ];
    const snapshots = snapshotsForPlan(plan);

    expect(
      auditSiteContentPlanRenderedRoutes({
        plan,
        contentPlanSha256: contentPlanSha256(plan),
        snapshots,
      }),
    ).toMatchObject({
      schemaVersion: 1,
      routes: [
        {
          path: "/",
          sections: [
            {
              id: "home-capability",
              sourceDocumentIds: ["source-1"],
              mediaIds: [],
              renderedTextSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
            },
          ],
        },
      ],
    });
  });

  it("accepts distinct multi-page DOM snapshots with exact global navigation and CTA links", () => {
    const receipt = auditSiteContentPlanRenderedRoutes({
      plan: CONTENT_PLAN,
      contentPlanSha256: contentPlanSha256(CONTENT_PLAN),
      snapshots: snapshotsForPlan(CONTENT_PLAN),
    });

    expect(receipt.routes.map((route) => route.path)).toEqual([
      "/",
      "/applications/",
    ]);
    expect(receipt.routes.every((route) => route.sections.length === 1)).toBe(
      true,
    );
  });

  it("accepts a planned CTA label with harmless visual decoration", () => {
    const snapshots = snapshotsForPlan(CONTENT_PLAN);
    const cta = snapshots[0]!.links.find(
      (link) => !link.inGlobalNavigation && link.pathname === "/applications/",
    )!;
    cta.text = `${CONTENT_PLAN.routes[0]!.cta!.label} →`;

    expect(
      auditSiteContentPlanRenderedRoutes({
        plan: CONTENT_PLAN,
        contentPlanSha256: contentPlanSha256(CONTENT_PLAN),
        snapshots,
      }).routes,
    ).toHaveLength(CONTENT_PLAN.routes.length);

    cta.text = "不匹配的按钮文字 →";
    expect(() =>
      auditSiteContentPlanRenderedRoutes({
        plan: CONTENT_PLAN,
        contentPlanSha256: contentPlanSha256(CONTENT_PLAN),
        snapshots,
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "NATIVE_BUILD_CONTENT_PLAN_INVALID",
        diagnostics: [
          expect.objectContaining({
            code: "CONTENT_PLAN_CTA_TEXT_MISMATCH",
            file: "/",
          }),
        ],
      }),
    );
  });

  it("accepts a visible plan summary in a hero outside the main landmark", () => {
    const snapshots = snapshotsForPlan(CONTENT_PLAN);
    snapshots[0]!.mainText = snapshots[0]!.mainText.replace(
      CONTENT_PLAN.routes[0]!.summary,
      "",
    );

    expect(
      auditSiteContentPlanRenderedRoutes({
        plan: CONTENT_PLAN,
        contentPlanSha256: contentPlanSha256(CONTENT_PLAN),
        snapshots,
      }).routes,
    ).toHaveLength(CONTENT_PLAN.routes.length);
  });

  it("accepts complete planned section paragraphs split across cards and semantic inline boundaries", () => {
    const plan = structuredClone(CONTENT_PLAN) as SiteContentPlanV2;
    plan.routes[0]!.sections[0]!.body =
      "第一段完整正文。\n\n可以开始吗？可以按计划开始。";
    const snapshots = snapshotsForPlan(plan);
    snapshots[0]!.sectionCandidates[0]!.text =
      "核心能力 第一段完整正文。 卡片标签 可以开始吗？ 可以按计划开始。";

    expect(
      auditSiteContentPlanRenderedRoutes({
        plan,
        contentPlanSha256: contentPlanSha256(plan),
        snapshots,
      }).routes,
    ).toHaveLength(plan.routes.length);
  });

  it("does not erase meaningful ASCII word boundaries while matching section bodies", () => {
    const plan = structuredClone(CONTENT_PLAN) as SiteContentPlanV2;
    plan.routes[0]!.sections[0]!.body =
      "Deploy now here for the verified team.";
    const snapshots = snapshotsForPlan(plan);
    snapshots[0]!.sectionCandidates[0]!.text =
      "核心能力 Deploy nowhere for the verified team.";

    expect(() =>
      auditSiteContentPlanRenderedRoutes({
        plan,
        contentPlanSha256: contentPlanSha256(plan),
        snapshots,
      }),
    ).toThrowError(
      expect.objectContaining({ code: "NATIVE_BUILD_CONTENT_PLAN_INVALID" }),
    );
  });

  it.each([
    {
      name: "missing H1",
      code: "CONTENT_PLAN_H1_MISSING",
      mutate: (snapshots: NativeContentPlanDomSnapshot[]) => {
        snapshots[0]!.h1Texts = ["错误标题"];
      },
    },
    {
      name: "missing visible summary",
      code: "CONTENT_PLAN_SUMMARY_MISSING",
      mutate: (snapshots: NativeContentPlanDomSnapshot[]) => {
        snapshots[0]!.pageText = snapshots[0]!.pageText.replace(
          CONTENT_PLAN.routes[0]!.summary,
          "",
        );
      },
    },
    {
      name: "missing section body",
      code: "CONTENT_PLAN_SECTION_BODY_MISSING",
      mutate: (snapshots: NativeContentPlanDomSnapshot[]) => {
        snapshots[0]!.sectionCandidates[0]!.text = "核心能力";
      },
    },
    {
      name: "dangling internal link",
      code: "CONTENT_PLAN_INTERNAL_LINK_OUTSIDE_MANIFEST",
      mutate: (snapshots: NativeContentPlanDomSnapshot[]) => {
        snapshots[0]!.links.push({
          text: "不存在的页面",
          pathname: "/missing/",
          protocol: "http:",
          sameOrigin: true,
          inGlobalNavigation: false,
        });
      },
    },
    {
      name: "external HTTP demo link",
      code: "CONTENT_PLAN_EXTERNAL_HTTP_LINK_FORBIDDEN",
      mutate: (snapshots: NativeContentPlanDomSnapshot[]) => {
        snapshots[0]!.links.push({
          text: "演示链接",
          pathname: "/demo/",
          protocol: "https:",
          sameOrigin: false,
          inGlobalNavigation: false,
        });
      },
    },
    {
      name: "missing global navigation",
      code: "CONTENT_PLAN_NAVIGATION_MISSING",
      mutate: (snapshots: NativeContentPlanDomSnapshot[]) => {
        snapshots[0]!.links = snapshots[0]!.links.filter(
          (link) =>
            !(link.inGlobalNavigation && link.pathname === "/applications/"),
        );
      },
    },
  ])("rejects $name", ({ code, mutate }) => {
    const snapshots = snapshotsForPlan(CONTENT_PLAN);
    mutate(snapshots);
    try {
      auditSiteContentPlanRenderedRoutes({
        plan: CONTENT_PLAN,
        contentPlanSha256: contentPlanSha256(CONTENT_PLAN),
        snapshots,
      });
      throw new Error("EXPECTED_CONTENT_PLAN_AUDIT_FAILURE");
    } catch (error) {
      expect(error).toMatchObject<Partial<NativeReactBuildError>>({
        code: "NATIVE_BUILD_CONTENT_PLAN_INVALID",
        diagnostics: [expect.objectContaining({ code })],
      });
    }
  });

  it("returns all distinct content-plan DOM diagnostics in one repair payload", () => {
    const snapshots = snapshotsForPlan(CONTENT_PLAN);
    snapshots[0]!.h1Texts = ["错误标题"];
    snapshots[0]!.pageText = snapshots[0]!.pageText.replace(
      CONTENT_PLAN.routes[0]!.summary,
      "",
    );
    snapshots[0]!.links = [];

    try {
      auditSiteContentPlanRenderedRoutes({
        plan: CONTENT_PLAN,
        contentPlanSha256: contentPlanSha256(CONTENT_PLAN),
        snapshots,
      });
      throw new Error("EXPECTED_AGGREGATED_CONTENT_PLAN_FAILURE");
    } catch (error) {
      expect(error).toBeInstanceOf(NativeReactBuildError);
      const codes = new Set(
        (error as NativeReactBuildError).diagnostics.map((item) => item.code),
      );
      expect(codes).toEqual(
        new Set([
          "CONTENT_PLAN_H1_MISSING",
          "CONTENT_PLAN_SUMMARY_MISSING",
          "CONTENT_PLAN_NAVIGATION_MISSING",
          "CONTENT_PLAN_CTA_MISSING",
        ]),
      );
    }
  });

  it("preserves every diagnostic category when a large manifest exceeds the repair cap", () => {
    const plan = structuredClone(CONTENT_PLAN) as SiteContentPlanV2;
    plan.routes = Array.from({ length: 30 }, (_, index) => {
      const path = index === 0 ? "/" : `/route-${index}/`;
      return {
        ...structuredClone(CONTENT_PLAN.routes[0]!),
        id: `route-${index}`,
        path,
        title: `Route ${index}`,
        h1: `Route ${index} H1`,
        summary: `Route ${index} unique summary`,
        cta: { label: `Route ${index} CTA`, targetPath: "/" },
        sections: [
          {
            ...structuredClone(CONTENT_PLAN.routes[0]!.sections[0]!),
            id: `section-${index}`,
            heading: `Route ${index} section`,
            body: `Route ${index} unique verified body`,
          },
        ],
      };
    });
    plan.navigation = [{ label: "首页", targetPath: "/" }];
    plan.coverage = [
      {
        sourceDocumentId: "source-1",
        status: "used",
        routeIds: plan.routes.map((route) => route.id),
        omissionReason: null,
      },
    ];
    const snapshots = snapshotsForPlan(plan);
    for (const [index, snapshot] of snapshots.entries()) {
      const route = plan.routes[index]!;
      snapshot.h1Texts = ["Wrong H1"];
      snapshot.pageText = snapshot.pageText.replace(route.summary, "");
      snapshot.links = [];
      snapshot.sectionCandidates = [];
    }

    try {
      auditSiteContentPlanRenderedRoutes({
        plan,
        contentPlanSha256: contentPlanSha256(plan),
        snapshots,
      });
      throw new Error("EXPECTED_CAPPED_CONTENT_PLAN_FAILURE");
    } catch (error) {
      expect(error).toBeInstanceOf(NativeReactBuildError);
      const diagnostics = (error as NativeReactBuildError).diagnostics;
      expect(diagnostics).toHaveLength(32);
      expect(new Set(diagnostics.map((item) => item.code))).toEqual(
        new Set([
          "CONTENT_PLAN_CTA_MISSING",
          "CONTENT_PLAN_H1_MISSING",
          "CONTENT_PLAN_NAVIGATION_MISSING",
          "CONTENT_PLAN_SECTION_BODY_MISSING",
          "CONTENT_PLAN_SUMMARY_MISSING",
        ]),
      );
      expect(diagnostics).toContainEqual(
        expect.objectContaining({
          code: "CONTENT_PLAN_SECTION_BODY_MISSING",
          file: expect.stringContaining("#section-"),
        }),
      );
    }
  });

  it("keeps distinct section coordinates and rejects planned paragraphs rendered out of order", () => {
    const plan = structuredClone(CONTENT_PLAN) as SiteContentPlanV2;
    plan.routes[0]!.sections = [
      {
        ...plan.routes[0]!.sections[0]!,
        id: "first-section",
        body: "第一段正文。\n\n第二段正文。",
      },
      {
        ...plan.routes[0]!.sections[0]!,
        id: "second-section",
        heading: "第二个区块",
        body: "另一个完整区块正文。",
      },
    ];
    const snapshots = snapshotsForPlan(plan);
    snapshots[0]!.sectionCandidates = [
      {
        id: "first-section",
        text: "核心能力 第二段正文。 第一段正文。",
      },
    ];

    try {
      auditSiteContentPlanRenderedRoutes({
        plan,
        contentPlanSha256: contentPlanSha256(plan),
        snapshots,
      });
      throw new Error("EXPECTED_SECTION_COORDINATE_FAILURE");
    } catch (error) {
      const sectionDiagnostics = (
        error as NativeReactBuildError
      ).diagnostics.filter((item) =>
        item.code.startsWith("CONTENT_PLAN_SECTION_"),
      );
      expect(sectionDiagnostics.map((item) => item.file)).toEqual([
        "/#first-section",
        "/#second-section",
      ]);
    }
  });

  it("rejects two routes that render the same main page body", () => {
    const plan = structuredClone(CONTENT_PLAN) as SiteContentPlanV2;
    plan.routes[1] = {
      ...plan.routes[0]!,
      id: "applications",
      path: "/applications/",
      title: "应用场景",
    };
    const snapshots = snapshotsForPlan(plan);
    try {
      auditSiteContentPlanRenderedRoutes({
        plan,
        contentPlanSha256: contentPlanSha256(plan),
        snapshots,
      });
      throw new Error("EXPECTED_DUPLICATE_ROUTE_FAILURE");
    } catch (error) {
      expect(error).toMatchObject<Partial<NativeReactBuildError>>({
        code: "NATIVE_BUILD_CONTENT_PLAN_INVALID",
        diagnostics: [
          expect.objectContaining({
            code: "CONTENT_PLAN_DUPLICATE_ROUTE_BODY",
          }),
        ],
      });
    }
  });

  it.each([
    {
      name: "missing frozen knowledge-media coordinate",
      requiredKnowledgeMedia: [],
    },
    {
      name: "different asset ID",
      requiredKnowledgeMedia: [
        {
          assetId: "other-knowledge-media",
          publicPath: KNOWLEDGE_MEDIA_PUBLIC_PATH,
          contentSha256: KNOWLEDGE_MEDIA_SHA256,
          routePaths: ["/"],
        },
      ],
    },
    {
      name: "different planned route binding",
      requiredKnowledgeMedia: [
        {
          assetId: KNOWLEDGE_MEDIA_ID,
          publicPath: KNOWLEDGE_MEDIA_PUBLIC_PATH,
          contentSha256: KNOWLEDGE_MEDIA_SHA256,
          routePaths: ["/applications/"],
        },
      ],
    },
  ])("rejects a plan media declaration with $name", async (fixture) => {
    const source = await validatedSource();
    const plan = contentPlanWithKnowledgeMedia();

    await expect(
      materializeNativeReactSource({
        sourceZip: source.sourceZip,
        validatedSource: source,
        build: BUILD_2_9,
        brief: BRIEF,
        mode: "preview",
        browserQa: false,
        contentPlan: plan,
        contentPlanSha256: contentPlanSha256(plan),
        requiredKnowledgeMedia: fixture.requiredKnowledgeMedia,
      }),
    ).rejects.toMatchObject<Partial<NativeReactBuildError>>({
      code: "NATIVE_BUILD_CONTENT_PLAN_INVALID",
      diagnostics: [
        expect.objectContaining({
          code: "CONTENT_PLAN_MEDIA_COORDINATES_MISMATCH",
        }),
      ],
    });
  });

  it("keeps customer revision media out of knowledge-media coordinate validation", async () => {
    const customerMediaBytes = KNOWLEDGE_MEDIA_BYTES;
    const customerMediaSha256 = sha256(customerMediaBytes);
    const publicPath =
      `/frontmind-user-media/${customerMediaSha256}.png` as const;
    const customerMediaId = `customer-media:${createHash("sha256")
      .update(publicPath, "utf8")
      .digest("hex")
      .slice(0, 32)}`;
    const plan = structuredClone(CONTENT_PLAN) as SiteContentPlanV2;
    plan.routes[0]!.sections[0]!.mediaIds = [customerMediaId];
    const source = await validatedSource({
      additional: { [`public${publicPath}`]: customerMediaBytes },
    });

    await expect(
      materializeNativeReactSource({
        sourceZip: source.sourceZip,
        validatedSource: source,
        build: BUILD_2_9,
        brief: BRIEF,
        mode: "preview",
        browserQa: false,
        contentPlan: plan,
        contentPlanSha256: contentPlanSha256(plan),
        requiredUserMedia: [{ publicPath, contentSha256: customerMediaSha256 }],
        requiredKnowledgeMedia: [],
      }),
    ).rejects.toMatchObject<Partial<NativeReactBuildError>>({
      code: "NATIVE_BUILD_USER_MEDIA_INVALID",
      diagnostics: [
        expect.objectContaining({
          code: "USER_MEDIA_BROWSER_AUDIT_REQUIRED",
        }),
      ],
    });
  });

  it("admits two full eight-image revision rounds into cumulative runtime validation", async () => {
    const cumulativeMedia = Array.from({ length: 16 }, (_, index) => {
      const bytes = Buffer.concat([
        KNOWLEDGE_MEDIA_BYTES,
        Buffer.from([index + 1]),
      ]);
      const contentSha256 = sha256(bytes);
      return {
        bytes,
        contentSha256,
        publicPath: `/frontmind-user-media/${contentSha256}.png` as const,
      };
    });
    const source = await validatedSource({
      additional: Object.fromEntries(
        cumulativeMedia.map((asset) => [
          `public${asset.publicPath}`,
          asset.bytes,
        ]),
      ),
    });

    await expect(
      materializeNativeReactSource({
        sourceZip: source.sourceZip,
        validatedSource: source,
        build: BUILD_2_9,
        brief: BRIEF,
        mode: "preview",
        browserQa: false,
        contentPlan: CONTENT_PLAN,
        contentPlanSha256: contentPlanSha256(CONTENT_PLAN),
        requiredUserMedia: cumulativeMedia.map(
          ({ publicPath, contentSha256 }) => ({
            publicPath,
            contentSha256,
          }),
        ),
      }),
    ).rejects.toMatchObject<Partial<NativeReactBuildError>>({
      code: "NATIVE_BUILD_USER_MEDIA_INVALID",
      diagnostics: [
        expect.objectContaining({
          code: "USER_MEDIA_BROWSER_AUDIT_REQUIRED",
        }),
      ],
    });
  }, 30_000);

  browserIt(
    "audits more than one message worth of cumulative user media in preview and production",
    async () => {
      const cumulativeMedia = Array.from({ length: 10 }, (_, index) => {
        const bytes = Buffer.concat([
          KNOWLEDGE_MEDIA_BYTES,
          Buffer.from([index + 1]),
        ]);
        const contentSha256 = sha256(bytes);
        return {
          bytes,
          contentSha256,
          publicPath: `/frontmind-user-media/${contentSha256}.png` as const,
        };
      });
      const plan = structuredClone(CONTENT_PLAN) as SiteContentPlanV2;
      plan.routes = [
        {
          ...plan.routes[0]!,
          cta: { label: "返回首页", targetPath: "/" },
        },
      ];
      plan.navigation = [{ label: "首页", targetPath: "/" }];
      plan.coverage = [
        {
          sourceDocumentId: "source-1",
          status: "used",
          routeIds: ["home"],
          omissionReason: null,
        },
      ];
      const imageMarkup = cumulativeMedia
        .map(
          (asset, index) =>
            `<img src="${asset.publicPath}" alt="累计修订图片 ${index + 1}" />`,
        )
        .join("");
      const source = await validatedSource({
        additional: Object.fromEntries(
          cumulativeMedia.map((asset) => [
            `public${asset.publicPath}`,
            asset.bytes,
          ]),
        ),
        main: `import React from "react";
import { createRoot } from "react-dom/client";
function App() { return <><header><nav><a href="/">首页</a></nav></header><main><h1>可信赖的企业服务</h1><p>围绕客户真实业务问题提供可核验的专业服务。</p><section data-siteops-section-id="home-capability"><h2>核心能力</h2><p>这是从完整知识快照组织出的首页核心能力说明。</p>${imageMarkup}</section><a href="/">返回首页</a></main></>; }
createRoot(document.getElementById("root")!).render(<App />);`,
      });
      const requiredUserMedia = cumulativeMedia.map(
        ({ publicPath, contentSha256 }) => ({
          publicPath,
          contentSha256,
        }),
      );
      const brief = { ...BRIEF, routes: [BRIEF.routes[0]!] };
      const common = {
        sourceZip: source.sourceZip,
        validatedSource: source,
        build: BUILD_2_9,
        brief,
        contentPlan: plan,
        contentPlanSha256: contentPlanSha256(plan),
        requiredUserMedia,
        lighthouseQa: false,
      } as const;

      const preview = await materializeNativeReactSource({
        ...common,
        mode: "preview",
      });
      const production = await rebuildNativeReactProductionFromSource({
        ...common,
        canonicalOrigin: "https://www.example.test",
        target: "global_excluding_cn",
      });

      for (const result of [preview, production]) {
        expect(
          (JSON.parse(result.qaJson.toString("utf8")) as { checks: unknown[] })
            .checks,
        ).toContainEqual(
          expect.objectContaining({ id: "user-media:dist-and-dom" }),
        );
        for (const asset of cumulativeMedia) {
          expect(
            result.files.get(asset.publicPath.slice(1))?.equals(asset.bytes),
          ).toBe(true);
        }
      }

      const missingAltMarkup = cumulativeMedia
        .map(
          (asset, index) =>
            `<img src="${asset.publicPath}" alt="${index === cumulativeMedia.length - 1 ? "" : `累计修订图片 ${index + 1}`}" />`,
        )
        .join("");
      const missingAltSource = await validatedSource({
        additional: Object.fromEntries(
          cumulativeMedia.map((asset) => [
            `public${asset.publicPath}`,
            asset.bytes,
          ]),
        ),
        main: `import React from "react";
import { createRoot } from "react-dom/client";
function App() { return <><header><nav><a href="/">首页</a></nav></header><main><h1>可信赖的企业服务</h1><p>围绕客户真实业务问题提供可核验的专业服务。</p><section data-siteops-section-id="home-capability"><h2>核心能力</h2><p>这是从完整知识快照组织出的首页核心能力说明。</p>${missingAltMarkup}</section><a href="/">返回首页</a></main></>; }
createRoot(document.getElementById("root")!).render(<App />);`,
      });
      await expect(
        materializeNativeReactSource({
          ...common,
          sourceZip: missingAltSource.sourceZip,
          validatedSource: missingAltSource,
          mode: "preview",
        }),
      ).rejects.toMatchObject<Partial<NativeReactBuildError>>({
        code: "NATIVE_BUILD_USER_MEDIA_INVALID",
        diagnostics: [
          expect.objectContaining({
            code: "USER_MEDIA_IMG_ALT_REQUIRED",
            file: cumulativeMedia.at(-1)!.publicPath,
          }),
        ],
      });

      const mismatchedPlan = structuredClone(plan) as SiteContentPlanV2;
      mismatchedPlan.routes[0]!.h1 = "不会出现在页面中的计划标题";
      await expect(
        materializeNativeReactSource({
          ...common,
          sourceZip: missingAltSource.sourceZip,
          validatedSource: missingAltSource,
          mode: "preview",
          contentPlan: mismatchedPlan,
          contentPlanSha256: contentPlanSha256(mismatchedPlan),
        }),
      ).rejects.toMatchObject<Partial<NativeReactBuildError>>({
        code: "NATIVE_BUILD_USER_MEDIA_INVALID",
        diagnostics: [
          expect.objectContaining({
            code: "USER_MEDIA_IMG_ALT_REQUIRED",
            file: cumulativeMedia.at(-1)!.publicPath,
          }),
        ],
      });
    },
    45_000,
  );

  it("rejects frozen knowledge-media output whose compiled bytes do not match", async () => {
    const plan = contentPlanWithKnowledgeMedia();
    const source = await validatedSource({
      additional: {
        [`public${KNOWLEDGE_MEDIA_PUBLIC_PATH}`]: Buffer.concat([
          KNOWLEDGE_MEDIA_BYTES,
          Buffer.from([0]),
        ]),
      },
    });

    await expect(
      materializeNativeReactSource({
        sourceZip: source.sourceZip,
        validatedSource: source,
        build: BUILD_2_9,
        brief: BRIEF,
        mode: "preview",
        browserQa: false,
        contentPlan: plan,
        contentPlanSha256: contentPlanSha256(plan),
        requiredKnowledgeMedia: [
          {
            assetId: KNOWLEDGE_MEDIA_ID,
            publicPath: KNOWLEDGE_MEDIA_PUBLIC_PATH,
            contentSha256: KNOWLEDGE_MEDIA_SHA256,
            routePaths: ["/"],
          },
        ],
      }),
    ).rejects.toMatchObject<Partial<NativeReactBuildError>>({
      code: "NATIVE_BUILD_CONTENT_PLAN_INVALID",
      diagnostics: [
        expect.objectContaining({
          code: "CONTENT_PLAN_MEDIA_DIST_FILE_MISSING_OR_CHANGED",
          file: KNOWLEDGE_MEDIA_PUBLIC_PATH,
        }),
      ],
    });
  }, 30_000);

  it("requires the frozen plan but does not block compilation when browser content audit is skipped", async () => {
    const source = await validatedSource();
    await expect(
      materializeNativeReactSource({
        sourceZip: source.sourceZip,
        validatedSource: source,
        build: BUILD_2_9,
        brief: BRIEF,
        mode: "preview",
        browserQa: false,
      }),
    ).rejects.toMatchObject<Partial<NativeReactBuildError>>({
      code: "NATIVE_BUILD_CONTENT_PLAN_INVALID",
      diagnostics: [expect.objectContaining({ code: "CONTENT_PLAN_REQUIRED" })],
    });

    const result = await materializeNativeReactSource({
      sourceZip: source.sourceZip,
      validatedSource: source,
      build: BUILD_2_9,
      brief: BRIEF,
      mode: "preview",
      browserQa: false,
      contentPlan: CONTENT_PLAN,
      contentPlanSha256: contentPlanSha256(CONTENT_PLAN),
    });
    expect(result.contract.contentReceipt?.routes).toHaveLength(
      CONTENT_PLAN.routes.length,
    );
    expect(result.buildDelivery).toMatchObject({
      qaStatus: "passed_with_warnings",
      warningCodes: expect.arrayContaining(["NATIVE_BROWSER_QA_SKIPPED"]),
    });
  }, 30_000);

  browserIt(
    "audits every planned route and recognizes semantic hero sections outside main",
    async () => {
      const source = await validatedSource({
        main: `import React from "react";
import { createRoot } from "react-dom/client";
import "./style.css";
const pages = {
  "/": { h1: "可信赖的企业服务", summary: "围绕客户真实业务问题提供可核验的专业服务。", sectionId: "home-capability", heading: "核心能力", body: "这是从完整知识快照组织出的首页核心能力说明。", cta: "查看应用场景", target: "/applications/" },
  "/applications/": { h1: "企业应用场景", summary: "把专业服务落到清晰、可执行的客户业务场景中。", sectionId: "application-delivery", heading: "落地路径", body: "依据已核验资料梳理需求、方案与持续优化的交付路径。", cta: "返回首页", target: "/" },
} as const;
type PreviewWindow = Window & { canonicalSitePathname?: () => string };
const pathname = () => (window as PreviewWindow).canonicalSitePathname?.() ?? window.location.pathname;
function App() { const page = pages[pathname() as keyof typeof pages] ?? pages["/"]; return <><header><nav><a href="/">首页</a><a href="/applications/">应用场景</a></nav></header><section data-section-id={page.sectionId}><h2>{page.heading}</h2><p>{page.body}</p></section><main><h1>{page.h1}</h1><p>{page.summary}</p><a href={page.target}>{page.cta}</a></main></>; }
createRoot(document.getElementById("root")!).render(<App />);`,
      });
      const result = await materializeNativeReactSource({
        sourceZip: source.sourceZip,
        validatedSource: source,
        build: BUILD_2_9,
        brief: BRIEF,
        mode: "preview",
        lighthouseQa: false,
        contentPlan: CONTENT_PLAN,
        contentPlanSha256: contentPlanSha256(CONTENT_PLAN),
      });

      expect(result.contentReceiptJson).not.toBeNull();
      expect(result.contract).toMatchObject({
        contentPlanSha256: contentPlanSha256(CONTENT_PLAN),
        contentReceiptSha256: result.contentReceiptSha256,
        contentReceipt: { routes: [{ path: "/" }, { path: "/applications/" }] },
      });
      expect(JSON.parse(result.provenanceJson.toString("utf8"))).toMatchObject({
        contentPlanSha256: contentPlanSha256(CONTENT_PLAN),
        contentReceiptSha256: result.contentReceiptSha256,
      });
    },
    30_000,
  );

  browserIt(
    "reports a multi-page content mismatch without blocking compiled output",
    async () => {
      const source = await validatedSource({
        main: `import React from "react";
import { createRoot } from "react-dom/client";
const pages = {
  "/": { h1: "可信赖的企业服务", summary: "围绕客户真实业务问题提供可核验的专业服务。", sectionId: "home-capability", heading: "核心能力", body: "这是从完整知识快照组织出的首页核心能力说明。", cta: "查看应用场景", target: "/applications/" },
  "/applications/": { h1: "企业应用场景", summary: "把专业服务落到清晰、可执行的客户业务场景中。", sectionId: "application-delivery", heading: "落地路径", body: "依据已核验资料梳理需求、方案与持续优化的交付路径。", cta: "返回首页", target: "/" },
} as const;
function App() { const page = pages[window.location.pathname as keyof typeof pages] ?? pages["/"]; return <><nav><a href="/">首页</a><a href="/applications/">应用场景</a></nav><main><h1>{page.h1}</h1><p>{page.summary}</p><section data-siteops-section-id={page.sectionId}><h2>{page.heading}</h2><p>{page.body}</p></section><a href={page.target}>{page.cta}</a></main></>; }
createRoot(document.getElementById("root")!).render(<App />);`,
      });

      const result = await materializeNativeReactSource({
        sourceZip: source.sourceZip,
        validatedSource: source,
        build: BUILD_2_9,
        brief: BRIEF,
        mode: "preview",
        lighthouseQa: false,
        contentPlan: CONTENT_PLAN,
        contentPlanSha256: contentPlanSha256(CONTENT_PLAN),
      });
      expect(result.buildDelivery).toMatchObject({
        qaStatus: "passed_with_warnings",
        warningCodes: expect.arrayContaining(["NATIVE_CONTENT_PLAN_WARNING"]),
      });
    },
    30_000,
  );

  browserIt(
    "reports a summary found only in shared footer chrome without blocking compilation",
    async () => {
      const plan = structuredClone(CONTENT_PLAN) as SiteContentPlanV2;
      plan.routes = [
        {
          ...plan.routes[0]!,
          cta: { label: "返回首页", targetPath: "/" },
        },
      ];
      plan.navigation = [{ label: "首页", targetPath: "/" }];
      plan.coverage = [
        {
          sourceDocumentId: "source-1",
          status: "used",
          routeIds: ["home"],
          omissionReason: null,
        },
      ];
      const source = await validatedSource({
        main: `import React from "react";
import { createRoot } from "react-dom/client";
function App() { return <><nav><a href="/">首页</a></nav><main><h1>可信赖的企业服务</h1><section data-siteops-section-id="home-capability"><h2>核心能力</h2><p>这是从完整知识快照组织出的首页核心能力说明。</p></section><a href="/">返回首页</a></main><footer><p>围绕客户真实业务问题提供可核验的专业服务。</p></footer></>; }
createRoot(document.getElementById("root")!).render(<App />);`,
      });

      const result = await materializeNativeReactSource({
        sourceZip: source.sourceZip,
        validatedSource: source,
        build: BUILD_2_9,
        brief: { ...BRIEF, routes: [BRIEF.routes[0]!] },
        mode: "preview",
        lighthouseQa: false,
        contentPlan: plan,
        contentPlanSha256: contentPlanSha256(plan),
      });
      expect(result.buildDelivery).toMatchObject({
        qaStatus: "passed_with_warnings",
        warningCodes: expect.arrayContaining(["NATIVE_CONTENT_PLAN_WARNING"]),
      });
    },
    30_000,
  );

  browserIt(
    "preserves exact knowledge-media bytes and requires a non-empty img alt on every planned route binding",
    async () => {
      const plan = contentPlanWithKnowledgeMedia();
      const source = await validatedSource({
        additional: {
          [`public${KNOWLEDGE_MEDIA_PUBLIC_PATH}`]: KNOWLEDGE_MEDIA_BYTES,
        },
        main: `import React from "react";
import { createRoot } from "react-dom/client";
import "./style.css";
const pages = {
  "/": { h1: "可信赖的企业服务", summary: "围绕客户真实业务问题提供可核验的专业服务。", sectionId: "home-capability", heading: "核心能力", body: "这是从完整知识快照组织出的首页核心能力说明。", cta: "查看应用场景", target: "/applications/", media: true },
  "/applications/": { h1: "企业应用场景", summary: "把专业服务落到清晰、可执行的客户业务场景中。", sectionId: "application-delivery", heading: "落地路径", body: "依据已核验资料梳理需求、方案与持续优化的交付路径。", cta: "返回首页", target: "/", media: false },
} as const;
type PreviewWindow = Window & { canonicalSitePathname?: () => string };
const pathname = () => (window as PreviewWindow).canonicalSitePathname?.() ?? window.location.pathname;
function App() { const page = pages[pathname() as keyof typeof pages] ?? pages["/"]; return <><header><nav><a href="/">首页</a><a href="/applications/">应用场景</a></nav></header><main><h1>{page.h1}</h1><p>{page.summary}</p><section data-siteops-section-id={page.sectionId}><h2>{page.heading}</h2><p>{page.body}</p>{page.media ? <img src="${KNOWLEDGE_MEDIA_PUBLIC_PATH}" alt="企业知识库中的核心能力图" /> : null}</section><a href={page.target}>{page.cta}</a></main></>; }
createRoot(document.getElementById("root")!).render(<App />);`,
      });
      const result = await materializeNativeReactSource({
        sourceZip: source.sourceZip,
        validatedSource: source,
        build: BUILD_2_9,
        brief: BRIEF,
        mode: "preview",
        lighthouseQa: false,
        contentPlan: plan,
        contentPlanSha256: contentPlanSha256(plan),
        requiredKnowledgeMedia: [
          {
            assetId: KNOWLEDGE_MEDIA_ID,
            publicPath: KNOWLEDGE_MEDIA_PUBLIC_PATH,
            contentSha256: KNOWLEDGE_MEDIA_SHA256,
            routePaths: ["/"],
          },
        ],
      });

      expect(
        result.files
          .get(KNOWLEDGE_MEDIA_PUBLIC_PATH.slice(1))
          ?.equals(KNOWLEDGE_MEDIA_BYTES),
      ).toBe(true);
      expect(
        result.contract.contentReceipt?.routes[0]?.sections[0],
      ).toMatchObject({
        id: "home-capability",
        mediaIds: [KNOWLEDGE_MEDIA_ID],
      });
      expect(
        (JSON.parse(result.qaJson.toString("utf8")) as { checks: unknown[] })
          .checks,
      ).toContainEqual(
        expect.objectContaining({ id: "knowledge-media:dist" }),
      );
    },
    30_000,
  );

  it("builds the exact validated source and materializes every frozen route", async () => {
    const source = await validatedSource();
    const result = await materializeNativeReactSource({
      sourceZip: source.sourceZip,
      validatedSource: source,
      build: BUILD,
      brief: BRIEF,
      mode: "preview",
      browserQa: false,
    });

    expect(result.sourceZip.equals(source.sourceZip)).toBe(true);
    expect(result.sourceSha256).toBe(source.sourceSha256);
    expect(result.buildDelivery).toEqual({
      renderMode: "twenty_first_native",
      qaStatus: "passed_with_warnings",
      warningCodes: ["NATIVE_BROWSER_QA_SKIPPED"],
    });
    expect(result.files.has("index.html")).toBe(true);
    expect(result.files.has("applications/index.html")).toBe(true);
    expect(result.files.has("404.html")).toBe(true);
    expect(result.files.get("index.html")?.toString("utf8")).toContain(
      'name="robots" content="noindex,nofollow"',
    );
    expect(
      [...result.files.keys()].some((name) =>
        /^assets\/app-.+\.js$/u.test(name),
      ),
    ).toBe(true);
    expect(result.provenanceJson.toString("utf8")).toContain(
      '"providerViteConfigExecuted":false',
    );
    expect(result.provenanceJson.toString("utf8")).toContain(
      '"providerPackageScriptsExecuted":false',
    );
  }, 30_000);

  it("removes compiled HTML that is outside the frozen route manifest", async () => {
    const source = await validatedSource({
      additional: {
        "public/extra/index.html": "<!doctype html><h1>Unplanned page</h1>",
      },
    });
    const result = await materializeNativeReactSource({
      sourceZip: source.sourceZip,
      validatedSource: source,
      build: BUILD,
      brief: BRIEF,
      mode: "preview",
      browserQa: false,
    });

    expect(result.files.has("extra/index.html")).toBe(false);
    expect(result.files.has("index.html")).toBe(true);
    expect(result.files.has("applications/index.html")).toBe(true);
    expect(result.files.has("404.html")).toBe(true);
  }, 30_000);

  it("binds v2 literal routes to canonical SiteBrief paths before compilation", async () => {
    const matching = await validatedRuntimeV2Source(["/", "/applications/"]);
    const runtimeAudit = vi.fn(currentRuntimeAudit);
    await expect(
      materializeNativeReactSource({
        sourceZip: matching.sourceZip,
        validatedSource: matching,
        build: BUILD,
        brief: {
          ...BRIEF,
          routes: BRIEF.routes.map((route) =>
            route.id === "applications"
              ? { ...route, slug: "/applications" }
              : route,
          ),
        },
        mode: "preview",
        browserQa: false,
        runtimeAudit,
      }),
    ).resolves.toMatchObject({
      contract: { routes: ["/", "/applications/"] },
    });
    expect(runtimeAudit).toHaveBeenCalledWith({
      files: matching.files,
      expectedRoutePaths: ["/", "/applications"],
      requireCanonicalSitePathname: false,
    });

    const mismatched = await validatedRuntimeV2Source(["/", "/contact/"]);
    await expect(
      materializeNativeReactSource({
        sourceZip: mismatched.sourceZip,
        validatedSource: mismatched,
        build: BUILD,
        brief: BRIEF,
        mode: "preview",
        browserQa: false,
        runtimeAudit: currentRuntimeAudit,
      }),
    ).rejects.toMatchObject<Partial<NativeReactBuildError>>({
      code: "NATIVE_BUILD_INPUT_INVALID",
      diagnostics: [
        expect.objectContaining({
          code: "ROUTE_MANIFEST_MISMATCH",
          file: NATIVE_RUNTIME_ROUTE_MODULE,
        }),
      ],
    });
  }, 30_000);

  it("fails closed when a v2 source has no frozen runtime auditor", async () => {
    const source = await validatedRuntimeV2Source(["/", "/applications/"]);
    await expect(
      materializeNativeReactSource({
        sourceZip: source.sourceZip,
        validatedSource: source,
        build: BUILD,
        brief: BRIEF,
        mode: "preview",
        browserQa: false,
      }),
    ).rejects.toMatchObject<Partial<NativeReactBuildError>>({
      code: "NATIVE_BUILD_RUNTIME_AUDIT_UNAVAILABLE",
    });
  });

  it("compiles a common Tailwind v4 source through the trusted host plugin", async () => {
    const source = await validatedSource({
      main: `import React from "react";
import { createRoot } from "react-dom/client";
import "./style.css";
createRoot(document.getElementById("root")!).render(<main className="flex min-h-screen items-center justify-center"><h1>原生 Tailwind 页面</h1></main>);`,
      css: '@import "tailwindcss";',
    });
    let result;
    try {
      result = await materializeNativeReactSource({
        sourceZip: source.sourceZip,
        validatedSource: source,
        build: BUILD,
        brief: BRIEF,
        mode: "preview",
        browserQa: false,
      });
    } catch (error) {
      // Kept assertion-safe: diagnostics contain only code/path/coordinates.
      throw new Error(
        `TAILWIND_BUILD_FAILED:${JSON.stringify((error as NativeReactBuildError).diagnostics)}`,
      );
    }
    const css = [...result.files.entries()]
      .filter(([name]) => name.endsWith(".css"))
      .map(([, bytes]) => bytes.toString("utf8"))
      .join("\n");
    expect(css).toMatch(/display:flex/u);
    expect(css).toMatch(/min-height:100vh/u);
  }, 30_000);

  it("links installed packages whose exports hide package.json", async () => {
    const source = await validatedSource({
      dependencies: {
        "@radix-ui/react-slot": "1.2.3",
        clsx: "2.1.1",
      },
      main: `import React from "react";
import { createRoot } from "react-dom/client";
import { Slot } from "@radix-ui/react-slot";
import clsx from "clsx";
function App() { return <Slot><main className={clsx("hero", true && "ready")}>原生组件官网</main></Slot>; }
createRoot(document.getElementById("root")!).render(<App />);`,
    });
    const result = await materializeNativeReactSource({
      sourceZip: source.sourceZip,
      validatedSource: source,
      build: BUILD,
      brief: BRIEF,
      mode: "preview",
      browserQa: false,
    });
    expect(result.files.get("index.html")?.toString("utf8")).toContain(
      "noindex,nofollow",
    );
    expect(result.provenanceJson.toString("utf8")).toContain(
      '"linkedHostDependencies":["@radix-ui/react-slot","clsx","react","react-dom","tailwindcss"]',
    );
  }, 30_000);

  it("rejects a remote media request before it can reach the compiler", async () => {
    await expect(
      validatedSource({
        main: `import React from "react";
import { createRoot } from "react-dom/client";
createRoot(document.getElementById("root")!).render(<img src="https://tracking.invalid/pixel.png" alt="" />);`,
      }),
    ).rejects.toMatchObject({
      code: "NATIVE_SOURCE_NETWORK_FORBIDDEN",
    });
  }, 30_000);

  it("hard-fails an indirect external request hidden in data before compilation", async () => {
    await expect(
      validatedSource({
        additional: {
          "src/content.json": JSON.stringify({
            hero: "https://tracking.invalid/pixel.png",
          }),
        },
        main: `import React from "react";
import { createRoot } from "react-dom/client";
import content from "./content.json";
function App() { return <main><h1>企业官网</h1><img src={content.hero} alt="" /></main>; }
createRoot(document.getElementById("root")!).render(<App />);`,
      }),
    ).rejects.toMatchObject({ code: "NATIVE_SOURCE_NETWORK_FORBIDDEN" });
  }, 30_000);

  it("returns only a safe file coordinate for a compiler failure", async () => {
    const source = await validatedSource({
      main: `import React from "react";
import { createRoot } from "react-dom/client";
createRoot(document.getElementById("root")!).render(<main><h1>缺少闭合标签</main>);`,
    });
    await expect(
      materializeNativeReactSource({
        sourceZip: source.sourceZip,
        validatedSource: source,
        build: BUILD,
        brief: BRIEF,
        mode: "preview",
        browserQa: false,
      }),
    ).rejects.toMatchObject<Partial<NativeReactBuildError>>({
      code: "NATIVE_BUILD_COMPILE_FAILED",
      diagnostics: [
        expect.objectContaining({
          file: "src/main.tsx",
          line: expect.any(Number),
          column: expect.any(Number),
        }),
      ],
    });
  }, 30_000);

  it("rejects a missing local asset after compilation", async () => {
    const source = await validatedSource({
      main: `import React from "react";
import { createRoot } from "react-dom/client";
createRoot(document.getElementById("root")!).render(<img src="/missing-company-logo.png" alt="企业标志" />);`,
    });
    await expect(
      materializeNativeReactSource({
        sourceZip: source.sourceZip,
        validatedSource: source,
        build: BUILD,
        brief: BRIEF,
        mode: "preview",
        browserQa: false,
      }),
    ).rejects.toMatchObject<Partial<NativeReactBuildError>>({
      code: "NATIVE_BUILD_LOCAL_ASSET_MISSING",
    });
  }, 30_000);

  browserIt(
    "rejects a compiled native site whose React root remains empty",
    async () => {
      const source = await validatedSource({
        main: `import React from "react";
import { createRoot } from "react-dom/client";
createRoot(document.getElementById("root")!).render(null);`,
      });
      await expect(
        materializeNativeReactSource({
          sourceZip: source.sourceZip,
          validatedSource: source,
          build: BUILD,
          brief: BRIEF,
          mode: "preview",
          lighthouseQa: false,
        }),
      ).rejects.toMatchObject<Partial<NativeReactBuildError>>({
        code: "NATIVE_BUILD_RENDER_FAILED",
      });
    },
    30_000,
  );

  it("rebuilds production from the same source archive with canonical routes", async () => {
    const source = await validatedSource();
    const result = await rebuildNativeReactProductionFromSource({
      sourceZip: source.sourceZip,
      validatedSource: source,
      build: BUILD,
      brief: BRIEF,
      canonicalOrigin: "https://www.example.test",
      target: "global_excluding_cn",
      browserQa: false,
    });
    expect(result.sourceZip.equals(source.sourceZip)).toBe(true);
    expect(result.contract.mode).toBe("production");
    expect(result.contract.canonicalOrigin).toBe("https://www.example.test");
    expect(result.contract.target).toBe("global_excluding_cn");
    expect(
      result.files.get("applications/index.html")?.toString("utf8"),
    ).toContain(
      'rel="canonical" href="https://www.example.test/applications/"',
    );
    expect(result.files.get("sitemap.xml")?.toString("utf8")).toContain(
      "https://www.example.test/applications/",
    );
    expect(result.files.get("index.html")?.toString("utf8")).toContain(
      'http-equiv="Content-Security-Policy"',
    );
  }, 30_000);

  it("rejects a coordinate-only 2.9 production rebuild without the frozen plan artifact", async () => {
    const source = await validatedSource();
    const frozenSha = contentPlanSha256(CONTENT_PLAN);
    await expect(
      rebuildNativeReactProductionFromSource({
        sourceZip: source.sourceZip,
        validatedSource: source,
        build: BUILD_2_9,
        brief: BRIEF,
        canonicalOrigin: "https://www.example.test",
        target: "global_excluding_cn",
        browserQa: false,
        contentPlanSha256: frozenSha,
      }),
    ).rejects.toMatchObject<Partial<NativeReactBuildError>>({
      code: "NATIVE_BUILD_CONTENT_PLAN_INVALID",
      diagnostics: [expect.objectContaining({ code: "CONTENT_PLAN_REQUIRED" })],
    });
  }, 30_000);

  browserIt(
    "uses the frozen dynamic plan instead of stale fixed brief routes in production",
    async () => {
      const plan = structuredClone(CONTENT_PLAN) as SiteContentPlanV2;
      plan.routes[0] = {
        ...plan.routes[0]!,
        cta: { label: "查看产品能力", targetPath: "/platform/" },
      };
      plan.routes[1] = {
        ...plan.routes[1]!,
        id: "platform",
        path: "/platform/",
        title: "产品能力",
        purpose: "汇总知识库中的产品实体",
        userQuestions: ["有哪些产品能力？"],
        h1: "产品能力总览",
        summary: "产品资料丰富，因此由 Manus 规划列表与详情关系。",
        cta: { label: "查看 Alpha", targetPath: "/platform/alpha/" },
        sections: [
          {
            ...plan.routes[1]!.sections[0]!,
            id: "platform-list",
            heading: "产品列表",
            body: "Alpha 是知识库中具有完整证据的产品实体。",
          },
        ],
      };
      plan.routes.push({
        ...structuredClone(plan.routes[1]!),
        id: "platform-alpha",
        path: "/platform/alpha/",
        title: "Alpha 产品",
        navigation: "hidden",
        parentPath: "/platform/",
        detailOfPath: "/platform/",
        purpose: "解释 Alpha 产品详情",
        userQuestions: ["Alpha 如何工作？"],
        h1: "Alpha 产品详情",
        summary: "详情页来自 Manus 对丰富产品资料的拆分。",
        cta: { label: "返回产品能力", targetPath: "/platform/" },
        sections: [
          {
            ...plan.routes[1]!.sections[0]!,
            id: "alpha-detail",
            heading: "Alpha 能力",
            body: "Alpha 详情正文完整保留冻结知识证据。",
          },
        ],
      });
      plan.navigation = [
        { label: "首页", targetPath: "/" },
        { label: "产品能力", targetPath: "/platform/" },
      ];
      plan.coverage = [
        {
          sourceDocumentId: "source-1",
          status: "used",
          routeIds: ["home", "platform", "platform-alpha"],
          omissionReason: null,
        },
      ];
      const source = await validatedSource({
        main: `import React from "react";
import { createRoot } from "react-dom/client";
const pages = {
  "/": { h1: "可信赖的企业服务", summary: "围绕客户真实业务问题提供可核验的专业服务。", sectionId: "home-capability", heading: "核心能力", body: "这是从完整知识快照组织出的首页核心能力说明。", cta: "查看产品能力", target: "/platform/" },
  "/platform/": { h1: "产品能力总览", summary: "产品资料丰富，因此由 Manus 规划列表与详情关系。", sectionId: "platform-list", heading: "产品列表", body: "Alpha 是知识库中具有完整证据的产品实体。", cta: "查看 Alpha", target: "/platform/alpha/" },
  "/platform/alpha/": { h1: "Alpha 产品详情", summary: "详情页来自 Manus 对丰富产品资料的拆分。", sectionId: "alpha-detail", heading: "Alpha 能力", body: "Alpha 详情正文完整保留冻结知识证据。", cta: "返回产品能力", target: "/platform/" },
} as const;
function App() { const page = pages[window.location.pathname as keyof typeof pages] ?? pages["/"]; return <><header><nav><a href="/">首页</a><a href="/platform/">产品能力</a></nav></header><main><h1>{page.h1}</h1><p>{page.summary}</p><section data-siteops-section-id={page.sectionId}><h2>{page.heading}</h2><p>{page.body}</p></section><a href={page.target}>{page.cta}</a></main></>; }
createRoot(document.getElementById("root")!).render(<App />);`,
      });
      const result = await rebuildNativeReactProductionFromSource({
        sourceZip: source.sourceZip,
        validatedSource: source,
        build: BUILD_2_9,
        // This is intentionally the pre-plan fixed manifest. Production must
        // never let it erase routes from the immutable SiteContentPlanV2.
        brief: BRIEF,
        contentPlan: plan,
        contentPlanSha256: contentPlanSha256(plan),
        canonicalOrigin: "https://www.example.test",
        target: "global_excluding_cn",
        lighthouseQa: false,
      });

      expect(result.contract.routes).toEqual([
        "/",
        "/platform/",
        "/platform/alpha/",
      ]);
      expect(
        result.contract.contentReceipt?.routes.map((route) => route.path),
      ).toEqual(["/", "/platform/", "/platform/alpha/"]);
      expect(result.files.has("platform/index.html")).toBe(true);
      expect(result.files.has("platform/alpha/index.html")).toBe(true);
      expect(result.files.has("applications/index.html")).toBe(false);
      expect(result.files.has("404.html")).toBe(true);
      expect(result.files.get("sitemap.xml")?.toString("utf8")).toContain(
        "https://www.example.test/platform/alpha/",
      );
    },
    30_000,
  );

  it("refuses a source archive that differs from the validated bytes", async () => {
    const source = await validatedSource();
    await expect(
      materializeNativeReactSource({
        sourceZip: Buffer.concat([source.sourceZip, Buffer.from("changed")]),
        validatedSource: source,
        build: BUILD,
        brief: BRIEF,
        mode: "preview",
        browserQa: false,
      }),
    ).rejects.toMatchObject<Partial<NativeReactBuildError>>({
      code: "NATIVE_BUILD_SOURCE_MISMATCH",
    });
  });
});
