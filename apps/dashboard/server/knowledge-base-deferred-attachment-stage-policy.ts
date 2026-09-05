import type { KnowledgeBaseClientAttachmentManifestItem } from "./knowledge-base-client-attachment-manifest";
import { assertCapturedKnowledgeBaseCustomerImage } from "./knowledge-base-customer-upload";
import {
  knowledgeBaseBuildRequiresOfficialLogo,
  knowledgeBaseManifestRepeatsOfficialLogo,
  loadKnowledgeBaseBuildRecord,
} from "./knowledge-base-final-turn-service";
import { MATERIALIZED_KNOWLEDGE_BASE_EXECUTION_MODE } from "./knowledge-base-materialized-service";
import { KnowledgeBaseTurnReservationError } from "./knowledge-base-turn-service";

/**
 * Logo is a legacy-v1 correctness contract and a Manus-v2 optional resource.
 * The only v2 operation allowed to validate or bind Logo bytes is an explicit
 * manual Logo submission. Ordinary images must remain ordinary attachments.
 */
export function knowledgeBaseTurnLogoPolicy(input: {
  providerProtocol?: string | null;
  manualLogoSubmission?: boolean;
  legacyLogoRequired?: boolean;
}) {
  const manusV2 = input.providerProtocol === "manus_v2";
  const manualLogoSubmission = input.manualLogoSubmission === true;
  const requiresOfficialLogo = !manusV2 && input.legacyLogoRequired === true;
  return {
    requiresOfficialLogo,
    inferOrdinaryAttachmentAsLogo:
      requiresOfficialLogo && !manualLogoSubmission,
    validateManualLogoSubmission: manualLogoSubmission,
    readPersistedLogoSubmission: !manusV2 || manualLogoSubmission,
    acceptProviderDiscoveredLogo: !manusV2,
    assertFinalLogoProvenance: !manusV2,
    // A byte-identical copy of an already-bound Logo is always a duplicate,
    // even though v2 never requires the customer to provide Logo bytes.
    rejectRepeatedOfficialLogo: true,
  } as const;
}

type DeferredAttachmentStageBuild = NonNullable<
  Awaited<ReturnType<typeof loadKnowledgeBaseBuildRecord>>
>;

/**
 * Keep resumed staging on the exact same product boundary as the normal
 * deferred stage endpoint. These are content/protocol identity checks, not
 * Provider adapter checks.
 */
export async function requireKnowledgeBaseDeferredAttachmentStageBuild(
  input: { userId: number; conversationId: string },
  loadBuild: typeof loadKnowledgeBaseBuildRecord = loadKnowledgeBaseBuildRecord,
): Promise<DeferredAttachmentStageBuild> {
  const build = await loadBuild(input.userId, input.conversationId);
  if (
    !build ||
    build.executionMode !== MATERIALIZED_KNOWLEDGE_BASE_EXECUTION_MODE ||
    build.skillVersion !== "5" ||
    build.providerProtocol !== "manus_v2"
  ) {
    throw new KnowledgeBaseTurnReservationError(
      build ? "RESET_REQUIRED" : "BUILD_NOT_FOUND",
      build
        ? "旧知识库构建不再续跑；请批准重置并重新上传资料"
        : "知识库构建不存在",
    );
  }
  return build as DeferredAttachmentStageBuild;
}

export type KnowledgeBaseDeferredAttachmentStagePolicyRejection = {
  code:
    | "KNOWLEDGE_BASE_LOGO_UPLOAD_CONFLICT"
    | "KNOWLEDGE_BASE_LOGO_UPLOAD_INVALID";
  message: string;
};

/**
 * Evaluate the byte-authoritative Logo policy shared by normal and resumed
 * deferred staging. Optional display/Provider fields never override the
 * Dashboard-owned size and SHA-256 proof passed here.
 */
export async function inspectKnowledgeBaseDeferredAttachmentStagePolicy(input: {
  build: DeferredAttachmentStageBuild;
  turnId: string;
  attachmentManifest: readonly KnowledgeBaseClientAttachmentManifestItem[];
  index: number;
  fileId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  contentSha256: string;
  validateCapturedImage?: typeof assertCapturedKnowledgeBaseCustomerImage;
}): Promise<KnowledgeBaseDeferredAttachmentStagePolicyRejection | null> {
  const isStartReservation = Boolean(
    input.build.activeTurnId === input.turnId &&
      input.build.revision === 0 &&
      input.build.currentLeafId === null,
  );
  const logoPolicy = knowledgeBaseTurnLogoPolicy({
    providerProtocol: input.build.providerProtocol,
    legacyLogoRequired:
      !isStartReservation &&
      knowledgeBaseBuildRequiresOfficialLogo(input.build),
  });
  const manifestItem = input.attachmentManifest[input.index];
  if (!manifestItem) {
    throw new KnowledgeBaseTurnReservationError(
      "CONFLICT",
      "上传文件与本轮附件清单不一致",
    );
  }
  const authoritativeManifestItem = {
    ...manifestItem,
    sizeBytes: input.sizeBytes,
    sha256: input.contentSha256,
  };
  if (
    logoPolicy.rejectRepeatedOfficialLogo &&
    knowledgeBaseManifestRepeatsOfficialLogo(input.build, [
      authoritativeManifestItem,
    ])
  ) {
    return {
      code: "KNOWLEDGE_BASE_LOGO_UPLOAD_CONFLICT",
      message: "该图片与已绑定的企业主 Logo 完全相同，无需作为普通补图再次上传",
    };
  }
  if (!logoPolicy.requiresOfficialLogo) return null;

  if (
    input.attachmentManifest.length !== 1 ||
    input.index !== 0 ||
    ![
      "image/avif",
      "image/gif",
      "image/jpeg",
      "image/png",
      "image/webp",
    ].includes(input.mimeType)
  ) {
    return {
      code: "KNOWLEDGE_BASE_LOGO_UPLOAD_INVALID",
      message: "当前知识库正在等待企业主 Logo，请只上传一张受支持的图片原文件",
    };
  }
  try {
    await (
      input.validateCapturedImage ?? assertCapturedKnowledgeBaseCustomerImage
    )({
      fileId: input.fileId,
      filename: input.filename,
      mimeType: input.mimeType,
      sizeBytes: input.sizeBytes,
      sourceSha256: input.contentSha256,
    });
  } catch {
    return {
      code: "KNOWLEDGE_BASE_LOGO_UPLOAD_INVALID",
      message: "上传文件不是可安全解码的企业主 Logo 图片，请重新选择原文件",
    };
  }
  return null;
}
