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

import artifactRouter from "./knowledge-base-artifact-api";

const servers: Server[] = [];

beforeEach(() => {
  let selectCount = 0;
  mocks.getDb.mockReset().mockResolvedValue({
    select: () => ({
      from: () => {
        selectCount += 1;
        if (selectCount === 1) {
          return {
            where: () => ({
              limit: async () => [
                {
                  id: buildId,
                  userId: 42,
                  generation: 2,
                  status: "ready_to_publish",
                  skillVersion: "4",
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
              ],
            }),
          };
        }
        return { where: async () => [] };
      },
    }),
  });
  mocks.readKnowledgeBuildArtifact.mockReset().mockResolvedValue(invalidZip);
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
  app.use((req: any, _res, next) => {
    req.frontmindUser = { id: 42, username: "knowledge-user", role: "user" };
    next();
  });
  app.use("/api/knowledge-base/artifacts", artifactRouter);
  const server = createServer(app);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}/api/knowledge-base/artifacts/${buildId}/package`;
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
});
