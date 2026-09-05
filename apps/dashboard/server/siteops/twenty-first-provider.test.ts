import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import JSZip from "jszip";
import { describe, expect, it, vi } from "vitest";
import sharp from "sharp";

import type {
  KnowledgeBaseSnapshot,
  SiteOperation,
  SiteProject,
} from "../../drizzle/schema";
import {
  visualSelectionBundleV7Schema,
  type SiteBrief,
} from "../../shared/siteops";
import { FRONTMIND_VISUAL_FAMILIES_V3 } from "../../shared/siteops-design";
import {
  TwentyFirstNativeTemplateError,
  TwentyFirstToolContractError,
  type TwentyFirstReadOnlySession,
} from "../twenty-first-service";
import {
  createTwentyFirstSiteOpsProviderHandler,
  nativeTemplateProviderErrorCode,
  nativeSourceProviderErrorCode,
  persistDefaultStaticTemplateCatalogBoards,
  planNativeTemplateCapacityPages,
  resolveVisualSearchPlan,
  type NativeTemplatePoolPersistenceInput,
  type TwentyFirstBoardPersistenceInput,
  type TwentyFirstProviderContext,
} from "./twenty-first-provider";
import {
  NativeVisualSourceError,
  createNativeSourceArchive,
  normalizeTwentyFirstNativeSource,
  prepareNativeTemplateCandidate,
  readVisualSelectionBundleArtifact,
} from "./native-visual-source";
import { StaticTemplateCatalogError } from "./static-template-catalog";
import {
  fetchPinnedPublicHttps,
  fetchSafeVisualPreview,
  isPublicPreviewAddress,
  lookupForPinnedPreviewAddress,
  pinnedHttpsFetch,
  pinnedPreviewRequestOptions,
  responseFromPinnedPreviewIncoming,
  samePreviewAddress,
} from "./remote-preview";

const credentialId = "11111111-1111-4111-8111-111111111111";
const snapshotId = "22222222-2222-4222-8222-222222222222";
const projectId = "33333333-3333-4333-8333-333333333333";
const operationId = "44444444-4444-4444-8444-444444444444";

it("keeps native browser, render and hard-safety provider codes distinct", () => {
  expect(nativeSourceProviderErrorCode("browser_unavailable")).toBe(
    "NATIVE_SOURCE_BROWSER_UNAVAILABLE",
  );
  expect(nativeSourceProviderErrorCode("render_failed")).toBe(
    "NATIVE_SOURCE_RENDER_UNAVAILABLE",
  );
  expect(nativeSourceProviderErrorCode("source_unsafe")).toBe(
    "NATIVE_SOURCE_UNSAFE",
  );
});

it("keeps complete-template catalog, build and render provider codes distinct", () => {
  expect(nativeTemplateProviderErrorCode("catalog_unavailable")).toBe(
    "NATIVE_TEMPLATE_CATALOG_UNAVAILABLE",
  );
  expect(nativeTemplateProviderErrorCode("compile_failed")).toBe(
    "NATIVE_TEMPLATE_COMPILE_UNAVAILABLE",
  );
  expect(nativeTemplateProviderErrorCode("browser_unavailable")).toBe(
    "NATIVE_TEMPLATE_BROWSER_UNAVAILABLE",
  );
});

it("capacity-balances the 135373697-byte randomized V6 pool without failing on an oversized first nine", () => {
  const pageLimit = 99 * 1024 * 1024;
  const largeArchiveBytes = 13_143_190;
  const candidates = [
    ...Array.from({ length: 9 }, (_, index) => ({
      key: `large-${index}`,
      archiveBytes: largeArchiveBytes,
      priorityIndex: index,
    })),
    ...Array.from({ length: 18 }, (_, index) => ({
      key: `small-${index}`,
      archiveBytes: index === 17 ? 949_165 : 949_166,
      priorityIndex: index + 9,
    })),
  ];
  expect(
    candidates
      .slice(0, 9)
      .reduce((total, candidate) => total + candidate.archiveBytes, 0),
  ).toBe(118_288_710);
  expect(
    candidates.reduce((total, candidate) => total + candidate.archiveBytes, 0),
  ).toBe(135_373_697);

  const plan = planNativeTemplateCapacityPages({
    candidates,
    pageCount: 3,
    maxPageBytes: pageLimit,
    currentBinIndex: 1,
  });
  expect(plan).toMatchObject({
    feasible: true,
    required: 27,
    usable: 27,
    rejectedOversize: 0,
  });
  expect(plan.bins).toHaveLength(3);
  expect(plan.current).toHaveLength(9);
  expect(new Set(plan.bins.flat().map((candidate) => candidate.key)).size).toBe(
    27,
  );
  for (const bin of plan.bins) {
    expect(bin).toHaveLength(9);
    expect(
      bin.reduce((total, candidate) => total + candidate.archiveBytes, 0),
    ).toBeLessThan(pageLimit);
  }

  const remaining = plan.bins
    .filter((bin) => bin !== plan.current)
    .flat()
    .map((candidate, priorityIndex) => ({ ...candidate, priorityIndex }));
  const nextPlan = planNativeTemplateCapacityPages({
    candidates: remaining,
    pageCount: 2,
    maxPageBytes: pageLimit,
  });
  expect(nextPlan.feasible).toBe(true);
  expect(nextPlan.bins).toHaveLength(2);
  expect(
    nextPlan.bins.every(
      (bin) =>
        bin.length === 9 &&
        bin.reduce((total, candidate) => total + candidate.archiveBytes, 0) <
          pageLimit,
    ),
  ).toBe(true);
});

function operation(): SiteOperation {
  const now = new Date();
  return {
    id: operationId,
    projectId,
    userId: 7,
    conversationTurnId: null,
    buildId: null,
    kind: "visual_search",
    status: "running",
    clientRequestId: "request-visual-search",
    inputHash: "a".repeat(64),
    input: {
      knowledgeSnapshotId: snapshotId,
      credentialId,
      credentialVersion: 3,
      workflowVersion: "1.3.0",
    },
    provider: "21st",
    providerOperationId: null,
    providerTaskId: null,
    leaseOwner: "lease",
    leaseExpiresAt: new Date(now.getTime() + 60_000),
    attempt: 1,
    result: null,
    errorCode: null,
    errorMessage: null,
    startedAt: now,
    completedAt: null,
    createdAt: now,
    updatedAt: now,
  };
}

function supplementalOperation(
  page: 2 | 3 = 2,
  admissionRevision = 4,
): SiteOperation {
  const row = operation();
  return {
    ...row,
    input: {
      schemaVersion: 2,
      knowledgeSnapshotId: snapshotId,
      credentialId,
      credentialVersion: 3,
      workflowVersion: "1.3.0",
      mode: "supplemental",
      page,
      admissionRevision,
    },
  };
}

function initialV2Operation(admissionRevision = 4): SiteOperation {
  const row = operation();
  return {
    ...row,
    input: {
      schemaVersion: 2,
      knowledgeSnapshotId: snapshotId,
      credentialId,
      credentialVersion: 3,
      workflowVersion: "1.3.0",
      mode: "initial",
      page: 1,
      admissionRevision,
    },
  };
}

function providerContext(): TwentyFirstProviderContext {
  const now = new Date();
  const brief: SiteBrief = {
    companyName: "FrontMind",
    primaryLanguage: "zh-CN",
    contacts: [],
    offerings: ["GEO Analytics"],
    audience: ["B2B marketing teams"],
    conversionGoal: "Book a demo",
    routes: [
      {
        id: "home",
        slug: "/",
        title: "Home",
        sourceDocumentIds: ["doc-1"],
      },
    ],
    verifiedFacts: [],
    publicAssetIds: [],
    unknowns: [],
  };
  return {
    project: {
      id: projectId,
      userId: 7,
      conversationId: "siteops:7",
      currentKnowledgeSnapshotId: snapshotId,
      currentBuildId: null,
      globalLiveDeploymentId: null,
      mainlandLiveDeploymentId: null,
      primaryLanguage: "zh-CN",
      canonicalHostname: null,
      currentTaskStartedAt: now,
      minimumKnowledgeSnapshotVersion: null,
      status: "visual_searching",
      brief,
      revision: 4,
      createdAt: now,
      updatedAt: now,
    } satisfies SiteProject,
    snapshot: {
      id: snapshotId,
      userId: 7,
      version: 2,
      sourceFileName: "frontmind.zip",
      sourceConversationId: null,
      sourceBuildId: null,
      sourceBuildRevision: null,
      sourceTaskId: null,
      sourceArtifactHash: null,
      archiveHash: "b".repeat(64),
      maintenanceTicketId: null,
      documents: [],
      assets: [],
      documentCount: 0,
      imageCount: 0,
      characterCount: 0,
      totalBytes: 1,
      status: "active",
      createdByUserId: 7,
      createdAt: now,
    } satisfies KnowledgeBaseSnapshot,
    brief,
    existingBoard: null,
  };
}

function sha256(buffer: Buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function patternHash(seed: number) {
  return createHash("sha256")
    .update(`siteops-visual-pattern:${seed}`)
    .digest("hex")
    .slice(0, 16);
}

async function perceptuallyDistinctPng(seed: number) {
  const bits = BigInt(`0x${patternHash(seed)}`);
  const pixels = Buffer.alloc(9 * 8);
  for (let row = 0; row < 8; row += 1) {
    let value = 128;
    pixels[row * 9] = value;
    for (let column = 0; column < 8; column += 1) {
      const offset = BigInt(63 - (row * 8 + column));
      const descending = ((bits >> offset) & 1n) === 1n;
      value += descending ? -8 : 8;
      pixels[row * 9 + column + 1] = value;
    }
  }
  return sharp(pixels, {
    raw: { width: 9, height: 8, channels: 1 },
  })
    .png()
    .toBuffer();
}

async function preparedTemplateFixture(input: {
  templateId: string | number;
  slug: string;
  version?: string | null;
  seed: number;
}) {
  const preview = await perceptuallyDistinctPng(input.seed);
  const zip = new JSZip();
  zip.file(
    "native-template/package.json",
    JSON.stringify({
      private: true,
      scripts: { dev: "vite", build: "vite build" },
      dependencies: { react: "19.2.1", "react-dom": "19.2.1" },
    }),
  );
  zip.file(
    "native-template/index.html",
    '<!doctype html><html><body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body></html>',
  );
  zip.file(
    "native-template/src/main.tsx",
    'import React from "react";import {createRoot} from "react-dom/client";import App from "./App";createRoot(document.getElementById("root")!).render(<App/>);',
  );
  zip.file(
    "native-template/src/App.tsx",
    `import React from "react";export default function App(){return <main>${input.slug}</main>}`,
  );
  const providerArchive = await zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
  });
  return prepareNativeTemplateCandidate({
    templateId: input.templateId,
    slug: input.slug,
    version: input.version ?? null,
    archive: providerArchive,
    expectedArchiveSha256: sha256(providerArchive),
    sourceSubdirectory: "native-template",
    previewUrl: `https://cdn.21st.dev/templates/${input.slug}.png`,
    signal: new AbortController().signal,
    fetchRemoteAsset: async ({ url }) => ({
      finalUrl: url,
      mimeType: "image/png" as const,
      buffer: preview,
      width: 1200,
      height: 800,
      sha256: sha256(preview),
      visualSignals: {
        dominantHex: "#000000",
        brightness: 0,
        contrast: 0,
      },
    }),
    renderPreview: async ({ sourceArchive, signal }) => {
      if (signal.aborted) throw signal.reason;
      return sharp({
        create: {
          width: 120,
          height: 80,
          channels: 3,
          background: {
            r: Buffer.from(sha256(sourceArchive), "hex")[0]!,
            g: Buffer.from(sha256(sourceArchive), "hex")[1]!,
            b: Buffer.from(sha256(sourceArchive), "hex")[2]!,
          },
        },
      })
        .png()
        .toBuffer();
    },
  });
}

const FAMILY_CATALOG_METADATA = [
  {
    name: "Orbital Hero Section",
    description:
      "Animated space hero background with planets trailing orbital wakes.",
  },
  {
    name: "Split Hero With Image Cards",
    description:
      "A split hero section with a serif headline and two image cards.",
  },
  {
    name: "Editorial Image Hero",
    description:
      "A hero section with a full-width image and a right-aligned serif headline.",
  },
  {
    name: "Feature Bento",
    description:
      "A responsive bento-grid feature section with a hero card and stat tiles.",
  },
  {
    name: "Feature Hero",
    description:
      "A centered hero section with a grid of icon-based feature cards highlighting product capabilities.",
  },
  {
    name: "Hero 03",
    description:
      "A centered hero section with a serif headline and dual call-to-action buttons.",
  },
  {
    name: "PrismaHero",
    description:
      "A full-screen cinematic hero section with a background video and strong visual storytelling.",
  },
  {
    name: "Hero with Mockup",
    description:
      "A modern animated hero section with mockup display and gradient effects.",
  },
  {
    name: "Illuminated Hero",
    description:
      "A striking hero section with glowing animated text for bold headlines.",
  },
] as const;

function familyMetadata(index: number) {
  return FAMILY_CATALOG_METADATA[index % FAMILY_CATALOG_METADATA.length]!;
}

function frontMindBaselineDependencies() {
  let persisted: TwentyFirstBoardPersistenceInput | null = null;
  return {
    renderCandidates: vi.fn(async ({ blueprints }) =>
      blueprints.map((blueprint: { heroFamily: string }) => ({
        heroFamily: blueprint.heroFamily,
        buffer: Buffer.from(`frontmind-baseline:${blueprint.heroFamily}`),
      })),
    ),
    persistArtifact: vi.fn(async (input: { buffer: Buffer }) => ({
      id: randomUUID(),
      contentSha256: sha256(input.buffer),
    })),
    persistBoard: vi.fn(
      async (_db: unknown, input: TwentyFirstBoardPersistenceInput) => {
        persisted = input;
        return {
          batchId: "55555555-5555-4555-8555-555555555555",
          candidateCount: input.mirroredCandidates.length,
          selectionBundleHash: input.selectionBundleArtifact.contentSha256,
        };
      },
    ),
    persisted: () => persisted,
  };
}

describe("21st SiteOps provider", () => {
  it("freezes V1 supplemental revision and page coordinates for commit CAS", () => {
    const context = providerContext();
    context.project.revision = 11;
    context.publishedPageCount = 1;

    expect(
      resolveVisualSearchPlan(
        {
          knowledgeSnapshotId: snapshotId,
          credentialId,
          credentialVersion: 3,
          workflowVersion: "1.3.0",
        },
        context,
      ),
    ).toEqual({
      schemaVersion: 1,
      mode: "supplemental",
      page: 2,
      admissionRevision: 11,
    });
  });

  it("reuses a board already committed for the same leased operation", async () => {
    const getCredential = vi.fn();
    const client = { withReadOnlySession: vi.fn() };
    const persistArtifact = vi.fn();
    const persistBoard = vi.fn();
    const context = providerContext();
    context.existingBoard = {
      batchId: "55555555-5555-4555-8555-555555555555",
      candidateCount: 9,
      selectionBundleHash: "c".repeat(64),
    };
    const handler = createTwentyFirstSiteOpsProviderHandler({
      getDb: async () => ({ fake: "db" }),
      loadContext: async () => context,
      getCredential,
      client,
      persistArtifact: persistArtifact as never,
      persistBoard,
    });

    await expect(
      handler({
        operation: operation(),
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({
      status: "succeeded",
      result: {
        batchId: "55555555-5555-4555-8555-555555555555",
        candidateCount: 9,
      },
    });
    expect(getCredential).not.toHaveBeenCalled();
    expect(client.withReadOnlySession).not.toHaveBeenCalled();
    expect(persistArtifact).not.toHaveBeenCalled();
    expect(persistBoard).not.toHaveBeenCalled();
  });

  it("publishes four fixed V7 pages without reading a 21st credential or provider API", async () => {
    const row = operation();
    row.input = {
      schemaVersion: 3,
      knowledgeSnapshotId: snapshotId,
      workflowVersion: "2.8.0",
      catalogVersion: "21st-included-recommended-20260828-v2",
      mode: "initial",
      page: 1,
      admissionRevision: 4,
    };
    const context = providerContext();
    context.project.revision = 4;
    context.publishedPageCount = 0;
    const previewFixtures = await Promise.all(
      Array.from({ length: 32 }, async (_, index) => {
        const bytes = await sharp({
          create: {
            width: 16,
            height: 10,
            channels: 4,
            background: {
              r: 28 + index,
              g: 44 + index,
              b: 72 + index,
              alpha: 1,
            },
          },
        })
          .png()
          .toBuffer();
        return { bytes, sha256: sha256(bytes) };
      }),
    );
    const catalog = {
      schemaVersion: "frontmind-static-template-catalog-v2" as const,
      workflowVersion: "2.8.0" as const,
      catalogVersion: "21st-included-recommended-20260828-v2" as const,
      pageSize: 8 as const,
      pageCount: 4 as const,
      entryCount: 32 as const,
      entries: Array.from({ length: 32 }, (_, index) => {
        const order = index + 1;
        const preview = previewFixtures[index]!;
        const candidateId = `static-template-${String(order).padStart(2, "0")}-fixture-${order}`;
        const sourceSha256 = order.toString(16).padStart(64, "0");
        return {
          order,
          page: Math.floor(index / 8) + 1,
          pageIndex: index % 8,
          candidateId,
          providerTemplateId: String(800 + order),
          providerSlug: `fixture-${order}`,
          providerName: `Fixture ${order}`,
          providerDescription: `Static fixture ${order}`,
          providerVersion: order.toString(16).padStart(40, "0"),
          sourceOwner: "frontmind",
          sourceRepo: `fixture-${order}`,
          sourceCommitSha: order.toString(16).padStart(40, "0"),
          sourceSubdirectory: null,
          sourceLicense: "MIT" as const,
          rawSourceAssetId: `catalog/raw-source/${candidateId}`,
          rawSourcePath: `catalog/sources/${candidateId}.zip`,
          rawSourceSha256: sourceSha256,
          rawSourceBytes: 1_024 + order,
          rawSourceFileCount: 10,
          rawSourceExpandedBytes: 2_048 + order,
          sourceAssetId: `catalog/source/${candidateId}`,
          sourcePath: `catalog/sources/${candidateId}.zip`,
          sourceSha256,
          sourceBytes: 1_024 + order,
          sourceFileCount: 10,
          sourceExpandedBytes: 2_048 + order,
          previewAssetId: `catalog/preview/${candidateId}`,
          previewPath: `catalog/previews/${candidateId}.png`,
          previewSha256: preview.sha256,
          previewBytes: preview.bytes.length,
          previewMimeType: "image/png" as const,
          previewWidth: 16,
          previewHeight: 10,
          tags: ["fixture"],
          executionAdmission: {
            status: "unavailable" as const,
            binding: {
              catalogVersion: "21st-included-recommended-20260828-v2",
              candidateId,
              rawSourceSha256: sourceSha256,
            },
            code: "STATIC_TEMPLATE_EXECUTION_ADMISSION_PENDING",
            reason: "该测试模板尚未完成执行准入。",
          },
        };
      }),
    };
    const getCredential = vi.fn();
    const withReadOnlySession = vi.fn();
    const listNativeTemplates = vi.fn();
    const downloadNativeTemplate = vi.fn();
    const persistedArtifacts: Array<{
      kind: string;
      mimeType: string;
      buffer: Buffer;
      idempotencyKey?: string;
      retainUntil?: Date;
    }> = [];
    const persistedSampleRuns: string[][] = [];
    const persistStaticTemplateCatalogBoards = vi.fn(async (_db, input) => {
      expect(input.catalogVersion).toBe(catalog.catalogVersion);
      expect(input.pages).toHaveLength(4);
      for (const [index, page] of input.pages.entries()) {
        expect(page.pageNumber).toBe(index + 1);
        expect(page.candidates).toHaveLength(8);
        expect(page.selectionBundle.candidates).toHaveLength(8);
        expect(
          page.candidates.every(
            (candidate) =>
              candidate.previewLocalAssetId ===
              `local:${candidate.catalogCandidateId}`,
          ),
        ).toBe(true);
        expect(
          page.selectionBundle.candidates.every(
            (candidate) => !("sourceArchivePath" in candidate),
          ),
        ).toBe(true);
      }
      persistedSampleRuns.push(
        input.pages.flatMap((page) =>
          page.candidates.map((candidate) => candidate.sampleId),
        ),
      );
      const selectResults: unknown[][] = [
        [input.context.project],
        [],
        [input.operation],
        [],
        [{ ordinal: 0 }],
        [{ sequence: 0 }],
      ];
      const insertedSampleRows: Array<Record<string, unknown>> = [];
      const query = (result: unknown[]) => {
        const chain: Record<string, unknown> & PromiseLike<unknown[]> = {
          then: (resolve, reject) =>
            Promise.resolve(result).then(resolve, reject),
        };
        chain.from = () => chain;
        chain.where = () => chain;
        chain.limit = () => chain;
        chain.for = async () => result;
        return chain;
      };
      const tx = {
        select: () => query(selectResults.shift() ?? []),
        insert: () => ({
          values: async (values: unknown) => {
            if (Array.isArray(values)) {
              insertedSampleRows.push(
                ...(values as Array<Record<string, unknown>>),
              );
            }
          },
        }),
        update: () => ({
          set: () => ({
            where: async () => ({ affectedRows: 1 }),
          }),
        }),
      };
      const result = await persistDefaultStaticTemplateCatalogBoards(
        {
          transaction: async (callback: (value: typeof tx) => unknown) =>
            callback(tx),
        },
        input,
      );
      expect(insertedSampleRows).toHaveLength(32);
      expect(
        insertedSampleRows.every((sample) => {
          const metadata = sample.sourceMetadata as Record<string, unknown>;
          return (
            typeof sample.previewLocalAssetId === "string" &&
            sample.previewLocalAssetId === metadata.previewLocalAssetId &&
            sample.attachmentId === null
          );
        }),
      ).toBe(true);
      return result;
    });
    let activePreviewReads = 0;
    let maximumPreviewReads = 0;
    const readStaticTemplateCatalogPreview = vi.fn(
      async (catalogVersion: string, candidateId: string) => {
        expect(catalogVersion).toBe(catalog.catalogVersion);
        activePreviewReads += 1;
        maximumPreviewReads = Math.max(maximumPreviewReads, activePreviewReads);
        await new Promise((resolve) => setTimeout(resolve, 1));
        activePreviewReads -= 1;
        return {
          entry: catalog.entries.find(
            (candidate) => candidate.candidateId === candidateId,
          )!,
          bytes: Buffer.from(
            previewFixtures[
              catalog.entries.findIndex(
                (candidate) => candidate.candidateId === candidateId,
              )
            ]!.bytes,
          ),
        };
      },
    );
    const loadStaticTemplateCatalog = vi.fn(async () => catalog);
    const handler = createTwentyFirstSiteOpsProviderHandler({
      getDb: async () => ({ fake: "db" }),
      loadContext: async () => context,
      getCredential,
      client: {
        withReadOnlySession,
        listNativeTemplates,
        downloadNativeTemplate,
      },
      loadStaticTemplateCatalog,
      readStaticTemplateCatalogPreview,
      persistArtifact: vi.fn(async (input) => {
        persistedArtifacts.push({
          kind: input.kind,
          mimeType: input.mimeType,
          buffer: Buffer.from(input.buffer),
          idempotencyKey: input.idempotencyKey,
          retainUntil: input.retainUntil,
        });
        return {
          id:
            input.kind === "static-template-preview"
              ? `local:${input.filename.replace(/\.png$/u, "")}`
              : `bundle:${input.idempotencyKey}`,
          contentSha256: sha256(input.buffer),
        };
      }) as never,
      persistStaticTemplateCatalogBoards,
    });

    await expect(
      handler({ operation: row, signal: new AbortController().signal }),
    ).resolves.toMatchObject({
      status: "succeeded",
      result: {
        candidateCount: 32,
        workflowVersion: "2.8.0",
        catalogVersion: catalog.catalogVersion,
        pageSize: 8,
        pageCount: 4,
        availablePages: 4,
        reservedPages: 0,
        canGenerateMore: false,
      },
    });
    await expect(
      handler({ operation: row, signal: new AbortController().signal }),
    ).resolves.toMatchObject({ status: "succeeded" });
    expect(loadStaticTemplateCatalog).toHaveBeenNthCalledWith(
      1,
      catalog.catalogVersion,
    );
    expect(loadStaticTemplateCatalog).toHaveBeenNthCalledWith(
      2,
      catalog.catalogVersion,
    );
    expect(readStaticTemplateCatalogPreview).toHaveBeenCalledTimes(64);
    expect(maximumPreviewReads).toBe(4);
    expect(persistedSampleRuns).toHaveLength(2);
    expect(persistedSampleRuns[1]).toEqual(persistedSampleRuns[0]);
    expect(new Set(persistedSampleRuns[0]).size).toBe(32);
    const previewArtifacts = persistedArtifacts.filter(
      (artifact) => artifact.kind === "static-template-preview",
    );
    expect(previewArtifacts).toHaveLength(64);
    for (const artifact of previewArtifacts) {
      expect(artifact.mimeType).toBe("image/png");
      expect(artifact.idempotencyKey).toMatch(
        new RegExp(`^v1:${catalog.catalogVersion}:.+:[a-f0-9]{64}$`, "u"),
      );
      expect(artifact.retainUntil!.getTime()).toBeGreaterThan(
        Date.now() + 23 * 60 * 60 * 1_000,
      );
    }
    const selectionArtifacts = persistedArtifacts.filter(
      (artifact) => artifact.kind === "static-template-selection-bundle",
    );
    expect(selectionArtifacts).toHaveLength(8);
    expect(
      selectionArtifacts.slice(0, 4).map((item) => item.idempotencyKey),
    ).toEqual(selectionArtifacts.slice(4).map((item) => item.idempotencyKey));
    for (const artifact of selectionArtifacts) {
      expect(artifact.mimeType).toBe("application/json");
      expect(
        visualSelectionBundleV7Schema.parse(
          JSON.parse(artifact.buffer.toString("utf8")),
        ).candidates,
      ).toHaveLength(8);
    }
    expect(getCredential).not.toHaveBeenCalled();
    expect(withReadOnlySession).not.toHaveBeenCalled();
    expect(listNativeTemplates).not.toHaveBeenCalled();
    expect(downloadNativeTemplate).not.toHaveBeenCalled();
  });

  it("recovers the complete four-page V7 catalog as one idempotent result", async () => {
    const row = operation();
    row.input = {
      schemaVersion: 3,
      knowledgeSnapshotId: snapshotId,
      workflowVersion: "2.8.0",
      catalogVersion: "21st-included-recommended-20260828-v1",
      mode: "initial",
      page: 1,
      admissionRevision: 4,
    };
    const context = providerContext();
    context.project.revision = 4;
    context.existingBoard = {
      batchId: "55555555-5555-4555-8555-555555555551",
      batchIds: [
        "55555555-5555-4555-8555-555555555551",
        "55555555-5555-4555-8555-555555555552",
        "55555555-5555-4555-8555-555555555553",
        "55555555-5555-4555-8555-555555555554",
      ],
      pageCount: 4,
      candidateCount: 32,
      selectionBundleHash: "c".repeat(64),
    };
    const getCredential = vi.fn();
    const loadStaticTemplateCatalog = vi.fn();
    const persistStaticTemplateCatalogBoards = vi.fn();
    const handler = createTwentyFirstSiteOpsProviderHandler({
      getDb: async () => ({ fake: "db" }),
      loadContext: async () => context,
      getCredential,
      client: { withReadOnlySession: vi.fn() },
      loadStaticTemplateCatalog,
      persistStaticTemplateCatalogBoards,
    });

    await expect(
      handler({ operation: row, signal: new AbortController().signal }),
    ).resolves.toMatchObject({
      status: "succeeded",
      result: {
        batchIds: context.existingBoard.batchIds,
        candidateCount: 32,
        workflowVersion: "2.8.0",
        pageSize: 8,
        pageCount: 4,
        availablePages: 4,
        reservedPages: 0,
        canGenerateMore: false,
      },
    });
    expect(getCredential).not.toHaveBeenCalled();
    expect(loadStaticTemplateCatalog).not.toHaveBeenCalled();
    expect(persistStaticTemplateCatalogBoards).not.toHaveBeenCalled();
  });

  it("preserves an exact frozen static catalog error instead of reporting board persistence", async () => {
    const row = operation();
    row.input = {
      schemaVersion: 3,
      knowledgeSnapshotId: snapshotId,
      workflowVersion: "2.8.0",
      catalogVersion: "21st-included-recommended-20260828-v1",
      mode: "initial",
      page: 1,
      admissionRevision: 4,
    };
    const context = providerContext();
    context.project.revision = 4;
    const loadStaticTemplateCatalog = vi.fn(async () => {
      throw new StaticTemplateCatalogError(
        "STATIC_TEMPLATE_CATALOG_VERSION_NOT_FOUND",
      );
    });
    const handler = createTwentyFirstSiteOpsProviderHandler({
      getDb: async () => ({ fake: "db" }),
      loadContext: async () => context,
      client: { withReadOnlySession: vi.fn() },
      loadStaticTemplateCatalog,
    });

    await expect(
      handler({ operation: row, signal: new AbortController().signal }),
    ).resolves.toMatchObject({
      status: "attention_required",
      code: "STATIC_TEMPLATE_CATALOG_VERSION_NOT_FOUND",
    });
    expect(loadStaticTemplateCatalog).toHaveBeenCalledWith(
      "21st-included-recommended-20260828-v1",
    );
  });

  it("binds nine directed families 1:1 to distinct real search-only 21st references", async () => {
    const secret = "21st_sk_never-persist-this-secret";
    const rawCode = "RAW_PROVIDER_CODE export default function Secret() {}";
    const searchCalls: Array<{
      query: string;
      type: "component";
      limit: number;
    }> = [];
    const detailCalls: Array<string | number> = [];
    let nextId = 1;
    const session: TwentyFirstReadOnlySession = {
      search: vi.fn(async (input) => {
        searchCalls.push(input);
        const familyIndex = Math.floor((nextId - 1) / 4);
        const metadata = familyMetadata(familyIndex);
        return {
          results: Array.from({ length: 4 }, () => {
            const id = nextId++;
            return {
              id,
              name: `${metadata.name} ${id}`,
              description: metadata.description,
              previewUrl: `https://cdn.example.test/${id}.png`,
              videoUrl: `https://cdn.example.test/${id}.mp4`,
              installCommand: "npx 21st add forbidden",
              componentCode: rawCode,
              demoCode: "RAW_DEMO_CODE",
            };
          }),
        };
      }),
      getComponent: vi.fn(async (providerItemId) => {
        detailCalls.push(providerItemId);
        return {
          data: {
            id: providerItemId,
            componentId: providerItemId,
            name: `Responsive modular hero ${providerItemId}`,
            description: "Light canvas, neutral sans, short transition",
            previewUrl: `https://cdn.example.test/${providerItemId}.png`,
            componentCode: rawCode,
            demoCode: "RAW_DEMO_CODE",
            installCommand: "npx 21st add forbidden",
          },
        };
      }),
    };
    const client = {
      withReadOnlySession: vi.fn(
        async <T>(
          apiKey: string,
          use: (active: TwentyFirstReadOnlySession) => Promise<T>,
        ) => {
          expect(apiKey).toBe(secret);
          return use(session);
        },
      ),
    };
    const artifacts: Array<{
      kind: string;
      buffer: Buffer;
      id: string;
      contentSha256: string;
    }> = [];
    const persistArtifact = vi.fn(
      async (input: { kind: string; buffer: Buffer }) => {
        const row = {
          kind: input.kind,
          buffer: Buffer.from(input.buffer),
          id: randomUUID(),
          contentSha256: sha256(input.buffer),
        };
        artifacts.push(row);
        return row as never;
      },
    );
    let persisted: TwentyFirstBoardPersistenceInput | null = null;
    const persistBoard = vi.fn(
      async (_db: unknown, input: TwentyFirstBoardPersistenceInput) => {
        persisted = input;
        return {
          batchId: "55555555-5555-4555-8555-555555555555",
          candidateCount: input.mirroredCandidates.length,
          selectionBundleHash: input.selectionBundleArtifact.contentSha256,
        };
      },
    );
    const renderCandidates = vi.fn(async ({ blueprints }) =>
      Promise.all(
        blueprints.map(async (blueprint) => ({
          heroFamily: blueprint.heroFamily,
          buffer: await perceptuallyDistinctPng(
            100 + FRONTMIND_VISUAL_FAMILIES_V3.indexOf(blueprint.heroFamily),
          ),
        })),
      ),
    );
    const context = providerContext();
    context.previousReferences = {
      providerItemKeys: ["n:1"],
      previewSha256s: [sha256(await perceptuallyDistinctPng(2))],
      perceptualHashes: [patternHash(3)],
    };
    const handler = createTwentyFirstSiteOpsProviderHandler({
      getDb: async () => ({ fake: "db" }),
      loadContext: async () => context,
      getCredential: async () => ({
        id: credentialId,
        version: 3,
        fingerprint: "fingerprint",
        apiKey: secret,
      }),
      client,
      fetchPreview: vi.fn(async ({ url }) => {
        const id = Number(new URL(url).pathname.replace(/\D/gu, ""));
        const buffer = await perceptuallyDistinctPng(id);
        const familyIndex = Math.floor((id - 1) / 4);
        const visualSignals = [
          { dominantHex: "#241238", brightness: 36, contrast: 74 },
          { dominantHex: "#f5d6b3", brightness: 210, contrast: 68 },
          { dominantHex: "#d9f0ff", brightness: 220, contrast: 64 },
          { dominantHex: "#d9f3df", brightness: 215, contrast: 62 },
          { dominantHex: "#131b4d", brightness: 42, contrast: 76 },
          { dominantHex: "#f7e8d2", brightness: 218, contrast: 66 },
          { dominantHex: "#122f28", brightness: 48, contrast: 72 },
          { dominantHex: "#e8e8e8", brightness: 225, contrast: 61 },
          { dominantHex: "#2d124a", brightness: 40, contrast: 78 },
        ][familyIndex]!;
        return {
          finalUrl: url,
          mimeType: "image/png",
          buffer,
          width: 1200,
          height: 800,
          sha256: sha256(buffer),
          visualSignals,
        };
      }),
      renderCandidates,
      persistArtifact: persistArtifact as never,
      persistBoard,
    });

    const result = await handler({
      operation: operation(),
      signal: new AbortController().signal,
    });

    expect(result).toMatchObject({
      status: "succeeded",
      projectStatus: "awaiting_visual_selection",
      result: {
        candidateCount: 9,
        actual: {
          searched: 36,
          shortlisted: 35,
          mirrored: 9,
          presented: 9,
        },
        diversity: {
          assignedFamilies: 9,
          distinctProviderItems: 9,
          distinctReferenceHashes: 9,
          distinctRealizationHashes: 9,
          distinctStyleSignatures: 9,
        },
      },
    });
    expect(searchCalls.map((call) => call.limit)).toEqual(Array(9).fill(18));
    expect(searchCalls.every((call) => call.type === "component")).toBe(true);
    expect(searchCalls).toHaveLength(9);
    expect(new Set(searchCalls.map((call) => call.query)).size).toBe(9);
    expect(detailCalls).toHaveLength(0);
    expect(
      (
        result.result as {
          diagnostics: {
            exactEligibilityEdges: number;
            terminalReason: string;
          };
        }
      ).diagnostics,
    ).toMatchObject({ terminalReason: "complete" });
    expect(
      (
        result.result as {
          diagnostics: { exactEligibilityEdges: number };
        }
      ).diagnostics.exactEligibilityEdges,
    ).toBeGreaterThanOrEqual(9);
    expect(persisted).not.toBeNull();
    expect(persisted!.searchPlan).toEqual({
      schemaVersion: 1,
      mode: "initial",
      page: 1,
      admissionRevision: 4,
    });
    expect(persisted!.mirroredCandidates).toHaveLength(9);
    expect(renderCandidates).toHaveBeenCalledOnce();
    const renderedBlueprints = renderCandidates.mock.calls[0]![0].blueprints;
    expect(renderedBlueprints).toHaveLength(9);
    expect(
      new Set(renderedBlueprints.map((item) => item.palette.canvas)).size,
    ).toBeGreaterThanOrEqual(4);
    expect(
      new Set(renderedBlueprints.map((item) => item.typeSystem)).size,
    ).toBeGreaterThanOrEqual(3);
    expect(persisted!.selectionBundle).toMatchObject({
      schemaVersion: 4,
      searchTarget: 162,
      referenceTarget: 9,
      displayTarget: 9,
    });
    expect(
      persisted!.selectionBundle.candidates.map((item) => item.label),
    ).toEqual(["A", "B", "C", "D", "E", "F", "G", "H", "I"]);
    expect(
      persisted!.mirroredCandidates.every((item) =>
        item.referenceBlueprint.componentManifest.includes(
          `hero:${item.referenceBlueprint.heroFamily}`,
        ),
      ),
    ).toBe(true);
    expect(persisted!.selectionBundle.candidates[0]).toMatchObject({
      providerItemKey: expect.stringMatching(/^n:/u),
      referencePerceptualHash: expect.stringMatching(/^[a-f0-9]{16}$/u),
      realizationPerceptualHash: expect.stringMatching(/^[a-f0-9]{16}$/u),
      referenceBlueprint: {
        schemaVersion: 4,
        heroFamily: "floating_orbit",
        inspirationEvidenceIds: [expect.stringMatching(/^[a-f0-9]{64}$/u)],
        referencePreviewSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
        styleSignature: expect.stringMatching(/^[a-f0-9]{64}$/u),
      },
      visualEvidence: {
        evidenceKind: "catalog_metadata_preview_v1",
        providerItemKey: expect.stringMatching(/^n:/u),
        taxonomyDerivationVersion: "catalog-metadata-preview-v1",
      },
    });
    expect(
      persisted!.selectionBundle.candidates.some((candidate) =>
        ["n:1", "n:2", "n:3"].includes(candidate.providerItemKey),
      ),
    ).toBe(false);
    expect(persisted!.selectionBundle.degradedReasons).toContain(
      "PREVIEW_RESULTS_REJECTED:2",
    );
    expect(
      new Set(
        persisted!.selectionBundle.candidates.map(
          (candidate) => candidate.referenceBlueprint.heroFamily,
        ),
      ).size,
    ).toBe(9);
    expect(
      new Set(
        persisted!.selectionBundle.candidates.map(
          (candidate) => candidate.previewSha256,
        ),
      ).size,
    ).toBe(9);
    expect(
      persisted!.selectionBundle.candidates.every(
        (candidate) =>
          candidate.previewLocalAssetId ===
            candidate.referenceBlueprint.referencePreviewLocalAssetId &&
          candidate.realizationPreviewLocalAssetId ===
            candidate.referenceBlueprint.previewLocalAssetId &&
          candidate.previewSha256 !== candidate.realizationPreviewSha256,
      ),
    ).toBe(true);
    const persistedText = JSON.stringify(persisted);
    const artifactText = Buffer.concat(
      artifacts.map((artifact) => artifact.buffer),
    ).toString("utf8");
    for (const sensitive of [secret, rawCode, "RAW_DEMO_CODE", "npx 21st"]) {
      expect(persistedText).not.toContain(sensitive);
      expect(artifactText).not.toContain(sensitive);
    }
    expect(
      artifacts.filter((artifact) => artifact.kind === "21st-visual-preview"),
    ).toHaveLength(9);
    expect(
      artifacts.filter(
        (artifact) => artifact.kind === "frontmind-visual-preview",
      ),
    ).toHaveLength(9);
    expect(
      artifacts.filter((artifact) => artifact.kind === "21st-selection-bundle"),
    ).toHaveLength(1);
  });

  it("replays 32 catalog candidates -> 29 downloads -> 27 prepared candidates and freezes three complete pages", async () => {
    const row = operation();
    row.input = {
      knowledgeSnapshotId: snapshotId,
      credentialId,
      credentialVersion: 3,
      workflowVersion: "2.5.0",
    };
    const secret = "21st_sk_template_secret_never_log";
    const templates = Array.from({ length: 64 }, (_, index) => ({
      templateId: index + 1,
      slug: `complete-template-${index + 1}`,
      name: `Official Template ${index + 1}`,
      version: `v${index + 1}`,
      // The official purchase contract may omit both optional catalog flags;
      // listNativeTemplates has already proven isUnlocked in that case.
      verified: false,
      includedWithPlan: false,
      sortRank: index,
      previewUrl: `https://cdn.21st.dev/templates/complete-${index + 1}.png`,
      sourceOwner: "frontmind-fixtures",
      sourceRepo: `template-${index + 1}`,
      sourceCommitSha: (index + 1).toString(16).padStart(40, "0"),
      sourceSubdirectory: null,
      sourceLicense: "MIT" as const,
    }));
    const withReadOnlySession = vi.fn();
    const listNativeTemplates = vi.fn(async () => templates);
    let downloadCalls = 0;
    const downloadNativeTemplate = vi.fn(async (_apiKey, input) => {
      downloadCalls += 1;
      if (downloadCalls === 1) {
        throw new TwentyFirstNativeTemplateError("download_unavailable", true);
      }
      if (downloadCalls <= 4) {
        throw new TwentyFirstNativeTemplateError("download_unavailable");
      }
      return {
        templateId: input.templateId,
        slug: input.slug,
        version: input.version ?? null,
        archive: new Uint8Array(Buffer.from(`zip:${input.slug}`)),
        sha256: sha256(Buffer.from(`zip:${input.slug}`)),
        contentType: "application/zip" as const,
        sourceUrlOrigin: "https://21st.dev" as const,
      };
    });
    let prepareCalls = 0;
    let activePreparations = 0;
    let maximumPreparations = 0;
    const prepareNativeTemplateCandidate = vi.fn(async (input) => {
      const call = prepareCalls++;
      activePreparations += 1;
      maximumPreparations = Math.max(maximumPreparations, activePreparations);
      try {
        await new Promise((resolve) => setTimeout(resolve, 1));
        if (call < 2) {
          throw new NativeVisualSourceError("NATIVE_TEMPLATE_COMPILE_FAILED");
        }
        return await preparedTemplateFixture({
          templateId: input.templateId,
          slug: input.slug,
          version: input.version,
          seed: 200 + call,
        });
      } finally {
        activePreparations -= 1;
      }
    });
    let currentContext = providerContext();
    const taskStartedAt = currentContext.project.currentTaskStartedAt;
    let persisted: TwentyFirstBoardPersistenceInput | null = null;
    const persistedPages: TwentyFirstBoardPersistenceInput[] = [];
    let selectionArtifact: Buffer | null = null;
    let frozenPool: NativeTemplatePoolPersistenceInput | null = null;
    const publishedPages = new Set<number>();
    const artifacts = new Map<
      string,
      { buffer: Buffer; contentSha256: string; mimeType: string; kind: string }
    >();
    const getCredential = vi.fn(async () => ({
      id: credentialId,
      version: 3,
      fingerprint: "fingerprint",
      apiKey: secret,
    }));
    const createHandler = () =>
      createTwentyFirstSiteOpsProviderHandler({
        getDb: async () => ({ fake: "db" }),
        loadContext: async () => currentContext,
        getCredential,
        client: {
          withReadOnlySession,
          listNativeTemplates,
          downloadNativeTemplate,
        },
        prepareNativeTemplateCandidate,
        resolveNativeTemplateShuffleKey: () => Buffer.alloc(32, 0x41),
        persistArtifact: vi.fn(async (input) => {
          const id = randomUUID();
          const contentSha256 = sha256(input.buffer);
          artifacts.set(id, {
            buffer: Buffer.from(input.buffer),
            contentSha256,
            mimeType: input.mimeType,
            kind: input.kind,
          });
          return {
            id,
            contentSha256,
          } as never;
        }),
        loadNativeTemplatePoolState: async ({ page, workflowVersion }) => {
          expect(workflowVersion).toBe("2.5.0");
          if (!frozenPool) return null;
          const frozenPage = frozenPool.pages.find(
            (candidate) => candidate.pageNumber === page,
          );
          return {
            poolId: frozenPool.poolId,
            pageCount: frozenPool.pages.length,
            availablePages: frozenPool.pages.length,
            reservedPages: frozenPool.pages.length - publishedPages.size,
            page:
              frozenPage && !publishedPages.has(page)
                ? {
                    pageNumber: page,
                    selectionBundleLocalAssetId:
                      frozenPage.selectionBundleArtifact.id,
                    selectionBundleHash:
                      frozenPage.selectionBundleArtifact.contentSha256,
                    items: frozenPage.items,
                  }
                : null,
          };
        },
        persistNativeTemplatePool: vi.fn(async (_db, input) => {
          frozenPool = input;
          return { poolId: input.poolId, created: true };
        }),
        readArtifact: vi.fn(async (input) => {
          const artifact = artifacts.get(input.localAssetId);
          if (!artifact) return null;
          return {
            row: {
              id: input.localAssetId,
              contentSha256: artifact.contentSha256,
              sizeBytes: artifact.buffer.length,
              mimeType: artifact.mimeType,
            },
            stored: {
              sizeBytes: artifact.buffer.length,
              sha256: artifact.contentSha256,
              createReadStream: () => Readable.from(artifact.buffer),
            },
          } as never;
        }),
        persistBoard: vi.fn(async (_db, input) => {
          persisted = input;
          persistedPages.push(input);
          if (input.candidatePoolPage) {
            publishedPages.add(input.candidatePoolPage.pageNumber);
          }
          selectionArtifact = artifacts.get(
            input.selectionBundleArtifact.id,
          )!.buffer;
          return {
            batchId: randomUUID(),
            candidateCount: input.mirroredCandidates.length,
            selectionBundleHash: input.selectionBundleArtifact.contentSha256,
          };
        }),
      });

    const handler = createHandler();
    const result = await handler({
      operation: row,
      signal: new AbortController().signal,
    });

    expect(result).toMatchObject({
      status: "succeeded",
      result: {
        candidateCount: 9,
        diagnostics: {
          templateMode: true,
          catalogCandidates: 32,
          templateDownloadAttempts: 33,
          templateDownloadsSucceeded: 29,
          sourcePreparationAttempts: 29,
          sourcePrepared: 27,
          previewFetchAttempts: 29,
          compileAttempts: 0,
          renderAttempts: 0,
          capacityCandidates: 27,
          capacityRequired: 27,
          capacityPages: 3,
          capacitySelected: 9,
          publishedCount: 9,
        },
      },
    });
    expect(withReadOnlySession).not.toHaveBeenCalled();
    expect(listNativeTemplates).toHaveBeenCalledOnce();
    expect(listNativeTemplates.mock.calls[0]![0]).toBe(secret);
    expect(listNativeTemplates.mock.calls[0]![1]).toMatchObject({
      limit: 60,
      excludeTemplateIds: [],
      excludeSlugs: [],
    });
    expect(JSON.stringify(listNativeTemplates.mock.calls)).not.toContain(
      "FrontMind",
    );
    expect(JSON.stringify(listNativeTemplates.mock.calls)).not.toContain(
      "GEO Analytics",
    );
    expect(downloadNativeTemplate).toHaveBeenCalledTimes(33);
    const downloadedTemplateIds = downloadNativeTemplate.mock.calls.map(
      ([, input]) => String(input.templateId),
    );
    expect(new Set(downloadedTemplateIds).size).toBe(32);
    expect(downloadedTemplateIds).not.toEqual(
      Array.from({ length: 32 }, (_, index) => String(index + 1)),
    );
    expect(prepareNativeTemplateCandidate).toHaveBeenCalledTimes(29);
    expect(maximumPreparations).toBeLessThanOrEqual(3);
    expect(persisted!.selectionBundle).toMatchObject({
      schemaVersion: 6,
      renderer: "twenty_first_native_template_v1",
      displayTarget: 9,
    });
    expect(
      new Set(
        persisted!.selectionBundle.candidates.map(
          (candidate) => candidate.providerTemplateId,
        ),
      ).size,
    ).toBe(9);
    expect(selectionArtifact).not.toBeNull();
    const restored = await readVisualSelectionBundleArtifact(
      selectionArtifact!,
    );
    expect(restored.bundle.schemaVersion).toBe(6);
    expect(restored.archives.size).toBe(9);
    expect(
      restored.bundle.candidates.every(
        (candidate) =>
          candidate.styleTokens?.previewSha256 === candidate.previewSha256 &&
          candidate.styleTokens.sourceTreeSha256 === candidate.sourceTreeSha256,
      ),
    ).toBe(true);
    expect(frozenPool).not.toBeNull();
    expect(frozenPool!.pages).toHaveLength(3);
    expect(frozenPool!.pages.flatMap((page) => page.items)).toHaveLength(27);
    expect(
      new Set(
        frozenPool!.pages.flatMap((page) =>
          page.items.map((item) => item.previewLocalAssetId),
        ),
      ).size,
    ).toBe(27);
    expect(
      frozenPool!.pages.every(
        (page) =>
          page.selectionBundleSizeBytes < 100 * 1024 * 1024 &&
          artifacts.get(page.selectionBundleArtifact.id)?.kind ===
            "21st-selection-bundle",
      ),
    ).toBe(true);
    expect(
      new Set(
        frozenPool!.pages.map(
          (page) => page.selectionBundleArtifact.contentSha256,
        ),
      ).size,
    ).toBe(3);
    expect(
      [...artifacts.values()].filter(
        (artifact) => artifact.kind === "21st-native-template-preview",
      ),
    ).toHaveLength(27);

    // Reclaim after the board transaction but before operation finalization
    // must recover the authoritative frozen capacity without touching 21st.
    currentContext.existingBoard = {
      batchId: randomUUID(),
      candidateCount: 9,
      selectionBundleHash: persisted!.selectionBundleArtifact.contentSha256,
    };
    await expect(
      createHandler()({
        operation: row,
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({
      status: "succeeded",
      result: { availablePages: 3, reservedPages: 2 },
    });
    currentContext.existingBoard = null;

    // Simulate a worker/process restart and a complete 21st/GitHub outage.
    // Page two and three must be restored only from their frozen V6 ZIPs.
    for (const page of [2, 3] as const) {
      currentContext = providerContext();
      currentContext.project.currentTaskStartedAt = taskStartedAt;
      currentContext.project.status = "awaiting_visual_selection";
      currentContext.publishedPageCount = page - 1;
      const nextOperation = supplementalOperation(page);
      nextOperation.id = `44444444-4444-4444-8444-44444444444${page}`;
      nextOperation.input = {
        ...(nextOperation.input as Record<string, unknown>),
        workflowVersion: "2.5.0",
      };
      await expect(
        createHandler()({
          operation: nextOperation,
          signal: new AbortController().signal,
        }),
      ).resolves.toMatchObject({
        status: "succeeded",
        result: {
          page,
          candidateCount: 9,
          availablePages: 3,
          reservedPages: 3 - page,
        },
      });
    }
    expect(getCredential).toHaveBeenCalledOnce();
    expect(listNativeTemplates).toHaveBeenCalledOnce();
    expect(downloadNativeTemplate).toHaveBeenCalledTimes(33);
    expect(
      persistedPages.map((page) => page.candidatePoolPage?.pageNumber),
    ).toEqual([1, 2, 3]);
    expect(
      new Set(
        persistedPages.flatMap((page) =>
          page.mirroredCandidates.map((candidate) =>
            "providerTemplateId" in candidate
              ? candidate.providerTemplateId
              : candidate.sampleId,
          ),
        ),
      ).size,
    ).toBe(27);
    expect(
      persistedPages.every((page) =>
        page.mirroredCandidates.every(
          (candidate) =>
            !("providerTemplateId" in candidate) ||
            (candidate.styleTokens?.previewSha256 === candidate.previewSha256 &&
              candidate.styleTokens.sourceTreeSha256 ===
                candidate.sourceTreeSha256),
        ),
      ),
    ).toBe(true);
  });

  it("legacy-backfills only page two from 23 remaining coordinates when 17 prepare and keeps page three closed", async () => {
    const row = supplementalOperation(2);
    row.input = {
      ...(row.input as Record<string, unknown>),
      workflowVersion: "2.5.0",
    };
    const templates = Array.from({ length: 32 }, (_, index) => ({
      templateId: index + 1,
      slug: `complete-template-${index + 1}`,
      name: `Template ${index + 1}`,
      version: null,
      verified: true,
      includedWithPlan: true,
      sortRank: index,
      previewUrl: `https://cdn.21st.dev/templates/page-${index + 1}.png`,
      sourceOwner: "frontmind-fixtures",
      sourceRepo: `template-${index + 1}`,
      sourceCommitSha: (index + 1).toString(16).padStart(40, "0"),
      sourceSubdirectory: null,
      sourceLicense: "MIT" as const,
    }));
    const context = providerContext();
    context.project.status = "awaiting_visual_selection";
    context.publishedPageCount = 1;
    context.previousReferences = {
      providerItemKeys: Array.from(
        { length: 9 },
        (_, index) => `t:${index + 1}:complete-template-${index + 1}`,
      ),
      previewSha256s: [],
      perceptualHashes: [],
      sourceTreeSha256s: [],
      nativePreviewSha256s: [],
    };
    const downloadedIds: number[] = [];
    let preparationAttempts = 0;
    let persisted: TwentyFirstBoardPersistenceInput | null = null;
    let frozenPool: NativeTemplatePoolPersistenceInput | null = null;
    const publishedPages = new Set<number>();
    const listNativeTemplates = vi.fn(async () => templates);
    const getCredential = vi.fn(async () => ({
      id: credentialId,
      version: 3,
      fingerprint: "fingerprint",
      apiKey: "21st_sk_test_secret",
    }));
    const handler = createTwentyFirstSiteOpsProviderHandler({
      getDb: async () => ({ fake: "db" }),
      loadContext: async () => context,
      getCredential,
      client: {
        withReadOnlySession: vi.fn(),
        listNativeTemplates,
        downloadNativeTemplate: vi.fn(async (_key, input) => {
          downloadedIds.push(Number(input.templateId));
          const archive = Buffer.from(`zip:${input.slug}`);
          return {
            templateId: input.templateId,
            slug: input.slug,
            version: null,
            archive: new Uint8Array(archive),
            sha256: sha256(archive),
            contentType: "application/zip" as const,
            sourceUrlOrigin: "https://21st.dev" as const,
          };
        }),
      },
      resolveNativeTemplateShuffleKey: () => Buffer.alloc(32, 0x42),
      prepareNativeTemplateCandidate: vi.fn(async (input) => {
        preparationAttempts += 1;
        if (preparationAttempts <= 6) {
          throw new NativeVisualSourceError("NATIVE_TEMPLATE_COMPILE_FAILED");
        }
        return preparedTemplateFixture({
          templateId: input.templateId,
          slug: input.slug,
          version: input.version,
          seed: 500 + Number(input.templateId),
        });
      }),
      persistArtifact: vi.fn(async (input) => ({
        id: randomUUID(),
        contentSha256: sha256(input.buffer),
      })) as never,
      loadNativeTemplatePoolState: vi.fn(async ({ page, workflowVersion }) => {
        expect(workflowVersion).toBe("2.5.0");
        if (!frozenPool) return null;
        const frozenPage = frozenPool.pages.find(
          (candidate) => candidate.pageNumber === page,
        );
        return {
          poolId: frozenPool.poolId,
          pageCount: frozenPool.pages.length,
          availablePages: 2,
          reservedPages: frozenPool.pages.filter(
            (candidate) => !publishedPages.has(candidate.pageNumber),
          ).length,
          page:
            frozenPage && !publishedPages.has(page)
              ? {
                  pageNumber: page,
                  selectionBundleLocalAssetId:
                    frozenPage.selectionBundleArtifact.id,
                  selectionBundleHash:
                    frozenPage.selectionBundleArtifact.contentSha256,
                  items: frozenPage.items,
                }
              : null,
        };
      }),
      persistNativeTemplatePool: vi.fn(async (_db, input) => {
        frozenPool = input;
        return { poolId: input.poolId, created: true };
      }),
      persistBoard: vi.fn(async (_db, input) => {
        persisted = input;
        if (input.candidatePoolPage) {
          publishedPages.add(input.candidatePoolPage.pageNumber);
        }
        return {
          batchId: "55555555-5555-4555-8555-555555555555",
          candidateCount: input.mirroredCandidates.length,
          selectionBundleHash: input.selectionBundleArtifact.contentSha256,
        };
      }),
    });

    await expect(
      handler({ operation: row, signal: new AbortController().signal }),
    ).resolves.toMatchObject({
      status: "succeeded",
      result: {
        page: 2,
        candidateCount: 9,
        availablePages: 2,
        reservedPages: 0,
      },
    });
    expect(downloadedIds).toHaveLength(23);
    expect(preparationAttempts).toBe(23);
    expect(downloadedIds.every((id) => id > 9)).toBe(true);
    expect(frozenPool?.pages).toHaveLength(1);
    expect(frozenPool?.pages[0]?.pageNumber).toBe(2);
    expect(persisted!.selectionBundle.schemaVersion).toBe(6);
    expect(
      persisted!.mirroredCandidates.every(
        (candidate) =>
          "providerTemplateId" in candidate &&
          Number(candidate.providerTemplateId) > 9,
      ),
    ).toBe(true);

    const pageThree = supplementalOperation(3);
    pageThree.input = {
      ...(pageThree.input as Record<string, unknown>),
      workflowVersion: "2.5.0",
    };
    context.publishedPageCount = 2;
    await expect(
      handler({
        operation: pageThree,
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({
      status: "attention_required",
      code: "VISUAL_CANDIDATE_POOL_EXHAUSTED",
      result: { availablePages: 2, reservedPages: 0 },
    });
    expect(getCredential).toHaveBeenCalledOnce();
    expect(listNativeTemplates).toHaveBeenCalledOnce();
  });

  it("publishes three pages of 27 different V6 Templates even when every preview has the same perceptual hash", async () => {
    const templates = Array.from({ length: 32 }, (_, index) => ({
      templateId: index + 1,
      slug: `random-template-${index + 1}`,
      name: `Random Template ${index + 1}`,
      version: (index + 1).toString(16).padStart(40, "0"),
      verified: true,
      includedWithPlan: true,
      sortRank: index,
      previewUrl: `https://cdn.21st.dev/templates/random-${index + 1}.png`,
      sourceOwner: "frontmind-fixtures",
      sourceRepo: `random-template-${index + 1}`,
      sourceCommitSha: (index + 1).toString(16).padStart(40, "0"),
      sourceSubdirectory: null,
      sourceLicense: "MIT" as const,
    }));
    const commonPreview = await perceptuallyDistinctPng(909);
    const previous = {
      providerItemKeys: [] as string[],
      previewSha256s: [] as string[],
      perceptualHashes: [] as string[],
      sourceTreeSha256s: [] as string[],
      nativePreviewSha256s: [] as string[],
      providerTemplateIds: [] as string[],
      providerTemplateSlugs: [] as string[],
    };
    const published: Array<{
      providerTemplateId: string;
      providerSlug: string;
      providerItemKey: string;
      sourceTreeSha256: string;
      previewSha256: string;
      previewPerceptualHash: string;
    }> = [];

    for (const page of [1, 2, 3] as const) {
      const context = providerContext();
      context.project.status =
        page === 1 ? "visual_searching" : "awaiting_visual_selection";
      context.publishedPageCount = page - 1;
      context.previousReferences = {
        providerItemKeys: [...previous.providerItemKeys],
        previewSha256s: [...previous.previewSha256s],
        perceptualHashes: [...previous.perceptualHashes],
        sourceTreeSha256s: [...previous.sourceTreeSha256s],
        nativePreviewSha256s: [...previous.nativePreviewSha256s],
        providerTemplateIds: [...previous.providerTemplateIds],
        providerTemplateSlugs: [...previous.providerTemplateSlugs],
      };
      const row =
        page === 1 ? initialV2Operation(4) : supplementalOperation(page, 4);
      row.id = `44444444-4444-4444-8444-44444444444${page}`;
      row.input = {
        ...(row.input as Record<string, unknown>),
        workflowVersion: "2.5.0",
      };
      let persisted: TwentyFirstBoardPersistenceInput | null = null;
      const handler = createTwentyFirstSiteOpsProviderHandler({
        getDb: async () => ({ fake: "db" }),
        loadContext: async () => context,
        getCredential: async () => ({
          id: credentialId,
          version: 3,
          fingerprint: "fingerprint",
          apiKey: "21st_sk_test_secret",
        }),
        client: {
          withReadOnlySession: vi.fn(),
          listNativeTemplates: vi.fn(async () => templates),
          downloadNativeTemplate: vi.fn(async (_key, input) => {
            const archive = Buffer.from(`zip:${input.slug}`);
            return {
              templateId: input.templateId,
              slug: input.slug,
              version: input.version ?? null,
              archive: new Uint8Array(archive),
              sha256: sha256(archive),
              contentType: "application/zip" as const,
              sourceUrlOrigin: "https://21st.dev" as const,
            };
          }),
        },
        resolveNativeTemplateShuffleKey: () => Buffer.alloc(32, 0x50 + page),
        prepareNativeTemplateCandidate: vi.fn(async (input) => {
          const prepared = await preparedTemplateFixture({
            templateId: input.templateId,
            slug: input.slug,
            version: input.version,
            seed: 909,
          });
          const preview = Buffer.concat([
            commonPreview,
            Buffer.from(`:${String(input.templateId)}`),
          ]);
          return {
            ...prepared,
            preview,
            previewSha256: sha256(preview),
            styleTokens: {
              ...prepared.styleTokens,
              previewSha256: sha256(preview),
            },
          };
        }),
        persistArtifact: vi.fn(async (input) => ({
          id: randomUUID(),
          contentSha256: sha256(input.buffer),
        })) as never,
        persistBoard: vi.fn(async (_db, input) => {
          persisted = input;
          return {
            batchId: randomUUID(),
            candidateCount: input.mirroredCandidates.length,
            selectionBundleHash: input.selectionBundleArtifact.contentSha256,
          };
        }),
      });

      await expect(
        handler({ operation: row, signal: new AbortController().signal }),
      ).resolves.toMatchObject({
        status: "succeeded",
        result: { page, candidateCount: 9 },
      });
      const pageCandidates = persisted!.mirroredCandidates.flatMap(
        (candidate) =>
          "providerTemplateId" in candidate
            ? [
                {
                  providerTemplateId: candidate.providerTemplateId,
                  providerSlug: candidate.providerSlug,
                  providerItemKey: candidate.providerItemKey,
                  sourceTreeSha256: candidate.sourceTreeSha256,
                  previewSha256: candidate.previewSha256,
                  previewPerceptualHash: candidate.previewPerceptualHash,
                },
              ]
            : [],
      );
      expect(pageCandidates).toHaveLength(9);
      published.push(...pageCandidates);
      previous.providerItemKeys.push(
        ...pageCandidates.map((candidate) => candidate.providerItemKey),
      );
      previous.perceptualHashes.push(
        ...pageCandidates.map((candidate) => candidate.previewPerceptualHash),
      );
      previous.sourceTreeSha256s.push(
        ...pageCandidates.map((candidate) => candidate.sourceTreeSha256),
      );
      previous.nativePreviewSha256s.push(
        ...pageCandidates.map((candidate) => candidate.previewSha256),
      );
      previous.providerTemplateIds.push(
        ...pageCandidates.map((candidate) => candidate.providerTemplateId),
      );
      previous.providerTemplateSlugs.push(
        ...pageCandidates.map((candidate) => candidate.providerSlug),
      );
    }

    expect(published).toHaveLength(27);
    expect(new Set(published.map((item) => item.providerTemplateId)).size).toBe(
      27,
    );
    expect(new Set(published.map((item) => item.providerSlug)).size).toBe(27);
    expect(new Set(published.map((item) => item.providerItemKey)).size).toBe(
      27,
    );
    expect(new Set(published.map((item) => item.sourceTreeSha256)).size).toBe(
      27,
    );
    expect(new Set(published.map((item) => item.previewSha256)).size).toBe(27);
    expect(
      new Set(published.map((item) => item.previewPerceptualHash)).size,
    ).toBe(1);
  });

  it("returns the aggregate live-template pool error without calling get_component", async () => {
    const row = operation();
    row.input = {
      knowledgeSnapshotId: snapshotId,
      credentialId,
      credentialVersion: 3,
      workflowVersion: "2.5.0",
    };
    const templates = Array.from({ length: 12 }, (_, index) => ({
      templateId: index + 1,
      slug: `template-${index + 1}`,
      name: `Template ${index + 1}`,
      version: null,
      verified: true,
      includedWithPlan: false,
      sortRank: index,
      previewUrl: `https://cdn.21st.dev/templates/failure-${index + 1}.png`,
      sourceOwner: "frontmind-fixtures",
      sourceRepo: `template-${index + 1}`,
      sourceCommitSha: (index + 1).toString(16).padStart(40, "0"),
      sourceSubdirectory: null,
      sourceLicense: "MIT" as const,
    }));
    const withReadOnlySession = vi.fn();
    const persistBoard = vi.fn();
    const handler = createTwentyFirstSiteOpsProviderHandler({
      getDb: async () => ({ fake: "db" }),
      loadContext: async () => providerContext(),
      getCredential: async () => ({
        id: credentialId,
        version: 3,
        fingerprint: "fingerprint",
        apiKey: "21st_sk_test_secret",
      }),
      client: {
        withReadOnlySession,
        listNativeTemplates: vi.fn(async () => templates),
        downloadNativeTemplate: vi.fn(async (_key, input) => ({
          templateId: input.templateId,
          slug: input.slug,
          version: null,
          archive: new Uint8Array([0x50, 0x4b, 0x03, 0x04]),
          sha256: "a".repeat(64),
          contentType: "application/zip" as const,
          sourceUrlOrigin: "https://21st.dev" as const,
        })),
      },
      resolveNativeTemplateShuffleKey: () => Buffer.alloc(32, 0x43),
      prepareNativeTemplateCandidate: vi.fn(async () => {
        throw new NativeVisualSourceError("NATIVE_TEMPLATE_COMPILE_FAILED");
      }),
      persistArtifact: vi.fn() as never,
      persistBoard,
    });

    await expect(
      handler({ operation: row, signal: new AbortController().signal }),
    ).resolves.toMatchObject({
      status: "attention_required",
      code: "NATIVE_TEMPLATE_BUILD_POOL_INSUFFICIENT",
      result: {
        templateMode: true,
        catalogCandidates: 12,
        templateDownloadAttempts: 12,
        sourcePreparationAttempts: 12,
        compileAttempts: 0,
        publishedCount: 0,
        capacityCandidates: 0,
        capacityRequired: 27,
        templateFailureCategory: "insufficient_live_templates",
      },
    });
    expect(withReadOnlySession).not.toHaveBeenCalled();
    expect(persistBoard).not.toHaveBeenCalled();
  });

  it.skip("retires V5 component-source board generation after the V6 Template cutover", async () => {
    const row = operation();
    row.input = {
      knowledgeSnapshotId: snapshotId,
      credentialId,
      credentialVersion: 3,
      workflowVersion: "2.5.0",
    };
    let nextId = 1;
    const search = vi.fn(async () => {
      const familyIndex = Math.floor((nextId - 1) / 4);
      const metadata = familyMetadata(familyIndex);
      return {
        results: Array.from({ length: 4 }, () => {
          const id = nextId++;
          return {
            id,
            name: `${metadata.name} ${id}`,
            description: metadata.description,
            previewUrl: `https://cdn.example.test/${id}.png`,
          };
        }),
      };
    });
    const getComponent = vi.fn(async (providerItemId: string | number) => ({
      data: {
        id: providerItemId,
        version: `v${providerItemId}`,
        componentCode: `import React from "react";export default function Native${providerItemId}(){return <main>Native ${providerItemId}</main>}`,
        demoCode: `import React from "react";import Native from "./component";export default function Demo${providerItemId}(){return <Native/>}`,
        dependencies: ["react@19.2.1", "react-dom@19.2.1"],
      },
    }));
    const selectionArtifacts: Array<{
      buffer: Buffer;
      mimeType: string;
      maxBytes: number;
    }> = [];
    let persisted: TwentyFirstBoardPersistenceInput | null = null;
    const renderCandidates = vi.fn();
    let activeNativePreparations = 0;
    let maximumNativePreparations = 0;
    const handler = createTwentyFirstSiteOpsProviderHandler({
      getDb: async () => ({ fake: "db" }),
      loadContext: async () => providerContext(),
      getCredential: async () => ({
        id: credentialId,
        version: 3,
        fingerprint: "fingerprint",
        apiKey: "21st_sk_test_secret",
      }),
      client: {
        withReadOnlySession: async (_apiKey, use) =>
          use({
            effectiveSearchLimit: 18,
            search,
            getComponent,
          }),
      },
      fetchPreview: vi.fn(async ({ url }) => {
        const id = Number(new URL(url).pathname.replace(/\D/gu, ""));
        const buffer = await perceptuallyDistinctPng(id);
        return {
          finalUrl: url,
          mimeType: "image/png",
          buffer,
          width: 1200,
          height: 800,
          sha256: sha256(buffer),
          visualSignals: {
            dominantHex: "#f5f5f5",
            brightness: 220,
            contrast: 70,
          },
        };
      }),
      prepareNativeCandidate: vi.fn(async ({ candidate, payload }) => {
        activeNativePreparations += 1;
        maximumNativePreparations = Math.max(
          maximumNativePreparations,
          activeNativePreparations,
        );
        try {
          await new Promise((resolve) => setTimeout(resolve, 2));
          if (candidate.providerItemId === 1) {
            throw new Error("provider source is incomplete");
          }
          const source = normalizeTwentyFirstNativeSource({
            candidate,
            payload,
          });
          const sourceArchive = await createNativeSourceArchive(source);
          const preview = await perceptuallyDistinctPng(
            100 + Number(candidate.providerItemId),
          );
          return {
            ...source,
            sourceArchive,
            sourceArchiveSha256: sha256(sourceArchive),
            preview,
            previewSha256: sha256(preview),
          };
        } finally {
          activeNativePreparations -= 1;
        }
      }),
      renderCandidates,
      persistArtifact: vi.fn(async (input) => {
        if (input.kind === "21st-selection-bundle") {
          selectionArtifacts.push({
            buffer: Buffer.from(input.buffer),
            mimeType: input.mimeType,
            maxBytes: input.maxBytes,
          });
        }
        return {
          id: randomUUID(),
          contentSha256: sha256(input.buffer),
        } as never;
      }),
      persistBoard: vi.fn(async (_db, input) => {
        persisted = input;
        return {
          batchId: "55555555-5555-4555-8555-555555555555",
          candidateCount: input.mirroredCandidates.length,
          selectionBundleHash: input.selectionBundleArtifact.contentSha256,
        };
      }),
    });

    await expect(
      handler({
        operation: row,
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({
      status: "succeeded",
      result: { candidateCount: 9, actual: { presented: 9 } },
    });
    expect(renderCandidates).not.toHaveBeenCalled();
    // A source-level rejection must remove only that catalog item and follow
    // the existing matching graph to a deeper, source-backed replacement.
    expect(getComponent.mock.calls.length).toBeGreaterThan(9);
    expect(maximumNativePreparations).toBeLessThanOrEqual(3);
    expect(search).toHaveBeenCalledTimes(9);
    expect(
      search.mock.calls.every(
        ([input]) =>
          input.tag === undefined &&
          input.query.includes(
            "complete responsive landing page homepage source",
          ),
      ),
    ).toBe(true);
    expect(persisted!.selectionBundle).toMatchObject({
      schemaVersion: 5,
      renderer: "twenty_first_native_react_v1",
      displayTarget: 9,
    });
    expect(
      persisted!.mirroredCandidates.every(
        (candidate) =>
          "sourceTreeSha256" in candidate &&
          candidate.previewLocalAssetId !==
            candidate.referencePreviewLocalAssetId,
      ),
    ).toBe(true);
    expect(selectionArtifacts).toHaveLength(1);
    expect(selectionArtifacts[0]).toMatchObject({
      mimeType: "application/zip",
      maxBytes: 25 * 1024 * 1024,
    });
    const restored = await readVisualSelectionBundleArtifact(
      selectionArtifacts[0]!.buffer,
    );
    expect(restored.bundle.candidates).toHaveLength(9);
    expect(restored.archives.size).toBe(9);
  });

  it.skip("retires V5 get_component admission after the V6 Template cutover", async () => {
    const row = operation();
    row.input = {
      knowledgeSnapshotId: snapshotId,
      credentialId,
      credentialVersion: 3,
      workflowVersion: "2.5.0",
    };
    let nextId = 1;
    const persistArtifact = vi.fn();
    const persistBoard = vi.fn();
    const prepareNativeCandidate = vi.fn();
    const handler = createTwentyFirstSiteOpsProviderHandler({
      getDb: async () => ({ fake: "db" }),
      loadContext: async () => providerContext(),
      getCredential: async () => ({
        id: credentialId,
        version: 3,
        fingerprint: "fingerprint",
        apiKey: "21st_sk_test_secret",
      }),
      client: {
        withReadOnlySession: async (_apiKey, use) =>
          use({
            effectiveSearchLimit: 18,
            search: async () => {
              const familyIndex = Math.floor((nextId - 1) / 4);
              const metadata = familyMetadata(familyIndex);
              return {
                results: Array.from({ length: 4 }, () => {
                  const id = nextId++;
                  return {
                    id,
                    name: `${metadata.name} ${id}`,
                    description: metadata.description,
                    previewUrl: `https://cdn.example.test/${id}.png`,
                  };
                }),
              };
            },
          }),
      },
      fetchPreview: vi.fn(async ({ url }) => {
        const id = Number(new URL(url).pathname.replace(/\D/gu, ""));
        const buffer = await perceptuallyDistinctPng(id);
        return {
          finalUrl: url,
          mimeType: "image/png",
          buffer,
          width: 1200,
          height: 800,
          sha256: sha256(buffer),
          visualSignals: {
            dominantHex: "#f5f5f5",
            brightness: 220,
            contrast: 70,
          },
        };
      }),
      prepareNativeCandidate,
      persistArtifact: persistArtifact as never,
      persistBoard,
    });

    await expect(
      handler({
        operation: row,
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({
      status: "attention_required",
      code: "MCP_GET_COMPONENT_REQUIRED",
    });
    expect(prepareNativeCandidate).not.toHaveBeenCalled();
    expect(persistArtifact).not.toHaveBeenCalled();
    expect(persistBoard).not.toHaveBeenCalled();
  });

  it.skip("retires V5 component-source contract rejection accounting", async () => {
    const row = operation();
    row.input = {
      knowledgeSnapshotId: snapshotId,
      credentialId,
      credentialVersion: 3,
      workflowVersion: "2.5.0",
    };
    let nextId = 1;
    const search = vi.fn(async () => {
      const familyIndex = Math.floor((nextId - 1) / 4);
      const metadata = familyMetadata(familyIndex);
      return {
        results: Array.from({ length: 4 }, () => {
          const id = nextId++;
          return {
            id,
            name: `${metadata.name} ${id}`,
            description: metadata.description,
            previewUrl: `https://cdn.example.test/${id}.png`,
          };
        }),
      };
    });
    const getComponent = vi.fn(async () => ({
      contractKind: "twenty_first_get_component_v1",
      status: { found: false, locked: false },
      sourceText: "Component not found.",
    }));
    const prepareNativeCandidate = vi.fn();
    const persistBoard = vi.fn();
    const handler = createTwentyFirstSiteOpsProviderHandler({
      getDb: async () => ({ fake: "db" }),
      loadContext: async () => providerContext(),
      getCredential: async () => ({
        id: credentialId,
        version: 3,
        fingerprint: "fingerprint",
        apiKey: "21st_sk_test_secret",
      }),
      client: {
        withReadOnlySession: async (_apiKey, use) =>
          use({ effectiveSearchLimit: 18, search, getComponent }),
      },
      fetchPreview: vi.fn(async ({ url }) => {
        const id = Number(new URL(url).pathname.replace(/\D/gu, ""));
        const buffer = await perceptuallyDistinctPng(id);
        return {
          finalUrl: url,
          mimeType: "image/png",
          buffer,
          width: 1200,
          height: 800,
          sha256: sha256(buffer),
        };
      }),
      prepareNativeCandidate,
      persistArtifact: vi.fn(async (input) => ({
        id: randomUUID(),
        contentSha256: sha256(input.buffer),
      })) as never,
      persistBoard,
    });

    await expect(
      handler({
        operation: row,
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({
      status: "attention_required",
      code: "NATIVE_SOURCE_CANDIDATES_UNAVAILABLE",
      result: {
        mirrorAttempted: 18,
        sourceFetchAttempts: 18,
        sourceFetchSucceeded: 0,
        sourcePreparationAttempts: 0,
        nativeFailureCategory: "source_incomplete",
        terminalReason: "source_failures",
      },
    });
    expect(getComponent).toHaveBeenCalledTimes(18);
    expect(prepareNativeCandidate).not.toHaveBeenCalled();
    expect(persistBoard).not.toHaveBeenCalled();
  });

  it.skip("retires the production-shaped V5 component compilation path", async () => {
    const row = operation();
    row.input = {
      knowledgeSnapshotId: snapshotId,
      credentialId,
      credentialVersion: 3,
      workflowVersion: "2.5.0",
    };
    let searchCall = 0;
    let nextId = 1;
    const search = vi.fn(async () => {
      const currentCall = searchCall++;
      const metadata = familyMetadata(currentCall);
      const resultCount = currentCall < 5 ? 8 : 7;
      return {
        results: Array.from({ length: resultCount }, () => {
          const id = nextId++;
          return {
            id,
            name: `${metadata.name} ${id}`,
            description: metadata.description,
            previewUrl: `https://cdn.example.test/${id}.png`,
          };
        }),
      };
    });
    const getComponent = vi.fn(async (providerItemId: string | number) => ({
      data: { id: providerItemId, componentCode: "source payload" },
    }));
    let sessionOpen = false;
    const prepareNativeCandidate = vi.fn(async () => {
      expect(sessionOpen).toBe(false);
      throw new NativeVisualSourceError("NATIVE_SOURCE_COMPILE_FAILED");
    });
    const persistBoard = vi.fn();
    const handler = createTwentyFirstSiteOpsProviderHandler({
      getDb: async () => ({ fake: "db" }),
      loadContext: async () => providerContext(),
      getCredential: async () => ({
        id: credentialId,
        version: 3,
        fingerprint: "fingerprint",
        apiKey: "21st_sk_test_secret",
      }),
      client: {
        withReadOnlySession: async (_apiKey, use) => {
          sessionOpen = true;
          try {
            return await use({
              effectiveSearchLimit: 18,
              search,
              getComponent,
            });
          } finally {
            sessionOpen = false;
          }
        },
      },
      fetchPreview: vi.fn(async ({ url }) => {
        const id = Number(new URL(url).pathname.replace(/\D/gu, ""));
        const buffer = await perceptuallyDistinctPng(id);
        return {
          finalUrl: url,
          mimeType: "image/png",
          buffer,
          width: 1200,
          height: 800,
          sha256: sha256(buffer),
        };
      }),
      prepareNativeCandidate,
      persistArtifact: vi.fn(async (input) => ({
        id: randomUUID(),
        contentSha256: sha256(input.buffer),
      })) as never,
      persistBoard,
    });

    await expect(
      handler({
        operation: row,
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({
      status: "attention_required",
      code: "NATIVE_SOURCE_COMPILE_UNAVAILABLE",
      result: {
        queryCalls: 9,
        normalizedUnique: 68,
        mirrorAttempted: 18,
        mirrorSucceeded: 18,
        sourceFetchAttempts: 18,
        sourceFetchSucceeded: 18,
        sourcePreparationAttempts: 18,
        sourcePrepared: 0,
        nativeFailureCategory: "compile_failed",
        terminalReason: "source_failures",
      },
    });
    expect(getComponent).toHaveBeenCalledTimes(18);
    expect(prepareNativeCandidate).toHaveBeenCalledTimes(18);
    expect(persistBoard).not.toHaveBeenCalled();
  });

  it.skip("retires V5 locked component-source quota handling", async () => {
    const row = operation();
    row.input = {
      knowledgeSnapshotId: snapshotId,
      credentialId,
      credentialVersion: 3,
      workflowVersion: "2.5.0",
    };
    let nextId = 1;
    const search = vi.fn(async () => {
      const familyIndex = Math.floor((nextId - 1) / 4);
      const metadata = familyMetadata(familyIndex);
      return {
        results: Array.from({ length: 4 }, () => {
          const id = nextId++;
          return {
            id,
            name: `${metadata.name} ${id}`,
            description: metadata.description,
            previewUrl: `https://cdn.example.test/${id}.png`,
          };
        }),
      };
    });
    const getComponent = vi.fn(async () => ({
      contractKind: "twenty_first_get_component_v1",
      status: { found: true, locked: true },
      sourceText: "Upgrade required.",
    }));
    const handler = createTwentyFirstSiteOpsProviderHandler({
      getDb: async () => ({ fake: "db" }),
      loadContext: async () => providerContext(),
      getCredential: async () => ({
        id: credentialId,
        version: 3,
        fingerprint: "fingerprint",
        apiKey: "21st_sk_test_secret",
      }),
      client: {
        withReadOnlySession: async (_apiKey, use) =>
          use({ effectiveSearchLimit: 18, search, getComponent }),
      },
      fetchPreview: vi.fn(async ({ url }) => {
        const id = Number(new URL(url).pathname.replace(/\D/gu, ""));
        const buffer = await perceptuallyDistinctPng(id);
        return {
          finalUrl: url,
          mimeType: "image/png",
          buffer,
          width: 1200,
          height: 800,
          sha256: sha256(buffer),
        };
      }),
      persistArtifact: vi.fn(async (input) => ({
        id: randomUUID(),
        contentSha256: sha256(input.buffer),
      })) as never,
      persistBoard: vi.fn(),
    });

    await expect(
      handler({
        operation: row,
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({
      status: "attention_required",
      code: "NATIVE_SOURCE_QUOTA_UNAVAILABLE",
      result: {
        nativeFailureCategory: "provider_quota",
      },
    });
    expect(getComponent.mock.calls.length).toBeLessThanOrEqual(3);
  });

  it("uses fresh V2 supplemental references from ranks thirteen through eighteen", async () => {
    let familyIndex = 0;
    const search = vi.fn(async (input: { limit: number; query: string }) => {
      const currentFamily = familyIndex++;
      const metadata = familyMetadata(currentFamily);
      return {
        results: Array.from({ length: input.limit }, (_, resultIndex) => {
          const isPublishedTopResult = resultIndex < 9;
          const isFirstFreshResult = resultIndex === 17;
          const id = isPublishedTopResult
            ? resultIndex + 1
            : 100 + currentFamily * 20 + resultIndex;
          return {
            id,
            name:
              isPublishedTopResult || isFirstFreshResult
                ? `${metadata.name} ${id}`
                : `Responsive Hero section ${id}`,
            description:
              isPublishedTopResult || isFirstFreshResult
                ? metadata.description
                : "A polished responsive landing-page Hero section.",
            previewUrl: `https://cdn.example.test/${id}.png`,
          };
        }),
      };
    });
    const context = providerContext();
    context.project.status = "awaiting_visual_selection";
    context.publishedPageCount = 1;
    context.previousReferences = {
      providerItemKeys: Array.from(
        { length: 9 },
        (_, index) => `n:${index + 1}`,
      ),
      previewSha256s: [],
      perceptualHashes: [],
    };
    const baseline = frontMindBaselineDependencies();
    const renderCandidates = vi.fn(async ({ blueprints }) =>
      Promise.all(
        blueprints.map(async (blueprint) => ({
          heroFamily: blueprint.heroFamily,
          buffer: await perceptuallyDistinctPng(
            500 + FRONTMIND_VISUAL_FAMILIES_V3.indexOf(blueprint.heroFamily),
          ),
        })),
      ),
    );
    const handler = createTwentyFirstSiteOpsProviderHandler({
      getDb: async () => ({ fake: "db" }),
      loadContext: async () => context,
      getCredential: async () => ({
        id: credentialId,
        version: 3,
        fingerprint: "fingerprint",
        apiKey: "21st_sk_test_secret",
      }),
      client: {
        withReadOnlySession: async (_apiKey, use) => use({ search }),
      },
      fetchPreview: vi.fn(async ({ url }) => {
        const id = Number(new URL(url).pathname.replace(/\D/gu, ""));
        const buffer = await perceptuallyDistinctPng(id);
        return {
          finalUrl: url,
          mimeType: "image/png",
          buffer,
          width: 1200,
          height: 800,
          sha256: sha256(buffer),
        };
      }),
      renderCandidates,
      persistArtifact: baseline.persistArtifact as never,
      persistBoard: baseline.persistBoard,
    });

    const result = await handler({
      operation: supplementalOperation(),
      signal: new AbortController().signal,
    });
    expect(result).toMatchObject({
      status: "succeeded",
      result: {
        mode: "supplemental",
        page: 2,
        candidateCount: 9,
        diversity: { assignedFamilies: 9 },
      },
    });
    expect(search).toHaveBeenCalledTimes(9);
    expect(search.mock.calls.every(([input]) => input.limit === 18)).toBe(true);
    expect(search.mock.calls[0]![0].query).toContain(
      "kinetic radial constellation",
    );
    expect(search.mock.calls[8]![0].query).toContain(
      "edge to edge typographic declaration",
    );
    expect(baseline.persisted()).toMatchObject({
      searchPlan: { schemaVersion: 2, mode: "supplemental", page: 2 },
      selectionBundle: { searchTarget: 162 },
    });
    expect(
      baseline
        .persisted()!
        .mirroredCandidates.some((candidate) =>
          Array.from({ length: 9 }, (_, index) => `n:${index + 1}`).includes(
            candidate.providerItemKey,
          ),
        ),
    ).toBe(false);
    expect(baseline.persisted()!.selectionBundle.candidates).toHaveLength(9);
    expect(
      new Set(
        baseline
          .persisted()!
          .selectionBundle.candidates.map(
            (candidate) => candidate.providerItemKey,
          ),
      ),
    ).toEqual(
      new Set(Array.from({ length: 9 }, (_, index) => `n:${117 + index * 20}`)),
    );
    expect(
      (
        result.result as {
          diagnostics: { mirrorAttempted: number };
        }
      ).diagnostics.mirrorAttempted,
    ).toBe(9);
  });

  it("records the live advertised search limit without inflating evidence", async () => {
    let id = 0;
    const search = vi.fn(async (input: { limit: number }) => ({
      results: [
        {
          id: ++id,
          name: `Responsive Hero section ${id}`,
          description: "A polished responsive landing-page Hero section.",
          previewUrl: `https://cdn.example.test/${id}.png`,
        },
      ],
    }));
    const baseline = frontMindBaselineDependencies();
    const handler = createTwentyFirstSiteOpsProviderHandler({
      getDb: async () => ({ fake: "db" }),
      loadContext: async () => providerContext(),
      getCredential: async () => ({
        id: credentialId,
        version: 3,
        fingerprint: "fingerprint",
        apiKey: "21st_sk_test_secret",
      }),
      client: {
        withReadOnlySession: async (_apiKey, use) =>
          use({ effectiveSearchLimit: 5, search }),
      },
      fetchPreview: vi.fn(async ({ url }) => {
        const itemId = Number(new URL(url).pathname.replace(/\D/gu, ""));
        const buffer = await perceptuallyDistinctPng(itemId);
        return {
          finalUrl: url,
          mimeType: "image/png",
          buffer,
          width: 1200,
          height: 800,
          sha256: sha256(buffer),
        };
      }),
      renderCandidates: vi.fn(async ({ blueprints }) =>
        Promise.all(
          blueprints.map(async (blueprint) => ({
            heroFamily: blueprint.heroFamily,
            buffer: await perceptuallyDistinctPng(
              600 + FRONTMIND_VISUAL_FAMILIES_V3.indexOf(blueprint.heroFamily),
            ),
          })),
        ),
      ),
      persistArtifact: baseline.persistArtifact as never,
      persistBoard: baseline.persistBoard,
    });

    await expect(
      handler({
        operation: operation(),
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({
      status: "succeeded",
      result: {
        diagnostics: {
          effectiveSearchLimit: 5,
          maximumQueryLimit: 5,
          queryCalls: 9,
        },
      },
    });
    expect(search.mock.calls.every(([input]) => input.limit === 5)).toBe(true);
    expect(baseline.persisted()!.selectionBundle.searchTarget).toBe(45);
  });

  it("keeps all 27 references provider-key distinct across three pages", async () => {
    let familyIndex = 0;
    const previousProviderKeys = Array.from(
      { length: 18 },
      (_, index) => `n:${index + 1}`,
    );
    const search = vi.fn(async () => {
      const currentFamily = familyIndex++;
      const metadata = familyMetadata(currentFamily);
      return {
        results: Array.from({ length: 18 }, (_, resultIndex) => {
          const id = resultIndex < 17 ? resultIndex + 1 : 100 + currentFamily;
          return {
            id,
            name: `${metadata.name} ${id}`,
            description: metadata.description,
            previewUrl: `https://cdn.example.test/${id}.png`,
          };
        }),
      };
    });
    const context = providerContext();
    context.project.status = "awaiting_visual_selection";
    context.publishedPageCount = 2;
    context.previousReferences = {
      providerItemKeys: previousProviderKeys,
      previewSha256s: [],
      perceptualHashes: [],
    };
    const baseline = frontMindBaselineDependencies();
    const handler = createTwentyFirstSiteOpsProviderHandler({
      getDb: async () => ({ fake: "db" }),
      loadContext: async () => context,
      getCredential: async () => ({
        id: credentialId,
        version: 3,
        fingerprint: "fingerprint",
        apiKey: "21st_sk_test_secret",
      }),
      client: {
        withReadOnlySession: async (_apiKey, use) => use({ search }),
      },
      fetchPreview: vi.fn(async ({ url }) => {
        const itemId = Number(new URL(url).pathname.replace(/\D/gu, ""));
        const buffer = await perceptuallyDistinctPng(itemId);
        return {
          finalUrl: url,
          mimeType: "image/png",
          buffer,
          width: 1200,
          height: 800,
          sha256: sha256(buffer),
        };
      }),
      renderCandidates: vi.fn(async ({ blueprints }) =>
        Promise.all(
          blueprints.map(async (blueprint) => ({
            heroFamily: blueprint.heroFamily,
            buffer: await perceptuallyDistinctPng(
              650 + FRONTMIND_VISUAL_FAMILIES_V3.indexOf(blueprint.heroFamily),
            ),
          })),
        ),
      ),
      persistArtifact: baseline.persistArtifact as never,
      persistBoard: baseline.persistBoard,
    });

    await expect(
      handler({
        operation: supplementalOperation(3),
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({
      status: "succeeded",
      result: {
        page: 3,
        candidateCount: 9,
        diagnostics: { terminalReason: "complete" },
      },
    });
    const thirdPageKeys = baseline
      .persisted()!
      .mirroredCandidates.map((candidate) => candidate.providerItemKey);
    expect(new Set([...previousProviderKeys, ...thirdPageKeys]).size).toBe(27);
    expect(
      thirdPageKeys.some((key) => previousProviderKeys.includes(key)),
    ).toBe(false);
    expect(search).toHaveBeenCalledTimes(9);
    expect(search.mock.calls.every(([input]) => input.limit === 18)).toBe(true);
  });

  it("uses the separate bounded query allowlist for a third visual page", async () => {
    const search = vi.fn(async (_input: { limit: number; query: string }) => ({
      results: [],
    }));
    const context = providerContext();
    context.project.status = "awaiting_visual_selection";
    context.publishedPageCount = 2;
    const baseline = frontMindBaselineDependencies();
    const handler = createTwentyFirstSiteOpsProviderHandler({
      getDb: async () => ({ fake: "db" }),
      loadContext: async () => context,
      getCredential: async () => ({
        id: credentialId,
        version: 3,
        fingerprint: "fingerprint",
        apiKey: "21st_sk_test_secret",
      }),
      client: {
        withReadOnlySession: async (_apiKey, use) => use({ search }),
      },
      ...baseline,
    });

    await expect(
      handler({
        operation: supplementalOperation(3),
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({
      status: "attention_required",
      code: "INSUFFICIENT_DISTINCT_21ST_HERO_REFERENCES",
    });
    expect(search).toHaveBeenCalledTimes(18);
    expect(search.mock.calls.every(([input]) => input.limit === 18)).toBe(true);
    expect(search.mock.calls[0]![0].query).toContain(
      "generative particle field",
    );
    expect(search.mock.calls[9]![0].query).toContain(
      "concentric spatial illustration",
    );
    expect(baseline.persistBoard).not.toHaveBeenCalled();
  });

  it("fails a stale V2 admission before credential or provider access", async () => {
    const context = providerContext();
    context.project.revision = 5;
    context.publishedPageCount = 0;
    const getCredential = vi.fn();
    const client = { withReadOnlySession: vi.fn() };
    const handler = createTwentyFirstSiteOpsProviderHandler({
      getDb: async () => ({ fake: "db" }),
      loadContext: async () => context,
      getCredential,
      client,
    });

    await expect(
      handler({
        operation: initialV2Operation(4),
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({
      status: "failed",
      code: "VISUAL_SEARCH_SUPERSEDED",
    });
    expect(getCredential).not.toHaveBeenCalled();
    expect(client.withReadOnlySession).not.toHaveBeenCalled();
  });

  it("checks the worker lease before persisting a completed V2 board", async () => {
    let familyIndex = 0;
    const context = providerContext();
    context.publishedPageCount = 0;
    const baseline = frontMindBaselineDependencies();
    const assertLeaseActive = vi.fn(async () => {
      throw new Error("SITEOPS_OPERATION_LEASE_LOST");
    });
    const handler = createTwentyFirstSiteOpsProviderHandler({
      getDb: async () => ({ fake: "db" }),
      loadContext: async () => context,
      getCredential: async () => ({
        id: credentialId,
        version: 3,
        fingerprint: "fingerprint",
        apiKey: "21st_sk_test_secret",
      }),
      client: {
        withReadOnlySession: async (_apiKey, use) =>
          use({
            search: async () => {
              const index = familyIndex++;
              const metadata = familyMetadata(index);
              return {
                results: [
                  {
                    id: 700 + index,
                    name: `${metadata.name} ${index}`,
                    description: metadata.description,
                    previewUrl: `https://cdn.example.test/${700 + index}.png`,
                  },
                ],
              };
            },
          }),
      },
      fetchPreview: vi.fn(async ({ url }) => {
        const id = Number(new URL(url).pathname.replace(/\D/gu, ""));
        const buffer = await perceptuallyDistinctPng(id);
        return {
          finalUrl: url,
          mimeType: "image/png",
          buffer,
          width: 1200,
          height: 800,
          sha256: sha256(buffer),
        };
      }),
      renderCandidates: vi.fn(async ({ blueprints }) =>
        Promise.all(
          blueprints.map(async (blueprint) => ({
            heroFamily: blueprint.heroFamily,
            buffer: await perceptuallyDistinctPng(
              800 + FRONTMIND_VISUAL_FAMILIES_V3.indexOf(blueprint.heroFamily),
            ),
          })),
        ),
      ),
      persistArtifact: baseline.persistArtifact as never,
      persistBoard: baseline.persistBoard,
    });

    await expect(
      handler({
        operation: initialV2Operation(),
        signal: new AbortController().signal,
        assertLeaseActive,
      }),
    ).resolves.toMatchObject({
      status: "failed",
      code: "VISUAL_SEARCH_SUPERSEDED",
    });
    expect(assertLeaseActive).toHaveBeenCalledOnce();
    expect(baseline.persistBoard).not.toHaveBeenCalled();
  });

  it("admits generic Heroes only as safe fallback edges", async () => {
    let nextId = 1;
    const baseline = frontMindBaselineDependencies();
    const search = vi.fn(async () => {
      return {
        results: Array.from({ length: 4 }, () => {
          const id = nextId++;
          return {
            id,
            name: `Responsive Hero section ${id}`,
            description: "A polished responsive landing-page Hero section.",
            previewUrl: `https://cdn.example.test/${id}.png`,
          };
        }),
      };
    });
    const renderCandidates = vi.fn(async ({ blueprints }) =>
      Promise.all(
        blueprints.map(async (blueprint) => ({
          heroFamily: blueprint.heroFamily,
          buffer: await perceptuallyDistinctPng(
            300 + FRONTMIND_VISUAL_FAMILIES_V3.indexOf(blueprint.heroFamily),
          ),
        })),
      ),
    );
    const handler = createTwentyFirstSiteOpsProviderHandler({
      getDb: async () => ({ fake: "db" }),
      loadContext: async () => providerContext(),
      getCredential: async () => ({
        id: credentialId,
        version: 3,
        fingerprint: "fingerprint",
        apiKey: "21st_sk_test_secret",
      }),
      client: {
        withReadOnlySession: async (_apiKey, use) => use({ search }),
      },
      fetchPreview: vi.fn(async ({ url }) => {
        const id = Number(new URL(url).pathname.replace(/\D/gu, ""));
        const buffer = await perceptuallyDistinctPng(id);
        return {
          finalUrl: url,
          mimeType: "image/png",
          buffer,
          width: 1200,
          height: 800,
          sha256: sha256(buffer),
        };
      }),
      renderCandidates,
      persistArtifact: baseline.persistArtifact as never,
      persistBoard: baseline.persistBoard,
    });

    await expect(
      handler({
        operation: operation(),
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({
      status: "succeeded",
      result: {
        candidateCount: 9,
        actual: { searched: 36, shortlisted: 36, mirrored: 9, presented: 9 },
        diagnostics: {
          diagnosticsVersion: 2,
          generalHeroEligibleCount: 36,
          exactEligibilityEdges: 0,
          safeFallbackEdges: 324,
          queryCalls: 9,
          effectiveSearchLimit: 18,
          mirrorAttempts: 9,
          terminalReason: "complete",
        },
        diversity: { familyQueriesRun: 9, assignedFamilies: 9 },
      },
    });
    expect(search).toHaveBeenCalledTimes(9);
    expect(renderCandidates).toHaveBeenCalledOnce();
    expect(baseline.persistBoard).toHaveBeenCalledOnce();
  });

  it("queries the matched neighbour in a Hall-deficient family graph", async () => {
    let callIndex = 0;
    const baseline = frontMindBaselineDependencies();
    const search = vi.fn(async () => {
      const currentCall = callIndex++;
      const id =
        currentCall === 0 ||
        currentCall === 1 ||
        (currentCall >= 9 && currentCall < 17)
          ? 1
          : currentCall < 9
            ? currentCall
            : 99;
      return {
        results: [
          {
            id,
            name: `Responsive Hero section ${id}`,
            description: "A polished responsive landing-page Hero section.",
            previewUrl: `https://cdn.example.test/${id}.png`,
          },
        ],
      };
    });
    const handler = createTwentyFirstSiteOpsProviderHandler({
      getDb: async () => ({ fake: "db" }),
      loadContext: async () => providerContext(),
      getCredential: async () => ({
        id: credentialId,
        version: 3,
        fingerprint: "fingerprint",
        apiKey: "21st_sk_test_secret",
      }),
      client: {
        withReadOnlySession: async (_apiKey, use) => use({ search }),
      },
      fetchPreview: vi.fn(async ({ url }) => {
        const id = Number(new URL(url).pathname.replace(/\D/gu, ""));
        const buffer = await perceptuallyDistinctPng(id);
        return {
          finalUrl: url,
          mimeType: "image/png",
          buffer,
          width: 1200,
          height: 800,
          sha256: sha256(buffer),
        };
      }),
      renderCandidates: vi.fn(async ({ blueprints }) =>
        Promise.all(
          blueprints.map(async (blueprint) => ({
            heroFamily: blueprint.heroFamily,
            buffer: await perceptuallyDistinctPng(
              900 + FRONTMIND_VISUAL_FAMILIES_V3.indexOf(blueprint.heroFamily),
            ),
          })),
        ),
      ),
      persistArtifact: baseline.persistArtifact as never,
      persistBoard: baseline.persistBoard,
    });

    await expect(
      handler({
        operation: operation(),
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({
      status: "succeeded",
      result: {
        diagnostics: {
          queryCalls: 18,
          generalHeroEligibleCount: 9,
          keyMatchingCardinality: 9,
          compatibleMatchingCardinality: 9,
          terminalReason: "complete",
        },
      },
    });
    expect(search).toHaveBeenCalledTimes(18);
    expect(search.mock.calls[9]![0].query).toContain(
      "full screen landing page hero big headline minimal",
    );
    expect(search.mock.calls[10]![0].query).toContain(
      "playful abstract orbit landing page hero particles",
    );
    expect(baseline.persisted()!.selectionBundle.searchTarget).toBe(324);
    expect(baseline.persistBoard).toHaveBeenCalledOnce();
  });

  it("deletes a failed preview key, rematches, and mirrors at concurrency three", async () => {
    let callIndex = 0;
    let nextId = 1;
    let activeFetches = 0;
    let maximumActiveFetches = 0;
    let failedProviderKey: string | null = null;
    const baseline = frontMindBaselineDependencies();
    const search = vi.fn(async () => {
      const count = callIndex++ === 0 ? 2 : 1;
      return {
        results: Array.from({ length: count }, () => {
          const id = nextId++;
          return {
            id,
            name: `Responsive Hero section ${id}`,
            description: "A polished responsive landing-page Hero section.",
            previewUrl: `https://cdn.example.test/${id}.png`,
          };
        }),
      };
    });
    const fetchPreview = vi.fn(async ({ url }: { url: string }) => {
      const id = Number(new URL(url).pathname.replace(/\D/gu, ""));
      activeFetches += 1;
      maximumActiveFetches = Math.max(maximumActiveFetches, activeFetches);
      await Promise.resolve();
      if (failedProviderKey === null) {
        failedProviderKey = `n:${id}`;
        activeFetches -= 1;
        throw new Error("PREVIEW_FETCH_FAILED");
      }
      const buffer = await perceptuallyDistinctPng(id);
      activeFetches -= 1;
      return {
        finalUrl: url,
        mimeType: "image/png",
        buffer,
        width: 1200,
        height: 800,
        sha256: sha256(buffer),
      };
    });
    const handler = createTwentyFirstSiteOpsProviderHandler({
      getDb: async () => ({ fake: "db" }),
      loadContext: async () => providerContext(),
      getCredential: async () => ({
        id: credentialId,
        version: 3,
        fingerprint: "fingerprint",
        apiKey: "21st_sk_test_secret",
      }),
      client: {
        withReadOnlySession: async (_apiKey, use) => use({ search }),
      },
      fetchPreview: fetchPreview as never,
      renderCandidates: vi.fn(async ({ blueprints }) =>
        Promise.all(
          blueprints.map(async (blueprint) => ({
            heroFamily: blueprint.heroFamily,
            buffer: await perceptuallyDistinctPng(
              950 + FRONTMIND_VISUAL_FAMILIES_V3.indexOf(blueprint.heroFamily),
            ),
          })),
        ),
      ),
      persistArtifact: baseline.persistArtifact as never,
      persistBoard: baseline.persistBoard,
    });

    const result = await handler({
      operation: operation(),
      signal: new AbortController().signal,
    });
    expect(result).toMatchObject({
      status: "succeeded",
      result: {
        diagnostics: {
          mirrorAttempted: 10,
          mirrorAttempts: 10,
          mirrorSucceeded: 9,
          rejectedByReason: { http: 1 },
          terminalReason: "complete",
        },
      },
    });
    expect(search).toHaveBeenCalledTimes(9);
    expect(maximumActiveFetches).toBe(3);
    expect(fetchPreview).toHaveBeenCalledTimes(10);
    expect(
      baseline
        .persisted()!
        .mirroredCandidates.some(
          (candidate) => candidate.providerItemKey === failedProviderKey,
        ),
    ).toBe(false);
  });

  it("rescues a preview-compatible 8/9 assignment with the tenth query", async () => {
    let searchCall = 0;
    const apiKeySentinel = "21st_sk_structured-log-sentinel";
    const structuredLog = vi
      .spyOn(console, "info")
      .mockImplementation(() => undefined);
    const commonPixels = await perceptuallyDistinctPng(77);
    const baseline = frontMindBaselineDependencies();
    const search = vi.fn(async () => {
      const id = ++searchCall;
      return {
        results: [
          {
            id,
            name: `Responsive Hero section ${id}`,
            description: "A polished responsive landing-page Hero section.",
            previewUrl: `https://cdn.example.test/${id}.png`,
          },
        ],
      };
    });
    const handler = createTwentyFirstSiteOpsProviderHandler({
      getDb: async () => ({ fake: "db" }),
      loadContext: async () => providerContext(),
      getCredential: async () => ({
        id: credentialId,
        version: 3,
        fingerprint: "fingerprint",
        apiKey: apiKeySentinel,
      }),
      client: {
        withReadOnlySession: async (_apiKey, use) => use({ search }),
      },
      fetchPreview: vi.fn(async ({ url }) => {
        const id = Number(new URL(url).pathname.replace(/\D/gu, ""));
        const buffer =
          id <= 2
            ? Buffer.concat([commonPixels, Buffer.from(`:${id}`)])
            : await perceptuallyDistinctPng(id);
        return {
          finalUrl: url,
          mimeType: "image/png",
          buffer,
          width: 1200,
          height: 800,
          sha256: sha256(buffer),
        };
      }),
      renderCandidates: vi.fn(async ({ blueprints }) =>
        Promise.all(
          blueprints.map(async (blueprint) => ({
            heroFamily: blueprint.heroFamily,
            buffer: await perceptuallyDistinctPng(
              980 + FRONTMIND_VISUAL_FAMILIES_V3.indexOf(blueprint.heroFamily),
            ),
          })),
        ),
      ),
      persistArtifact: baseline.persistArtifact as never,
      persistBoard: baseline.persistBoard,
    });

    await expect(
      handler({
        operation: operation(),
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({
      status: "succeeded",
      result: {
        diagnostics: {
          queryCalls: 10,
          mirrorAttempts: 10,
          compatibleMatchingCardinality: 9,
          terminalReason: "complete",
        },
      },
    });
    expect(search).toHaveBeenCalledTimes(10);
    expect(baseline.persisted()!.selectionBundle.searchTarget).toBe(180);
    expect(baseline.persistBoard).toHaveBeenCalledOnce();
    const serializedLog = JSON.stringify(structuredLog.mock.calls);
    const events = structuredLog.mock.calls.flatMap((call) => {
      const entry = call[1];
      return entry && typeof entry === "object" && "event" in entry
        ? [String(entry.event)]
        : [];
    });
    expect(events).toEqual(
      expect.arrayContaining([
        "visual_query_capability",
        "visual_matching",
        "visual_mirror",
        "visual_page_published",
      ]),
    );
    expect(serializedLog).not.toContain(apiKeySentinel);
    expect(serializedLog).not.toContain("floating orbital geometric hero");
    expect(serializedLog).not.toContain("Responsive Hero section");
    expect(serializedLog).not.toContain("https://cdn.example.test");
    structuredLog.mockRestore();
  });

  it("reports the 36-preview I/O cap as preview admission failure, not solver exhaustion", async () => {
    let nextId = 1;
    const baseline = frontMindBaselineDependencies();
    const commonPixels = await perceptuallyDistinctPng(42);
    const search = vi.fn(async () => ({
      results: Array.from({ length: 4 }, () => {
        const id = nextId++;
        return {
          id,
          name: `Responsive Hero section ${id}`,
          description: "A polished responsive landing-page Hero section.",
          previewUrl: `https://cdn.example.test/${id}.png`,
        };
      }),
    }));
    const handler = createTwentyFirstSiteOpsProviderHandler({
      getDb: async () => ({ fake: "db" }),
      loadContext: async () => providerContext(),
      getCredential: async () => ({
        id: credentialId,
        version: 3,
        fingerprint: "fingerprint",
        apiKey: "21st_sk_test_secret",
      }),
      client: {
        withReadOnlySession: async (_apiKey, use) => use({ search }),
      },
      fetchPreview: vi.fn(async ({ url }) => {
        const id = Number(new URL(url).pathname.replace(/\D/gu, ""));
        // Trailing bytes change the exact content hash while sharp decodes the
        // same pixels, exercising the pHash constraint rather than SHA only.
        const buffer = Buffer.concat([commonPixels, Buffer.from(`:${id}`)]);
        return {
          finalUrl: url,
          mimeType: "image/png",
          buffer,
          width: 1200,
          height: 800,
          sha256: sha256(buffer),
        };
      }),
      persistArtifact: baseline.persistArtifact as never,
      persistBoard: baseline.persistBoard,
    });

    await expect(
      handler({
        operation: operation(),
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({
      status: "attention_required",
      code: "VISUAL_PREVIEW_REFERENCES_UNAVAILABLE",
      result: {
        mirrorAttempted: 36,
        mirrorAttempts: 36,
        mirrorSucceeded: 36,
        compatibleMatchingCardinality: 1,
        terminalReason: "preview_failures",
      },
    });
    expect(search).toHaveBeenCalledTimes(9);
    expect(baseline.persistBoard).not.toHaveBeenCalled();
  });

  it("rejects producer drift before database or provider access", async () => {
    const getDb = vi.fn();
    const client = { withReadOnlySession: vi.fn() };
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const handler = createTwentyFirstSiteOpsProviderHandler({ getDb, client });
    const drifted = operation();
    drifted.input = {
      ...drifted.input,
      manusCredentialId: "55555555-5555-4555-8555-555555555555",
    };

    await expect(
      handler({
        operation: drifted,
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({
      status: "failed",
      code: "VISUAL_OPERATION_CONTRACT_MISMATCH",
    });
    expect(getDb).not.toHaveBeenCalled();
    expect(client.withReadOnlySession).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(
      "[SiteOps21st] visual_search_failed",
      expect.objectContaining({
        operationId,
        projectId,
        stage: "validate_operation",
      }),
    );
    log.mockRestore();
  });

  it("classifies MCP schema drift and redacts the active credential in logs", async () => {
    const secret = "21st_sk_log-redaction-sentinel";
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const handler = createTwentyFirstSiteOpsProviderHandler({
      getDb: async () => ({ fake: "db" }),
      loadContext: async () => providerContext(),
      getCredential: async () => ({
        id: credentialId,
        version: 3,
        fingerprint: "fingerprint",
        apiKey: secret,
      }),
      client: {
        withReadOnlySession: async () => {
          const error = new TwentyFirstToolContractError();
          error.message = `${error.message}: ${secret}`;
          throw error;
        },
      },
    });

    await expect(
      handler({
        operation: operation(),
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({
      status: "attention_required",
      code: "MCP_CONTRACT_INCOMPATIBLE",
    });
    expect(JSON.stringify(log.mock.calls)).not.toContain(secret);
    expect(log).toHaveBeenCalledWith(
      "[SiteOps21st] visual_search_failed",
      expect.objectContaining({ stage: "mcp_retrieval" }),
    );
    log.mockRestore();
  });

  it("fails truthfully instead of synthesizing nine candidates for an empty catalog", async () => {
    const baseline = frontMindBaselineDependencies();
    const handler = createTwentyFirstSiteOpsProviderHandler({
      getDb: async () => ({ fake: "db" }),
      loadContext: async () => providerContext(),
      getCredential: async () => ({
        id: credentialId,
        version: 3,
        fingerprint: "fingerprint",
        apiKey: "21st_sk_test_secret",
      }),
      client: {
        withReadOnlySession: async (_apiKey, use) =>
          use({
            search: async () => ({ results: [] }),
            getComponent: async () => {
              throw new Error("must not retrieve an empty pool");
            },
          }),
      },
      ...baseline,
    });

    await expect(
      handler({
        operation: operation(),
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({
      status: "attention_required",
      code: "INSUFFICIENT_DISTINCT_21ST_HERO_REFERENCES",
      result: {
        normalizedUnique: 0,
        diversity: {
          familyQueriesRun: 18,
          eligibleReferences: 0,
          assignedFamilies: 0,
        },
      },
    });
    expect(baseline.renderCandidates).not.toHaveBeenCalled();
    expect(baseline.persistBoard).not.toHaveBeenCalled();
  });

  it("distinguishes missing preview references from an empty catalog", async () => {
    let id = 0;
    const baseline = frontMindBaselineDependencies();
    const handler = createTwentyFirstSiteOpsProviderHandler({
      getDb: async () => ({ fake: "db" }),
      loadContext: async () => providerContext(),
      getCredential: async () => ({
        id: credentialId,
        version: 3,
        fingerprint: "fingerprint",
        apiKey: "21st_sk_test_secret",
      }),
      client: {
        withReadOnlySession: async (_apiKey, use) =>
          use({
            search: async () => ({
              results: [{ id: ++id, name: `Hero Catalog item ${id}` }],
            }),
          }),
      },
      ...baseline,
    });
    await expect(
      handler({
        operation: operation(),
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({
      status: "attention_required",
      code: "INSUFFICIENT_DISTINCT_21ST_HERO_REFERENCES",
      result: {
        normalizedUnique: 18,
        withPreviewReference: 0,
        diversity: { assignedFamilies: 0 },
      },
    });
    expect(baseline.persistBoard).not.toHaveBeenCalled();
  });

  it("uses nine trusted families instead of filling the board with sections", async () => {
    let searchIndex = 0;
    const fetchPreview = vi.fn();
    const baseline = frontMindBaselineDependencies();
    const names = ["Pricing", "Sidebar", "Testimonial", "Motion Reference"];
    const handler = createTwentyFirstSiteOpsProviderHandler({
      getDb: async () => ({ fake: "db" }),
      loadContext: async () => providerContext(),
      getCredential: async () => ({
        id: credentialId,
        version: 3,
        fingerprint: "fingerprint",
        apiKey: "21st_sk_test_secret",
      }),
      client: {
        withReadOnlySession: async (_apiKey, use) =>
          use({
            search: async () => {
              const index = searchIndex++;
              return {
                results: [
                  {
                    id: index + 1,
                    name: names[index % names.length],
                    previewUrl: `https://cdn.example.test/${index + 1}.png`,
                  },
                ],
              };
            },
          }),
      },
      fetchPreview,
      ...baseline,
    });

    await expect(
      handler({
        operation: operation(),
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({
      status: "attention_required",
      code: "INSUFFICIENT_DISTINCT_21ST_HERO_REFERENCES",
      result: {
        shortlistCount: 0,
        diversity: { assignedFamilies: 0 },
      },
    });
    expect(fetchPreview).not.toHaveBeenCalled();
    expect(baseline.persistBoard).not.toHaveBeenCalled();
  });

  it("reports aggregate mirror diagnostics without leaking preview URLs", async () => {
    let id = 0;
    const baseline = frontMindBaselineDependencies();
    const handler = createTwentyFirstSiteOpsProviderHandler({
      getDb: async () => ({ fake: "db" }),
      loadContext: async () => providerContext(),
      getCredential: async () => ({
        id: credentialId,
        version: 3,
        fingerprint: "fingerprint",
        apiKey: "21st_sk_test_secret",
      }),
      client: {
        withReadOnlySession: async (_apiKey, use) =>
          use({
            search: async () => {
              const itemId = ++id;
              const metadata = familyMetadata((itemId - 1) % 9);
              return {
                results: [
                  {
                    id: itemId,
                    name: `${metadata.name} ${itemId}`,
                    description: metadata.description,
                    previewUrl: `https://cdn.example.test/${itemId}.png?token=secret`,
                  },
                ],
              };
            },
          }),
      },
      fetchPreview: vi.fn(async () => {
        throw new Error("PREVIEW_FETCH_FAILED");
      }),
      ...baseline,
    });
    const result = await handler({
      operation: operation(),
      signal: new AbortController().signal,
    });
    expect(result).toMatchObject({
      status: "attention_required",
      code: "VISUAL_PREVIEW_REFERENCES_UNAVAILABLE",
      result: {
        diagnosticsVersion: 2,
        mirrorAttempted: 9,
        mirrorAttempts: 9,
        mirrorSucceeded: 0,
        rejectedByReason: { http: 9 },
        terminalReason: "preview_failures",
        diversity: { assignedFamilies: 0 },
      },
    });
    expect(JSON.stringify(result)).not.toContain("token=secret");
  });

  it("maps an outer abort to VISUAL_SEARCH_TIMEOUT", async () => {
    const controller = new AbortController();
    controller.abort();
    const handler = createTwentyFirstSiteOpsProviderHandler({
      getDb: async () => ({ fake: "db" }),
      loadContext: async () => providerContext(),
      getCredential: async () => ({
        id: credentialId,
        version: 3,
        fingerprint: "fingerprint",
        apiKey: "21st_sk_test_secret",
      }),
      client: {
        withReadOnlySession: async (_apiKey, use) =>
          use({ search: async () => ({ results: [] }) }),
      },
    });
    await expect(
      handler({ operation: operation(), signal: controller.signal }),
    ).resolves.toMatchObject({
      status: "failed",
      code: "VISUAL_SEARCH_TIMEOUT",
    });
  });

  it("rejects private preview addresses before making an HTTP request", async () => {
    const fetchImpl = vi.fn();
    await expect(
      fetchSafeVisualPreview({
        url: "https://127.0.0.1/private.png",
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toThrow("PREVIEW_URL_PRIVATE_ADDRESS");
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(isPublicPreviewAddress("fec0::1")).toBe(false);
  });

  it("returns the Node 22 lookup array shape and disables automatic family selection", async () => {
    const selected = { address: "93.184.216.34", family: 4 as const };
    const options = pinnedPreviewRequestOptions({
      url: new URL("https://example.com/image.png?X-Amz-Signature=memory-only"),
      selected,
      signal: new AbortController().signal,
      headers: {},
    });
    expect(options).toMatchObject({
      agent: false,
      family: 4,
      autoSelectFamily: false,
      servername: "example.com",
    });
    const lookup = lookupForPinnedPreviewAddress(selected) as any;
    await expect(
      new Promise((resolve, reject) =>
        lookup(
          "example.com",
          { all: true },
          (error: Error | null, addresses: unknown) =>
            error ? reject(error) : resolve(addresses),
        ),
      ),
    ).resolves.toEqual([selected]);
    await expect(
      new Promise((resolve, reject) =>
        lookup(
          "example.com",
          { all: false },
          (error: Error | null, address: string, family: number) =>
            error ? reject(error) : resolve({ address, family }),
        ),
      ),
    ).resolves.toEqual(selected);
  });

  it.each([204, 205, 304])(
    "constructs a bodyless Response for HTTP %s without throwing",
    (status) => {
      const incoming = Object.assign(Readable.from([]), {
        statusCode: status,
        statusMessage: "No Body",
        headers: { "x-preview": "ok" },
      });
      const response = responseFromPinnedPreviewIncoming(incoming as never);
      expect(response.status).toBe(status);
      expect(response.body).toBeNull();
      expect(response.headers.get("x-preview")).toBe("ok");
    },
  );

  it("tries at most three pinned public addresses and stops after a response", async () => {
    const addresses = [
      { address: "1.1.1.1", family: 4 as const },
      { address: "8.8.8.8", family: 4 as const },
      { address: "9.9.9.9", family: 4 as const },
      { address: "208.67.222.222", family: 4 as const },
    ];
    const requestImpl = vi.fn(
      async ({ selected }: { selected: (typeof addresses)[number] }) => {
        if (selected.address !== "9.9.9.9") {
          const error = Object.assign(new Error("connect failed"), {
            code: "ECONNREFUSED",
          });
          throw error;
        }
        return new Response("ok", { status: 200 });
      },
    );
    await expect(
      pinnedHttpsFetch(
        {
          url: new URL("https://example.com/image.png"),
          addresses,
          signal: new AbortController().signal,
          headers: {},
        },
        requestImpl as never,
      ),
    ).resolves.toMatchObject({ status: 200 });
    expect(
      requestImpl.mock.calls.map(([input]) => input.selected.address),
    ).toEqual(["1.1.1.1", "8.8.8.8", "9.9.9.9"]);
  });

  it("treats an exact peer mismatch as terminal and normalizes mapped IPv4", async () => {
    expect(samePreviewAddress("93.184.216.34", "::ffff:5db8:d822")).toBe(true);
    const requestImpl = vi.fn(async () => {
      throw new Error("PREVIEW_CONNECTED_ADDRESS_UNSAFE");
    });
    await expect(
      pinnedHttpsFetch(
        {
          url: new URL("https://example.com/image.png"),
          addresses: [
            { address: "1.1.1.1", family: 4 },
            { address: "8.8.8.8", family: 4 },
          ],
          signal: new AbortController().signal,
          headers: {},
        },
        requestImpl as never,
      ),
    ).rejects.toThrow("PREVIEW_CONNECTED_ADDRESS_UNSAFE");
    expect(requestImpl).toHaveBeenCalledTimes(1);
  });

  it("normalizes provider images to metadata-free PNG before hashing", async () => {
    const upstream = await sharp({
      create: {
        width: 120,
        height: 60,
        channels: 3,
        background: { r: 24, g: 48, b: 96 },
      },
    })
      .withMetadata({ comment: "provider-private-metadata" })
      .png()
      .toBuffer();
    const result = await fetchSafeVisualPreview({
      url: "https://preview.example.com/example.png",
      resolveImpl: vi
        .fn()
        .mockResolvedValue([{ address: "93.184.216.34", family: 4 }]) as never,
      fetchImpl: vi.fn().mockResolvedValue(
        new Response(upstream, {
          status: 200,
          headers: { "content-type": "image/png" },
        }),
      ) as unknown as typeof fetch,
    });

    expect(result.mimeType).toBe("image/png");
    expect((await sharp(result.buffer).metadata()).format).toBe("png");
    expect(result.buffer.toString("utf8")).not.toContain(
      "provider-private-metadata",
    );
    expect(result.sha256).toBe(sha256(result.buffer));
    expect(result.visualSignals.dominantHex).toMatch(/^#[a-f0-9]{6}$/u);
    expect(result.visualSignals.brightness).toBeLessThan(96);
  });

  it("accepts a bounded large source image when its normalized asset is below 5 MiB", async () => {
    const smallPng = await sharp({
      create: {
        width: 3840,
        height: 2880,
        channels: 3,
        background: { r: 248, g: 248, b: 248 },
      },
    })
      .png()
      .toBuffer();
    const upstream = Buffer.concat([
      smallPng,
      Buffer.alloc(6 * 1024 * 1024, 0x20),
    ]);
    expect(upstream.byteLength).toBeGreaterThan(5 * 1024 * 1024);
    expect(upstream.byteLength).toBeLessThan(12 * 1024 * 1024);

    const result = await fetchSafeVisualPreview({
      url: "https://preview.example.com/large-source.png",
      resolveImpl: vi
        .fn()
        .mockResolvedValue([{ address: "93.184.216.34", family: 4 }]) as never,
      fetchImpl: vi.fn().mockResolvedValue(
        new Response(upstream, {
          status: 200,
          headers: { "content-type": "image/png" },
        }),
      ) as unknown as typeof fetch,
    });

    expect(result.width).toBe(2400);
    expect(result.height).toBe(1800);
    expect(result.buffer.byteLength).toBeLessThan(5 * 1024 * 1024);
  });

  it("rejects source images above 12 MiB before decoding", async () => {
    const upstream = Buffer.alloc(12 * 1024 * 1024 + 1, 0x20);
    await expect(
      fetchSafeVisualPreview({
        url: "https://preview.example.com/oversized-source.png",
        resolveImpl: vi
          .fn()
          .mockResolvedValue([
            { address: "93.184.216.34", family: 4 },
          ]) as never,
        fetchImpl: vi.fn().mockResolvedValue(
          new Response(upstream, {
            status: 200,
            headers: { "content-type": "image/png" },
          }),
        ) as unknown as typeof fetch,
      }),
    ).rejects.toThrow("PREVIEW_TOO_LARGE");
  });

  it("rejects a normalized preview above 5 MiB", async () => {
    const noisyPixels = randomBytes(1600 * 1600 * 3);
    const upstream = await sharp(noisyPixels, {
      raw: { width: 1600, height: 1600, channels: 3 },
    })
      .png({ compressionLevel: 0 })
      .toBuffer();
    expect(upstream.byteLength).toBeGreaterThan(5 * 1024 * 1024);
    expect(upstream.byteLength).toBeLessThan(12 * 1024 * 1024);

    await expect(
      fetchSafeVisualPreview({
        url: "https://preview.example.com/noisy.png",
        resolveImpl: vi
          .fn()
          .mockResolvedValue([
            { address: "93.184.216.34", family: 4 },
          ]) as never,
        fetchImpl: vi.fn().mockResolvedValue(
          new Response(upstream, {
            status: 200,
            headers: { "content-type": "image/png" },
          }),
        ) as unknown as typeof fetch,
      }),
    ).rejects.toThrow("PREVIEW_TOO_LARGE");
  });

  it("rejects embedded private IPv4 across IPv6 transition formats", () => {
    expect(isPublicPreviewAddress("::ffff:7f00:1")).toBe(false);
    expect(isPublicPreviewAddress("::ffff:a9fe:a9fe")).toBe(false);
    expect(isPublicPreviewAddress("::ffff:0a00:0001")).toBe(false);
    expect(isPublicPreviewAddress("64:ff9b::7f00:1")).toBe(false);
    expect(isPublicPreviewAddress("::ffff:5db8:d822")).toBe(true);
    expect(isPublicPreviewAddress("93.184.216.34")).toBe(true);
    expect(isPublicPreviewAddress("2001:4860:4860::8888")).toBe(true);
  });

  it("re-resolves every pinned redirect and rejects a private next hop", async () => {
    const resolveImpl = vi
      .fn()
      .mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    const transport = vi.fn().mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: { location: "https://127.0.0.1/internal" },
      }),
    );

    await expect(
      fetchPinnedPublicHttps({
        url: "https://example.com/start",
        signal: new AbortController().signal,
        maxRedirects: 2,
        resolveImpl: resolveImpl as never,
        transport,
      }),
    ).rejects.toThrow("PREVIEW_URL_PRIVATE_ADDRESS");
    expect(resolveImpl).toHaveBeenCalledTimes(1);
    expect(transport).toHaveBeenCalledTimes(1);
    expect(transport.mock.calls[0]?.[0]).toMatchObject({
      addresses: [{ address: "93.184.216.34", family: 4 }],
    });
  });

  it("keeps an ESA-style pinned redirect on the exact allowed origin", async () => {
    const resolveImpl = vi
      .fn()
      .mockResolvedValue([{ address: "2606:4700:4700::1111", family: 6 }]);
    const transport = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { location: "/final?signature=redirect-secret" },
        }),
      )
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));

    const result = await fetchPinnedPublicHttps({
      url: "https://example.com/start",
      allowedOrigin: "https://example.com",
      signal: new AbortController().signal,
      maxRedirects: 2,
      resolveImpl: resolveImpl as never,
      transport,
    });

    expect(result.finalUrl.toString()).toBe("https://example.com/final");
    expect(transport).toHaveBeenCalledTimes(2);
    expect(transport.mock.calls.map(([call]) => call.url.toString())).toEqual([
      "https://example.com/start",
      "https://example.com/final?signature=redirect-secret",
    ]);
  });
});
