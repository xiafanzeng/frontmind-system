import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  acquirePresalesFileCreateReservation,
  completePresalesFileCreateReservation,
  hashPresalesFileCreatePayload,
  hashPresalesFileIdempotencyKey,
  markStoredPresalesFileRetention,
  readPresalesFileLifecycle,
  readStoredPresalesFile,
  recordPresalesFileDescriptor,
  removePresalesFileCreateReservation,
  stagePresalesFileContent,
  sweepPresalesFileStorageRetention,
} from "./presales-file-store";

const originalAssetDir = process.env.FRONTMIND_DASHBOARD_ASSET_DIR;
let assetDir = "";

describe("durable presales file-create reservations", () => {
  beforeEach(async () => {
    assetDir = await mkdtemp(path.join(tmpdir(), "presales-file-ledger-"));
    process.env.FRONTMIND_DASHBOARD_ASSET_DIR = assetDir;
  });

  afterEach(async () => {
    if (originalAssetDir === undefined) {
      delete process.env.FRONTMIND_DASHBOARD_ASSET_DIR;
    } else {
      process.env.FRONTMIND_DASHBOARD_ASSET_DIR = originalAssetDir;
    }
    await rm(assetDir, { recursive: true, force: true });
  });

  it("replays one completed file after response loss and a fresh caller", async () => {
    const idempotencyKey = "geo-custom-file:stable-operation:archive:v1";
    const requestHash = hashPresalesFileCreatePayload({
      filename: "knowledge.zip",
      mimeType: "application/zip",
      sizeBytes: 123,
    });
    const acquired = await acquirePresalesFileCreateReservation({
      idempotencyKey,
      requestHash,
      apiCredentialId: "credential-1",
      credentialVersion: 3,
      now: new Date("2026-08-02T08:00:00.000Z"),
    });
    expect(acquired.state).toBe("acquired");
    if (acquired.state !== "acquired") throw new Error("not acquired");

    await completePresalesFileCreateReservation({
      keyHash: acquired.keyHash,
      attemptId: acquired.attemptId,
      upstreamFileId: "upstream-file-1",
      upstreamFilename: "knowledge.zip",
      upstreamStatus: "pending",
      uploadUrl: "https://uploads.example.test/knowledge.zip?signature=secret",
      uploadExpiresAt: "2026-08-02T08:10:00.000Z",
      now: new Date("2026-08-02T08:00:01.000Z"),
    });

    // The API response can disappear here. A new process has no in-memory
    // state; it resolves the same operation solely from the persistent volume.
    const replay = await acquirePresalesFileCreateReservation({
      idempotencyKey,
      requestHash,
      apiCredentialId: "credential-1",
      credentialVersion: 3,
      now: new Date("2026-08-02T08:00:02.000Z"),
    });
    expect(replay).toMatchObject({
      state: "completed",
      upstreamFileId: "upstream-file-1",
      upstreamFilename: "knowledge.zip",
    });

    const reservationPath = path.join(
      assetDir,
      "presales-files",
      "create-reservations",
      `${hashPresalesFileIdempotencyKey(idempotencyKey)}.json`,
    );
    const persisted = await readFile(reservationPath, "utf8");
    expect(persisted).not.toContain(idempotencyKey);
    expect((await stat(reservationPath)).mode & 0o777).toBe(0o600);
  });

  it("replays the completed file after response loss, restart, and credential rotation", async () => {
    const idempotencyKey = "geo-custom-file:rotation-loss:skill:v1";
    const requestHash = hashPresalesFileCreatePayload({
      filename: "classifier.skill.zip",
      mimeType: "application/zip",
      sizeBytes: 456,
    });
    const first = await acquirePresalesFileCreateReservation({
      idempotencyKey,
      requestHash,
      apiCredentialId: "credential-old",
      credentialVersion: 7,
    });
    if (first.state !== "acquired") throw new Error("not acquired");
    await completePresalesFileCreateReservation({
      keyHash: first.keyHash,
      attemptId: first.attemptId,
      upstreamFileId: "file-created-before-rotation",
      upstreamFilename: "classifier.skill.zip",
    });

    // A restarted proxy sees only the durable ledger and the newly active
    // credential. The immutable completed operation still resolves to the
    // original file instead of creating or exposing a second file.
    const replay = await acquirePresalesFileCreateReservation({
      idempotencyKey,
      requestHash,
      apiCredentialId: "credential-new",
      credentialVersion: 8,
    });
    expect(replay).toMatchObject({
      state: "completed",
      upstreamFileId: "file-created-before-rotation",
    });
    const mismatchedReplay = await acquirePresalesFileCreateReservation({
      idempotencyKey,
      requestHash: hashPresalesFileCreatePayload({
        filename: "different.skill.zip",
        mimeType: "application/zip",
        sizeBytes: 456,
      }),
      apiCredentialId: "credential-new",
      credentialVersion: 8,
    });
    expect(mismatchedReplay).toEqual({ state: "conflict" });

    await removePresalesFileCreateReservation("file-created-before-rotation");
    const retiredReplay = await acquirePresalesFileCreateReservation({
      idempotencyKey,
      requestHash,
      apiCredentialId: "credential-newer",
      credentialVersion: 9,
    });
    expect(retiredReplay).toEqual({
      state: "deleted",
      upstreamFileId: "file-created-before-rotation",
    });
  });

  it("keeps a permanent compact tombstone after cleanup", async () => {
    const idempotencyKey = "geo-custom-file:stable-operation:skill:v1";
    const requestHash = hashPresalesFileCreatePayload({
      filename: "classifier.skill.zip",
      mimeType: "application/zip",
      sizeBytes: 456,
    });
    const input = {
      idempotencyKey,
      requestHash,
      apiCredentialId: "credential-1",
      credentialVersion: 3,
    };
    const acquired = await acquirePresalesFileCreateReservation(input);
    if (acquired.state !== "acquired") throw new Error("not acquired");
    await completePresalesFileCreateReservation({
      keyHash: acquired.keyHash,
      attemptId: acquired.attemptId,
      upstreamFileId: "upstream-file-cleaned",
      upstreamFilename: "classifier.skill.zip",
      uploadUrl: "https://uploads.example.test/skill.zip?secret=value",
    });

    await removePresalesFileCreateReservation("upstream-file-cleaned");
    const replay = await acquirePresalesFileCreateReservation(input);
    expect(replay).toEqual({
      state: "deleted",
      upstreamFileId: "upstream-file-cleaned",
    });

    const root = path.join(assetDir, "presales-files", "create-reservations");
    const entries = await readdir(root);
    const tombstonePath = path.join(
      root,
      `${hashPresalesFileIdempotencyKey(idempotencyKey)}.json`,
    );
    const tombstone = await readFile(tombstonePath, "utf8");
    expect(entries).toContain(path.basename(tombstonePath));
    expect(tombstone).not.toContain("uploads.example.test");
    expect(tombstone).not.toContain("classifier.skill.zip");
    expect(Buffer.byteLength(tombstone)).toBeLessThan(1_024);
  });

  it("reclaims only an expired lease with the same upstream key hash", async () => {
    const idempotencyKey = "geo-custom-file:ambiguous-response:archive:v1";
    const requestHash = hashPresalesFileCreatePayload({
      filename: "archive.zip",
      sizeBytes: 10,
    });
    const first = await acquirePresalesFileCreateReservation({
      idempotencyKey,
      requestHash,
      apiCredentialId: "credential-1",
      credentialVersion: 1,
      now: new Date("2026-08-02T08:00:00.000Z"),
      leaseMs: 1_000,
    });
    expect(first.state).toBe("acquired");

    const pending = await acquirePresalesFileCreateReservation({
      idempotencyKey,
      requestHash,
      apiCredentialId: "credential-1",
      credentialVersion: 1,
      now: new Date("2026-08-02T08:00:00.500Z"),
      leaseMs: 1_000,
    });
    expect(pending.state).toBe("pending");

    const recovered = await acquirePresalesFileCreateReservation({
      idempotencyKey,
      requestHash,
      apiCredentialId: "credential-1",
      credentialVersion: 1,
      now: new Date("2026-08-02T08:00:02.000Z"),
      leaseMs: 1_000,
    });
    expect(recovered).toMatchObject({
      state: "acquired",
      keyHash: hashPresalesFileIdempotencyKey(idempotencyKey),
    });
    if (first.state === "acquired" && recovered.state === "acquired") {
      expect(recovered.attemptId).not.toBe(first.attemptId);
    }
  });

  it("rejects reusing one operation key for different file metadata", async () => {
    const idempotencyKey = "geo-custom-file:metadata-conflict:skill:v1";
    await acquirePresalesFileCreateReservation({
      idempotencyKey,
      requestHash: hashPresalesFileCreatePayload({
        filename: "one.zip",
        sizeBytes: 10,
      }),
      apiCredentialId: "credential-1",
      credentialVersion: 1,
    });
    const conflict = await acquirePresalesFileCreateReservation({
      idempotencyKey,
      requestHash: hashPresalesFileCreatePayload({
        filename: "two.zip",
        sizeBytes: 10,
      }),
      apiCredentialId: "credential-1",
      credentialVersion: 1,
    });
    expect(conflict.state).toBe("conflict");
  });
});

describe("presales file content retention manifest", () => {
  beforeEach(async () => {
    assetDir = await mkdtemp(path.join(tmpdir(), "presales-file-content-"));
    process.env.FRONTMIND_DASHBOARD_ASSET_DIR = assetDir;
  });

  afterEach(async () => {
    if (originalAssetDir === undefined) {
      delete process.env.FRONTMIND_DASHBOARD_ASSET_DIR;
    } else {
      process.env.FRONTMIND_DASHBOARD_ASSET_DIR = originalAssetDir;
    }
    await rm(assetDir, { recursive: true, force: true });
  });

  async function store(input: {
    fileId: string;
    body?: string;
    uploadedAt?: Date | string;
    contentExpiresAt?: Date | string;
  }) {
    const body = input.body ?? input.fileId;
    const staged = await stagePresalesFileContent({
      fileId: input.fileId,
      stream: Readable.from([body]),
      maxBytes: 1_024,
    });
    await staged.commit({
      filename: `${input.fileId}.pdf`,
      mimeType: "application/pdf",
      uploadedAt: input.uploadedAt,
      contentExpiresAt: input.contentExpiresAt,
    });
  }

  it("persists an immutable upload deadline across later commits", async () => {
    const uploadedAt = new Date("2026-01-01T00:00:00.000Z");
    const contentExpiresAt = new Date("2026-01-31T00:00:00.000Z");
    await store({ fileId: "user-upload", uploadedAt, contentExpiresAt });

    await store({
      fileId: "user-upload",
      body: "replacement bytes",
      uploadedAt: new Date("2026-02-01T00:00:00.000Z"),
      contentExpiresAt: new Date("2026-03-03T00:00:00.000Z"),
    });
    await recordPresalesFileDescriptor({
      fileId: "user-upload",
      filename: "descriptor replay.pdf",
    });

    const stored = await readStoredPresalesFile("user-upload");
    expect(stored?.uploadedAt?.toISOString()).toBe(uploadedAt.toISOString());
    expect(stored?.contentExpiresAt?.toISOString()).toBe(
      contentExpiresAt.toISOString(),
    );
    expect(stored?.manifestUpdatedAt).toBeInstanceOf(Date);
  });

  it("stamps a legacy stored manifest without rewriting its bytes", async () => {
    await store({ fileId: "legacy-user-upload", body: "original bytes" });
    const uploadedAt = new Date("2026-01-01T00:00:00.000Z");
    const contentExpiresAt = new Date("2026-01-31T00:00:00.000Z");

    await expect(
      markStoredPresalesFileRetention({
        fileId: "legacy-user-upload",
        uploadedAt,
        contentExpiresAt,
      }),
    ).resolves.toBe(true);

    const stored = await readStoredPresalesFile("legacy-user-upload");
    expect(stored?.uploadedAt).toEqual(uploadedAt);
    expect(stored?.contentExpiresAt).toEqual(contentExpiresAt);
    const chunks: Buffer[] = [];
    for await (const chunk of stored!.createReadStream()) {
      chunks.push(Buffer.from(chunk));
    }
    expect(Buffer.concat(chunks).toString("utf8")).toBe("original bytes");
  });

  it("rejects a partial or non-forward retention interval", async () => {
    const staged = await stagePresalesFileContent({
      fileId: "invalid-retention",
      stream: Readable.from(["bytes"]),
      maxBytes: 1_024,
    });
    await expect(
      staged.commit({ uploadedAt: "2026-01-01T00:00:00.000Z" }),
    ).rejects.toThrow("PRESALES_FILE_RETENTION_INVALID");
    await staged.discard();
  });

  it("fails closed when an existing retention ledger is partial or corrupt", async () => {
    await store({
      fileId: "corrupt-retention-ledger",
      uploadedAt: "2026-01-01T00:00:00.000Z",
      contentExpiresAt: "2026-01-31T00:00:00.000Z",
    });
    const root = path.join(assetDir, "presales-files");
    const manifestName = (await readdir(root)).find((name) =>
      /^[a-f0-9]{64}\.json$/u.test(name),
    );
    expect(manifestName).toBeDefined();
    const manifestPath = path.join(root, String(manifestName));
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<
      string,
      unknown
    >;
    delete manifest.contentExpiresAt;
    await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);

    await expect(
      readPresalesFileLifecycle("corrupt-retention-ledger"),
    ).rejects.toThrow("PRESALES_FILE_RETENTION_INVALID");
    await expect(
      readStoredPresalesFile("corrupt-retention-ledger"),
    ).rejects.toThrow("PRESALES_FILE_RETENTION_INVALID");

    const retry = await stagePresalesFileContent({
      fileId: "corrupt-retention-ledger",
      stream: Readable.from(["replacement"]),
      maxBytes: 1_024,
    });
    await expect(
      retry.commit({
        uploadedAt: "2026-02-01T00:00:00.000Z",
        contentExpiresAt: "2026-03-03T00:00:00.000Z",
      }),
    ).rejects.toThrow("PRESALES_FILE_RETENTION_INVALID");
    await retry.discard();
  });

  it("fails closed for a managed file until the database deadline is acknowledged", async () => {
    await store({
      fileId: "expired-user-upload",
      uploadedAt: "2026-01-01T00:00:00.000Z",
      contentExpiresAt: "2026-01-31T00:00:00.000Z",
    });
    await store({
      fileId: "live-user-upload",
      uploadedAt: "2026-01-15T00:00:00.000Z",
      contentExpiresAt: "2026-02-14T00:00:00.000Z",
    });
    // This is a valid legacy v1/assistant-output manifest, but the absence of
    // retention fields means the filesystem fallback must not age-delete it.
    await store({ fileId: "assistant-output-without-retention" });

    const unavailable = await sweepPresalesFileStorageRetention({
      now: new Date("2026-01-31T00:00:00.000Z"),
    });

    expect(unavailable).toMatchObject({
      scannedStoredManifests: 3,
      deleted: 0,
      expiredFilesDeleted: 0,
      failures: 1,
    });
    expect(await readStoredPresalesFile("expired-user-upload")).not.toBeNull();

    const acknowledged = await sweepPresalesFileStorageRetention({
      now: new Date("2026-01-31T00:00:00.000Z"),
      onRetainedFile: vi.fn(),
    });
    expect(acknowledged).toMatchObject({
      deleted: 1,
      expiredFilesDeleted: 1,
      failures: 0,
    });
    expect(acknowledged.reclaimedBytes).toBeGreaterThan(0);
    expect(acknowledged.bytesReclaimed).toBe(acknowledged.reclaimedBytes);
    expect(await readStoredPresalesFile("expired-user-upload")).toBeNull();
    expect(await readPresalesFileLifecycle("expired-user-upload")).toEqual({
      state: "expired",
      uploadedAt: new Date("2026-01-01T00:00:00.000Z"),
      contentExpiresAt: new Date("2026-01-31T00:00:00.000Z"),
      contentDeletedAt: new Date("2026-01-31T00:00:00.000Z"),
      contentStoredAt: null,
      manifestUpdatedAt: new Date("2026-01-31T00:00:00.000Z"),
    });
    expect(await readStoredPresalesFile("live-user-upload")).not.toBeNull();
    expect(
      await readStoredPresalesFile("assistant-output-without-retention"),
    ).not.toBeNull();
    expect(
      (await readStoredPresalesFile("assistant-output-without-retention"))
        ?.manifestUpdatedAt,
    ).toBeInstanceOf(Date);
  });

  it("removes stale upload temporaries but leaves a recent upload alone", async () => {
    const oldStage = await stagePresalesFileContent({
      fileId: "abandoned-upload",
      stream: Readable.from(["old bytes"]),
      maxBytes: 1_024,
    });
    const recentStage = await stagePresalesFileContent({
      fileId: "active-upload",
      stream: Readable.from(["new bytes"]),
      maxBytes: 1_024,
    });
    const root = path.join(assetDir, "presales-files");
    const temporaryFiles = (await readdir(root)).filter((name) =>
      name.endsWith(".upload.tmp"),
    );
    expect(temporaryFiles).toHaveLength(2);
    let oldTemporary: string | undefined;
    for (const name of temporaryFiles) {
      const bytes = await readFile(path.join(root, name), "utf8");
      if (bytes === "old bytes") {
        oldTemporary = name;
        await utimes(
          path.join(root, name),
          new Date("2026-01-01T00:00:00.000Z"),
          new Date("2026-01-01T00:00:00.000Z"),
        );
      }
    }
    expect(oldTemporary).toBeDefined();

    const result = await sweepPresalesFileStorageRetention({
      now: new Date("2026-01-02T00:00:00.000Z"),
      staleUploadTempMs: 60_000,
    });
    expect(result.staleTempsDeleted).toBe(1);
    expect(result.staleUploadTempsDeleted).toBe(1);
    expect(result.reclaimedBytes).toBeGreaterThan(0);
    expect(result.bytesReclaimed).toBe(result.reclaimedBytes);
    expect(
      (await readdir(root)).filter((name) => name.endsWith(".upload.tmp")),
    ).toHaveLength(1);
    await oldStage.discard();
    await recentStage.discard();
  });

  it("removes only over-age atomic manifest temporaries", async () => {
    await store({ fileId: "manifest-temp-anchor" });
    const root = path.join(assetDir, "presales-files");
    const manifestName = (await readdir(root)).find((name) =>
      /^[a-f0-9]{64}\.json$/.test(name),
    );
    expect(manifestName).toBeDefined();
    const oldTemporary = `${manifestName}.11111111-1111-4111-8111-111111111111.tmp`;
    const recentTemporary = `${manifestName}.22222222-2222-4222-8222-222222222222.tmp`;
    const unrelatedTemporary = `${manifestName}.not-a-writer-uuid.tmp`;
    await Promise.all([
      writeFile(path.join(root, oldTemporary), "old manifest snapshot"),
      writeFile(path.join(root, recentTemporary), "recent manifest snapshot"),
      writeFile(path.join(root, unrelatedTemporary), "unknown temporary"),
    ]);
    const oldAt = new Date("2026-01-01T00:00:00.000Z");
    await utimes(path.join(root, oldTemporary), oldAt, oldAt);

    const result = await sweepPresalesFileStorageRetention({
      now: new Date("2026-01-02T00:00:00.000Z"),
      staleManifestTempMs: 60_000,
    });

    expect(result).toMatchObject({
      staleTempsDeleted: 1,
      staleManifestTempsDeleted: 1,
      failures: 0,
    });
    expect(result.reclaimedBytes).toBeGreaterThan(0);
    await expect(stat(path.join(root, oldTemporary))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(stat(path.join(root, recentTemporary))).resolves.toBeDefined();
    await expect(
      stat(path.join(root, unrelatedTemporary)),
    ).resolves.toBeDefined();
  });

  it("bounds each scan and resumes with an opaque cursor", async () => {
    for (const fileId of ["expired-a", "expired-b", "expired-c"]) {
      await store({
        fileId,
        uploadedAt: "2026-01-01T00:00:00.000Z",
        contentExpiresAt: "2026-01-31T00:00:00.000Z",
      });
    }

    let cursor: string | null = null;
    let deleted = 0;
    for (let page = 0; page < 10; page += 1) {
      const result = await sweepPresalesFileStorageRetention({
        now: new Date("2026-02-01T00:00:00.000Z"),
        batchSize: 1,
        maxBatches: 1,
        cursor,
        onRetainedFile: vi.fn(),
      });
      expect(result.scannedEntries).toBe(1);
      deleted += result.expiredFilesDeleted;
      cursor = result.nextCursor;
      if (!cursor) break;
    }
    expect(deleted).toBe(3);
    expect(cursor).toBeNull();
  });

  it("keeps the manifest until derived-file cleanup succeeds", async () => {
    const body = "expired bytes with prepared derivatives";
    await store({
      fileId: "expired-with-derived-file",
      body,
      uploadedAt: "2026-01-01T00:00:00.000Z",
      contentExpiresAt: "2026-01-31T00:00:00.000Z",
    });
    const firstHook = vi.fn(async ({ fileId, sizeBytes }) => {
      expect(fileId).toBe("expired-with-derived-file");
      expect(sizeBytes).toBe(Buffer.byteLength(body));
      expect(
        await readStoredPresalesFile("expired-with-derived-file"),
      ).toBeNull();
      throw new Error("PREPARED_FILE_DELETE_FAILED");
    });

    const first = await sweepPresalesFileStorageRetention({
      now: new Date("2026-02-01T00:00:00.000Z"),
      onRetainedFile: vi.fn(),
      onExpiredFile: firstHook,
    });
    expect(first).toMatchObject({
      deleted: 0,
      failures: 1,
      bytesReclaimed: Buffer.byteLength(body),
    });
    expect(firstHook).toHaveBeenCalledOnce();
    expect(
      (await readdir(path.join(assetDir, "presales-files"))).filter((name) =>
        /^[a-f0-9]{64}\.json$/.test(name),
      ),
    ).toHaveLength(1);

    const retryHook = vi.fn();
    const retry = await sweepPresalesFileStorageRetention({
      now: new Date("2026-02-01T01:00:00.000Z"),
      onRetainedFile: vi.fn(),
      onExpiredFile: retryHook,
    });
    expect(retry).toMatchObject({ deleted: 1, failures: 0 });
    expect(retryHook).toHaveBeenCalledWith({
      fileId: "expired-with-derived-file",
      sizeBytes: Buffer.byteLength(body),
    });
    expect(
      (await readdir(path.join(assetDir, "presales-files"))).filter((name) =>
        /^[a-f0-9]{64}\.json$/.test(name),
      ),
    ).toHaveLength(1);
    expect(
      await readPresalesFileLifecycle("expired-with-derived-file"),
    ).toEqual({
      state: "expired",
      uploadedAt: new Date("2026-01-01T00:00:00.000Z"),
      contentExpiresAt: new Date("2026-01-31T00:00:00.000Z"),
      contentDeletedAt: new Date("2026-02-01T01:00:00.000Z"),
      contentStoredAt: null,
      manifestUpdatedAt: new Date("2026-02-01T01:00:00.000Z"),
    });
  });
});
