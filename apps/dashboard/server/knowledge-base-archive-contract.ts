/**
 * Contract for a newly produced archive. Builder v4 must never emit a legacy
 * schema even though older production releases accepted one while v4 rolled
 * out.
 */
export function knowledgeBaseArchiveWriteContractVersions(
  skillVersion: string,
) {
  if (skillVersion === "1") return undefined;
  if (skillVersion === "4") return [4] as const;
  return [2, 3] as const;
}

/**
 * Compatibility contract for an archive that was already accepted by an
 * earlier production release. This is used only for durable reads,
 * publication and PACKAGE_REBIND_REQUIRED recovery; it must not be used by the
 * final-turn write path.
 */
export function knowledgeBaseArchiveReadContractVersions(skillVersion: string) {
  if (skillVersion === "1") return undefined;
  if (skillVersion === "4") return [3, 4] as const;
  return [2, 3] as const;
}

/**
 * Customer-upload bytes and exact Logo provenance are schema-v4 contracts,
 * not properties of every build that happened to run Skill v4. Historical
 * Skill-v4/schema-v3 archives predate that evidence contract and must retain
 * their original buildRevision, raw-ID, order and unique-Logo checks without
 * attempting to manufacture v4 evidence during a read.
 */
export function knowledgeBaseArchiveRequiresV4UploadEvidence(
  skillVersion: string,
  packageSchemaVersion: unknown,
) {
  return skillVersion === "4" && packageSchemaVersion === 4;
}
