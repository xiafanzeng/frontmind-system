import type { DecryptedCredential } from "./auth-service";
import { findRetainedKnowledgeBaseLocalAsset } from "./knowledge-base-deferred-upload-recovery";
import { persistKnowledgeBaseBuildSource } from "./knowledge-base-local-source-store";
import {
  applyKnowledgeBaseRevisionWorkingSet,
  readActiveKnowledgeBaseWorkingSet,
} from "./knowledge-base-materialized-service";
import { validateKnowledgeBaseWorkingSetArchive } from "./knowledge-base-materialized-contract";
import {
  beginKnowledgeBaseManusV2Dispatch,
  bindKnowledgeBaseManusV2Submission,
  failKnowledgeNodeEdit,
  freezeKnowledgeBaseTurnAttachments,
  recordKnowledgeNodeEditPatch,
  type KnowledgeBaseRecoveryClaim,
} from "./knowledge-base-turn-service";
import {
  createKnowledgeNodeEditPatch,
  knowledgeNodeEditPrompt,
  KNOWLEDGE_NODE_IMAGE_MIMES,
  nodeEditSha256,
} from "./knowledge-node-edit-contract";
import {
  KnowledgeNodeEditProvider,
  findKnowledgeNodeEditorResources,
} from "./providers/knowledge-node-edit-provider";
import { getEnterpriseProjectScope } from "./enterprise-project-scope";

/** Uses the ordinary reservation/upload/CAS ledger, but never prepares a Skill
 * or uploads a Working Set. Recovery can read the same paid session; it cannot
 * start a second model command for this turn. */
export async function dispatchKnowledgeNodeEdit(
  claim: KnowledgeBaseRecoveryClaim,
  credential: DecryptedCredential,
) {
  const identity = {
    userId: claim.turn.userId,
    turnId: claim.turn.id,
    leaseToken: claim.leaseToken,
  };
  try {
    if (
      claim.recoveryMetadata.nodeEditMode !== "low_v1" ||
      claim.turn.operationType !== "revise"
    )
      throw new Error("KNOWLEDGE_NODE_EDIT_MODE_INVALID");
    const active = await readActiveKnowledgeBaseWorkingSet({
      userId: claim.turn.userId,
      buildId: claim.turn.buildId,
      generation: claim.turn.buildGeneration,
    });
    const scope = getEnterpriseProjectScope();
    if (
      scope &&
      (scope.ownerUserId !== claim.turn.userId ||
        (active.build.enterpriseProjectId !== scope.enterpriseProjectId &&
          !(
            scope.isLegacyDefault && active.build.enterpriseProjectId === null
          )))
    )
      throw new Error("ENTERPRISE_PROJECT_OWNER_MISMATCH");
    const base = await validateKnowledgeBaseWorkingSetArchive(active.bytes, {
      buildId: active.build.id,
      generation: active.build.generation,
      contentVersion: active.build.contentVersion,
      skillContentHash: active.build.skillContentHash ?? undefined,
      companyName: active.build.companyName,
      companyWebsite: active.build.companyWebsite,
    });
    const leaf = base.manifest.leaves.find(
      (item) => item.leafId === claim.turn.expectedLeafId,
    );
    if (
      !leaf ||
      active.build.currentLeafId !== leaf.leafId ||
      active.build.activeTurnId !== claim.turn.id
    )
      throw new Error("KNOWLEDGE_NODE_EDIT_TARGET_CHANGED");
    const attachments = (claim.recoveryMetadata.attachments ?? []) as Array<{
      file_id: string;
      filename: string;
    }>;
    const manifest = (claim.recoveryMetadata.attachmentManifest ??
      []) as Array<{
      filename: string;
      mimeType: string;
      sizeBytes: number;
      sha256?: string;
    }>;
    if (attachments.length !== manifest.length)
      throw new Error("KNOWLEDGE_NODE_EDIT_ATTACHMENT_MISMATCH");
    const images: Array<{ bytes: Buffer; sha256: string; mimeType: string }> =
      [];
    const proofs: Array<{
      index: number;
      fileId: string;
      contentSha256: string;
      sizeBytes: number;
      mimeType: string;
      localStorageKey: string;
      sourceWorkingSetId?: string;
      sourceAssetId?: string;
    }> = [];
    for (let index = 0; index < attachments.length; index += 1) {
      const attachment = attachments[index]!;
      const item = manifest[index]!;
      if (
        !KNOWLEDGE_NODE_IMAGE_MIMES.includes(
          item.mimeType as (typeof KNOWLEDGE_NODE_IMAGE_MIMES)[number],
        )
      )
        throw new Error("KNOWLEDGE_NODE_EDIT_IMAGES_ONLY");
      const local = await findRetainedKnowledgeBaseLocalAsset({
        userId: claim.turn.userId,
        localAssetId: attachment.file_id,
        filename: item.filename,
        mimeType: item.mimeType,
        sizeBytes: item.sizeBytes,
        sha256: item.sha256,
        includeBytes: true,
      });
      if (!local?.bytes) throw new Error("KNOWLEDGE_NODE_EDIT_IMAGE_MISSING");
      const retained = await persistKnowledgeBaseBuildSource({
        userId: claim.turn.userId,
        buildId: claim.turn.buildId,
        generation: claim.turn.buildGeneration,
        bytes: local.bytes,
      });
      images.push({
        bytes: local.bytes,
        sha256: local.contentSha256,
        mimeType: item.mimeType,
      });
      proofs.push({
        index,
        fileId: attachment.file_id,
        contentSha256: local.contentSha256,
        sizeBytes: local.bytes.length,
        mimeType: item.mimeType,
        localStorageKey: retained.storageKey,
      });
    }
    const selectedAssetIds = Array.isArray(
      claim.recoveryMetadata.selectedAssetIds,
    )
      ? (claim.recoveryMetadata.selectedAssetIds as string[])
      : [];
    for (const assetId of [...new Set(selectedAssetIds)]) {
      const asset = base.manifest.assets.find(
        (item) => item.assetId === assetId,
      );
      if (
        !asset ||
        asset.provenance.sourceKind !== "user_upload" ||
        asset.provenance.ownership !== "first_party"
      )
        throw new Error("KNOWLEDGE_NODE_EDIT_IMAGE_OWNERSHIP");
      if (
        images.some((image) => image.sha256 === asset.sha256) ||
        leaf.assetIds.includes(assetId)
      )
        continue;
      const bytes = base.files.get(asset.path);
      if (!bytes || nodeEditSha256(bytes) !== asset.sha256)
        throw new Error("KNOWLEDGE_NODE_EDIT_IMAGE_MISSING");
      images.push({ bytes, sha256: asset.sha256, mimeType: asset.mimeType });
      proofs.push({
        index: proofs.length,
        fileId: `working-set:${active.workingSet.id}:${assetId}`,
        contentSha256: asset.sha256,
        sizeBytes: bytes.length,
        mimeType: asset.mimeType,
        localStorageKey: active.workingSet.storageKey,
        sourceWorkingSetId: active.workingSet.id,
        sourceAssetId: assetId,
      });
    }
    await freezeKnowledgeBaseTurnAttachments({
      ...identity,
      attachmentFileIds: attachments.map((item) => item.file_id),
    });
    const instruction = String(claim.recoveryMetadata.userMessage ?? "").trim();
    const removeAssetIds = Array.isArray(claim.recoveryMetadata.removeAssetIds)
      ? (claim.recoveryMetadata.removeAssetIds as string[])
      : [];
    if (!instruction && images.length === 0 && removeAssetIds.length === 0)
      throw new Error("KNOWLEDGE_NODE_EDIT_EMPTY");
    let contentMarkdown = base.files.get(leaf.contentPath)!.toString("utf8");
    let providerTaskId: string | null = null;
    if (instruction) {
      if (credential.provider !== "zhipu")
        throw new Error("KNOWLEDGE_NODE_EDIT_ZHIPU_REQUIRED");
      const prompt = knowledgeNodeEditPrompt(contentMarkdown, instruction);
      if (
        !claim.turn.upstreamTaskId &&
        claim.turn.createAttemptState === "not_sent"
      ) {
        await beginKnowledgeBaseManusV2Dispatch({
          ...identity,
          frozenProviderRequestHash: nodeEditSha256(prompt),
        });
      }
      const providerIdentity = {
        provider: "zhipu" as const,
        accountUserId: claim.turn.userId,
        enterpriseProjectId:
          scope?.enterpriseProjectId ?? active.build.enterpriseProjectId,
        enterpriseProjectLegacyDefault: scope?.isLegacyDefault,
        credentialId: credential.id,
        credentialVersion: credential.version,
        credentialOwnerUserId: credential.userId,
      };
      const reusableResources =
        await findKnowledgeNodeEditorResources(providerIdentity);
      const provider = new KnowledgeNodeEditProvider({
        apiKey: credential.apiKey,
        identity: providerIdentity,
        reusableResources,
      });
      const output = await provider.edit({
        intentId: `knowledge-node-edit:${claim.turn.id}`,
        prompt,
        onSession: async (sessionId) => {
          if (claim.turn.upstreamTaskId) {
            if (claim.turn.upstreamTaskId !== sessionId)
              throw new Error("KNOWLEDGE_NODE_EDIT_SESSION_CONFLICT");
          } else {
            await bindKnowledgeBaseManusV2Submission({
              ...identity,
              method: "task.create",
              taskId: sessionId,
            });
          }
        },
      });
      contentMarkdown = output.contentMarkdown;
      providerTaskId = output.sessionId;
    }
    const archiveBytes = await createKnowledgeNodeEditPatch({
      base,
      operationId: claim.turn.operationKey,
      targetLeafId: leaf.leafId,
      contentMarkdown,
      images,
      removeAssetIds,
    });
    await recordKnowledgeNodeEditPatch({
      ...identity,
      patchSha256: nodeEditSha256(archiveBytes),
      providerTaskId,
      attachmentSourceProofs: proofs,
    });
    await applyKnowledgeBaseRevisionWorkingSet({
      userId: claim.turn.userId,
      buildId: claim.turn.buildId,
      generation: claim.turn.buildGeneration,
      turnId: claim.turn.id,
      operationId: claim.turn.operationKey,
      providerTaskId,
      resultSource: "local_node_edit",
      targetLeafId: leaf.leafId,
      archiveBytes,
    });
    return { taskId: providerTaskId, rebound: false, reconciled: true };
  } catch (error) {
    const message =
      error instanceof Error && /BALANCE|INSUFFICIENT/i.test(error.message)
        ? "账户余额不足，本次修改未保存，原节点内容已保留。充值后可重新提交修改。"
        : "本次节点修改未能安全保存，原节点内容已保留。没有自动重跑或升级模型，请检查修改要求后重新提交。";
    await failKnowledgeNodeEdit({ ...identity, message });
    return {
      taskId: claim.turn.upstreamTaskId,
      rebound: false,
      reconciled: true,
    };
  }
}
