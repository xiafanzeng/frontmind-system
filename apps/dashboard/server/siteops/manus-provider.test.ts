import { afterEach, describe, expect, it, vi } from "vitest";
import JSZip from "jszip";
import { Readable } from "node:stream";
import { createHash } from "node:crypto";
import {
  canonicalJson,
  createVisualEvidenceV1,
} from "../../shared/siteops-workflow";
import {
  SITEOPS_MATERIALIZER_V2_1,
  SITEOPS_MATERIALIZER_V2_2,
  SITEOPS_MATERIALIZER_V2_3,
  SITEOPS_MATERIALIZER_V2_4,
  SITEOPS_WORKFLOW,
} from "../../shared/siteops";
import { referenceBlueprintForVisualCandidate } from "../../shared/siteops-design";
import { siteOperations } from "../../drizzle/schema";

import {
  briefWithoutBrandAssets,
  combinedTerminalTaskState,
  completedSiteBuildMessage,
  contentRepairPrompt,
  designRepairPrompt,
  designValidationFailure,
  handledWaitingResolution,
  hostOwnedEmptyRouteIds,
  createManusSiteOpsProviderHandler,
  frozenAssetDecisions,
  getSiteOpsSocialWorkflowReadiness,
  loadVerifiedSiteOpsSocialWorkflowPackage,
  loadVerifiedSiteOpsWorkflowPackage,
  materializeWithSingleHostRetry,
  classifySiteOpsMaterializationFailure,
  contentPatchMaterializationOverrides,
  messageAskUserWaiting,
  phaseTerminalTaskState,
  safePublicDocuments,
  resultFailure,
  selectedVisualPreviewCoordinates,
  structuredResultGrace,
  terminalTaskState,
  usesBuildPlanContractV4,
  usesHostOwnedContentDraft,
  visualPreviewAttachment,
} from "./manus-provider";
import {
  buildManusV2CreateTaskBody,
  buildManusV2SendMessageBody,
  ManusV2ApiError,
} from "../manus-v2-client";

const operation = {
  id: "10000000-0000-4000-8000-000000000001",
  projectId: "20000000-0000-4000-8000-000000000002",
  userId: 7,
  conversationTurnId: null,
  buildId: "30000000-0000-4000-8000-000000000003",
  kind: "site_build",
  status: "running",
  clientRequestId: "request-1",
  inputHash: "a".repeat(64),
  input: {
    credentialScope: "customer",
    buildId: "30000000-0000-4000-8000-000000000003",
    manusCredentialId: "40000000-0000-4000-8000-000000000004",
    manusCredentialVersion: 9,
    agentProfile: "frontmind-pro",
    feedback: "保持事实不变并调整页面表达。".repeat(200),
  },
  provider: "manus",
  providerOperationId: null,
  providerTaskId: null,
  leaseOwner: "lease",
  leaseExpiresAt: new Date(),
  attempt: 1,
  result: null,
  errorCode: null,
  errorMessage: null,
  startedAt: new Date(),
  completedAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
} as const;

afterEach(() => vi.restoreAllMocks());

describe("Manus SiteOps provider boundary", () => {
  it("maps resilient content-patch defaults to one public-safe delivery marker", () => {
    expect(
      contentPatchMaterializationOverrides({
        renderMode: "content_patch",
        warningCount: 2,
      }),
    ).toEqual({
      renderModeOverride: "content_patch",
      contentPatchUsesTrustedDefaults: true,
    });
    expect(
      contentPatchMaterializationOverrides({
        renderMode: "content_patch",
        warningCount: 0,
      }),
    ).toEqual({ renderModeOverride: "content_patch" });
    expect(
      contentPatchMaterializationOverrides({
        renderMode: "trusted_fallback",
        warningCount: 1,
      }),
    ).toEqual({
      forceTrustedFallback: {
        warningCode: "SITEOPS_CONTENT_PATCH_TRUSTED_FALLBACK",
      },
    });
  });

  it("keeps frozen 2.2 tasks on BuildContractV4 and PageContentWireV3", async () => {
    expect(
      usesBuildPlanContractV4(SITEOPS_MATERIALIZER_V2_2.frontMindVersion),
    ).toBe(true);
    expect(usesBuildPlanContractV4(SITEOPS_WORKFLOW.frontMindVersion)).toBe(
      true,
    );
    expect(
      usesBuildPlanContractV4(SITEOPS_MATERIALIZER_V2_1.frontMindVersion),
    ).toBe(false);

    const workflow = await JSZip.loadAsync(
      await loadVerifiedSiteOpsWorkflowPackage(SITEOPS_MATERIALIZER_V2_2),
      { checkCRC32: true },
    );
    const runtime = JSON.parse(
      await workflow.file("runtime-contract.json")!.async("string"),
    );
    expect(runtime).toMatchObject({
      adapterVersion: "2.2.0",
      providerWire: {
        phaseTwoCanonical: "PageContentSpecV2",
        phaseTwoOutputFilename: "frontmind-page-content-wire-v3.json",
      },
      aiTask: { phaseTwoOutput: "PageContentWireV3" },
      renderer: {
        kind: "react_static_v2",
        componentLibraryVersion: "2.2.0",
        materializerVersion: "2.2.0",
      },
      contentSystem: { buildContract: "BuildContractV4" },
    });
  });

  it("keeps historical 2.3/2.4 semantics and reserves content patches for 2.6", async () => {
    expect(
      usesHostOwnedContentDraft(SITEOPS_MATERIALIZER_V2_3.frontMindVersion),
    ).toBe(false);
    expect(
      usesHostOwnedContentDraft(SITEOPS_MATERIALIZER_V2_4.frontMindVersion),
    ).toBe(false);
    expect(usesHostOwnedContentDraft(SITEOPS_WORKFLOW.frontMindVersion)).toBe(
      true,
    );

    const workflow = await JSZip.loadAsync(
      await loadVerifiedSiteOpsWorkflowPackage(SITEOPS_MATERIALIZER_V2_3),
      { checkCRC32: true },
    );
    const runtime = JSON.parse(
      await workflow.file("runtime-contract.json")!.async("string"),
    );
    expect(runtime).toMatchObject({
      adapterVersion: "2.3.0",
      aiTask: {
        taskCount: 1,
        sameTaskForBothPhases: true,
        phaseOneOutput: "SiteDesignWireV3",
        phaseTwoOutput: "PageContentWireV3",
      },
      renderer: {
        componentLibraryVersion: "2.3.0",
        materializerVersion: "2.3.0",
      },
    });
  });

  it("keeps the provider reference and host realization as two exact V4 preview coordinates", () => {
    const candidateId = "60000000-0000-4000-8000-000000000006";
    const referenceLocalAssetId = "80000000-0000-4000-8000-000000000008";
    const realizationLocalAssetId = "81000000-0000-4000-8000-000000000008";
    const referenceSha256 = "a".repeat(64);
    const realizationSha256 = "b".repeat(64);
    const coordinates = selectedVisualPreviewCoordinates({
      bundle: {
        schemaVersion: 4,
        candidates: [
          {
            id: candidateId,
            previewLocalAssetId: referenceLocalAssetId,
            previewSha256: referenceSha256,
            realizationPreviewLocalAssetId: realizationLocalAssetId,
            realizationPreviewSha256: realizationSha256,
            referenceBlueprint: {
              referencePreviewLocalAssetId: referenceLocalAssetId,
              referencePreviewSha256: referenceSha256,
              previewLocalAssetId: realizationLocalAssetId,
              previewSha256: realizationSha256,
            },
          },
        ],
      } as never,
      candidateId,
      samplePreviewLocalAssetId: referenceLocalAssetId,
      evidencePreviewSha256: referenceSha256,
    });

    expect(coordinates).toEqual({
      referenceLocalAssetId,
      referenceSha256,
      realizationLocalAssetId,
      realizationSha256,
      hasIndependentRealization: true,
    });
    expect(() =>
      selectedVisualPreviewCoordinates({
        bundle: {
          schemaVersion: 4,
          candidates: [
            {
              id: candidateId,
              previewLocalAssetId: referenceLocalAssetId,
              previewSha256: referenceSha256,
              realizationPreviewLocalAssetId: realizationLocalAssetId,
              realizationPreviewSha256: realizationSha256,
              referenceBlueprint: {
                referencePreviewLocalAssetId: referenceLocalAssetId,
                referencePreviewSha256: referenceSha256,
                previewLocalAssetId: realizationLocalAssetId,
                previewSha256: "c".repeat(64),
              },
            },
          ],
        } as never,
        candidateId,
        samplePreviewLocalAssetId: referenceLocalAssetId,
        evidencePreviewSha256: referenceSha256,
      }),
    ).toThrow("视觉参考与可实现预览坐标不一致");
  });

  it("keeps customer-facing completion and content repair copy renderer-neutral", () => {
    const completion = completedSiteBuildMessage();
    const repair = contentRepairPrompt({
      repairAttempt: 2,
      outputFilename: "frontmind-page-content-wire-v2.json",
      repairReason: "EMPTY_TYPED_BLOCK_BODY",
    });

    expect(completion).toBe(
      "FrontMind 静态官网已完成构建和 QA，可以在私有预览中检查并批准。",
    );
    expect(completion).not.toMatch(/Astro/u);
    expect(repair).toContain("受信网站 QA");
    expect(repair).toContain("数据驱动");
    expect(repair).toContain("正式恢复副本");
    expect(repair).not.toMatch(/Astro/u);
  });

  it("uses one host-empty route policy and precise design repair reasons", () => {
    expect(
      hostOwnedEmptyRouteIds({
        routes: [{ id: "home" }, { id: "news" }],
        contentInventory: {
          entries: [{ kind: "service" }],
        },
      } as never),
    ).toEqual(["news"]);
    expect(
      hostOwnedEmptyRouteIds({
        routes: [{ id: "home" }, { id: "news" }],
        contentInventory: {
          entries: [{ kind: "company_news" }],
        },
      } as never),
    ).toEqual([]);
    const failure = designValidationFailure(
      new Error("SITEOPS_DESIGN_SLOT_ORDER_INVALID"),
    );
    expect(failure).toMatchObject({ reason: "SLOT_ORDER_INVALID" });
    expect(failure.signature).toMatch(/^[a-f0-9]{64}$/u);
    expect(
      designRepairPrompt({
        repairAttempt: 2,
        maxAttempts: 2,
        outputFilename: "frontmind-site-design-wire-v3.json",
        wireVersion: 3,
        repairReason: failure.reason,
        hostOwnedEmptyRouteIds: ["news"],
      }),
    ).toContain("第 2/2 次修复");
  });

  it("propagates an aborted worker signal instead of projecting a terminal build failure", async () => {
    const getDb = vi.fn();
    const handler = createManusSiteOpsProviderHandler({ getDb });
    const controller = new AbortController();
    controller.abort();

    await expect(
      handler({ operation: operation as never, signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(getDb).not.toHaveBeenCalled();
  });

  it("treats stopped as completion and waits five minutes for its structured result", () => {
    expect(terminalTaskState("stopped")).toEqual({
      completed: true,
      failed: false,
    });
    for (const status of [
      "completed",
      "complete",
      "finished",
      "done",
      "success",
    ]) {
      expect(terminalTaskState(status)).toEqual({
        completed: true,
        failed: false,
      });
    }
    for (const status of ["failed", "error", "cancelled", "canceled"]) {
      expect(terminalTaskState(status)).toEqual({
        completed: false,
        failed: true,
      });
    }
    const started = structuredResultGrace(
      { schemaVersion: 1, stage: "design_pending", taskId: "task-1" },
      true,
      1_000,
    );
    expect(started).toMatchObject({
      expired: false,
      state: { resultPendingSince: new Date(1_000).toISOString() },
    });
    expect(structuredResultGrace(started.state, true, 300_999).expired).toBe(
      false,
    );
    expect(structuredResultGrace(started.state, true, 301_000).expired).toBe(
      true,
    );
    const stoppedFromDetail = {
      schemaVersion: 2 as const,
      stage: "native_repair_pending" as const,
      taskId: "task-1",
      nativeRepairAttempt: 1,
      attempts: {
        extraction: 0,
        design: 0,
        content: 0,
        materialization: 0,
      },
      providerStoppedAt: new Date(1_000).toISOString(),
    };
    expect(
      structuredResultGrace(stoppedFromDetail, false, 300_999).expired,
    ).toBe(false);
    expect(
      structuredResultGrace(stoppedFromDetail, false, 301_000).expired,
    ).toBe(true);
    expect(combinedTerminalTaskState("running", "stopped")).toEqual({
      completed: true,
      failed: false,
    });
    expect(combinedTerminalTaskState("stopped", "running")).toEqual({
      completed: false,
      failed: false,
    });
    expect(combinedTerminalTaskState("stopped", "error")).toEqual({
      completed: false,
      failed: true,
    });
    expect(phaseTerminalTaskState("stopped", "stopped")).toEqual({
      completed: true,
      failed: false,
    });
    expect(phaseTerminalTaskState(null, "stopped")).toEqual({
      completed: false,
      failed: false,
    });
    const waitingState = {
      schemaVersion: 1 as const,
      stage: "repair_pending" as const,
      taskId: "task-1",
      repairKind: "design" as const,
      repairAttempt: 1,
      handledWaitingEventId: "waiting-1",
      handledWaitingAt: new Date(5_000).toISOString(),
    };
    expect(handledWaitingResolution(waitingState, "waiting-1", 5_001)).toBe(
      "pending",
    );
    expect(handledWaitingResolution(waitingState, "waiting-2", 5_001)).toBe(
      "new",
    );
    expect(handledWaitingResolution(waitingState, "waiting-1", 125_000)).toBe(
      "expired",
    );
  });

  it("allows only a provider question to enter the same-task repair path", () => {
    expect(
      messageAskUserWaiting({ eventType: "messageAskUser" } as never),
    ).toBe(true);
    expect(messageAskUserWaiting({ eventType: "deploy" } as never)).toBe(false);
  });

  it("maps an explicit task.create 400 to a known FrontMind rejection", () => {
    const result = resultFailure(
      new ManusV2ApiError("task.create", 400, "invalid_argument", false, false),
    );
    expect(result).toMatchObject({
      status: "failed",
      code: "FRONTMIND_BUILD_REQUEST_INVALID",
      result: { stage: "create_rejected" },
    });
    expect(JSON.stringify(result)).not.toMatch(/manus|invalid_argument/iu);
  });

  it("never sends official Logo identifiers through the Manus SiteBrief", () => {
    const promptBrief = briefWithoutBrandAssets({
      companyName: "星河智造",
      primaryLanguage: "zh-CN",
      contacts: [],
      offerings: ["设备服务"],
      audience: ["制造企业"],
      conversionGoal: "联系咨询",
      routes: [
        {
          id: "home",
          slug: "/",
          title: "首页",
          sourceDocumentIds: ["overview"],
        },
      ],
      verifiedFacts: [],
      publicAssetIds: ["secret-official-logo-id"],
      unknowns: [],
    });

    expect(promptBrief.publicAssetIds).toEqual([]);
    expect(JSON.stringify(promptBrief)).not.toContain(
      "secret-official-logo-id",
    );
  });

  it("passes customer-confirmed dashboard-core leaves but never inferred/evidence documents", () => {
    const documents = safePublicDocuments({
      documents: [
        {
          id: "1.1",
          path: "企业/简介.md",
          title: "企业简介",
          content: "客户已确认的企业事实",
          kind: "leaf",
          evidenceStatus: "needs_verification",
          customerVisible: true,
        },
        {
          id: "evidence-1",
          path: "证据/营业执照.txt",
          title: "营业执照",
          content: "敏感证据",
          kind: "evidence",
          evidenceStatus: "verified_first_party",
          customerVisible: true,
        },
        {
          id: "guess-1",
          path: "推断.md",
          title: "推断",
          content: "模型推断",
          kind: "leaf",
          evidenceStatus: "inferred",
          customerVisible: true,
        },
      ],
    } as never);

    expect(documents.map((item) => item.id)).toEqual(["1.1"]);
  });

  it("keeps every safe document and its complete content for lossless dossier splitting", () => {
    const content = "完整知识".repeat(6_000);
    const documents = safePublicDocuments({
      documents: Array.from({ length: 81 }, (_, index) => ({
        id: `doc-${index + 1}`,
        path: `doc-${index + 1}.md`,
        title: `资料 ${index + 1}`,
        content,
        kind: "leaf",
        evidenceStatus: "verified_first_party",
        customerVisible: true,
      })),
    } as never);

    expect(documents).toHaveLength(81);
    expect(documents[0]?.content).toBe(content);
  });

  it("publishes only the selected first-party logo and quarantines other assets", () => {
    const decisions = frozenAssetDecisions(
      {
        assets: [
          {
            id: "logo",
            key: "logo.png",
            path: "assets/logo.png",
            mimeType: "image/png",
            size: 10,
            sha256: "a".repeat(64),
            sourceKind: "official_logo_upload",
            ownership: "first_party",
          },
          {
            id: "license",
            key: "license.jpg",
            path: "assets/license.jpg",
            mimeType: "image/jpeg",
            size: 20,
            sha256: "b".repeat(64),
            sourceKind: "official_document",
            ownership: "unknown",
          },
        ],
      } as never,
      { publicAssetIds: ["logo"] } as never,
    );

    expect(decisions).toEqual([
      { id: "logo", sha256: "a".repeat(64), decision: "publish" },
      { id: "license", sha256: "b".repeat(64), decision: "quarantine" },
    ]);
  });

  it("publishes the first requested valid logo and omits duplicate bytes", () => {
    const duplicateSha = "a".repeat(64);
    const decisions = frozenAssetDecisions(
      {
        assets: [
          {
            id: "logo-first-in-archive",
            key: "logo-a.png",
            path: "assets/logo-a.png",
            sha256: duplicateSha,
            sourceKind: "official_logo_upload",
            ownership: "first_party",
          },
          {
            id: "logo-selected-first",
            key: "logo-b.png",
            path: "assets/logo-b.png",
            sha256: duplicateSha.toUpperCase(),
            sourceKind: "official_logo_upload",
            ownership: "first_party",
          },
          {
            id: "license",
            key: "license.jpg",
            path: "assets/license.jpg",
            sha256: "b".repeat(64),
            sourceKind: "official_document",
            ownership: "unknown",
          },
        ],
      } as never,
      {
        publicAssetIds: ["logo-selected-first", "logo-first-in-archive"],
      } as never,
    );

    expect(decisions).toEqual([
      {
        id: "logo-first-in-archive",
        sha256: duplicateSha,
        decision: "omit",
      },
      {
        id: "logo-selected-first",
        sha256: duplicateSha,
        decision: "publish",
      },
      { id: "license", sha256: "b".repeat(64), decision: "quarantine" },
    ]);
  });

  it("retries only one host-transient materialization without invoking content repair", async () => {
    const run = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(
        Object.assign(new Error("ECONNREFUSED"), {
          phase: "browser_qa",
        }),
      )
      .mockResolvedValueOnce("ok");
    const result = await materializeWithSingleHostRetry({
      run,
      signal: new AbortController().signal,
    });
    expect(result).toEqual({ value: "ok", localRetryCount: 1 });
    expect(run).toHaveBeenCalledTimes(2);

    const deterministic = classifySiteOpsMaterializationFailure(
      new Error("SITEOPS_SOURCE_QUARANTINED_ASSET_PRESENT"),
    );
    expect(deterministic).toMatchObject({
      phase: "asset_projection",
      retryClass: "host_deterministic",
    });
    const deterministicRun = vi.fn(async () => {
      throw deterministic;
    });
    await expect(
      materializeWithSingleHostRetry({
        run: deterministicRun,
        signal: new AbortController().signal,
      }),
    ).rejects.toBe(deterministic);
    expect(deterministicRun).toHaveBeenCalledTimes(1);
  });

  it("packages the hash-verified FrontMind 1.5 workflow with SKILL and runtime contract", async () => {
    const bytes = await loadVerifiedSiteOpsWorkflowPackage();
    const zip = await JSZip.loadAsync(bytes, { checkCRC32: true });

    expect(zip.file("SKILL.md")).not.toBeNull();
    expect(zip.file("runtime-contract.json")).not.toBeNull();
    expect(zip.file("MANIFEST.json")).not.toBeNull();
  });

  it("loads channel-specific brand-safe social workflows for runtime readiness", async () => {
    const [wechatBytes, xhsBytes, readiness] = await Promise.all([
      loadVerifiedSiteOpsSocialWorkflowPackage("wechat"),
      loadVerifiedSiteOpsSocialWorkflowPackage("xiaohongshu"),
      getSiteOpsSocialWorkflowReadiness(),
    ]);
    const [wechat, xhs] = await Promise.all([
      JSZip.loadAsync(wechatBytes, { checkCRC32: true }),
      JSZip.loadAsync(xhsBytes, { checkCRC32: true }),
    ]);
    expect(wechat.file("SKILL.md")).not.toBeNull();
    expect(wechat.file("runtime-contract.json")).not.toBeNull();
    expect(xhs.file("SKILL.md")).not.toBeNull();
    expect(xhs.file("runtime-contract.json")).not.toBeNull();
    expect(readiness).toMatchObject({
      ready: true,
      website: { version: SITEOPS_WORKFLOW.frontMindVersion },
      workflows: [
        { channel: "wechat", version: "1.0.0" },
        { channel: "xiaohongshu", version: "1.0.0" },
      ],
    });
  });

  it("attaches the frozen same-origin visual bytes to the first Manus task", async () => {
    const bytes = Buffer.from("normalized-png-preview", "utf8");
    const attachment = await visualPreviewAttachment(
      {
        row: {
          mimeType: "image/png",
          contentSha256: createHash("sha256").update(bytes).digest("hex"),
        },
        stored: {
          sizeBytes: bytes.length,
          createReadStream: () => Readable.from([bytes]),
        },
      } as never,
      "selected-visual.png",
    );

    expect(attachment).toEqual({
      filename: "selected-visual.png",
      mime_type: "image/png",
      file_data: `data:image/png;base64,${bytes.toString("base64")}`,
    });
  });

  it("keeps a historical 2.3 task on the immutable two-phase contract", async () => {
    const infoLog = vi
      .spyOn(console, "info")
      .mockImplementation(() => undefined);
    const errorLog = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const preview = Buffer.from("frozen-preview", "utf8");
    const previewHash = createHash("sha256").update(preview).digest("hex");
    const visualEvidence = createVisualEvidenceV1({
      evidenceKind: "catalog_metadata_preview_v1",
      providerItemKey: "n:143",
      metadataSha256: "c".repeat(64),
      providerResponseSha256: "d".repeat(64),
      previewSha256: previewHash,
      taxonomyDerivationVersion: "catalog-metadata-preview-v1",
    });
    const evidenceHash = visualEvidence.evidenceSha256;
    const supportOne = Buffer.from("frozen-support-one", "utf8");
    const supportTwo = Buffer.from("frozen-support-two", "utf8");
    const supportOneId = "81000000-0000-4000-8000-000000000008";
    const supportTwoId = "82000000-0000-4000-8000-000000000008";
    const supportOneHash = createHash("sha256")
      .update(supportOne)
      .digest("hex");
    const supportTwoHash = createHash("sha256")
      .update(supportTwo)
      .digest("hex");
    const supportOneEvidence = createVisualEvidenceV1({
      evidenceKind: "catalog_metadata_preview_v1",
      providerItemKey: "n:144",
      metadataSha256: "1".repeat(64),
      providerResponseSha256: "2".repeat(64),
      previewSha256: supportOneHash,
      taxonomyDerivationVersion: "catalog-metadata-preview-v1",
    });
    const supportTwoEvidence = createVisualEvidenceV1({
      evidenceKind: "catalog_metadata_preview_v1",
      providerItemKey: "n:145",
      metadataSha256: "3".repeat(64),
      providerResponseSha256: "4".repeat(64),
      previewSha256: supportTwoHash,
      taxonomyDerivationVersion: "catalog-metadata-preview-v1",
    });
    const designToken = `siteops-design:${operation.id}`;
    const designResult = {
      operationToken: designToken,
      schemaVersion: 3,
      layoutArchetype: "asymmetric",
      density: "balanced",
      surfaceStyle: "bordered",
      typeScale: "display",
      imageTreatment: "contained",
      motionLevel: "subtle",
      backgroundPaletteIndex: 2,
      textPaletteIndex: 0,
      accentPaletteIndex: 1,
      siteTitle: "星河智造",
      description: "经过知识来源核验的企业官网。",
      routeSlots: [{ routeId: "home", slotId: "proof", variant: "proof" }],
    };
    const context = {
      build: {
        id: operation.buildId,
        projectId: operation.projectId,
        userId: operation.userId,
        knowledgeSnapshotId: "50000000-0000-4000-8000-000000000005",
        knowledgeArchiveHash: "a".repeat(64),
        workflowVersion: SITEOPS_MATERIALIZER_V2_3.frontMindVersion,
        brief: {
          companyName: "星河智造",
          primaryLanguage: "zh-CN",
          contacts: [],
          offerings: ["设备服务"],
          audience: ["制造企业"],
          conversionGoal: "联系咨询",
          routes: [
            ["home", "/", "首页"],
            ["about", "/about", "关于我们"],
            ["products", "/products", "产品"],
            ["services", "/services", "服务"],
            ["solutions", "/solutions", "解决方案"],
            ["cases", "/cases", "案例"],
            ["faq", "/faq", "常见问题"],
            ["contact", "/contact", "联系我们"],
            ["news", "/news", "企业动态"],
          ].map(([id, slug, title]) => ({
            id,
            slug,
            title,
            sourceDocumentIds: ["overview"],
          })),
          verifiedFacts: Array.from({ length: 120 }, (_, index) => ({
            statement: `经过来源核验的企业事实 ${index + 1}`,
            sourceDocumentIds: ["overview"],
          })),
          publicAssetIds: [],
          unknowns: [],
        },
        selectionHash: "b".repeat(64),
        repairAttempts: 0,
        upstreamManusTaskId: null,
      },
      project: { id: operation.projectId },
      snapshot: {
        id: "50000000-0000-4000-8000-000000000005",
        archiveHash: "a".repeat(64),
        totalBytes: 1,
        sourceBuildId: null,
        sourceBuildRevision: null,
        assets: [],
        documents: Array.from({ length: 56 }, (_, index) => ({
          id: index === 0 ? "overview" : `source-${index + 1}`,
          path: index === 0 ? "overview.md" : `source-${index + 1}.md`,
          title: index === 0 ? "企业简介" : `企业资料 ${index + 1}`,
          content:
            index === 0
              ? "星河智造提供设备服务。"
              : `经过来源核验的企业资料 ${index + 1}。`.repeat(100),
          kind: "leaf" as const,
          evidenceStatus: "verified_first_party" as const,
          customerVisible: true,
        })),
      },
      sample: {
        id: "60000000-0000-4000-8000-000000000006",
        batchId: "70000000-0000-4000-8000-000000000007",
        previewLocalAssetId: "80000000-0000-4000-8000-000000000008",
        sourceMetadata: {
          providerItemKey: "n:143",
          visualEvidence,
          taxonomy: {
            role: "foundation",
            palette: ["#10212B", "#EF6C45", "#F5F2EA"],
            typography: [],
            layout: [],
            motion: [],
            accessibility: ["reduced-motion"],
          },
          score: 90,
          rationale: "视觉证据完整",
        },
      },
      batch: {
        selectionBundleLocalAssetId: "90000000-0000-4000-8000-000000000009",
        selectionBundleHash: "",
      },
    };
    const selectionBundle = {
      schemaVersion: 2,
      queryPlanHash: "f".repeat(64),
      searchTarget: 18,
      shortlistTarget: 12,
      displayTarget: 9,
      candidates: [
        {
          id: context.sample.id,
          label: "B",
          queryAxis: "foundation_split",
          providerItemKey: "n:143",
          title: "Split hero",
          description: "Enterprise split layout",
          author: "21st",
          sourceUrl: "https://21st.dev/community/components/split-hero",
          visualEvidence,
          previewLocalAssetId: context.sample.previewLocalAssetId,
          previewSha256: previewHash,
          taxonomy: context.sample.sourceMetadata.taxonomy,
          score: 90,
          rationale: "视觉证据完整",
        },
      ],
      supportingCandidates: [
        {
          id: "61000000-0000-4000-8000-000000000006",
          queryAxis: "section_proof_conversion",
          providerItemKey: "n:144",
          title: "Proof section",
          description: "Enterprise proof cards",
          author: "21st",
          sourceUrl: "https://21st.dev/community/components/proof",
          visualEvidence: supportOneEvidence,
          previewLocalAssetId: supportOneId,
          previewSha256: supportOneHash,
          taxonomy: {
            role: "section",
            palette: [],
            typography: [],
            layout: ["modular-grid"],
            motion: [],
            accessibility: ["reduced-motion"],
          },
          score: 85,
          rationale: "真实证明区参考",
        },
        {
          id: "62000000-0000-4000-8000-000000000006",
          queryAxis: "motion_accessible",
          providerItemKey: "n:145",
          title: "Accessible motion",
          description: "Reduced motion interaction",
          author: "21st",
          sourceUrl: "https://21st.dev/community/components/motion",
          visualEvidence: supportTwoEvidence,
          previewLocalAssetId: supportTwoId,
          previewSha256: supportTwoHash,
          taxonomy: {
            role: "motion",
            palette: [],
            typography: [],
            layout: [],
            motion: ["short-transition"],
            accessibility: ["reduced-motion"],
          },
          score: 80,
          rationale: "真实动效参考",
        },
      ],
      selectedCandidateId: null,
      delegated: false,
      degradedReasons: [],
    };
    const selectionBytes = Buffer.from(canonicalJson(selectionBundle), "utf8");
    context.batch.selectionBundleHash = createHash("sha256")
      .update(selectionBytes)
      .digest("hex");
    const referenceBlueprint = referenceBlueprintForVisualCandidate({
      candidateId: context.sample.id,
      providerItemKey: visualEvidence.providerItemKey,
      previewSha256: previewHash,
      title: "Split hero",
      sourceUrl: "https://21st.dev/community/components/split-hero",
      heroEligibility: { variant: "split_media" },
    });
    const buildOperation = {
      ...operation,
      input: { ...operation.input, referenceBlueprint },
    };
    const db = {
      select: () => {
        let selectedTable: unknown;
        const query: any = {};
        const rows = () => (selectedTable === siteOperations ? [] : [context]);
        query.from = (table: unknown) => {
          selectedTable = table;
          return query;
        };
        query.innerJoin = () => query;
        query.where = () => query;
        query.limit = () => query;
        query.for = async () => rows();
        query.then = (
          resolve: (value: unknown[]) => unknown,
          reject: (error: unknown) => unknown,
        ) => Promise.resolve(rows()).then(resolve, reject);
        return query;
      },
      update: () => ({
        set: () => ({ where: async () => [{ affectedRows: 1 }] }),
      }),
      transaction: async (callback: (tx: unknown) => unknown) => callback(db),
    };
    const createTask = vi.fn(async () => ({ taskId: "manus-task-1" }));
    const sendMessage = vi.fn(async () => undefined);
    let taskStatus = "running";
    const client = {
      createTask,
      sendMessage,
      findCreatedTask: vi.fn(),
      taskDetail: vi.fn(async () => ({ status: taskStatus })),
      listAllMessages: vi.fn(async () => [
        {
          id: "design-marker",
          type: "user_message",
          timestamp: 0,
          user_message: {
            content: `FRONTMIND_MANUS_V2_OPERATION_CONTRACT={"operationToken":"siteops-design:${operation.id}"}`,
          },
        },
        {
          id: "design-result",
          type: "structured_output_result",
          timestamp: 1,
          structured_output_result: { success: true, value: designResult },
        },
        {
          id: "design-stopped",
          type: "status_update",
          timestamp: 2,
          status_update: { agent_status: "stopped" },
        },
      ]),
    };
    const readArtifact = vi.fn(async (input: { localAssetId: string }) => {
      const isSelection =
        input.localAssetId === context.batch.selectionBundleLocalAssetId;
      const bytes = isSelection
        ? selectionBytes
        : input.localAssetId === supportOneId
          ? supportOne
          : input.localAssetId === supportTwoId
            ? supportTwo
            : preview;
      return {
        row: {
          id: input.localAssetId,
          scope: "managed_user",
          accountUserId: operation.userId,
          storageKey: `siteops:${operation.projectId}:fixture:${input.localAssetId}`,
          mimeType: isSelection ? "application/json" : "image/png",
          contentSha256: createHash("sha256").update(bytes).digest("hex"),
        },
        stored: {
          sizeBytes: bytes.length,
          createReadStream: () => Readable.from([bytes]),
        },
      };
    });
    const handler = createManusSiteOpsProviderHandler({
      getDb: async () => db as never,
      getCredential: async () =>
        ({
          id: operation.input.manusCredentialId,
          userId: operation.userId,
          version: operation.input.manusCredentialVersion,
          apiKey: "secret-key",
        }) as never,
      createClient: () => client as never,
      readSnapshotArchive: async () => Buffer.from("x"),
      readArtifact: readArtifact as never,
    });

    const created = await handler({
      operation: buildOperation as never,
      signal: new AbortController().signal,
    });
    expect(created).toMatchObject({
      status: "pending",
      providerTaskId: "manus-task-1",
      result: {
        schemaVersion: 2,
        stage: "design_pending",
        taskId: "manus-task-1",
        attempts: {
          extraction: 0,
          design: 0,
          content: 0,
          materialization: 0,
        },
      },
    });
    expect(createTask).toHaveBeenCalledTimes(1);
    expect(createTask.mock.calls[0]![0]).toMatchObject({
      agentProfile: "manus-1.6-max",
    });
    expect(createTask.mock.calls[0]![0].attachments).toHaveLength(5);
    expect(createTask.mock.calls[0]![0].attachments[2]).toMatchObject({
      filename: "selected-visual.png",
      mime_type: "image/png",
    });
    expect(
      createTask.mock.calls[0]![0].attachments.map(
        (attachment: { filename: string }) => attachment.filename,
      ),
    ).toEqual([
      `frontmind-react-static-company-site-workflow-${SITEOPS_MATERIALIZER_V2_3.frontMindVersion}.zip`,
      "frontmind-siteops-source-dossier-v1.json",
      "selected-visual.png",
      "support-visual-1.png",
      "support-visual-2.png",
    ]);
    expect(
      Array.from(createTask.mock.calls[0]![0].prompt).length,
    ).toBeLessThanOrEqual(3_000);
    expect(createTask.mock.calls[0]![0].prompt).not.toContain(
      "星河智造提供设备服务",
    );
    expect(createTask.mock.calls[0]![0].prompt).toContain("SiteDesignWireV3");
    expect(createTask.mock.calls[0]![0].prompt).toContain(
      "frontmind-site-design-wire-v3.json",
    );
    const createBody = buildManusV2CreateTaskBody(createTask.mock.calls[0]![0]);
    expect(createBody.message.content).toHaveLength(6);
    expect(JSON.stringify(createBody.structured_output_schema)).not.toMatch(
      /"(?:pattern|minimum|maximum|minItems|maxItems)"/u,
    );
    const dossierAttachment = createTask.mock.calls[0]![0].attachments[1];
    const dossier = JSON.parse(
      Buffer.from(
        dossierAttachment.file_data.split(",", 2)[1],
        "base64",
      ).toString("utf8"),
    );
    expect(dossier.visualEvidence.supportEvidenceSha256s).toEqual([
      supportOneEvidence.evidenceSha256,
      supportTwoEvidence.evidenceSha256,
    ]);
    expect(dossier.documents[0].content).toBe("星河智造提供设备服务。");
    expect(dossier.documents).toHaveLength(56);
    expect(dossier.brief.verifiedFacts).toHaveLength(120);
    expect(
      dossier.brief.routes.map((route: { id: string }) => route.id),
    ).toEqual([
      "home",
      "about",
      "products",
      "services",
      "solutions",
      "cases",
      "faq",
      "contact",
    ]);
    expect(
      JSON.stringify(createTask.mock.calls[0]![0].structuredOutputSchema),
    ).not.toContain('"news"');

    taskStatus = "stopped";
    client.listAllMessages.mockResolvedValueOnce([
      {
        id: "invalid-design-marker",
        type: "user_message",
        timestamp: 0,
        user_message: {
          content: `FRONTMIND_MANUS_V2_OPERATION_CONTRACT={"operationToken":"siteops-design:${operation.id}"}`,
        },
      },
      {
        id: "invalid-design-result",
        type: "structured_output_result",
        timestamp: 1,
        structured_output_result: {
          success: true,
          value: { ...designResult, siteTitle: "" },
        },
      },
      {
        id: "invalid-design-stopped",
        type: "status_update",
        timestamp: 2,
        status_update: { agent_status: "stopped" },
      },
    ] as never);
    const repairScheduled = await handler({
      operation: {
        ...buildOperation,
        providerTaskId: "manus-task-1",
        result: created.result,
      } as never,
      signal: new AbortController().signal,
    });
    expect(repairScheduled).toMatchObject({
      status: "pending",
      result: {
        schemaVersion: 2,
        stage: "repair_send_ready",
        repairKind: "design",
        repairCategory: "design",
        repairAttempt: 1,
        attempts: {
          extraction: 0,
          design: 1,
          content: 0,
          materialization: 0,
        },
        validation: {
          phase: "design",
          source: "structured",
          reason: "TEXT_LIMIT",
          repeatCount: 0,
        },
      },
    });
    const repairToken = `siteops-repair:${operation.id}:design:design:1`;
    client.listAllMessages.mockResolvedValueOnce([
      {
        id: "repeat-invalid-design-marker",
        type: "user_message",
        timestamp: 0,
        user_message: {
          content: `FRONTMIND_MANUS_V2_OPERATION_CONTRACT=${JSON.stringify({ operationToken: repairToken })}`,
        },
      },
      {
        id: "repeat-invalid-design-result",
        type: "structured_output_result",
        timestamp: 1,
        structured_output_result: {
          success: true,
          value: {
            ...designResult,
            operationToken: repairToken,
            siteTitle: "",
          },
        },
      },
      {
        id: "repeat-invalid-design-stopped",
        type: "status_update",
        timestamp: 2,
        status_update: { agent_status: "stopped" },
      },
    ] as never);
    const sendCountBeforeRepeat = sendMessage.mock.calls.length;
    const repeatedInvalid = await handler({
      operation: {
        ...buildOperation,
        providerTaskId: "manus-task-1",
        result: { ...repairScheduled.result, stage: "repair_pending" },
      } as never,
      signal: new AbortController().signal,
    });
    expect(repeatedInvalid).toMatchObject({
      status: "failed",
      code: "FRONTMIND_BUILD_OUTPUT_INVALID",
      result: { validation: { repeatCount: 1 } },
    });
    expect(sendMessage).toHaveBeenCalledTimes(sendCountBeforeRepeat);
    const designed = await handler({
      operation: {
        ...buildOperation,
        providerTaskId: "manus-task-1",
        result: created.result,
      } as never,
      signal: new AbortController().signal,
    });
    expect(designed).toMatchObject({
      status: "pending",
      result: { stage: "content_send_ready", taskId: "manus-task-1" },
    });
    expect(
      (
        designed.result as {
          design?: { designSpec: { routeCompositions: unknown[] } };
        }
      ).design?.designSpec.routeCompositions,
    ).toEqual(
      expect.arrayContaining([
        {
          routeId: "news",
          slots: [{ slotId: "news-empty", variant: "statement" }],
        },
      ]),
    );

    const continued = await handler({
      operation: {
        ...buildOperation,
        providerTaskId: "manus-task-1",
        result: designed.result,
      } as never,
      signal: new AbortController().signal,
    });
    expect(continued).toMatchObject({
      status: "pending",
      result: { stage: "content_pending", taskId: "manus-task-1" },
    });
    expect(createTask).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0]![0].taskId).toBe("manus-task-1");
    expect(sendMessage.mock.calls[0]![0].attachments).toEqual([
      expect.objectContaining({
        filename: "frontmind-build-plan-contract-v4.json",
        mime_type: "application/json",
      }),
      expect.objectContaining({
        filename: "frontmind-customer-feedback-v1.json",
        mime_type: "application/json",
      }),
    ]);
    expect(
      Array.from(sendMessage.mock.calls[0]![0].prompt).length,
    ).toBeLessThanOrEqual(3_000);
    expect(sendMessage.mock.calls[0]![0].prompt).toContain("PageContentWireV3");
    expect(sendMessage.mock.calls[0]![0].prompt).toContain(
      "frontmind-page-content-wire-v3.json",
    );
    expect(
      JSON.stringify(sendMessage.mock.calls[0]![0].structuredOutputSchema),
    ).not.toContain('"news"');
    const sendBody = buildManusV2SendMessageBody(sendMessage.mock.calls[0]![0]);
    expect(sendBody.task_id).toBe("manus-task-1");
    expect(sendBody.message.content).toHaveLength(3);
    expect(JSON.stringify(sendBody.structured_output_schema)).not.toMatch(
      /"(?:pattern|minimum|maximum|minItems|maxItems)"/u,
    );
    expect(
      readArtifact.mock.calls.filter(([input]) =>
        [
          context.sample.previewLocalAssetId,
          supportOneId,
          supportTwoId,
        ].includes(input.localAssetId),
      ),
    ).toHaveLength(3);

    const safeLogs = JSON.stringify([
      ...infoLog.mock.calls,
      ...errorLog.mock.calls,
    ]);
    expect(safeLogs).toContain("wire_resolution");
    expect(safeLogs).toContain("wire_normalized");
    expect(safeLogs).not.toContain("星河智造");
    expect(safeLogs).not.toContain("secret-key");
    expect(safeLogs).not.toContain("siteops-repair:");
    expect(safeLogs).not.toContain("files.example.test");
  });

  it("uses the immutable credential id and version frozen in the operation", async () => {
    const createClient = vi.fn();
    const getCredential = vi.fn(async () => ({
      id: operation.input.manusCredentialId,
      userId: operation.userId,
      version: 10,
      apiKey: "secret-key",
      fingerprint: "fingerprint",
      status: "active" as const,
      verifiedAt: new Date(),
      agentProfile: "frontmind-pro" as const,
      upstreamModel: "manus-1.6-max" as const,
    }));
    const handler = createManusSiteOpsProviderHandler({
      getDb: async () => ({}) as never,
      getCredential,
      createClient,
    });

    const result = await handler({
      // Social generation keeps the eager credential boundary. New 2.6 site
      // builds deliberately stage their trusted baseline before credential
      // lookup, so they need a complete build fixture instead of this narrow
      // credential-only database stub.
      operation: { ...operation, kind: "social_package" } as never,
      signal: new AbortController().signal,
    });

    expect(result).toMatchObject({
      status: "attention_required",
      code: "FRONTMIND_CUSTOMER_CREDENTIAL_VERSION_UNAVAILABLE",
    });
    expect(getCredential).toHaveBeenCalledWith(
      operation.userId,
      operation.input.manusCredentialId,
    );
    expect(createClient).not.toHaveBeenCalled();
  });

  it.each([
    "malformed-receipt",
    "missing-staging-task",
    "content-plan-mismatch",
  ] as const)(
    "fails closed before provider access for a raw %s source checkpoint",
    async (variant) => {
      const taskId = "native-task-1";
      const operationToken = `siteops-native-source:${operation.id}:0`;
      const receipt = {
        operationToken,
        baseSourceSha256: "b".repeat(64),
        archiveSha256:
          variant === "malformed-receipt" ? "invalid" : "c".repeat(64),
        fileCount: 3,
      };
      const rawResult = {
        schemaVersion: 2,
        stage: "native_source_pending",
        attempts: {
          extraction: 0,
          design: 0,
          content: 0,
          materialization: 0,
        },
        taskId,
        nativeRepairAttempt: 0,
        ...(variant === "content-plan-mismatch"
          ? { contentPlanSha256: "d".repeat(64) }
          : {}),
        buildPhase: "compiling",
        buildCheckpoint: "archive_validated",
        nativeSourceStaging: {
          assetId: "50000000-0000-4000-8000-000000000005",
          sha256: "c".repeat(64),
          bytes: 128,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          ...(variant === "missing-staging-task" ? {} : { taskId }),
          repairAttempt: 0,
          receipt,
        },
      };
      const getCredential = vi.fn();
      const createClient = vi.fn();
      const handler = createManusSiteOpsProviderHandler({
        getDb: async () => ({}) as never,
        getCredential: getCredential as never,
        createClient,
      });

      const result = await handler({
        operation: {
          ...operation,
          providerTaskId: taskId,
          result: rawResult,
        } as never,
        signal: new AbortController().signal,
      });

      expect(result).toMatchObject({
        status: "attention_required",
        code: "FRONTMIND_BUILD_STAGED_SOURCE_IDENTITY_CONFLICT",
        providerTaskId: taskId,
        result: rawResult,
      });
      expect(getCredential).not.toHaveBeenCalled();
      expect(createClient).not.toHaveBeenCalled();
    },
  );

  it("fails closed before any provider request when the frozen key was deleted", async () => {
    const createClient = vi.fn();
    const handler = createManusSiteOpsProviderHandler({
      getDb: async () => ({}) as never,
      getCredential: async () => null,
      createClient,
    });

    const result = await handler({
      operation: { ...operation, kind: "social_package" } as never,
      signal: new AbortController().signal,
    });

    expect(result.status).toBe("attention_required");
    expect(createClient).not.toHaveBeenCalled();
  });
});
