// @vitest-environment node
import { expect, it, vi } from "vitest";
import { loadWorkerConfig } from "../../../apps/monitoring-worker/src/config";
import { createPublisherWorkerEngine } from "../../../apps/monitoring-worker/src/publishing/bootstrap";
import { PublisherWorkerProcessor } from "../../../apps/monitoring-worker/src/publishing/processor";

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const config = loadWorkerConfig({
  NODE_ENV: "production", OBJECT_STORE_DRIVER: "local", ALLOW_LOCAL_OBJECT_STORE_IN_PRODUCTION: "true",
  LOCAL_OBJECT_STORE_DIR: "/var/lib/frontmind/monitoring-assets", MOLI_API_TOKEN: "test-only-moli-token",
  PUBLISHER_FEATURE_ENABLED: "true", PUBLISHER_PROVIDER_ENABLED: "true", PUBLISHER_MODE: "live",
  PUBLISHER_REAL_ENABLED: "true", PUBLISHER_PUBLISH_ENABLED: "false",
  PUBLISHER_KOL_BASE_URL: "https://api.kol.cn", PUBLISHER_KOL_ACCESS_TOKEN: "test-only-kol-token",
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
      resources: Array.from({ length: page === missingPage ? 0 : Math.min(perPage, total - (page - 1) * perPage) }, (_, index) => ({
        id: (page - 1) * perPage + index + 1, name: `测试媒体${page}-${index}`, price: "18.00",
      })),
      pagination: { currentPage: page, lastPage, perPage, total },
    })),
    createOrder: vi.fn(), listOrders: vi.fn(), getOrderByOrderId: vi.fn(),
  };
  const processor = new PublisherWorkerProcessor({ repository: repository as never, provider: provider as never, objectStore: {} as never, logger }, config);
  const run = () => processor.handle({ id: "catalog-test", type: "sync_kol_catalog", payload: {}, attemptCount: 0, maxAttempts: 1, leasedUntil: new Date(Date.now() + 60_000) });
  return { run, repository, provider, stagedRows: () => stagedRows };
}

it("fully stages the documented 93,067-resource, 1,862-page catalog before activation", async () => {
  const subject = catalog(93_067);
  await subject.run();
  expect(subject.provider.listResources).toHaveBeenCalledTimes(1_862);
  expect(subject.stagedRows()).toBe(93_067);
  expect(subject.repository.finalizeKolCatalogSync).toHaveBeenCalledOnce();
  expect(subject.repository.finalizeKolCatalogSync).toHaveBeenCalledWith(expect.objectContaining({ expectedLastPage: 1_862 }));
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
  expect(config).toMatchObject({ catalogLogosEnabled: false, publishEnabled: false });
  expect(config.logoSearch).toBeUndefined();
  const controller = new AbortController();
  const repository = {
    leasePublisherJobs: vi.fn(async (_options: { allowedTypes?: readonly string[] }) => { controller.abort(); return []; }),
    enqueuePublisherMaintenanceJobs: vi.fn(),
    recoverExpiredPublisherSubmissions: vi.fn().mockResolvedValue(0),
    claimExpiredPublisherObjectLeases: vi.fn().mockResolvedValue([]),
  };
  const worker = createPublisherWorkerEngine({ config, repository: repository as never, objectStore: {} as never, logger });
  await worker.run(controller.signal);
  const options = repository.leasePublisherJobs.mock.calls[0]![0];
  expect(options.allowedTypes).toContain("sync_kol_catalog");
  expect(options.allowedTypes).not.toContain("archive_publisher_media_logo");
});
