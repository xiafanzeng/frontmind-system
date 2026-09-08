import JSZip from "jszip";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import {
  createKnowledgeNodeEditPatch,
  knowledgeNodeEditPrompt,
  nodeEditSha256,
  parseKnowledgeNodeEditOutput,
} from "./knowledge-node-edit-contract";
import {
  normalizeMaterializedKnowledgeBaseResult,
  validateKnowledgeBaseNodePatchArchive,
  validateKnowledgeBaseWorkingSetArchive,
} from "./knowledge-base-materialized-contract";

export async function nodeEditBaseFixture() {
  const zip = new JSZip();
  const leaves = Array.from({ length: 30 }, (_, ordinal) => {
    const leafId = `1.${ordinal + 1}`;
    const contentPath = `nodes/${ordinal + 1}.md`;
    const content = `# 节点 ${ordinal + 1}\n\n原始事实 ${ordinal + 1}。`;
    zip.file(contentPath, content, { createFolders: false });
    return {
      leafId,
      branchId: "identity",
      branchTitle: "企业身份",
      title: `节点 ${ordinal + 1}`,
      ordinal,
      contentPath,
      contentSha256: nodeEditSha256(content),
      evidencePaths: [],
      assetIds: [],
    };
  });
  const manifest = {
    kind: "frontmind.kb-working-set",
    schemaVersion: 1,
    operationId: "initial-operation",
    buildId: "11111111-1111-4111-8111-111111111111",
    generation: 1,
    contentVersion: 1,
    skill: {
      name: "socratic-kb-builder",
      version: "5",
      contentHash: "a".repeat(64),
    },
    treePolicyVersion: 2,
    company: { name: "示例企业", website: null },
    researchCoverage: {
      officialPages: {
        discovered: 12,
        attempted: 12,
        succeeded: 12,
        failed: 0,
      },
      publicQueries: 6,
      officialDocuments: 0,
      uploadsRead: 0,
      sourceCount: 1,
      productFamilies: [
        {
          id: "primary",
          name: "核心业务",
          leafIds: leaves.map((leaf) => leaf.leafId),
        },
      ],
      dimensions: [
        "enterprise_identity",
        "team_and_organization",
        "products_and_services",
        "capabilities_and_delivery",
        "industries_scenarios_and_cases",
        "differentiation_and_evidence",
        "cooperation_delivery_and_support",
      ].map((id) => ({ id, status: "covered", leafIds: ["1.1"] })),
      stopReason: "coverage_complete",
    },
    branches: [{ branchId: "identity", title: "企业身份", ordinal: 0 }],
    evidenceLedger: [],
    leaves,
    assets: [],
    logo: { status: "missing", assetId: null },
    counts: { leaves: leaves.length, evidenceFiles: 0, assets: 0 },
  };
  zip.file("BUNDLE.json", JSON.stringify(manifest));
  const bytes = await zip.generateAsync({ type: "nodebuffer" });
  return {
    bytes,
    base: await validateKnowledgeBaseWorkingSetArchive(bytes, {
      buildId: manifest.buildId,
      generation: 1,
      contentVersion: 1,
      skillContentHash: manifest.skill.contentHash,
      companyName: manifest.company.name,
    }),
  };
}

describe("lightweight knowledge node edit contract", () => {
  it("accepts exactly one JSON body, without repair or ignored extra fields", () => {
    expect(parseKnowledgeNodeEditOutput('{"contentMarkdown":"# 已修改"}')).toBe(
      "# 已修改",
    );
    for (const invalid of [
      '```json\n{"contentMarkdown":"x"}\n```',
      '{"contentMarkdown":"a","contentMarkdown":"b"}',
      '{"contentMarkdown":"x","reason":"extra"}',
      '{"contentMarkdown":""}',
    ])
      expect(() => parseKnowledgeNodeEditOutput(invalid)).toThrow();
    expect(
      JSON.parse(knowledgeNodeEditPrompt("当前节点", "修改一句话")),
    ).toEqual({ currentNode: "当前节点", instruction: "修改一句话" });
  });
  it("builds a deterministic local patch and preserves all untouched nodes", async () => {
    const { base } = await nodeEditBaseFixture();
    const image = await sharp({
      create: { width: 8, height: 8, channels: 3, background: "red" },
    })
      .png()
      .toBuffer();
    const input = {
      base,
      operationId: "edit-001",
      targetLeafId: "1.1",
      contentMarkdown: "# 节点 1\n\n用户修改后的事实。",
      images: [
        { bytes: image, mimeType: "image/png", sha256: nodeEditSha256(image) },
      ],
    };
    const patch = await createKnowledgeNodeEditPatch(input);
    expect(patch.equals(await createKnowledgeNodeEditPatch(input))).toBe(true);
    const authority = {
      buildId: base.manifest.buildId,
      generation: 1,
      baseContentVersion: 1,
      baseWorkingSetSha256: base.packageSha256,
      operationId: input.operationId,
      targetLeafId: "1.1",
      attachmentSourceProofs: [
        {
          index: 0,
          contentSha256: nodeEditSha256(image),
          sizeBytes: image.length,
          mimeType: "image/png",
        },
      ],
    };
    await expect(
      validateKnowledgeBaseNodePatchArchive(patch, authority),
    ).resolves.toBeDefined();
    const result = await normalizeMaterializedKnowledgeBaseResult({
      mode: "patch",
      archiveBytes: patch,
      authority,
      base,
      provenance: {
        exactBoundTask: false,
        directAssistantOutput: false,
        applicationAuthoredPatch: true,
        descriptorFilename: "local-node-patch.zip",
      },
    });
    expect(result.kind).toBe("accepted");
    if (result.kind !== "accepted") throw new Error(JSON.stringify(result));
    expect(result.manifest.contentVersion).toBe(2);
    expect(result.manifest.assets).toHaveLength(1);
    expect(
      result.workingSet.files
        .get(base.manifest.leaves[1]!.contentPath)
        ?.equals(base.files.get(base.manifest.leaves[1]!.contentPath)!),
    ).toBe(true);
    expect(result.manifest.leaves[0]!.assetIds).toHaveLength(1);
  });
  it("rejects altered image bytes and removal of another node's asset", async () => {
    const { base } = await nodeEditBaseFixture();
    await expect(
      createKnowledgeNodeEditPatch({
        base,
        operationId: "edit-002",
        targetLeafId: "1.1",
        contentMarkdown: "正文",
        images: [
          {
            bytes: Buffer.from("wrong"),
            mimeType: "image/png",
            sha256: "a".repeat(64),
          },
        ],
      }),
    ).rejects.toThrow("IMAGE_INVALID");
    await expect(
      createKnowledgeNodeEditPatch({
        base,
        operationId: "edit-002",
        targetLeafId: "1.1",
        contentMarkdown: "正文",
        images: [],
        removeAssetIds: ["foreign-asset"],
      }),
    ).rejects.toThrow("IMAGE_OWNERSHIP");
  });
  it.each([false, true])(
    "preserves existing image bytes and the other node through a local patch (detach shared image: %s)",
    async (detachSharedImage) => {
      const { base: original } = await nodeEditBaseFixture();
      const bytes = await sharp({
        create: { width: 8, height: 8, channels: 3, background: "blue" },
      })
        .png()
        .toBuffer();
      const asset = {
        assetId: "shared-image",
        path: "assets/shared.png",
        sha256: nodeEditSha256(bytes),
        mimeType: "image/png",
        bytes: bytes.length,
        width: 8,
        height: 8,
        provenance: {
          ownership: "first_party",
          sourceKind: "user_upload",
          originalUploadSha256: nodeEditSha256(bytes),
        },
        documentIds: ["1.1", "1.2"],
        assetType: "customer_supplied",
        displayRole: "inline",
      };
      const attachedBytes = await sharp({
        create: { width: 8, height: 8, channels: 3, background: "green" },
      })
        .png()
        .toBuffer();
      const attachedAsset = {
        ...asset,
        assetId: "target-only-image",
        path: "assets/target-only.png",
        sha256: nodeEditSha256(attachedBytes),
        bytes: attachedBytes.length,
        provenance: {
          ...asset.provenance,
          originalUploadSha256: nodeEditSha256(attachedBytes),
        },
        documentIds: ["1.1"],
      };
      const manifest = {
        ...original.manifest,
        assets: [asset, attachedAsset],
        counts: { ...original.manifest.counts, assets: 2 },
        leaves: original.manifest.leaves.map((leaf) =>
          leaf.leafId === "1.1"
            ? { ...leaf, assetIds: [asset.assetId, attachedAsset.assetId] }
            : leaf.leafId === "1.2"
              ? { ...leaf, assetIds: [asset.assetId] }
              : leaf,
        ),
      };
      const zip = new JSZip();
      for (const [path, content] of original.files)
        if (path !== "BUNDLE.json")
          zip.file(path, content, { createFolders: false });
      zip.file(asset.path, bytes, { createFolders: false });
      zip.file(attachedAsset.path, attachedBytes, { createFolders: false });
      zip.file("BUNDLE.json", JSON.stringify(manifest));
      const base = await validateKnowledgeBaseWorkingSetArchive(
        await zip.generateAsync({ type: "nodebuffer" }),
        {
          buildId: manifest.buildId,
          generation: 1,
          contentVersion: 1,
          skillContentHash: manifest.skill.contentHash,
          companyName: manifest.company.name,
        },
      );
      const archiveBytes = await createKnowledgeNodeEditPatch({
        base,
        operationId: "detach-shared",
        targetLeafId: "1.1",
        contentMarkdown: detachSharedImage
          ? base.files.get(base.manifest.leaves[0]!.contentPath)!.toString()
          : "# 节点 1\n\n直接编辑后的正文，原有图片仍保留。",
        images: [],
        removeAssetIds: detachSharedImage ? [asset.assetId] : [],
      });
      const authority = {
        buildId: manifest.buildId,
        generation: 1,
        baseContentVersion: 1,
        baseWorkingSetSha256: base.packageSha256,
        operationId: "detach-shared",
        targetLeafId: "1.1",
        attachmentSourceProofs: [],
      };
      const result = await normalizeMaterializedKnowledgeBaseResult({
        mode: "patch",
        archiveBytes,
        authority,
        base,
        provenance: {
          exactBoundTask: false,
          directAssistantOutput: false,
          applicationAuthoredPatch: true,
          descriptorFilename: "local.zip",
        },
      });
      expect(result.kind).toBe("accepted");
      if (result.kind !== "accepted") throw new Error(JSON.stringify(result));
      expect(result.manifest.leaves[0]!.assetIds).toEqual(
        detachSharedImage
          ? [attachedAsset.assetId]
          : [asset.assetId, attachedAsset.assetId],
      );
      expect(result.manifest.leaves[1]!.assetIds).toEqual([asset.assetId]);
      expect(
        result.manifest.assets.find((item) => item.assetId === asset.assetId)!
          .documentIds,
      ).toEqual(detachSharedImage ? ["1.2"] : ["1.1", "1.2"]);
      expect(
        result.manifest.assets.find(
          (item) => item.assetId === attachedAsset.assetId,
        ),
      ).toEqual(attachedAsset);
      expect(result.workingSet.files.get(asset.path)?.equals(bytes)).toBe(true);
      expect(
        result.workingSet.files.get(attachedAsset.path)?.equals(attachedBytes),
      ).toBe(true);
      expect(
        result.workingSet.files
          .get(base.manifest.leaves[1]!.contentPath)
          ?.equals(base.files.get(base.manifest.leaves[1]!.contentPath)!),
      ).toBe(true);
      expect(base.manifest.leaves[0]!.assetIds).toEqual([
        asset.assetId,
        attachedAsset.assetId,
      ]);
      if (!detachSharedImage) {
        expect(result.manifest.assets).toEqual(base.manifest.assets);
        return;
      }
      const legacy = await normalizeMaterializedKnowledgeBaseResult({
        mode: "patch",
        archiveBytes,
        authority,
        base,
        provenance: {
          exactBoundTask: true,
          directAssistantOutput: true,
          descriptorFilename: "provider.zip",
        },
      });
      expect(legacy.kind).toBe("rejected");
    },
  );
});
