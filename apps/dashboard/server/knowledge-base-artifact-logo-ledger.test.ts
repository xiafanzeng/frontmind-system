import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const packageBytes = Buffer.from("validated-customer-logo-package");
const packageSha256 = createHash("sha256").update(packageBytes).digest("hex");
const logoSha256 = "a".repeat(64);
const buildId = "123e4567-e89b-42d3-a456-426614174000";
const officialLogoUpload = {
  turnId: "turn-logo",
  leafId: "1.1",
  index: 0,
  fileId: "file-logo",
  filename: "company-logo.png",
  mimeType: "image/png",
  sizeBytes: 42,
  sourceSha256: logoSha256,
};

const mocks = vi.hoisted(() => ({
  getDb: vi.fn(),
  readKnowledgeBuildArtifact: vi.fn(),
  validateKnowledgeArchiveForDownload: vi.fn(),
  assertKnowledgeBasePackageMatchesBuild: vi.fn(),
  packageUploadEvidence: vi.fn(),
  assertCustomerUploadVisualBindings: vi.fn(),
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

vi.mock("./dashboard-api", () => ({
  KnowledgeArchiveValidationError: class KnowledgeArchiveValidationError extends Error {},
  readStoredKnowledgeAssetBytes: vi.fn(),
  validateKnowledgeArchiveForDownload:
    mocks.validateKnowledgeArchiveForDownload,
}));

vi.mock("./knowledge-base-package-validation", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("./knowledge-base-package-validation")
    >();
  return {
    ...actual,
    assertKnowledgeBasePackageMatchesBuild:
      mocks.assertKnowledgeBasePackageMatchesBuild,
  };
});

vi.mock("./knowledge-base-customer-upload", () => ({
  assertKnowledgeBaseCustomerUploadVisualBindings:
    mocks.assertCustomerUploadVisualBindings,
  verifiedKnowledgeBaseCustomerUploadImagesFromTurn: vi.fn(),
  verifiedKnowledgeBasePackageUploadEvidenceForBuild:
    mocks.packageUploadEvidence,
}));

import artifactRouter from "./knowledge-base-artifact-api";

const servers: Server[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  let selectCount = 0;
  mocks.getDb.mockResolvedValue({
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
                  treePolicyVersion: 1,
                  initialResearchCoverage: null,
                  revision: 8,
                  logoStorageKey: `knowledge-builds/42/${buildId}/generation-2/official-logo.bin`,
                  logoSha256,
                  logoBytes: 42,
                  logoFilename: "company-logo.png",
                  logoMimeType: "image/png",
                  packageStorageKey: `knowledge-builds/42/${buildId}/generation-2/knowledge-base.zip`,
                  packageArchiveSha256: packageSha256,
                  packageSizeBytes: packageBytes.length,
                  packageFilename: "knowledge-base.zip",
                },
              ],
            }),
          };
        }
        return {
          where: async () => [
            {
              leafId: "1.1",
              title: "企业身份",
              branchId: "1",
              branchTitle: "企业与品牌",
              ordinal: 0,
              status: "confirmed",
              contentMarkdown: "企业正文",
              contentSha256: null,
            },
          ],
        };
      },
    }),
  });
  mocks.readKnowledgeBuildArtifact.mockResolvedValue(packageBytes);
  mocks.packageUploadEvidence.mockResolvedValue({
    expectedCustomerUploads: [],
    expectedOfficialLogoUpload: officialLogoUpload,
    expectedOfficialLogoProvenance: undefined,
  });
  mocks.validateKnowledgeArchiveForDownload.mockImplementation(
    async (input: {
      validateParsed?: (parsed: unknown) => Promise<void> | void;
    }) => {
      await input.validateParsed?.({
        packageBuildRevision: 8,
        packageSchemaVersion: 4,
        documents: [],
        assets: [],
      });
    },
  );
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

describe("knowledge-base customer-upload Logo immutable download", () => {
  it("revalidates against the dedicated Logo ledger instead of treating it as an ordinary upload", async () => {
    const response = await fetch(await startApp());

    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(packageBytes);
    expect(mocks.packageUploadEvidence).toHaveBeenCalledWith({
      userId: 42,
      buildId,
      generation: 2,
      officialLogoSha256: logoSha256,
      packageArchiveSha256: packageSha256,
    });
    expect(mocks.assertKnowledgeBasePackageMatchesBuild).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedCustomerUploads: [],
        expectedOfficialLogoUpload: officialLogoUpload,
        expectedOfficialLogoProvenance: undefined,
      }),
    );
  });
});
