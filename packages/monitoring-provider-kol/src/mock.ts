import { randomUUID } from "node:crypto";
import type {
  KolCreateOrderInput,
  KolOrder,
  KolOrderPage,
  KolOrderQuery,
  KolProviderPort,
  KolResource,
  KolResourcePage,
} from "./types.js";

export class MockKolClient implements KolProviderPort {
  readonly mode = "mock" as const;
  private readonly orders = new Map<string, KolOrder>();

  constructor(
    private readonly resources: readonly KolResource[] = defaultResources(),
    private readonly now: () => Date = () => new Date(),
  ) {}

  async listResources(page = 1): Promise<KolResourcePage> {
    if (!Number.isInteger(page) || page < 1)
      throw new TypeError("page is invalid");
    const perPage = 50;
    return {
      resources: this.resources.slice((page - 1) * perPage, page * perPage),
      pagination: {
        currentPage: page,
        lastPage: Math.max(1, Math.ceil(this.resources.length / perPage)),
        perPage,
        total: this.resources.length,
      },
    };
  }

  async createOrder(input: KolCreateOrderInput) {
    if (!Number.isInteger(input.resourceId) || input.resourceId < 1)
      throw new TypeError("resourceId is invalid");
    if (!input.title.trim() || !input.html.trim())
      throw new TypeError("title and html are required");
    const now = this.now();
    const resource = this.resources.find(
      (item) => item.id === input.resourceId,
    );
    const orderId = `mock-v1.${input.resourceId}.${now.valueOf()}.${randomUUID()}`;
    const order: KolOrder = {
      id: this.orders.size + 1,
      resourceId: input.resourceId,
      orderId,
      title: input.title.trim(),
      status: "success",
      providerStatus: 1,
      responseMessage: `https://mock.kol.invalid/publications/${encodeURIComponent(orderId)}`,
      reportedPrice: resource?.price ?? "0",
      resourceName: resource?.name ?? "Mock media",
      createdAt: Math.floor(now.valueOf() / 1_000),
      updatedAt: Math.floor(now.valueOf() / 1_000),
      publishedUrl: `https://mock.kol.invalid/publications/${encodeURIComponent(orderId)}`,
      raw: Object.freeze({ mock: true }),
    };
    this.orders.set(orderId, order);
    return {
      orderId,
      resourceId: input.resourceId,
      resourceName: order.resourceName ?? "Mock media",
      message: "Mock order accepted",
      raw: Object.freeze({ mock: true }),
    };
  }

  async listOrders(query: KolOrderQuery = {}): Promise<KolOrderPage> {
    const orders = [...this.orders.values()].filter(
      (order) =>
        (query.id === undefined || order.id === query.id) &&
        (query.orderId === undefined || order.orderId === query.orderId),
    );
    return { orders };
  }

  async getOrderByOrderId(orderId: string): Promise<KolOrder | undefined> {
    return this.orders.get(orderId);
  }
}

function defaultResources(): KolResource[] {
  return [
    {
      id: 1,
      name: "Mock 技术媒体",
      platform: "网站",
      taxonomy: "科技",
      kind: "news",
      area: "全国",
      titleLimit: 60,
      price: "8.00",
      successRate: "98",
      isSelfMedia: false,
      raw: Object.freeze({ mock: true }),
    },
    {
      id: 2,
      name: "Mock 自媒体",
      platform: "公众号",
      taxonomy: "商业",
      kind: "self_media",
      area: "全国",
      titleLimit: 64,
      price: "12.00",
      successRate: "96",
      isSelfMedia: true,
      fanCount: 120_000n,
      likeCount: 8_500n,
      publishCount: 1_280n,
      raw: Object.freeze({ mock: true }),
    },
  ];
}
