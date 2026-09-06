// @vitest-environment node
import { expect, it, vi } from "vitest";
import { loadWorkerConfig } from "../../../apps/monitoring-worker/src/config";
import { createPublisherWorkerEngine } from "../../../apps/monitoring-worker/src/publishing/bootstrap";
import { PublisherWorkerProcessor } from "../../../apps/monitoring-worker/src/publishing/processor";

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const config = loadWorkerConfig({
  NODE_ENV: "production",
  OBJECT_STORE_DRIVER: "local",
  ALLOW_LOCAL_OBJECT_STORE_IN_PRODUCTION: "true",
  LOCAL_OBJECT_STORE_DIR: "/var/lib/frontmind/monitoring-assets",
  MOLI_API_TOKEN: "test-only-moli-token",
  PUBLISHER_FEATURE_ENABLED: "true",
  PUBLISHER_PROVIDER_ENABLED: "true",
  PUBLISHER_MODE: "live",
  PUBLISHER_REAL_ENABLED: "true",
  PUBLISHER_PUBLISH_ENABLED: "false",
  PUBLISHER_KOL_BASE_URL: "https://api.kol.cn",
  PUBLISHER_KOL_ACCESS_TOKEN: "test-only-kol-token",
  PUBLISHER_PUBLIC_ORIGIN: "https://dashboard.test",
}).publisher;

function catalog(total: number, perPage = 50, missingPage?: number) {
  const lastPage = Math.ceil(total / perPage);
  let stagedRows = 0;
  const repository = {
    beginKolCatalogSync: vi.fn(async () => ({ acquired: true })),
    stageKolCatalogPage: vi.fn(async (input: { resources: unknown[] }) => {
      stagedRows += input.resources.length;
      return { crossKindDuplicateRecords: 0 };
    }),
    finalizeKolCatalogSync: vi.fn(async () => undefined),
    failKolCatalogSync: vi.fn(async () => undefined),
  };
  const provider = {
    mode: "live",
    listResources: vi.fn(async (page: number) => ({
      resources: Array.from(
        {
          length:
            page === missingPage
              ? 0
              : Math.min(perPage, total - (page - 1) * perPage),
        },
        (_, index) => ({
          id: (page - 1) * perPage + index + 1,
          name: `测试媒体${page}-${index}`,
          price: "18.00",
        }),
      ),
      pagination: { currentPage: page, lastPage, perPage, total },
    })),
    createOrder: vi.fn(),
    listOrders: vi.fn(),
    getOrderByOrderId: vi.fn(),
  };
  const processor = new PublisherWorkerProcessor(
    {
      repository: repository as never,
      provider: provider as never,
      objectStore: {} as never,
      logger,
    },
    config,
  );
  const run = () =>
    processor.handle({
      id: "catalog-test",
      type: "sync_kol_catalog",
      payload: {},
      attemptCount: 0,
      maxAttempts: 1,
      leasedUntil: new Date(Date.now() + 60_000),
    });
  return { run, repository, provider, stagedRows: () => stagedRows };
}

it("fully stages the documented 93,067-resource, 1,862-page catalog before activation", async () => {
  const subject = catalog(93_067);
  await subject.run();
  expect(subject.provider.listResources).toHaveBeenCalledTimes(1_862);
  expect(subject.stagedRows()).toBe(93_067);
  expect(subject.repository.finalizeKolCatalogSync).toHaveBeenCalledOnce();
  expect(subject.repository.finalizeKolCatalogSync).toHaveBeenCalledWith(
    expect.objectContaining({ expectedLastPage: 1_862 }),
  );
  expect(subject.repository.failKolCatalogSync).not.toHaveBeenCalled();
  expect(subject.provider.createOrder).not.toHaveBeenCalled();
});

it("keeps the previous catalog when a non-final provider page is empty", async () => {
  const subject = catalog(10_050, 50, 3);
  await expect(subject.run()).rejects.toThrow("empty or short non-final page");
  expect(subject.provider.listResources).toHaveBeenCalledTimes(3);
  expect(subject.repository.finalizeKolCatalogSync).not.toHaveBeenCalled();
  expect(subject.repository.failKolCatalogSync).toHaveBeenCalledOnce();
  expect(subject.provider.createOrder).not.toHaveBeenCalled();
});

it("retains the bounded resource limit without making a partial catalog active", async () => {
  const subject = catalog(100_001);
  await expect(subject.run()).rejects.toThrow("100,000-resource safety limit");
  expect(subject.repository.stageKolCatalogPage).not.toHaveBeenCalled();
  expect(subject.repository.finalizeKolCatalogSync).not.toHaveBeenCalled();
});

it("synchronizes names and prices without claiming optional logo jobs or enabling publication", async () => {
  expect(config).toMatchObject({
    catalogLogosEnabled: false,
    publishEnabled: false,
  });
  expect(config.logoSearch).toBeUndefined();
  const controller = new AbortController();
  const repository = {
    leasePublisherJobs: vi.fn(
      async (_options: { allowedTypes?: readonly string[] }) => {
        controller.abort();
        return [];
      },
    ),
    enqueuePublisherMaintenanceJobs: vi.fn(),
    recoverExpiredPublisherSubmissions: vi.fn().mockResolvedValue(0),
    claimExpiredPublisherObjectLeases: vi.fn().mockResolvedValue([]),
  };
  const worker = createPublisherWorkerEngine({
    config,
    repository: repository as never,
    objectStore: {} as never,
    logger,
  });
  await worker.run(controller.signal);
  const options = repository.leasePublisherJobs.mock.calls[0]![0];
  expect(options.allowedTypes).toContain("sync_kol_catalog");
  expect(options.allowedTypes).not.toContain("archive_publisher_media_logo");
});

// A real successful KOL page returned name=null for resource 89271. Keep its
// row in pagination evidence, but never invent a name or quote for customers.
import { KolClient } from "../../../packages/monitoring-provider-kol/src/client";
import { PublisherWorkerRepository } from "../../../packages/monitoring-db/src/publisher-worker-repository";
import {
  publisherMediaResources,
  publisherMediaSyncRuns,
  publisherMediaSyncStaging,
  publisherRuntimeState,
} from "../../../packages/monitoring-db/src/schema";

function selectedRepository(selections: unknown[][]) {
  const updates: { table: unknown; value: Record<string, unknown> }[] = [];
  const inserts: { table: unknown; value: unknown }[] = [];
  const chain = (value: unknown): any => ({
    from() {
      return this;
    },
    where() {
      return this;
    },
    for() {
      return this;
    },
    limit() {
      return this;
    },
    orderBy() {
      return this;
    },
    onDuplicateKeyUpdate() {
      return this;
    },
    then(
      resolve: (value: unknown) => unknown,
      reject: (reason: unknown) => unknown,
    ) {
      return Promise.resolve(value).then(resolve, reject);
    },
  });
  const database = {
    select: vi.fn(() => {
      if (!selections.length) throw new Error("Unexpected repository read");
      return chain(selections.shift());
    }),
    update: (table: unknown) => ({
      set: (value: Record<string, unknown>) => {
        updates.push({ table, value });
        return chain(undefined);
      },
    }),
    insert: (table: unknown) => ({
      values: (value: unknown) => {
        inserts.push({ table, value });
        return chain(undefined);
      },
    }),
    delete: vi.fn(() => chain(undefined)),
    execute: vi.fn(async () => undefined),
    transaction: async (
      fn: (tx: unknown) => Promise<unknown>,
    ): Promise<unknown> => fn(database),
  };
  return {
    repository: new PublisherWorkerRepository(database as never),
    database,
    updates,
    inserts,
  };
}

it("keeps complete page evidence and stages only rows with real names and valid customer prices", async () => {
  const rows = [
    { id: 1, name: "可用门户", price: 31.5, is_zimeiti: 2 },
    { id: 89271, name: null, price: 87.5, is_zimeiti: 1 },
    { id: 3, name: "可用自媒体", price: "26.3", is_zimeiti: 1 },
    { id: 4, name: "缺少价格", price: null, is_zimeiti: 1 },
    { id: 5, name: "无效价格", price: { unavailable: true }, is_zimeiti: 1 },
    { id: 6, name: "零价格", price: 0, is_zimeiti: 1 },
    { id: 7, name: "错误数组价格", price: [30], is_zimeiti: 1 },
    { id: 8, name: " ", price: 30, is_zimeiti: 1 },
  ];
  const client = new KolClient({
    baseUrl: "https://api.kol.test",
    mode: "live",
    accessToken: "test-only-token",
    fetch: vi.fn(async () =>
      Response.json({
        success: true,
        status: 200,
        pagination: {
          current_page: 1,
          last_page: 1,
          per_page: rows.length,
          total: rows.length,
        },
        data: rows,
      }),
    ),
  });
  const result = await client.listResources();
  expect(result.resources).toHaveLength(rows.length);
  expect(result.resources[1]).toMatchObject({
    id: 89271,
    name: "",
    price: "87.5",
  });
  const now = new Date("2026-09-06T00:00:00.000Z");
  const gate = {
    leaseOwner: "7b3f2af5-7794-4c0e-ad1d-1e41784d523d:test-lease",
    leaseExpiresAt: new Date(now.valueOf() + 60_000),
  };
  const subject = selectedRepository([
    [gate],
    [{ status: "running", pagesFetched: 0, pagesExpected: 0 }],
    [],
  ]);
  const staged = await subject.repository.stageKolCatalogPage({
    runId: "7b3f2af5-7794-4c0e-ad1d-1e41784d523d",
    leaseToken: "7b3f2af5-7794-4c0e-ad1d-1e41784d523d:test-lease",
    page: 1,
    expectedLastPage: 1,
    resources: result.resources,
    stagedAt: now,
  });
  expect(staged).toEqual({
    invalidRecords: 6,
    duplicateRecords: 0,
    crossKindDuplicateRecords: 0,
  });
  const insert = subject.inserts.find(
    (item) => item.table === publisherMediaSyncStaging,
  )!;
  expect(insert.value).toEqual([
    expect.objectContaining({
      externalResourceId: "1",
      name: "可用门户",
      priceTenThousandths: 315_000n,
    }),
    expect.objectContaining({
      externalResourceId: "3",
      name: "可用自媒体",
      priceTenThousandths: 263_000n,
    }),
  ]);
  expect(
    subject.inserts.some((item) => item.table === publisherMediaResources),
  ).toBe(false);
});

function finalizationSubject(overrides: Record<string, unknown> = {}) {
  const syncedAt = new Date("2026-09-06T00:00:00.000Z");
  const gate = {
    leaseOwner: "7b3f2af5-7794-4c0e-ad1d-1e41784d523d:test-lease",
    leaseExpiresAt: new Date(syncedAt.valueOf() + 60_000),
  };
  const run = {
    status: "running",
    pagesFetched: 1_837,
    pagesExpected: 1_837,
    recordsSeen: 91_832,
    newsRecords: 10_672,
    selfMediaRecords: 81_159,
    invalidRecords: 1,
    duplicateRecords: 0,
    crossKindDuplicateRecords: 0,
    ...overrides,
  };
  const subject = selectedRepository([
    [gate],
    [run],
    [{ records: 91_831, positiveNews: 10_672, positiveSelfMedia: 81_159 }],
    [{ externalResourceId: "1", payloadHash: "a".repeat(64) }],
    [gate],
    [run],
    [{}],
  ]);
  return {
    ...subject,
    run: () =>
      subject.repository.finalizeKolCatalogSync({
        runId: "7b3f2af5-7794-4c0e-ad1d-1e41784d523d",
        leaseToken: "7b3f2af5-7794-4c0e-ad1d-1e41784d523d:test-lease",
        expectedLastPage: 1_837,
        syncedAt,
      }),
  };
}

it("activates all usable rows after complete pagination while retaining invalid-row counts", async () => {
  const subject = finalizationSubject();
  await subject.run();
  expect(subject.updates).toContainEqual({
    table: publisherMediaSyncRuns,
    value: expect.objectContaining({
      status: "success",
      isComplete: true,
      recordsChanged: 91_831,
    }),
  });
  expect(subject.updates).toContainEqual({
    table: publisherRuntimeState,
    value: expect.objectContaining({
      catalogKindComplete: true,
      credentialStatus: "healthy",
    }),
  });
  expect(
    subject.updates.some((item) => Object.hasOwn(item.value, "invalidRecords")),
  ).toBe(false);
  expect(subject.database.execute).toHaveBeenCalled();
});

it.each([
  [{ pagesFetched: 1_836 }, "Catalog pagination was incomplete"],
  [{ invalidRecords: 2 }, "Catalog staging counters did not reconcile"],
  [
    { crossKindDuplicateRecords: 1 },
    "Catalog contains one resource id in multiple media categories",
  ],
])(
  "still preserves the active catalog for incomplete or inconsistent page evidence %j",
  async (overrides, reason) => {
    const subject = finalizationSubject(overrides);
    await subject.run();
    expect(subject.updates).toContainEqual({
      table: publisherMediaSyncRuns,
      value: expect.objectContaining({
        status: "partial",
        isComplete: false,
        stopReason: reason,
      }),
    });
    expect(
      subject.updates.some((item) => item.table === publisherRuntimeState),
    ).toBe(false);
    expect(subject.database.execute).not.toHaveBeenCalled();
  },
);
