// @vitest-environment node
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { Readable } from "node:stream";
import express from "express";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const dependencies = vi.hoisted(() => ({
  authenticate: vi.fn(),
  scope: vi.fn(),
  credential: vi.fn(),
  active: vi.fn(),
}));
vi.mock("./auth-service", async (original) => ({
  ...(await original<typeof import("./auth-service")>()),
  authenticateRequest: dependencies.authenticate,
  getCredentialForUpstreamResource: dependencies.credential,
  getEffectiveDecryptedCredentialForAccount: dependencies.active,
}));
vi.mock("./enterprise-project-service", async (original) => ({
  ...(await original<typeof import("./enterprise-project-service")>()),
  resolveEnterpriseProjectScope: dependencies.scope,
}));
import manusProxy from "./manus-proxy";
import preparedFileRouter from "./prepared-file-router";
import { requireExpressAuth } from "./_core/express-auth";
import { resolveUpstreamCredential } from "./_core/upstream-credential";
import { currentEnterpriseProjectId } from "./enterprise-project-context";
import {
  PreparedFileService,
  preparedFileService,
  createPreparedAssetId,
  type PreparedFileManifest,
} from "./prepared-file-service";
import { OWNED_FILE_CONTENT_RESOLVER_VERSION } from "./owned-file-content-resolver";
import { stagePresalesFileContent } from "./presales-file-store";

const projectA = "11111111-1111-4111-8111-111111111111";
const projectB = "22222222-2222-4222-8222-222222222222";
const ownerId = 7,
  adminId = 99,
  credentialId = "enterprise-download-credential";
const textFile = "enterprise-owned-text",
  pdfFile = "enterprise-owned-pdf";
const textBytes = Buffer.from("Project A local text content"),
  pdfBytes = Buffer.from("%PDF-1.7\nProject A prepared file");
const assetId = createPreparedAssetId(
  ownerId,
  credentialId,
  {
    kind: "file",
    fileId: pdfFile,
  },
  null,
  projectA,
);

describe("enterprise native file downloads", () => {
  let directory: string,
    baseUrl: string,
    server: ReturnType<typeof createServer>,
    service: PreparedFileService;
  const oldDirectory = process.env.FRONTMIND_DASHBOARD_ASSET_DIR;
  const credential = {
    id: credentialId,
    userId: ownerId,
    version: 1,
    apiKey: "local-test-only-key",
    fingerprint: "test",
    status: "active",
    verifiedAt: new Date(),
    resource: {
      createdAt: new Date(),
      contentExpiresAt: new Date(Date.now() + 3_600_000),
      contentDeletedAt: null,
    },
  };
  beforeAll(async () => {
    // Fake only authenticated account/project records. The real Express auth,
    // credential middleware, owned-file resolver, durable files and prepared
    // manifest authorization all execute below.
    dependencies.authenticate.mockImplementation(async (req) => ({
      id:
        req.headers["x-test-user"] === "owner"
          ? ownerId
          : req.headers["x-test-user"] === "stranger"
            ? 8
            : adminId,
      role:
        req.headers["x-test-user"] === "owner" ||
        req.headers["x-test-user"] === "stranger"
          ? "user"
          : "admin",
      isActive: true,
    }));
    dependencies.scope.mockImplementation(async (actor, id) => {
      if (
        ![projectA, projectB].includes(id) ||
        ![ownerId, adminId].includes(actor.id)
      )
        throw new Error("PROJECT_NOT_FOUND");
      return {
        enterpriseProjectId: id,
        ownerUserId: ownerId,
        actorUserId: actor.id,
        isLegacyDefault: false,
      };
    });
    dependencies.credential.mockImplementation(async (owner, kind, fileId) =>
      owner === ownerId &&
      currentEnterpriseProjectId() === projectA &&
      kind === "file" &&
      [textFile, pdfFile].includes(fileId)
        ? credential
        : null,
    );
    dependencies.active.mockImplementation(async (owner) =>
      owner === ownerId ? credential : null,
    );
    directory = await mkdtemp(
      path.join(tmpdir(), "frontmind-enterprise-download-"),
    );
    process.env.FRONTMIND_DASHBOARD_ASSET_DIR = path.join(directory, "sources");
    for (const [fileId, bytes, filename, mimeType] of [
      [textFile, textBytes, "test.txt", "text/plain"],
      [pdfFile, pdfBytes, "test.pdf", "application/pdf"],
    ] as const) {
      const staged = await stagePresalesFileContent({
        fileId,
        stream: Readable.from([bytes]),
        maxBytes: 10000,
      });
      await staged.commit({ filename, mimeType });
    }
    service = new PreparedFileService(path.join(directory, "prepared"), {
      skipToolingCheck: true,
      workerConcurrency: 0,
    });
    await service.initialize();
    const manifest: PreparedFileManifest = {
      version: 1,
      sourceResolverVersion: OWNED_FILE_CONTENT_RESOLVER_VERSION,
      id: assetId,
      ownerUserId: ownerId,
      enterpriseScopeVersion: 1,
      enterpriseProjectId: projectA,
      credentialId,
      sourceKind: "provider_file",
      sourceAuthorityId: credentialId,
      projectAssignmentId: null,
      source: { kind: "file", fileId: pdfFile },
      filename: "prepared.pdf",
      mimeType: "application/pdf",
      status: "ready",
      phase: "ready",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      lastAccessedAt: Date.now(),
      size: pdfBytes.length,
      etag: "test-etag",
      sourceExpiresAt: Date.now() + 3_600_000,
      expiresAt: Date.now() + 3_600_000,
    };
    await writeFile(
      path.join(directory, "prepared", `${assetId}.json`),
      JSON.stringify(manifest),
    );
    await writeFile(service.contentPath(assetId), pdfBytes);
    for (const method of [
      "getReadyManifest",
      "getStatus",
      "retry",
      "registerFile",
      "registerExternal",
      "contentPath",
      "beginUse",
      "endUse",
    ] as const)
      vi.spyOn(preparedFileService, method).mockImplementation(
        service[method].bind(service) as never,
      );
    const app = express();
    app.use(express.json());
    app.use("/api/frontmind/assets", requireExpressAuth, preparedFileRouter);
    app.use(
      "/api/frontmind",
      requireExpressAuth,
      resolveUpstreamCredential,
      manusProxy,
    );
    server = createServer(app);
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    if (server)
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    await service?.shutdown();
    vi.restoreAllMocks();
    if (oldDirectory === undefined)
      delete process.env.FRONTMIND_DASHBOARD_ASSET_DIR;
    else process.env.FRONTMIND_DASHBOARD_ASSET_DIR = oldDirectory;
    if (directory) await rm(directory, { recursive: true, force: true });
  });
  const scoped = (pathname: string, project = projectA) =>
    `${baseUrl}${pathname}${pathname.includes("?") ? "&" : "?"}enterpriseProjectId=${project}`;
  async function token(pathname: string, body?: unknown) {
    const response = await fetch(scoped(pathname), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body ?? {}),
    });
    expect(response.status).toBe(200);
    return response.json() as Promise<{ downloadUrl: string }>;
  }
  it("allows an authorized admin to obtain and follow a native customer-file download URL without request headers", async () => {
    const issued = await token("/api/frontmind/download-token", {
      fileId: textFile,
    });
    expect(
      new URL(issued.downloadUrl, baseUrl).searchParams.get(
        "enterpriseProjectId",
      ),
    ).toBe(projectA);
    const response = await fetch(`${baseUrl}${issued.downloadUrl}`);
    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(textBytes);
    expect(dependencies.credential).toHaveBeenCalledWith(
      ownerId,
      "file",
      textFile,
      undefined,
      { allowExpiredFileContent: true },
    );
    const direct = await fetch(
      scoped(`/api/frontmind/v1/files/${textFile}/content`),
    );
    expect(direct.status).toBe(200);
  });
  it("rejects a changed, missing or conflicting enterprise project and a different account before returning file bytes", async () => {
    const issued = await token("/api/frontmind/download-token", {
      fileId: textFile,
    });
    const url = new URL(issued.downloadUrl, baseUrl);
    url.searchParams.set("enterpriseProjectId", projectB);
    expect((await fetch(url)).status).toBe(403);
    url.searchParams.delete("enterpriseProjectId");
    expect((await fetch(url)).status).toBe(403);
    expect(
      (
        await fetch(`${baseUrl}${issued.downloadUrl}`, {
          headers: { "x-enterprise-project-id": projectB },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await fetch(`${baseUrl}${issued.downloadUrl}`, {
          headers: { "x-test-user": "stranger" },
        })
      ).status,
    ).toBe(404);
    expect(
      (await fetch(scoped(`/api/frontmind/v1/files/${textFile}`, projectB)))
        .status,
    ).toBe(403);
  });
  it("retains the enterprise project through PDF redirects and preserves the attachment query", async () => {
    const issued = await token("/api/frontmind/download-token", {
      fileId: pdfFile,
    });
    const redirected = await fetch(`${baseUrl}${issued.downloadUrl}`, {
      redirect: "manual",
    });
    expect(redirected.status).toBe(307);
    const location = new URL(redirected.headers.get("location")!, baseUrl);
    expect(location.searchParams.get("enterpriseProjectId")).toBe(projectA);
    expect(location.searchParams.get("download")).toBe("1");
    const content = await fetch(location);
    expect(content.status).toBe(200);
    expect(Buffer.from(await content.arrayBuffer())).toEqual(pdfBytes);
  });
  it("authorizes prepared PDF status and native tokens with the scoped customer owner", async () => {
    const status = await fetch(
      scoped(`/api/frontmind/assets/${assetId}/status`),
    );
    expect(status.status).toBe(200);
    const payload = await status.json();
    for (const key of ["contentUrl", "downloadTokenUrl"])
      expect(
        new URL(payload[key], baseUrl).searchParams.get("enterpriseProjectId"),
      ).toBe(projectA);
    const issued = await token(
      `/api/frontmind/assets/${assetId}/download-token`,
    );
    expect(
      new URL(issued.downloadUrl, baseUrl).searchParams.get(
        "enterpriseProjectId",
      ),
    ).toBe(projectA);
    const content = await fetch(`${baseUrl}${issued.downloadUrl}`);
    expect(content.status).toBe(200);
    expect(Buffer.from(await content.arrayBuffer())).toEqual(pdfBytes);
  });
  it("rechecks prepared PDF source project for content, status, retry and signed token reads", async () => {
    const issued = await token(
        `/api/frontmind/assets/${assetId}/download-token`,
      ),
      changed = new URL(issued.downloadUrl, baseUrl);
    changed.searchParams.set("enterpriseProjectId", projectB);
    expect((await fetch(changed)).status).toBe(404);
    for (const endpoint of ["content", "status", "download-token", "retry"]) {
      const response = await fetch(
        scoped(`/api/frontmind/assets/${assetId}/${endpoint}`, projectB),
        {
          method: ["retry", "download-token"].includes(endpoint)
            ? "POST"
            : "GET",
        },
      );
      expect(response.status).toBe(404);
    }
    const head = await fetch(
      scoped(`/api/frontmind/assets/${assetId}/content`, projectB),
      { method: "HEAD" },
    );
    expect(head.status).toBe(404);
  });
  it("isolates externally prepared PDFs through prepare, status and native download routes", async () => {
    const response = await fetch(scoped("/api/frontmind/assets/prepare"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        fileUrl: "https://objects.example.com/native-external.pdf",
        fileName: "external.pdf",
      }),
    });
    expect(response.status).toBe(200);
    const created = await response.json();
    expect(
      new URL(created.contentUrl, baseUrl).searchParams.get(
        "enterpriseProjectId",
      ),
    ).toBe(projectA);
    const manifestPath = path.join(
      directory,
      "prepared",
      `${created.assetId}.json`,
    );
    const stored = JSON.parse(await readFile(manifestPath, "utf8"));
    expect(stored).toMatchObject({
      ownerUserId: ownerId,
      enterpriseScopeVersion: 1,
      enterpriseProjectId: projectA,
    });
    await writeFile(service.contentPath(created.assetId), pdfBytes);
    await writeFile(
      manifestPath,
      JSON.stringify({
        ...stored,
        status: "ready",
        phase: "ready",
        size: pdfBytes.length,
      }),
    );
    const issued = await token(
      `/api/frontmind/assets/${created.assetId}/download-token`,
    );
    const content = await fetch(`${baseUrl}${issued.downloadUrl}`);
    expect(content.status).toBe(200);
    expect(Buffer.from(await content.arrayBuffer())).toEqual(pdfBytes);
    const changed = new URL(issued.downloadUrl, baseUrl);
    changed.searchParams.set("enterpriseProjectId", projectB);
    expect((await fetch(changed)).status).toBe(404);
    expect(
      (
        await fetch(
          scoped(`/api/frontmind/assets/${created.assetId}/status`, projectB),
        )
      ).status,
    ).toBe(404);
    changed.searchParams.delete("enterpriseProjectId");
    expect(
      (await fetch(changed, { headers: { "x-test-user": "owner" } })).status,
    ).toBe(404);
  });

  it("keeps the account owner able to follow the same project URL", async () => {
    const issued = await token("/api/frontmind/download-token", {
      fileId: textFile,
    });
    const response = await fetch(`${baseUrl}${issued.downloadUrl}`, {
      headers: { "x-test-user": "owner" },
    });
    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(textBytes);
  });
});
