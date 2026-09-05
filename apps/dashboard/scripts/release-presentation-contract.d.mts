export type ReleasePresentation = {
  releaseChannel: "development" | "production";
  websiteUrl: string;
  documentTitle: string;
  preventIndexing: boolean;
};

export function normalizeReleasePresentation(
  value: unknown,
): ReleasePresentation;
