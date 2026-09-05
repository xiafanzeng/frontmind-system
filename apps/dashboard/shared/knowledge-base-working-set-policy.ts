import { GENERATED_KNOWLEDGE_BASE_WORKING_SET_POLICY } from "./knowledge-base-working-set-policy.generated";

export const KNOWLEDGE_BASE_WORKING_SET_POLICY =
  GENERATED_KNOWLEDGE_BASE_WORKING_SET_POLICY;

export type KnowledgeBaseWorkingSetPolicyWarning = Readonly<{
  code: string;
  area?: string;
}>;

export type KnowledgeBaseWorkingSetPolicyProbe = Readonly<{
  archive?: Readonly<{
    compressedBytes: number;
    entries: ReadonlyArray<
      Readonly<{ compressedBytes: number; uncompressedBytes: number }>
    >;
  }>;
  evidence?: Readonly<{
    path: string;
    mimeType?: string | null;
    present?: boolean;
    digestMatches?: boolean;
    utf8?: boolean;
    nonEmpty?: boolean;
  }>;
  authority?: Readonly<{
    mode: "initial" | "revision";
    field: string;
    matches: boolean;
  }>;
}>;

export type KnowledgeBaseWorkingSetPolicyProbeResult = Readonly<{
  accepted: boolean;
  retained: readonly string[];
  dropped: readonly string[];
  warnings: readonly KnowledgeBaseWorkingSetPolicyWarning[];
  hardFailure: string | null;
}>;

const evidenceExtensions = new Set<string>(
  KNOWLEDGE_BASE_WORKING_SET_POLICY.evidence.textExtensions,
);
const evidenceMimeTypes = new Set<string>(
  KNOWLEDGE_BASE_WORKING_SET_POLICY.evidence.textMimeTypes,
);

function normalizedMediaType(value: string | null | undefined) {
  return value?.split(";", 1)[0]?.trim().toLowerCase() || null;
}

export function isKnowledgeBaseTextEvidencePath(path: string) {
  const extension = path.match(/\.[^.\/]+$/u)?.[0]?.toLowerCase() ?? "";
  return evidenceExtensions.has(extension);
}

export function evaluateKnowledgeBaseArchivePolicy(
  archive: NonNullable<KnowledgeBaseWorkingSetPolicyProbe["archive"]>,
) {
  const limits = KNOWLEDGE_BASE_WORKING_SET_POLICY.archive;
  const totalUncompressedBytes = archive.entries.reduce(
    (total, entry) => total + entry.uncompressedBytes,
    0,
  );
  const ratioInvalid = archive.entries.some(
    (entry) =>
      entry.uncompressedBytes > 0 &&
      (entry.compressedBytes <= 0 ||
        entry.uncompressedBytes / entry.compressedBytes >
          limits.maxCompressionRatio),
  );
  return (
    archive.compressedBytes > 0 &&
    archive.compressedBytes <= limits.maxCompressedBytes &&
    archive.entries.length > 0 &&
    archive.entries.length <= limits.maxEntryCount &&
    totalUncompressedBytes <= limits.maxUncompressedBytes &&
    !ratioInvalid
  );
}

export function probeKnowledgeBaseWorkingSetPolicy(
  input: KnowledgeBaseWorkingSetPolicyProbe,
): KnowledgeBaseWorkingSetPolicyProbeResult {
  const retained: string[] = [];
  const dropped: string[] = [];
  const warnings: KnowledgeBaseWorkingSetPolicyWarning[] = [];
  if (input.archive && !evaluateKnowledgeBaseArchivePolicy(input.archive)) {
    return {
      accepted: false,
      retained,
      dropped,
      warnings,
      hardFailure: "archiveSafety",
    };
  }
  if (input.authority && !input.authority.matches) {
    const authorityPolicy =
      KNOWLEDGE_BASE_WORKING_SET_POLICY.authority[input.authority.mode];
    if (
      (authorityPolicy.hard as readonly string[]).includes(
        input.authority.field,
      )
    ) {
      return {
        accepted: false,
        retained,
        dropped,
        warnings,
        hardFailure: input.authority.field,
      };
    }
    if (
      (authorityPolicy.serverOwned as readonly string[]).includes(
        input.authority.field,
      )
    ) {
      warnings.push(
        KNOWLEDGE_BASE_WORKING_SET_POLICY.warnings.serverCoordinateNormalized,
      );
    }
  }
  if (input.evidence) {
    const evidence = input.evidence;
    const mediaType = normalizedMediaType(evidence.mimeType);
    if (!isKnowledgeBaseTextEvidencePath(evidence.path)) {
      dropped.push(evidence.path);
      warnings.push(
        KNOWLEDGE_BASE_WORKING_SET_POLICY.evidence.optionalBinary.warning,
      );
    } else if (
      (mediaType !== null && !evidenceMimeTypes.has(mediaType)) ||
      evidence.present === false ||
      evidence.digestMatches === false ||
      evidence.utf8 === false ||
      evidence.nonEmpty === false
    ) {
      dropped.push(evidence.path);
      warnings.push(
        KNOWLEDGE_BASE_WORKING_SET_POLICY.evidence.optionalInvalidText.warning,
      );
    } else {
      retained.push(evidence.path);
    }
  }
  return { accepted: true, retained, dropped, warnings, hardFailure: null };
}
