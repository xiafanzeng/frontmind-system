import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import express from "express";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const buildId = "123e4567-e89b-42d3-a456-426614174000";
const turnId = "223e4567-e89b-42d3-a456-426614174001";

const mocks = vi.hoisted(() => ({
  getDb: vi.fn(),
  readStoredPresalesFile: vi.fn(),
  declaredImages: vi.fn(),
  verifiedImages: vi.fn(),
}));

vi.mock("./db", () => ({ getDb: mocks.getDb }));

vi.mock("./presales-file-store", () => ({
  readStoredPresalesFile: mocks.readStoredPresalesFile,
}));

vi.mock("./knowledge-base-customer-upload", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./knowledge-base-customer-upload")>();
  return {
    ...actual,
    declaredKnowledgeBaseCustomerUploadImagesFromTurn: mocks.declaredImages,
    verifiedKnowledgeBaseCustomerUploadImagesFromTurn: mocks.verifiedImages,
  };
});

import artifactRouter from "./knowledge-base-artifact-api";
import {
  knowledgeBaseCustomerUploadInternalIdentity,
  type KnowledgeBaseCustomerUploadImage,
} from "./knowledge-base-customer-upload";
import { knowledgeBasePublicResourceHandle } from "./knowledge-base-public-resource";

const servers: Server[] = [];

function sha256(bytes: Buffer) {
  return createHash("sha256").update(bytes).digest("hex");
}

function configureDatabase(
  input: {
    buildUserId?: number;
    turnUserId?: number;
    turnBuildId?: string;
    turnGeneration?: number;
    turnStatus?: string;
    includeTurn?: boolean;
  } = {},
) {
  let selectCount = 0;
  mocks.getDb.mockResolvedValue({
    select: () => ({
      from: () => {
        selectCount += 1;
        const rows =
          selectCount === 1
            ? [
                {
                  id: buildId,
                  userId: input.buildUserId ?? 42,
                  generation: 3,
                },
              ]
            : input.includeTurn === false
              ? []
              : [
                  {
                    id: turnId,
                    userId: input.turnUserId ?? 42,
                    buildId: input.turnBuildId ?? buildId,
                    buildGeneration: input.turnGeneration ?? 3,
                    status: input.turnStatus ?? "completed",
                    expectedLeafId: "1.2",
                    attachmentFileIds: ["customer-file-1"],
                    metadata: {},
                  },
                ];
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
}

function configureImage(input: {
  bytes: Buffer;
  filename: string;
  mimeType: string;
  storedBytes?: Buffer;
}) {
  const sourceSha256 = sha256(input.bytes);
  mocks.verifiedImages.mockResolvedValue([
    {
      turnId,
      leafId: "1.2",
      index: 0,
      fileId: "customer-file-1",
      filename: input.filename,
      mimeType: input.mimeType,
      sizeBytes: input.bytes.length,
      sourceSha256,
    },
  ]);
  mocks.declaredImages.mockReturnValue([
    {
      turnId,
      leafId: "1.2",
      index: 0,
      fileId: "customer-file-1",
      filename: input.filename,
      mimeType: input.mimeType,
      sizeBytes: input.bytes.length,
      sourceSha256,
    },
  ]);
  mocks.readStoredPresalesFile.mockResolvedValue({
    filename: input.filename,
    mimeType: input.mimeType,
    sizeBytes: input.bytes.length,
    sha256: sourceSha256,
    createReadStream: () => Readable.from([input.storedBytes ?? input.bytes]),
  });
  return sourceSha256;
}

async function startApp(sourceSha256: string, authenticated = true) {
  const app = express();
  app.use((req: any, _res, next) => {
    if (authenticated) {
      req.frontmindUser = {
        id: 42,
        username: "knowledge-user",
        role: "user",
      };
    }
    next();
  });
  app.use("/api/knowledge-base/artifacts", artifactRouter);
  const server = createServer(app);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}/api/knowledge-base/artifacts/${buildId}/customer-uploads/${turnId}/0/${sourceSha256}`;
}

async function startOpaqueApp(handle: string) {
  const app = express();
  app.use((req: any, _res, next) => {
    req.frontmindUser = {
      id: 42,
      username: "knowledge-user",
      role: "user",
    };
    next();
  });
  app.use("/api/knowledge-base/artifacts", artifactRouter);
  const server = createServer(app);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}/api/knowledge-base/artifacts/resources/${handle}`;
}

beforeEach(() => {
  mocks.getDb.mockReset();
  mocks.readStoredPresalesFile.mockReset();
  mocks.declaredImages.mockReset();
  mocks.verifiedImages.mockReset();
  configureDatabase();
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

describe("knowledge-base customer-upload image preview", () => {
  it("serves a hash-verified raster as a decoded same-origin PNG", async () => {
    const source = await sharp({
      create: {
        width: 24,
        height: 16,
        channels: 4,
        background: { r: 30, g: 120, b: 210, alpha: 0.8 },
      },
    })
      .webp()
      .toBuffer();
    const sourceSha256 = configureImage({
      bytes: source,
      filename: "customer-photo.webp",
      mimeType: "image/webp",
    });

    const response = await fetch(await startApp(sourceSha256));
    const preview = Buffer.from(await response.arrayBuffer());

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("cross-origin-resource-policy")).toBe(
      "same-origin",
    );
    expect(response.headers.get("content-disposition")).toContain("inline;");
    expect(preview.subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
    await expect(sharp(preview).metadata()).resolves.toMatchObject({
      format: "png",
      width: 24,
      height: 16,
    });
  });

  it("sanitizes an SVG by rasterizing it instead of returning active XML", async () => {
    const source = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 10"><rect width="20" height="10" fill="#491060"/></svg>',
      "utf8",
    );
    const sourceSha256 = configureImage({
      bytes: source,
      filename: "customer-logo.svg",
      mimeType: "image/svg+xml",
    });

    const response = await fetch(await startApp(sourceSha256));
    const preview = Buffer.from(await response.arrayBuffer());

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(preview.toString("utf8").toLowerCase()).not.toContain("<svg");
    await expect(sharp(preview).metadata()).resolves.toMatchObject({
      format: "png",
    });
  });

  it("serves the current exact customer upload through an opaque URL without reflecting its filename or digest", async () => {
    const source = await sharp({
      create: {
        width: 12,
        height: 9,
        channels: 4,
        background: { r: 50, g: 80, b: 120, alpha: 1 },
      },
    })
      .png()
      .toBuffer();
    const sourceSha256 = configureImage({
      bytes: source,
      filename: "private-customer-name.png",
      mimeType: "image/png",
    });
    const image: KnowledgeBaseCustomerUploadImage = {
      turnId,
      leafId: "1.2",
      index: 0,
      fileId: "customer-file-1",
      filename: "private-customer-name.png",
      mimeType: "image/png",
      sizeBytes: source.length,
      sourceSha256,
    };
    const handle = knowledgeBasePublicResourceHandle({
      buildId,
      kind: "customer_upload",
      internalIdentity: knowledgeBaseCustomerUploadInternalIdentity(image),
    });

    const response = await fetch(await startOpaqueApp(handle));
    const preview = Buffer.from(await response.arrayBuffer());

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("etag")).toBeNull();
    expect(response.headers.get("content-disposition")).toBe(
      'inline; filename="knowledge-base-image.png"',
    );
    expect(response.url).not.toContain(buildId);
    expect(response.url).not.toContain(turnId);
    expect(response.url).not.toContain(sourceSha256);
    expect(response.url).not.toContain("private-customer-name.png");
    await expect(sharp(preview).metadata()).resolves.toMatchObject({
      format: "png",
      width: 12,
      height: 9,
    });
  });

  it("rejects SVG external resources before rasterization", async () => {
    const source = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg"><image href="http://169.254.169.254/latest/meta-data"/></svg>',
      "utf8",
    );
    const sourceSha256 = configureImage({
      bytes: source,
      filename: "unsafe.png",
      mimeType: "image/png",
    });

    const response = await fetch(await startApp(sourceSha256));

    expect(response.status).toBe(415);
    expect(await response.json()).toMatchObject({
      error: { code: "CUSTOMER_UPLOAD_IMAGE_UNSAFE" },
    });
  });

  it("does not expose a turn from another build generation", async () => {
    configureDatabase({ turnGeneration: 2 });
    const source = await sharp({
      create: {
        width: 2,
        height: 2,
        channels: 3,
        background: { r: 0, g: 0, b: 0 },
      },
    })
      .png()
      .toBuffer();
    const sourceSha256 = configureImage({
      bytes: source,
      filename: "private.png",
      mimeType: "image/png",
    });

    const response = await fetch(await startApp(sourceSha256));

    expect(response.status).toBe(404);
    expect(mocks.verifiedImages).not.toHaveBeenCalled();
    expect(mocks.readStoredPresalesFile).not.toHaveBeenCalled();
  });

  it("rejects bytes that no longer match the captured source hash", async () => {
    const source = await sharp({
      create: {
        width: 4,
        height: 4,
        channels: 3,
        background: { r: 100, g: 20, b: 10 },
      },
    })
      .png()
      .toBuffer();
    const tampered = Buffer.from(source);
    tampered[tampered.length - 1] ^= 0xff;
    const sourceSha256 = configureImage({
      bytes: source,
      storedBytes: tampered,
      filename: "customer.png",
      mimeType: "image/png",
    });

    const response = await fetch(await startApp(sourceSha256));

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: { code: "CUSTOMER_UPLOAD_INTEGRITY_MISMATCH" },
    });
  });

  it("requires an authenticated user before reading build or file state", async () => {
    const sourceSha256 = "a".repeat(64);
    const response = await fetch(await startApp(sourceSha256, false));

    expect(response.status).toBe(401);
    expect(mocks.getDb).not.toHaveBeenCalled();
    expect(mocks.readStoredPresalesFile).not.toHaveBeenCalled();
  });
});
