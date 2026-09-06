export type ContentQuotaPool =
  | "content_asset_publish"
  | "website_content_publish";

export const CONTENT_QUOTA_LIMITS = Object.freeze({
  basic: Object.freeze({
    content_asset_publish: 1,
    website_content_publish: 0,
  }),
  knowledge: Object.freeze({
    content_asset_publish: 0,
    website_content_publish: 0,
  }),
  advanced: Object.freeze({
    content_asset_publish: 5,
    website_content_publish: 20,
  }),
  luxury: Object.freeze({
    content_asset_publish: 20,
    website_content_publish: 100,
  }),
});
