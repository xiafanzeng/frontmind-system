import { createHash } from "node:crypto";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";

import {
  buildKnowledgeBaseFinalizationInput,
  KNOWLEDGE_BASE_FINALIZATION_INPUT_FILENAME_PREFIX,
} from "./knowledge-base-finalization-input";
import { knowledgeBaseMarkdownSha256 } from "./knowledge-base-package-validation";

function sha256(bytes: Buffer | string) {
  return createHash("sha256").update(bytes).digest("hex");
}

function approvedNodes(count = 8) {
  return Array.from({ length: count }, (_, order) => {
    const id = order === 7 ? "7.5" : `1.${order + 1}`;
    const contentMarkdown =
      order === 7
        ? "# 最终节点\n\n经客户确认的正文。\n"
        : `# 节点 ${id}\n\n经客户确认的正文。\n`;
    return {
      id,
      title: order === 7 ? "销售网络与渠道" : `节点 ${id}`,
      branchId: order === 7 ? "7" : "1",
      branchTitle: order === 7 ? "服务与合作" : "企业身份",
      order,
      status: "confirmed",
      contentMarkdown,
      contentSha256: knowledgeBaseMarkdownSha256(contentMarkdown),
    };
  });
}

describe("knowledge-base finalization input", () => {
  it("deterministically carries approved prose and physical image bytes", async () => {
    const nodes = approvedNodes();
    const logo = Buffer.from("logo-image-bytes");
    const upload = Buffer.from("customer-image-bytes");
    const input = {
      companyName: "硅基流动",
      operationId: "operation-final",
      turnId: "turn-final",
      buildRevision: 51,
      nodes,
      assets: [
        {
          kind: "official_logo" as const,
          filename: "logo.png",
          mimeType: "image/png",
          sha256: sha256(logo),
          bytes: logo,
          documentIds: ["1.1"],
          sourceKind: "official_logo_upload",
          sourceUploadIndex: 0,
          sourceUploadFileId: "file-logo",
          sourceUploadFilename: "logo.png",
          sourceUploadMimeType: "image/png",
          sourceUploadSizeBytes: logo.length,
          sourceUploadSha256: sha256(logo),
        },
        {
          kind: "customer_upload" as const,
          filename: "customer.jpeg",
          mimeType: "image/jpeg",
          sha256: sha256(upload),
          bytes: upload,
          documentIds: ["7.5", "1.6"],
          sourceFileIds: ["file-customer"],
          sourceKind: "user_upload",
          sourceUploadFilename: "customer.jpeg",
          sourceUploadMimeType: "image/jpeg",
          sourceUploadSha256: sha256(upload),
        },
      ],
    };

    const first = await buildKnowledgeBaseFinalizationInput(input);
    const second = await buildKnowledgeBaseFinalizationInput(input);
    expect(first.filename).toBe(
      `${KNOWLEDGE_BASE_FINALIZATION_INPUT_FILENAME_PREFIX}-${first.sha256.slice(0, 16)}.zip`,
    );
    expect(first.assetCount).toBe(2);
    expect(first.bytes.equals(second.bytes)).toBe(true);
    expect(first.sha256).toBe(sha256(first.bytes));

    const zip = await JSZip.loadAsync(first.bytes, { checkCRC32: true });
    expect(Object.values(zip.files).filter((entry) => entry.dir)).toEqual([]);
    const ledger = JSON.parse(
      await zip.file("FINALIZATION_INPUT.json")!.async("string"),
    );
    expect(ledger.requiredPackage).toEqual({
      schemaVersion: 4,
      profile: "dashboard-enterprise-v1",
      buildRevision: 51,
      treePolicyVersion: 1,
      minLeaves: 8,
      maxLeaves: 115,
    });
    expect(ledger.nodes[7]).toMatchObject({
      id: "7.5",
      contentMarkdown: nodes[7]!.contentMarkdown,
      contentSha256: nodes[7]!.contentSha256,
    });
    expect(
      await zip.file(ledger.nodes[7].approvedContentPath)!.async("string"),
    ).toBe(nodes[7]!.contentMarkdown);
    const logoLedger = ledger.assets.find(
      (asset: { kind: string }) => asset.kind === "official_logo",
    );
    const uploadLedger = ledger.assets.find(
      (asset: { kind: string }) => asset.kind === "customer_upload",
    );
    expect(logoLedger).toMatchObject({
      input: {
        filename: "logo.png",
        mimeType: "image/png",
        sha256: sha256(logo),
      },
      requiredManifest: {
        branchId: "1",
        ownership: "first_party",
        assetType: "brand_identity",
        displayRole: "badge",
        sourceUploadIndex: 0,
        sourceUploadFileId: "file-logo",
        sourceUploadSha256: sha256(logo),
      },
    });
    expect(uploadLedger.requiredManifest).toMatchObject({
      branchId: "1",
      documentIds: ["1.6", "7.5"],
      sourceKind: "user_upload",
      assetType: "customer_supplied",
      displayRole: "inline",
    });
    expect(
      Buffer.from(await zip.file(logoLedger.input.path)!.async("uint8array")),
    ).toEqual(logo);
    expect(
      Buffer.from(await zip.file(uploadLedger.input.path)!.async("uint8array")),
    ).toEqual(upload);
    expect(await zip.file("README.md")!.async("string")).toContain(
      "VALID dashboard-enterprise-v1 archive",
    );
    expect(await zip.file("README.md")!.async("string")).toContain(
      "including the finalization-input filename, SHA-256, operationId and turnId flags",
    );
    expect(await zip.file("README.md")!.async("string")).toContain(
      "Never invent sourceUpload*",
    );
  });

  it("pins deep finalization input to 30–115 approved nodes", async () => {
    const logo = Buffer.from("deep-policy-logo");
    await expect(
      buildKnowledgeBaseFinalizationInput({
        companyName: "企业",
        operationId: "operation",
        turnId: "turn",
        buildRevision: 30,
        treePolicyVersion: 2,
        nodes: approvedNodes(29),
        assets: [],
      }),
    ).rejects.toThrow("FINALIZATION_INPUT_COORDINATES_INVALID");

    const result = await buildKnowledgeBaseFinalizationInput({
      companyName: "企业",
      operationId: "operation",
      turnId: "turn",
      buildRevision: 30,
      treePolicyVersion: 2,
      nodes: approvedNodes(30),
      assets: [
        {
          kind: "official_logo",
          filename: "logo.png",
          mimeType: "image/png",
          sha256: sha256(logo),
          bytes: logo,
          documentIds: ["1.1"],
        },
      ],
    });
    const zip = await JSZip.loadAsync(result.bytes, { checkCRC32: true });
    const ledger = JSON.parse(
      await zip.file("FINALIZATION_INPUT.json")!.async("string"),
    );
    expect(ledger.requiredPackage).toMatchObject({
      treePolicyVersion: 2,
      minLeaves: 30,
      maxLeaves: 115,
    });
    expect(ledger.nodes).toHaveLength(30);

    const maximum = await buildKnowledgeBaseFinalizationInput({
      companyName: "企业",
      operationId: "operation-max",
      turnId: "turn-max",
      buildRevision: 115,
      treePolicyVersion: 2,
      nodes: approvedNodes(115),
      assets: [
        {
          kind: "official_logo",
          filename: "logo.png",
          mimeType: "image/png",
          sha256: sha256(logo),
          bytes: logo,
          documentIds: ["1.1"],
        },
      ],
    });
    const maximumZip = await JSZip.loadAsync(maximum.bytes, {
      checkCRC32: true,
    });
    expect(
      JSON.parse(
        await maximumZip.file("FINALIZATION_INPUT.json")!.async("string"),
      ).nodes,
    ).toHaveLength(115);

    await expect(
      buildKnowledgeBaseFinalizationInput({
        companyName: "企业",
        operationId: "operation-over-max",
        turnId: "turn-over-max",
        buildRevision: 116,
        treePolicyVersion: 2,
        nodes: approvedNodes(116),
        assets: [],
      }),
    ).rejects.toThrow("FINALIZATION_INPUT_COORDINATES_INVALID");
  });

  it("rejects placeholder-only finalization input", async () => {
    await expect(
      buildKnowledgeBaseFinalizationInput({
        companyName: "企业",
        operationId: "operation",
        turnId: "turn",
        buildRevision: 1,
        nodes: approvedNodes(),
        assets: [],
      }),
    ).rejects.toThrow("FINALIZATION_INPUT_LOGO_REQUIRED");
  });

  it("carries an automatically bound Logo without external provenance", async () => {
    const logo = Buffer.from("managed-auto-logo-bytes");
    const result = await buildKnowledgeBaseFinalizationInput({
      companyName: "企业",
      operationId: "operation",
      turnId: "turn",
      buildRevision: 51,
      nodes: approvedNodes(),
      assets: [
        {
          kind: "official_logo",
          filename: "logo.png",
          mimeType: "image/png",
          sha256: sha256(logo),
          bytes: logo,
          documentIds: ["1.1"],
        },
      ],
    });
    const zip = await JSZip.loadAsync(result.bytes, { checkCRC32: true });
    const ledger = JSON.parse(
      await zip.file("FINALIZATION_INPUT.json")!.async("string"),
    );
    expect(ledger.assets[0].requiredManifest).not.toHaveProperty("sourceKind");
    expect(ledger.assets[0].requiredManifest).toMatchObject({
      assetType: "brand_identity",
      displayRole: "badge",
      documentIds: ["1.1"],
    });
  });

  it("rejects a legacy Logo whose provenance would have to be guessed", async () => {
    const logo = Buffer.from("logo-image-bytes");
    await expect(
      buildKnowledgeBaseFinalizationInput({
        companyName: "企业",
        operationId: "operation",
        turnId: "turn",
        buildRevision: 51,
        nodes: approvedNodes(),
        assets: [
          {
            kind: "official_logo",
            filename: "logo.png",
            mimeType: "image/png",
            sha256: sha256(logo),
            bytes: logo,
            documentIds: ["1.1"],
            sourceKind: "legacy_bound_logo",
          },
        ],
      }),
    ).rejects.toThrow("FINALIZATION_INPUT_ASSET_PROVENANCE_INVALID");
  });

  it("rejects an official-web Logo without the exact source asset URL", async () => {
    const logo = Buffer.from("logo-image-bytes");
    await expect(
      buildKnowledgeBaseFinalizationInput({
        companyName: "企业",
        operationId: "operation",
        turnId: "turn",
        buildRevision: 51,
        nodes: approvedNodes(),
        assets: [
          {
            kind: "official_logo",
            filename: "logo.png",
            mimeType: "image/png",
            sha256: sha256(logo),
            bytes: logo,
            documentIds: ["1.1"],
            sourceKind: "official_web",
            sourcePageUrl: "https://company.example/about",
          },
        ],
      }),
    ).rejects.toThrow("FINALIZATION_INPUT_ASSET_PROVENANCE_INVALID");
  });
});
