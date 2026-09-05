import JSZip from "jszip";
import { describe, expect, it } from "vitest";

import type {
  KnowledgeBaseBuild,
  KnowledgeBaseBuildNode,
} from "../drizzle/schema";
import { knowledgeBaseMarkdownSha256 } from "./knowledge-base-package-validation";
import {
  buildDashboardOwnedKnowledgePackage,
  knowledgeBasePackageSweepWriteApplied,
  MAX_AUTOMATIC_PACKAGE_ATTEMPTS,
  nextKnowledgeBasePackageFailure,
  readDashboardOwnedKnowledgePackage,
} from "./knowledge-base-local-package";
import {
  knowledgeBuildArtifactLocalPackageStorageKey,
  knowledgeBuildArtifactStorageKeyBelongsTo,
} from "./knowledge-build-artifact-store";

const build = {
  id: "123e4567-e89b-42d3-a456-426614174000",
  generation: 3,
  revision: 2,
  companyName: "FrontMind",
  logoStorageKey: null,
} as KnowledgeBaseBuild;

function nodes() {
  return [
    {
      leafId: "1.1",
      title: "一句话定位",
      branchId: "identity",
      branchTitle: "企业身份",
      ordinal: 0,
      status: "confirmed",
      contentMarkdown: "## 1.1 一句话定位\n\nFrontMind 是企业 AI 工作流平台。",
      contentSha256: knowledgeBaseMarkdownSha256(
        "## 1.1 一句话定位\n\nFrontMind 是企业 AI 工作流平台。",
      ),
      sourceUrls: ["https://frontmind.net/"],
      imageUrls: [],
    },
    {
      leafId: "1.2",
      title: "公司主体",
      branchId: "identity",
      branchTitle: "企业身份",
      ordinal: 1,
      status: "direct_prefilled",
      contentMarkdown: "## 1.2 公司主体\n\n北京超前智能科技有限公司。",
      contentSha256: knowledgeBaseMarkdownSha256(
        "## 1.2 公司主体\n\n北京超前智能科技有限公司。",
      ),
      sourceUrls: [],
      imageUrls: [],
    },
  ] as KnowledgeBaseBuildNode[];
}

describe("Dashboard-owned knowledge package", () => {
  it("builds and revalidates a customer-safe derivative before hashing", async () => {
    const privateBrand = ["Ma", "nus"].join("");
    const pollutedNodes = nodes();
    pollutedNodes[0] = {
      ...pollutedNodes[0]!,
      leafId: `${privateBrand}_V2_1.1`,
      title: `${privateBrand} 节点`,
      branchId: `${privateBrand}-identity`,
      branchTitle: `${privateBrand} 企业身份`,
      contentMarkdown: `## ${privateBrand} 节点\n\n内部码 ${privateBrand.toUpperCase()}_V2_TASK，来源 https://open.${privateBrand.toLowerCase()}.ai/task/1。`,
      contentSha256: knowledgeBaseMarkdownSha256(
        `## ${privateBrand} 节点\n\n内部码 ${privateBrand.toUpperCase()}_V2_TASK，来源 https://open.${privateBrand.toLowerCase()}.ai/task/1。`,
      ),
      sourceUrls: [
        `https://api.${privateBrand.toLowerCase()}.ai/source`,
        "https://frontmind.net/source",
      ],
      imageUrls: [`https://cdn.${privateBrand.toLowerCase()}.ai/image.png`],
    };
    const logo = Buffer.from("customer-logo-bytes", "utf8");
    const logoSha256 = await import("node:crypto").then(({ createHash }) =>
      createHash("sha256").update(logo).digest("hex"),
    );
    const built = await buildDashboardOwnedKnowledgePackage({
      build: {
        ...build,
        companyName: `${privateBrand} 企业`,
      },
      nodes: pollutedNodes,
      logo: {
        buffer: logo,
        filename: `${privateBrand}_logo.png`,
        mimeType: "image/png",
        sha256: logoSha256,
        bytes: logo.length,
      },
    });

    const zip = await JSZip.loadAsync(built.buffer, { checkCRC32: true });
    const publicStrings = [JSON.stringify(built.manifest)];
    for (const entry of Object.values(zip.files)) {
      publicStrings.push(entry.name);
      if (!entry.dir) publicStrings.push(await entry.async("string"));
    }
    expect(publicStrings.join("\n")).not.toMatch(/manus/iu);
    expect(built.manifest.documents[0]?.sourceUrls).toEqual([
      "https://frontmind.net/source",
    ]);
    expect(built.manifest.documents[0]?.imageUrls).toEqual([]);

    const parsed = await readDashboardOwnedKnowledgePackage({
      buffer: built.buffer,
      expected: {
        buildId: build.id,
        generation: build.generation,
        revision: build.revision,
        companyName: `${privateBrand} 企业`,
      },
      nodes: pollutedNodes,
    });
    expect(parsed.documents[0]?.title).toBe("FrontMind 节点");
  });

  it("builds deterministic bytes solely from accepted nodes", async () => {
    const first = await buildDashboardOwnedKnowledgePackage({
      build,
      nodes: nodes(),
    });
    const second = await buildDashboardOwnedKnowledgePackage({
      build,
      nodes: nodes(),
    });

    expect(first.sha256).toBe(second.sha256);
    expect(first.buffer.equals(second.buffer)).toBe(true);
    expect(first.manifest.missing_optional_assets).toContain("official_logo");

    const parsed = await readDashboardOwnedKnowledgePackage({
      buffer: first.buffer,
      expected: {
        buildId: build.id,
        generation: build.generation,
        revision: build.revision,
        companyName: build.companyName,
      },
      nodes: nodes(),
    });
    expect(parsed.documents.map((document) => document.id)).toEqual([
      "1.1",
      "1.2",
    ]);
    expect(parsed.assets).toEqual([]);
  });

  it("packages a verified durable Logo when available without making it required", async () => {
    // A minimal valid 1x1 PNG. The package builder binds exact bytes/hash; the
    // artifact store performs the image decode validation before this input is
    // produced in the worker.
    const logo = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    );
    const logoSha256 = await import("node:crypto").then(({ createHash }) =>
      createHash("sha256").update(logo).digest("hex"),
    );
    const first = await buildDashboardOwnedKnowledgePackage({
      build,
      nodes: nodes(),
      logo: {
        buffer: logo,
        filename: "brand-logo.png",
        mimeType: "image/png",
        sha256: logoSha256,
        bytes: logo.length,
      },
    });
    const second = await buildDashboardOwnedKnowledgePackage({
      build,
      nodes: nodes(),
      logo: {
        buffer: logo,
        filename: "brand-logo.png",
        mimeType: "image/png",
        sha256: logoSha256,
        bytes: logo.length,
      },
    });
    expect(first.buffer.equals(second.buffer)).toBe(true);
    expect(first.manifest.missing_optional_assets).not.toContain(
      "official_logo",
    );
    expect(first.manifest.assets).toEqual([
      expect.objectContaining({
        id: "official-logo",
        path: "assets/official-logo.png",
        sha256: logoSha256,
        bytes: logo.length,
      }),
    ]);

    const parsed = await readDashboardOwnedKnowledgePackage({
      buffer: first.buffer,
      expected: {
        buildId: build.id,
        generation: build.generation,
        revision: build.revision,
        companyName: build.companyName,
      },
      nodes: nodes(),
      storeAsset: async ({ id, sha256, buffer }) => {
        expect(id).toBe("official-logo");
        expect(sha256).toBe(logoSha256);
        expect(buffer.equals(logo)).toBe(true);
        return "snapshot-logo.png";
      },
    });
    expect(parsed.assets).toEqual([
      expect.objectContaining({
        id: "official-logo",
        key: "snapshot-logo.png",
        path: "frontmind_knowledge_base/assets/official-logo.png",
        sha256: logoSha256,
        assetType: "brand_identity",
        displayRole: "badge",
      }),
    ]);
    expect(parsed.storedAssetKeys).toEqual(["snapshot-logo.png"]);
  });

  it("keeps an unbound registered asset while enforcing its empty document binding", async () => {
    const built = await buildDashboardOwnedKnowledgePackage({
      build,
      nodes: nodes(),
    });
    const zip = await JSZip.loadAsync(built.buffer);
    const manifestPath = "frontmind_knowledge_base/00_package_manifest.json";
    const assetPath =
      "frontmind_knowledge_base/working-set/assets/unbound-brand-reference.png";
    const asset = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    );
    const assetSha256 = await import("node:crypto").then(({ createHash }) =>
      createHash("sha256").update(asset).digest("hex"),
    );
    const manifest = JSON.parse(await zip.file(manifestPath)!.async("string"));
    manifest.assets.push({
      id: "unbound-brand-reference",
      kind: "working_set_asset",
      path: "working-set/assets/unbound-brand-reference.png",
      sourcePath: "assets/unbound-brand-reference.png",
      filename: "unbound-brand-reference.png",
      mimeType: "image/png",
      sha256: assetSha256,
      bytes: asset.length,
      width: 1,
      height: 1,
      provenance: { kind: "brand-reference" },
      documentIds: [],
    });
    manifest.counts.files += 1;
    zip.file(assetPath, asset);
    zip.file(manifestPath, JSON.stringify(manifest));

    const parsed = await readDashboardOwnedKnowledgePackage({
      buffer: await zip.generateAsync({ type: "nodebuffer", platform: "UNIX" }),
      expected: {
        buildId: build.id,
        generation: build.generation,
        revision: build.revision,
        companyName: build.companyName,
      },
      nodes: nodes(),
    });
    expect(parsed.assets).toContainEqual(
      expect.objectContaining({
        id: "unbound-brand-reference",
        sha256: assetSha256,
        documentIds: [],
      }),
    );
    const parsedAsset = parsed.assets.find(
      (candidate) => candidate.id === "unbound-brand-reference",
    );
    expect(parsedAsset).not.toHaveProperty("caption");
    expect(parsedAsset).not.toHaveProperty("alt");
  });

  it("rejects a Logo whose declared durable identity does not match its bytes", async () => {
    const logo = Buffer.from("not-the-declared-logo", "utf8");
    await expect(
      buildDashboardOwnedKnowledgePackage({
        build,
        nodes: nodes(),
        logo: {
          buffer: logo,
          filename: "brand-logo.png",
          mimeType: "image/png",
          sha256: "a".repeat(64),
          bytes: logo.length,
        },
      }),
    ).rejects.toThrow("LOCAL_PACKAGE_OPTIONAL_LOGO_INTEGRITY_MISMATCH");
  });

  it("rejects changed node bytes even if the ZIP itself remains valid", async () => {
    const built = await buildDashboardOwnedKnowledgePackage({
      build,
      nodes: nodes(),
    });
    const zip = await JSZip.loadAsync(built.buffer);
    zip.file(
      "frontmind_knowledge_base/nodes/0001.md",
      "## 1.1 一句话定位\n\n被替换的正文。",
    );
    const changed = await zip.generateAsync({ type: "nodebuffer" });

    await expect(
      readDashboardOwnedKnowledgePackage({
        buffer: changed,
        expected: {
          buildId: build.id,
          generation: build.generation,
          revision: build.revision,
          companyName: build.companyName,
        },
        nodes: nodes(),
      }),
    ).rejects.toThrow("LOCAL_PACKAGE_NODE_HASH_MISMATCH");
  });

  it("rejects a manifest whose frozen enterprise no longer matches the build", async () => {
    const built = await buildDashboardOwnedKnowledgePackage({
      build,
      nodes: nodes(),
    });

    await expect(
      readDashboardOwnedKnowledgePackage({
        buffer: built.buffer,
        expected: {
          buildId: build.id,
          generation: build.generation,
          revision: build.revision,
          companyName: "另一企业",
        },
        nodes: nodes(),
      }),
    ).rejects.toThrow("LOCAL_PACKAGE_COORDINATES_MISMATCH");
  });

  it("requires every packaged document to match an accepted DB node", async () => {
    const built = await buildDashboardOwnedKnowledgePackage({
      build,
      nodes: nodes(),
    });
    const mismatchedNodes = nodes();
    mismatchedNodes[0] = {
      ...mismatchedNodes[0]!,
      leafId: "unexpected-leaf",
    };

    await expect(
      readDashboardOwnedKnowledgePackage({
        buffer: built.buffer,
        expected: {
          buildId: build.id,
          generation: build.generation,
          revision: build.revision,
          companyName: build.companyName,
        },
        nodes: mismatchedNodes,
      }),
    ).rejects.toThrow("LOCAL_PACKAGE_NODE_AUTHORITY_MISMATCH");
  });

  it("refuses to package an incomplete or corrupt accepted-node set", async () => {
    const incomplete = nodes();
    incomplete[1] = { ...incomplete[1]!, status: "pending" };
    await expect(
      buildDashboardOwnedKnowledgePackage({ build, nodes: incomplete }),
    ).rejects.toThrow("LOCAL_PACKAGE_CORE_NODES_INCOMPLETE");

    const mismatched = nodes();
    mismatched[0] = { ...mismatched[0]!, contentSha256: "f".repeat(64) };
    await expect(
      buildDashboardOwnedKnowledgePackage({ build, nodes: mismatched }),
    ).rejects.toThrow("LOCAL_PACKAGE_CORE_NODE_HASH_MISMATCH");
  });

  it("uses a revision-scoped immutable path for Dashboard-owned packages", () => {
    const first = knowledgeBuildArtifactLocalPackageStorageKey({
      userId: 1,
      buildId: build.id,
      generation: build.generation,
      revision: 2,
    });
    const later = knowledgeBuildArtifactLocalPackageStorageKey({
      userId: 1,
      buildId: build.id,
      generation: build.generation,
      revision: 3,
    });
    expect(first).not.toBe(later);
    expect(
      knowledgeBuildArtifactStorageKeyBelongsTo({
        storageKey: later,
        userId: 1,
        buildId: build.id,
        generation: build.generation,
        kind: "package",
      }),
    ).toBe(true);
  });

  it("caps local package retries without changing completed content semantics", () => {
    const retry = nextKnowledgeBasePackageFailure({
      packageAttemptCount: 0,
      now: new Date("2026-08-12T00:00:00.000Z"),
      errorCode: "LOCAL_PACKAGE_CORE_NODES_INCOMPLETE",
    });
    expect(retry).toMatchObject({
      packageStatus: "retrying",
      packageAttemptCount: 1,
      packageLastErrorCode: "LOCAL_PACKAGE_CORE_NODES_INCOMPLETE",
    });
    expect(retry.packageNextRetryAt).toBeInstanceOf(Date);

    const capped = nextKnowledgeBasePackageFailure({
      packageAttemptCount: MAX_AUTOMATIC_PACKAGE_ATTEMPTS - 1,
      now: new Date("2026-08-12T00:00:00.000Z"),
      errorCode: "LOCAL_PACKAGE_CORE_NODES_INCOMPLETE",
    });
    expect(capped).toEqual({
      packageStatus: "attention_required",
      packageAttemptCount: MAX_AUTOMATIC_PACKAGE_ATTEMPTS,
      packageNextRetryAt: null,
      packageLastErrorCode: "LOCAL_PACKAGE_CORE_NODES_INCOMPLETE",
    });

    expect(
      nextKnowledgeBasePackageFailure({
        packageAttemptCount: 0,
        now: new Date("2026-08-12T00:00:00.000Z"),
        errorCode: "MATERIALIZED_BUILD_NOT_PUBLISHABLE",
      }),
    ).toEqual({
      packageStatus: "attention_required",
      packageAttemptCount: 1,
      packageNextRetryAt: null,
      packageLastErrorCode: "MATERIALIZED_BUILD_NOT_PUBLISHABLE",
    });
  });

  it("does not count a stale competing package CAS as work", () => {
    expect(knowledgeBasePackageSweepWriteApplied([{ affectedRows: 1 }])).toBe(
      true,
    );
    expect(knowledgeBasePackageSweepWriteApplied([{ affectedRows: 0 }])).toBe(
      false,
    );
    expect(knowledgeBasePackageSweepWriteApplied([])).toBe(false);
  });
});
