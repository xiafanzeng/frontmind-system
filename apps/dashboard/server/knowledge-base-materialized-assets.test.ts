import { createHash } from "node:crypto";

import JSZip from "jszip";
import sharp from "sharp";
import { describe, expect, it } from "vitest";

import type {
  KnowledgeBaseBuild,
  KnowledgeBaseBuildNode,
} from "../drizzle/schema";
import {
  buildDashboardOwnedKnowledgePackage,
  readDashboardOwnedKnowledgePackage,
} from "./knowledge-base-local-package";
import {
  projectKnowledgeBaseWorkingSetLeafResources,
  resolveKnowledgeBaseWorkingSetResourceByOpaqueHandle,
  resolveKnowledgeBaseWorkingSetResource,
} from "./knowledge-base-materialized-assets";
import {
  validateKnowledgeBaseNodePatchArchive,
  validateKnowledgeBaseWorkingSetArchive,
} from "./knowledge-base-materialized-contract";
import { composeKnowledgeBaseWorkingSetRevision } from "./knowledge-base-materialized-service";
import { knowledgeBaseMarkdownSha256 } from "./knowledge-base-package-validation";

const fixedDate = new Date("2000-01-01T00:00:00.000Z");
const buildId = "11111111-1111-4111-8111-111111111111";
const skillHash = "a".repeat(64);

function sha256(value: Buffer | string) {
  return createHash("sha256").update(value).digest("hex");
}

async function image(red: number) {
  return sharp({
    create: {
      width: 2,
      height: 2,
      channels: 4,
      background: { r: red, g: 20, b: 30, alpha: 1 },
    },
  })
    .png()
    .toBuffer();
}

async function initialWorkingSet() {
  const zip = new JSZip();
  const productImage = await image(100);
  const evidence = Buffer.from("已核验的产品图来源与产品事实。\n", "utf8");
  zip.file("assets/product.png", productImage, {
    date: fixedDate,
    createFolders: false,
  });
  zip.file("evidence/1.1/product.md", evidence, {
    date: fixedDate,
    createFolders: false,
  });
  const leaves = Array.from({ length: 30 }, (_, index) => {
    const leafId = `1.${index + 1}`;
    const contentPath = `nodes/${String(index + 1).padStart(4, "0")}.md`;
    const content = `## ${leafId} 节点 ${index + 1}\n\n完整正文 ${index + 1}`;
    zip.file(contentPath, content, { date: fixedDate, createFolders: false });
    return {
      leafId,
      branchId: "identity",
      branchTitle: "企业身份",
      title: `节点 ${index + 1}`,
      ordinal: index,
      contentPath,
      contentSha256: sha256(content),
      evidencePaths: index === 0 ? ["evidence/1.1/product.md"] : [],
      assetIds: index === 0 ? ["product-main"] : [],
    };
  });
  const manifest = {
    kind: "frontmind.kb-working-set",
    schemaVersion: 1,
    operationId: "initial-operation",
    buildId,
    generation: 1,
    contentVersion: 1,
    skill: {
      name: "socratic-kb-builder",
      version: "5",
      contentHash: skillHash,
    },
    treePolicyVersion: 2,
    company: { name: "示例企业", website: null },
    researchCoverage: {},
    branches: [{ branchId: "identity", title: "企业身份", ordinal: 0 }],
    evidenceLedger: [
      {
        path: "evidence/1.1/product.md",
        sha256: sha256(evidence),
        leafId: "1.1",
        sourceUrl: "https://example.com/product",
        retrievedAt: "2026-08-14T00:00:00Z",
      },
    ],
    leaves,
    assets: [
      {
        assetId: "product-main",
        path: "assets/product.png",
        sha256: sha256(productImage),
        mimeType: "image/png",
        bytes: productImage.length,
        width: 2,
        height: 2,
        provenance: { kind: "official-document", page: 3 },
        documentIds: ["1.1"],
      },
    ],
    logo: { status: "missing", assetId: null },
    counts: { leaves: 30, evidenceFiles: 1, assets: 1 },
  };
  zip.file("BUNDLE.json", JSON.stringify(manifest), {
    date: fixedDate,
    createFolders: false,
  });
  const bytes = await zip.generateAsync({
    type: "nodebuffer",
    platform: "UNIX",
  });
  return validateKnowledgeBaseWorkingSetArchive(bytes, {
    operationId: "initial-operation",
    buildId,
    generation: 1,
    contentVersion: 1,
    skillContentHash: skillHash,
    companyName: "示例企业",
  });
}

async function revisedWorkingSet(
  base: Awaited<ReturnType<typeof initialWorkingSet>>,
  options: {
    invalidContent?: boolean;
    sameContent?: boolean;
    invalidEvidence?: boolean;
    invalidAsset?: boolean;
    includeValidSibling?: boolean;
    omitEvidenceAdd?: boolean;
    omitAssetAdd?: boolean;
    evidenceRemove?: string[];
    assetRemove?: string[];
  } = {},
) {
  const zip = new JSZip();
  const replacementImage = await image(200);
  const replacementEvidence = Buffer.from(
    "修订后重新核验的产品证据。\n",
    "utf8",
  );
  const siblingImage = await image(220);
  const siblingEvidence = Buffer.from("仍然有效的同级补充证据。\n", "utf8");
  const content = options.sameContent
    ? base.files.get(base.manifest.leaves[0]!.contentPath)!.toString("utf8")
    : "## 1.1 节点 1\n\n修订后的完整正文";
  zip.file("patch/1.1.md", content, { date: fixedDate, createFolders: false });
  if (!options.omitEvidenceAdd) {
    zip.file("evidence/1.1/revised.md", replacementEvidence, {
      date: fixedDate,
      createFolders: false,
    });
  }
  if (!options.omitAssetAdd) {
    zip.file("assets/product-revised.png", replacementImage, {
      date: fixedDate,
      createFolders: false,
    });
  }
  if (options.includeValidSibling) {
    zip.file("evidence/1.1/sibling.md", siblingEvidence, {
      date: fixedDate,
      createFolders: false,
    });
    zip.file("assets/product-sibling.png", siblingImage, {
      date: fixedDate,
      createFolders: false,
    });
  }
  const manifest = {
    kind: "frontmind.kb-node-patch",
    schemaVersion: 1,
    operationId: "revision-operation",
    buildId,
    generation: 1,
    baseContentVersion: 1,
    baseWorkingSetSha256: base.packageSha256,
    targetLeafId: "1.1",
    contentPath: "patch/1.1.md",
    contentSha256: options.invalidContent ? "0".repeat(64) : sha256(content),
    evidence: {
      add: [
        ...(options.omitEvidenceAdd
          ? []
          : [
              {
                path: "evidence/1.1/revised.md",
                sha256: options.invalidEvidence
                  ? "0".repeat(64)
                  : sha256(replacementEvidence),
              },
            ]),
        ...(options.includeValidSibling
          ? [
              {
                path: "evidence/1.1/sibling.md",
                sha256: sha256(siblingEvidence),
              },
            ]
          : []),
      ],
      remove: options.evidenceRemove ?? ["evidence/1.1/product.md"],
    },
    assets: {
      add: [
        ...(options.omitAssetAdd
          ? []
          : [
              {
                assetId: "product-revised",
                path: "assets/product-revised.png",
                sha256: options.invalidAsset
                  ? "0".repeat(64)
                  : sha256(replacementImage),
                mimeType: "image/png",
                bytes: replacementImage.length,
                width: 2,
                height: 2,
                provenance: { kind: "user-revision" },
                documentIds: ["1.1"],
              },
            ]),
        ...(options.includeValidSibling
          ? [
              {
                assetId: "product-sibling",
                path: "assets/product-sibling.png",
                sha256: sha256(siblingImage),
                mimeType: "image/png",
                bytes: siblingImage.length,
                width: 2,
                height: 2,
                provenance: { kind: "user-revision" },
                documentIds: ["1.1"],
              },
            ]
          : []),
      ],
      remove: options.assetRemove ?? ["product-main"],
    },
  };
  zip.file("PATCH.json", JSON.stringify(manifest), {
    date: fixedDate,
    createFolders: false,
  });
  const patch = await validateKnowledgeBaseNodePatchArchive(
    await zip.generateAsync({ type: "nodebuffer", platform: "UNIX" }),
    {
      operationId: "revision-operation",
      buildId,
      generation: 1,
      baseContentVersion: 1,
      baseWorkingSetSha256: base.packageSha256,
      targetLeafId: "1.1",
    },
  );
  return {
    ...(await composeKnowledgeBaseWorkingSetRevision({ base, patch })),
    patch,
  };
}

function confirmedNodes(
  workingSet: Awaited<ReturnType<typeof initialWorkingSet>>,
) {
  return workingSet.manifest.leaves.map((leaf) => {
    const content = workingSet.files.get(leaf.contentPath)!.toString("utf8");
    const projected = projectKnowledgeBaseWorkingSetLeafResources({
      buildId,
      leafId: leaf.leafId,
      workingSet,
    });
    return {
      leafId: leaf.leafId,
      title: leaf.title,
      branchId: leaf.branchId,
      branchTitle: leaf.branchTitle,
      ordinal: leaf.ordinal,
      status: "confirmed",
      contentMarkdown: content,
      contentSha256: knowledgeBaseMarkdownSha256(content),
      sourceUrls: workingSet.manifest.evidenceLedger
        .filter((entry) => entry.leafId === leaf.leafId && entry.sourceUrl)
        .map((entry) => entry.sourceUrl!),
      imageUrls: projected
        .filter((resource) => resource.kind === "working_set_asset")
        .map((resource) => resource.sameOriginUrl),
      assetRefs: leaf.assetIds,
    } as KnowledgeBaseBuildNode;
  });
}

describe("materialized Working Set assets", () => {
  it("applies valid PATCH components independently and preserves invalid replacements", async () => {
    const initial = await initialWorkingSet();
    const validContentWithBadAsset = await revisedWorkingSet(initial, {
      invalidEvidence: true,
      invalidAsset: true,
    });
    expect(validContentWithBadAsset.patch.components).toEqual({
      content: "valid",
      evidence: "invalid",
      assets: "invalid",
    });
    expect(
      validContentWithBadAsset.validated.files
        .get(initial.manifest.leaves[0]!.contentPath)!
        .toString("utf8"),
    ).toContain("修订后的完整正文");
    expect(
      validContentWithBadAsset.validated.manifest.leaves[0]!.assetIds,
    ).toEqual(["product-main"]);
    expect(validContentWithBadAsset.validated.manifest.assets[0]!.assetId).toBe(
      "product-main",
    );
    expect(
      validContentWithBadAsset.validated.manifest.leaves[0]!.evidencePaths,
    ).toEqual(["evidence/1.1/product.md"]);

    const badContentWithValidResources = await revisedWorkingSet(initial, {
      invalidContent: true,
    });
    expect(badContentWithValidResources.patch.components).toEqual({
      content: "invalid",
      evidence: "valid",
      assets: "valid",
    });
    expect(
      badContentWithValidResources.validated.files
        .get(initial.manifest.leaves[0]!.contentPath)!
        .equals(initial.files.get(initial.manifest.leaves[0]!.contentPath)!),
    ).toBe(true);
    expect(
      badContentWithValidResources.validated.manifest.leaves[0]!.assetIds,
    ).toEqual(["product-revised"]);

    const allInvalid = await revisedWorkingSet(initial, {
      invalidContent: true,
      invalidEvidence: true,
      invalidAsset: true,
    });
    expect(allInvalid.patch.components).toEqual({
      content: "invalid",
      evidence: "invalid",
      assets: "invalid",
    });
    expect(allInvalid.changed).toBe(false);
    expect(allInvalid.validated.packageSha256).toBe(initial.packageSha256);
    expect(allInvalid.validated.manifest.contentVersion).toBe(1);
  });

  it("hard-rejects removal that is not currently and exclusively bound to the target leaf", async () => {
    const initial = await initialWorkingSet();

    await expect(
      revisedWorkingSet(initial, {
        evidenceRemove: ["evidence/2.1/foreign.md"],
      }),
    ).rejects.toMatchObject({ code: "PATCH_CONFLICT" });
    await expect(
      revisedWorkingSet(initial, {
        assetRemove: ["foreign-leaf-asset"],
      }),
    ).rejects.toMatchObject({ code: "PATCH_CONFLICT" });
  });

  it("composes valid siblings while preserving the last good resources when another replacement is dropped", async () => {
    const initial = await initialWorkingSet();
    const partial = await revisedWorkingSet(initial, {
      invalidContent: true,
      invalidEvidence: true,
      invalidAsset: true,
      includeValidSibling: true,
    });

    expect(partial.patch.components).toEqual({
      content: "invalid",
      evidence: "invalid",
      assets: "invalid",
    });
    expect(partial.changed).toBe(true);
    expect(partial.validated.manifest.contentVersion).toBe(2);
    expect(partial.validated.manifest.leaves[0]!.evidencePaths).toEqual([
      "evidence/1.1/product.md",
      "evidence/1.1/sibling.md",
    ]);
    expect(partial.validated.manifest.leaves[0]!.assetIds).toEqual([
      "product-main",
      "product-sibling",
    ]);
    expect(
      partial.validated.files
        .get(initial.manifest.leaves[0]!.contentPath)!
        .equals(initial.files.get(initial.manifest.leaves[0]!.contentPath)!),
    ).toBe(true);
  });

  it("treats ownership-validated evidence-only and asset-only removals as effective change", async () => {
    const initial = await initialWorkingSet();
    const removed = await revisedWorkingSet(initial, {
      invalidContent: true,
      omitEvidenceAdd: true,
      omitAssetAdd: true,
    });

    expect(removed.patch.components).toEqual({
      content: "invalid",
      evidence: "valid",
      assets: "valid",
    });
    expect(removed.changed).toBe(true);
    expect(removed.validated.manifest.contentVersion).toBe(2);
    expect(removed.validated.manifest.leaves[0]!.evidencePaths).toEqual([]);
    expect(removed.validated.manifest.leaves[0]!.assetIds).toEqual([]);
  });

  it("creates a new content version for an unchanged body plus a safe new image", async () => {
    const initial = await initialWorkingSet();
    const withImage = await revisedWorkingSet(initial, {
      sameContent: true,
      omitEvidenceAdd: true,
      evidenceRemove: [],
      assetRemove: [],
    });

    expect(withImage.changed).toBe(true);
    expect(withImage.validated.manifest.contentVersion).toBe(2);
    expect(withImage.validated.manifest.leaves[0]!.assetIds).toEqual([
      "product-main",
      "product-revised",
    ]);
    expect(
      withImage.validated.files
        .get(initial.manifest.leaves[0]!.contentPath)!
        .equals(initial.files.get(initial.manifest.leaves[0]!.contentPath)!),
    ).toBe(true);
  });

  it("projects only manifest-bound initial and revised local resources", async () => {
    const initial = await initialWorkingSet();
    const initialResources = projectKnowledgeBaseWorkingSetLeafResources({
      buildId,
      leafId: "1.1",
      workingSet: initial,
    });
    expect(initialResources.map((resource) => resource.kind)).toEqual([
      "working_set_asset",
    ]);
    expect(
      initialResources.every((resource) =>
        /^\/api\/knowledge-base\/artifacts\/resources\/[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}$/u.test(
          resource.sameOriginUrl,
        ),
      ),
    ).toBe(true);
    expect(Object.keys(initialResources[0]!).sort()).toEqual([
      "caption",
      "id",
      "kind",
      "mimeType",
      "sameOriginUrl",
      "sizeBytes",
    ]);
    expect(initialResources[0]).toMatchObject({
      kind: "working_set_asset",
      caption: "知识库配图",
      mimeType: "image/png",
    });
    const publicJson = JSON.stringify(initialResources);
    expect(publicJson).not.toContain(buildId);
    expect(publicJson).not.toContain("product-main");
    expect(publicJson).not.toContain("assets/product.png");
    expect(publicJson).not.toContain(initial.manifest.assets[0]!.sha256);
    const opaqueAsset = resolveKnowledgeBaseWorkingSetResourceByOpaqueHandle({
      suppliedHandle: initialResources[0]!.sameOriginUrl.split("/").at(-1)!,
      buildId,
      workingSet: initial,
    });
    expect(opaqueAsset).not.toBeNull();
    expect(sha256(opaqueAsset!.bytes)).toBe(initial.manifest.assets[0]!.sha256);
    const initialAsset = resolveKnowledgeBaseWorkingSetResource({
      buildId,
      workingSet: initial,
      kind: "asset",
      assetId: "product-main",
      expectedSha256: initial.manifest.assets[0]!.sha256,
    });
    expect(sha256(initialAsset.bytes)).toBe(initial.manifest.assets[0]!.sha256);
    const evidenceEntry = initial.manifest.evidenceLedger[0]!;
    expect(initialResources).toHaveLength(1);
    const initialEvidence = resolveKnowledgeBaseWorkingSetResource({
      buildId,
      workingSet: initial,
      kind: "evidence",
      leafId: "1.1",
      pathSha256: sha256(evidenceEntry.path),
      expectedSha256: evidenceEntry.sha256,
    });
    expect(sha256(initialEvidence.bytes)).toBe(evidenceEntry.sha256);

    const revised = await revisedWorkingSet(initial);
    expect(revised.validated.manifest.leaves.slice(1)).toEqual(
      initial.manifest.leaves.slice(1),
    );
    const revisedResources = projectKnowledgeBaseWorkingSetLeafResources({
      buildId,
      leafId: "1.1",
      workingSet: revised.validated,
    });
    expect(revisedResources).toHaveLength(1);
    expect(revisedResources[0]).toMatchObject({
      kind: "working_set_asset",
      caption: "知识库配图",
      mimeType: "image/png",
    });
    expect(JSON.stringify(revisedResources)).not.toContain(
      "product-revised.png",
    );
    expect(JSON.stringify(revisedResources)).not.toContain("product-main");
    expect(() =>
      resolveKnowledgeBaseWorkingSetResource({
        buildId,
        workingSet: revised.validated,
        kind: "asset",
        assetId: "product-main",
        expectedSha256: initial.manifest.assets[0]!.sha256,
      }),
    ).toThrow("not registered");
  });

  it("copies every registered evidence and asset byte into the deterministic final ZIP", async () => {
    const initial = await initialWorkingSet();
    const revised = (await revisedWorkingSet(initial)).validated;
    const nodes = confirmedNodes(revised);
    const build = {
      id: buildId,
      generation: 1,
      revision: 1,
      companyName: "示例企业",
      logoStorageKey: null,
    } as KnowledgeBaseBuild;
    const first = await buildDashboardOwnedKnowledgePackage({
      build,
      nodes,
      materializedWorkingSet: revised,
    });
    const second = await buildDashboardOwnedKnowledgePackage({
      build,
      nodes,
      materializedWorkingSet: revised,
    });
    expect(first.buffer.equals(second.buffer)).toBe(true);
    expect(first.sha256).toBe(second.sha256);
    expect(first.manifest.evidence).toHaveLength(1);
    expect(first.manifest.documents[0]?.imageUrls).toEqual([]);
    expect(first.manifest.documents[0]?.sourceUrls).toEqual([]);
    expect(first.manifest.assets).toEqual([
      expect.objectContaining({
        kind: "working_set_asset",
        id: "product-revised",
        sha256: revised.manifest.assets[0]!.sha256,
        provenance: { kind: "user-revision" },
      }),
    ]);

    const parsed = await readDashboardOwnedKnowledgePackage({
      buffer: first.buffer,
      expected: {
        buildId,
        generation: 1,
        revision: 1,
        companyName: "示例企业",
      },
      nodes,
    });
    expect(parsed.documents[0]?.evidenceDocumentIds).toEqual([
      "working-set/evidence/1.1/revised.md",
    ]);
    expect(parsed.documents[0]?.assetIds).toEqual(["product-revised"]);
    expect(parsed.assets[0]).toEqual(
      expect.objectContaining({
        id: "product-revised",
        sha256: revised.manifest.assets[0]!.sha256,
        documentIds: ["1.1"],
      }),
    );

    const zip = await JSZip.loadAsync(first.buffer, { checkCRC32: true });
    const sourceIndex = await zip
      .file("frontmind_knowledge_base/00_source_index.md")!
      .async("string");
    const finalManifest = await zip
      .file("frontmind_knowledge_base/00_package_manifest.json")!
      .async("string");
    expect(`${sourceIndex}\n${finalManifest}`).not.toContain(
      "/api/knowledge-base/",
    );
    const evidenceBytes = await zip
      .file("frontmind_knowledge_base/working-set/evidence/1.1/revised.md")!
      .async("nodebuffer");
    const assetBytes = await zip
      .file("frontmind_knowledge_base/working-set/assets/product-revised.png")!
      .async("nodebuffer");
    expect(sha256(evidenceBytes)).toBe(
      revised.manifest.evidenceLedger[0]!.sha256,
    );
    expect(sha256(assetBytes)).toBe(revised.manifest.assets[0]!.sha256);
  });

  it("rejects a final package whose manifest references an unregistered asset", async () => {
    const workingSet = await initialWorkingSet();
    const nodes = confirmedNodes(workingSet);
    const built = await buildDashboardOwnedKnowledgePackage({
      build: {
        id: buildId,
        generation: 1,
        revision: 0,
        companyName: "示例企业",
        logoStorageKey: null,
      } as KnowledgeBaseBuild,
      nodes,
      materializedWorkingSet: workingSet,
    });
    const zip = await JSZip.loadAsync(built.buffer);
    const manifestPath = "frontmind_knowledge_base/00_package_manifest.json";
    const manifest = JSON.parse(await zip.file(manifestPath)!.async("string"));
    manifest.documents[0].assetIds = ["unregistered-asset"];
    zip.file(manifestPath, JSON.stringify(manifest), {
      date: fixedDate,
      createFolders: false,
    });
    await expect(
      readDashboardOwnedKnowledgePackage({
        buffer: await zip.generateAsync({
          type: "nodebuffer",
          platform: "UNIX",
        }),
        expected: {
          buildId,
          generation: 1,
          revision: 0,
          companyName: "示例企业",
        },
        nodes,
      }),
    ).rejects.toThrow(/AUTHORITY|BINDING/u);
  });
});
