import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import JSZip from "jszip";
import { describe, expect, it, vi } from "vitest";

import {
  FRONTMIND_SITE_SOURCE_ARCHIVE_FILENAME,
  FRONTMIND_SITE_SOURCE_ARCHIVE_MIME,
  FRONTMIND_SITE_SOURCE_RECEIPT_FILENAME,
  NATIVE_RUNTIME_APP_ENTRYPOINT,
  NATIVE_RUNTIME_CONTRACT_FILENAME,
  NATIVE_RUNTIME_CONTRACT_V1,
  NATIVE_RUNTIME_CONTRACT_V1_BYTES,
  NATIVE_RUNTIME_CONTRACT_V1_SHA256,
  NATIVE_RUNTIME_EXECUTION_SHELL_FILENAME,
  NATIVE_RUNTIME_EXECUTION_SHELL_V1,
  NATIVE_RUNTIME_EXECUTION_SHELL_V1_BYTES,
  NATIVE_RUNTIME_EXECUTION_SHELL_V1_SHA256,
  NATIVE_RUNTIME_HTML_ENTRYPOINT,
  NATIVE_RUNTIME_ALLOWED_EXACT_VERSIONS,
  NATIVE_RUNTIME_APP_SHELL_V1_TEXT,
  NATIVE_RUNTIME_HTML_SHELL_V1_TEXT,
  NATIVE_RUNTIME_ROUTE_MANIFEST_EXPORT,
  NATIVE_RUNTIME_ROUTE_MODULE,
  NATIVE_SOURCE_ALLOWED_DEPENDENCIES,
  NATIVE_SOURCE_PREFLIGHT_SHA256,
  NATIVE_SOURCE_PREFLIGHT_V2_FILENAME,
  NATIVE_SOURCE_PREFLIGHT_V2_SCRIPT,
  NATIVE_SOURCE_PREFLIGHT_V2_SHA256,
  NATIVE_SOURCE_PREFLIGHT_V2_VERSION,
  NATIVE_SOURCE_PREFLIGHT_VERSION,
  NativeRuntimeContractAuditError,
  NativeReactSourceError,
  TWENTY_FIRST_NATIVE_SOURCE_SYSTEM_PROMPT,
  TWENTY_FIRST_NATIVE_TEMPLATE_V2_7_SYSTEM_PROMPT,
  auditNativeRuntimeContractV1,
  installedNativeSourceDependencyVersion,
  nativeRuntimeContractV1Schema,
  nativeRuntimeExecutionShellV1Schema,
  readNativeSourceAttachment,
  siteSourceReceiptSchema,
  siteSourceReceiptV1Schema,
  siteSourceReceiptV2Schema,
  validateNativeReactSourceArchive,
} from "./native-react-source";

const operationToken = "siteops-build:10000000-0000-4000-8000-000000000001";
const baseSourceSha256 = "a".repeat(64);
const executionBaselineSha256 = "d".repeat(64);
const contentPlanSha256 = "e".repeat(64);

function sha256(value: Buffer) {
  return createHash("sha256").update(value).digest("hex");
}

function packageJson(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    name: "frontmind-native-site",
    private: true,
    version: "1.0.0",
    scripts: { build: "vite build" },
    dependencies: {
      "@vitejs/plugin-react": "5.0.4",
      react: "19.2.1",
      "react-dom": "19.2.1",
      vite: "7.1.9",
    },
    ...overrides,
  });
}

async function sourceArchive(input?: {
  package?: Record<string, unknown>;
  source?: string | Buffer;
  mutate?: (zip: JSZip) => void;
  platform?: "DOS" | "UNIX";
}) {
  const zip = new JSZip();
  zip.file("native-site/package.json", packageJson(input?.package));
  zip.file(
    "native-site/index.html",
    '<!doctype html><html><body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body></html>',
  );
  zip.file(
    "native-site/src/main.tsx",
    input?.source ??
      'import React from "react"; import { createRoot } from "react-dom/client"; import "./style.css"; createRoot(document.getElementById("root")!).render(<main>企业官网</main>);',
  );
  zip.file(
    "native-site/src/style.css",
    "body { color: #111; background: #fff; }",
  );
  input?.mutate?.(zip);
  const archive = await zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    platform: input?.platform ?? "UNIX",
  });
  return archive;
}

function receipt(archive: Buffer, overrides: Record<string, unknown> = {}) {
  return {
    operationToken,
    baseSourceSha256,
    archiveSha256: sha256(archive),
    fileCount: 4,
    ...overrides,
  };
}

function executionShellFile(pathname: string) {
  const file = NATIVE_RUNTIME_EXECUTION_SHELL_V1.files.find(
    (candidate) => candidate.path === pathname,
  );
  if (!file) throw new Error(`Missing execution shell file: ${pathname}`);
  return file.text;
}

async function runtimeV2Archive(input?: {
  mutate?: (zip: JSZip) => void;
  routePaths?: readonly string[];
}) {
  const zip = new JSZip();
  for (const file of NATIVE_RUNTIME_EXECUTION_SHELL_V1.files) {
    zip.file(`native-site/${file.path}`, file.text);
  }
  zip.file(
    `native-site/${NATIVE_RUNTIME_ROUTE_MODULE}`,
    `import Home from "./home";\nexport const ${NATIVE_RUNTIME_ROUTE_MANIFEST_EXPORT} = ${JSON.stringify(input?.routePaths ?? ["/"])} as const;\nexport default function FrontMindRoutes() { return <Home />; }\n`,
  );
  zip.file(
    "native-site/src/home.tsx",
    "export default function Home() { return <main>企业官网</main>; }\n",
  );
  input?.mutate?.(zip);
  return zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    platform: "UNIX",
  });
}

function receiptV2(archive: Buffer, overrides: Record<string, unknown> = {}) {
  return {
    operationToken,
    baseSourceSha256,
    archiveSha256: sha256(archive),
    fileCount: 5,
    preflightVersion: NATIVE_SOURCE_PREFLIGHT_V2_VERSION,
    preflightStatus: "passed",
    preflightSha256: NATIVE_SOURCE_PREFLIGHT_V2_SHA256,
    runtimeContractVersion: NATIVE_RUNTIME_CONTRACT_V1.contractVersion,
    runtimeContractSha256: NATIVE_RUNTIME_CONTRACT_V1_SHA256,
    executionShellSha256: NATIVE_RUNTIME_EXECUTION_SHELL_V1_SHA256,
    executionBaselineSha256,
    ...overrides,
  };
}

async function writeFixtureFiles(
  root: string,
  files: Readonly<Record<string, string | Buffer>>,
) {
  for (const [relative, bytes] of Object.entries(files)) {
    const absolute = path.join(root, relative);
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, bytes);
  }
}

function runPreflightV2(root: string) {
  return spawnSync(
    process.execPath,
    [path.join(root, NATIVE_SOURCE_PREFLIGHT_V2_FILENAME), root],
    {
      cwd: root,
      encoding: "utf8",
      timeout: 120_000,
    },
  );
}

async function expectCode(promise: Promise<unknown>, code: string) {
  await expect(promise).rejects.toMatchObject<Partial<NativeReactSourceError>>({
    code,
  });
}

describe("native React source archive boundary", () => {
  it("freezes the complete-source no-redesign prompt contract", () => {
    expect(TWENTY_FIRST_NATIVE_SOURCE_SYSTEM_PROMPT).toContain(
      "不是视觉设计师",
    );
    expect(TWENTY_FIRST_NATIVE_SOURCE_SYSTEM_PROMPT).toContain("不得主动修改");
    expect(TWENTY_FIRST_NATIVE_SOURCE_SYSTEM_PROMPT).toContain(
      NATIVE_SOURCE_PREFLIGHT_V2_FILENAME,
    );
    expect(TWENTY_FIRST_NATIVE_SOURCE_SYSTEM_PROMPT).toContain(
      NATIVE_RUNTIME_CONTRACT_FILENAME,
    );
    expect(TWENTY_FIRST_NATIVE_SOURCE_SYSTEM_PROMPT).toContain(
      NATIVE_RUNTIME_EXECUTION_SHELL_FILENAME,
    );
    expect(TWENTY_FIRST_NATIVE_SOURCE_SYSTEM_PROMPT).toContain("立即结束");
    for (const coordinate of [
      "CSS",
      "className",
      "动画",
      "响应式断点",
      "组件层级",
      "import",
      "依赖",
    ]) {
      expect(TWENTY_FIRST_NATIVE_SOURCE_SYSTEM_PROMPT).toContain(coordinate);
    }
    expect(TWENTY_FIRST_NATIVE_SOURCE_SYSTEM_PROMPT).toContain(
      FRONTMIND_SITE_SOURCE_ARCHIVE_FILENAME,
    );
  });

  it("guides 2.7 template adaptation through prompt-only quality constraints", () => {
    for (const instruction of [
      "这是适配用户选中的模板，不是从零重新设计",
      "页面目的 × 用户问题 × 企业事实 × CTA",
      "产品与服务 / 产品 / 服务",
      "同一完整段落不得在多个页面或卡片中重复",
      "不得把模板改造成通用卡片站",
      "production build",
      "不要输出思考过程",
    ]) {
      expect(TWENTY_FIRST_NATIVE_TEMPLATE_V2_7_SYSTEM_PROMPT).toContain(
        instruction,
      );
    }
    expect(TWENTY_FIRST_NATIVE_TEMPLATE_V2_7_SYSTEM_PROMPT).toContain(
      FRONTMIND_SITE_SOURCE_ARCHIVE_FILENAME,
    );
    expect(TWENTY_FIRST_NATIVE_TEMPLATE_V2_7_SYSTEM_PROMPT).not.toContain(
      "视觉相似度阈值",
    );
  });

  it("freezes one exact host runtime contract and styleless execution shell", () => {
    const contract = nativeRuntimeContractV1Schema.parse(
      JSON.parse(NATIVE_RUNTIME_CONTRACT_V1_BYTES.toString("utf8")),
    );
    expect(contract).toEqual(NATIVE_RUNTIME_CONTRACT_V1);
    expect(sha256(NATIVE_RUNTIME_CONTRACT_V1_BYTES)).toBe(
      NATIVE_RUNTIME_CONTRACT_V1_SHA256,
    );
    expect(
      Object.keys(contract.dependencies.allowedExactVersions).sort(),
    ).toEqual([...NATIVE_SOURCE_ALLOWED_DEPENDENCIES].sort());
    expect(contract.dependencies.allowedExactVersions).toEqual(
      NATIVE_RUNTIME_ALLOWED_EXACT_VERSIONS,
    );
    expect(Object.isFrozen(NATIVE_RUNTIME_ALLOWED_EXACT_VERSIONS)).toBe(true);
    expect(Object.isFrozen(NATIVE_RUNTIME_CONTRACT_V1)).toBe(true);
    expect(
      Object.isFrozen(
        NATIVE_RUNTIME_CONTRACT_V1.dependencies.allowedExactVersions,
      ),
    ).toBe(true);
    for (const dependency of NATIVE_SOURCE_ALLOWED_DEPENDENCIES) {
      const frozenVersion = NATIVE_RUNTIME_ALLOWED_EXACT_VERSIONS[dependency];
      expect(contract.dependencies.allowedExactVersions[dependency]).toBe(
        frozenVersion,
      );
      expect(installedNativeSourceDependencyVersion(dependency)).toBe(
        frozenVersion,
      );
    }
    const changedContract = {
      ...NATIVE_RUNTIME_CONTRACT_V1,
      dependencies: {
        ...NATIVE_RUNTIME_CONTRACT_V1.dependencies,
        allowedExactVersions: {
          ...NATIVE_RUNTIME_CONTRACT_V1.dependencies.allowedExactVersions,
          react: "19.2.0",
        },
      },
    };
    expect(
      nativeRuntimeContractV1Schema.safeParse(changedContract).success,
    ).toBe(false);

    const shell = nativeRuntimeExecutionShellV1Schema.parse(
      JSON.parse(NATIVE_RUNTIME_EXECUTION_SHELL_V1_BYTES.toString("utf8")),
    );
    expect(shell).toEqual(NATIVE_RUNTIME_EXECUTION_SHELL_V1);
    expect(sha256(NATIVE_RUNTIME_EXECUTION_SHELL_V1_BYTES)).toBe(
      NATIVE_RUNTIME_EXECUTION_SHELL_V1_SHA256,
    );
    expect(shell.files.map((file) => file.path).sort()).toEqual(
      [
        "package.json",
        NATIVE_RUNTIME_HTML_ENTRYPOINT,
        NATIVE_RUNTIME_APP_ENTRYPOINT,
      ].sort(),
    );
    expect(shell.files.map((file) => file.text).join("\n")).not.toMatch(
      /<style|stylesheet|\.css/iu,
    );
    expect(executionShellFile(NATIVE_RUNTIME_APP_ENTRYPOINT)).toContain(
      'from "./frontmind-routes"',
    );
    expect(executionShellFile(NATIVE_RUNTIME_HTML_ENTRYPOINT)).toBe(
      NATIVE_RUNTIME_HTML_SHELL_V1_TEXT,
    );
    expect(executionShellFile(NATIVE_RUNTIME_APP_ENTRYPOINT)).toBe(
      NATIVE_RUNTIME_APP_SHELL_V1_TEXT,
    );
  });

  it("freezes the aggregate runtime preflight v2 attachment", () => {
    expect(sha256(NATIVE_SOURCE_PREFLIGHT_V2_SCRIPT)).toBe(
      NATIVE_SOURCE_PREFLIGHT_V2_SHA256,
    );
    const script = NATIVE_SOURCE_PREFLIGHT_V2_SCRIPT.toString("utf8");
    for (const coordinate of [
      NATIVE_RUNTIME_CONTRACT_FILENAME,
      NATIVE_RUNTIME_ROUTE_MODULE,
      "LIFECYCLE_SCRIPT_FORBIDDEN",
      "DEPENDENCY_VERSION_MISMATCH",
      "DYNAMIC_IMPORT_FORBIDDEN",
      "REMOTE_RESOURCE_FORBIDDEN",
      "PREFLIGHT_V2_FAILED",
    ]) {
      expect(script).toContain(coordinate);
    }
  });

  it("executes preflight v2 with exact shells, eager multi-routes, alias, Tailwind v4, and binary assets", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "frontmind-preflight-v2-"));
    try {
      const exact = NATIVE_RUNTIME_ALLOWED_EXACT_VERSIONS;
      await writeFixtureFiles(root, {
        [NATIVE_SOURCE_PREFLIGHT_V2_FILENAME]:
          NATIVE_SOURCE_PREFLIGHT_V2_SCRIPT,
        [NATIVE_RUNTIME_CONTRACT_FILENAME]: NATIVE_RUNTIME_CONTRACT_V1_BYTES,
        [NATIVE_RUNTIME_HTML_ENTRYPOINT]: NATIVE_RUNTIME_HTML_SHELL_V1_TEXT,
        [NATIVE_RUNTIME_APP_ENTRYPOINT]: NATIVE_RUNTIME_APP_SHELL_V1_TEXT,
        "package.json": `${JSON.stringify({
          name: "frontmind-preflight-parity",
          private: true,
          scripts: { build: "vite build" },
          dependencies: {
            "@tailwindcss/vite": exact["@tailwindcss/vite"],
            react: exact.react,
            "react-dom": exact["react-dom"],
            tailwindcss: exact.tailwindcss,
            vite: exact.vite,
          },
        })}\n`,
        [NATIVE_RUNTIME_ROUTE_MODULE]: `import Home from "@/home";\nimport About from "@/about";\nimport "@/style.css";\nexport const ${NATIVE_RUNTIME_ROUTE_MANIFEST_EXPORT} = ["/", "/about/"] as const;\nexport default function FrontMindRoutes() { return location.pathname === "/about/" ? <About /> : <Home />; }\n`,
        "src/home.tsx":
          'export default function Home() { return <main className="font-brand"><video controls src="/media.mp4" /><img src="/hero.avif" alt="" /></main>; }\n',
        "src/about.tsx":
          'export default function About() { return <main className="text-blue-600">About</main>; }\n',
        "src/style.css":
          '@import "tailwindcss";\n@font-face { font-family: "Brand"; src: url("/brand.ttf") format("truetype"), url("/brand.otf") format("opentype"); }\n.font-brand { font-family: "Brand"; }\n',
        "src/accepted.scss": "$brand: #123456; .sample { color: $brand; }\n",
        "public/media.mp4": Buffer.from([0, 255, 0, 255, 1, 2, 3]),
        "public/brand.ttf": Buffer.from([0, 255, 254, 253]),
        "public/brand.otf": Buffer.from([255, 0, 253, 1]),
        "public/hero.avif": Buffer.from([0, 0, 0, 32, 102, 116, 121, 112]),
      });
      await symlink(
        path.resolve("node_modules"),
        path.join(root, "node_modules"),
        "dir",
      );

      const result = runPreflightV2(root);
      if (result.status !== 0) {
        throw new Error(
          `preflight failed (${String(result.status)}): ${result.stderr}`,
        );
      }
      expect({
        status: result.status,
        stdout: result.stdout,
        stderr: result.stderr,
      }).toMatchObject({ status: 0 });
      expect(JSON.parse(result.stdout)).toMatchObject({
        version: NATIVE_SOURCE_PREFLIGHT_V2_VERSION,
        status: "passed",
        runtimeContractSha256: NATIVE_RUNTIME_CONTRACT_V1_SHA256,
      });
      await expect(
        access(
          path.join(root, ".frontmind-native-preflight-v2-vite.config.mjs"),
        ),
      ).rejects.toBeDefined();
      await expect(access(path.join(root, "dist/index.html"))).resolves.toBe(
        undefined,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 130_000);

  it("executes preflight v2 as one aggregate rejection", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "frontmind-preflight-v2-bad-"),
    );
    try {
      await writeFixtureFiles(root, {
        [NATIVE_SOURCE_PREFLIGHT_V2_FILENAME]:
          NATIVE_SOURCE_PREFLIGHT_V2_SCRIPT,
        [NATIVE_RUNTIME_CONTRACT_FILENAME]: NATIVE_RUNTIME_CONTRACT_V1_BYTES,
        [NATIVE_RUNTIME_HTML_ENTRYPOINT]: '<div id="wrong"></div>',
        [NATIVE_RUNTIME_APP_ENTRYPOINT]: "export default null;",
        "package.json": JSON.stringify({
          scripts: { build: "next build", postinstall: "node setup.js" },
          dependencies: { react: "0.0.1", next: "16.0.0" },
        }),
        [NATIVE_RUNTIME_ROUTE_MODULE]: `const Page = import("./home");\nexport const ${NATIVE_RUNTIME_ROUTE_MANIFEST_EXPORT} = ["/", "/", "BAD"] as const;\nexport default Page;\n`,
        "src/home.tsx": "export default function Home() { return null; }\n",
      });
      const result = runPreflightV2(root);
      const output = `${result.stdout}\n${result.stderr}`;
      expect(result.status).not.toBe(0);
      for (const code of [
        "PREFLIGHT_V2_FAILED",
        "HTML_SHELL_INVALID",
        "APP_SHELL_INVALID",
        "BUILD_COMMAND_INVALID",
        "LIFECYCLE_SCRIPT_FORBIDDEN",
        "DEPENDENCY_VERSION_MISMATCH",
        "FRAMEWORK_FORBIDDEN",
        "DYNAMIC_IMPORT_FORBIDDEN",
        "ROUTE_MANIFEST_INVALID",
      ]) {
        expect(output).toContain(code);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps legacy receipts readable and validates complete preflight coordinates", () => {
    const archiveSha256 = "b".repeat(64);
    const legacy = {
      operationToken,
      baseSourceSha256,
      archiveSha256,
      fileCount: 4,
    };
    expect(siteSourceReceiptV1Schema.parse(legacy)).toEqual(legacy);
    expect(
      siteSourceReceiptV1Schema.parse({
        ...legacy,
        preflightVersion: NATIVE_SOURCE_PREFLIGHT_VERSION,
        preflightStatus: "passed",
        preflightSha256: NATIVE_SOURCE_PREFLIGHT_SHA256,
      }),
    ).toMatchObject({ preflightStatus: "passed" });
    expect(
      siteSourceReceiptV1Schema.safeParse({
        ...legacy,
        preflightVersion: NATIVE_SOURCE_PREFLIGHT_VERSION,
      }).success,
    ).toBe(false);
  });

  it("discriminates historical v1 and contract-bound v2 receipts under the compatible filename", async () => {
    const archive = await runtimeV2Archive();
    const legacy = receipt(archive, { fileCount: 5 });
    const current = receiptV2(archive);
    expect(FRONTMIND_SITE_SOURCE_RECEIPT_FILENAME).toBe(
      "frontmind-site-source-receipt-v1.json",
    );
    expect(siteSourceReceiptSchema.parse(legacy)).toEqual(legacy);
    expect(siteSourceReceiptSchema.parse(current)).toEqual(current);
    expect(siteSourceReceiptV2Schema.parse(current)).toEqual(current);
    const { executionBaselineSha256: _, ...missingBaseline } = current;
    expect(siteSourceReceiptV2Schema.safeParse(missingBaseline).success).toBe(
      false,
    );
    expect(
      siteSourceReceiptV2Schema.parse({
        ...current,
        contentPlanSha256,
      }).contentPlanSha256,
    ).toBe(contentPlanSha256);
  });

  it("requires the exact frozen content plan when a 2.9 coordinate is supplied", async () => {
    const archive = await runtimeV2Archive();
    await expect(
      validateNativeReactSourceArchive({
        archive,
        receipt: receiptV2(archive, { contentPlanSha256 }),
        expectedOperationToken: operationToken,
        expectedBaseSourceSha256: baseSourceSha256,
        requiredReceiptVersion: 2,
        expectedExecutionBaselineSha256: executionBaselineSha256,
        expectedContentPlanSha256: contentPlanSha256,
      }),
    ).resolves.toBeDefined();
    await expect(
      validateNativeReactSourceArchive({
        archive,
        receipt: receiptV2(archive),
        expectedOperationToken: operationToken,
        expectedBaseSourceSha256: baseSourceSha256,
        requiredReceiptVersion: 2,
        expectedExecutionBaselineSha256: executionBaselineSha256,
        expectedContentPlanSha256: contentPlanSha256,
      }),
    ).rejects.toMatchObject({ code: "NATIVE_SOURCE_RECEIPT_INVALID" });
    await expect(
      validateNativeReactSourceArchive({
        archive,
        receipt: receipt(archive, { fileCount: 5 }),
        expectedOperationToken: operationToken,
        expectedBaseSourceSha256: baseSourceSha256,
        expectedContentPlanSha256: contentPlanSha256,
      }),
    ).rejects.toMatchObject({ code: "NATIVE_SOURCE_RECEIPT_INVALID" });
  });

  it("accepts a bounded complete React archive and normalizes one wrapper directory", async () => {
    const archive = await sourceArchive();
    const result = await validateNativeReactSourceArchive({
      archive,
      receipt: receipt(archive),
      expectedOperationToken: operationToken,
      expectedBaseSourceSha256: baseSourceSha256,
    });

    expect(result.archiveSha256).toBe(sha256(archive));
    expect(result.fileCount).toBe(4);
    expect(result.htmlEntrypoint).toBe("index.html");
    expect(result.entrypoint).toBe("src/main.tsx");
    expect([...result.files.keys()]).toEqual([
      "index.html",
      "package.json",
      "src/main.tsx",
      "src/style.css",
    ]);
  });

  it("accepts a force-v2 archive only when all runtime receipt coordinates match", async () => {
    const archive = await runtimeV2Archive();
    await expect(
      validateNativeReactSourceArchive({
        archive,
        receipt: receiptV2(archive),
        expectedOperationToken: operationToken,
        expectedBaseSourceSha256: baseSourceSha256,
        expectedExecutionBaselineSha256: executionBaselineSha256,
        requiredReceiptVersion: 2,
      }),
    ).resolves.toMatchObject({
      receipt: { preflightVersion: NATIVE_SOURCE_PREFLIGHT_V2_VERSION },
      entrypoint: NATIVE_RUNTIME_APP_ENTRYPOINT,
      fileCount: 5,
    });

    await expectCode(
      validateNativeReactSourceArchive({
        archive,
        receipt: receiptV2(archive),
        expectedOperationToken: operationToken,
        expectedBaseSourceSha256: baseSourceSha256,
        requiredReceiptVersion: 1,
      }),
      "NATIVE_SOURCE_RECEIPT_INVALID",
    );
    await expectCode(
      validateNativeReactSourceArchive({
        archive,
        receipt: receipt(archive, { fileCount: 5 }),
        expectedOperationToken: operationToken,
        expectedBaseSourceSha256: baseSourceSha256,
        expectedExecutionBaselineSha256: executionBaselineSha256,
        requiredReceiptVersion: 2,
      }),
      "NATIVE_SOURCE_RECEIPT_INVALID",
    );

    for (const overrides of [
      { runtimeContractSha256: "e".repeat(64) },
      { executionShellSha256: "e".repeat(64) },
      { executionBaselineSha256: "e".repeat(64) },
    ]) {
      await expectCode(
        validateNativeReactSourceArchive({
          archive,
          receipt: receiptV2(archive, overrides),
          expectedOperationToken: operationToken,
          expectedBaseSourceSha256: baseSourceSha256,
          expectedExecutionBaselineSha256: executionBaselineSha256,
          requiredReceiptVersion: 2,
        }),
        "NATIVE_SOURCE_RECEIPT_INVALID",
      );
    }
  });

  it("accepts V2 ZIP entry counts that include explicit directory records", async () => {
    const archive = await runtimeV2Archive({
      mutate: (zip) => {
        zip.folder("native-site");
        zip.folder("native-site/src");
        for (let index = 0; index < 8; index += 1) {
          zip.file(
            `native-site/src/fixture-${index}.ts`,
            `export const fixture${index} = ${index};\n`,
          );
        }
      },
    });
    const parsed = await JSZip.loadAsync(archive, { createFolders: false });
    const entries = Object.values(parsed.files);
    const regularFileCount = entries.filter((entry) => !entry.dir).length;

    expect(regularFileCount).toBe(13);
    expect(entries.length).toBe(15);
    await expect(
      validateNativeReactSourceArchive({
        archive,
        receipt: receiptV2(archive, { fileCount: entries.length }),
        expectedOperationToken: operationToken,
        expectedBaseSourceSha256: baseSourceSha256,
        expectedExecutionBaselineSha256: executionBaselineSha256,
        requiredReceiptVersion: 2,
      }),
    ).resolves.toMatchObject({ fileCount: regularFileCount });
  });

  it("keeps V1 file counts strict and classifies true V2 count mismatches as invalid receipts", async () => {
    const archive = await runtimeV2Archive({
      mutate: (zip) => {
        zip.folder("native-site");
        zip.folder("native-site/src");
      },
    });
    const parsed = await JSZip.loadAsync(archive, { createFolders: false });
    const entries = Object.values(parsed.files);
    const regularFileCount = entries.filter((entry) => !entry.dir).length;
    expect(entries.length).toBeGreaterThan(regularFileCount + 1);

    await expectCode(
      validateNativeReactSourceArchive({
        archive,
        receipt: receipt(archive, { fileCount: entries.length }),
        expectedOperationToken: operationToken,
        expectedBaseSourceSha256: baseSourceSha256,
        requiredReceiptVersion: 1,
      }),
      "NATIVE_SOURCE_RECEIPT_INVALID",
    );
    await expectCode(
      validateNativeReactSourceArchive({
        archive,
        receipt: receiptV2(archive, { fileCount: regularFileCount + 1 }),
        expectedOperationToken: operationToken,
        expectedBaseSourceSha256: baseSourceSha256,
        expectedExecutionBaselineSha256: executionBaselineSha256,
        requiredReceiptVersion: 2,
      }),
      "NATIVE_SOURCE_RECEIPT_INVALID",
    );
  });

  it("does not relax the authoritative non-directory file limit for V2 archives", async () => {
    const archive = await runtimeV2Archive({
      mutate: (zip) => zip.file("native-site/src/extra.ts", "export {};\n"),
    });
    await expectCode(
      validateNativeReactSourceArchive({
        archive,
        receipt: receiptV2(archive, { fileCount: 6 }),
        expectedOperationToken: operationToken,
        expectedBaseSourceSha256: baseSourceSha256,
        expectedExecutionBaselineSha256: executionBaselineSha256,
        requiredReceiptVersion: 2,
        limits: { maxFiles: 5 },
      }),
      "NATIVE_SOURCE_LIMIT_EXCEEDED",
    );
  });

  it("aggregates framework, shell, dependency, route and execution violations", async () => {
    const badFiles = new Map<string, Buffer>([
      [
        "package.json",
        Buffer.from(
          JSON.stringify({
            scripts: { build: "next build", postinstall: "node setup.js" },
            dependencies: {
              next: "16.0.0",
              react: "0.0.1",
            },
          }),
        ),
      ],
      [
        "index.html",
        Buffer.from(
          '<!doctype html><img src="https://example.test/a.png"><script type="module" src="/pages/index.tsx"></script>',
        ),
      ],
      [
        "pages/index.tsx",
        Buffer.from(
          'import Image from "next/image"; fetch("https://example.test/data"); const Page = import("./page"); eval("Page");',
        ),
      ],
      ["vite.config.ts", Buffer.from("export default {}")],
    ]);
    const audit = auditNativeRuntimeContractV1({ files: badFiles });
    expect(audit.ok).toBe(false);
    expect(audit.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining([
        "REQUIRED_FILE_MISSING",
        "BUILD_COMMAND_INVALID",
        "LIFECYCLE_SCRIPT_FORBIDDEN",
        "FRAMEWORK_FORBIDDEN",
        "DEPENDENCY_VERSION_MISMATCH",
        "DEPENDENCY_REQUIRED",
        "ROOT_ELEMENT_MISSING",
        "HTML_SHELL_INVALID",
        "APP_ENTRYPOINT_MISMATCH",
        "HOST_CONFIG_FORBIDDEN",
        "REMOTE_RESOURCE_FORBIDDEN",
        "DYNAMIC_EXECUTION_FORBIDDEN",
        "DYNAMIC_IMPORT_FORBIDDEN",
      ]),
    );

    const invalidArchive = await runtimeV2Archive({
      mutate: (zip) => {
        zip.file(
          "native-site/package.json",
          JSON.stringify({
            scripts: { build: "next build", postinstall: "node setup.js" },
            dependencies: { next: "16.0.0", react: "0.0.1" },
          }),
        );
        zip.file(
          `native-site/${NATIVE_RUNTIME_ROUTE_MODULE}`,
          'const Page = import("./home"); export default Page;',
        );
      },
    });
    await expect(
      validateNativeReactSourceArchive({
        archive: invalidArchive,
        receipt: receiptV2(invalidArchive),
        expectedOperationToken: operationToken,
        expectedBaseSourceSha256: baseSourceSha256,
        expectedExecutionBaselineSha256: executionBaselineSha256,
        requiredReceiptVersion: 2,
      }),
    ).rejects.toMatchObject<Partial<NativeRuntimeContractAuditError>>({
      code: "NATIVE_SOURCE_RUNTIME_CONTRACT_INVALID",
      audit: { ok: false },
    });
  });

  it("binds the literal eager route manifest exactly to SiteBrief slugs", () => {
    const files = new Map<string, Buffer>();
    for (const file of NATIVE_RUNTIME_EXECUTION_SHELL_V1.files) {
      files.set(file.path, Buffer.from(file.text, "utf8"));
    }
    files.set(
      NATIVE_RUNTIME_ROUTE_MODULE,
      Buffer.from(
        `import Home from "./home";\nimport About from "./about";\nimport Contact from "./contact";\nexport const ${NATIVE_RUNTIME_ROUTE_MANIFEST_EXPORT} = ["/", "/about/", "/contact/"] as const;\nexport default function FrontMindRoutes() { return location.pathname === "/about/" ? <About /> : location.pathname === "/contact/" ? <Contact /> : <Home />; }\n`,
      ),
    );
    files.set(
      "src/home.tsx",
      Buffer.from("export default function Home() { return null; }\n"),
    );
    files.set(
      "src/about.tsx",
      Buffer.from("export default function About() { return null; }\n"),
    );
    files.set(
      "src/contact.tsx",
      Buffer.from("export default function Contact() { return null; }\n"),
    );

    expect(
      auditNativeRuntimeContractV1({
        files,
        expectedRoutePaths: ["/", "/about", "contact"],
      }),
    ).toMatchObject({ ok: true, issues: [] });
    expect(
      auditNativeRuntimeContractV1({
        files,
        expectedRoutePaths: ["/", "/about", "contact"],
        requireCanonicalSitePathname: true,
      }).issues.map((issue) => issue.code),
    ).toContain("CANONICAL_PATHNAME_REQUIRED");

    files.set(
      NATIVE_RUNTIME_ROUTE_MODULE,
      Buffer.from(
        `import Home from "./home";\nimport About from "./about";\nimport Contact from "./contact";\nexport const ${NATIVE_RUNTIME_ROUTE_MANIFEST_EXPORT} = ["/", "/about/", "/contact/"] as const;\ntype PreviewWindow = Window & { canonicalSitePathname?: () => string };\nconst pathname = () => (window as PreviewWindow).canonicalSitePathname?.() ?? window.location.pathname;\nexport default function FrontMindRoutes() { const route = pathname(); return route === "/about/" ? <About /> : route === "/contact/" ? <Contact /> : <Home />; }\n`,
      ),
    );
    expect(
      auditNativeRuntimeContractV1({
        files,
        expectedRoutePaths: ["/", "/about", "contact"],
        requireCanonicalSitePathname: true,
      }),
    ).toMatchObject({ ok: true, issues: [] });
    expect(
      auditNativeRuntimeContractV1({
        files,
        expectedRoutePaths: ["/", "/contact/"],
      }).issues.map((issue) => issue.code),
    ).toContain("ROUTE_MANIFEST_MISMATCH");

    files.set(
      NATIVE_RUNTIME_ROUTE_MODULE,
      Buffer.from(
        'import Home from "./home";\nexport default function FrontMindRoutes() { return <Home />; }\n',
      ),
    );
    expect(
      auditNativeRuntimeContractV1({
        files,
        expectedRoutePaths: ["/"],
      }).issues.map((issue) => issue.code),
    ).toContain("ROUTE_MANIFEST_INVALID");

    files.set(
      NATIVE_RUNTIME_ROUTE_MODULE,
      Buffer.from(
        `import Home from "./home";\nexport const ${NATIVE_RUNTIME_ROUTE_MANIFEST_EXPORT} = ["/"] as const;\nexport default function FrontMindRoutes() { return <Home />; }\n`,
      ),
    );
    expect(
      auditNativeRuntimeContractV1({
        files,
        expectedRoutePaths: ["/"],
        requireCanonicalSitePathname: true,
      }),
    ).toMatchObject({ ok: true, issues: [] });
  });

  it("reports precise ZIP, package syntax, package shape, and file-type reasons", async () => {
    const invalidZip = Buffer.from("not-a-zip", "utf8");
    await expectCode(
      validateNativeReactSourceArchive({
        archive: invalidZip,
        receipt: receipt(invalidZip, { fileCount: 1 }),
        expectedOperationToken: operationToken,
        expectedBaseSourceSha256: baseSourceSha256,
      }),
      "NATIVE_SOURCE_ZIP_INVALID",
    );

    const invalidPackageJson = await sourceArchive({
      mutate: (zip) => zip.file("native-site/package.json", "{invalid"),
    });
    await expectCode(
      validateNativeReactSourceArchive({
        archive: invalidPackageJson,
        receipt: receipt(invalidPackageJson),
        expectedOperationToken: operationToken,
        expectedBaseSourceSha256: baseSourceSha256,
      }),
      "NATIVE_SOURCE_PACKAGE_JSON_INVALID",
    );

    const invalidPackageShape = await sourceArchive({
      mutate: (zip) => zip.file("native-site/package.json", "[]"),
    });
    await expectCode(
      validateNativeReactSourceArchive({
        archive: invalidPackageShape,
        receipt: receipt(invalidPackageShape),
        expectedOperationToken: operationToken,
        expectedBaseSourceSha256: baseSourceSha256,
      }),
      "NATIVE_SOURCE_PACKAGE_SHAPE_INVALID",
    );

    const forbiddenType = await sourceArchive({
      mutate: (zip) => zip.file("native-site/bin/tool.exe", "binary"),
    });
    await expectCode(
      validateNativeReactSourceArchive({
        archive: forbiddenType,
        receipt: receipt(forbiddenType, { fileCount: 5 }),
        expectedOperationToken: operationToken,
        expectedBaseSourceSha256: baseSourceSha256,
      }),
      "NATIVE_SOURCE_FILE_TYPE_FORBIDDEN",
    );
  });

  it("rejects dependency ranges so preview and production use one exact runtime", async () => {
    const archive = await sourceArchive({
      package: {
        dependencies: {
          react: "^19.2.1",
          "react-dom": "19.2.1",
        },
      },
    });
    await expectCode(
      validateNativeReactSourceArchive({
        archive,
        receipt: receipt(archive),
        expectedOperationToken: operationToken,
        expectedBaseSourceSha256: baseSourceSha256,
      }),
      "NATIVE_SOURCE_DEPENDENCY_VERSION_MISMATCH",
    );
  });

  it("rejects operation, base-source and output archive coordinate mismatches", async () => {
    const archive = await sourceArchive();
    await expectCode(
      validateNativeReactSourceArchive({
        archive,
        receipt: receipt(archive, { operationToken: "siteops-build:other" }),
        expectedOperationToken: operationToken,
        expectedBaseSourceSha256: baseSourceSha256,
      }),
      "NATIVE_SOURCE_TOKEN_MISMATCH",
    );
    await expectCode(
      validateNativeReactSourceArchive({
        archive,
        receipt: receipt(archive, { baseSourceSha256: "b".repeat(64) }),
        expectedOperationToken: operationToken,
        expectedBaseSourceSha256: baseSourceSha256,
      }),
      "NATIVE_SOURCE_BASE_HASH_MISMATCH",
    );
    await expectCode(
      validateNativeReactSourceArchive({
        archive,
        receipt: receipt(archive, { archiveSha256: "c".repeat(64) }),
        expectedOperationToken: operationToken,
        expectedBaseSourceSha256: baseSourceSha256,
      }),
      "NATIVE_SOURCE_ARCHIVE_HASH_MISMATCH",
    );
  });

  it("rejects traversal paths even when JSZip exposes a sanitized entry name", async () => {
    const archive = await sourceArchive({
      mutate: (zip) => zip.file("../escape.tsx", "export default 1"),
    });
    await expectCode(
      validateNativeReactSourceArchive({
        archive,
        receipt: receipt(archive, { fileCount: 5 }),
        expectedOperationToken: operationToken,
        expectedBaseSourceSha256: baseSourceSha256,
      }),
      "NATIVE_SOURCE_PATH_INVALID",
    );
  });

  it("rejects Unix symbolic links", async () => {
    const archive = await sourceArchive({
      mutate: (zip) =>
        zip.file("native-site/src/link.tsx", "main.tsx", {
          unixPermissions: 0o120777,
        }),
      platform: "UNIX",
    });
    await expectCode(
      validateNativeReactSourceArchive({
        archive,
        receipt: receipt(archive, { fileCount: 5 }),
        expectedOperationToken: operationToken,
        expectedBaseSourceSha256: baseSourceSha256,
      }),
      "NATIVE_SOURCE_SYMLINK_FORBIDDEN",
    );
  });

  it("rejects decompressed files beyond the bounded single-file budget", async () => {
    const archive = await sourceArchive({ source: "export default 'large';" });
    await expectCode(
      validateNativeReactSourceArchive({
        archive,
        receipt: receipt(archive),
        expectedOperationToken: operationToken,
        expectedBaseSourceSha256: baseSourceSha256,
        limits: { maxSingleFileBytes: 12 },
      }),
      "NATIVE_SOURCE_LIMIT_EXCEEDED",
    );
  });

  it("rejects invalid UTF-8 in a source text file", async () => {
    const archive = await sourceArchive({
      source: Buffer.from([0xff, 0xfe, 0xfd]),
    });
    await expectCode(
      validateNativeReactSourceArchive({
        archive,
        receipt: receipt(archive),
        expectedOperationToken: operationToken,
        expectedBaseSourceSha256: baseSourceSha256,
      }),
      "NATIVE_SOURCE_TEXT_INVALID",
    );
  });

  it("rejects secrets and the operation token in source text", async () => {
    const archive = await sourceArchive({
      source:
        'const clientSecret = "client-secret-value-123456789"; export default clientSecret;',
    });
    await expectCode(
      validateNativeReactSourceArchive({
        archive,
        receipt: receipt(archive),
        expectedOperationToken: operationToken,
        expectedBaseSourceSha256: baseSourceSha256,
      }),
      "NATIVE_SOURCE_SECRET_FORBIDDEN",
    );
  });

  it("rejects the raw operation-token bytes even inside a binary asset", async () => {
    const archive = await sourceArchive({
      mutate: (zip) =>
        zip.file(
          "native-site/public/opaque.png",
          Buffer.concat([
            Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00]),
            Buffer.from(operationToken, "utf8"),
            Buffer.from([0x00, 0xff]),
          ]),
        ),
    });
    await expectCode(
      validateNativeReactSourceArchive({
        archive,
        receipt: receipt(archive, { fileCount: 5 }),
        expectedOperationToken: operationToken,
        expectedBaseSourceSha256: baseSourceSha256,
      }),
      "NATIVE_SOURCE_SECRET_FORBIDDEN",
    );
  });

  it("allows only exact Tailwind and archive-local relative CSS imports", async () => {
    const archive = await sourceArchive({
      mutate: (zip) => {
        zip.file(
          "native-site/src/style.css",
          '@import "tailwindcss";\n@import "./theme.css";\nbody{color:#111}',
        );
        zip.file("native-site/src/theme.css", ".hero{display:grid}");
      },
    });
    await expect(
      validateNativeReactSourceArchive({
        archive,
        receipt: receipt(archive, { fileCount: 5 }),
        expectedOperationToken: operationToken,
        expectedBaseSourceSha256: baseSourceSha256,
      }),
    ).resolves.toMatchObject({ entrypoint: "src/main.tsx" });

    for (const forbiddenImport of [
      '@import "file:/tmp/host.css";',
      '@import "/absolute.css";',
      '@import "../escape.css";',
      '@import "https://example.test/remote.css";',
    ]) {
      const invalid = await sourceArchive({
        mutate: (zip) => zip.file("native-site/src/style.css", forbiddenImport),
      });
      await expectCode(
        validateNativeReactSourceArchive({
          archive: invalid,
          receipt: receipt(invalid),
          expectedOperationToken: operationToken,
          expectedBaseSourceSha256: baseSourceSha256,
        }),
        "NATIVE_SOURCE_STYLE_IMPORT_FORBIDDEN",
      );
    }
  });

  it("rejects Tailwind directives that load executable plugins or config", async () => {
    for (const directive of [
      '@plugin "./plugin.js";',
      '@config "./tailwind.config.js";',
    ]) {
      const archive = await sourceArchive({
        mutate: (zip) => zip.file("native-site/src/style.css", directive),
      });
      await expectCode(
        validateNativeReactSourceArchive({
          archive,
          receipt: receipt(archive),
          expectedOperationToken: operationToken,
          expectedBaseSourceSha256: baseSourceSha256,
        }),
        "NATIVE_SOURCE_STYLE_EXECUTION_FORBIDDEN",
      );
    }
  });

  it("rejects dynamic execution and dynamic imports", async () => {
    for (const source of [
      'eval("alert(1)")',
      'const lazy = import("./other")',
      'const compile = new Function("return 1")',
    ]) {
      const archive = await sourceArchive({ source });
      await expectCode(
        validateNativeReactSourceArchive({
          archive,
          receipt: receipt(archive),
          expectedOperationToken: operationToken,
          expectedBaseSourceSha256: baseSourceSha256,
        }),
        "NATIVE_SOURCE_DYNAMIC_EXECUTION_FORBIDDEN",
      );
    }
  });

  it("rejects browser network requests, remote frames and unsafe HTML injection", async () => {
    const cases = [
      {
        source: 'fetch("https://example.test/data")',
        code: "NATIVE_SOURCE_NETWORK_FORBIDDEN",
      },
      {
        source: "const x = { dangerouslySetInnerHTML: { __html: value } };",
        code: "NATIVE_SOURCE_HTML_INJECTION_FORBIDDEN",
      },
    ];
    for (const item of cases) {
      const archive = await sourceArchive({ source: item.source });
      await expectCode(
        validateNativeReactSourceArchive({
          archive,
          receipt: receipt(archive),
          expectedOperationToken: operationToken,
          expectedBaseSourceSha256: baseSourceSha256,
        }),
        item.code,
      );
    }

    const framedArchive = await sourceArchive({
      mutate: (zip) =>
        zip.file(
          "native-site/index.html",
          '<!doctype html><iframe src="https://evil.example"></iframe><script type="module" src="/src/main.tsx"></script>',
        ),
    });
    await expectCode(
      validateNativeReactSourceArchive({
        archive: framedArchive,
        receipt: receipt(framedArchive),
        expectedOperationToken: operationToken,
        expectedBaseSourceSha256: baseSourceSha256,
      }),
      "NATIVE_SOURCE_NETWORK_FORBIDDEN",
    );
  });

  it("rejects lifecycle scripts and dependencies outside the compile allowlist", async () => {
    const lifecycleArchive = await sourceArchive({
      package: {
        scripts: { build: "vite build", postinstall: "node setup.js" },
      },
    });
    await expectCode(
      validateNativeReactSourceArchive({
        archive: lifecycleArchive,
        receipt: receipt(lifecycleArchive),
        expectedOperationToken: operationToken,
        expectedBaseSourceSha256: baseSourceSha256,
      }),
      "NATIVE_SOURCE_LIFECYCLE_SCRIPT_FORBIDDEN",
    );

    const dependencyArchive = await sourceArchive({
      package: { dependencies: { react: "19.2.1", "unknown-kit": "1.0.0" } },
    });
    await expectCode(
      validateNativeReactSourceArchive({
        archive: dependencyArchive,
        receipt: receipt(dependencyArchive),
        expectedOperationToken: operationToken,
        expectedBaseSourceSha256: baseSourceSha256,
      }),
      "NATIVE_SOURCE_DEPENDENCY_FORBIDDEN",
    );
  });
});

describe("native source binary attachment boundary", () => {
  it("accepts only the exact ZIP filename and MIME from a bounded data URL", async () => {
    const body = Buffer.from("PK bounded source", "utf8");
    await expect(
      readNativeSourceAttachment({
        attachment: {
          filename: FRONTMIND_SITE_SOURCE_ARCHIVE_FILENAME,
          contentType: FRONTMIND_SITE_SOURCE_ARCHIVE_MIME,
          url: `data:${FRONTMIND_SITE_SOURCE_ARCHIVE_MIME};base64,${body.toString("base64")}`,
        },
      }),
    ).resolves.toEqual(body);

    for (const contentType of [
      "Application/ZIP; charset=binary",
      "application/x-zip-compressed",
      "application/octet-stream",
    ]) {
      await expect(
        readNativeSourceAttachment({
          attachment: {
            filename: FRONTMIND_SITE_SOURCE_ARCHIVE_FILENAME,
            contentType,
            url: `data:${FRONTMIND_SITE_SOURCE_ARCHIVE_MIME};base64,${body.toString("base64")}`,
          },
        }),
      ).resolves.toEqual(body);
    }

    await expectCode(
      readNativeSourceAttachment({
        attachment: {
          filename: "other.zip",
          contentType: FRONTMIND_SITE_SOURCE_ARCHIVE_MIME,
          url: `data:${FRONTMIND_SITE_SOURCE_ARCHIVE_MIME};base64,${body.toString("base64")}`,
        },
      }),
      "NATIVE_SOURCE_ATTACHMENT_INVALID",
    );
  });

  it("uses an injected pinned HTTPS fetch and enforces the response MIME", async () => {
    const body = Buffer.from("PK fetched source", "utf8");
    const fetchPinned = vi.fn(async () => ({
      response: new Response(body, {
        status: 200,
        headers: {
          "content-type": FRONTMIND_SITE_SOURCE_ARCHIVE_MIME,
          "content-length": String(body.length),
        },
      }),
      finalUrl: { origin: "https://files.example.test", path: "/source" },
    }));
    await expect(
      readNativeSourceAttachment({
        attachment: {
          filename: FRONTMIND_SITE_SOURCE_ARCHIVE_FILENAME,
          contentType: FRONTMIND_SITE_SOURCE_ARCHIVE_MIME,
          url: "https://files.example.test/source.zip?opaque=1",
        },
        fetchPinned,
      }),
    ).resolves.toEqual(body);
    expect(fetchPinned).toHaveBeenCalledTimes(1);

    for (const responseContentType of [
      "Application/ZIP; charset=binary",
      "application/x-zip-compressed",
      "application/octet-stream",
    ]) {
      await expect(
        readNativeSourceAttachment({
          attachment: {
            filename: FRONTMIND_SITE_SOURCE_ARCHIVE_FILENAME,
            contentType: FRONTMIND_SITE_SOURCE_ARCHIVE_MIME,
            url: "https://files.example.test/source.zip?opaque=2",
          },
          fetchPinned: vi.fn(async () => ({
            response: new Response(body, {
              status: 200,
              headers: { "content-type": responseContentType },
            }),
            finalUrl: { origin: "https://files.example.test", path: "/source" },
          })) as never,
        }),
      ).resolves.toEqual(body);
    }

    await expectCode(
      readNativeSourceAttachment({
        attachment: {
          filename: FRONTMIND_SITE_SOURCE_ARCHIVE_FILENAME,
          contentType: FRONTMIND_SITE_SOURCE_ARCHIVE_MIME,
          url: "https://files.example.test/source.zip?opaque=3",
        },
        fetchPinned: vi.fn(async () => ({
          response: new Response(body, {
            status: 200,
            headers: { "content-type": "text/html" },
          }),
          finalUrl: { origin: "https://files.example.test", path: "/source" },
        })) as never,
      }),
      "NATIVE_SOURCE_ATTACHMENT_INVALID",
    );
  });

  it("classifies transient attachment download failures for bounded recovery", async () => {
    const attachment = {
      filename: FRONTMIND_SITE_SOURCE_ARCHIVE_FILENAME,
      contentType: FRONTMIND_SITE_SOURCE_ARCHIVE_MIME,
      url: "https://files.example.test/source.zip",
    };
    await expect(
      readNativeSourceAttachment({
        attachment,
        fetchPinned: vi.fn(async () => ({
          response: new Response(null, { status: 503 }),
          finalUrl: { origin: "https://files.example.test", path: "/source" },
        })) as never,
      }),
    ).rejects.toMatchObject({
      code: "NATIVE_SOURCE_ATTACHMENT_UNAVAILABLE",
      retryable: true,
      status: 503,
    });
    await expect(
      readNativeSourceAttachment({
        attachment,
        fetchPinned: vi.fn(async () => {
          throw new Error("connection reset");
        }) as never,
      }),
    ).rejects.toMatchObject({
      code: "NATIVE_SOURCE_ATTACHMENT_UNAVAILABLE",
      retryable: true,
      status: null,
    });
  });
});
