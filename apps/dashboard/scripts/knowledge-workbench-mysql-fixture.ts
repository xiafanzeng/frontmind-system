import { createHash, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import JSZip from "jszip";
import sharp from "sharp";
import {
  knowledgeBaseBuilds,
  knowledgeBaseBuildNodes,
  knowledgeBaseWorkingSets,
} from "../drizzle/schema";
import { validateKnowledgeBaseWorkingSetArchive } from "../server/knowledge-base-materialized-contract";
import { persistKnowledgeBaseBuildSource } from "../server/knowledge-base-local-source-store";

/** A genuine v5 archive + SQL projection; acceptance itself is never mocked. */
export async function materializeMysqlWorkbenchDraft(
  executor: any,
  buildId: string,
  contentVersion = 1,
) {
  const [build] = await executor
    .select()
    .from(knowledgeBaseBuilds)
    .where(eq(knowledgeBaseBuilds.id, buildId));
  const sha = (value: string | Buffer) =>
    createHash("sha256").update(value).digest("hex");
  const zip = new JSZip();
  const leaves = Array.from({ length: 30 }, (_, ordinal) => {
    const title = `节点 ${ordinal + 1}`;
    const contentPath = `nodes/${String(ordinal + 1).padStart(4, "0")}.md`;
    const content = `# ${title}\n\n完整正文 ${ordinal + 1}，工作稿版本 ${contentVersion}`;
    zip.file(contentPath, content, { createFolders: false });
    return {
      leafId: `1.${ordinal + 1}`,
      branchId: "identity",
      branchTitle: "企业身份",
      title,
      ordinal,
      contentPath,
      contentSha256: sha(content),
      evidencePaths: ordinal === 0 ? ["evidence/source.md"] : [],
      assetIds: ordinal === 0 ? ["managed-product-image"] : [],
    };
  });
  const researchCoverage = {
    officialPages: { discovered: 12, attempted: 12, succeeded: 12, failed: 0 },
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
  };
  const managedImage = await sharp({
    create: {
      width: 2,
      height: 2,
      channels: 4,
      background: { r: 120, g: 30, b: 20, alpha: 1 },
    },
  })
    .png()
    .toBuffer();
  zip.file("assets/product.png", managedImage, { createFolders: false });
  const evidence = "数据库验收使用的企业来源资料";
  zip.file("evidence/source.md", evidence, { createFolders: false });
  const manifest = {
    kind: "frontmind.kb-working-set",
    schemaVersion: 1,
    operationId: randomUUID(),
    buildId,
    generation: build.generation,
    contentVersion,
    skill: {
      name: build.skillName,
      version: build.skillVersion,
      contentHash: build.skillContentHash,
    },
    treePolicyVersion: 2,
    company: { name: build.companyName, website: build.companyWebsite },
    researchCoverage,
    branches: [{ branchId: "identity", title: "企业身份", ordinal: 0 }],
    leaves,
    evidenceLedger: [
      {
        path: "evidence/source.md",
        sha256: sha(evidence),
        leafId: "1.1",
        sourceUrl: "https://acceptance.invalid/source",
        retrievedAt: null,
      },
    ],
    assets: [
      {
        assetId: "managed-product-image",
        path: "assets/product.png",
        sha256: sha(managedImage),
        mimeType: "image/png",
        bytes: managedImage.length,
        width: 2,
        height: 2,
        provenance: { kind: "official-document", page: 1 },
        documentIds: ["1.1"],
      },
    ],
    logo: { status: "missing", assetId: null },
    counts: { leaves: leaves.length, evidenceFiles: 1, assets: 1 },
  };
  zip.file("BUNDLE.json", JSON.stringify(manifest), { createFolders: false });
  const bytes = await zip.generateAsync({
    type: "nodebuffer",
    platform: "UNIX",
  });
  const validated = await validateKnowledgeBaseWorkingSetArchive(bytes, {
    buildId,
    generation: build.generation,
    contentVersion,
    skillContentHash: build.skillContentHash,
    companyName: build.companyName,
  });
  const source = await persistKnowledgeBaseBuildSource({
    userId: build.userId,
    buildId,
    generation: build.generation,
    bytes: validated.archiveBytes,
  });
  const workingSetId = randomUUID();
  await executor.transaction(async (tx: any) => {
    await tx
      .update(knowledgeBaseWorkingSets)
      .set({ status: "superseded" })
      .where(eq(knowledgeBaseWorkingSets.buildId, buildId));
    await tx.insert(knowledgeBaseWorkingSets).values({
      id: workingSetId,
      buildId,
      generation: build.generation,
      contentVersion,
      status: "active",
      storageKey: source.storageKey,
      sizeBytes: source.sizeBytes,
      packageSha256: validated.packageSha256,
      manifestSha256: validated.manifestSha256,
      manifest: validated.manifest,
      activatedAt: new Date(),
    });
    await tx
      .delete(knowledgeBaseBuildNodes)
      .where(eq(knowledgeBaseBuildNodes.buildId, buildId));
    await tx.insert(knowledgeBaseBuildNodes).values(
      leaves.map((leaf) => ({
        id: randomUUID(),
        buildId,
        leafId: leaf.leafId,
        branchId: leaf.branchId,
        branchTitle: leaf.branchTitle,
        title: leaf.title,
        ordinal: leaf.ordinal,
        contentVersion,
        contentSha256: leaf.contentSha256,
        contentMarkdown: validated.files
          .get(leaf.contentPath)!
          .toString("utf8"),
        status: contentVersion > 1 ? "needs_verification" : "pending",
      })),
    );
    await tx
      .update(knowledgeBaseBuilds)
      .set({
        executionMode: "materialized_bundle_v1",
        providerProtocol: "manus_v2",
        activeWorkingSetId: workingSetId,
        contentVersion,
        totalNodeCount: leaves.length,
        treePolicyVersion: 2,
        initialResearchCoverage: researchCoverage,
        status: "confirming",
        activeTurnId: null,
        awaitingResponseSince: null,
        confirmedCount: 0,
        revision: build.revision + (contentVersion > 1 ? 1 : 0),
        stateEpoch: build.stateEpoch + 1,
      })
      .where(eq(knowledgeBaseBuilds.id, buildId));
  });
  const [current] = await executor
    .select()
    .from(knowledgeBaseBuilds)
    .where(eq(knowledgeBaseBuilds.id, buildId));
  return {
    conversationId: current.conversationId,
    clientRequestId: randomUUID(),
    expectedGeneration: current.generation,
    expectedRevision: current.revision,
    expectedStateEpoch: current.stateEpoch,
    expectedContentVersion: contentVersion,
    expectedResetRevision: 0,
  };
}
