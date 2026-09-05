export type PublicationMode = "mock" | "test" | "live";

export type PublicationItemStatus =
  | "queued"
  | "submitting"
  | "processing"
  | "success"
  | "failed"
  | "auth_blocked"
  | "submission_unknown"
  | "action_required";

export type PublicationBatchStatus =
  | "queued"
  | "processing"
  | "success"
  | "failed"
  | "partial_success"
  | "action_required";

export type PublicationFundsStatus =
  "reserved" | "frozen" | "consumed" | "released";

export interface ContentIssue {
  code: string;
  message: string;
  blocking: boolean;
  assetId?: string;
  ordinal?: number;
  source?: "validation" | "image" | "conversion" | "sanitizer";
}

export interface CanonicalHtmlResult {
  canonicalHtml: string;
  plainText: string;
  contentHash: string;
  containsImages: boolean;
  stats: {
    characterCount: number;
    paragraphCount: number;
    linkCount: number;
    imageCount: number;
  };
  warnings: readonly ContentIssue[];
  blockingIssues: readonly ContentIssue[];
}

export interface CanonicalHtmlOptions {
  allowedAssetIds?: Iterable<string>;
  allowedImageSourcesByAssetId?: ReadonlyMap<string, Iterable<string>>;
  allowedImageOrigins?: Iterable<string>;
}

export interface ValidatedDocx {
  bytes: Uint8Array;
  fileName: string;
  sourceSha256: string;
  suggestedTitle: string;
  referencedBodyImageCount: number;
  warnings: readonly ContentIssue[];
  blockingIssues: readonly ContentIssue[];
}

export interface NormalizedPublisherImage {
  bytes: Uint8Array;
  sha256: string;
  mimeType: "image/jpeg" | "image/png";
  width: number;
  height: number;
  warnings: readonly ContentIssue[];
}

export interface PersistedDocxImage {
  assetId: string;
  src: string;
  storageKey?: string;
  capability?: string;
}

export interface ImportedDocxImage extends PersistedDocxImage {
  ordinal: number;
  sha256: string;
  mimeType: "image/jpeg" | "image/png";
  width: number;
  height: number;
  sizeBytes: number;
}

export interface DocxImportReport {
  fileName: string;
  sourceSha256: string;
  suggestedTitle: string;
  canonicalHtml: string;
  plainText: string;
  contentHash: string;
  containsImages: boolean;
  images: readonly ImportedDocxImage[];
  warnings: readonly ContentIssue[];
  blockingIssues: readonly ContentIssue[];
  stats: CanonicalHtmlResult["stats"];
}
