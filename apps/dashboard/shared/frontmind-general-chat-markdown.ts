export type GeneralChatAssistantArtifactBinding = {
  artifactId: string;
  /** Provider URL attached to the same assistant event. */
  originalUrl: string;
  filename: string;
  mimeType: string;
};

export type GeneralChatAssistantMarkdownPathKind =
  | "exact_attachment_url"
  | "home_path"
  | "mnt_data_path"
  | "sandbox_path"
  | "file_url"
  | "absolute_path"
  | "relative_path"
  | "bare_filename";

export type GeneralChatAssistantMarkdownResult = {
  text: string;
  rewrittenCount: number;
  unresolvedCount: number;
  deduplicatedImageCount: number;
  matchKinds: GeneralChatAssistantMarkdownPathKind[];
  unresolvedKinds: GeneralChatAssistantMarkdownPathKind[];
  unresolvedReasons: Array<"missing" | "ambiguous">;
  /** Raw destinations never leave this helper; callers may hash these values. */
  matchedDestinations: string[];
  unresolvedDestinations: string[];
};

function safeDecode(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function markdownDestination(raw: string) {
  const trimmed = raw.trim();
  if (trimmed.startsWith("<")) {
    const close = trimmed.indexOf(">");
    if (close > 0) return trimmed.slice(1, close);
  }
  const whitespace = trimmed.search(/\s/u);
  return whitespace < 0 ? trimmed : trimmed.slice(0, whitespace);
}

function providerLocalPathKind(
  destination: string,
): Exclude<
  GeneralChatAssistantMarkdownPathKind,
  "exact_attachment_url"
> | null {
  const decoded = safeDecode(destination.trim());
  if (/^\/home(?:\/|$)/u.test(decoded)) return "home_path";
  if (/^\/mnt\/data(?:\/|$)/u.test(decoded)) return "mnt_data_path";
  if (/^sandbox:(?:\/\/)?/iu.test(decoded)) return "sandbox_path";
  if (/^file:(?:\/\/)?/iu.test(decoded)) return "file_url";
  if (/^\//u.test(decoded)) return "absolute_path";
  if (/^\.\.?\//u.test(decoded)) return "relative_path";
  if (
    decoded.length > 0 &&
    !decoded.includes("/") &&
    !decoded.includes("\\") &&
    !decoded.startsWith("#") &&
    !/^[a-z][a-z0-9+.-]*:/iu.test(decoded)
  ) {
    return "bare_filename";
  }
  return null;
}

function providerLocalBasename(destination: string) {
  let decoded = safeDecode(destination.trim()).replaceAll("\\", "/");
  decoded = decoded.replace(/^sandbox:(?:\/\/)?/iu, "");
  decoded = decoded.replace(/^file:(?:\/\/)?/iu, "");
  const query = decoded.search(/[?#]/u);
  if (query >= 0) decoded = decoded.slice(0, query);
  const basename = decoded.split("/").filter(Boolean).at(-1) ?? "";
  return safeDecode(basename);
}

function artifactContentUrl(artifactId: string) {
  return `/api/frontmind/v2/artifacts/${encodeURIComponent(artifactId)}/content`;
}

/**
 * Rewrites only links that can be proven to reference an artifact localized
 * from the same Provider assistant event. Provider-local paths that cannot be
 * proven are rendered as plain text instead of becoming Dashboard navigation.
 */
export function canonicalizeGeneralChatAssistantMarkdown(
  text: string,
  bindings: readonly GeneralChatAssistantArtifactBinding[],
): GeneralChatAssistantMarkdownResult {
  let rewrittenCount = 0;
  let unresolvedCount = 0;
  let deduplicatedImageCount = 0;
  const matchKinds: GeneralChatAssistantMarkdownPathKind[] = [];
  const unresolvedKinds: GeneralChatAssistantMarkdownPathKind[] = [];
  const unresolvedReasons: Array<"missing" | "ambiguous"> = [];
  const matchedDestinations: string[] = [];
  const unresolvedDestinations: string[] = [];

  const canonical = text.replace(
    /(!?)\[([^\]\n]*)\]\(([^)\n]+)\)/gu,
    (node, imagePrefix: string, label: string, rawDestination: string) => {
      const destination = markdownDestination(rawDestination);
      const exact = bindings.filter(
        (binding) => binding.originalUrl.trim() === destination,
      );
      const localKind = providerLocalPathKind(destination);
      let candidates = exact;
      let matchKind: GeneralChatAssistantMarkdownPathKind | null = null;
      if (exact.length > 0) {
        matchKind = "exact_attachment_url";
      } else if (localKind) {
        const basename = providerLocalBasename(destination);
        candidates = bindings.filter(
          (binding) => providerLocalBasename(binding.filename) === basename,
        );
        matchKind = localKind;
      } else {
        return node;
      }

      if (candidates.length !== 1 || !matchKind) {
        unresolvedCount += 1;
        unresolvedKinds.push(matchKind ?? localKind ?? "bare_filename");
        unresolvedReasons.push(candidates.length > 1 ? "ambiguous" : "missing");
        unresolvedDestinations.push(destination);
        return label;
      }

      const binding = candidates[0]!;
      rewrittenCount += 1;
      matchKinds.push(matchKind);
      matchedDestinations.push(destination);
      if (imagePrefix && binding.mimeType.toLowerCase().startsWith("image/")) {
        deduplicatedImageCount += 1;
        return "";
      }
      return `${imagePrefix}[${label}](${artifactContentUrl(binding.artifactId)})`;
    },
  );

  return {
    text: canonical,
    rewrittenCount,
    unresolvedCount,
    deduplicatedImageCount,
    matchKinds,
    unresolvedKinds,
    unresolvedReasons,
    matchedDestinations,
    unresolvedDestinations,
  };
}
