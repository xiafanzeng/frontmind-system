import { createHash } from "node:crypto";
import { Readable } from "node:stream";

import { beforeEach, describe, expect, it, vi } from "vitest";

const dependencies = vi.hoisted(() => ({
  getDb: vi.fn(),
  readStoredPresalesFile: vi.fn(),
  removeStoredPresalesFile: vi.fn(),
  stagePresalesFileContent: vi.fn(),
  withStoredPresalesFileMutationLock: vi.fn(
    async (_id: string, callback: () => Promise<unknown>) => callback(),
  ),
}));

vi.mock("../db", () => ({ getDb: dependencies.getDb }));
vi.mock("../presales-file-store", () => ({
  readStoredPresalesFile: dependencies.readStoredPresalesFile,
  removeStoredPresalesFile: dependencies.removeStoredPresalesFile,
  stagePresalesFileContent: dependencies.stagePresalesFileContent,
  withStoredPresalesFileMutationLock:
    dependencies.withStoredPresalesFileMutationLock,
}));

import { persistSiteOpsArtifact } from "./artifact-store";

const sha256 = (value: Buffer) =>
  createHash("sha256").update(value).digest("hex");

describe("SiteOps idempotent artifact persistence", () => {
  const rows: Array<Record<string, any>> = [];
  const bodies = new Map<string, Buffer>();
  let synchronizeFirstTwoReads = false;

  beforeEach(() => {
    rows.length = 0;
    bodies.clear();
    synchronizeFirstTwoReads = false;
    vi.clearAllMocks();

    let initialReads = 0;
    let releaseInitialReads!: () => void;
    const bothInitialReads = new Promise<void>((resolve) => {
      releaseInitialReads = resolve;
    });
    const db = {
      select: () => {
        const query: any = {
          from: () => query,
          where: () => query,
          limit: async () => {
            initialReads += 1;
            if (synchronizeFirstTwoReads && initialReads <= 2) {
              if (initialReads === 2) releaseInitialReads();
              await bothInitialReads;
            }
            return rows.slice(0, 1);
          },
        };
        return query;
      },
      insert: () => ({
        values: async (value: Record<string, any>) => {
          if (rows.some((row) => row.id === value.id)) {
            throw new Error("DUPLICATE_LOCAL_ASSET");
          }
          rows.push(value);
        },
      }),
    };
    dependencies.getDb.mockResolvedValue(db);
    dependencies.stagePresalesFileContent.mockImplementation(
      async (input: { fileId: string; stream: Readable }) => {
        const chunks: Buffer[] = [];
        for await (const chunk of input.stream) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        const bytes = Buffer.concat(chunks);
        return {
          sizeBytes: bytes.length,
          sha256: sha256(bytes),
          createReadStream: () => Readable.from([bytes]),
          discard: vi.fn(async () => undefined),
          commit: vi.fn(async () => {
            bodies.set(input.fileId, bytes);
          }),
        };
      },
    );
    dependencies.readStoredPresalesFile.mockImplementation(
      async (id: string) => {
        const bytes = bodies.get(id);
        return bytes
          ? {
              filename: "artifact.zip",
              mimeType: "application/zip",
              sizeBytes: bytes.length,
              sha256: sha256(bytes),
              createReadStream: () => Readable.from([bytes]),
            }
          : null;
      },
    );
    dependencies.removeStoredPresalesFile.mockImplementation(
      async (id: string) => {
        bodies.delete(id);
      },
    );
  });

  it("returns one equivalent row across a duplicate reclaim and never deletes shared bytes", async () => {
    const bytes = Buffer.from("validated-source", "utf8");
    const retainUntil = new Date(Date.now() + 24 * 60 * 60 * 1_000);
    const input = {
      userId: 7,
      projectId: "20000000-0000-4000-8000-000000000002",
      kind: "site-source-staging",
      filename: "artifact.zip",
      mimeType: "application/zip",
      buffer: bytes,
      idempotencyKey: "operation:source:0",
      retainUntil,
    };

    synchronizeFirstTwoReads = true;
    const [first, reclaimed] = await Promise.all([
      persistSiteOpsArtifact(input),
      persistSiteOpsArtifact(input),
    ]);

    expect(first.id).toBe(reclaimed.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: first.id,
      contentSha256: sha256(bytes),
      retainUntil,
    });
    expect(bodies.get(first.id)).toEqual(bytes);
    expect(dependencies.removeStoredPresalesFile).not.toHaveBeenCalled();
  });

  it("finishes expensive staging before locking and discards its temp when a waiter already won", async () => {
    const bytes = Buffer.from("slow-validated-source", "utf8");
    const retainUntil = new Date(Date.now() + 24 * 60 * 60 * 1_000);
    const commit = vi.fn(async () => undefined);
    const discard = vi.fn(async () => undefined);
    let finishSlowStage!: (value: Record<string, unknown>) => void;
    dependencies.stagePresalesFileContent.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishSlowStage = resolve;
        }),
    );
    dependencies.withStoredPresalesFileMutationLock.mockImplementationOnce(
      async (id: string, callback: () => Promise<unknown>) => {
        const winner = {
          id,
          scope: "managed_user",
          accountUserId: 7,
          presalesProjectId: null,
          filename: "artifact.zip",
          mimeType: "application/zip",
          sizeBytes: bytes.length,
          contentSha256: sha256(bytes),
          storageKey: `siteops:20000000-0000-4000-8000-000000000002:site-source-staging:${id}`,
          storageKeyHash: "f".repeat(64),
          refCount: 1,
          retainUntil,
          createdAt: new Date(),
        };
        rows.push(winner);
        bodies.set(id, bytes);
        return callback();
      },
    );

    const persisting = persistSiteOpsArtifact({
      userId: 7,
      projectId: "20000000-0000-4000-8000-000000000002",
      kind: "site-source-staging",
      filename: "artifact.zip",
      mimeType: "application/zip",
      buffer: bytes,
      idempotencyKey: "operation:slow-source:0",
      retainUntil,
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(
      dependencies.withStoredPresalesFileMutationLock,
    ).not.toHaveBeenCalled();

    finishSlowStage({
      sizeBytes: bytes.length,
      sha256: sha256(bytes),
      createReadStream: () => Readable.from([bytes]),
      commit,
      discard,
    });
    const result = await persisting;

    expect(result).toBe(rows[0]);
    expect(commit).not.toHaveBeenCalled();
    expect(discard).toHaveBeenCalledTimes(1);
    expect(bodies.get(result.id)).toEqual(bytes);
    expect(dependencies.removeStoredPresalesFile).not.toHaveBeenCalled();
  });
});
