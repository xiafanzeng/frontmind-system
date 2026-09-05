export const SITEOPS_COMPOSER_LOCAL_UPLOAD_HEADERS = {
  scope: "X-FrontMind-SiteOps-Upload-Scope",
  clientRequestId: "X-FrontMind-SiteOps-Client-Request-Id",
  contentSha256: "X-FrontMind-SiteOps-Content-SHA256",
  ordinal: "X-FrontMind-SiteOps-Ordinal",
} as const;

export const SITEOPS_COMPOSER_LOCAL_UPLOAD_SCOPE = "composer-v1" as const;

export type SiteOpsComposerLocalUploadCoordinate = {
  clientRequestId: string;
  contentSha256: string;
  ordinal: number;
};

/** These coordinates are an idempotency identity, never an asset capability. */
export function siteOpsComposerLocalUploadHeaders(
  coordinate: SiteOpsComposerLocalUploadCoordinate,
): Record<string, string> {
  return {
    [SITEOPS_COMPOSER_LOCAL_UPLOAD_HEADERS.scope]:
      SITEOPS_COMPOSER_LOCAL_UPLOAD_SCOPE,
    [SITEOPS_COMPOSER_LOCAL_UPLOAD_HEADERS.clientRequestId]:
      coordinate.clientRequestId,
    [SITEOPS_COMPOSER_LOCAL_UPLOAD_HEADERS.contentSha256]:
      coordinate.contentSha256,
    [SITEOPS_COMPOSER_LOCAL_UPLOAD_HEADERS.ordinal]: String(coordinate.ordinal),
  };
}
