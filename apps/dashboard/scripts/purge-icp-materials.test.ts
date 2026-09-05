import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ICP_PURGE_CONFIRMATION,
  ICP_STORAGE_ROOT_OPTION,
  purgeIcpMaterialFiles,
  resolveIcpMaterialPath,
  resolveIcpStorageRoot,
} from "./purge-icp-materials";

describe("ICP material purge safety", () => {
  const temporaryRoots: string[] = [];
  const storageKey = "123e4567-e89b-42d3-a456-426614174000.bin";

  async function createStorageRoot() {
    const root = await mkdtemp(path.join(os.tmpdir(), "frontmind-icp-purge-"));
    temporaryRoots.push(root);
    return root;
  }

  afterEach(async () => {
    await Promise.all(
      temporaryRoots
        .splice(0)
        .map((root) => rm(root, { recursive: true, force: true })),
    );
  });

  it("requires explicit root and permanent-delete arguments", () => {
    expect(ICP_PURGE_CONFIRMATION).toBe("--confirm-permanent-delete");
    expect(ICP_STORAGE_ROOT_OPTION).toBe("--storage-root=");
  });

  it("resolves only UUID blob names directly below the configured root", () => {
    const root = path.resolve("/var/lib/frontmind/icp-materials");
    expect(resolveIcpMaterialPath(root, storageKey)).toBe(
      path.join(root, storageKey),
    );
    expect(() => resolveIcpMaterialPath(root, "../secret.bin")).toThrow(
      "ICP 存储键格式无效",
    );
    expect(() => resolveIcpMaterialPath(root, "not-a-uuid.bin")).toThrow(
      "ICP 存储键格式无效",
    );
    expect(() => resolveIcpStorageRoot("relative/icp-materials")).toThrow(
      "必须是绝对路径",
    );
    expect(() => resolveIcpStorageRoot(path.parse(root).root)).toThrow(
      "过于宽泛",
    );
  });

  it("performs a dry-run without deleting files or database records", async () => {
    const root = await createStorageRoot();
    const filePath = path.join(root, storageKey);
    await writeFile(filePath, "encrypted");
    const deleteDatabaseRecords = vi.fn(async () => undefined);

    const result = await purgeIcpMaterialFiles({
      storageRoot: root,
      materials: [{ id: "material-1", storageKey }],
      attachmentCount: 1,
      confirmed: false,
      deleteDatabaseRecords,
    });

    expect(result).toMatchObject({
      materialCount: 1,
      attachmentCount: 1,
      existingFileCount: 1,
      unexpectedEntryCount: 0,
      deleted: false,
    });
    expect(deleteDatabaseRecords).not.toHaveBeenCalled();
    await expect(access(filePath)).resolves.toBeUndefined();
  });

  it("permanently deletes exact files before database records", async () => {
    const root = await createStorageRoot();
    const filePath = path.join(root, storageKey);
    await writeFile(filePath, "encrypted");
    const deleteDatabaseRecords = vi.fn(async () => {
      await expect(access(filePath)).rejects.toMatchObject({ code: "ENOENT" });
    });

    const result = await purgeIcpMaterialFiles({
      storageRoot: root,
      materials: [{ id: "material-1", storageKey }],
      attachmentCount: 1,
      confirmed: true,
      deleteDatabaseRecords,
    });

    expect(result.deleted).toBe(true);
    expect(deleteDatabaseRecords).toHaveBeenCalledOnce();
  });

  it("rejects unregistered directory entries before deleting anything", async () => {
    const root = await createStorageRoot();
    const filePath = path.join(root, storageKey);
    await writeFile(filePath, "encrypted");
    await writeFile(path.join(root, "orphan.bin"), "unknown");
    const deleteDatabaseRecords = vi.fn(async () => undefined);

    await expect(
      purgeIcpMaterialFiles({
        storageRoot: root,
        materials: [{ id: "material-1", storageKey }],
        attachmentCount: 0,
        confirmed: true,
        deleteDatabaseRecords,
      }),
    ).rejects.toThrow("未登记目录项");
    expect(deleteDatabaseRecords).not.toHaveBeenCalled();
    await expect(access(filePath)).resolves.toBeUndefined();
  });

  it("is idempotent when registered files and the root are already absent", async () => {
    const root = path.join(
      os.tmpdir(),
      `frontmind-icp-purge-absent-${Date.now()}`,
    );
    const deleteDatabaseRecords = vi.fn(async () => undefined);

    const result = await purgeIcpMaterialFiles({
      storageRoot: root,
      materials: [{ id: "material-1", storageKey }],
      attachmentCount: 0,
      confirmed: true,
      deleteDatabaseRecords,
    });

    expect(result.deleted).toBe(true);
    expect(result.existingFileCount).toBe(0);
    expect(deleteDatabaseRecords).toHaveBeenCalledOnce();
  });
});
