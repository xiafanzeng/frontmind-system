import { createHash } from "node:crypto";

import JSZip from "jszip";
import { describe, expect, it } from "vitest";

import { markedKnowledgeArchiveFormalContent } from "./knowledge-archive-text-utils";
import {
  KnowledgeBasePackageCanonicalizationError,
  canonicalizeKnowledgeBaseFinalArchive,
} from "./knowledge-base-package-canonicalization";
import { knowledgeBaseMarkdownSha256 } from "./knowledge-base-package-validation";

const root = "example_knowledge_base/";
const leafOnePath = "branches/identity/1.1_positioning.md";
const leafTwoPath = "branches/identity/1.2_company.md";
const assetPath = "09_media_assets/customer-image.png";

function nodes() {
  return [
    {
      leafId: "1.1",
      title: "一句话定位",
      branchId: "identity",
      branchTitle: "企业身份",
      ordinal: 0,
      status: "confirmed",
      contentMarkdown: "## 1.1 一句话定位\n\n客户确认的一句话定位。",
      contentSha256: knowledgeBaseMarkdownSha256(
        "## 1.1 一句话定位\n\n客户确认的一句话定位。",
      ),
    },
    {
      leafId: "1.2",
      title: "公司主体",
      branchId: "identity",
      branchTitle: "企业身份",
      ordinal: 1,
      status: "confirmed",
      contentMarkdown: "## 1.2 公司主体\n\n客户确认的公司主体。",
      contentSha256: knowledgeBaseMarkdownSha256(
        "## 1.2 公司主体\n\n客户确认的公司主体。",
      ),
    },
  ];
}

async function candidateArchive(options?: {
  firstId?: string;
  secondId?: string;
  manifestBom?: boolean;
}) {
  const zip = new JSZip();
  const documents = [
    {
      id: options?.firstId || "1.1",
      path: leafOnePath,
      kind: "leaf",
      title: "一句话定位",
      branchId: "identity",
      branchTitle: "企业身份",
      order: 0,
      assetIds: [],
      customerVisible: true,
    },
    {
      id: options?.secondId || "1.2",
      path: leafTwoPath,
      kind: "leaf",
      title: "公司主体",
      branchId: "identity",
      branchTitle: "企业身份",
      order: 1,
      assetIds: ["asset-customer"],
      customerVisible: true,
    },
  ];
  const manifest = {
    schemaVersion: 4,
    profile: "dashboard-enterprise-v1",
    buildRevision: 47,
    documents,
    assets: [
      {
        id: "asset-customer",
        path: assetPath,
        branchId: "identity",
        documentIds: [options?.secondId || "1.2"],
      },
    ],
    counts: {
      totalFiles: 5,
      customerVisibleCharacters: 1,
      evidenceCharacters: 12,
      packagedImages: 1,
    },
  };
  zip.file(
    `${root}00_package_manifest.json`,
    `${options?.manifestBom ? "\uFEFF" : ""}${JSON.stringify(manifest, null, 2).replace(/\n/gu, "\r\n")}\r\n`,
  );
  zip.file(
    `${root}${leafOnePath}`,
    `# 1.1 一句话定位\n\n<!-- FRONTMIND_FORMAL_CONTENT_START -->\n\n模型改写的定位。\n\n<!-- FRONTMIND_FORMAL_CONTENT_END -->\n\n## 证据与核验\n\n- evidence-one`,
  );
  zip.file(
    `${root}${leafTwoPath}`,
    `# 1.2 公司主体\n\n<!-- FRONTMIND_FORMAL_CONTENT_START -->\n\n模型改写的公司主体。\n\n<!-- FRONTMIND_FORMAL_CONTENT_END -->\n\n## 证据与核验\n\n- evidence-two`,
  );
  zip.file(`${root}${assetPath}`, Buffer.from([0, 1, 2, 3, 4, 5]));
  zip.file(`${root}README.md`, "Archive references 1.2 exactly.\n");
  return zip.generateAsync({ type: "nodebuffer" });
}

async function readCanonical(buffer: Buffer) {
  const zip = await JSZip.loadAsync(buffer, { checkCRC32: true });
  const manifest = JSON.parse(
    await zip.file(`${root}00_package_manifest.json`)!.async("string"),
  );
  return { zip, manifest };
}

describe("knowledge-base final archive canonicalization", () => {
  it("canonicalizes a BOM/CRLF manifest while preserving strict schema validation", async () => {
    const result = await canonicalizeKnowledgeBaseFinalArchive({
      buffer: await candidateArchive({ manifestBom: true }),
      nodes: nodes(),
      buildRevision: 47,
    });

    expect(result.changed).toBe(true);
    const { manifest } = await readCanonical(result.buffer);
    expect(manifest.schemaVersion).toBe(4);
    expect(manifest.documents).toHaveLength(2);
  });

  it("seals approved bodies deterministically while preserving raw node IDs and bytes", async () => {
    const candidate = await candidateArchive();
    const first = await canonicalizeKnowledgeBaseFinalArchive({
      buffer: candidate,
      nodes: nodes(),
      buildRevision: 47,
    });
    const repeated = await canonicalizeKnowledgeBaseFinalArchive({
      buffer: candidate,
      nodes: nodes(),
      buildRevision: 47,
    });
    const idempotent = await canonicalizeKnowledgeBaseFinalArchive({
      buffer: first.buffer,
      nodes: nodes(),
      buildRevision: 47,
    });

    expect(first.changed).toBe(true);
    expect(repeated.buffer.equals(first.buffer)).toBe(true);
    expect(idempotent).toMatchObject({ changed: false });
    expect(idempotent.buffer.equals(first.buffer)).toBe(true);

    const { zip, manifest } = await readCanonical(first.buffer);
    expect(
      manifest.documents.map((document: { id: string }) => document.id),
    ).toEqual(["1.1", "1.2"]);
    expect(manifest.assets[0].documentIds).toEqual(["1.2"]);
    expect(manifest.counts.customerVisibleCharacters).toBeGreaterThan(1);
    expect(
      markedKnowledgeArchiveFormalContent(
        await zip.file(`${root}${leafOnePath}`)!.async("string"),
      )?.trim(),
    ).toBe(nodes()[0]!.contentMarkdown);
    expect(await zip.file(`${root}README.md`)!.async("string")).toContain(
      "1.2",
    );
    expect(
      createHash("sha256")
        .update(await zip.file(`${root}${assetPath}`)!.async("nodebuffer"))
        .digest("hex"),
    ).toBe(
      createHash("sha256")
        .update(Buffer.from([0, 1, 2, 3, 4, 5]))
        .digest("hex"),
    );
  });

  it("rejects arbitrary archive-only leaf aliases", async () => {
    await expect(
      canonicalizeKnowledgeBaseFinalArchive({
        buffer: await candidateArchive({ secondId: "node-1.2" }),
        nodes: nodes(),
        buildRevision: 47,
      }),
    ).rejects.toThrow(KnowledgeBasePackageCanonicalizationError);
  });

  it("rejects the historical leaf- prefix on writes but accepts it on reads", async () => {
    const legacy = await candidateArchive({
      firstId: "leaf-1.1",
      secondId: "leaf-1.2",
    });
    await expect(
      canonicalizeKnowledgeBaseFinalArchive({
        buffer: legacy,
        nodes: nodes(),
        buildRevision: 47,
      }),
    ).rejects.toThrow(KnowledgeBasePackageCanonicalizationError);

    const recovered = await canonicalizeKnowledgeBaseFinalArchive({
      buffer: legacy,
      nodes: nodes(),
      buildRevision: 47,
      legacyV4ReadCompatibility: true,
    });
    const { manifest } = await readCanonical(recovered.buffer);
    expect(
      manifest.documents.map((document: { id: string }) => document.id),
    ).toEqual(["leaf-1.1", "leaf-1.2"]);
    expect(manifest.assets[0].documentIds).toEqual(["leaf-1.2"]);
  });
});
