export type KolPublicationMode = "mock" | "test" | "live";
export type KolCreateOrderEncoding = "json" | "form" | "unknown";

export interface KolPagination {
  currentPage: number;
  lastPage: number;
  perPage: number;
  total: number;
}

export type KolMediaKind = "news" | "self_media";

/**
 * Normalized catalog fields that may be persisted by the server. Supplier-tier
 * prices are intentionally not represented here, which makes accidental API
 * exposure considerably harder. `price` is the provider's customer market
 * price used by FrontMind media-publishing quotes.
 */
export interface KolResource {
  id: number;
  name: string;
  platform?: string;
  taxonomy?: string;
  mediaType?: string;
  kind: KolMediaKind;
  area?: string;
  caseUrl?: string;
  titleLimit?: number;
  price?: string;
  pcWeight?: string;
  mobileWeight?: string;
  successRate?: string;
  includeRate?: string;
  publishTime?: string;
  includeType?: string;
  linkType?: string;
  entryUrl?: string;
  entryLevel?: string;
  logo?: string;
  icon?: string;
  remark?: string;
  description?: string;
  recommended?: boolean;
  recommendationTags?: string[];
  platformRecommendationTags?: string[];
  recommendationRemark?: string;
  authenticationType?: string;
  authenticationDescription?: string;
  isSelfMedia: boolean;
  authenticated?: boolean;
  festivalPublishable?: boolean;
  fanCount?: bigint;
  likeCount?: bigint;
  publishCount?: bigint;
  raw: Readonly<Record<string, unknown>>;
}

export interface KolResourcePage {
  resources: readonly KolResource[];
  pagination: KolPagination;
}

export interface KolCreateOrderInput {
  resourceId: number;
  title: string;
  html: string;
}

export interface KolCreateOrderResult {
  orderId: string;
  resourceId: number;
  resourceName: string;
  paidAt?: string | number;
  message?: string;
  raw: Readonly<Record<string, unknown>>;
}

export type KolOrderStatus = "processing" | "success" | "failed" | "unknown";

export interface KolOrder {
  id: number;
  resourceId: number;
  orderId: string;
  title: string;
  status: KolOrderStatus;
  providerStatus: number;
  responseMessage?: string;
  reportedPrice?: string;
  resourceName?: string;
  manuscriptId?: string;
  createdAt?: number;
  updatedAt?: number;
  publishedUrl?: string;
  failureReason?: string;
  raw: Readonly<Record<string, unknown>>;
}

export interface KolOrderPage {
  orders: readonly KolOrder[];
  pagination?: KolPagination;
}

export interface KolOrderQuery {
  page?: number;
  id?: number;
  orderId?: string;
}

export interface KolProviderPort {
  readonly mode: KolPublicationMode;
  listResources(page?: number, signal?: AbortSignal): Promise<KolResourcePage>;
  createOrder(
    input: KolCreateOrderInput,
    signal?: AbortSignal,
  ): Promise<KolCreateOrderResult>;
  listOrders(
    query?: KolOrderQuery,
    signal?: AbortSignal,
  ): Promise<KolOrderPage>;
  getOrderByOrderId(
    orderId: string,
    signal?: AbortSignal,
  ): Promise<KolOrder | undefined>;
}

export interface KolClientOptions {
  baseUrl: string;
  /**
   * Pre-issued Worker-only token. When present, the client never calls the
   * provider authentication endpoint and never falls back to account login.
   */
  accessToken?: string;
  apiKey?: string;
  mobile?: string;
  password?: string;
  identity?: string;
  captcha?: string;
  captchaToken?: string;
  mode: Exclude<KolPublicationMode, "mock">;
  realEnabled?: boolean;
  publishEnabled?: boolean;
  createOrderEncoding?: KolCreateOrderEncoding;
  testResourceId?: number;
  timeoutMs?: number;
  maxGetAttempts?: number;
  getRetryBaseMs?: number;
  maxResponseBytes?: number;
  tokenRefreshSkewMs?: number;
  userAgent?: string;
  fetch?: typeof fetch;
  now?: () => Date;
  sleep?: (milliseconds: number) => Promise<void>;
}
