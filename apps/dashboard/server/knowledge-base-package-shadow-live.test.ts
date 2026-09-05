import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import JSZip from "jszip";
import { afterEach, describe, expect, it } from "vitest";

import { runKnowledgePackageLiveShadow } from "./knowledge-base-package-shadow-live";

const BUILD_ID = "33333333-3333-4333-8333-333333333333";
const ROOT = "company_knowledge_base";
let temporaryRoot: string | undefined;

afterEach(async () => {
  if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true });
  temporaryRoot = undefined;
  delete process.env.FRONTMIND_DASHBOARD_ASSET_DIR;
});

async function fixture() {
  const kinds = ["leaf", "overview", "evidence", "report", "index"] as const;
  const documents = kinds.map((kind, order) => ({
    id: `${kind}-1`,
    path: `documents/${kind}.md`,
    kind,
    title: `${kind} title`,
    branchId: "branch-1",
    order,
    sourceIds: [`source-${kind}`],
    assetIds: [],
    evidenceDocumentIds: [],
    customerVisible: kind !== "evidence",
  }));
  const bodyById = new Map(
    documents.map((document) => [
      document.id,
      `# ${document.title}\n\n${document.kind} body`,
    ]),
  );
  const zip = new JSZip();
  for (const document of documents) {
    zip.file(`${ROOT}/${document.path}`, bodyById.get(document.id)!);
  }
  zip.file(
    `${ROOT}/00_package_manifest.json`,
    JSON.stringify({
      schemaVersion: 4,
      profile: "dashboard-enterprise-v1",
      documents,
      assets: [],
      counts: {
        totalFiles: documents.length + 1,
        customerVisibleCharacters: 100,
        evidenceCharacters: 10,
        packagedImages: 0,
      },
    }),
  );
  const archiveBytes = await zip.generateAsync({ type: "nodebuffer" });
  const validatedArchive = {
    validationProfile: "dashboard-enterprise-v1" as const,
    packageSchemaVersion: 4 as const,
    documents: documents.map((document) => ({
      ...document,
      path: `${ROOT}/${document.path}`,
      content: bodyById.get(document.id)!,
    })),
    assets: [],
  };
  const supplementText = documents
    .filter((document) => document.kind !== "leaf")
    .map((document) =>
      JSON.stringify({
        kind: document.kind,
        id: document.id,
        title: document.title,
        branchId: document.branchId,
        order: document.order,
        sourceIds: document.sourceIds,
        assetIds: document.assetIds,
        bodyMarkdown: bodyById.get(document.id),
      }),
    )
    .join("\n");
  return {
    archiveBytes,
    validatedArchive,
    supplementText,
    leafBody: bodyById.get("leaf-1")!,
  };
}

async function runFixture(input: {
  supplementText?: string;
  environment?: NodeJS.ProcessEnv;
  report?: Parameters<typeof runKnowledgePackageLiveShadow>[0]["report"];
}) {
  const value = await fixture();
  return runKnowledgePackageLiveShadow({
    buildId: BUILD_ID,
    generation: 7,
    archiveBytes: value.archiveBytes,
    validatedArchive: value.validatedArchive,
    serverLeafMarkdownById: new Map([["leaf-1", value.leafBody]]),
    readDashboardAssetBytes: async () => {
      throw new Error("fixture contains no assets");
    },
    validateArchive: async () => value.validatedArchive,
    supplementText: input.supplementText,
    environment: input.environment,
    report: input.report,
  });
}

describe("live non-authoritative package shadow", () => {
  it("is default-on, compares Shadow A and records a safe missing-supplement reason", async () => {
    temporaryRoot = await mkdtemp(
      path.join(tmpdir(), "frontmind-live-shadow-"),
    );
    process.env.FRONTMIND_DASHBOARD_ASSET_DIR = temporaryRoot;
    const observations: Array<{ ruleCode: string; sampleId: string }> = [];
    const result = await runFixture({
      environment: {},
      report: (observation) => observations.push(observation),
    });
    expect(result).toMatchObject({
      status: "shadow_a_equivalent",
      shadowB: "supplement_missing",
    });
    expect(observations.map((value) => value.ruleCode)).toEqual([
      "package_projection_built",
      "package_shadow_a_equivalent",
      "package_shadow_b_supplement_missing",
    ]);
    expect(new Set(observations.map((value) => value.sampleId)).size).toBe(1);
  });

  it("compares Shadow B only when a complete supplement is actually present", async () => {
    temporaryRoot = await mkdtemp(
      path.join(tmpdir(), "frontmind-live-shadow-"),
    );
    process.env.FRONTMIND_DASHBOARD_ASSET_DIR = temporaryRoot;
    const value = await fixture();
    const observations: string[] = [];
    const result = await runFixture({
      supplementText: value.supplementText,
      report: (observation) => observations.push(observation.ruleCode),
    });
    expect(result.status).toBe("shadow_b_equivalent");
    expect(observations).toContain("package_shadow_b_equivalent");
    expect(observations).not.toContain("package_shadow_b_supplement_missing");
  });

  it("supports an emergency kill switch without becoming a release gate", async () => {
    const observations: string[] = [];
    await expect(
      runFixture({
        environment: { FRONTMIND_KB_PACKAGE_SHADOW: "disabled" },
        report: (observation) => observations.push(observation.ruleCode),
      }),
    ).resolves.toEqual({ status: "disabled" });
    expect(observations).toEqual([]);
  });

  it("contains projection and reporter failures instead of rejecting FINAL.zip", async () => {
    const observations: string[] = [];
    await expect(
      runKnowledgePackageLiveShadow({
        buildId: BUILD_ID,
        generation: 1,
        archiveBytes: Buffer.from("not-a-zip"),
        validatedArchive: {
          validationProfile: "dashboard-enterprise-v1",
          packageSchemaVersion: 4,
          documents: [],
          assets: [],
        },
        serverLeafMarkdownById: new Map(),
        readDashboardAssetBytes: async () => Buffer.alloc(0),
        validateArchive: async () => {
          throw new Error("must not reach validator");
        },
        environment: {},
        report: (observation) => {
          observations.push(observation.ruleCode);
          throw new Error("telemetry unavailable");
        },
      }),
    ).resolves.toMatchObject({ status: "failed", phase: "projection" });
    expect(observations).toEqual(["package_projection_failed"]);
  });
});
