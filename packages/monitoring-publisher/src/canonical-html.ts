import sanitizeHtml from "sanitize-html";
import { sha256Hex } from "./hash.js";
import type {
  CanonicalHtmlOptions,
  CanonicalHtmlResult,
  ContentIssue,
} from "./types.js";

const PUBLISH_TAGS = [
  "p",
  "br",
  "h2",
  "h3",
  "strong",
  "b",
  "em",
  "i",
  "u",
  "blockquote",
  "ul",
  "ol",
  "li",
  "a",
  "img",
  "span",
];

export class PublisherContentError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly httpStatus = 400,
  ) {
    super(message);
    this.name = "PublisherContentError";
  }
}

export type PublisherCanonicalImageReference = {
  assetId: string;
  source: string;
};

/**
 * Reads image references from HTML that has already passed the publisher
 * canonicalizer. Callers must still bind each asset to its owner/article and
 * validate the exact capability before treating a source as trusted.
 */
export function publisherCanonicalImageReferences(
  input: string,
): readonly PublisherCanonicalImageReference[] {
  if (typeof input !== "string" || input.length > 2_000_000) return [];
  const references: PublisherCanonicalImageReference[] = [];
  sanitizeHtml(input, {
    allowedTags: ["img"],
    allowedAttributes: { img: ["src", "data-asset-id"] },
    allowedSchemes: ["http", "https"],
    allowedSchemesByTag: { img: ["http", "https"] },
    allowProtocolRelative: false,
    disallowedTagsMode: "discard",
    enforceHtmlBoundary: true,
    transformTags: {
      img: (_tag, attributes) => {
        const assetId = attributes["data-asset-id"]?.trim() ?? "";
        const source = attributes.src?.trim() ?? "";
        if (assetId && source) {
          try {
            const url = new URL(source);
            if (url.protocol === "http:" || url.protocol === "https:") {
              references.push({ assetId, source });
            }
          } catch {
            // A canonical publisher image never has an invalid URL.
          }
        }
        return { tagName: "img", attribs: {} as sanitizeHtml.Attributes };
      },
    },
  });
  return references;
}

export function canonicalizePublisherHtml(
  input: string,
  options: CanonicalHtmlOptions = {},
): CanonicalHtmlResult {
  if (typeof input !== "string" || input.length > 2_000_000) {
    throw new PublisherContentError(
      "invalid_html",
      "Article HTML must be a string no larger than 2 MiB",
      413,
    );
  }
  const assetIds = new Set(options.allowedAssetIds ?? []);
  const imageOrigins = new Set(options.allowedImageOrigins ?? []);
  const sourcesByAsset = options.allowedImageSourcesByAssetId;
  const warnings: ContentIssue[] = [];
  const blockers: ContentIssue[] = [];
  let images = 0;
  let links = 0;

  const canonicalHtml = sanitizeHtml(input, {
    allowedTags: PUBLISH_TAGS,
    allowedAttributes: {
      a: ["href", "title", "target", "rel"],
      img: ["src", "alt", "data-asset-id"],
      span: ["class", "data-image-error", "data-import-error"],
    },
    allowedClasses: { span: ["content-import-warning"] },
    allowedSchemes: ["http", "https"],
    allowedSchemesByTag: { img: ["http", "https"] },
    allowProtocolRelative: false,
    disallowedTagsMode: "discard",
    enforceHtmlBoundary: true,
    transformTags: {
      h1: "h2",
      h4: "p",
      h5: "p",
      h6: "p",
      a: (_tag, attributes) => {
        const href = normalizeHttpUrl(attributes.href);
        if (!href) {
          warnings.push({
            code: "unsafe_link_removed",
            message: "A non-HTTP(S) or invalid link was removed",
            blocking: false,
            source: "sanitizer",
          });
          return {
            tagName: "span",
            attribs: {} as sanitizeHtml.Attributes,
          };
        }
        links += 1;
        return {
          tagName: "a",
          attribs: {
            href,
            title: trimAttribute(attributes.title, 300),
            target: "_blank",
            rel: "noopener noreferrer nofollow",
          } as sanitizeHtml.Attributes,
        };
      },
      img: (_tag, attributes) => {
        const assetId = attributes["data-asset-id"]?.trim() ?? "";
        const source = attributes.src?.trim() ?? "";
        if (
          !assetIds.has(assetId) ||
          !isTrustedImageSource(source, assetId, sourcesByAsset, imageOrigins)
        ) {
          blockers.push({
            code: "untrusted_image",
            message: "The article contains an unregistered or untrusted image",
            blocking: true,
            source: "sanitizer",
            assetId: assetId || undefined,
          });
          return {
            tagName: "span",
            attribs: {
              class: "content-import-warning",
              "data-image-error": assetId || "unknown",
            } as sanitizeHtml.Attributes,
            text: "[Image failed security validation]",
          };
        }
        images += 1;
        return {
          tagName: "img",
          attribs: {
            src: source,
            alt: trimAttribute(attributes.alt, 300),
            "data-asset-id": assetId,
          } as sanitizeHtml.Attributes,
        };
      },
      span: (_tag, attributes) => {
        const imageError = attributes["data-image-error"]?.trim();
        const importError = attributes["data-import-error"]?.trim();
        if (imageError || importError) {
          blockers.push({
            code: imageError ? "unresolved_image" : "unresolved_import_issue",
            message: imageError
              ? "The article still contains an unresolved image placeholder"
              : "The article still contains an unresolved DOCX import placeholder",
            blocking: true,
            source: "sanitizer",
            assetId:
              imageError && imageError !== "unknown" ? imageError : undefined,
          });
        }
        return {
          tagName: "span",
          attribs: {
            ...(imageError
              ? { "data-image-error": trimAttribute(imageError, 200) }
              : {}),
            ...(importError
              ? { "data-import-error": trimAttribute(importError, 200) }
              : {}),
            ...(imageError || importError
              ? { class: "content-import-warning" }
              : {}),
          } as sanitizeHtml.Attributes,
        };
      },
    },
  })
    .replace(/<p>(?:\s|&nbsp;|<br\s*\/?\s*>)*<\/p>/giu, "")
    .replace(/(?:\r?\n){3,}/gu, "\n\n")
    .trim();

  const plainText = publisherHtmlToPlainText(canonicalHtml);
  if (!plainText && images === 0) {
    blockers.push({
      code: "empty_content",
      message: "Article content must not be empty",
      blocking: true,
      source: "sanitizer",
    });
  }
  return {
    canonicalHtml,
    plainText,
    contentHash: sha256Hex(canonicalHtml),
    containsImages:
      images > 0 || blockers.some((issue) => issue.code.includes("image")),
    stats: {
      characterCount: Array.from(plainText.replace(/\s/gu, "")).length,
      paragraphCount:
        canonicalHtml.match(/<(?:p|h2|h3|blockquote|li)\b/giu)?.length ?? 0,
      linkCount: links,
      imageCount: images,
    },
    warnings: dedupeIssues(warnings),
    blockingIssues: dedupeIssues(blockers),
  };
}

export function publisherHtmlToPlainText(html: string): string {
  return sanitizeHtml(html, { allowedTags: [], allowedAttributes: {} })
    .replace(/&nbsp;/giu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function isTrustedImageSource(
  source: string,
  assetId: string,
  sources: ReadonlyMap<string, Iterable<string>> | undefined,
  origins: ReadonlySet<string>,
): boolean {
  const explicitSources = sources?.get(assetId);
  if (explicitSources) return new Set(explicitSources).has(source);
  try {
    const url = new URL(source);
    return url.protocol === "https:" && origins.has(url.origin);
  } catch {
    return false;
  }
}

function normalizeHttpUrl(value: string | undefined): string | undefined {
  if (!value || value.length > 2_048) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    url.username = "";
    url.password = "";
    return url.toString();
  } catch {
    return undefined;
  }
}

function trimAttribute(value: string | undefined, length: number): string {
  return value?.trim().slice(0, length) ?? "";
}

function dedupeIssues(issues: readonly ContentIssue[]): ContentIssue[] {
  const seen = new Set<string>();
  return issues.filter((issue) => {
    const key = `${issue.code}:${issue.assetId ?? ""}:${issue.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
