// @vitest-environment node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import axios from "axios";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getEnterpriseProjectScope,
  runWithEnterpriseProjectScope,
  runWithoutEnterpriseProjectScope,
} from "./enterprise-project-context";
const recovery = vi.hoisted(() => ({ restore: vi.fn() }));
vi.mock("./enterprise-project-recovery", () => ({
  runWithStoredEnterpriseProjectScope: recovery.restore,
}));
import {
  PreparedFileService,
  type PreparedFileManifest,
} from "./prepared-file-service";
import {
  OwnedFileContentError,
  ownedFileContentResolver,
} from "./owned-file-content-resolver";

const owner = 7,
  projectA = "11111111-1111-4111-8111-111111111111",
  projectB = "22222222-2222-4222-8222-222222222222";
const scopes = new Map([
  [
    projectA,
    {
      enterpriseProjectId: projectA,
      ownerUserId: owner,
      actorUserId: 99,
      isLegacyDefault: false,
    },
  ],
  [
    projectB,
    {
      enterpriseProjectId: projectB,
      ownerUserId: owner,
      actorUserId: owner,
      isLegacyDefault: false,
    },
  ],
]);
const scoped = <T>(id: string, action: () => T) =>
  runWithEnterpriseProjectScope(scopes.get(id)!, action);
const input = {
  ownerUserId: owner,
  credentialId: "external-local",
  url: "https://objects.example.com/isolated.pdf",
  filename: "isolated.pdf",
};
const roots: string[] = [],
  instances: PreparedFileService[] = [];
async function instance(root?: string) {
  const directory =
    root ?? (await fs.mkdtemp(path.join(os.tmpdir(), "prepared-enterprise-")));
  if (!root) roots.push(directory);
  const service = new PreparedFileService(directory, {
    skipToolingCheck: true,
    workerConcurrency: 0,
  });
  instances.push(service);
  await service.initialize();
  return { service, directory };
}
async function manifest(directory: string, id: string) {
  return JSON.parse(
    await fs.readFile(path.join(directory, `${id}.json`), "utf8"),
  ) as PreparedFileManifest;
}
afterEach(async () => {
  await Promise.all(instances.splice(0).map((service) => service.shutdown()));
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
  vi.restoreAllMocks();
  recovery.restore.mockReset();
});

describe("prepared external files belong to one enterprise project", () => {
  it("stores different caches for the same URL in account scope and two projects, and rejects all cross-scope reads", async () => {
    const { service, directory } = await instance();
    const account = await service.registerExternal(input),
      a = await scoped(projectA, () => service.registerExternal(input)),
      b = await scoped(projectB, () => service.registerExternal(input));
    expect(new Set([account.assetId, a.assetId, b.assetId]).size).toBe(3);
    expect(await manifest(directory, a.assetId)).toMatchObject({
      ownerUserId: owner,
      enterpriseScopeVersion: 1,
      enterpriseProjectId: projectA,
    });
    expect(await manifest(directory, account.assetId)).toMatchObject({
      enterpriseScopeVersion: 1,
      enterpriseProjectId: null,
    });
    for (const other of [account.assetId, b.assetId])
      await expect(
        scoped(projectA, () => service.getReadyManifest(other, owner)),
      ).rejects.toMatchObject({ code: "ASSET_NOT_FOUND" });
    await expect(service.getStatus(a.assetId, owner)).rejects.toMatchObject({
      code: "ASSET_NOT_FOUND",
    });
    await expect(
      scoped(projectB, () => service.retry(a.assetId, owner)),
    ).rejects.toMatchObject({ code: "ASSET_NOT_FOUND" });
    await expect(
      scoped(projectA, () => service.getStatus(a.assetId, 8)),
    ).rejects.toMatchObject({ code: "ASSET_NOT_FOUND" });
    await expect(
      scoped(projectA, () =>
        service.registerExternal({ ...input, ownerUserId: 8 }),
      ),
    ).rejects.toThrow("ENTERPRISE_PROJECT_OWNER_MISMATCH");
    const reader = (await instance(directory)).service;
    expect(
      (await scoped(projectA, () => reader.getStatus(a.assetId, owner)))
        .assetId,
    ).toBe(a.assetId);
    await expect(
      scoped(projectB, () => reader.getReadyManifest(a.assetId, owner)),
    ).rejects.toMatchObject({ code: "ASSET_NOT_FOUND" });
  });
  it("leaves historical external caches account-only, including when the request uses a default enterprise project", async () => {
    const { service, directory } = await instance();
    const created = await service.registerExternal(input),
      legacy = await manifest(directory, created.assetId);
    delete legacy.enterpriseProjectId;
    delete legacy.enterpriseScopeVersion;
    await fs.writeFile(
      path.join(directory, `${created.assetId}.json`),
      JSON.stringify(legacy),
    );
    const reader = (await instance(directory)).service;
    expect((await reader.getStatus(created.assetId, owner)).assetId).toBe(
      created.assetId,
    );
    await expect(
      runWithEnterpriseProjectScope(
        { ...scopes.get(projectA)!, isLegacyDefault: true },
        () => reader.getStatus(created.assetId, owner),
      ),
    ).rejects.toMatchObject({ code: "ASSET_NOT_FOUND" });
    await expect(
      scoped(projectB, () => reader.getReadyManifest(created.assetId, owner)),
    ).rejects.toMatchObject({ code: "ASSET_NOT_FOUND" });
    expect(await manifest(directory, created.assetId)).not.toHaveProperty(
      "enterpriseScopeVersion",
    );
  });
  it("binds a historical owned-file cache only after its file source proves the current project, then prevents reassignment", async () => {
    const { service, directory } = await instance();
    const created = await service.registerFile({
      ownerUserId: owner,
      credentialId: "provider-1",
      fileId: "historical-file",
      filename: "legacy.pdf",
    });
    const legacy = await manifest(directory, created.assetId);
    delete legacy.enterpriseProjectId;
    delete legacy.enterpriseScopeVersion;
    await fs.writeFile(
      path.join(directory, `${created.assetId}.json`),
      JSON.stringify(legacy),
    );
    vi.spyOn(ownedFileContentResolver, "authorize").mockImplementation(
      async (access) => {
        if (
          access.ownerUserId !== owner ||
          getEnterpriseProjectScope()?.enterpriseProjectId !== projectA
        )
          throw new OwnedFileContentError(
            "SOURCE_FORBIDDEN",
            "Project mismatch",
            { statusCode: 403 },
          );
        return {
          sourceKind: "provider_file",
          sourceAuthorityId: "provider-1",
          credentialId: "provider-1",
          isTaskBoundAssistantOutput: false,
          expiresAt: Date.now() + 60000,
        };
      },
    );
    await expect(
      scoped(projectB, () => service.getStatus(created.assetId, owner)),
    ).rejects.toMatchObject({ code: "SOURCE_FORBIDDEN" });
    expect(await manifest(directory, created.assetId)).not.toHaveProperty(
      "enterpriseScopeVersion",
    );
    await scoped(projectA, () => service.getStatus(created.assetId, owner));
    expect(await manifest(directory, created.assetId)).toMatchObject({
      enterpriseScopeVersion: 1,
      enterpriseProjectId: projectA,
    });
    await expect(
      service.getStatus(created.assetId, owner),
    ).rejects.toMatchObject({ code: "ASSET_NOT_FOUND" });
    const changed = await manifest(directory, created.assetId);
    changed.enterpriseProjectId = projectB;
    await expect(
      (service as any).persistManifest(changed, undefined, {
        expectedUpdatedAt: changed.updatedAt,
      }),
    ).rejects.toMatchObject({ code: "SOURCE_FORBIDDEN" });
    expect(
      (await manifest(directory, created.assetId)).enterpriseProjectId,
    ).toBe(projectA);
  });
  it("rejects malformed or incomplete project metadata instead of treating it as an account cache", async () => {
    const { service, directory } = await instance();
    const created = await scoped(projectA, () =>
      service.registerExternal(input),
    );
    const saved = await manifest(directory, created.assetId);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const missingVersion = { ...saved };
    delete missingVersion.enterpriseScopeVersion;
    await fs.writeFile(
      path.join(directory, `${created.assetId}.json`),
      JSON.stringify(missingVersion),
    );
    await expect(
      scoped(projectA, () => service.getStatus(created.assetId, owner)),
    ).rejects.toMatchObject({ code: "ASSET_NOT_FOUND" });
    const missingProject = { ...saved };
    delete missingProject.enterpriseProjectId;
    await fs.writeFile(
      path.join(directory, `${created.assetId}.json`),
      JSON.stringify(missingProject),
    );
    await expect(
      service.getStatus(created.assetId, owner),
    ).rejects.toMatchObject({ code: "ASSET_NOT_FOUND" });
  });

  it("does not promote explicitly account-owned file caches into projects even when a file source would authorize", async () => {
    const { service } = await instance();
    const created = await service.registerFile({
      ownerUserId: owner,
      credentialId: "provider-1",
      fileId: "account-file",
      filename: "account.pdf",
    });
    const authorize = vi.spyOn(ownedFileContentResolver, "authorize");
    await expect(
      scoped(projectA, () => service.getStatus(created.assetId, owner)),
    ).rejects.toMatchObject({ code: "ASSET_NOT_FOUND" });
    expect(authorize).not.toHaveBeenCalled();
  });
  it("recovers queued external processing with persisted project ownership even when another request drains the queue", async () => {
    // Scope restoration must not depend on this test host's disk pressure or
    // trigger unrelated cache eviction; storage guards have dedicated coverage.
    vi.spyOn(fs, "statfs").mockResolvedValue({
      bsize: 4096,
      blocks: 100_000_000,
      bavail: 50_000_000,
      bfree: 50_000_000,
      files: 1_000_000,
      ffree: 900_000,
      type: 0,
    });
    const { service: writer, directory } = await instance();
    const a = await scoped(projectA, () => writer.registerExternal(input));
    const account = await writer.registerExternal({
      ...input,
      url: "https://objects.example.com/account.pdf",
    });
    const { service } = await instance(directory);
    const observed: (string | null)[] = [];
    const bytes = Buffer.from("%PDF-1.7\nlocal pipeline fixture");
    recovery.restore.mockImplementation(async (user, id, action) => {
      if (user !== owner) throw new Error("OWNER_MISMATCH");
      return id ? scoped(id, action) : runWithoutEnterpriseProjectScope(action);
    });
    vi.spyOn(axios, "get").mockImplementation(async () => {
      observed.push(getEnterpriseProjectScope()?.enterpriseProjectId ?? null);
      return {
        status: 200,
        data: Readable.from([bytes]),
        headers: {
          "content-type": "application/pdf",
          "content-length": String(bytes.length),
        },
      };
    });
    vi.spyOn(service as any, "runWorker").mockImplementation(
      async (_manifest, _source, destination) => {
        await fs.writeFile(destination as string, bytes);
        return { pageCount: 1 };
      },
    );
    await scoped(projectB, () => (service as any).processAsset(a.assetId));
    await scoped(projectA, () =>
      (service as any).processAsset(account.assetId),
    );
    expect(observed).toEqual([projectA, null]);
    expect(await manifest(directory, a.assetId)).toMatchObject({
      status: "ready",
      enterpriseProjectId: projectA,
    });
    expect(await manifest(directory, account.assetId)).toMatchObject({
      status: "ready",
      enterpriseProjectId: null,
    });
    expect(recovery.restore).toHaveBeenCalledWith(
      owner,
      projectA,
      expect.any(Function),
    );
    expect(recovery.restore).toHaveBeenCalledWith(
      owner,
      null,
      expect.any(Function),
    );
  });
  it("refuses to fetch when durable project ownership can no longer be restored", async () => {
    const { service, directory } = await instance();
    const created = await scoped(projectA, () =>
      service.registerExternal(input),
    );
    const network = vi.spyOn(axios, "get");
    recovery.restore.mockRejectedValue(
      new Error("ENTERPRISE_PROJECT_RECOVERY_OWNER_MISMATCH"),
    );
    await scoped(projectB, () =>
      (service as any).processAsset(created.assetId),
    );
    expect(network).not.toHaveBeenCalled();
    expect(await manifest(directory, created.assetId)).toMatchObject({
      status: "failed",
      enterpriseProjectId: projectA,
    });
  });
});
