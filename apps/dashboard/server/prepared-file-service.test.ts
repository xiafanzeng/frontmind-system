import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  PreparedFileService,
  type PreparedFileManifest,
} from "./prepared-file-service";

type TestClaim = {
  owner: string;
  workspaceKey: string;
  assertOwned: () => Promise<void>;
  release: () => Promise<void>;
};

type TestablePreparedService = PreparedFileService & {
  acquireProcessingClaim: (assetId: string) => Promise<TestClaim | null>;
  persistManifest: (
    manifest: PreparedFileManifest,
    claim?: TestClaim,
    options?: { allowCreate?: boolean; expectedUpdatedAt?: number },
  ) => Promise<void>;
  deleteAsset: (assetId: string) => Promise<void>;
};

const services: PreparedFileService[] = [];
const roots: string[] = [];

async function service(
  root: string,
  processingClaimStaleMs = 25,
  orphanSweepMinAgeMs?: number,
) {
  const result = new PreparedFileService(root, {
    skipToolingCheck: true,
    workerConcurrency: 0,
    processingClaimStaleMs,
    orphanSweepMinAgeMs,
  });
  services.push(result);
  await result.initialize();
  return result;
}

async function root() {
  const result = await fs.mkdtemp(
    path.join(os.tmpdir(), "frontmind-prepared-shared-"),
  );
  roots.push(result);
  return result;
}

afterEach(async () => {
  await Promise.allSettled(services.splice(0).map((item) => item.shutdown()));
  await Promise.allSettled(
    roots
      .splice(0)
      .map((item) => fs.rm(item, { recursive: true, force: true })),
  );
});

describe("PreparedFileService shared-volume coordination", () => {
  it("discovers manifests created after another instance initialized", async () => {
    const sharedRoot = await root();
    const reader = await service(sharedRoot);
    const writer = await service(sharedRoot);
    const registered = await writer.registerExternal({
      ownerUserId: 7,
      credentialId: "external",
      url: "https://objects.example.com/report.pdf?signature=one",
      filename: "报告.pdf",
    });

    await expect(
      reader.getStatus(registered.assetId, 7),
    ).resolves.toMatchObject({
      assetId: registered.assetId,
      status: "queued",
    });
  });

  it("lets another instance delete every shared manifest for an owned source", async () => {
    const sharedRoot = await root();
    const writer = await service(sharedRoot);
    const cleaner = await service(sharedRoot);
    const registered = await writer.registerFile({
      ownerUserId: 7,
      credentialId: "credential-1",
      fileId: "file/shared #1",
      filename: "shared.pdf",
      expiresAt: Date.now() + 60_000,
    });

    await expect(cleaner.deleteByFileSource("file/shared #1")).resolves.toBe(1);
    await expect(
      fs.stat(path.join(sharedRoot, `${registered.assetId}.json`)),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      fs.stat(path.join(sharedRoot, `${registered.assetId}.delete`)),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("records managed local asset authority without inventing a Provider credential", async () => {
    const sharedRoot = await root();
    const writer = await service(sharedRoot);
    const localAssetId = `asset_${"a".repeat(30)}`;
    const registered = await writer.registerFile({
      ownerUserId: 7,
      sourceKind: "managed_local_asset",
      sourceAuthorityId: localAssetId,
      fileId: localAssetId,
      filename: "local.pdf",
      expiresAt: Date.now() + 60_000,
    });
    const manifest = JSON.parse(
      await fs.readFile(
        path.join(sharedRoot, `${registered.assetId}.json`),
        "utf8",
      ),
    );

    expect(manifest).toMatchObject({
      sourceKind: "managed_local_asset",
      sourceAuthorityId: localAssetId,
      source: { kind: "file", fileId: localAssetId },
    });
    expect(manifest).not.toHaveProperty("credentialId");
  });

  it("converges a durable delete marker left by a crashed instance", async () => {
    const sharedRoot = await root();
    const writer = await service(sharedRoot);
    const registered = await writer.registerExternal({
      ownerUserId: 7,
      credentialId: "external",
      url: "https://objects.example.com/abandoned.pdf",
      filename: "abandoned.pdf",
    });
    await fs.writeFile(
      path.join(sharedRoot, `${registered.assetId}.delete`),
      `${Date.now()}\n`,
      { mode: 0o600 },
    );

    const recoveringInstance = await service(sharedRoot);
    await recoveringInstance.reconcileSharedState();
    await expect(
      fs.stat(path.join(sharedRoot, `${registered.assetId}.json`)),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      fs.stat(path.join(sharedRoot, `${registered.assetId}.delete`)),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fences a stale worker before its queued manifest write reaches disk", async () => {
    const sharedRoot = await root();
    const oldInstance = (await service(
      sharedRoot,
      5,
    )) as TestablePreparedService;
    const newInstance = (await service(
      sharedRoot,
      5,
    )) as TestablePreparedService;
    const registered = await oldInstance.registerExternal({
      ownerUserId: 7,
      credentialId: "external",
      url: "https://objects.example.com/fenced.pdf",
      filename: "fenced.pdf",
    });
    const oldClaim = await oldInstance.acquireProcessingClaim(
      registered.assetId,
    );
    expect(oldClaim).not.toBeNull();
    const staleAt = new Date(Date.now() - 1_000);
    await fs.utimes(
      path.join(sharedRoot, `${registered.assetId}.claim`),
      staleAt,
      staleAt,
    );
    const newClaim = await newInstance.acquireProcessingClaim(
      registered.assetId,
    );
    expect(newClaim).not.toBeNull();
    expect(newClaim?.workspaceKey).not.toBe(oldClaim?.workspaceKey);

    const manifestPath = path.join(sharedRoot, `${registered.assetId}.json`);
    const base = JSON.parse(
      await fs.readFile(manifestPath, "utf8"),
    ) as PreparedFileManifest;
    const current = { ...base, updatedAt: 222 };
    await newInstance.persistManifest(current, newClaim!);
    await expect(
      oldInstance.persistManifest({ ...base, updatedAt: 111 }, oldClaim!),
    ).rejects.toThrow("PREPARED_FILE_PROCESSING_CLAIM_LOST");
    expect(
      (
        JSON.parse(
          await fs.readFile(manifestPath, "utf8"),
        ) as PreparedFileManifest
      ).updatedAt,
    ).toBe(222);

    await oldClaim?.release();
    await newClaim?.release();
  });

  it("does not let a stale non-worker update recreate a deleted manifest", async () => {
    const sharedRoot = await root();
    const writer = (await service(sharedRoot)) as TestablePreparedService;
    const cleaner = await service(sharedRoot);
    const registered = await writer.registerExternal({
      ownerUserId: 7,
      credentialId: "external",
      url: "https://objects.example.com/deleted.pdf",
      filename: "deleted.pdf",
    });
    const manifestPath = path.join(sharedRoot, `${registered.assetId}.json`);
    const stale = JSON.parse(
      await fs.readFile(manifestPath, "utf8"),
    ) as PreparedFileManifest;

    // External assets use the same private deletion primitive in production;
    // invoke it here only to deterministically place deletion between a stale
    // read and its later write.
    await (cleaner as TestablePreparedService).deleteAsset(registered.assetId);
    stale.lastAccessedAt += 1_000;
    stale.updatedAt += 1_000;

    await expect(
      writer.persistManifest(stale, undefined, {
        expectedUpdatedAt: stale.updatedAt - 1_000,
      }),
    ).rejects.toMatchObject({ code: "ASSET_NOT_FOUND" });
    await expect(fs.stat(manifestPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("checks a durable delete marker again inside the manifest claim", async () => {
    const sharedRoot = await root();
    const instance = (await service(sharedRoot)) as TestablePreparedService;
    const registered = await instance.registerExternal({
      ownerUserId: 7,
      credentialId: "external",
      url: "https://objects.example.com/delete-race.pdf",
      filename: "delete-race.pdf",
    });
    const manifestPath = path.join(sharedRoot, `${registered.assetId}.json`);
    const manifest = JSON.parse(
      await fs.readFile(manifestPath, "utf8"),
    ) as PreparedFileManifest;
    const claim = await instance.acquireProcessingClaim(registered.assetId);
    expect(claim).not.toBeNull();
    await fs.writeFile(
      path.join(sharedRoot, `${registered.assetId}.delete`),
      `${Date.now()}\n`,
      { mode: 0o600 },
    );

    await expect(
      instance.persistManifest(manifest, claim!),
    ).rejects.toMatchObject({ code: "ASSET_DELETE_REQUESTED" });
    expect(await fs.readFile(manifestPath, "utf8")).toContain(
      `"id":"${registered.assetId}"`,
    );
    await claim?.release();
  });

  it("rejects a stale non-worker revision after another instance updates it", async () => {
    const sharedRoot = await root();
    const first = (await service(sharedRoot)) as TestablePreparedService;
    const second = (await service(sharedRoot)) as TestablePreparedService;
    const registered = await first.registerExternal({
      ownerUserId: 7,
      credentialId: "external",
      url: "https://objects.example.com/revision.pdf",
      filename: "revision.pdf",
    });
    const manifestPath = path.join(sharedRoot, `${registered.assetId}.json`);
    const base = JSON.parse(
      await fs.readFile(manifestPath, "utf8"),
    ) as PreparedFileManifest;
    const current = { ...base, updatedAt: base.updatedAt + 1 };
    await first.persistManifest(current, undefined, {
      expectedUpdatedAt: base.updatedAt,
    });

    await expect(
      second.persistManifest(
        { ...base, updatedAt: base.updatedAt + 2 },
        undefined,
        { expectedUpdatedAt: base.updatedAt },
      ),
    ).rejects.toMatchObject({ code: "PREPARED_FILE_MANIFEST_CONFLICT" });
    expect(
      (
        JSON.parse(
          await fs.readFile(manifestPath, "utf8"),
        ) as PreparedFileManifest
      ).updatedAt,
    ).toBe(current.updatedAt);
  });

  it("does not rewrite a queued or processing manifest when retry is requested", async () => {
    const sharedRoot = await root();
    const instance = await service(sharedRoot);
    const registered = await instance.registerExternal({
      ownerUserId: 7,
      credentialId: "external",
      url: "https://objects.example.com/queued.pdf",
      filename: "queued.pdf",
    });
    const manifestPath = path.join(sharedRoot, `${registered.assetId}.json`);
    const before = await fs.readFile(manifestPath, "utf8");

    await expect(instance.retry(registered.assetId, 7)).resolves.toMatchObject({
      status: "queued",
    });
    expect(await fs.readFile(manifestPath, "utf8")).toBe(before);
  });

  it("reclaims only known over-age orphan artifacts and reports the deletion", async () => {
    const sharedRoot = await root();
    const instance = await service(sharedRoot, 25, 50);
    const assetId = "b".repeat(40);
    const recentAssetId = "c".repeat(40);
    const paths = [
      path.join(sharedRoot, `${assetId}.json`),
      path.join(sharedRoot, `${assetId}.pdf`),
      path.join(sharedRoot, `${assetId}.aaaaaaaaaaaaaaaa.source.tmp`),
    ];
    await Promise.all([
      fs.writeFile(paths[0], "not-json"),
      fs.writeFile(paths[1], "%PDF-orphan"),
      fs.writeFile(paths[2], "partial-source"),
      fs.writeFile(path.join(sharedRoot, `${recentAssetId}.pdf`), "%PDF-new"),
      fs.writeFile(path.join(sharedRoot, `${assetId}.unknown.tmp`), "unknown"),
    ]);
    const workPath = path.join(sharedRoot, `${assetId}.aaaaaaaaaaaaaaaa.work`);
    await fs.mkdir(workPath);
    await fs.writeFile(path.join(workPath, "page.pdf"), "%PDF-work");
    const oldAt = new Date(Date.now() - 1_000);
    await Promise.all(paths.map((entry) => fs.utimes(entry, oldAt, oldAt)));
    await fs.utimes(workPath, oldAt, oldAt);

    const result = await instance.sweepOrphanedStorage(Date.now());

    expect(result).toMatchObject({
      candidateAssets: 1,
      deletedEntries: 4,
      orphanPdfsDeleted: 1,
      orphanManifestsDeleted: 1,
      staleTempsDeleted: 1,
      staleWorkDirectoriesDeleted: 1,
      failures: 0,
    });
    expect(result.bytesReclaimed).toBeGreaterThan(0);
    for (const entry of [...paths, workPath]) {
      await expect(fs.stat(entry)).rejects.toMatchObject({ code: "ENOENT" });
    }
    await expect(
      fs.stat(path.join(sharedRoot, `${recentAssetId}.pdf`)),
    ).resolves.toBeDefined();
    await expect(
      fs.stat(path.join(sharedRoot, `${assetId}.unknown.tmp`)),
    ).resolves.toBeDefined();
  });

  it("never reclaims an orphan while another instance owns its claim", async () => {
    const sharedRoot = await root();
    const instance = (await service(
      sharedRoot,
      250,
      250,
    )) as TestablePreparedService;
    const assetId = "d".repeat(40);
    const pdfPath = path.join(sharedRoot, `${assetId}.pdf`);
    await fs.writeFile(pdfPath, "%PDF-claimed");
    const oldAt = new Date(Date.now() - 1_000);
    await fs.utimes(pdfPath, oldAt, oldAt);
    const claim = await instance.acquireProcessingClaim(assetId);
    expect(claim).not.toBeNull();

    const claimed = await instance.sweepOrphanedStorage(Date.now());
    expect(claimed).toMatchObject({
      deletedEntries: 0,
      skippedClaimedAssets: 1,
      failures: 0,
    });
    await expect(fs.stat(pdfPath)).resolves.toBeDefined();

    await claim?.release();
    const released = await instance.sweepOrphanedStorage(Date.now());
    expect(released.orphanPdfsDeleted).toBe(1);
    await expect(fs.stat(pdfPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps canonical files owned by a valid manifest while removing stale scratch", async () => {
    const sharedRoot = await root();
    const instance = await service(sharedRoot, 25, 50);
    const registered = await instance.registerExternal({
      ownerUserId: 7,
      credentialId: "external",
      url: "https://objects.example.com/owned.pdf",
      filename: "owned.pdf",
    });
    const manifestPath = path.join(sharedRoot, `${registered.assetId}.json`);
    const pdfPath = path.join(sharedRoot, `${registered.assetId}.pdf`);
    const sourcePath = path.join(
      sharedRoot,
      `${registered.assetId}.aaaaaaaaaaaaaaaa.source.tmp`,
    );
    const manifestTemporary = path.join(
      sharedRoot,
      `${registered.assetId}.json.123.33333333-3333-4333-8333-333333333333.tmp`,
    );
    await Promise.all([
      fs.writeFile(pdfPath, "%PDF-owned"),
      fs.writeFile(sourcePath, "partial-source"),
      fs.writeFile(manifestTemporary, "partial-manifest"),
    ]);
    const oldAt = new Date(Date.now() - 1_000);
    await Promise.all(
      [manifestPath, pdfPath, sourcePath, manifestTemporary].map((entry) =>
        fs.utimes(entry, oldAt, oldAt),
      ),
    );

    const result = await instance.sweepOrphanedStorage(Date.now());

    expect(result).toMatchObject({
      deletedEntries: 2,
      orphanPdfsDeleted: 0,
      orphanManifestsDeleted: 0,
      staleTempsDeleted: 2,
      failures: 0,
    });
    await expect(fs.stat(manifestPath)).resolves.toBeDefined();
    await expect(fs.stat(pdfPath)).resolves.toBeDefined();
    await expect(fs.stat(sourcePath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(manifestTemporary)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
