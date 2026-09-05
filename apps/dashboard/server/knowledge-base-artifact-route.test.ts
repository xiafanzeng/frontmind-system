import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invalidZip = Buffer.from(
  "PK\u0003\u0004not-a-decodable-archive",
  "binary",
);
const packageSha256 = createHash("sha256").update(invalidZip).digest("hex");
const buildId = "123e4567-e89b-42d3-a456-426614174000";

const mocks = vi.hoisted(() => ({
  getDb: vi.fn(),
  readKnowledgeBuildArtifact: vi.fn(),
  readValidatedActiveKnowledgeBaseWorkingSet: vi.fn(),
  resolveKnowledgeBaseWorkingSetResourceByOpaqueHandle: vi.fn(),
  resolveKnowledgeBaseWorkingSetResource: vi.fn(),
}));

vi.mock("./db", () => ({ getDb: mocks.getDb }));

vi.mock("./knowledge-build-artifact-store", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./knowledge-build-artifact-store")>();
  return {
    ...actual,
    readKnowledgeBuildArtifact: mocks.readKnowledgeBuildArtifact,
  };
});

vi.mock("./knowledge-base-materialized-assets", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("./knowledge-base-materialized-assets")
    >();
  return {
    ...actual,
    readValidatedActiveKnowledgeBaseWorkingSet:
      mocks.readValidatedActiveKnowledgeBaseWorkingSet,
    resolveKnowledgeBaseWorkingSetResourceByOpaqueHandle:
      mocks.resolveKnowledgeBaseWorkingSetResourceByOpaqueHandle,
    resolveKnowledgeBaseWorkingSetResource:
      mocks.resolveKnowledgeBaseWorkingSetResource,
  };
});

import artifactRouter from "./knowledge-base-artifact-api";
import { knowledgeBasePublicResourceHandle } from "./knowledge-base-public-resource";

const servers: Server[] = [];

beforeEach(() => {
  let selectCount = 0;
  mocks.getDb.mockReset().mockResolvedValue({
    select: () => ({
      from: () => {
        selectCount += 1;
        const rows =
          selectCount === 1
            ? [
                {
                  id: buildId,
                  userId: 42,
                  generation: 2,
                  status: "ready_to_publish",
                  skillVersion: "4",
                  treePolicyVersion: 1,
                  initialResearchCoverage: null,
                  revision: 8,
                  logoStorageKey: `knowledge-builds/42/${buildId}/generation-2/official-logo.bin`,
                  logoSha256: "a".repeat(64),
                  logoBytes: 128,
                  logoFilename: "logo.png",
                  logoMimeType: "image/png",
                  packageStorageKey: `knowledge-builds/42/${buildId}/generation-2/knowledge-base.zip`,
                  packageArchiveSha256: packageSha256,
                  packageSizeBytes: invalidZip.length,
                  packageFilename: "knowledge-base.zip",
                },
              ]
            : [];
        return {
          where: () => ({
            limit: async () => rows,
            then: (resolve: (value: typeof rows) => unknown) =>
              Promise.resolve(rows).then(resolve),
          }),
        };
      },
    }),
  });
  mocks.readKnowledgeBuildArtifact.mockReset().mockResolvedValue(invalidZip);
  mocks.readValidatedActiveKnowledgeBaseWorkingSet
    .mockReset()
    .mockResolvedValue({ validated: { manifest: {}, files: new Map() } });
  mocks.resolveKnowledgeBaseWorkingSetResource.mockReset().mockReturnValue({
    bytes: Buffer.from("verified-working-set-image"),
    filename: "product.png",
    mimeType: "image/png",
    disposition: "inline",
  });
  mocks.resolveKnowledgeBaseWorkingSetResourceByOpaqueHandle
    .mockReset()
    .mockReturnValue({
      bytes: Buffer.from("verified-working-set-image"),
      filename: "private-product-name.png",
      mimeType: "image/png",
      disposition: "inline",
    });
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

async function startApp(path = "package", opaque = false) {
  const app = express();
  app.use((req: any, _res, next) => {
    req.frontmindUser = { id: 42, username: "knowledge-user", role: "user" };
    next();
  });
  app.use("/api/knowledge-base/artifacts", artifactRouter);
  const server = createServer(app);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}/api/knowledge-base/artifacts/${opaque ? path : `${buildId}/${path}`}`;
}

describe("knowledge-base final package download", () => {
  it("does not return a magic-byte-only ZIP that cannot actually be unpacked", async () => {
    const response = await fetch(await startApp());

    expect(response.status).toBe(409);
    expect(response.headers.get("content-type")).not.toContain(
      "application/zip",
    );
    expect(await response.json()).toMatchObject({
      error: { code: "ARTIFACT_INTEGRITY_MISMATCH" },
    });
    expect(mocks.readKnowledgeBuildArtifact).toHaveBeenCalledWith({
      userId: 42,
      buildId,
      generation: 2,
      kind: "package",
      expectedSha256: packageSha256,
      expectedBytes: invalidZip.length,
      storageKey: `knowledge-builds/42/${buildId}/generation-2/knowledge-base.zip`,
    });
  });

  it("serves a manifest-bound active Working Set image from the same origin", async () => {
    const response = await fetch(
      await startApp(`working-set/assets/product-main/${"a".repeat(64)}`),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("image/png");
    expect(response.headers.get("content-security-policy")).toContain(
      "default-src 'none'",
    );
    expect(Buffer.from(await response.arrayBuffer())).toEqual(
      Buffer.from("verified-working-set-image"),
    );
    expect(mocks.readValidatedActiveKnowledgeBaseWorkingSet).toHaveBeenCalled();
    expect(mocks.resolveKnowledgeBaseWorkingSetResource).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "asset",
        assetId: "product-main",
        expectedSha256: "a".repeat(64),
      }),
    );
  });

  it("serves the current Working Set through an opaque URL without reflecting internal identity", async () => {
    const handle = knowledgeBasePublicResourceHandle({
      buildId,
      kind: "working_set_asset",
      internalIdentity: `1.1\0private-asset-id\0assets/private-product-name.png\0${"a".repeat(64)}`,
    });
    const response = await fetch(await startApp(`resources/${handle}`, true));

    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(
      Buffer.from("verified-working-set-image"),
    );
    expect(response.headers.get("etag")).toBeNull();
    expect(response.headers.get("content-disposition")).toBe(
      'inline; filename="knowledge-base-image.png"',
    );
    expect(response.url).not.toContain(buildId);
    expect(response.url).not.toContain("private-asset-id");
    expect(response.url).not.toContain("private-product-name.png");
    expect(
      mocks.resolveKnowledgeBaseWorkingSetResourceByOpaqueHandle,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        suppliedHandle: handle,
        buildId,
      }),
    );
  });
});
