import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { SITEOPS_MATERIALIZER_V2_4, type SiteBrief } from "./siteops";
import {
  referenceBlueprintV4ForFamily,
  siteDesignResultV2Schema,
} from "./siteops-design";
import { createHostOwnedSiteDesignResultV2 } from "./siteops-host-design";

const brief: SiteBrief = {
  companyName: "可信企业",
  primaryLanguage: "zh-CN",
  contacts: [],
  offerings: ["可信服务"],
  audience: ["企业客户"],
  conversionGoal: "联系企业",
  contentInventory: {
    schemaVersion: 1,
    source: "frozen_knowledge_snapshot",
    entries: [],
  },
  routes: [
    { id: "home", slug: "/", title: "首页", sourceDocumentIds: ["doc-1"] },
    {
      id: "services",
      slug: "/services",
      title: "服务",
      sourceDocumentIds: ["doc-1"],
    },
    { id: "news", slug: "/news", title: "企业动态", sourceDocumentIds: [] },
  ],
  verifiedFacts: [
    { statement: "企业介绍来自冻结资料。", sourceDocumentIds: ["doc-1"] },
  ],
  publicAssetIds: [],
  unknowns: [],
};

const blueprint = referenceBlueprintV4ForFamily({
  candidateId: "10000000-0000-4000-8000-000000000001",
  providerItemKey: "s:trusted-reference",
  referencePreviewLocalAssetId: "20000000-0000-4000-8000-000000000002",
  referencePreviewSha256: "1".repeat(64),
  realizationPreviewLocalAssetId: "30000000-0000-4000-8000-000000000003",
  realizationPreviewSha256: "2".repeat(64),
  heroFamily: "split_media",
  inspirationEvidenceId: "3".repeat(64),
  inspirationTaxonomy: {
    role: "foundation",
    palette: [],
    typography: [],
    layout: ["split-media-layout"],
    motion: [],
    accessibility: ["reduced-motion"],
  },
});

const taxonomy = {
  role: "foundation" as const,
  palette: ["#ffffff", "#111111", "#2457ff"],
  typography: [],
  layout: [],
  motion: [],
  accessibility: [],
};

describe("host-owned workflow 2.4 design", () => {
  it("freezes a self-consistent manifest and every packaged byte", async () => {
    const root = path.resolve(
      process.cwd(),
      "private-workflows/react-static-company-site-workflow-v2.4.0",
    );
    const manifestBytes = await readFile(path.join(root, "MANIFEST.json"));
    const manifest = JSON.parse(manifestBytes.toString("utf8")) as {
      version: string;
      host: {
        starterSha256: string;
        componentLibraryVersion: string;
        materializerVersion: string;
        materializerSha256: string;
      };
      files: Array<{ path: string; bytes: number; sha256: string }>;
    };
    const digest = (bytes: Buffer) =>
      createHash("sha256").update(bytes).digest("hex");

    expect(digest(manifestBytes)).toBe(
      SITEOPS_MATERIALIZER_V2_4.runtimeManifestSha256,
    );
    expect(manifest).toMatchObject({
      version: SITEOPS_MATERIALIZER_V2_4.frontMindVersion,
      host: {
        starterSha256: SITEOPS_MATERIALIZER_V2_4.starterSha256,
        componentLibraryVersion:
          SITEOPS_MATERIALIZER_V2_4.componentLibraryVersion,
        materializerVersion: SITEOPS_MATERIALIZER_V2_4.materializerVersion,
        materializerSha256: SITEOPS_MATERIALIZER_V2_4.materializerSha256,
      },
    });
    for (const entry of manifest.files) {
      const bytes = await readFile(path.join(root, entry.path));
      expect(bytes.byteLength, entry.path).toBe(entry.bytes);
      expect(digest(bytes), entry.path).toBe(entry.sha256);
    }
  });

  it("creates a complete deterministic design without provider coordinates", () => {
    const input = {
      operationToken: "siteops-content:token",
      brief,
      referenceBlueprint: blueprint,
      taxonomy,
    };
    const first = createHostOwnedSiteDesignResultV2(input);
    const second = createHostOwnedSiteDesignResultV2(input);

    expect(first).toEqual(second);
    expect(siteDesignResultV2Schema.parse(first)).toEqual(first);
    expect(first.designSpec.layoutArchetype).toBe("split");
    expect(
      first.designSpec.routeCompositions.map((route) => route.routeId),
    ).toEqual(["home", "services", "news"]);
    expect(first.designSpec.routeCompositions[0]?.slots).toContainEqual({
      slotId: "offerings",
      variant: "cards",
    });
    expect(first.designSpec.routeCompositions[2]?.slots).toEqual([
      { slotId: "news-empty", variant: "statement" },
    ]);
  });

  it("keeps palette coordinates valid when legacy taxonomy has no colours", () => {
    const design = createHostOwnedSiteDesignResultV2({
      operationToken: "siteops-content:token",
      brief,
      referenceBlueprint: blueprint,
      taxonomy: { ...taxonomy, palette: [] },
    });
    expect(design.designSpec.colorRoles).toEqual({
      backgroundPaletteIndex: 0,
      textPaletteIndex: 0,
      accentPaletteIndex: 0,
    });
  });
});
