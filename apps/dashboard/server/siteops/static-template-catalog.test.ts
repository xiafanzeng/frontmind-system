import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";
import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";

import {
  FROZEN_STATIC_TEMPLATE_CATALOG,
  STATIC_TEMPLATE_CATALOG_ENTRY_COUNT,
  STATIC_TEMPLATE_CATALOG_PAGE_COUNT,
  STATIC_TEMPLATE_CATALOG_PAGE_SIZE,
  STATIC_TEMPLATE_CATALOG_VERSION,
  StaticTemplateCatalogError,
  getStaticTemplateCatalogReadiness,
  inspectStaticTemplateSourceArchive,
  loadActiveStaticTemplateCatalog,
  loadStaticTemplateCatalogVersion,
  openStaticTemplateCatalogSource,
  openStaticTemplateCatalogVersionPreview,
  openStaticTemplateCatalogVersionSource,
  readStaticTemplateCatalogPreview,
  seedStaticTemplateCatalog,
  type StaticTemplateExecutionAdmissionBuilder,
} from "./static-template-catalog";
import {
  NATIVE_RUNTIME_CONTRACT_V1_SHA256,
  NATIVE_RUNTIME_EXECUTION_SHELL_V1_SHA256,
} from "./native-react-source";

const temporaryRoots: string[] = [];

async function temporaryRoot() {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "frontmind-static-catalog-"),
  );
  temporaryRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function sourceArchive(
  entries: Array<{
    name: string;
    value: string | Buffer;
    unixPermissions?: number;
  }> = [],
) {
  const zip = new JSZip();
  zip.file("template/README.md", "# Template\n");
  zip.file("template/src/with space.tsx", "export default function Page(){}\n");
  zip.file("template/node_modules/@types/example/index.d.ts", "export {};\n");
  zip.file(
    "template/src/app/[...slug]/page.tsx",
    "export default function Page(){}\n",
  );
  zip.file(
    "template/src/app/api/route.ts",
    "export const GET=()=>new Response();\n",
  );
  zip.file("template/.env.example", "SAFE_EXAMPLE=true\n");
  zip.file("template/.npmrc", "legacy-peer-deps=true\n");
  zip.file("template/docs/readme-link", "../README.md", {
    unixPermissions: 0o120777,
  });
  for (const entry of entries) {
    zip.file(entry.name, entry.value, {
      unixPermissions: entry.unixPermissions,
    });
  }
  return zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    platform: "UNIX",
  });
}

async function inspectBytes(bytes: Buffer) {
  const root = await temporaryRoot();
  const target = path.join(root, "source.zip");
  await writeFile(target, bytes);
  return inspectStaticTemplateSourceArchive(target);
}

const testExecutionAdmissionBuilder: StaticTemplateExecutionAdmissionBuilder =
  async ({ definition, rawSourceSha256 }) => {
    if (definition.candidateId !== "static-template-22-hirael-agency-landing") {
      return {
        status: "unavailable",
        code: "STATIC_TEMPLATE_EXECUTION_ADMISSION_PENDING",
        reason: "该测试模板尚未完成执行准入。",
      };
    }
    const normalizedSource = await sourceArchive([
      {
        name: "template/admission-binding.txt",
        value: rawSourceSha256,
      },
    ]);
    const digest = (value: string) =>
      createHash("sha256").update(value).digest("hex");
    return {
      status: "admitted",
      framework: "vite_react",
      normalizedSource,
      sourceTreeSha256: digest(`tree:${rawSourceSha256}`),
      runtimeContractSha256: NATIVE_RUNTIME_CONTRACT_V1_SHA256,
      executionShellSha256: NATIVE_RUNTIME_EXECUTION_SHELL_V1_SHA256,
      contract: Buffer.from('{"passed":true}\n'),
      dist: Buffer.from("PK-test-dist"),
      qa: Buffer.from('{"passed":true}\n'),
      browserReceipt: Buffer.from('{"browser":{"available":true}}\n'),
      qaStatus: "passed_with_warnings",
    };
  };

function frozenSourceUrl(
  definition: (typeof FROZEN_STATIC_TEMPLATE_CATALOG)[number],
) {
  return `https://codeload.github.com/${definition.sourceOwner}/${definition.sourceRepo}/zip/${definition.sourceCommitSha}`;
}

async function catalogSourceArchive(
  definitions: Array<(typeof FROZEN_STATIC_TEMPLATE_CATALOG)[number]>,
) {
  const first = definitions[0]!;
  const root = `${first.sourceRepo}-${first.sourceCommitSha}`;
  const zip = new JSZip();
  zip.file(`${root}/README.md`, `# ${first.sourceRepo}\n`);
  if (first.sourceRepo === "hirael") {
    for (const supportPath of [
      "package.json",
      "pnpm-lock.yaml",
      "pnpm-workspace.yaml",
      "tsconfig.json",
      "next.config.ts",
      "postcss.config.mjs",
      "components.json",
      "registry.json",
      "LICENSE",
      "lib/utils.ts",
    ]) {
      zip.file(`${root}/${supportPath}`, `${supportPath}\n`);
    }
  }
  if (definitions.every((definition) => definition.sourceSubdirectory)) {
    zip.file(`${root}/unselected/.env.production`, "NOT_RETAINED=true\n");
  }
  for (const definition of definitions) {
    const base = definition.sourceSubdirectory
      ? `${root}/${definition.sourceSubdirectory}`
      : `${root}/src`;
    zip.file(
      `${base}/${definition.candidateId}.tsx`,
      `export const candidate = ${JSON.stringify(definition.candidateId)};\n`,
    );
  }
  return zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    platform: "UNIX",
  });
}

describe("static Template catalog", () => {
  it("freezes exactly four ordered pages of eight unique provider candidates", () => {
    expect(FROZEN_STATIC_TEMPLATE_CATALOG).toHaveLength(
      STATIC_TEMPLATE_CATALOG_ENTRY_COUNT,
    );
    expect(STATIC_TEMPLATE_CATALOG_PAGE_SIZE).toBe(8);
    expect(STATIC_TEMPLATE_CATALOG_PAGE_COUNT).toBe(4);
    expect(
      new Set(FROZEN_STATIC_TEMPLATE_CATALOG.map((entry) => entry.candidateId))
        .size,
    ).toBe(32);
    expect(
      new Set(
        FROZEN_STATIC_TEMPLATE_CATALOG.map((entry) => entry.providerTemplateId),
      ).size,
    ).toBe(32);
    expect(
      new Set(
        FROZEN_STATIC_TEMPLATE_CATALOG.map((entry) =>
          [
            entry.sourceOwner,
            entry.sourceRepo,
            entry.sourceCommitSha,
            entry.sourceSubdirectory ?? "",
          ].join("/"),
        ),
      ).size,
    ).toBe(32);
    expect(
      FROZEN_STATIC_TEMPLATE_CATALOG.filter(
        (entry) => entry.sourceRepo === "hirael",
      ).map((entry) => entry.sourceSubdirectory),
    ).toEqual([
      "registry/hirael/templates/nexacore",
      "registry/hirael/templates/asme",
      "registry/hirael/templates/velorah",
      "registry/hirael/templates/rivr",
      "registry/hirael/templates/usd-halo",
      "registry/hirael/templates/portfolio",
      "registry/hirael/templates/mindloop",
      "registry/hirael/templates/agency-landing",
      "registry/hirael/templates/creative-studio",
    ]);
    expect(FROZEN_STATIC_TEMPLATE_CATALOG.map((entry) => entry.order)).toEqual(
      Array.from({ length: 32 }, (_, index) => index + 1),
    );
  });

  it("keeps provider source inert while accepting spaces, @types, catch-all/API routes and an in-root documentation symlink", async () => {
    await expect(inspectBytes(await sourceArchive())).resolves.toMatchObject({
      fileCount: expect.any(Number),
      expandedBytes: expect.any(Number),
    });
  });

  it.each([
    {
      name: "secret file",
      entries: [{ name: "template/.env.production", value: "TOKEN=secret\n" }],
      code: "STATIC_TEMPLATE_CATALOG_ZIP_SECRET_FILE",
    },
    {
      name: "escaping symlink",
      entries: [
        {
          name: "template/docs/outside-link",
          value: "../../../etc/passwd",
          unixPermissions: 0o120777,
        },
      ],
      code: "STATIC_TEMPLATE_CATALOG_ZIP_SYMLINK_ESCAPES",
    },
    {
      name: "embedded npm credential",
      entries: [
        {
          name: "template/.npmrc",
          value: "//registry.npmjs.org/:_authToken=literal-secret-value\n",
        },
      ],
      code: "STATIC_TEMPLATE_CATALOG_ZIP_SECRET_FILE",
    },
  ])("rejects a $name", async ({ entries, code }) => {
    await expect(
      inspectBytes(await sourceArchive(entries)),
    ).rejects.toMatchObject({ code });
  });

  it("rejects a corrupt ZIP envelope", async () => {
    await expect(
      inspectBytes(Buffer.from("PK\\x03\\x04broken")),
    ).rejects.toBeInstanceOf(StaticTemplateCatalogError);
  });

  it("rejects a ZIP whose stored payload no longer matches its CRC", async () => {
    const zip = new JSZip();
    zip.file("template/source.tsx", "unique-payload-for-crc-check");
    const bytes = await zip.generateAsync({
      type: "nodebuffer",
      compression: "STORE",
      platform: "UNIX",
    });
    const payload = Buffer.from("unique-payload-for-crc-check");
    const offset = bytes.indexOf(payload);
    expect(offset).toBeGreaterThan(0);
    bytes[offset] = bytes[offset]! ^ 0xff;
    await expect(inspectBytes(bytes)).rejects.toMatchObject({
      code: "STATIC_TEMPLATE_CATALOG_ZIP_CRC_INVALID",
    });
  });

  it("seeds 32 source/preview pairs atomically, then runs fully offline from the active version", async () => {
    const root = await temporaryRoot();
    const sourceDefinitions = new Map<
      string,
      Array<(typeof FROZEN_STATIC_TEMPLATE_CATALOG)[number]>
    >();
    for (const definition of FROZEN_STATIC_TEMPLATE_CATALOG) {
      const url = frozenSourceUrl(definition);
      sourceDefinitions.set(url, [
        ...(sourceDefinitions.get(url) ?? []),
        definition,
      ]);
    }
    const sources = new Map<string, Buffer>();
    await Promise.all(
      [...sourceDefinitions].map(async ([url, definitions]) => {
        sources.set(url, await catalogSourceArchive(definitions));
      }),
    );
    const previews = new Map<string, Buffer>();
    await Promise.all(
      FROZEN_STATIC_TEMPLATE_CATALOG.map(async (definition, index) => {
        previews.set(
          definition.previewUrl,
          await sharp({
            create: {
              width: 16,
              height: 9,
              channels: 4,
              background: {
                r: (index * 47) % 256,
                g: (index * 83) % 256,
                b: (index * 131) % 256,
                alpha: 1,
              },
            },
          })
            .png()
            .toBuffer(),
        );
      }),
    );
    let requests = 0;
    const fetchImpl = (async (input: string | URL | Request) => {
      requests += 1;
      const url = String(input);
      if (url.startsWith("https://codeload.github.com/")) {
        const archive = sources.get(url);
        if (!archive) return new Response(null, { status: 404 });
        return new Response(archive, {
          status: 200,
          headers: { "content-length": String(archive.byteLength) },
        });
      }
      const preview = previews.get(url);
      if (!preview) return new Response(null, { status: 404 });
      return new Response(preview, {
        status: 200,
        headers: { "content-length": String(preview.byteLength) },
      });
    }) as typeof fetch;

    const first = await seedStaticTemplateCatalog({
      rootDir: root,
      fetchImpl,
      concurrency: 3,
      executionAdmissionBuilder: testExecutionAdmissionBuilder,
    });
    expect(first.reused).toBe(false);
    expect(first.catalog.catalogVersion).toBe(STATIC_TEMPLATE_CATALOG_VERSION);
    expect(first.catalog.entries).toHaveLength(32);
    expect(
      first.catalog.entries.filter((entry) => entry.page === 1),
    ).toHaveLength(8);
    expect(
      first.catalog.entries.filter((entry) => entry.page === 4),
    ).toHaveLength(8);
    expect(
      new Set(first.catalog.entries.map((entry) => entry.previewSha256)).size,
    ).toBe(32);
    expect(
      new Set(first.catalog.entries.map((entry) => entry.sourceSha256)).size,
    ).toBe(32);
    expect(
      first.catalog.entries
        .filter((entry) => entry.executionAdmission.status === "admitted")
        .map((entry) => entry.candidateId),
    ).toEqual(["static-template-22-hirael-agency-landing"]);
    expect(requests).toBe(sources.size + previews.size);

    const hirael = first.catalog.entries.filter(
      (entry) => entry.sourceRepo === "hirael",
    );
    expect(hirael).toHaveLength(9);
    const projected = await JSZip.loadAsync(
      await readFile(path.join(root, hirael[0]!.rawSourcePath)),
    );
    const projectedNames = Object.keys(projected.files);
    expect(
      projectedNames.some((name) =>
        name.includes("registry/hirael/templates/nexacore/"),
      ),
    ).toBe(true);
    expect(
      projectedNames.some((name) =>
        name.includes("registry/hirael/templates/asme/"),
      ),
    ).toBe(false);
    for (const supportPath of [
      "package.json",
      "pnpm-lock.yaml",
      "pnpm-workspace.yaml",
      "tsconfig.json",
      "next.config.ts",
      "postcss.config.mjs",
      "components.json",
      "registry.json",
      "LICENSE",
      "README.md",
      "lib/utils.ts",
    ]) {
      expect(
        projectedNames.some((name) => name.endsWith(`/${supportPath}`)),
        supportPath,
      ).toBe(true);
    }

    const offlineFetch = (async () => {
      throw new Error("network must not be used after activation");
    }) as typeof fetch;
    const second = await seedStaticTemplateCatalog({
      rootDir: root,
      fetchImpl: offlineFetch,
    });
    expect(second.reused).toBe(true);
    expect(requests).toBe(sources.size + previews.size);
    await expect(
      loadActiveStaticTemplateCatalog({ rootDir: root }),
    ).resolves.toMatchObject({ entryCount: 32, pageSize: 8, pageCount: 4 });
    await expect(
      getStaticTemplateCatalogReadiness({ rootDir: root }),
    ).resolves.toMatchObject({
      ready: true,
      activeCatalogVersion: STATIC_TEMPLATE_CATALOG_VERSION,
      entryCount: 32,
      admittedCount: 1,
      requiredAdmissionReady: true,
    });

    const candidate = first.catalog.entries[0]!;
    const admittedCandidate = first.catalog.entries.find(
      (entry) =>
        entry.candidateId === "static-template-22-hirael-agency-landing",
    )!;
    const preview = await readStaticTemplateCatalogPreview(
      candidate.candidateId,
      {
        rootDir: root,
      },
    );
    expect(preview.entry.previewSha256).toBe(candidate.previewSha256);
    expect(preview.bytes.byteLength).toBe(candidate.previewBytes);
    const source = await openStaticTemplateCatalogSource(
      admittedCandidate.candidateId,
      {
        rootDir: root,
      },
    );
    expect(source.entry.sourceSha256).toBe(admittedCandidate.sourceSha256);
    source.stream.destroy();

    const legacyVersion = "21st-included-recommended-20260828-v1";
    const {
      rawSourceAssetId: _rawSourceAssetId,
      rawSourcePath: _rawSourcePath,
      rawSourceSha256: _rawSourceSha256,
      rawSourceBytes: _rawSourceBytes,
      rawSourceFileCount: _rawSourceFileCount,
      rawSourceExpandedBytes: _rawSourceExpandedBytes,
      executionAdmission: _executionAdmission,
      ...legacyEntry
    } = candidate;
    const legacyManifest = {
      schemaVersion: "frontmind-static-template-catalog-v1",
      workflowVersion: first.catalog.workflowVersion,
      catalogVersion: legacyVersion,
      pageSize: 1,
      pageCount: 1,
      entryCount: 1,
      entries: [legacyEntry],
    } as const;
    const legacyDirectory = path.join(
      root,
      "siteops/static-template-catalog/catalogs",
      legacyVersion,
    );
    await mkdir(legacyDirectory, { recursive: true });
    const legacyManifestBytes = Buffer.from(
      `${JSON.stringify(legacyManifest)}\n`,
    );
    await writeFile(
      path.join(legacyDirectory, "manifest.json"),
      legacyManifestBytes,
    );
    const legacyAsset = async (
      kind: "source" | "preview",
      assetPath: string,
      sha256: string,
      bytes: number,
    ) => {
      const signature = await stat(path.join(root, assetPath), {
        bigint: true,
      });
      return {
        candidateId: legacyEntry.candidateId,
        kind,
        path: assetPath,
        sha256,
        bytes,
        inode: signature.ino.toString(),
        modifiedNs: signature.mtimeNs.toString(),
        changedNs: signature.ctimeNs.toString(),
      };
    };
    await writeFile(
      path.join(legacyDirectory, "integrity.json"),
      `${JSON.stringify({
        schemaVersion: "frontmind-static-template-catalog-integrity-v1",
        workflowVersion: first.catalog.workflowVersion,
        catalogVersion: legacyVersion,
        manifestSha256: createHash("sha256")
          .update(legacyManifestBytes)
          .digest("hex"),
        assets: [
          await legacyAsset(
            "source",
            legacyEntry.sourcePath,
            legacyEntry.sourceSha256,
            legacyEntry.sourceBytes,
          ),
          await legacyAsset(
            "preview",
            legacyEntry.previewPath,
            legacyEntry.previewSha256,
            legacyEntry.previewBytes,
          ),
        ],
      })}\n`,
    );
    await expect(
      loadStaticTemplateCatalogVersion(legacyVersion, { rootDir: root }),
    ).resolves.toMatchObject({
      schemaVersion: "frontmind-static-template-catalog-v1",
      catalogVersion: legacyVersion,
      entryCount: 1,
    });
    const legacySource = await openStaticTemplateCatalogVersionSource(
      legacyVersion,
      legacyEntry.candidateId,
      { rootDir: root },
    );
    expect(legacySource.entry.sourceSha256).toBe(legacyEntry.sourceSha256);
    legacySource.stream.destroy();

    const activePath = path.join(
      root,
      "siteops/static-template-catalog/active.json",
    );
    const activeBytes = await readFile(activePath);
    const invalidActive = JSON.parse(activeBytes.toString("utf8")) as {
      manifestSha256: string;
    };
    invalidActive.manifestSha256 = "0".repeat(64);
    await writeFile(activePath, `${JSON.stringify(invalidActive)}\n`);
    await expect(
      getStaticTemplateCatalogReadiness({ rootDir: root }),
    ).resolves.toMatchObject({
      ready: false,
      code: "STATIC_TEMPLATE_CATALOG_MANIFEST_HASH_MISMATCH",
    });
    await writeFile(activePath, activeBytes);

    const previewPath = path.join(root, candidate.previewPath);
    const tamperedPreview = Buffer.from(preview.bytes);
    tamperedPreview[0] = tamperedPreview[0]! ^ 0xff;
    await writeFile(previewPath, tamperedPreview);
    await expect(
      getStaticTemplateCatalogReadiness({ rootDir: root }),
    ).resolves.toMatchObject({
      ready: false,
      code: "STATIC_TEMPLATE_CATALOG_INTEGRITY_STAT_MISMATCH",
    });
    await expect(
      readStaticTemplateCatalogPreview(candidate.candidateId, {
        rootDir: root,
      }),
    ).rejects.toMatchObject({
      code: "STATIC_TEMPLATE_CATALOG_PREVIEW_HASH_MISMATCH",
    });

    await expect(
      seedStaticTemplateCatalog({
        rootDir: root,
        fetchImpl,
        concurrency: 3,
        executionAdmissionBuilder: testExecutionAdmissionBuilder,
      }),
    ).rejects.toMatchObject({
      code: "STATIC_TEMPLATE_CATALOG_VERSION_CONFLICT",
    });
    await writeFile(previewPath, preview.bytes);
    const repaired = await seedStaticTemplateCatalog({
      rootDir: root,
      fetchImpl,
      concurrency: 3,
      executionAdmissionBuilder: testExecutionAdmissionBuilder,
    });
    expect(repaired.reused).toBe(true);
    expect(requests).toBe(sources.size + previews.size);
    await expect(
      getStaticTemplateCatalogReadiness({ rootDir: root }),
    ).resolves.toMatchObject({ ready: true, entryCount: 32 });
    expect(
      (
        await readdir(
          path.join(root, "siteops/static-template-catalog/catalogs"),
        )
      ).some((name) =>
        name.startsWith(`${STATIC_TEMPLATE_CATALOG_VERSION}.invalid-`),
      ),
    ).toBe(false);

    const repairedActiveBytes = await readFile(activePath);
    const futureActive = JSON.parse(repairedActiveBytes.toString("utf8")) as {
      workflowVersion: string;
      catalogVersion: string;
      manifestPath: string;
      integrityPath: string;
    };
    futureActive.workflowVersion = "2.9.0";
    futureActive.catalogVersion = "future-static-catalog-v2";
    futureActive.manifestPath =
      "siteops/static-template-catalog/catalogs/future-static-catalog-v2/manifest.json";
    futureActive.integrityPath =
      "siteops/static-template-catalog/catalogs/future-static-catalog-v2/integrity.json";
    await writeFile(activePath, `${JSON.stringify(futureActive)}\n`);
    await expect(
      getStaticTemplateCatalogReadiness({ rootDir: root }),
    ).resolves.toMatchObject({
      ready: false,
      code: "STATIC_TEMPLATE_CATALOG_VERSION_MISMATCH",
    });
    await expect(
      loadStaticTemplateCatalogVersion(STATIC_TEMPLATE_CATALOG_VERSION, {
        rootDir: root,
      }),
    ).resolves.toMatchObject({
      entryCount: 32,
      catalogVersion: STATIC_TEMPLATE_CATALOG_VERSION,
    });
    const frozenSource = await openStaticTemplateCatalogVersionSource(
      STATIC_TEMPLATE_CATALOG_VERSION,
      admittedCandidate.candidateId,
      { rootDir: root },
    );
    const repairedAdmittedCandidate = repaired.catalog.entries.find(
      (entry) => entry.candidateId === admittedCandidate.candidateId,
    )!;
    expect(frozenSource.entry.sourceSha256).toBe(
      repairedAdmittedCandidate.sourceSha256,
    );
    frozenSource.stream.destroy();
    const frozenPreview = await openStaticTemplateCatalogVersionPreview(
      STATIC_TEMPLATE_CATALOG_VERSION,
      candidate.candidateId,
      { rootDir: root },
    );
    expect(frozenPreview.entry.previewSha256).toBe(candidate.previewSha256);
    frozenPreview.stream.destroy();
    await expect(
      loadStaticTemplateCatalogVersion("../active", { rootDir: root }),
    ).rejects.toMatchObject({
      code: "STATIC_TEMPLATE_CATALOG_VERSION_INVALID",
    });
    await writeFile(activePath, repairedActiveBytes);
  });

  it("does not activate a partial catalog", async () => {
    const root = await temporaryRoot();
    let requests = 0;
    const fetchImpl = (async () => {
      requests += 1;
      if (requests > 4) return new Response(null, { status: 503 });
      return new Response(await sourceArchive(), { status: 200 });
    }) as typeof fetch;
    await expect(
      seedStaticTemplateCatalog({ rootDir: root, fetchImpl, concurrency: 1 }),
    ).rejects.toBeInstanceOf(StaticTemplateCatalogError);
    await expect(
      loadActiveStaticTemplateCatalog({ rootDir: root }),
    ).resolves.toBeNull();
  });

  it("keeps the seed lock until sibling workers settle after admission fails", async () => {
    const root = await temporaryRoot();
    const sourceDefinitions = new Map<
      string,
      Array<(typeof FROZEN_STATIC_TEMPLATE_CATALOG)[number]>
    >();
    for (const definition of FROZEN_STATIC_TEMPLATE_CATALOG) {
      const url = frozenSourceUrl(definition);
      sourceDefinitions.set(url, [
        ...(sourceDefinitions.get(url) ?? []),
        definition,
      ]);
    }
    const sources = new Map<string, Buffer>();
    await Promise.all(
      [...sourceDefinitions].map(async ([url, definitions]) => {
        sources.set(url, await catalogSourceArchive(definitions));
      }),
    );
    const preview = await sharp({
      create: {
        width: 16,
        height: 9,
        channels: 4,
        background: { r: 17, g: 34, b: 51, alpha: 1 },
      },
    })
      .png()
      .toBuffer();

    let blockNextFetch = false;
    let blocked = false;
    let resolveBlocked!: () => void;
    const blockedFetch = new Promise<void>((resolve) => {
      resolveBlocked = resolve;
    });
    let releaseBlocked!: () => void;
    const blockedRelease = new Promise<void>((resolve) => {
      releaseBlocked = resolve;
    });
    const fetchImpl = (async (request: string | URL | Request) => {
      const url = String(request);
      if (blockNextFetch && !blocked) {
        blocked = true;
        resolveBlocked();
        await blockedRelease;
      }
      const source = sources.get(url);
      const bytes = source ?? preview;
      return new Response(bytes, {
        status: 200,
        headers: { "content-length": String(bytes.length) },
      });
    }) as typeof fetch;
    const admissionFailure = new Error("TEST_EXECUTION_ADMISSION_FAILED");
    const executionAdmissionBuilder: StaticTemplateExecutionAdmissionBuilder =
      async (builderInput) => {
        if (
          builderInput.definition.candidateId !==
          "static-template-22-hirael-agency-landing"
        ) {
          return testExecutionAdmissionBuilder(builderInput);
        }
        blockNextFetch = true;
        await blockedFetch;
        throw admissionFailure;
      };

    let firstSettled = false;
    const firstSeed = seedStaticTemplateCatalog({
      rootDir: root,
      fetchImpl,
      concurrency: 2,
      executionAdmissionBuilder,
    }).finally(() => {
      firstSettled = true;
    });
    await blockedFetch;
    await Promise.resolve();
    expect(firstSettled).toBe(false);
    await expect(
      seedStaticTemplateCatalog({
        rootDir: root,
        fetchImpl,
        concurrency: 1,
        executionAdmissionBuilder,
      }),
    ).rejects.toMatchObject({
      code: "STATIC_TEMPLATE_CATALOG_SEED_IN_PROGRESS",
    });
    expect(firstSettled).toBe(false);

    releaseBlocked();
    await expect(firstSeed).rejects.toBe(admissionFailure);
    expect(firstSettled).toBe(true);
  });
});
