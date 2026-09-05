import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import JSZip from "jszip";
import sharp from "sharp";
import { describe, expect, it } from "vitest";

import {
  visualSelectionBundleV5Schema,
  visualSelectionBundleV6Schema,
} from "../../shared/siteops";
import type { NormalizedTwentyFirstCandidate } from "../../shared/siteops-workflow";
import {
  NATIVE_RUNTIME_CONTRACT_FILENAME,
  NATIVE_RUNTIME_CONTRACT_V1,
  NATIVE_RUNTIME_CONTRACT_V1_SHA256,
  NATIVE_RUNTIME_EXECUTION_SHELL_FILENAME,
  NATIVE_RUNTIME_EXECUTION_SHELL_V1_SHA256,
  NATIVE_RUNTIME_CONTRACT_VERSION,
  NATIVE_SOURCE_PREFLIGHT_V2_SHA256,
  NATIVE_SOURCE_PREFLIGHT_V2_VERSION,
  auditNativeRuntimeContractV1,
  validateNativeReactSourceArchive,
} from "./native-react-source";
import {
  compileValidatedNativeReactSource,
  materializeNativeReactSource,
} from "./native-react-build-runtime";
import {
  NativeVisualSourceError,
  VISUAL_SELECTION_BUNDLE_V6_SOURCE_ARCHIVE_MAX_BYTES,
  assertVisualSelectionBundleV6SourceArchiveSize,
  classifyNativeVisualFailure,
  createNativeSourceArchive,
  createVisualSelectionBundleV5Artifact,
  createVisualSelectionBundleV6Artifact,
  normalizeTwentyFirstNativeTemplateArchive,
  normalizeTwentyFirstNativeSource,
  prepareLegacyNativeTemplateCandidate,
  prepareNativeTemplateCandidate,
  prepareStaticTemplateExecutionSource,
  readNativeSourceArchive,
  readVisualSelectionBundleArtifact,
  renderNativeReactSourcePreview,
  selectedNativeSourceArchive,
} from "./native-visual-source";

const browserIt =
  process.env.FRONTMIND_RUN_SITEOPS_BROWSER_INTEGRATION === "1" ? it : it.skip;

function digest(value: string | Buffer) {
  return createHash("sha256").update(value).digest("hex");
}

function searchCandidate(id = 1) {
  return {
    providerItemId: id,
    providerItemKey: `n:${id}`,
  } as NormalizedTwentyFirstCandidate;
}

function payload(id: number, suffix = "") {
  return {
    data: {
      id,
      version: `v${id}`,
      componentCode: [
        'import React from "react";',
        `export default function NativeHero${suffix}(){return <div className="min-h-screen bg-white text-slate-950"><header><nav>FrontMind</nav></header><main><section><h1>Native ${id}</h1></section><section><h2>Capabilities</h2><p>Page-level candidate</p></section></main><footer>Contact</footer></div>}`,
      ].join("\n"),
      demoCode: [
        'import React from "react";',
        `import NativeHero from "./component";`,
        `export default function Demo${suffix}(){return <NativeHero />}`,
      ].join("\n"),
      globalsCss: "body{font-family:system-ui,sans-serif}",
      dependencies: ["react@19.2.1", "react-dom@19.2.1"],
    },
  };
}

async function completeTemplateArchive(
  framework: "vite_react" | "next_static",
  options: {
    lifecycle?: boolean;
    consoleError?: boolean;
    label?: string;
    remoteFonts?: boolean;
  } = {},
) {
  const zip = new JSZip();
  const scripts = options.lifecycle
    ? { postinstall: "node install.js" }
    : framework === "vite_react"
      ? { dev: "vite", build: "vite build" }
      : { dev: "next dev", build: "next build" };
  zip.file(
    "native-template/package.json",
    JSON.stringify({
      private: true,
      scripts,
      dependencies: {
        ...(framework === "next_static" ? { next: "15.5.0" } : {}),
        react: "19.2.1",
        "react-dom": "19.2.1",
      },
    }),
  );
  zip.file(
    "native-template/LICENSE",
    "Permitted 21st template fixture license\n",
  );
  if (framework === "vite_react") {
    zip.file(
      "native-template/index.html",
      '<!doctype html><html><body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body></html>',
    );
    zip.file(
      "native-template/src/main.tsx",
      'import React from "react"; import {createRoot} from "react-dom/client"; import App from "./App"; createRoot(document.getElementById("root")!).render(<App/>);',
    );
    zip.file(
      "native-template/src/App.tsx",
      [
        'import React from "react";',
        'import "./styles.css";',
        options.consoleError ? 'console.error("provider diagnostic");' : "",
        `export default function App(){return <div className="landing"><h1>Complete Vite template ${options.label ?? ""}</h1><a href="https://example.com/contact">Contact</a></div>}`,
      ].join("\n"),
    );
    zip.file(
      "native-template/src/styles.css",
      [
        options.remoteFonts
          ? '@import url("https://fonts.googleapis.com/css2?family=Inter");'
          : "",
        options.remoteFonts
          ? '@font-face{font-family:Inter;src:url("https://fonts.gstatic.com/s/inter.woff2") format("woff2")}'
          : "",
        ".landing{min-height:320px;padding:48px;background:#eef2ff;color:#172554;font-family:Inter,system-ui,sans-serif}",
      ].join("\n"),
    );
  } else {
    zip.file(
      "native-template/app/page.tsx",
      [
        'import Image from "next/image";',
        'import Link from "next/link";',
        'export default function Page(){return <main><Image src="/hero.svg" alt="" width={80} height={80}/><h1>Complete Next template</h1><Link href="https://example.com/contact">Contact</Link></main>}',
      ].join("\n"),
    );
    zip.file(
      "native-template/app/layout.tsx",
      'import React from "react"; import "./globals.css"; export default function Layout({children}:{children:React.ReactNode}){return <div className="shell">{children}</div>}',
    );
    zip.file(
      "native-template/app/globals.css",
      ".shell{min-height:360px;padding:48px;background:#fff7ed;color:#431407}",
    );
    zip.file(
      "native-template/public/hero.svg",
      '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80"><rect width="80" height="80" fill="#ea580c"/></svg>',
    );
  }
  return zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    platform: "UNIX",
  });
}

async function renderedTemplateFixture(input: {
  sourceArchive: Buffer;
  signal: AbortSignal;
}) {
  if (input.signal.aborted) throw input.signal.reason;
  await readNativeSourceArchive(input.sourceArchive);
  const hash = Buffer.from(digest(input.sourceArchive), "hex");
  return sharp({
    create: {
      width: 160,
      height: 100,
      channels: 3,
      background: { r: hash[0]!, g: hash[1]!, b: hash[2]! },
    },
  })
    .png()
    .toBuffer();
}

describe("21st native visual source", () => {
  it("keeps every V6 source archive within the bounded Manus upload boundary", () => {
    expect(() =>
      assertVisualSelectionBundleV6SourceArchiveSize(
        Buffer.alloc(VISUAL_SELECTION_BUNDLE_V6_SOURCE_ARCHIVE_MAX_BYTES),
      ),
    ).not.toThrow();
    expect(() =>
      assertVisualSelectionBundleV6SourceArchiveSize(
        Buffer.alloc(VISUAL_SELECTION_BUNDLE_V6_SOURCE_ARCHIVE_MAX_BYTES + 1),
      ),
    ).toThrow("V6_SOURCE_ARCHIVE_SIZE_INVALID");
  });

  it("normalizes a complete Vite Template into the downstream source contract", async () => {
    const providerArchive = await completeTemplateArchive("vite_react");
    const source = await normalizeTwentyFirstNativeTemplateArchive({
      templateId: "vite-landing",
      slug: "vite-landing",
      version: "commit-a",
      archive: providerArchive,
      expectedArchiveSha256: digest(providerArchive),
    });
    expect(source).toMatchObject({
      framework: "vite_react",
      templateId: "vite-landing",
      templateSlug: "vite-landing",
      entrypoint: "src/App.tsx",
      demoEntrypoint: "src/App.tsx",
      sourceDirectory: "source",
    });
    expect(source.files.map((file) => file.path)).toEqual(
      expect.arrayContaining([
        "index.html",
        "package.json",
        "LICENSE",
        "src/main.tsx",
        "src/App.tsx",
        "src/styles.css",
      ]),
    );
    const sourceArchive = await createNativeSourceArchive(source);
    const inspected = await readNativeSourceArchive(sourceArchive);
    const operationToken = "template-downstream-validation";
    await expect(
      validateNativeReactSourceArchive({
        archive: sourceArchive,
        receipt: {
          operationToken,
          baseSourceSha256: digest(sourceArchive),
          archiveSha256: digest(sourceArchive),
          fileCount: inspected.files.length + 1,
        },
        expectedOperationToken: operationToken,
        expectedBaseSourceSha256: digest(sourceArchive),
      }),
    ).resolves.toMatchObject({ entrypoint: "src/main.tsx" });
  });

  it("normalizes a static Next Template through local compatibility modules", async () => {
    const providerArchive = await completeTemplateArchive("next_static");
    const source = await normalizeTwentyFirstNativeTemplateArchive({
      templateId: 42,
      slug: "next-landing",
      version: null,
      archive: providerArchive,
    });
    expect(source).toMatchObject({
      framework: "next_static",
      entrypoint: "app/page.tsx",
      demoEntrypoint: "src/frontmind-next/root.tsx",
    });
    const page = source.files
      .find((file) => file.path === "app/page.tsx")!
      .bytes.toString("utf8");
    expect(page).toContain('from "@/frontmind-next/image"');
    expect(page).toContain('from "@/frontmind-next/link"');
    expect(source.dependencies.map((value) => value.name)).not.toContain(
      "next",
    );
    expect(source.files.map((file) => file.path)).toEqual(
      expect.arrayContaining([
        "src/frontmind-next/image.tsx",
        "src/frontmind-next/link.tsx",
        "src/frontmind-next/root.tsx",
      ]),
    );
  });

  it("honors an exact Marketplace source subdirectory instead of selecting a sibling project", async () => {
    const zip = new JSZip();
    const manifest = JSON.stringify({
      dependencies: { react: "19.2.1", "react-dom": "19.2.1" },
    });
    zip.file("repo/package.json", manifest);
    zip.file(
      "repo/app/page.tsx",
      "export default function Wrong(){return <main>Repository shell</main>}",
    );
    zip.file("repo/template/package.json", manifest);
    zip.file(
      "repo/template/app/page.tsx",
      "export default function Selected(){return <main>Selected template</main>}",
    );
    const archive = await zip.generateAsync({ type: "nodebuffer" });
    const source = await normalizeTwentyFirstNativeTemplateArchive({
      templateId: 772,
      slug: "open-saas",
      version: "c".repeat(40),
      archive,
      sourceSubdirectory: "template",
    });
    expect(source.entrypoint).toBe("app/page.tsx");
    expect(
      source.files
        .find((file) => file.path === "app/page.tsx")!
        .bytes.toString("utf8"),
    ).toContain("Selected template");
    expect(JSON.stringify(source.files)).not.toContain("Repository shell");
  });

  it("projects distinct registry templates from one verified repository coordinate", async () => {
    const zip = new JSZip();
    zip.file(
      "hirael/package.json",
      JSON.stringify({
        dependencies: { react: "19.2.1", "react-dom": "19.2.1" },
      }),
    );
    zip.file(
      "hirael/app/page.tsx",
      "export default function Docs(){return <main>Registry documentation</main>}",
    );
    zip.file("hirael/app/globals.css", "body{margin:0}");
    zip.file(
      "hirael/registry/hirael/templates/agency-landing/agency-landing.tsx",
      'import "../../../../app/globals.css"; export default function Agency(){return <main>Agency landing</main>}',
    );
    zip.file(
      "hirael/registry/hirael/templates/velorah/velorah.tsx",
      "export default function Velorah(){return <main>Velorah landing</main>}",
    );
    const archive = await zip.generateAsync({ type: "nodebuffer" });
    const agency = await normalizeTwentyFirstNativeTemplateArchive({
      templateId: 790,
      slug: "hirael-agency-landing",
      version: "8".repeat(40),
      archive,
    });
    const velorah = await normalizeTwentyFirstNativeTemplateArchive({
      templateId: 795,
      slug: "hirael-velorah",
      version: "8".repeat(40),
      archive,
    });
    expect(agency.entrypoint).toBe(
      "registry/hirael/templates/agency-landing/agency-landing.tsx",
    );
    expect(velorah.entrypoint).toBe(
      "registry/hirael/templates/velorah/velorah.tsx",
    );
    expect(agency.sourceTreeSha256).not.toBe(velorah.sourceTreeSha256);
    expect(JSON.stringify(agency.files)).not.toContain(
      "Registry documentation",
    );
  });

  it("prepares a complete registry template as an offline eager Vite execution archive", async () => {
    const zip = new JSZip();
    zip.file(
      "hirael/package.json",
      JSON.stringify({
        private: true,
        dependencies: {
          react: "19.2.1",
          "react-dom": "19.2.1",
          shaders: "3.1.457",
        },
      }),
    );
    zip.file(
      "hirael/registry/hirael/templates/agency-landing/agency-landing.tsx",
      'import { Hero } from "./hero"; export default function AgencyLanding(){return <Hero/>}',
    );
    zip.file(
      "hirael/registry/hirael/templates/agency-landing/hero.tsx",
      [
        'import dynamic from "next/dynamic";',
        'import { Details } from "./details";',
        'const ShaderBackground = dynamic(() => import("./shader-background").then((m) => m.ShaderBackground), { ssr: false });',
        'const HERO_IMAGE = "https://assets.example.com/hero.png";',
        'const HERO_VIDEO = "https://assets.example.com/hero.mp4";',
        'export function Hero(){return <main><ShaderBackground/><img alt="" src={HERO_IMAGE}/><video muted src={HERO_VIDEO}/><h1>Agency</h1><Details/></main>}',
      ].join("\n"),
    );
    zip.file(
      "hirael/registry/hirael/templates/agency-landing/details.tsx",
      "export function Details(){return <section>Complete registry subtree</section>}",
    );
    zip.file(
      "hirael/registry/hirael/templates/agency-landing/shader-background.tsx",
      [
        'import { ChromaFlow, FilmGrain, FlutedGlass, Shader, Swirl } from "shaders/react";',
        "export function ShaderBackground(){return <Shader style={{width:'100%',height:'100%'}}><Swirl colorA='#fff' colorB='#eee'/><ChromaFlow baseColor='#fff' downColor='#f60' leftColor='#f60' rightColor='#f60' upColor='#f60'/><FlutedGlass/><FilmGrain/></Shader>}",
      ].join("\n"),
    );
    const providerArchive = await zip.generateAsync({ type: "nodebuffer" });
    const mirroredImage = await sharp({
      create: {
        width: 24,
        height: 16,
        channels: 4,
        background: { r: 240, g: 90, b: 20, alpha: 1 },
      },
    })
      .png()
      .toBuffer();
    const mirroredVideo = Buffer.concat([
      Buffer.from([0, 0, 0, 24]),
      Buffer.from("ftypisom", "latin1"),
      Buffer.from("frontmind-mp4-fixture", "utf8"),
    ]);
    const prepared = await prepareStaticTemplateExecutionSource({
      templateId: 790,
      slug: "hirael-agency-landing",
      version: "8".repeat(40),
      archive: providerArchive,
      expectedArchiveSha256: digest(providerArchive),
      sourceSubdirectory: "registry/hirael/templates/agency-landing",
      signal: new AbortController().signal,
      fetchRemoteAsset: async ({ url }) => ({
        finalUrl: url,
        mimeType: "image/png" as const,
        buffer: mirroredImage,
        width: 24,
        height: 16,
        sha256: digest(mirroredImage),
        visualSignals: {
          dominantHex: "#f05a14",
          brightness: 120,
          contrast: 40,
        },
      }),
      fetchRemoteRuntimeMedia: async ({ url }) => ({
        finalUrl: url,
        mimeType: "video/mp4",
        buffer: mirroredVideo,
      }),
      frozenRuntimeMedia: [
        {
          kind: "image",
          url: "https://assets.example.com/hero.png",
          bytes: mirroredImage.length,
          sha256: digest(mirroredImage),
        },
        {
          kind: "video",
          url: "https://assets.example.com/hero.mp4",
          bytes: mirroredVideo.length,
          sha256: digest(mirroredVideo),
        },
      ],
    });

    expect(prepared.framework).toBe("vite_react");
    const files = new Map(
      prepared.files.map((file) => [file.path, file.bytes.toString("utf8")]),
    );
    const hero = files.get("registry/hirael/templates/agency-landing/hero.tsx");
    const shader = files.get(
      "registry/hirael/templates/agency-landing/shader-background.tsx",
    );
    expect(hero).toContain(
      'import { ShaderBackground } from "./shader-background";',
    );
    expect(hero).not.toContain("next/dynamic");
    expect(hero).not.toContain("import(");
    expect(shader).toContain('from "shaders/react/bundle"');
    expect(shader).toContain("<Shader disableTelemetry={true}");
    expect(files.keys()).toContain(
      "registry/hirael/templates/agency-landing/details.tsx",
    );
    expect(files.get("src/main.tsx")).toContain(
      'import FrontMindRoutes from "./frontmind-routes";',
    );
    expect(files.get("src/frontmind-routes.tsx")).toContain(
      'export const FRONTMIND_ROUTE_PATHS = ["/"] as const;',
    );
    expect(files.has(NATIVE_RUNTIME_CONTRACT_FILENAME)).toBe(true);
    expect(files.has(NATIVE_RUNTIME_EXECUTION_SHELL_FILENAME)).toBe(true);
    expect(
      prepared.files.filter((file) =>
        file.path.startsWith("public/frontmind-native-media/"),
      ),
    ).toHaveLength(2);
    const mirroredMp4 = prepared.files.find((file) =>
      file.path.endsWith(".mp4"),
    );
    expect(mirroredMp4?.bytes.equals(mirroredVideo)).toBe(true);
    expect(hero).toContain(mirroredMp4!.path.slice("public".length));
    expect(
      prepared.files
        .filter((file) => /\.(?:css|html|[cm]?[jt]sx?)$/u.test(file.path))
        .some((file) => file.bytes.includes("https://")),
    ).toBe(false);

    await expect(
      prepareStaticTemplateExecutionSource({
        templateId: 790,
        slug: "hirael-agency-landing",
        version: "8".repeat(40),
        archive: providerArchive,
        expectedArchiveSha256: digest(providerArchive),
        sourceSubdirectory: "registry/hirael/templates/agency-landing",
        signal: new AbortController().signal,
        fetchRemoteAsset: async ({ url }) => ({
          finalUrl: url,
          mimeType: "image/png" as const,
          buffer: mirroredImage,
          width: 24,
          height: 16,
          sha256: digest(mirroredImage),
          visualSignals: {
            dominantHex: "#f05a14",
            brightness: 120,
            contrast: 40,
          },
        }),
        fetchRemoteRuntimeMedia: async ({ url }) => ({
          finalUrl: url,
          mimeType: "video/mp4",
          buffer: mirroredVideo,
        }),
        frozenRuntimeMedia: [
          {
            kind: "image",
            url: "https://assets.example.com/hero.png",
            bytes: mirroredImage.length,
            sha256: digest(mirroredImage),
          },
          {
            kind: "video",
            url: "https://assets.example.com/hero.mp4",
            bytes: mirroredVideo.length,
            sha256: "0".repeat(64),
          },
        ],
      }),
    ).rejects.toMatchObject({
      code: "NATIVE_SOURCE_STATIC_MEDIA_INTEGRITY_MISMATCH",
    });

    const operationToken = "static-template-registry-admission-test";
    const validated = await validateNativeReactSourceArchive({
      archive: prepared.sourceArchive,
      receipt: {
        operationToken,
        baseSourceSha256: prepared.sourceArchiveSha256,
        archiveSha256: prepared.sourceArchiveSha256,
        fileCount: prepared.files.length + 1,
        preflightVersion: NATIVE_SOURCE_PREFLIGHT_V2_VERSION,
        preflightStatus: "passed",
        preflightSha256: NATIVE_SOURCE_PREFLIGHT_V2_SHA256,
        runtimeContractVersion: NATIVE_RUNTIME_CONTRACT_VERSION,
        runtimeContractSha256: NATIVE_RUNTIME_CONTRACT_V1_SHA256,
        executionShellSha256: NATIVE_RUNTIME_EXECUTION_SHELL_V1_SHA256,
        executionBaselineSha256: prepared.sourceArchiveSha256,
      },
      expectedOperationToken: operationToken,
      expectedBaseSourceSha256: prepared.sourceArchiveSha256,
      requiredReceiptVersion: 2,
      expectedExecutionBaselineSha256: prepared.sourceArchiveSha256,
      runtimeContract: NATIVE_RUNTIME_CONTRACT_V1,
    });
    expect(validated.files.size).toBe(prepared.files.length + 1);
    expect(
      validated.files.has(
        "registry/hirael/templates/agency-landing/shader-background.tsx",
      ),
    ).toBe(true);
    const materialized = await materializeNativeReactSource({
      sourceZip: prepared.sourceArchive,
      validatedSource: validated,
      build: {
        id: "79000000-0000-4000-8000-000000000001",
        projectId: "79000000-0000-4000-8000-000000000002",
        workflowVersion: "2.8.0",
        selectionHash: digest("registry-execution-admission"),
      },
      brief: {
        companyName: "FrontMind catalog admission",
        primaryLanguage: "zh-CN",
        contacts: [],
        offerings: ["受控模板执行验证"],
        audience: ["FrontMind catalog admission"],
        conversionGoal: "验证模板执行能力",
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
            sourceDocumentIds: ["catalog-admission-source"],
          },
        ],
        verifiedFacts: [
          {
            statement: "该内容仅用于模板执行准入。",
            sourceDocumentIds: ["catalog-admission-source"],
          },
        ],
        publicAssetIds: [],
        unknowns: [],
      },
      mode: "preview",
      timeoutMs: 120_000,
      browserQa: false,
      lighthouseQa: false,
      runtimeAudit: (auditInput) =>
        auditNativeRuntimeContractV1({
          ...auditInput,
          contract: NATIVE_RUNTIME_CONTRACT_V1,
        }),
    });
    expect(JSON.parse(materialized.qaJson.toString("utf8"))).toMatchObject({
      passed: true,
      browser: { available: false },
    });
    expect(materialized.distZip.length).toBeGreaterThan(0);
  }, 30_000);

  it("binds shared-repository Hirael archives to distinct opaque slug entrypoints and hashes", async () => {
    const zip = new JSZip();
    zip.file(
      "hirael/package.json",
      JSON.stringify({
        private: true,
        dependencies: { react: "19.2.1", "react-dom": "19.2.1" },
      }),
    );
    zip.file(
      "hirael/app/page.tsx",
      "export default function Registry(){return <main>Registry shell</main>}",
    );
    zip.file(
      "hirael/registry/hirael/templates/agency-landing/agency-landing.tsx",
      'import "./styles.css"; export default function Agency(){return <main className="agency">Agency</main>}',
    );
    zip.file(
      "hirael/registry/hirael/templates/agency-landing/styles.css",
      ".agency{font-family:Georgia,serif;padding:64px}",
    );
    zip.file(
      "hirael/registry/hirael/templates/velorah/velorah.tsx",
      'import "./styles.css"; export default function Velorah(){return <main className="velorah">Velorah</main>}',
    );
    zip.file(
      "hirael/registry/hirael/templates/velorah/styles.css",
      ".velorah{font-family:Inter,system-ui,sans-serif;padding:8px}",
    );
    const providerArchive = await zip.generateAsync({ type: "nodebuffer" });
    const prepare = (slug: string) =>
      prepareNativeTemplateCandidate({
        templateId: slug,
        slug,
        version: "8".repeat(40),
        archive: providerArchive,
        expectedArchiveSha256: digest(providerArchive),
        previewUrl: `https://cdn.21st.dev/templates/${slug}.png`,
        signal: new AbortController().signal,
        fetchRemoteAsset: async ({ url }) => ({
          finalUrl: url,
          mimeType: "image/png" as const,
          buffer: Buffer.from(url),
          width: 1200,
          height: 800,
          sha256: digest(url),
          visualSignals: {
            dominantHex: "#000000",
            brightness: 0,
            contrast: 0,
          },
        }),
        renderPreview: renderedTemplateFixture,
      });
    const agency = await prepare("hirael-agency-landing");
    const velorah = await prepare("hirael-velorah");
    expect(agency).toMatchObject({
      sourceFormat: "provider_archive_v1",
      framework: "next_static",
      entrypoint: "registry/hirael/templates/agency-landing/agency-landing.tsx",
    });
    expect(velorah.entrypoint).toBe(
      "registry/hirael/templates/velorah/velorah.tsx",
    );
    expect(agency.sourceTreeSha256).not.toBe(velorah.sourceTreeSha256);
    expect(agency.sourceArchiveSha256).not.toBe(velorah.sourceArchiveSha256);
    expect(agency.styleTokens).toMatchObject({
      typeSystem: "editorial_serif",
      density: "spacious",
      sourceTreeSha256: agency.sourceTreeSha256,
    });
    expect(velorah.styleTokens).toMatchObject({
      typeSystem: "display_sans",
      density: "compact",
      sourceTreeSha256: velorah.sourceTreeSha256,
    });
    const agencyRetry = await prepare("hirael-agency-landing");
    expect(agencyRetry.sourceTreeSha256).toBe(agency.sourceTreeSha256);
    expect(agencyRetry.sourceArchiveSha256).toBe(agency.sourceArchiveSha256);
  });

  it("freezes the complete Template ZIP only after rendering its derived controlled build", async () => {
    const providerArchive = await completeTemplateArchive("vite_react");
    let previewFetches = 0;
    let renderedArchiveSha256: string | null = null;
    const prepared = await prepareNativeTemplateCandidate({
      templateId: "inert-complete-template",
      slug: "inert-complete-template",
      version: "1".repeat(40),
      archive: providerArchive,
      expectedArchiveSha256: digest(providerArchive),
      previewUrl: "https://cdn.21st.dev/templates/inert-complete-template.png",
      signal: new AbortController().signal,
      fetchRemoteAsset: async ({ url }) => {
        previewFetches += 1;
        return {
          finalUrl: url,
          mimeType: "image/png" as const,
          buffer: Buffer.from("unused-marketplace-preview"),
          width: 1200,
          height: 800,
          sha256: digest("unused-marketplace-preview"),
          visualSignals: {
            dominantHex: "#000000",
            brightness: 0,
            contrast: 0,
          },
        };
      },
      fetchRemoteStyleAsset: async () => {
        throw new Error("fixture has no remote Template CSS");
      },
      renderPreview: async (input) => {
        renderedArchiveSha256 = digest(input.sourceArchive);
        return renderedTemplateFixture(input);
      },
    });
    expect(previewFetches).toBe(0);
    expect(renderedArchiveSha256).not.toBeNull();
    expect(prepared).toMatchObject({
      sourceFormat: "provider_archive_v1",
      framework: "vite_react",
      styleTokens: {
        schemaVersion: 1,
        derivation: "normalized-preview-bounded-source-v1",
        previewSha256: prepared.previewSha256,
        sourceTreeSha256: prepared.sourceTreeSha256,
        dominantHex: expect.stringMatching(/^#[a-f0-9]{6}$/u),
        contrast: "low",
        typeSystem: "display_sans",
        density: "spacious",
      },
    });
    expect(prepared.preview.length).toBeGreaterThan(0);
    const frozen = await JSZip.loadAsync(prepared.sourceArchive, {
      checkCRC32: true,
    });
    const frozenProvider = await frozen
      .file("provider-source.zip")!
      .async("nodebuffer");
    expect(frozenProvider.equals(providerArchive)).toBe(true);
    expect(digest(frozenProvider)).toBe(digest(providerArchive));
  });

  it("retains the 2.5 opaque Template and Marketplace preview semantics for immutable replay", async () => {
    const providerArchive = await completeTemplateArchive("vite_react");
    const marketplacePreview = await sharp({
      create: {
        width: 160,
        height: 100,
        channels: 3,
        background: { r: 36, g: 68, b: 112 },
      },
    })
      .png()
      .toBuffer();
    const prepared = await prepareLegacyNativeTemplateCandidate({
      templateId: "legacy-template",
      slug: "legacy-template",
      version: "2".repeat(40),
      archive: providerArchive,
      expectedArchiveSha256: digest(providerArchive),
      previewUrl: "https://cdn.21st.dev/templates/legacy-template.png",
      signal: new AbortController().signal,
      fetchRemoteAsset: async ({ url }) => ({
        finalUrl: url,
        mimeType: "image/png" as const,
        buffer: marketplacePreview,
        width: 1200,
        height: 800,
        sha256: digest(marketplacePreview),
        visualSignals: {
          dominantHex: "#000000",
          brightness: 0,
          contrast: 0,
        },
      }),
    });
    expect(prepared.sourceFormat).toBe("provider_archive_v1");
    expect(prepared.preview.equals(marketplacePreview)).toBe(true);
    const wrapper = await JSZip.loadAsync(prepared.sourceArchive);
    expect(wrapper.file("provider-source.zip")).not.toBeNull();
  });

  it("rejects unsafe opaque provider ZIP paths before freezing candidate data", async () => {
    const zip = new JSZip();
    zip.file("../escape.tsx", "export default null");
    const archive = await zip.generateAsync({ type: "nodebuffer" });
    await expect(
      prepareNativeTemplateCandidate({
        templateId: "unsafe-template",
        slug: "unsafe-template",
        version: "1".repeat(40),
        archive,
        previewUrl: "https://cdn.21st.dev/templates/unsafe.png",
        signal: new AbortController().signal,
        fetchRemoteAsset: async () => {
          throw new Error("preview must not be fetched for an unsafe ZIP");
        },
      }),
    ).rejects.toThrow("NATIVE_TEMPLATE_SOURCE_UNSAFE");
  });

  it("rejects even an unreferenced documentation symlink before compiling a candidate", async () => {
    const zip = new JSZip();
    zip.file(
      "template/app/page.tsx",
      'const retainedDocumentation="AGENTS.md"; export default function Page(){return <main data-doc={retainedDocumentation}>Template</main>}',
    );
    zip.file("template/AGENTS.md", "Repository documentation\n");
    zip.file("template/CLAUDE.md", "AGENTS.md", {
      unixPermissions: 0o120777,
    });
    const providerArchive = await zip.generateAsync({
      type: "nodebuffer",
      platform: "UNIX",
    });
    await expect(
      prepareNativeTemplateCandidate({
        templateId: "safe-doc-link",
        slug: "safe-doc-link",
        version: "1".repeat(40),
        archive: providerArchive,
        expectedArchiveSha256: digest(providerArchive),
        previewUrl: "https://cdn.21st.dev/templates/safe-doc-link.png",
        signal: new AbortController().signal,
        fetchRemoteAsset: async ({ url }) => ({
          finalUrl: url,
          mimeType: "image/png" as const,
          buffer: Buffer.from("safe-preview"),
          width: 1200,
          height: 800,
          sha256: digest("safe-preview"),
          visualSignals: {
            dominantHex: "#000000",
            brightness: 0,
            contrast: 0,
          },
        }),
        renderPreview: renderedTemplateFixture,
      }),
    ).rejects.toThrow("NATIVE_TEMPLATE_SOURCE_UNSAFE");
  });

  it("rejects a documentation symlink referenced by runtime source", async () => {
    const zip = new JSZip();
    zip.file(
      "template/app/page.tsx",
      'const linkedDocumentation="CLAUDE.md"; export default function Page(){return <main data-doc={linkedDocumentation}>Template</main>}',
    );
    zip.file("template/AGENTS.md", "Repository documentation\n");
    zip.file("template/CLAUDE.md", "AGENTS.md", {
      unixPermissions: 0o120777,
    });
    const providerArchive = await zip.generateAsync({
      type: "nodebuffer",
      platform: "UNIX",
    });
    await expect(
      prepareNativeTemplateCandidate({
        templateId: "referenced-doc-link",
        slug: "referenced-doc-link",
        version: "1".repeat(40),
        archive: providerArchive,
        expectedArchiveSha256: digest(providerArchive),
        previewUrl: "https://cdn.21st.dev/templates/referenced-doc-link.png",
        signal: new AbortController().signal,
        fetchRemoteAsset: async () => {
          throw new Error("preview must not be fetched for an unsafe ZIP");
        },
      }),
    ).rejects.toThrow("NATIVE_TEMPLATE_SOURCE_UNSAFE");
  });

  it("rejects a documentation symlink whose target is a directory", async () => {
    const zip = new JSZip();
    zip.file(
      "template/app/page.tsx",
      "export default function Page(){return <main>Template</main>}",
    );
    zip.file("template/AGENTS.md/details.txt", "Repository documentation\n");
    zip.file("template/CLAUDE.md", "AGENTS.md", {
      unixPermissions: 0o120777,
    });
    const providerArchive = await zip.generateAsync({
      type: "nodebuffer",
      platform: "UNIX",
    });
    await expect(
      prepareNativeTemplateCandidate({
        templateId: "directory-doc-link",
        slug: "directory-doc-link",
        version: "1".repeat(40),
        archive: providerArchive,
        expectedArchiveSha256: digest(providerArchive),
        previewUrl: "https://cdn.21st.dev/templates/directory-doc-link.png",
        signal: new AbortController().signal,
        fetchRemoteAsset: async () => {
          throw new Error("preview must not be fetched for an unsafe ZIP");
        },
      }),
    ).rejects.toThrow("NATIVE_TEMPLATE_SOURCE_UNSAFE");
  });

  it.each([
    ["runtime source", "template/src/linked.tsx", "target.tsx"],
    ["public asset", "template/public/logo.svg", "real-logo.svg"],
    ["build configuration", "template/docker-compose.yml", "compose.yml"],
    ["absolute target", "template/CLAUDE.md", "/AGENTS.md"],
    ["traversing target", "template/CLAUDE.md", "../AGENTS.md"],
    ["unknown metadata", "template/notes", "AGENTS.md"],
  ])(
    "rejects an opaque provider symlink in %s",
    async (_label, link, target) => {
      const zip = new JSZip();
      zip.file(
        "template/app/page.tsx",
        "export default function Page(){return <main>Template</main>}",
      );
      zip.file("template/AGENTS.md", "Repository documentation\n");
      zip.file("template/target.tsx", "export default null");
      zip.file("template/real-logo.svg", "<svg></svg>");
      zip.file("template/compose.yml", "services: {}\n");
      zip.file(link, target, { unixPermissions: 0o120777 });
      const providerArchive = await zip.generateAsync({
        type: "nodebuffer",
        platform: "UNIX",
      });
      await expect(
        prepareNativeTemplateCandidate({
          templateId: "unsafe-link",
          slug: "unsafe-link",
          version: "1".repeat(40),
          archive: providerArchive,
          expectedArchiveSha256: digest(providerArchive),
          previewUrl: "https://cdn.21st.dev/templates/unsafe-link.png",
          signal: new AbortController().signal,
          fetchRemoteAsset: async () => {
            throw new Error("preview must not be fetched for an unsafe ZIP");
          },
        }),
      ).rejects.toThrow("NATIVE_TEMPLATE_SOURCE_UNSAFE");
    },
  );

  it("selects a safe Next route-group landing page and composes its layouts", async () => {
    const zip = new JSZip();
    zip.file(
      "template/package.json",
      JSON.stringify({
        scripts: { build: "next build", prepare: "husky" },
        dependencies: {
          next: "15.5.0",
          react: "19.2.1",
          "react-dom": "19.2.1",
        },
      }),
    );
    zip.file(
      "template/src/app/layout.tsx",
      "export default function Root({children}:{children:React.ReactNode}){return <div data-layout='root'>{children}</div>}",
    );
    zip.file(
      "template/src/app/(marketing)/layout.tsx",
      "export default function Marketing({children}:{children:React.ReactNode}){return <section data-layout='marketing'>{children}</section>}",
    );
    zip.file(
      "template/src/app/(marketing)/page.tsx",
      "export default function Page(){return <main>Marketing home</main>}",
    );
    zip.file(
      "template/src/app/[slug]/page.tsx",
      "export default function Dynamic(){return <main>Dynamic</main>}",
    );
    const source = await normalizeTwentyFirstNativeTemplateArchive({
      templateId: "grouped-next",
      slug: "grouped-next",
      version: null,
      archive: await zip.generateAsync({ type: "nodebuffer" }),
    });
    expect(source).toMatchObject({
      framework: "next_static",
      entrypoint: "src/app/(marketing)/page.tsx",
    });
    const root = source.files
      .find((file) => file.path === "src/frontmind-next/root.tsx")!
      .bytes.toString("utf8");
    expect(root).toContain("Layout0");
    expect(root).toContain("Layout1");
    expect(root.indexOf("<Layout0>")).toBeLessThan(root.indexOf("<Layout1>"));
    expect(root).not.toContain("[slug]");
  });

  it("selects a buildable Vite package root ahead of docs and Next roots", async () => {
    const zip = new JSZip();
    zip.file(
      "template/docs/package.json",
      JSON.stringify({
        scripts: { postinstall: "node docs-install.js" },
        dependencies: { vue: "3.5.0" },
      }),
    );
    zip.file("template/docs/index.html", '<div id="root"></div>');
    zip.file(
      "template/docs/src/App.tsx",
      "export default function Docs(){return <main>Documentation</main>}",
    );
    zip.file(
      "template/nextjs-version/package.json",
      JSON.stringify({
        scripts: { build: "next build" },
        dependencies: {
          next: "15.5.0",
          react: "19.2.1",
          "react-dom": "19.2.1",
        },
      }),
    );
    zip.file(
      "template/nextjs-version/app/page.tsx",
      "export default function Page(){return <main>Next root</main>}",
    );
    zip.file(
      "template/vite-version/package.json",
      JSON.stringify({
        scripts: { build: "vite build" },
        dependencies: { react: "19.2.1", "react-dom": "19.2.1" },
      }),
    );
    zip.file(
      "template/vite-version/index.html",
      '<div id="root"></div><script type="module" src="/src/main.tsx"></script>',
    );
    zip.file(
      "template/vite-version/src/main.tsx",
      'import App from "./App"; export default App;',
    );
    zip.file(
      "template/vite-version/src/App.tsx",
      "export default function App(){return <main>Vite root</main>}",
    );
    const source = await normalizeTwentyFirstNativeTemplateArchive({
      templateId: "multi-root-dashboard",
      slug: "multi-root-dashboard",
      version: null,
      archive: await zip.generateAsync({ type: "nodebuffer" }),
    });
    expect(source.framework).toBe("vite_react");
    expect(
      source.files
        .find((file) => file.path === "src/App.tsx")
        ?.bytes.toString("utf8"),
    ).toContain("Vite root");
    expect(
      source.files.some((file) =>
        file.bytes.toString("utf8").includes("Documentation"),
      ),
    ).toBe(false);
  });

  it("retains remote font CSS for the pinned mirroring stage", async () => {
    const providerArchive = await completeTemplateArchive("vite_react", {
      remoteFonts: true,
    });
    const source = await normalizeTwentyFirstNativeTemplateArchive({
      templateId: "remote-font-template",
      slug: "remote-font-template",
      version: null,
      archive: providerArchive,
    });
    const css = source.files
      .find((file) => file.path === "src/styles.css")!
      .bytes.toString("utf8");
    expect(css).toContain("https://fonts.googleapis.com/");
    expect(css).toContain("@font-face");
    expect(css).toContain("system-ui");
  });

  it("compiles a static Tailwind v3 theme without executing its config", async () => {
    const zip = new JSZip();
    zip.file(
      "template/package.json",
      JSON.stringify({
        scripts: { build: "vite build", prepare: "husky" },
        dependencies: { react: "19.2.1", "react-dom": "19.2.1" },
      }),
    );
    zip.file(
      "template/index.html",
      '<div id="root"></div><script type="module" src="/src/main.tsx"></script>',
    );
    zip.file(
      "template/src/main.tsx",
      'import App from "./App"; export default App;',
    );
    zip.file(
      "template/src/App.tsx",
      'import "./styles.css"; export default function App(){return <main className="container rounded-card bg-brand animate-fade-in">Tailwind v3</main>}',
    );
    zip.file(
      "template/src/styles.css",
      "@tailwind base;@tailwind components;@tailwind utilities;:root{--brand:220 80% 50%;--radius:1rem}",
    );
    zip.file(
      "template/tailwind.config.js",
      `const animate = require("tailwindcss-animate");
      module.exports = {
        content: ["./src/**/*.{ts,tsx}"],
        theme: {
          container: { center: true, padding: "2rem" },
          extend: {
            colors: { brand: "hsl(var(--brand))" },
            borderRadius: { card: "var(--radius)" },
            keyframes: { fadeIn: { "0%": { opacity: "0" }, "100%": { opacity: "1" } } },
            animation: { "fade-in": "fadeIn 300ms ease-out" }
          }
        },
        plugins: [animate]
      };`,
    );
    const source = await normalizeTwentyFirstNativeTemplateArchive({
      templateId: "tailwind-v3-static",
      slug: "tailwind-v3-static",
      version: null,
      archive: await zip.generateAsync({ type: "nodebuffer" }),
    });
    expect(source.files.map((file) => file.path)).toContain(
      "frontmind-tailwind-v3.json",
    );
    expect(source.files.map((file) => file.path)).not.toContain(
      "tailwind.config.js",
    );
    const sourceArchive = await createNativeSourceArchive(source);
    const inspected = await readNativeSourceArchive(sourceArchive);
    const token = "tailwind-v3-controlled-build";
    const validated = await validateNativeReactSourceArchive({
      archive: sourceArchive,
      receipt: {
        operationToken: token,
        baseSourceSha256: digest(sourceArchive),
        archiveSha256: digest(sourceArchive),
        fileCount: inspected.files.length + 1,
      },
      expectedOperationToken: token,
      expectedBaseSourceSha256: digest(sourceArchive),
    });
    const root = await mkdtemp(path.join(tmpdir(), "frontmind-tailwind-v3-"));
    try {
      const compiled = await compileValidatedNativeReactSource({
        root,
        source: validated,
      });
      const css = compiled.files
        .filter((file) => file.path.endsWith(".css"))
        .map((file) => file.bytes.toString("utf8"))
        .join("\n");
      expect(css).toContain("--brand");
      expect(css).toContain("var(--radius)");
      expect(css).toContain("fadeIn");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  it("never executes Template lifecycle scripts and omits them from the controlled package", async () => {
    const providerArchive = await completeTemplateArchive("vite_react", {
      lifecycle: true,
    });
    const source = await normalizeTwentyFirstNativeTemplateArchive({
      templateId: "inert-provider-script",
      slug: "inert-provider-script",
      version: null,
      archive: providerArchive,
    });
    const controlledPackage = JSON.parse(
      source.files
        .find((file) => file.path === "package.json")!
        .bytes.toString("utf8"),
    ) as { scripts?: Record<string, string> };
    expect(controlledPackage.scripts ?? {}).not.toHaveProperty("postinstall");
    expect(JSON.stringify(controlledPackage)).not.toContain("install.js");
  });

  it("normalizes the advertised get_component payload into a deterministic source archive", async () => {
    const source = normalizeTwentyFirstNativeSource({
      candidate: searchCandidate(143),
      payload: payload(143),
    });
    expect(source).toMatchObject({
      providerItemKey: "n:143",
      providerVersion: "v143",
      entrypoint: "src/provider/component.tsx",
      demoEntrypoint: "src/provider/demo.tsx",
      htmlEntrypoint: "index.html",
      appEntrypoint: "src/main.tsx",
      dependencies: expect.arrayContaining([
        { name: "react", installedVersion: "19.2.1" },
        { name: "react-dom", installedVersion: "19.2.1" },
        { name: "tailwindcss", installedVersion: "4.1.14" },
        { name: "vite", installedVersion: "7.1.9" },
      ]),
    });
    const first = await createNativeSourceArchive(source);
    const second = await createNativeSourceArchive(source);
    expect(first.equals(second)).toBe(true);
    const restored = await readNativeSourceArchive(first);
    expect(restored.manifest.sourceTreeSha256).toBe(source.sourceTreeSha256);
    expect(restored.files.map((file) => file.path)).toEqual([
      "index.html",
      "package.json",
      "src/frontmind-tailwind.css",
      "src/main.tsx",
      "src/provider/component.tsx",
      "src/provider/demo.tsx",
      "src/provider/globals.css",
    ]);
  });

  it("normalizes the official bounded sourceText contract and aligns its demo import", () => {
    const source = normalizeTwentyFirstNativeSource({
      candidate: searchCandidate(143),
      payload: {
        contractKind: "twenty_first_get_component_v1",
        status: { found: true, locked: false },
        sourceText: [
          "## Component",
          "```tsx",
          'import React from "react";',
          "export default function Hero(){return <main><h1>Native contract</h1></main>}",
          "```",
          "## Demo",
          "```tsx",
          'import React from "react";',
          'import Hero from "./hero";',
          "export default function Demo(){return <Hero />}",
          "```",
          "## Styles",
          "```css",
          "body{font-family:system-ui,sans-serif}",
          "```",
        ].join("\n"),
      },
    });
    expect(source.entrypoint).toBe("src/provider/hero.tsx");
    expect(source.demoEntrypoint).toBe("src/provider/demo.tsx");
    expect(source.files.map((file) => file.path)).toEqual(
      expect.arrayContaining([
        "src/provider/hero.tsx",
        "src/provider/demo.tsx",
        "src/provider/globals.css",
      ]),
    );
    expect(source.dependencies).toEqual(
      expect.arrayContaining([{ name: "react", installedVersion: "19.2.1" }]),
    );
  });

  it("fails fast for a locked or missing official source contract", () => {
    expect(() =>
      normalizeTwentyFirstNativeSource({
        candidate: searchCandidate(143),
        payload: {
          contractKind: "twenty_first_get_component_v1",
          status: { found: true, locked: true },
          sourceText: "upgrade required",
        },
      }),
    ).toThrow("NATIVE_SOURCE_PROVIDER_QUOTA");
    expect(() =>
      normalizeTwentyFirstNativeSource({
        candidate: searchCandidate(143),
        payload: {
          contractKind: "twenty_first_get_component_v1",
          status: { found: false, locked: false },
          sourceText: "not found",
        },
      }),
    ).toThrow("NATIVE_SOURCE_FILES_INCOMPLETE");
  });

  it("merges inline registry dependency files before validating local imports", () => {
    const source = normalizeTwentyFirstNativeSource({
      candidate: searchCandidate(144),
      payload: {
        data: {
          id: 144,
          entrypoint: "src/provider/page.tsx",
          demoEntrypoint: "src/provider/demo.tsx",
          files: {
            "src/provider/page.tsx": [
              'import { Button } from "@/components/ui/button";',
              "export default function Page(){return <main><h1>Registry page</h1><Button>Start</Button></main>}",
            ].join("\n"),
            "src/provider/demo.tsx":
              'import Page from "./page"; export default function Demo(){return <Page />}',
          },
          registryDependencies: [
            {
              slug: "button",
              files: [
                {
                  path: "src/components/ui/button.tsx",
                  content:
                    "export function Button(props: React.ButtonHTMLAttributes<HTMLButtonElement>){return <button {...props} />}",
                },
              ],
            },
          ],
        },
      },
    });
    expect(source.files.map((file) => file.path)).toContain(
      "src/components/ui/button.tsx",
    );
  });

  it("classifies an advertised registry slug without its files as an unsupported dependency", () => {
    let failure: unknown;
    try {
      normalizeTwentyFirstNativeSource({
        candidate: searchCandidate(145),
        payload: {
          data: {
            id: 145,
            componentCode: [
              'import { Button } from "@/components/ui/button";',
              "export default function Page(){return <main><h1>Missing registry file</h1><Button /></main>}",
            ].join("\n"),
            demoCode:
              'import Page from "./component"; export default function Demo(){return <Page />}',
            registryDependencies: ["button"],
          },
        },
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect(String((failure as Error).message)).toContain(
      "NATIVE_SOURCE_REGISTRY_DEPENDENCY_UNRESOLVED",
    );
    expect(classifyNativeVisualFailure(failure)).toBe("dependency_unsupported");
  });

  it("keeps browser, render and hard-safety failures in distinct categories", () => {
    expect(
      classifyNativeVisualFailure(
        new NativeVisualSourceError("NATIVE_PREVIEW_BROWSER_UNAVAILABLE"),
      ),
    ).toBe("browser_unavailable");
    expect(
      classifyNativeVisualFailure(
        new NativeVisualSourceError("NATIVE_PREVIEW_RENDER_FAILED"),
      ),
    ).toBe("render_failed");
    expect(
      classifyNativeVisualFailure(
        new NativeVisualSourceError("NATIVE_SOURCE_EXECUTION_UNSAFE"),
      ),
    ).toBe("source_unsafe");
  });

  it("rejects traversal, dynamic execution and unapproved dependencies", () => {
    expect(() =>
      normalizeTwentyFirstNativeSource({
        candidate: searchCandidate(),
        payload: {
          id: 1,
          files: { "../escape.tsx": "export default function X(){}" },
        },
      }),
    ).toThrow("NATIVE_SOURCE_PATH_UNSAFE");
    expect(() =>
      normalizeTwentyFirstNativeSource({
        candidate: searchCandidate(),
        payload: {
          ...payload(1).data,
          componentCode: "export default function X(){eval('x');return null}",
        },
      }),
    ).toThrow("NATIVE_SOURCE_EXECUTION_UNSAFE");
    expect(() =>
      normalizeTwentyFirstNativeSource({
        candidate: searchCandidate(),
        payload: {
          ...payload(1).data,
          dependencies: ["untrusted-runtime@1.0.0"],
        },
      }),
    ).toThrow("NATIVE_SOURCE_DEPENDENCY_UNSAFE");
  });

  browserIt(
    "renders the normalized React source rather than a provider screenshot",
    async () => {
      const source = normalizeTwentyFirstNativeSource({
        candidate: searchCandidate(7),
        payload: payload(7),
      });
      const sourceArchive = await createNativeSourceArchive(source);
      const preview = await renderNativeReactSourcePreview({
        sourceArchive,
        signal: new AbortController().signal,
      });
      const metadata = await sharp(preview).metadata();
      expect(metadata.format).toBe("png");
      expect(metadata.width).toBe(1440);
      expect(metadata.height).toBeGreaterThanOrEqual(1000);
    },
    30_000,
  );

  browserIt(
    "rejects a candidate whose React render throws",
    async () => {
      const source = normalizeTwentyFirstNativeSource({
        candidate: searchCandidate(8),
        payload: {
          data: {
            ...payload(8).data,
            componentCode:
              'export default function Broken(){throw new Error("boom");}',
            demoCode:
              'import Broken from "./component"; export default function Demo(){return <Broken />}',
          },
        },
      });
      const sourceArchive = await createNativeSourceArchive(source);
      await expect(
        renderNativeReactSourcePreview({
          sourceArchive,
          signal: new AbortController().signal,
        }),
      ).rejects.toThrow("NATIVE_PREVIEW_RENDER_FAILED");
    },
    30_000,
  );

  browserIt(
    "does not reject a safe visible render for viewport or semantic heuristics",
    async () => {
      const source = normalizeTwentyFirstNativeSource({
        candidate: searchCandidate(9),
        payload: {
          data: {
            ...payload(9).data,
            componentCode:
              'export default function Button(){return <button type="button">Continue</button>}',
            demoCode:
              'import Button from "./component"; export default function Demo(){return <Button />}',
          },
        },
      });
      const sourceArchive = await createNativeSourceArchive(source);
      const preview = await renderNativeReactSourcePreview({
        sourceArchive,
        signal: new AbortController().signal,
      });
      expect((await sharp(preview).metadata()).format).toBe("png");
    },
    30_000,
  );

  it("round-trips nine nested source archives and selects one by candidate ID", async () => {
    const sourceArchives = new Map<string, Buffer>();
    const candidates = [];
    for (let index = 0; index < 9; index += 1) {
      const label = String.fromCharCode(65 + index);
      const id = `candidate-${label}`;
      const source = normalizeTwentyFirstNativeSource({
        candidate: searchCandidate(index + 1),
        payload: payload(index + 1, label),
      });
      const archive = await createNativeSourceArchive(source);
      sourceArchives.set(id, archive);
      const referencePreviewSha256 = digest(`reference-${label}`);
      candidates.push({
        id,
        label,
        queryAxis: "foundation_split" as const,
        providerItemId: String(index + 1),
        providerItemKey: `n:${index + 1}`,
        providerVersion: `v${index + 1}`,
        title: `Native ${label}`,
        description: null,
        author: null,
        sourceUrl: `https://21st.dev/community/components/${index + 1}`,
        visualEvidence: {
          evidenceKind: "catalog_metadata_preview_v1" as const,
          providerItemKey: `n:${index + 1}`,
          metadataSha256: digest(`metadata-${label}`),
          providerResponseSha256: digest(`response-${label}`),
          previewSha256: referencePreviewSha256,
          taxonomyDerivationVersion: "catalog-metadata-preview-v1" as const,
          evidenceSha256: digest(`evidence-${label}`),
        },
        referencePreviewLocalAssetId: `00000000-0000-4000-8000-0000000000${String(index + 1).padStart(2, "0")}`,
        referencePreviewSha256,
        referencePerceptualHash: digest(`phash-${label}`).slice(0, 16),
        previewLocalAssetId: `10000000-0000-4000-8000-0000000000${String(index + 1).padStart(2, "0")}`,
        previewSha256: digest(`native-preview-${label}`),
        taxonomy: {
          role: "foundation" as const,
          palette: [],
          typography: [],
          layout: [],
          motion: [],
          accessibility: [],
        },
        score: 90 - index,
        rationale: "真实原生源码候选",
        sourceTreeSha256: source.sourceTreeSha256,
        sourceArchiveSha256: digest(archive),
        sourceArchivePath: `candidates/${label}/source.zip`,
        entrypoint: source.entrypoint,
        demoEntrypoint: source.demoEntrypoint,
        sourceDirectory: "source" as const,
      });
    }
    const bundle = visualSelectionBundleV5Schema.parse({
      schemaVersion: 5,
      renderer: "twenty_first_native_react_v1",
      queryPlanHash: digest("query-plan"),
      searchTarget: 162,
      displayTarget: 9,
      candidates,
      selectedCandidateId: null,
      delegated: false,
      degradedReasons: [],
    });
    const artifactBytes = await createVisualSelectionBundleV5Artifact({
      bundle,
      sourceArchives,
    });
    const restored = await readVisualSelectionBundleArtifact(artifactBytes);
    expect(restored.bundle.schemaVersion).toBe(5);
    expect(restored.archives).toHaveLength(9);
    const selected = await selectedNativeSourceArchive({
      artifactBytes,
      selectedCandidateId: "candidate-H",
    });
    expect(selected.candidate.label).toBe("H");
    expect(selected.manifest.providerItemKey).toBe("n:8");
    expect(selected.bundle.queryPlanHash).toBe(digest("query-plan"));

    const operationToken =
      "siteops-native-selected:30000000-0000-4000-8000-000000000001";
    const validated = await validateNativeReactSourceArchive({
      archive: selected.archiveBytes,
      receipt: {
        operationToken,
        baseSourceSha256: selected.archiveSha256,
        archiveSha256: selected.archiveSha256,
        fileCount: selected.files.length + 1,
      },
      expectedOperationToken: operationToken,
      expectedBaseSourceSha256: selected.archiveSha256,
    });
    expect(validated.entrypoint).toBe("src/main.tsx");
    expect(validated.files.get("index.html")?.toString("utf8")).toContain(
      'src="/src/main.tsx"',
    );
    const materialized = await materializeNativeReactSource({
      sourceZip: selected.archiveBytes,
      validatedSource: validated,
      build: {
        id: "30000000-0000-4000-8000-000000000002",
        projectId: "30000000-0000-4000-8000-000000000003",
        knowledgeSnapshotId: "30000000-0000-4000-8000-000000000004",
        workflowVersion: "2.5.0",
        selectionHash: digest("selected-native-archive"),
      },
      brief: {
        companyName: "原生候选测试企业",
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
        ],
        verifiedFacts: [
          {
            statement: "这是已核验的企业介绍。",
            sourceDocumentIds: ["source-1"],
          },
        ],
        publicAssetIds: [],
        unknowns: [],
      },
      mode: "preview",
      browserQa: false,
    });
    expect(materialized.sourceZip.equals(selected.archiveBytes)).toBe(true);
    expect(materialized.files.has("index.html")).toBe(true);

    const zip = await JSZip.loadAsync(artifactBytes);
    zip.file("unexpected.txt", "nope");
    const unexpected = await zip.generateAsync({ type: "nodebuffer" });
    await expect(readVisualSelectionBundleArtifact(unexpected)).rejects.toThrow(
      "VISUAL_SELECTION_BUNDLE_UNEXPECTED_ENTRY",
    );
  }, 45_000);

  it("round-trips V6 compiled Template archives and returns the complete Provider ZIP to Manus", async () => {
    const sourceArchives = new Map<string, Buffer>();
    const providerArchives = new Map<string, Buffer>();
    const candidates = [];
    for (let index = 0; index < 9; index += 1) {
      const label = String.fromCharCode(65 + index);
      const id = `template-candidate-${label}`;
      const providerArchive = await completeTemplateArchive("vite_react", {
        label,
      });
      const prepared = await prepareNativeTemplateCandidate({
        templateId: `template-${label}`,
        slug: `template-${label.toLowerCase()}`,
        version: `commit-${label.toLowerCase()}`,
        archive: providerArchive,
        previewUrl: `https://cdn.21st.dev/templates/${label}.png`,
        signal: new AbortController().signal,
        fetchRemoteAsset: async ({ url }) => ({
          finalUrl: url,
          mimeType: "image/png" as const,
          buffer: Buffer.from(`preview-${label}`),
          width: 1200,
          height: 800,
          sha256: digest(`preview-${label}`),
          visualSignals: {
            dominantHex: "#000000",
            brightness: 0,
            contrast: 0,
          },
        }),
        renderPreview: renderedTemplateFixture,
      });
      providerArchives.set(id, providerArchive);
      sourceArchives.set(id, prepared.sourceArchive);
      candidates.push({
        id,
        sampleId: id,
        label,
        title: `Template ${label}`,
        description: null,
        author: null,
        previewLocalAssetId: `20000000-0000-4000-8000-0000000000${String(index + 1).padStart(2, "0")}`,
        previewSha256: digest(`template-preview-${label}`),
        providerTemplateId: `template-${label}`,
        providerSlug: `template-${label.toLowerCase()}`,
        providerVersion: `commit-${label.toLowerCase()}`,
        sourceFormat: prepared.sourceFormat,
        framework: prepared.framework,
        sourceTreeSha256: prepared.sourceTreeSha256,
        sourceArchiveSha256: prepared.sourceArchiveSha256,
        sourceArchivePath: `candidates/${label}/source.zip`,
        sourceDirectory: "source",
        entrypoint: prepared.entrypoint,
      });
    }
    const bundle = visualSelectionBundleV6Schema.parse({
      schemaVersion: 6,
      renderer: "twenty_first_native_template_v1",
      queryPlanHash: digest("template-query-plan"),
      displayTarget: 9,
      candidates,
      selectedCandidateId: null,
      delegated: false,
      degradedReasons: [],
    });
    const artifactBytes = await createVisualSelectionBundleV6Artifact({
      bundle,
      sourceArchives,
    });
    const restored = await readVisualSelectionBundleArtifact(artifactBytes);
    expect(restored.bundle.schemaVersion).toBe(6);
    expect(restored.archives).toHaveLength(9);
    const selected = await selectedNativeSourceArchive({
      artifactBytes,
      selectedCandidateId: "template-candidate-H",
    });
    expect(selected.bundle.schemaVersion).toBe(6);
    expect(selected.candidate).toMatchObject({
      providerTemplateId: "template-H",
      providerSlug: "template-h",
      sourceFormat: "provider_archive_v1",
      framework: "vite_react",
    });
    expect(selected.manifest).toMatchObject({
      sourceFormat: "provider_archive_v1",
      providerTemplateId: "template-H",
      providerSlug: "template-h",
    });
    expect(
      selected.archiveBytes.equals(
        providerArchives.get("template-candidate-H")!,
      ),
    ).toBe(true);
    expect(selected.archiveSha256).toBe(digest(selected.archiveBytes));
    expect(selected.files).toHaveLength(0);
  }, 45_000);
});
