import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import sharp from "sharp";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const dependencies = vi.hoisted(() => ({
  getDb: vi.fn(),
  readKnowledgeBuildArtifact: vi.fn(),
  readStoredPresalesFile: vi.fn(),
}));

vi.mock("./db", () => ({ getDb: dependencies.getDb }));
vi.mock("./knowledge-build-artifact-store", () => ({
  readKnowledgeBuildArtifact: dependencies.readKnowledgeBuildArtifact,
}));
vi.mock("./presales-file-store", () => ({
  readStoredPresalesFile: dependencies.readStoredPresalesFile,
}));

import {
  assertKnowledgeBaseFinalLogoProvenance,
  inspectKnowledgeBaseFinalLogoProvenance,
  repairKnowledgeBaseOfficialLogoProvenance,
  replayCompletedKnowledgeBaseLogoProvenanceRepair,
} from "./knowledge-base-logo-provenance-repair";

let logoBytes: Buffer;
let differentLogoBytes: Buffer;

beforeAll(async () => {
  logoBytes = await sharp({
    create: {
      width: 512,
      height: 512,
      channels: 4,
      background: { r: 25, g: 80, b: 160, alpha: 1 },
    },
  })
    .png()
    .toBuffer();
  differentLogoBytes = await sharp({
    create: {
      width: 512,
      height: 512,
      channels: 4,
      background: { r: 160, g: 80, b: 25, alpha: 1 },
    },
  })
    .png()
    .toBuffer();
});

beforeEach(() => {
  dependencies.getDb.mockReset();
  dependencies.readKnowledgeBuildArtifact.mockReset();
  dependencies.readStoredPresalesFile.mockReset();
});

function sha256(bytes: Buffer) {
  return createHash("sha256").update(bytes).digest("hex");
}

function build(overrides: Record<string, unknown> = {}) {
  return {
    id: "10000000-0000-4000-8000-000000000001",
    userId: 7,
    conversationId: "conversation-1",
    skillVersion: "4",
    generation: 3,
    revision: 50,
    currentLeafId: "7.5",
    totalNodeCount: 50,
    confirmedCount: 49,
    directPrefilledCount: 0,
    status: "protocol_error",
    stateEpoch: 11,
    activeTurnId: "failed-final-turn",
    logoStorageKey: "build/logo.png",
    logoSha256: sha256(logoBytes),
    logoBytes: logoBytes.length,
    logoFilename: "legacy-logo.png",
    logoMimeType: "image/png",
    ...overrides,
  };
}

function nodes(finalStatus: "current" | "needs_verification" = "current") {
  return Array.from({ length: 50 }, (_, ordinal) => ({
    leafId: ordinal === 49 ? "7.5" : `leaf-${ordinal}`,
    ordinal,
    status: ordinal === 49 ? finalStatus : "confirmed",
  }));
}

function repairTurn(
  overrides: Record<string, unknown> = {},
  uploadOverrides: Record<string, unknown> = {},
) {
  return {
    id: "repair-turn-1",
    clientRequestId: "logo-repair-request-1",
    operationType: "logo_provenance_repair",
    buildId: "10000000-0000-4000-8000-000000000001",
    buildGeneration: 3,
    expectedRevision: 50,
    expectedLeafId: "7.5",
    attachmentFileIds: ["fresh-logo-file"],
    status: "completed",
    metadata: {
      logoProvenanceRepair: {
        kind: "frontmind.knowledge-base.logo-provenance-repair",
        schemaVersion: 1,
        immutable: true,
        buildId: "10000000-0000-4000-8000-000000000001",
        generation: 3,
        revision: 50,
        leafId: "7.5",
        officialLogoUpload: {
          verified: true,
          index: 0,
          fileId: "fresh-logo-file",
          filename: "fresh-logo.png",
          mimeType: "image/png",
          sizeBytes: logoBytes.length,
          sourceSha256: sha256(logoBytes),
          ...uploadOverrides,
        },
      },
    },
    ...overrides,
  };
}

function thenable<T>(value: T) {
  const promise = Promise.resolve(value);
  const query: any = {
    from: () => query,
    where: () => query,
    limit: () => query,
    orderBy: () => query,
    for: () => query,
    then: promise.then.bind(promise),
    catch: promise.catch.bind(promise),
    finally: promise.finally.bind(promise),
  };
  return query;
}

function fakeDb(input: {
  preliminaryBuild?: ReturnType<typeof build>;
  txSelections?: unknown[][];
  updateAffectedRows?: number;
}) {
  const preliminary = input.preliminaryBuild ?? build();
  const txSelections = [...(input.txSelections || [])];
  const inserted: Record<string, unknown>[] = [];
  const buildUpdates: Record<string, unknown>[] = [];
  const tx = {
    select: vi.fn(() => thenable(txSelections.shift() || [])),
    insert: vi.fn(() => ({
      values: vi.fn(async (value: Record<string, unknown>) => {
        inserted.push(value);
        return [{ affectedRows: 1 }];
      }),
    })),
    update: vi.fn(() => ({
      set: vi.fn((value: Record<string, unknown>) => {
        buildUpdates.push(value);
        return {
          where: vi.fn(async () => [
            { affectedRows: input.updateAffectedRows ?? 1 },
          ]),
        };
      }),
    })),
  };
  const db = {
    select: vi.fn(() => thenable([preliminary])),
    transaction: vi.fn(async (callback: (executor: typeof tx) => unknown) =>
      callback(tx),
    ),
  };
  return { db, tx, inserted, buildUpdates };
}

function uploadInput(bytes = logoBytes) {
  return {
    userId: 7,
    conversationId: "conversation-1",
    clientRequestId: "logo-repair-request-1",
    expectedGeneration: 3,
    expectedRevision: 50,
    expectedLeafId: "7.5",
    attachment: {
      file_id: "fresh-logo-file",
      filename: "fresh-logo.png",
    },
    manifest: {
      filename: "fresh-logo.png",
      sizeBytes: bytes.length,
      mimeType: "image/png",
      lastModified: 1,
      sha256: sha256(bytes),
    },
  };
}

function bindManagedBytes(bytes = logoBytes) {
  dependencies.readStoredPresalesFile.mockResolvedValue({
    filename: "fresh-logo.png",
    mimeType: "image/png",
    recordedSizeBytes: bytes.length,
    sizeBytes: bytes.length,
    sha256: sha256(bytes),
    createReadStream: () => Readable.from(bytes),
  });
  dependencies.readKnowledgeBuildArtifact.mockResolvedValue(logoBytes);
}

describe("knowledge-base Logo provenance repair", () => {
  it.each(["current", "needs_verification"] as const)(
    "does not require provenance at a final %s leaf",
    async (finalStatus) => {
      const stateDb = fakeDb({ preliminaryBuild: build() });
      stateDb.db.select
        .mockImplementationOnce(() => thenable([build()]))
        .mockImplementationOnce(() => thenable(nodes(finalStatus)))
        .mockImplementationOnce(() => thenable([]));
      dependencies.getDb.mockResolvedValue(stateDb.db);

      await expect(
        inspectKnowledgeBaseFinalLogoProvenance({
          userId: 7,
          buildId: build().id,
          generation: 3,
        }),
      ).resolves.toBe("not_applicable");
    },
  );

  it("does not block final reservation preflight", async () => {
    const stateDb = fakeDb({ preliminaryBuild: build() });
    stateDb.db.select
      .mockImplementationOnce(() => thenable([build()]))
      .mockImplementationOnce(() => thenable(nodes()))
      .mockImplementationOnce(() => thenable([]));
    dependencies.getDb.mockResolvedValue(stateDb.db);

    await expect(
      assertKnowledgeBaseFinalLogoProvenance({
        userId: 7,
        buildId: build().id,
        generation: 3,
      }),
    ).resolves.toBe("not_applicable");
    expect(stateDb.db.transaction).not.toHaveBeenCalled();
  });

  it.each(["current", "needs_verification"] as const)(
    "binds exact managed bytes at a final %s leaf without changing business state",
    async (finalStatus) => {
      bindManagedBytes();
      const stateDb = fakeDb({
        txSelections: [
          [build()],
          nodes(finalStatus),
          [{ status: "failed" }],
          [],
        ],
      });
      dependencies.getDb.mockResolvedValue(stateDb.db);

      await expect(
        repairKnowledgeBaseOfficialLogoProvenance(uploadInput()),
      ).resolves.toMatchObject({ idempotent: false });
      expect(stateDb.inserted).toHaveLength(1);
      expect(stateDb.inserted[0]).toMatchObject({
        operationType: "logo_provenance_repair",
        expectedRevision: 50,
        expectedLeafId: "7.5",
        buildGeneration: 3,
        status: "completed",
      });
      expect(stateDb.buildUpdates).toEqual([
        expect.objectContaining({ stateEpoch: 12 }),
      ]);
      expect(stateDb.buildUpdates[0]).not.toHaveProperty("revision");
      expect(stateDb.buildUpdates[0]).not.toHaveProperty("currentLeafId");
      expect(stateDb.buildUpdates[0]).not.toHaveProperty("status");
      expect(stateDb.buildUpdates[0]).not.toHaveProperty("confirmedCount");
      expect(stateDb.buildUpdates[0]).not.toHaveProperty(
        "directPrefilledCount",
      );
    },
  );

  it("rejects a visually valid but byte-different Logo before any ledger write", async () => {
    bindManagedBytes(differentLogoBytes);
    const stateDb = fakeDb({});
    dependencies.getDb.mockResolvedValue(stateDb.db);

    await expect(
      repairKnowledgeBaseOfficialLogoProvenance(
        uploadInput(differentLogoBytes),
      ),
    ).rejects.toMatchObject({
      code: "KNOWLEDGE_BASE_LOGO_REPAIR_UPLOAD_INVALID",
    });
    expect(stateDb.db.transaction).not.toHaveBeenCalled();
    expect(stateDb.inserted).toEqual([]);
  });

  it("coalesces an exact replay of the same immutable repair upload", async () => {
    bindManagedBytes();
    const stateDb = fakeDb({
      txSelections: [
        [build()],
        nodes(),
        [{ status: "failed" }],
        [repairTurn()],
      ],
    });
    dependencies.getDb.mockResolvedValue(stateDb.db);

    await expect(
      repairKnowledgeBaseOfficialLogoProvenance(uploadInput()),
    ).resolves.toMatchObject({ idempotent: true });
    expect(stateDb.inserted).toEqual([]);
    expect(stateDb.buildUpdates).toEqual([]);
  });

  it("replays a committed repair before rereading an expired upload", async () => {
    const stateDb = fakeDb({});
    stateDb.db.select
      .mockImplementationOnce(() =>
        thenable([{ id: build().id, generation: 3 }]),
      )
      .mockImplementationOnce(() => thenable([repairTurn()]));
    dependencies.getDb.mockResolvedValue(stateDb.db);
    dependencies.readStoredPresalesFile.mockRejectedValue(
      new Error("expired upload must not be read"),
    );

    await expect(
      replayCompletedKnowledgeBaseLogoProvenanceRepair(uploadInput()),
    ).resolves.toMatchObject({ idempotent: true });
    expect(dependencies.readStoredPresalesFile).not.toHaveBeenCalled();
    expect(dependencies.readKnowledgeBuildArtifact).not.toHaveBeenCalled();
  });

  it("does not coalesce a different client request onto an existing repair", async () => {
    const stateDb = fakeDb({});
    stateDb.db.select
      .mockImplementationOnce(() =>
        thenable([{ id: build().id, generation: 3 }]),
      )
      .mockImplementationOnce(() => thenable([repairTurn()]));
    dependencies.getDb.mockResolvedValue(stateDb.db);

    await expect(
      replayCompletedKnowledgeBaseLogoProvenanceRepair({
        ...uploadInput(),
        clientRequestId: "different-request",
      }),
    ).resolves.toBeNull();
  });

  it("rejects a second or conflicting Logo provenance ledger", async () => {
    bindManagedBytes();
    const stateDb = fakeDb({
      txSelections: [
        [build()],
        nodes(),
        [{ status: "failed" }],
        [repairTurn(), repairTurn({ id: "repair-turn-2" })],
      ],
    });
    dependencies.getDb.mockResolvedValue(stateDb.db);

    await expect(
      repairKnowledgeBaseOfficialLogoProvenance(uploadInput()),
    ).rejects.toMatchObject({
      code: "KNOWLEDGE_BASE_LOGO_PROVENANCE_CONFLICT",
    });
    expect(stateDb.inserted).toEqual([]);
  });

  it("isolates the repair by build generation", async () => {
    bindManagedBytes();
    const stateDb = fakeDb({});
    dependencies.getDb.mockResolvedValue(stateDb.db);

    await expect(
      repairKnowledgeBaseOfficialLogoProvenance({
        ...uploadInput(),
        expectedGeneration: 4,
      }),
    ).rejects.toMatchObject({
      code: "KNOWLEDGE_BASE_LOGO_REPAIR_BUILD_CHANGED",
    });
    expect(stateDb.db.transaction).not.toHaveBeenCalled();
  });

  it("fails closed when the build epoch compare-and-swap loses", async () => {
    bindManagedBytes();
    const stateDb = fakeDb({
      updateAffectedRows: 0,
      txSelections: [[build()], nodes(), [{ status: "failed" }], []],
    });
    dependencies.getDb.mockResolvedValue(stateDb.db);

    await expect(
      repairKnowledgeBaseOfficialLogoProvenance(uploadInput()),
    ).rejects.toMatchObject({
      code: "KNOWLEDGE_BASE_LOGO_REPAIR_BUILD_CHANGED",
    });
  });
});
