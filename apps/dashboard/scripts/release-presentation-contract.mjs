export function normalizeReleasePresentation(value) {
  if (!value || typeof value !== "object") {
    throw new Error("FRONTMIND_RELEASE_PRESENTATION_INVALID");
  }
  const releaseChannel = String(value.releaseChannel || "")
    .trim()
    .toLowerCase();
  if (releaseChannel !== "development" && releaseChannel !== "production") {
    throw new Error("FRONTMIND_RELEASE_CHANNEL_INVALID");
  }
  const websiteUrl = String(value.websiteUrl || "").trim();
  let parsedWebsiteUrl;
  try {
    parsedWebsiteUrl = new URL(websiteUrl);
  } catch {
    throw new Error("FRONTMIND_WEBSITE_URL_INVALID");
  }
  if (
    parsedWebsiteUrl.protocol !== "https:" ||
    parsedWebsiteUrl.username ||
    parsedWebsiteUrl.password ||
    parsedWebsiteUrl.pathname !== "/" ||
    parsedWebsiteUrl.search ||
    parsedWebsiteUrl.hash
  ) {
    throw new Error("FRONTMIND_WEBSITE_URL_INVALID");
  }
  const documentTitle = String(value.documentTitle || "").trim();
  if (!documentTitle || /[<>&]/u.test(documentTitle)) {
    throw new Error("FRONTMIND_DOCUMENT_TITLE_INVALID");
  }
  if (typeof value.preventIndexing !== "boolean") {
    throw new Error("FRONTMIND_INDEXING_POLICY_INVALID");
  }
  return {
    releaseChannel,
    websiteUrl: parsedWebsiteUrl.toString().replace(/\/$/u, ""),
    documentTitle,
    preventIndexing: value.preventIndexing,
  };
}
