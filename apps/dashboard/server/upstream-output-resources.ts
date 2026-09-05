import {
  collectKnowledgeBaseOutputResourceProjections,
  KnowledgeBaseArtifactIdentityError,
} from "./knowledge-base-artifact";

function assertLedgerFileId(fileId: string) {
  if (/[\s/?#\u0000-\u001f\u007f]/u.test(fileId)) {
    throw new KnowledgeBaseArtifactIdentityError(
      "上游文件标识包含不允许的空白或路径字符",
    );
  }
  return fileId;
}

/**
 * Collect only file identities carried by provider-owned typed resources.
 *
 * The resource projection collector is also the ZIP/image trust boundary: it
 * accepts direct provider output resources and direct children of assistant
 * messages, rejects conflicting or oversized identities, and ignores user,
 * tool, reasoning, input, and arbitrary deeply nested objects. Keeping this
 * ledger collector on that same boundary prevents untrusted model-shaped JSON
 * from claiming or pinning an upstream file resource.
 */
export function collectUpstreamOutputFileIds(
  value: unknown,
  options: { ignoreInvalidImageResources?: boolean } = {},
) {
  const ids = new Set<string>();
  for (const projection of collectKnowledgeBaseOutputResourceProjections(
    value,
    {
      ignoreInvalidImageProjections: options.ignoreInvalidImageResources,
    },
  )) {
    if (projection.fileId) ids.add(assertLedgerFileId(projection.fileId));
  }
  return ids;
}
