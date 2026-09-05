// @vitest-environment node
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { expect, it, vi } from "vitest";
import express from "express";
import JSZip from "jszip";
import { LocalPrivateObjectStore } from "../../../packages/monitoring-object-store/src/local";
import { createPublisherHttpService } from "../../../packages/monitoring-api/src/publisher-service";
import { createApiApp } from "../../../packages/monitoring-api/src/server";
import { runtimeConfigSchema } from "../../../packages/monitoring-config/src/index";
import { loadWorkerConfig } from "../../../apps/monitoring-worker/src/config";
import { PublisherWorkerProcessor } from "../../../apps/monitoring-worker/src/publishing/processor";
import { unavailablePublishingProvider } from "../../../apps/monitoring-worker/src/publishing/bootstrap";

it("uploads and converts DOCX from the persistent private store while provider and image publishing are disabled", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "frontmind-docx-fusion-"));
  const store = new LocalPrivateObjectStore({ rootDirectory: directory });
  const ownerId = "11111111-1111-5111-8111-111111111111";
  const importId = "22222222-2222-5222-8222-222222222222";
  let source: { objectKey: string; originalName: string; contentType: string } | undefined;
  const finish = vi.fn().mockResolvedValue(undefined);
  const failure = vi.fn().mockResolvedValue(undefined);
  const repository = {
    getPublisherRuntimeState: vi.fn().mockResolvedValue({ featureEnabled: true, publishEnabled: false, imagePublishEnabled: false }),
    createPublisherObjectLease: vi.fn().mockResolvedValue("lease-1"),
    releasePublisherObjectLease: vi.fn().mockResolvedValue(undefined),
    createDocxImport: vi.fn(async (_ownerId, input) => { source = input; return { id: importId }; }),
    getPublisherDocxImport: vi.fn(async () => ({ importId, ownerId, status: "uploaded", objectKey: source!.objectKey, fileName: source!.originalName, contentType: source!.contentType })),
    completePublisherDocxImport: finish,
    failPublisherDocxImport: failure,
  };
  const service = createPublisherHttpService({
    repository: repository as never, writer: store, reader: store,
    capabilitySecret: "test-only-secret-for-docx-capabilities", publicOrigin: "https://dashboard.test",
  });
  const config = runtimeConfigSchema.parse({
    NODE_ENV: "production", EMBEDDED_DASHBOARD: true, DATABASE_URL: "mysql://localhost/test",
    SESSION_SECRET: "test-only-secret-for-docx-capabilities", PUBLIC_ORIGIN: "https://dashboard.test",
    OBJECT_STORE_DRIVER: "local", ALLOW_LOCAL_OBJECT_STORE_IN_PRODUCTION: "true", LOCAL_OBJECT_STORE_DIR: directory,
    PUBLISHER_FEATURE_ENABLED: "true", PUBLISHER_IMAGE_ENABLED: "false", PUBLISHER_PUBLIC_ASSETS_ENABLED: "false",
  });
  const app = express();
  app.use("/api/monitoring", createApiApp({
    repository: {} as never,
    auth: { resolve: async () => ({ user: { id: ownerId, username: "customer", role: "user", status: "active" }, session: null, tokenHash: null }) },
    config, publisherHttpService: service,
    paymentConfiguration: { publicState: { configured: false, onlinePayment: { configured: false, provider: null, methods: [] }, bankTransfer: { configured: false } } },
  }));
  const server = app.listen(0, "127.0.0.1");
  try {
    await new Promise<void>(resolve => server.once("listening", resolve));
    const archive = new JSZip();
    archive.file("[Content_Types].xml", '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
    archive.file("_rels/.rels", '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
    archive.file("word/document.xml", '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>离线稿件导入验收正文</w:t></w:r></w:p></w:body></w:document>');
    const bytes = await archive.generateAsync({ type: "uint8array" });
    const form = new FormData();
    form.append("file", new Blob([bytes], { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }), "acceptance.docx");
    const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/monitoring/publisher/docx-imports`, {
      method: "POST", headers: { Origin: "https://dashboard.test" }, body: form,
    });
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ importId, status: "queued" });
    expect((await store.head(source!.objectKey)).exists).toBe(true);
    const workerConfig = loadWorkerConfig({
      NODE_ENV: "production", OBJECT_STORE_DRIVER: "local", ALLOW_LOCAL_OBJECT_STORE_IN_PRODUCTION: "true", LOCAL_OBJECT_STORE_DIR: directory,
      MOLI_API_TOKEN: "test-only-token", PUBLISHER_FEATURE_ENABLED: "true", PUBLISHER_PROVIDER_ENABLED: "false", PUBLISHER_MODE: "live", PUBLISHER_PUBLIC_ORIGIN: "https://dashboard.test",
    });
    const processor = new PublisherWorkerProcessor({
      repository: repository as never, objectStore: store,
      provider: unavailablePublishingProvider("live"),
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      fetch: vi.fn(() => { throw new Error("DOCX must not use external network"); }) as never,
    }, workerConfig.publisher);
    await processor.handle({ id: "job-1", type: "import_docx", payload: { importId }, attemptCount: 0, maxAttempts: 1, leasedUntil: new Date(Date.now() + 60_000) });
    expect(failure).not.toHaveBeenCalled();
    expect(finish).toHaveBeenCalledWith(expect.objectContaining({ importId, ownerId, report: expect.objectContaining({ plainText: expect.stringContaining("离线稿件导入验收正文"), blockingIssues: [] }) }));
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
