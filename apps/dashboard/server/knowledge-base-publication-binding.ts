type KnowledgeBasePublicationBinding = {
  packageArchiveSha256?: string | null;
  packageDescriptorHash?: string | null;
};

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
  const descriptorHash = String(build.packageDescriptorHash || "").toLowerCase();
  return /^[a-f0-9]{64}$/u.test(descriptorHash) ? descriptorHash : null;
}
