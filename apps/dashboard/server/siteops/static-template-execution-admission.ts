import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import {
  materializeNativeReactSource,
  type NativeReactQaReportV1,
} from "./native-react-build-runtime";
import {
  NATIVE_RUNTIME_CONTRACT_V1,
  NATIVE_RUNTIME_CONTRACT_V1_SHA256,
  NATIVE_RUNTIME_EXECUTION_SHELL_V1_SHA256,
  NATIVE_RUNTIME_CONTRACT_VERSION,
  NATIVE_SOURCE_PREFLIGHT_V2_SHA256,
  NATIVE_SOURCE_PREFLIGHT_V2_VERSION,
  auditNativeRuntimeContractV1,
  validateNativeReactSourceArchive,
} from "./native-react-source";
import { prepareStaticTemplateExecutionSource } from "./native-visual-source";
import type { StaticTemplateExecutionAdmissionBuilder } from "./static-template-catalog";

export const REQUIRED_STATIC_TEMPLATE_EXECUTION_CANDIDATE_ID =
  "static-template-22-hirael-agency-landing" as const;

export const REQUIRED_STATIC_TEMPLATE_RUNTIME_MEDIA = [
  {
    kind: "image",
    url: "https://images.higgs.ai/?default=1&output=webp&url=https%3A%2F%2Fd8j0ntlcm91z4.cloudfront.net%2Fuser_38xzZboKViGWJOttwIXH07lWA1P%2Fhf_20260516_090123_74be96d4-9c1b-40cf-932a-96f4f4babed3.png&w=1280&q=85",
    bytes: 1_243_139,
    sha256: "0558e2172a0701dd8e827467874a2c19274525f9cfc10d7b7252e814b619bc20",
  },
  {
    kind: "image",
    url: "https://images.higgs.ai/?default=1&output=webp&url=https%3A%2F%2Fd8j0ntlcm91z4.cloudfront.net%2Fuser_38xzZboKViGWJOttwIXH07lWA1P%2Fhf_20260516_090133_c157d30b-a99a-4477-bec1-a446149ec3f2.png&w=1280&q=85",
    bytes: 803_376,
    sha256: "98afffb93f712b38043d37fa2b3102dff4ce0c7e4993f10606ea94d0e5ae9d90",
  },
  {
    kind: "video",
    url: "https://d8j0ntlcm91z4.cloudfront.net/user_38xzZboKViGWJOttwIXH07lWA1P/hf_20260516_122702_390f5305-8719-41d5-ae80-d23ab3796c28.mp4",
    bytes: 5_382_028,
    sha256: "7ae4366f98d04032dcb7d39cbaf0de8acd2d621e6596c4f1a61ada7692cad432",
  },
  {
    kind: "video",
    url: "https://d8j0ntlcm91z4.cloudfront.net/user_38xzZboKViGWJOttwIXH07lWA1P/hf_20260516_123323_f909c2b8-ff6c-4edf-882b-8ebcdbe389b5.mp4",
    bytes: 5_250_214,
    sha256: "d130650249850e82ee1e9c248aed7761c8e842998f0cec479c9d1a6ac154fc38",
  },
] as const;

const ADMISSION_BUILD = {
  id: "22222222-2222-4222-8222-222222222222",
  projectId: "22222222-2222-4222-8222-222222222223",
  knowledgeSnapshotId: null,
  workflowVersion: "2.8.0",
} as const;

const ADMISSION_BRIEF = {
  companyName: "FrontMind execution admission",
  primaryLanguage: "zh-CN",
  contacts: [],
  offerings: ["受控静态官网执行验证"],
  audience: ["FrontMind catalog admission"],
  conversionGoal: "验证模板执行能力",
  contentInventory: {
    schemaVersion: 1,
    source: "frozen_knowledge_snapshot",
    entries: [],
  },
  routes: [
    {
      id: "home",
      slug: "/",
      title: "首页",
      sourceDocumentIds: ["catalog-admission-source"],
    },
  ],
  verifiedFacts: [
    {
      statement: "该内容仅用于模板执行准入，不进入客户网站。",
      sourceDocumentIds: ["catalog-admission-source"],
    },
  ],
  publicAssetIds: [],
  unknowns: [],
} as const;

function sha256(bytes: Buffer | string) {
  return createHash("sha256").update(bytes).digest("hex");
}

function jsonBuffer(value: unknown) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

/** The current production admission lane is deliberately narrow: #22 is the
 * user-visible recovery baseline and must complete the full controlled Vite,
 * dist, static QA and browser QA pipeline. Every other frozen raw source stays
 * visible but unavailable until it receives the same immutable evidence. */
export const buildStaticTemplateExecutionAdmission: StaticTemplateExecutionAdmissionBuilder =
  async (input) => {
    if (
      input.definition.candidateId !==
      REQUIRED_STATIC_TEMPLATE_EXECUTION_CANDIDATE_ID
    ) {
      return {
        status: "unavailable",
        code: "STATIC_TEMPLATE_EXECUTION_ADMISSION_PENDING",
        reason:
          "该模板尚未完成 FrontMind 受控 Vite 构建与浏览器验收，当前不可选择。",
      };
    }
    const rawSource = await readFile(input.rawSourcePath);
    if (
      rawSource.byteLength !== input.rawSourceBytes ||
      sha256(rawSource) !== input.rawSourceSha256
    ) {
      throw new Error("STATIC_TEMPLATE_RAW_SOURCE_HASH_MISMATCH");
    }
    const prepared = await prepareStaticTemplateExecutionSource({
      templateId: input.definition.providerTemplateId,
      slug: input.definition.providerSlug,
      version: input.definition.sourceCommitSha,
      archive: rawSource,
      expectedArchiveSha256: input.rawSourceSha256,
      sourceSubdirectory: input.definition.sourceSubdirectory,
      signal: input.signal,
      frozenRuntimeMedia: REQUIRED_STATIC_TEMPLATE_RUNTIME_MEDIA,
    });
    const operationToken = `catalog-admission:${input.catalogVersion}:${input.definition.candidateId}`;
    const validated = await validateNativeReactSourceArchive({
      archive: prepared.sourceArchive,
      receipt: {
        operationToken,
        baseSourceSha256: prepared.sourceArchiveSha256,
        archiveSha256: prepared.sourceArchiveSha256,
        fileCount: prepared.files.length + 1,
        preflightVersion: NATIVE_SOURCE_PREFLIGHT_V2_VERSION,
        preflightStatus: "passed",
        preflightSha256: NATIVE_SOURCE_PREFLIGHT_V2_SHA256,
        runtimeContractVersion: NATIVE_RUNTIME_CONTRACT_VERSION,
        runtimeContractSha256: NATIVE_RUNTIME_CONTRACT_V1_SHA256,
        executionShellSha256: NATIVE_RUNTIME_EXECUTION_SHELL_V1_SHA256,
        executionBaselineSha256: prepared.sourceArchiveSha256,
      },
      expectedOperationToken: operationToken,
      expectedBaseSourceSha256: prepared.sourceArchiveSha256,
      requiredReceiptVersion: 2,
      expectedExecutionBaselineSha256: prepared.sourceArchiveSha256,
      runtimeContract: NATIVE_RUNTIME_CONTRACT_V1,
    });
    const selectionHash = sha256(
      JSON.stringify({
        catalogVersion: input.catalogVersion,
        candidateId: input.definition.candidateId,
        rawSourceSha256: input.rawSourceSha256,
      }),
    );
    const materialized = await materializeNativeReactSource({
      sourceZip: prepared.sourceArchive,
      validatedSource: validated,
      build: { ...ADMISSION_BUILD, selectionHash },
      brief: ADMISSION_BRIEF,
      mode: "preview",
      timeoutMs: 120_000,
      abortSignal: input.signal,
      browserQa: true,
      lighthouseQa: false,
      runtimeAudit: (auditInput) =>
        auditNativeRuntimeContractV1({
          ...auditInput,
          contract: NATIVE_RUNTIME_CONTRACT_V1,
        }),
    });
    const qa = JSON.parse(
      materialized.qaJson.toString("utf8"),
    ) as NativeReactQaReportV1;
    if (!qa.passed || !qa.browser.available) {
      throw new Error("STATIC_TEMPLATE_BROWSER_QA_UNAVAILABLE");
    }
    const browserReceipt = jsonBuffer({
      schemaVersion: 1,
      receiptKind: "frontmind_static_template_browser_admission",
      binding: {
        catalogVersion: input.catalogVersion,
        candidateId: input.definition.candidateId,
        rawSourceSha256: input.rawSourceSha256,
        runtimeMedia: REQUIRED_STATIC_TEMPLATE_RUNTIME_MEDIA,
      },
      normalizedSourceSha256: prepared.sourceArchiveSha256,
      sourceTreeSha256: prepared.sourceTreeSha256,
      runtimeContractSha256: NATIVE_RUNTIME_CONTRACT_V1_SHA256,
      executionShellSha256: NATIVE_RUNTIME_EXECUTION_SHELL_V1_SHA256,
      deliveryContractSha256: materialized.contractSha256,
      distSha256: materialized.distSha256,
      qaSha256: materialized.qaSha256,
      browser: qa.browser,
      buildDelivery: materialized.buildDelivery,
    });
    return {
      status: "admitted",
      framework: prepared.framework,
      normalizedSource: prepared.sourceArchive,
      sourceTreeSha256: prepared.sourceTreeSha256,
      runtimeContractSha256: NATIVE_RUNTIME_CONTRACT_V1_SHA256,
      executionShellSha256: NATIVE_RUNTIME_EXECUTION_SHELL_V1_SHA256,
      contract: materialized.contractJson,
      dist: materialized.distZip,
      qa: materialized.qaJson,
      browserReceipt,
      qaStatus: materialized.buildDelivery.qaStatus,
    };
  };
