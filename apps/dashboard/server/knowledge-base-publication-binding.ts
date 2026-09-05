type KnowledgeBasePublicationBinding = {
  packageArchiveSha256?: string | null;
  packageDescriptorHash?: string | null;
};

type KnowledgeBasePackageWriterBinding = {
  id: string;
  generation: number;
  executionMode?: string | null;
  canonicalTaskId?: string | null;
  upstreamTaskId?: string | null;
};

/**
 * Materialized builds deliberately release every Provider task after the
 * returned Working Set has been localized.  The final customer package is
 * therefore bound to a stable Dashboard identity, not to the transient task
 * that happened to generate the first bundle or latest patch.
 */
export function knowledgeBasePackageWriterTaskId(
  build: KnowledgeBasePackageWriterBinding,
) {
  if (build.executionMode === "materialized_bundle_v1") {
    return `dashboard-materialized:${build.id}:${build.generation}`;
  }
  return String(build.canonicalTaskId || build.upstreamTaskId || "");
}

/**
 * New builds are bound to immutable ZIP bytes. Historical builds did not keep
 * those bytes and therefore retain their descriptor-hash compatibility path.
 * Every publish caller and the final row-lock CAS must use this same choice.
 */
export function knowledgeBasePublicationBindingHash(
  build: KnowledgeBasePublicationBinding,
) {
  const archiveHash = String(build.packageArchiveSha256 || "").toLowerCase();
  if (/^[a-f0-9]{64}$/u.test(archiveHash)) return archiveHash;
  const descriptorHash = String(
    build.packageDescriptorHash || "",
  ).toLowerCase();
  return /^[a-f0-9]{64}$/u.test(descriptorHash) ? descriptorHash : null;
}
