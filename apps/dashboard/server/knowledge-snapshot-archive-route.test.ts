import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";
import JSZip from "jszip";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getKnowledgeSnapshotForWorkspace: vi.fn(),
  readKnowledgeSnapshotArchive: vi.fn(),
  loadKnowledgeSnapshotDownloadValidation: vi.fn(),
}));

vi.mock("./_core/express-auth", () => ({
  requireExpressAuth: (req: any, res: any, next: () => void) => {
    if (req.header("x-test-auth") !== "user") {
      res
        .status(401)
        .json({ error: { message: "请先登录", code: "UNAUTHORIZED" } });
      return;
    }
    req.frontmindUser = {
      id: 42,
      username: "knowledge-user",
      role: "user",
      isActive: true,
    };
    next();
  },
}));

vi.mock("./dashboard-service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./dashboard-service")>();
  return {
    ...actual,
    getKnowledgeSnapshotForWorkspace: mocks.getKnowledgeSnapshotForWorkspace,
  };
});

vi.mock("./knowledge-snapshot-archive-store", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./knowledge-snapshot-archive-store")>();
  return {
    ...actual,
    readKnowledgeSnapshotArchive: mocks.readKnowledgeSnapshotArchive,
  };
});

vi.mock("./knowledge-snapshot-download-validation", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("./knowledge-snapshot-download-validation")
    >();
  return {
    ...actual,
    loadKnowledgeSnapshotDownloadValidation:
      mocks.loadKnowledgeSnapshotDownloadValidation,
  };
});

import dashboardRouter from "./dashboard-api";
import type { KnowledgeBaseBuildNode } from "../drizzle/schema";
import { buildDashboardOwnedKnowledgePackage } from "./knowledge-base-local-package";
import {
  KnowledgeSnapshotDownloadBindingError,
  type KnowledgeSnapshotDownloadValidation,
} from "./knowledge-snapshot-download-validation";

const servers: Server[] = [];
const snapshotId = "00000000-0000-4000-8000-000000000123";
const buildId = "123e4567-e89b-42d3-a456-426614174000";
let archive: Buffer;
let archiveHash: string;

function localPackageNodes() {
  return [
    {
      leafId: "1.1",
      title: "企业定位",
      branchId: "identity",
      branchTitle: "企业身份",
      ordinal: 0,
      status: "confirmed",
      contentMarkdown: "## 1.1 企业定位\n\nFrontMind 是企业 AI 工作流平台。",
      contentSha256: null,
      sourceUrls: ["https://frontmind.net/"],
      imageUrls: [],
    },
  ] as KnowledgeBaseBuildNode[];
}

async function dashboardOwnedArchive() {
  const nodes = localPackageNodes();
  const built = await buildDashboardOwnedKnowledgePackage({
    build: {
      id: buildId,
      generation: 2,
      revision: 7,
      companyName: "FrontMind",
      logoStorageKey: null,
    },
    nodes,
  });
  const validation: KnowledgeSnapshotDownloadValidation = {
    kind: "dashboard_owned",
    buildId,
    archiveSha256: built.sha256,
    archiveBytes: built.buffer.length,
    expected: {
      buildId,
      generation: 2,
      revision: 7,
      companyName: "FrontMind",
    },
    nodes,
  };
  return { ...built, validation };
}

async function downloadableArchive(extraFiles: Record<string, string> = {}) {
  const zip = new JSZip();
  const root = "company_knowledge_base";
  for (const file of [
    "README.md",
    "00_knowledge_tree.md",
    "00_crawl_coverage_report.md",
    "00_web_intelligence_report.md",
    "00_source_index.md",
    "09_media_assets/asset_inventory.md",
    "10_reference_assets/reference_asset_inventory.md",
  ]) {
    zip.file(`${root}/${file}`, `# ${file}\n\n已验证的知识库内容。`);
  }
  for (const [file, content] of Object.entries(extraFiles)) {
    zip.file(file, content);
  }
  return zip.generateAsync({ type: "nodebuffer" });
}

beforeEach(async () => {
  archive = await downloadableArchive();
  archiveHash = createHash("sha256").update(archive).digest("hex");
  mocks.getKnowledgeSnapshotForWorkspace.mockReset().mockResolvedValue({
    id: snapshotId,
    userId: 42,
    sourceFileName: "企业知识库.zip",
    archiveHash,
    totalBytes: archive.length,
  });
  mocks.readKnowledgeSnapshotArchive.mockReset().mockResolvedValue(archive);
  mocks.loadKnowledgeSnapshotDownloadValidation
    .mockReset()
    .mockResolvedValue({ kind: "historical" });
});

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
          ),
      ),
  );
});

async function startApp() {
  const app = express();
  app.use("/api/dashboard", dashboardRouter);
  const server = createServer(app);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}/api/dashboard/knowledge/snapshots/${snapshotId}/archive`;
}

describe("knowledge snapshot ZIP endpoint", () => {
  it("requires an authenticated workspace before reading archive bytes", async () => {
    const url = await startApp();
    const response = await fetch(url);

    expect(response.status).toBe(401);
    expect(mocks.getKnowledgeSnapshotForWorkspace).not.toHaveBeenCalled();
    expect(mocks.readKnowledgeSnapshotArchive).not.toHaveBeenCalled();
  });

  it("serves the snapshot-bound ZIP with download-safe headers", async () => {
    const url = await startApp();
    const response = await fetch(url, {
      headers: { "x-test-auth": "user" },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/zip");
    expect(response.headers.get("content-length")).toBe(String(archive.length));
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("content-disposition")).toContain(
      "filename*=UTF-8''%E4%BC%81%E4%B8%9A%E7%9F%A5%E8%AF%86%E5%BA%93.zip",
    );
    expect(Buffer.from(await response.arrayBuffer())).toEqual(archive);
    expect(mocks.getKnowledgeSnapshotForWorkspace).toHaveBeenCalledWith({
      actor: expect.objectContaining({ id: 42, role: "user" }),
      snapshotId,
    });
    expect(mocks.readKnowledgeSnapshotArchive).toHaveBeenCalledWith({
      userId: 42,
      snapshotId,
      expectedSha256: archiveHash,
      expectedBytes: archive.length,
    });
  });

  it("serves an exactly bound Dashboard-owned local package", async () => {
    const local = await dashboardOwnedArchive();
    mocks.getKnowledgeSnapshotForWorkspace.mockResolvedValueOnce({
      id: snapshotId,
      userId: 42,
      sourceFileName: "FrontMind-knowledge-base.zip",
      archiveHash: local.sha256,
      totalBytes: local.buffer.length,
    });
    mocks.readKnowledgeSnapshotArchive.mockResolvedValueOnce(local.buffer);
    mocks.loadKnowledgeSnapshotDownloadValidation.mockResolvedValueOnce(
      local.validation,
    );

    const response = await fetch(await startApp(), {
      headers: { "x-test-auth": "user" },
    });

    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(local.buffer);
  });

  it("refuses tampered Dashboard-owned bytes before sending the archive", async () => {
    const local = await dashboardOwnedArchive();
    const tampered = Buffer.from(local.buffer);
    tampered[tampered.length - 1] = tampered[tampered.length - 1]! ^ 0xff;
    mocks.getKnowledgeSnapshotForWorkspace.mockResolvedValueOnce({
      id: snapshotId,
      userId: 42,
      sourceFileName: "FrontMind-knowledge-base.zip",
      archiveHash: local.sha256,
      totalBytes: local.buffer.length,
    });
    mocks.readKnowledgeSnapshotArchive.mockResolvedValueOnce(tampered);
    mocks.loadKnowledgeSnapshotDownloadValidation.mockResolvedValueOnce(
      local.validation,
    );

    const response = await fetch(await startApp(), {
      headers: { "x-test-auth": "user" },
    });

    expect(response.status).toBe(409);
    expect(response.headers.get("content-type")).not.toContain(
      "application/zip",
    );
    expect(await response.json()).toMatchObject({
      error: { code: "KNOWLEDGE_ARCHIVE_BINDING_INVALID" },
    });
  });

  it("refuses a Dashboard-owned snapshot whose DB binding no longer matches", async () => {
    mocks.loadKnowledgeSnapshotDownloadValidation.mockRejectedValueOnce(
      new KnowledgeSnapshotDownloadBindingError(),
    );

    const response = await fetch(await startApp(), {
      headers: { "x-test-auth": "user" },
    });

    expect(response.status).toBe(409);
    expect(response.headers.get("content-type")).not.toContain(
      "application/zip",
    );
    expect(await response.json()).toMatchObject({
      error: { code: "KNOWLEDGE_ARCHIVE_BINDING_INVALID" },
    });
  });

  it("round-trips the persisted ZIP through the authenticated download endpoint", async () => {
    const assetRoot = await mkdtemp(
      path.join(tmpdir(), "frontmind-knowledge-route-roundtrip-"),
    );
    const previousAssetRoot = process.env.FRONTMIND_DASHBOARD_ASSET_DIR;
    process.env.FRONTMIND_DASHBOARD_ASSET_DIR = assetRoot;
    try {
      const bytes = await downloadableArchive();
      const archiveHash = createHash("sha256").update(bytes).digest("hex");
      const archiveStore = await vi.importActual<
        typeof import("./knowledge-snapshot-archive-store")
      >("./knowledge-snapshot-archive-store");
      await archiveStore.persistKnowledgeSnapshotArchive({
        userId: 42,
        snapshotId,
        buffer: bytes,
        expectedSha256: archiveHash,
      });
      mocks.getKnowledgeSnapshotForWorkspace.mockResolvedValueOnce({
        id: snapshotId,
        userId: 42,
        sourceFileName: "企业知识库.zip",
        archiveHash,
        totalBytes: bytes.length,
      });
      mocks.readKnowledgeSnapshotArchive.mockImplementationOnce((input) =>
        archiveStore.readKnowledgeSnapshotArchive(input),
      );

      const url = await startApp();
      const response = await fetch(url, {
        headers: { "x-test-auth": "user" },
      });

      expect(response.status).toBe(200);
      expect(response.headers.get("content-length")).toBe(String(bytes.length));
      expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
    } finally {
      if (previousAssetRoot === undefined) {
        delete process.env.FRONTMIND_DASHBOARD_ASSET_DIR;
      } else {
        process.env.FRONTMIND_DASHBOARD_ASSET_DIR = previousAssetRoot;
      }
      await rm(assetRoot, { recursive: true, force: true });
    }
  });

  it("does not disclose or read an archive outside the authenticated workspace", async () => {
    mocks.getKnowledgeSnapshotForWorkspace.mockResolvedValueOnce(null);
    const url = await startApp();
    const response = await fetch(url, {
      headers: { "x-test-auth": "user" },
    });

    expect(response.status).toBe(404);
    expect(mocks.readKnowledgeSnapshotArchive).not.toHaveBeenCalled();
  });

  it("makes a legacy archive unavailable when its public filename is polluted", async () => {
    const privateBrand = ["Ma", "nus"].join("");
    mocks.getKnowledgeSnapshotForWorkspace.mockResolvedValueOnce({
      id: snapshotId,
      userId: 42,
      sourceFileName: `${privateBrand}_V2_知识库.zip`,
      archiveHash,
      totalBytes: archive.length,
    });

    const response = await fetch(await startApp(), {
      headers: { "x-test-auth": "user" },
    });

    expect(response.status).toBe(409);
    const payload = await response.json();
    expect(payload).toMatchObject({
      error: { code: "KNOWLEDGE_ARCHIVE_PUBLIC_CONTENT_UNAVAILABLE" },
    });
    expect(JSON.stringify(payload)).not.toMatch(/manus/iu);
  });

  it("makes a legacy archive unavailable when extracted text is polluted", async () => {
    const privateBrand = ["Ma", "nus"].join("");
    const polluted = await downloadableArchive({
      "company_knowledge_base/notes.md": `${privateBrand.toUpperCase()}_V2_TASK`,
    });
    const pollutedHash = createHash("sha256").update(polluted).digest("hex");
    mocks.getKnowledgeSnapshotForWorkspace.mockResolvedValueOnce({
      id: snapshotId,
      userId: 42,
      sourceFileName: "企业知识库.zip",
      archiveHash: pollutedHash,
      totalBytes: polluted.length,
    });
    mocks.readKnowledgeSnapshotArchive.mockResolvedValueOnce(polluted);

    const response = await fetch(await startApp(), {
      headers: { "x-test-auth": "user" },
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: { code: "KNOWLEDGE_ARCHIVE_PUBLIC_CONTENT_UNAVAILABLE" },
    });
  });

  it("makes a legacy archive unavailable when ZIP metadata is polluted", async () => {
    const privateBrand = ["Ma", "nus"].join("");
    const zip = await JSZip.loadAsync(await downloadableArchive());
    zip.comment = `${privateBrand} internal archive`;
    const polluted = await zip.generateAsync({ type: "nodebuffer" });
    const pollutedHash = createHash("sha256").update(polluted).digest("hex");
    mocks.getKnowledgeSnapshotForWorkspace.mockResolvedValueOnce({
      id: snapshotId,
      userId: 42,
      sourceFileName: "企业知识库.zip",
      archiveHash: pollutedHash,
      totalBytes: polluted.length,
    });
    mocks.readKnowledgeSnapshotArchive.mockResolvedValueOnce(polluted);

    const response = await fetch(await startApp(), {
      headers: { "x-test-auth": "user" },
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: { code: "KNOWLEDGE_ARCHIVE_PUBLIC_CONTENT_UNAVAILABLE" },
    });
  });

  it("refuses a path-traversal ZIP before sending any archive bytes", async () => {
    const unsafe = await downloadableArchive({
      "../escaped.md": "不得写出知识库根目录",
    });
    const unsafeHash = createHash("sha256").update(unsafe).digest("hex");
    mocks.getKnowledgeSnapshotForWorkspace.mockResolvedValueOnce({
      id: snapshotId,
      userId: 42,
      sourceFileName: "企业知识库.zip",
      archiveHash: unsafeHash,
      totalBytes: unsafe.length,
    });
    mocks.readKnowledgeSnapshotArchive.mockResolvedValueOnce(unsafe);

    const response = await fetch(await startApp(), {
      headers: { "x-test-auth": "user" },
    });

    expect(response.status).toBe(409);
    expect(response.headers.get("content-type")).not.toContain(
      "application/zip",
    );
    expect(await response.json()).toMatchObject({
      error: { code: "KNOWLEDGE_ARCHIVE_UNSAFE_INVALID" },
    });
  });
});
