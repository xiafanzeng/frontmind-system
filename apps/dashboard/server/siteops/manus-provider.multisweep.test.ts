import { createHash } from "node:crypto";
import { Readable } from "node:stream";

import JSZip from "jszip";
import { describe, expect, it, vi } from "vitest";

import {
  canonicalJson,
  createVisualEvidenceV1,
} from "../../shared/siteops-workflow";
import {
  SITEOPS_MATERIALIZER_V2_5,
  SITEOPS_WORKFLOW,
  visualSelectionBundleV5Schema,
} from "../../shared/siteops";
import {
  FRONTMIND_VISUAL_FAMILIES_V3,
  referenceBlueprintV4ForFamily,
} from "../../shared/siteops-design";

const remotePreview = vi.hoisted(() => ({
  fetchPinnedPublicHttps: vi.fn(),
}));

vi.mock("./remote-preview", () => ({
  fetchPinnedPublicHttps: remotePreview.fetchPinnedPublicHttps,
}));

import {
  NATIVE_REJECTED_CANDIDATE_RECONCILIATION_MS,
  createNativeRejectedCandidateV1,
  createManusSiteOpsProviderHandler,
  nativeSourceAttachmentTransport,
  nativeSourceSystemPromptForWorkflow,
  nativeTemplateCoordinateDirective,
} from "./manus-provider";
import { siteOpsArtifactIdForIdempotency } from "./artifact-store";
import { SiteOpsMaterializationError } from "./materialization-error";
import {
  NATIVE_RUNTIME_CONTRACT_FILENAME,
  NATIVE_RUNTIME_CONTRACT_V1,
  NATIVE_RUNTIME_CONTRACT_V1_SHA256,
  NATIVE_RUNTIME_EXECUTION_SHELL_FILENAME,
  NATIVE_RUNTIME_EXECUTION_SHELL_V1,
  NATIVE_RUNTIME_EXECUTION_SHELL_V1_SHA256,
  NATIVE_RUNTIME_ROUTE_MODULE,
  NATIVE_SOURCE_PREFLIGHT_V2_FILENAME,
  NATIVE_SOURCE_PREFLIGHT_V2_SHA256,
  NATIVE_SOURCE_PREFLIGHT_V2_VERSION,
} from "./native-react-source";
import {
  createNativeSourceArchive,
  createVisualSelectionBundleV5Artifact,
  normalizeTwentyFirstNativeSource,
  SITEOPS_NATIVE_TEMPLATE_WORKFLOW_VERSION,
  SITEOPS_NATIVE_VISUAL_WORKFLOW_VERSION,
} from "./native-visual-source";

const sha256 = (value: Buffer | string) =>
  createHash("sha256").update(value).digest("hex");

describe("native Template coordinates", () => {
  it("binds shared-repository Hirael templates to distinct canonical Manus coordinates", () => {
    const sharedArchiveSha256 = sha256("shared-hirael-repository");
    const selection = (slug: string, sourceSubdirectory: string) =>
      ({
        bundle: { schemaVersion: 6 },
        candidate: { sourceFormat: "provider_archive_v1" },
        manifest: {
          sourceFormat: "provider_archive_v1",
          providerTemplateId: `hirael/${slug}`,
          providerSlug: slug,
          providerVersion: "0123456789abcdef0123456789abcdef01234567",
          sourceSubdirectory,
          framework: "next_static",
          entrypoint: `${sourceSubdirectory}/app/page.tsx`,
          providerArchiveSha256: sharedArchiveSha256,
          sourceTreeSha256: sha256(`hirael:${slug}:${sourceSubdirectory}`),
        },
      }) as never;

    const commerce = nativeTemplateCoordinateDirective(
      selection("hirael-commerce", "registry/templates/commerce"),
    );
    const studio = nativeTemplateCoordinateDirective(
      selection("hirael-studio", "registry/templates/studio"),
    );
    expect(commerce).not.toBeNull();
    expect(studio).not.toBeNull();

    const decode = (directive: NonNullable<typeof commerce>) => {
      const encoded = directive.attachment.file_data.split(",", 2)[1]!;
      const text = Buffer.from(encoded, "base64").toString("utf8");
      expect(text.endsWith("\n")).toBe(true);
      return { text, value: JSON.parse(text) as Record<string, unknown> };
    };
    const commerceCoordinate = decode(commerce!);
    const studioCoordinate = decode(studio!);
    expect(commerceCoordinate.value).toMatchObject({
      schemaVersion: 1,
      sourceFormat: "provider_archive_v1",
      providerSlug: "hirael-commerce",
      sourceSubdirectory: "registry/templates/commerce",
      entrypoint: "registry/templates/commerce/app/page.tsx",
      providerArchiveSha256: sharedArchiveSha256,
    });
    expect(studioCoordinate.value).toMatchObject({
      providerSlug: "hirael-studio",
      sourceSubdirectory: "registry/templates/studio",
      entrypoint: "registry/templates/studio/app/page.tsx",
      providerArchiveSha256: sharedArchiveSha256,
    });
    expect(commerceCoordinate.text).not.toBe(studioCoordinate.text);
    expect(commerce!.promptInstruction).toContain(
      "必须只使用其中指定的 providerSlug、sourceSubdirectory 和 entrypoint",
    );
    expect(commerce!.promptInstruction).toContain("其他模板");
  });

  it("does not attach a Template coordinate for historical normalized sources", () => {
    expect(
      nativeTemplateCoordinateDirective({
        bundle: { schemaVersion: 5 },
        candidate: { sourceFormat: "normalized_v1" },
      } as never),
    ).toBeNull();
  });

  it("binds a normalized V6 Template to its exact compiled source coordinates", () => {
    const sourceArchiveSha256 = sha256("normalized-template-archive");
    const sourceTreeSha256 = sha256("normalized-template-tree");
    const directive = nativeTemplateCoordinateDirective({
      bundle: { schemaVersion: 6 },
      candidate: {
        sourceFormat: "normalized_v1",
        providerTemplateId: "twenty-first/template-one",
        providerSlug: "template-one",
        providerVersion: "commit-one",
        sourceDirectory: "source",
        framework: "vite_react",
        entrypoint: "src/App.tsx",
        sourceArchiveSha256,
        sourceTreeSha256,
      },
      manifest: {
        providerItemKey: "t:twenty-first/template-one:template-one",
        providerVersion: "commit-one",
        entrypoint: "src/App.tsx",
        sourceTreeSha256,
      },
    } as never);
    expect(directive).not.toBeNull();
    const encoded = directive!.attachment.file_data.split(",", 2)[1]!;
    expect(
      JSON.parse(Buffer.from(encoded, "base64").toString("utf8")),
    ).toMatchObject({
      schemaVersion: 1,
      sourceFormat: "normalized_v1",
      providerSlug: "template-one",
      sourceDirectory: "source",
      entrypoint: "src/App.tsx",
      sourceArchiveSha256,
      sourceTreeSha256,
    });
    expect(directive!.promptInstruction).toContain("production build 验证");
  });

  it("uses inline bytes through 20 MiB and provider file IDs above it", () => {
    expect(nativeSourceAttachmentTransport(20 * 1024 * 1024)).toBe("inline");
    expect(nativeSourceAttachmentTransport(20 * 1024 * 1024 + 1)).toBe(
      "provider_file",
    );
  });

  it("uses the 2.7 adaptation prompt without changing historical 2.5 instructions", () => {
    expect(
      nativeSourceSystemPromptForWorkflow(
        SITEOPS_NATIVE_TEMPLATE_WORKFLOW_VERSION,
      ),
    ).toContain("页面目的 × 用户问题 × 企业事实 × CTA");
    expect(
      nativeSourceSystemPromptForWorkflow(
        SITEOPS_NATIVE_TEMPLATE_WORKFLOW_VERSION,
      ),
    ).toContain("不得把模板改造成通用卡片站");
    expect(
      nativeSourceSystemPromptForWorkflow(
        SITEOPS_NATIVE_VISUAL_WORKFLOW_VERSION,
      ),
    ).toContain("不是视觉设计师");
  });
});

function operationWithState(
  operation: typeof baseOperation,
  providerTaskId: string | null,
  result: unknown,
) {
  return {
    ...operation,
    providerTaskId,
    result,
  };
}

const baseOperation = {
  id: "10000000-0000-4000-8000-000000000001",
  projectId: "20000000-0000-4000-8000-000000000002",
  userId: 7,
  conversationTurnId: null,
  buildId: "30000000-0000-4000-8000-000000000003",
  kind: "site_build",
  status: "running",
  clientRequestId: "request-multisweep",
  inputHash: "a".repeat(64),
  input: {
    credentialScope: "customer",
    buildId: "30000000-0000-4000-8000-000000000003",
    manusCredentialId: "40000000-0000-4000-8000-000000000004",
    manusCredentialVersion: 9,
    agentProfile: "frontmind-base",
  },
  provider: "manus",
  providerOperationId: null,
  providerTaskId: null,
  leaseOwner: "lease-multisweep",
  leaseExpiresAt: new Date(Date.now() + 12 * 60_000),
  attempt: 1,
  result: null,
  errorCode: null,
  errorMessage: null,
  startedAt: new Date(),
  completedAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
} as const;

function operationMarker(operationToken: string, timestamp: number) {
  return {
    id: `marker-${timestamp}`,
    type: "user_message",
    timestamp,
    user_message: {
      content: `继续执行。\nFRONTMIND_MANUS_V2_OPERATION_CONTRACT=${JSON.stringify({ operationToken })}`,
    },
  };
}

describe("SiteOps personal-key build multi-sweep integration", () => {
  it("binds a deterministic 2.6 baseline before the patch task and keeps running prose on GET-only reconciliation", async () => {
    const preview = Buffer.from("frozen-hero-preview", "utf8");
    const realizationPreview = Buffer.from(
      "frozen-host-realization-preview",
      "utf8",
    );
    const previewSha256 = sha256(preview);
    const realizationPreviewSha256 = sha256(realizationPreview);
    const visualEvidence = createVisualEvidenceV1({
      evidenceKind: "catalog_metadata_preview_v1",
      providerItemKey: "n:143",
      metadataSha256: "c".repeat(64),
      providerResponseSha256: "d".repeat(64),
      previewSha256,
      taxonomyDerivationVersion: "catalog-metadata-preview-v1",
    });
    const referenceBlueprint = referenceBlueprintV4ForFamily({
      candidateId: "60000000-0000-4000-8000-000000000006",
      providerItemKey: visualEvidence.providerItemKey,
      referencePreviewLocalAssetId: "80000000-0000-4000-8000-000000000008",
      referencePreviewSha256: previewSha256,
      realizationPreviewLocalAssetId: "81000000-0000-4000-8000-000000000008",
      realizationPreviewSha256,
      heroFamily: "split_media",
      inspirationEvidenceId: visualEvidence.evidenceSha256,
      inspirationTaxonomy: {
        role: "foundation",
        palette: [],
        typography: [],
        layout: ["split-layout"],
        motion: [],
        accessibility: ["reduced-motion"],
      },
    });
    const buildOperation = {
      ...baseOperation,
      input: { ...baseOperation.input, referenceBlueprint },
    } as const;

    const context = {
      build: {
        id: baseOperation.buildId,
        projectId: baseOperation.projectId,
        userId: baseOperation.userId,
        knowledgeSnapshotId: "50000000-0000-4000-8000-000000000005",
        knowledgeArchiveHash: "a".repeat(64),
        workflowUpstreamVersion: SITEOPS_WORKFLOW.upstreamVersion,
        workflowUpstreamHash: SITEOPS_WORKFLOW.upstreamSha256,
        workflowVersion: SITEOPS_WORKFLOW.frontMindVersion,
        workflowPackageHash: SITEOPS_WORKFLOW.runtimeManifestSha256,
        starterVersion: SITEOPS_WORKFLOW.starterVersion,
        brief: {
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
          verifiedFacts: [
            {
              statement: "星河智造提供设备服务。",
              sourceDocumentIds: ["overview"],
            },
          ],
          publicAssetIds: [],
          unknowns: [],
        },
        selectionHash: "e".repeat(64),
        repairAttempts: 0,
        upstreamManusTaskId: null as string | null,
        status: "queued",
      },
      project: { id: baseOperation.projectId },
      snapshot: {
        id: "50000000-0000-4000-8000-000000000005",
        userId: baseOperation.userId,
        archiveHash: "a".repeat(64),
        totalBytes: 1,
        sourceBuildId: null,
        sourceBuildRevision: null,
        assets: [],
        documents: [
          {
            id: "overview",
            path: "overview.md",
            title: "企业简介",
            content: "星河智造提供设备服务。",
            kind: "leaf" as const,
            evidenceStatus: "verified_first_party" as const,
            customerVisible: true,
          },
        ],
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
            layout: ["split-layout"],
            motion: [],
            accessibility: ["reduced-motion"],
          },
          score: 90,
          rationale: "合格 Hero 视觉证据",
        },
      },
      batch: {
        selectionBundleLocalAssetId: "90000000-0000-4000-8000-000000000009",
        selectionBundleHash: "",
      },
    };
    const perceptualHashes = [
      "0000000000000000",
      "ffffffffffffffff",
      "aaaaaaaaaaaaaaaa",
      "5555555555555555",
      "cccccccccccccccc",
      "3333333333333333",
      "f0f0f0f0f0f0f0f0",
      "0f0f0f0f0f0f0f0f",
      "9696969696969696",
    ] as const;
    const families = [
      "split_media",
      ...FRONTMIND_VISUAL_FAMILIES_V3.filter(
        (family) => family !== "split_media",
      ),
    ] as const;
    const selectionCandidates = families.map((heroFamily, index) => {
      const selected = index === 0;
      const suffix = String(index + 10).padStart(12, "0");
      const candidateId = selected
        ? context.sample.id
        : `60000000-0000-4000-8000-${suffix}`;
      const providerItemKey = selected ? "n:143" : `n:${200 + index}`;
      const referencePreviewLocalAssetId = selected
        ? context.sample.previewLocalAssetId
        : `80000000-0000-4000-8000-${suffix}`;
      const realizationPreviewLocalAssetId = selected
        ? referenceBlueprint.previewLocalAssetId
        : `81000000-0000-4000-8000-${suffix}`;
      const referenceSha = selected
        ? previewSha256
        : sha256(`provider-reference-${index}`);
      const realizationSha = selected
        ? realizationPreviewSha256
        : sha256(`host-realization-${index}`);
      const candidateEvidence = selected
        ? visualEvidence
        : createVisualEvidenceV1({
            evidenceKind: "catalog_metadata_preview_v1",
            providerItemKey,
            metadataSha256: sha256(`metadata-${index}`),
            providerResponseSha256: sha256(`response-${index}`),
            previewSha256: referenceSha,
            taxonomyDerivationVersion: "catalog-metadata-preview-v1",
          });
      const candidateTaxonomy = {
        role: "foundation" as const,
        palette: [] as string[],
        typography: [] as string[],
        layout: [`${heroFamily}-layout`],
        motion: [] as string[],
        accessibility: ["reduced-motion"],
      };
      const blueprint = selected
        ? referenceBlueprint
        : referenceBlueprintV4ForFamily({
            candidateId,
            providerItemKey,
            referencePreviewLocalAssetId,
            referencePreviewSha256: referenceSha,
            realizationPreviewLocalAssetId,
            realizationPreviewSha256: realizationSha,
            heroFamily,
            inspirationEvidenceId: candidateEvidence.evidenceSha256,
            inspirationTaxonomy: candidateTaxonomy,
          });
      return {
        id: candidateId,
        label: String.fromCharCode(65 + index),
        queryAxis: "foundation_split" as const,
        providerItemKey,
        title: `${heroFamily} Hero`,
        description: "Enterprise hero reference",
        author: "21st",
        sourceUrl: `https://21st.dev/community/components/${heroFamily}`,
        visualEvidence: candidateEvidence,
        previewLocalAssetId: referencePreviewLocalAssetId,
        previewSha256: referenceSha,
        realizationPreviewLocalAssetId,
        realizationPreviewSha256: realizationSha,
        referencePerceptualHash: perceptualHashes[index]!,
        realizationPerceptualHash: perceptualHashes[(index + 4) % 9]!,
        referenceBlueprint: blueprint,
        taxonomy: candidateTaxonomy,
        score: 90 - index,
        rationale: "合格 Hero 视觉证据",
      };
    });
    const selectionBundle = {
      schemaVersion: 4,
      queryPlanHash: "f".repeat(64),
      searchTarget: 162,
      referenceTarget: 9,
      displayTarget: 9,
      candidates: selectionCandidates,
      selectedCandidateId: context.sample.id,
      delegated: false,
      degradedReasons: [],
    };
    const selectionBytes = Buffer.from(canonicalJson(selectionBundle), "utf8");
    context.batch.selectionBundleHash = sha256(selectionBytes);

    const timeline: string[] = [];
    const buildWrites: Array<Record<string, unknown>> = [];
    const query: any = {};
    query.from = () => query;
    query.innerJoin = () => query;
    query.where = () => query;
    query.limit = async () => [context];
    const db = {
      select: () => query,
      transaction: async (callback: (tx: unknown) => Promise<unknown>) =>
        callback(db),
      update: () => ({
        set: (values: Record<string, unknown>) => ({
          where: async () => {
            if (!("result" in values)) {
              buildWrites.push(values);
              Object.assign(context.build, values);
              if (values.status === "qa_running")
                timeline.push("db:qa_running");
            }
            return [{ affectedRows: 1 }];
          },
        }),
      }),
    };

    const readArtifact = vi.fn(async (input: { localAssetId: string }) => {
      const isSelection =
        input.localAssetId === context.batch.selectionBundleLocalAssetId;
      const isRealization =
        input.localAssetId === referenceBlueprint.previewLocalAssetId;
      const bytes = isSelection
        ? selectionBytes
        : isRealization
          ? realizationPreview
          : preview;
      return {
        row: {
          id: input.localAssetId,
          scope: "managed_user",
          accountUserId: baseOperation.userId,
          storageKey: `siteops:${baseOperation.projectId}:fixture:${input.localAssetId}`,
          mimeType: isSelection ? "application/json" : "image/png",
          contentSha256: sha256(bytes),
        },
        stored: {
          sizeBytes: bytes.length,
          createReadStream: () => Readable.from([bytes]),
        },
      };
    });

    const contentTaskId = "manus-content-patch-task";
    const createTask = vi.fn(async () => {
      timeline.push("provider:create");
      return { taskId: contentTaskId };
    });
    const sendMessage = vi.fn(async () => {
      timeline.push("provider:send");
    });
    const client = {
      createTask,
      sendMessage,
      findCreatedTask: vi.fn(),
      taskDetail: vi.fn(async () => ({ status: "running" })),
      listAllMessages: vi.fn(async () => [
        operationMarker(`siteops-content:${baseOperation.id}`, 1),
        {
          id: "assistant-thinking",
          type: "assistant_message",
          timestamp: 2,
          assistant_message: { content: "正在思考并整理官网内容……" },
        },
      ]),
    };

    const contractJson = Buffer.from('{"contract":true}', "utf8");
    const sourceZip = Buffer.from("source-zip", "utf8");
    const distZip = Buffer.from("dist-zip", "utf8");
    const qaJson = Buffer.from('{"passed":true,"mode":"preview"}', "utf8");
    const visualQaZip = Buffer.from("visual-qa-zip", "utf8");
    const provenanceJson = Buffer.from('{"provenance":true}', "utf8");
    const materialized = {
      contract: { specHash: "9".repeat(64) },
      buildDelivery: {
        renderMode: "trusted_fallback" as const,
        qaStatus: "partial" as const,
        warningCodes: ["SITEOPS_CONTENT_PATCH_TRUSTED_FALLBACK"],
      },
      contractJson,
      contractSha256: sha256(contractJson),
      sourceZip,
      sourceSha256: sha256(sourceZip),
      distZip,
      distSha256: sha256(distZip),
      qaJson,
      qaSha256: sha256(qaJson),
      visualQaZip,
      visualQaSha256: sha256(visualQaZip),
      provenanceJson,
      provenanceSha256: sha256(provenanceJson),
      buildLog: Buffer.from("ok", "utf8"),
      files: new Map<string, Buffer>(),
    };
    let materializeAttempts = 0;
    const materializeSite = vi.fn(async (input: unknown) => {
      timeline.push("materialize");
      expect(input).toMatchObject({
        mode: "preview",
        forceTrustedFallback: {
          warningCode: "SITEOPS_CONTENT_PATCH_TRUSTED_FALLBACK",
        },
        generatedContent: {
          routes: [
            {
              routeId: "home",
              sections: expect.arrayContaining([
                expect.objectContaining({
                  slotId: "overview",
                  paragraphs: ["星河智造提供设备服务。"],
                  sourceDocumentIds: ["overview"],
                }),
              ]),
            },
          ],
        },
      });
      materializeAttempts += 1;
      if (materializeAttempts === 1) {
        throw new SiteOpsMaterializationError({
          phase: "browser_qa",
          code: "SITEOPS_BROWSER_RUNTIME_UNAVAILABLE",
          retryClass: "host_transient",
        });
      }
      return materialized as never;
    });
    const artifactIds = {
      "site-contract": "a0000000-0000-4000-8000-000000000001",
      "site-source": "a0000000-0000-4000-8000-000000000002",
      "site-dist": "a0000000-0000-4000-8000-000000000003",
      "site-qa": "a0000000-0000-4000-8000-000000000004",
      "site-provenance": "a0000000-0000-4000-8000-000000000005",
    } as const;
    const persistArtifact = vi.fn(
      async (input: { kind: string; buffer: Buffer }) => {
        timeline.push(`persist:${input.kind}`);
        return {
          id: artifactIds[input.kind as keyof typeof artifactIds],
          contentSha256: sha256(input.buffer),
        } as never;
      },
    );
    let providerAvailable = false;
    const getCredential = vi.fn(async () => {
      if (!providerAvailable) throw new Error("CREDENTIAL_OFFLINE");
      return {
        id: baseOperation.input.manusCredentialId,
        userId: baseOperation.userId,
        version: baseOperation.input.manusCredentialVersion,
        apiKey: "customer-personal-key",
      };
    });
    const createClient = vi.fn(() => client as never);
    const assertLeaseActive = vi.fn(async () => {
      timeline.push("lease");
    });

    remotePreview.fetchPinnedPublicHttps.mockReset();

    const handler = createManusSiteOpsProviderHandler({
      getDb: async () => db as never,
      getCredential: getCredential as never,
      createClient,
      readSnapshotArchive: async () => Buffer.from("x"),
      readArtifact: readArtifact as never,
      materializeSite,
      persistArtifact: persistArtifact as never,
    });
    const sweep = (operation: typeof buildOperation) =>
      handler({
        operation: operation as never,
        signal: new AbortController().signal,
        assertLeaseActive,
      });

    const created = await sweep(buildOperation);
    expect(created).toMatchObject({
      status: "pending",
      buildStatus: "qa_running",
      result: {
        stage: "content_pending",
        buildCheckpoint: "artifacts_staged",
        fallbackPreview: {
          status: "staged",
          operationToken: `siteops-content-baseline:${baseOperation.id}`,
          buildDelivery: {
            renderMode: "trusted_fallback",
            qaStatus: "partial",
          },
        },
        design: {
          designSpec: {
            schemaVersion: 2,
            routeCompositions: [expect.objectContaining({ routeId: "home" })],
          },
        },
      },
    });
    expect(created.providerTaskId).toBeUndefined();
    expect(createTask).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(getCredential).not.toHaveBeenCalled();
    expect(createClient).not.toHaveBeenCalled();
    expect(materializeSite).toHaveBeenCalledTimes(2);
    expect(persistArtifact).toHaveBeenCalledTimes(5);

    const stagedState = created.result as Record<string, any>;
    const resumedStaging = await sweep(
      operationWithState(buildOperation, null, stagedState) as never,
    );
    expect(resumedStaging).toMatchObject({
      status: "pending",
      buildStatus: "qa_running",
      result: {
        buildCheckpoint: "artifacts_staged",
        fallbackPreview: { status: "staged" },
      },
    });
    expect(getCredential).not.toHaveBeenCalled();
    expect(createClient).not.toHaveBeenCalled();
    expect(materializeSite).toHaveBeenCalledTimes(2);
    expect(persistArtifact).toHaveBeenCalledTimes(5);

    Object.assign(context.build, {
      contractLocalAssetId: artifactIds["site-contract"],
    });
    const partialBinding = await sweep(
      operationWithState(buildOperation, null, stagedState) as never,
    );
    expect(partialBinding).toMatchObject({
      status: "attention_required",
      code: "BUILD_ARTIFACT_BINDING_FAILED",
    });
    expect(getCredential).not.toHaveBeenCalled();
    expect(createClient).not.toHaveBeenCalled();
    Object.assign(context.build, { contractLocalAssetId: null });

    providerAvailable = true;
    const boundState = {
      ...stagedState,
      fallbackPreview: {
        ...stagedState.fallbackPreview,
        status: "bound",
      },
    };
    Object.assign(context.build, {
      status: "qa_running",
      contractLocalAssetId: artifactIds["site-contract"],
      sourceLocalAssetId: artifactIds["site-source"],
      distLocalAssetId: artifactIds["site-dist"],
      qaLocalAssetId: artifactIds["site-qa"],
      provenanceLocalAssetId: artifactIds["site-provenance"],
    });

    const taskCreated = await sweep(
      operationWithState(buildOperation, null, boundState) as never,
    );
    expect(taskCreated).toMatchObject({
      status: "pending",
      providerTaskId: contentTaskId,
      buildStatus: "qa_running",
      result: {
        stage: "content_pending",
        taskId: contentTaskId,
        fallbackPreview: { status: "bound" },
      },
    });
    expect(createTask).toHaveBeenCalledTimes(1);
    expect(createTask.mock.calls[0]![0]).toMatchObject({
      agentProfile: "manus-1.6",
    });
    expect(createTask.mock.calls[0]![0].prompt).toContain(
      "SiteContentPatchWireV1",
    );
    expect(createTask.mock.calls[0]![0].prompt).not.toContain("SiteDesignWire");
    expect(createTask.mock.calls[0]![0].attachments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          filename: "frontmind-site-content-slot-manifest-v1.json",
        }),
      ]),
    );
    expect(
      JSON.stringify(createTask.mock.calls[0]![0].structuredOutputSchema),
    ).not.toMatch(/(?:layoutArchetype|routeSlots|palette|component)/u);
    expect(sendMessage).not.toHaveBeenCalled();

    timeline.length = 0;
    const twentyMinutesAgo = new Date(Date.now() - 20 * 60_000);
    const runningState = {
      ...(taskCreated.result as Record<string, any>),
      phaseOperationToken: `siteops-content:${baseOperation.id}`,
      phaseStartedAt: twentyMinutesAgo.toISOString(),
      lastContractProgressAt: undefined,
    };
    const stillReconciling = await sweep(
      operationWithState(
        {
          ...buildOperation,
          startedAt: twentyMinutesAgo,
          createdAt: twentyMinutesAgo,
        } as never,
        contentTaskId,
        runningState,
      ) as never,
    );

    expect(stillReconciling).toMatchObject({
      status: "pending",
      providerTaskId: contentTaskId,
      buildStatus: "qa_running",
      nextPollMs: 300_000,
      result: {
        stage: "content_pending",
        buildPhase: "provider_sync_delayed",
        fallbackPreview: { status: "bound" },
      },
    });
    expect(remotePreview.fetchPinnedPublicHttps).not.toHaveBeenCalled();
    expect(materializeSite).toHaveBeenCalledTimes(2);
    expect(persistArtifact).toHaveBeenCalledTimes(5);
    expect(persistArtifact.mock.calls.map(([input]) => input.kind)).toEqual([
      "site-contract",
      "site-source",
      "site-dist",
      "site-qa",
      "site-provenance",
    ]);
    expect(buildWrites.some((write) => "contractLocalAssetId" in write)).toBe(
      false,
    );

    expect(createTask).toHaveBeenCalledTimes(1);
    expect(sendMessage).not.toHaveBeenCalled();
    expect(client.taskDetail).toHaveBeenCalledTimes(1);
    expect(client.listAllMessages).toHaveBeenCalledTimes(1);
    expect(context.build.repairAttempts).toBe(0);
    expect(getCredential).toHaveBeenCalledTimes(2);
    expect(
      getCredential.mock.calls.every(
        ([userId, credentialId]) =>
          userId === baseOperation.userId &&
          credentialId === baseOperation.input.manusCredentialId,
      ),
    ).toBe(true);
    expect(
      createClient.mock.calls.every(
        ([input]) =>
          input.apiKey === "customer-personal-key" &&
          input.credentialId === baseOperation.input.manusCredentialId,
      ),
    ).toBe(true);

    expect(buildWrites.some((write) => write.status === "qa_running")).toBe(
      true,
    );
  });

  it("binds the selected V5 source ZIP through Manus receipt, native materialization, and persisted preview", async () => {
    const selectedIndex = 7;
    const sourceArchives = new Map<string, Buffer>();
    const candidates = [];
    for (let index = 0; index < 9; index += 1) {
      const label = String.fromCharCode(65 + index);
      const candidateId = `60000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`;
      const providerItemKey = `n:${index + 1}`;
      const source = normalizeTwentyFirstNativeSource({
        candidate: { providerItemId: index + 1, providerItemKey } as never,
        payload: {
          id: index + 1,
          version: `v${index + 1}`,
          componentCode: `import React from "react";export default function Native${label}(){return <main>Native ${label}</main>}`,
          demoCode: `import React from "react";import Native from "./component";export default function Demo${label}(){return <Native/>}`,
          globalsCss: `body{--candidate:${index + 1}}`,
          dependencies: ["react@19.2.1", "react-dom@19.2.1"],
        },
      });
      const sourceArchive = await createNativeSourceArchive(source);
      sourceArchives.set(candidateId, sourceArchive);
      const referencePreviewSha256 = sha256(`reference-${label}`);
      const evidence = createVisualEvidenceV1({
        evidenceKind: "catalog_metadata_preview_v1",
        providerItemKey,
        metadataSha256: sha256(`metadata-${label}`),
        providerResponseSha256: sha256(`response-${label}`),
        previewSha256: referencePreviewSha256,
        taxonomyDerivationVersion: "catalog-metadata-preview-v1",
      });
      candidates.push({
        id: candidateId,
        label,
        queryAxis: "foundation_split" as const,
        providerItemId: String(index + 1),
        providerItemKey,
        providerVersion: `v${index + 1}`,
        title: `Native ${label}`,
        description: null,
        author: null,
        sourceUrl: `https://21st.dev/community/components/${index + 1}`,
        visualEvidence: evidence,
        referencePreviewLocalAssetId: `70000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
        referencePreviewSha256,
        referencePerceptualHash: sha256(`phash-${label}`).slice(0, 16),
        previewLocalAssetId: `80000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
        previewSha256: sha256(`native-preview-${label}`),
        taxonomy: {
          role: "foundation" as const,
          palette: ["#ffffff", "#111111"],
          typography: [],
          layout: [],
          motion: [],
          accessibility: [],
        },
        score: 90 - index,
        rationale: "真实原生源码候选",
        sourceTreeSha256: source.sourceTreeSha256,
        sourceArchiveSha256: sha256(sourceArchive),
        sourceArchivePath: `candidates/${label}/source.zip`,
        entrypoint: source.entrypoint,
        demoEntrypoint: source.demoEntrypoint,
        sourceDirectory: "source" as const,
      });
    }
    const selected = candidates[selectedIndex]!;
    const bundle = visualSelectionBundleV5Schema.parse({
      schemaVersion: 5,
      renderer: "twenty_first_native_react_v1",
      queryPlanHash: sha256("native-query-plan"),
      searchTarget: 162,
      displayTarget: 9,
      candidates,
      selectedCandidateId: null,
      delegated: false,
      degradedReasons: [],
    });
    const selectionBytes = await createVisualSelectionBundleV5Artifact({
      bundle,
      sourceArchives,
    });

    const finalZip = new JSZip();
    for (const file of NATIVE_RUNTIME_EXECUTION_SHELL_V1.files) {
      finalZip.file(file.path, file.text);
    }
    finalZip.file(
      NATIVE_RUNTIME_ROUTE_MODULE,
      'import Home from "./home";\nexport const FRONTMIND_ROUTE_PATHS = ["/"] as const;\nexport default function FrontMindRoutes() { return <Home />; }\n',
    );
    finalZip.file(
      "src/home.tsx",
      "export default function Home() { return <main>企业官网</main>; }\n",
    );
    const finalSourceZip = await finalZip.generateAsync({ type: "nodebuffer" });
    const finalSourceSha256 = sha256(finalSourceZip);
    const operationToken = `siteops-native-source:${baseOperation.id}:0`;
    const selectedBaseSha256 = selected.sourceArchiveSha256;
    const receipt = {
      operationToken,
      baseSourceSha256: selectedBaseSha256,
      archiveSha256: finalSourceSha256,
      fileCount: 5,
      preflightVersion: NATIVE_SOURCE_PREFLIGHT_V2_VERSION,
      preflightStatus: "passed",
      preflightSha256: NATIVE_SOURCE_PREFLIGHT_V2_SHA256,
      runtimeContractVersion: NATIVE_RUNTIME_CONTRACT_V1.contractVersion,
      runtimeContractSha256: NATIVE_RUNTIME_CONTRACT_V1_SHA256,
      executionShellSha256: NATIVE_RUNTIME_EXECUTION_SHELL_V1_SHA256,
      executionBaselineSha256: selectedBaseSha256,
    };
    const context = {
      build: {
        id: baseOperation.buildId,
        projectId: baseOperation.projectId,
        userId: baseOperation.userId,
        knowledgeSnapshotId: "50000000-0000-4000-8000-000000000005",
        knowledgeArchiveHash: "a".repeat(64),
        workflowUpstreamVersion: SITEOPS_MATERIALIZER_V2_5.upstreamVersion,
        workflowUpstreamHash: SITEOPS_MATERIALIZER_V2_5.upstreamSha256,
        workflowVersion: SITEOPS_MATERIALIZER_V2_5.frontMindVersion,
        workflowPackageHash: SITEOPS_MATERIALIZER_V2_5.runtimeManifestSha256,
        starterVersion: SITEOPS_MATERIALIZER_V2_5.starterVersion,
        brief: {
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
          verifiedFacts: [
            {
              statement: "星河智造提供设备服务。",
              sourceDocumentIds: ["overview"],
            },
          ],
          publicAssetIds: [],
          unknowns: [],
        },
        selectionHash: sha256("native-selection"),
        repairAttempts: 0,
        parentBuildId: null,
        upstreamManusTaskId: null as string | null,
        status: "queued",
      },
      project: { id: baseOperation.projectId },
      snapshot: {
        id: "50000000-0000-4000-8000-000000000005",
        userId: baseOperation.userId,
        archiveHash: "a".repeat(64),
        totalBytes: 1,
        sourceBuildId: null,
        sourceBuildRevision: null,
        assets: [],
        documents: [
          {
            id: "overview",
            path: "overview.md",
            title: "企业简介",
            content: "星河智造提供设备服务。",
            kind: "leaf" as const,
            evidenceStatus: "verified_first_party" as const,
            customerVisible: true,
          },
        ],
      },
      sample: {
        id: selected.id,
        batchId: "70000000-0000-4000-8000-000000000007",
        previewLocalAssetId: selected.previewLocalAssetId,
        sourceMetadata: {
          schemaVersion: 5,
          renderer: "twenty_first_native_react_v1",
          providerItemKey: selected.providerItemKey,
          providerVersion: selected.providerVersion,
          sourceTreeSha256: selected.sourceTreeSha256,
          sourceArchiveSha256: selected.sourceArchiveSha256,
          visualEvidence: selected.visualEvidence,
          taxonomy: selected.taxonomy,
        },
      },
      batch: {
        selectionBundleLocalAssetId: "90000000-0000-4000-8000-000000000009",
        selectionBundleHash: sha256(selectionBytes),
      },
    };
    const query: any = {};
    query.from = () => query;
    query.innerJoin = () => query;
    query.where = () => query;
    query.limit = async () => [context];
    let persistedOperationResult: unknown = null;
    const db = {
      select: () => query,
      transaction: async (callback: (tx: unknown) => Promise<unknown>) =>
        callback(db),
      update: () => ({
        set: (values: Record<string, unknown>) => ({
          where: async () => {
            if ("result" in values) {
              persistedOperationResult = values.result;
            } else {
              Object.assign(context.build, values);
            }
            return [{ affectedRows: 1 }];
          },
        }),
      }),
    };
    const taskId = "native-manus-task";
    const createTask = vi.fn(async () => ({ taskId }));
    remotePreview.fetchPinnedPublicHttps
      .mockReset()
      .mockResolvedValueOnce({
        response: new Response(null, { status: 503 }),
        finalUrl: { origin: "https://files.example.test", path: "/source" },
      })
      .mockResolvedValueOnce({
        response: new Response(null, { status: 503 }),
        finalUrl: { origin: "https://files.example.test", path: "/source" },
      })
      .mockResolvedValueOnce({
        response: new Response(null, { status: 503 }),
        finalUrl: { origin: "https://files.example.test", path: "/source" },
      })
      .mockResolvedValue({
        response: new Response(finalSourceZip, {
          status: 200,
          headers: {
            "content-type": "application/zip",
            "content-length": String(finalSourceZip.length),
          },
        }),
        finalUrl: { origin: "https://files.example.test", path: "/source" },
      });
    const formalEvents = [
      operationMarker(operationToken, 0),
      {
        id: "native-receipt",
        type: "structured_output_result",
        timestamp: 1,
        structured_output_result: { success: true, value: receipt },
      },
      {
        id: "native-source",
        type: "assistant_message",
        timestamp: 2,
        assistant_message: {
          content: "完整源码已返回。",
          attachments: [
            {
              filename: "frontmind-site-source-v1.zip",
              content_type: "application/zip",
              url: "https://files.example.test/source.zip?signature=fresh",
            },
          ],
        },
      },
      {
        id: "native-stopped",
        type: "status_update",
        timestamp: 3,
        status_update: { agent_status: "stopped" },
      },
    ];
    const client = {
      createTask,
      sendMessage: vi.fn(),
      findCreatedTask: vi.fn(),
      taskDetail: vi.fn(async () => ({ status: "stopped" })),
      listAllMessages: vi.fn(async () => formalEvents),
    };
    const contractJson = Buffer.from(
      JSON.stringify({ contractKind: "twenty_first_native_build_contract" }),
    );
    const distZip = Buffer.from("native-dist");
    const qaJson = Buffer.from(
      JSON.stringify({ passed: true, mode: "preview" }),
    );
    const qaZip = Buffer.from("native-qa");
    const provenanceJson = Buffer.from("{}\n");
    const materialized = {
      contractJson,
      contractSha256: sha256(contractJson),
      sourceZip: finalSourceZip,
      sourceSha256: finalSourceSha256,
      distZip,
      distSha256: sha256(distZip),
      qaJson,
      qaSha256: sha256(qaJson),
      visualQaZip: qaZip,
      visualQaSha256: sha256(qaZip),
      provenanceJson,
      provenanceSha256: sha256(provenanceJson),
      buildLog: Buffer.from("ok"),
      files: new Map<string, Buffer>(),
      buildDelivery: {
        renderMode: "twenty_first_native" as const,
        qaStatus: "passed" as const,
        warningCodes: [],
      },
    };
    let crashAfterStaging = true;
    const materializeNativeSite = vi.fn(async (input: any) => {
      expect(input.sourceZip.equals(finalSourceZip)).toBe(true);
      expect(input.mode).toBe("preview");
      if (crashAfterStaging) {
        crashAfterStaging = false;
        throw new Error("SIMULATED_WORKER_CRASH_AFTER_SOURCE_STAGING");
      }
      return materialized as never;
    });
    const trustedSourceZip = Buffer.from("frontmind-host-fallback-source");
    const trustedDistZip = Buffer.from("frontmind-host-fallback-dist");
    const trustedQaZip = Buffer.from("frontmind-host-fallback-qa");
    const trustedContract = Buffer.from(
      JSON.stringify({ contractKind: "frontmind_host_fallback" }),
    );
    const trustedProvenance = Buffer.from(
      JSON.stringify({ renderer: "frontmind_host" }),
    );
    const materializeNativeFallbackSite = vi.fn(async (input: any) => {
      expect(input).not.toHaveProperty("sourceZip");
      expect(input.mode).toBe("preview");
      return {
        ...materialized,
        contractJson: trustedContract,
        contractSha256: sha256(trustedContract),
        sourceZip: trustedSourceZip,
        sourceSha256: sha256(trustedSourceZip),
        distZip: trustedDistZip,
        distSha256: sha256(trustedDistZip),
        visualQaZip: trustedQaZip,
        visualQaSha256: sha256(trustedQaZip),
        provenanceJson: trustedProvenance,
        provenanceSha256: sha256(trustedProvenance),
        buildDelivery: {
          renderMode: "trusted_fallback" as const,
          qaStatus: "partial" as const,
          warningCodes: ["NATIVE_PROVIDER_SYNC_TRUSTED_FALLBACK"],
        },
      } as never;
    });
    const stagedArtifacts = new Map<
      string,
      { buffer: Buffer; retainUntil: Date | null }
    >();
    let failDistOnce = false;
    const persistArtifact = vi.fn(async (input: any) => {
      const id = siteOpsArtifactIdForIdempotency({
        userId: input.userId,
        projectId: input.projectId,
        kind: input.kind,
        idempotencyKey: input.idempotencyKey,
      });
      if (input.kind === "site-dist" && failDistOnce) {
        failDistOnce = false;
        throw new Error("SIMULATED_NTH_ARTIFACT_FAILURE");
      }
      stagedArtifacts.set(id, {
        buffer: input.buffer,
        retainUntil: input.retainUntil ?? null,
      });
      return {
        id,
        contentSha256: sha256(input.buffer),
        sizeBytes: input.buffer.length,
      };
    });
    const readArtifact = vi.fn(async (input: { localAssetId: string }) => {
      if (input.localAssetId === context.batch.selectionBundleLocalAssetId) {
        return {
          row: {
            id: context.batch.selectionBundleLocalAssetId,
            scope: "managed_user",
            accountUserId: baseOperation.userId,
            storageKey: `siteops:${baseOperation.projectId}:native-selection`,
            mimeType: "application/zip",
            contentSha256: context.batch.selectionBundleHash,
            sizeBytes: selectionBytes.length,
          },
          stored: {
            sizeBytes: selectionBytes.length,
            createReadStream: () => Readable.from([selectionBytes]),
          },
        };
      }
      const staged = stagedArtifacts.get(input.localAssetId);
      if (!staged) return null;
      return {
        row: {
          id: input.localAssetId,
          scope: "managed_user",
          accountUserId: baseOperation.userId,
          storageKey: `siteops:${baseOperation.projectId}:site-source-staging:${input.localAssetId}`,
          mimeType: "application/zip",
          contentSha256: sha256(staged.buffer),
          sizeBytes: staged.buffer.length,
          retainUntil: staged.retainUntil,
        },
        stored: {
          sizeBytes: staged.buffer.length,
          createReadStream: () => Readable.from([staged.buffer]),
        },
      };
    });
    const getCredential = vi.fn(async () => ({
      id: baseOperation.input.manusCredentialId,
      userId: baseOperation.userId,
      version: baseOperation.input.manusCredentialVersion,
      apiKey: "customer-personal-key",
    }));
    const createClient = vi.fn(() => client as never);
    const handler = createManusSiteOpsProviderHandler({
      getDb: async () => db as never,
      getCredential: getCredential as never,
      createClient,
      readSnapshotArchive: async () => Buffer.from("x"),
      readArtifact: readArtifact as never,
      materializeNativeSite,
      materializeNativeTrustedFallbackSite: materializeNativeFallbackSite,
      persistArtifact: persistArtifact as never,
    });
    const assertLeaseActive = vi.fn(async () => undefined);
    const created = await handler({
      operation: baseOperation as never,
      signal: new AbortController().signal,
      assertLeaseActive,
    });
    expect(created).toMatchObject({
      status: "pending",
      providerTaskId: taskId,
      result: {
        stage: "native_source_pending",
        nativeSourceContractVersion: 2,
        nativeRepairAttempt: 0,
        buildPhase: "source_waiting",
      },
    });
    const createInput = createTask.mock.calls[0]![0] as any;
    expect(createInput.prompt).toContain("不是视觉设计师");
    expect(createInput.prompt).toContain(selectedBaseSha256);
    expect(createInput.prompt).toContain("preflightStatus=passed");
    expect(createInput.prompt).toContain(
      "fileCount 必须填写最终 ZIP 的非目录文件条目数（不计目录项）",
    );
    expect(createInput.prompt).toContain(
      "只返回 frontmind-site-source-v1.zip 与 frontmind-site-source-receipt-v1.json 各一份后结束",
    );
    const preflightAttachment = createInput.attachments.find(
      (item: any) => item.filename === NATIVE_SOURCE_PREFLIGHT_V2_FILENAME,
    );
    expect(preflightAttachment.mime_type).toBe("text/javascript");
    expect(
      Buffer.from(
        preflightAttachment.file_data.split(",", 2)[1],
        "base64",
      ).toString("utf8"),
    ).toContain("PREFLIGHT_V2_FAILED");
    expect(
      createInput.attachments.some(
        (item: any) => item.filename === NATIVE_RUNTIME_CONTRACT_FILENAME,
      ),
    ).toBe(true);
    expect(
      createInput.attachments.some(
        (item: any) =>
          item.filename === NATIVE_RUNTIME_EXECUTION_SHELL_FILENAME,
      ),
    ).toBe(true);
    expect(createInput.structuredOutputSchema.required).toEqual(
      expect.arrayContaining([
        "preflightVersion",
        "preflightStatus",
        "preflightSha256",
      ]),
    );
    const baseAttachment = createInput.attachments.find(
      (item: any) => item.filename === "frontmind-selected-21st-source-v1.zip",
    );
    expect(
      Buffer.from(baseAttachment.file_data.split(",", 2)[1], "base64").equals(
        sourceArchives.get(selected.id)!,
      ),
    ).toBe(true);

    const delayedState = {
      ...(created.result as Record<string, unknown>),
      nativeSourceReadFailureCount: 2,
      nativeSourceReadFailureSince: new Date(
        Date.now() - 15 * 60_000,
      ).toISOString(),
      buildPhase: "provider_sync_delayed",
    };
    failDistOnce = true;
    const fallbackDeferred = await handler({
      operation: operationWithState(
        baseOperation,
        taskId,
        delayedState,
      ) as never,
      signal: new AbortController().signal,
      assertLeaseActive,
    });
    expect(fallbackDeferred).toMatchObject({
      status: "pending",
      providerTaskId: taskId,
      result: {
        fallbackPreviewFailureCount: 1,
        fallbackPreviewLastErrorCode: "SITEOPS_TRUSTED_FALLBACK_FAILED",
        fallbackPreviewNextPollAt: expect.any(String),
      },
    });
    expect(fallbackDeferred.result).not.toHaveProperty("fallbackPreview");
    expect(createTask).toHaveBeenCalledTimes(1);
    expect(client.sendMessage).not.toHaveBeenCalled();

    const retryFallbackState = {
      ...(fallbackDeferred.result as Record<string, unknown>),
      fallbackPreviewNextPollAt: new Date(Date.now() - 1).toISOString(),
    };
    const fallback = await handler({
      operation: operationWithState(
        baseOperation,
        taskId,
        retryFallbackState,
      ) as never,
      signal: new AbortController().signal,
      assertLeaseActive,
    });
    expect(fallback).toMatchObject({
      status: "pending",
      providerTaskId: taskId,
      buildStatus: "qa_running",
      result: {
        fallbackPreview: {
          status: "staged",
          trigger: "provider_read_delayed",
          buildDelivery: { renderMode: "trusted_fallback" },
        },
      },
    });
    expect(materializeNativeFallbackSite).toHaveBeenCalledTimes(2);
    expect(materializeNativeSite).not.toHaveBeenCalled();
    expect(remotePreview.fetchPinnedPublicHttps).toHaveBeenCalledTimes(2);
    expect(createTask).toHaveBeenCalledTimes(1);
    expect(client.sendMessage).not.toHaveBeenCalled();
    expect(
      persistArtifact.mock.calls
        .slice(0, 5)
        .every(([value]) =>
          String(value.idempotencyKey).includes(":trusted-fallback:"),
        ),
    ).toBe(true);

    const boundFallbackState = {
      ...(fallback.result as Record<string, unknown>),
      fallbackPreview: {
        ...((fallback.result as Record<string, any>).fallbackPreview ?? {}),
        status: "bound",
      },
    };
    const expiredFallbackState = {
      ...boundFallbackState,
      fallbackPreview: {
        ...(boundFallbackState.fallbackPreview as Record<string, unknown>),
        reconcileUntilAt: new Date(Date.now() - 1).toISOString(),
      },
    };
    client.taskDetail.mockResolvedValue({ status: "running" });
    client.listAllMessages.mockResolvedValue([
      operationMarker(operationToken, 0),
    ]);
    const expired = await handler({
      operation: operationWithState(
        baseOperation,
        taskId,
        expiredFallbackState,
      ) as never,
      signal: new AbortController().signal,
      assertLeaseActive,
    });
    expect(expired).toMatchObject({
      status: "attention_required",
      code: "FRONTMIND_BUILD_PROVIDER_SYNC_ATTENTION",
      result: {
        fallbackPreview: {
          status: "bound",
          taskId,
          buildId: baseOperation.buildId,
          operationToken: `siteops-native-fallback:${baseOperation.id}`,
        },
      },
    });
    expect(createTask).toHaveBeenCalledTimes(1);
    expect(client.sendMessage).not.toHaveBeenCalled();
    expect(materializeNativeFallbackSite).toHaveBeenCalledTimes(2);

    client.taskDetail.mockResolvedValue({ status: "stopped" });
    client.listAllMessages.mockResolvedValue(formalEvents);
    failDistOnce = true;

    remotePreview.fetchPinnedPublicHttps.mockClear();
    const rejectedCandidateState = {
      ...boundFallbackState,
      nativeRejectedCandidateV1: createNativeRejectedCandidateV1({
        taskId,
        repairAttempt: 0,
        operationToken,
        attachmentIdentity: "native-source:attachment:0",
        archiveSha256: finalSourceSha256,
        errorCode: "NATIVE_SOURCE_PACKAGE_JSON_INVALID",
        rejectedAt: new Date("2026-08-27T14:00:00.000Z"),
      }),
    };
    for (let sweep = 0; sweep < 20; sweep += 1) {
      await expect(
        handler({
          operation: operationWithState(
            baseOperation,
            taskId,
            rejectedCandidateState,
          ) as never,
          signal: new AbortController().signal,
          assertLeaseActive,
        }),
      ).resolves.toMatchObject({
        status: "pending",
        providerTaskId: taskId,
        nextPollMs: NATIVE_REJECTED_CANDIDATE_RECONCILIATION_MS,
        result: {
          nativeRejectedCandidateV1: {
            archiveSha256: finalSourceSha256,
          },
        },
      });
    }
    expect(remotePreview.fetchPinnedPublicHttps).not.toHaveBeenCalled();
    expect(materializeNativeSite).not.toHaveBeenCalled();
    expect(client.sendMessage).not.toHaveBeenCalled();

    const transientDownload = await handler({
      operation: operationWithState(
        baseOperation,
        taskId,
        boundFallbackState,
      ) as never,
      signal: new AbortController().signal,
      assertLeaseActive,
    });
    expect(transientDownload).toMatchObject({
      status: "pending",
      providerTaskId: taskId,
      nextPollMs: NATIVE_REJECTED_CANDIDATE_RECONCILIATION_MS,
      result: {
        stage: "native_source_pending",
        nativeSourceReadFailureCount: 5,
        buildPhase: "provider_sync_delayed",
      },
    });
    expect(client.sendMessage).not.toHaveBeenCalled();
    expect(materializeNativeSite).not.toHaveBeenCalled();

    const interrupted = await handler({
      operation: operationWithState(
        baseOperation,
        taskId,
        transientDownload.result,
      ) as never,
      signal: new AbortController().signal,
      assertLeaseActive,
    });
    expect(interrupted.status).not.toBe("succeeded");
    expect(persistedOperationResult).toMatchObject({
      buildCheckpoint: "compile_started",
      nativeSourceStaging: {
        sha256: finalSourceSha256,
        bytes: finalSourceZip.length,
        expiresAt: expect.any(String),
        taskId,
        repairAttempt: 0,
        receipt,
      },
    });

    client.taskDetail.mockClear();
    client.listAllMessages.mockClear();
    client.createTask.mockClear();
    client.sendMessage.mockClear();
    getCredential.mockClear();
    createClient.mockClear();
    getCredential.mockRejectedValue(new Error("CREDENTIAL_OFFLINE"));
    createClient.mockImplementation(() => {
      throw new Error("CLIENT_MUST_NOT_BE_CREATED");
    });
    client.taskDetail.mockRejectedValue(new Error("PROVIDER_OFFLINE"));
    client.listAllMessages.mockRejectedValue(new Error("PROVIDER_OFFLINE"));
    remotePreview.fetchPinnedPublicHttps.mockClear();

    const artifactInterrupted = await handler({
      operation: operationWithState(
        baseOperation,
        taskId,
        persistedOperationResult,
      ) as never,
      signal: new AbortController().signal,
      assertLeaseActive,
    });
    expect(artifactInterrupted.status).not.toBe("succeeded");
    expect(stagedArtifacts.size).toBe(10);

    const finished = await handler({
      operation: operationWithState(
        baseOperation,
        taskId,
        persistedOperationResult,
      ) as never,
      signal: new AbortController().signal,
      assertLeaseActive,
    });
    expect(finished).toMatchObject({
      status: "succeeded",
      projectStatus: "preview_ready",
      buildStatus: "preview_ready",
      result: {
        buildId: baseOperation.buildId,
        distHash: materialized.distSha256,
        buildDelivery: { renderMode: "twenty_first_native" },
        artifactStaging: {
          generation: "formal",
          taskId,
          operationToken,
          nativeRepairAttempt: 0,
          artifactBindings: expect.any(Object),
          expiresAt: expect.any(String),
        },
      },
    });
    expect(materializeNativeSite).toHaveBeenCalledTimes(3);
    expect(persistArtifact.mock.calls.length).toBeGreaterThanOrEqual(18);
    expect(stagedArtifacts.size).toBe(11);
    expect(
      persistArtifact.mock.calls.find(
        ([input]) => input.kind === "site-source-staging",
      )?.[0],
    ).toMatchObject({
      kind: "site-source-staging",
      idempotencyKey: `native-source:${operationToken}`,
      retainUntil: expect.any(Date),
    });
    expect(
      persistArtifact.mock.calls
        .filter(([input]) => input.kind !== "site-source-staging")
        .every(
          ([input]) =>
            /^build:/u.test(input.idempotencyKey) &&
            input.retainUntil instanceof Date,
        ),
    ).toBe(true);
    expect(getCredential).not.toHaveBeenCalled();
    expect(createClient).not.toHaveBeenCalled();
    expect(client.taskDetail).not.toHaveBeenCalled();
    expect(client.listAllMessages).not.toHaveBeenCalled();
    expect(client.sendMessage).not.toHaveBeenCalled();
    expect(remotePreview.fetchPinnedPublicHttps).not.toHaveBeenCalled();
  });
});
