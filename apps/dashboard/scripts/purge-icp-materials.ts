import "dotenv/config";
import { access, readdir, rmdir, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import mysql from "mysql2/promise";

export const ICP_PURGE_CONFIRMATION = "--confirm-permanent-delete";
export const ICP_STORAGE_ROOT_OPTION = "--storage-root=";
const STORAGE_KEY_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.bin$/i;

export type IcpMaterialRecord = {
  id: string;
  storageKey: string;
};

export function resolveIcpStorageRoot(value: string) {
  if (!path.isAbsolute(value)) {
    throw new Error("ICP 存储根目录必须是绝对路径");
  }
  const resolved = path.resolve(value);
  const forbiddenRoots = new Set([
    path.parse(resolved).root,
    path.resolve(process.cwd()),
    path.resolve(os.homedir()),
  ]);
  if (forbiddenRoots.has(resolved)) {
    throw new Error("ICP 存储根目录过于宽泛，拒绝执行");
  }
  return resolved;
}

export function resolveIcpMaterialPath(root: string, storageKey: string) {
  if (!STORAGE_KEY_PATTERN.test(storageKey)) {
    throw new Error(`ICP 存储键格式无效：${storageKey}`);
  }
  const resolvedRoot = path.resolve(root);
  const resolvedFile = path.resolve(resolvedRoot, storageKey);
  if (path.dirname(resolvedFile) !== resolvedRoot) {
    throw new Error(`ICP 文件越出存储根目录：${storageKey}`);
  }
  return resolvedFile;
}

async function fileExists(filePath: string) {
  try {
    await access(filePath);
    return true;
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return false;
    throw error;
  }
}

export async function purgeIcpMaterialFiles(input: {
  storageRoot: string;
  materials: IcpMaterialRecord[];
  attachmentCount: number;
  confirmed: boolean;
  deleteDatabaseRecords: () => Promise<void>;
}) {
  const storageRoot = resolveIcpStorageRoot(input.storageRoot);
  const materialPaths = input.materials.map((material) =>
    resolveIcpMaterialPath(storageRoot, material.storageKey),
  );
  const existingFiles = (
    await Promise.all(materialPaths.map((filePath) => fileExists(filePath)))
  ).filter(Boolean).length;
  const rootEntries = await readdir(storageRoot, { withFileTypes: true }).catch(
    (error) => {
      if ((error as { code?: string }).code === "ENOENT") return [];
      throw error;
    },
  );
  const registeredStorageKeys = new Set(
    input.materials.map((material) => material.storageKey),
  );
  const unexpectedEntries = rootEntries
    .map((entry) => entry.name)
    .filter((entryName) => !registeredStorageKeys.has(entryName));
  const result = {
    materialCount: input.materials.length,
    attachmentCount: input.attachmentCount,
    existingFileCount: existingFiles,
    directoryFileCount: rootEntries.filter((entry) => entry.isFile()).length,
    unexpectedEntryCount: unexpectedEntries.length,
    storageRoot,
    deleted: false,
  };
  if (!input.confirmed) return result;
  if (unexpectedEntries.length > 0) {
    throw new Error(
      `ICP 存储根目录包含 ${unexpectedEntries.length} 个未登记目录项，拒绝删除材料记录；请逐项核验`,
    );
  }

  for (const filePath of materialPaths) {
    await unlink(filePath).catch((error) => {
      if ((error as { code?: string }).code !== "ENOENT") throw error;
    });
  }
  const remaining = (
    await Promise.all(materialPaths.map((filePath) => fileExists(filePath)))
  ).filter(Boolean);
  if (remaining.length) {
    throw new Error(`仍有 ${remaining.length} 个 ICP 加密文件未删除`);
  }
  const leftovers = await readdir(storageRoot).catch((error) => {
    if ((error as { code?: string }).code === "ENOENT") return [];
    throw error;
  });
  if (leftovers.length > 0) {
    throw new Error(`ICP 目录仍有 ${leftovers.length} 个文件，清理核验失败`);
  }

  await input.deleteDatabaseRecords();
  await rmdir(storageRoot).catch((error) => {
    if ((error as { code?: string }).code !== "ENOENT") throw error;
  });
  return { ...result, deleted: true };
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) throw new Error("DATABASE_URL 未配置");
  const storageRootArgument = process.argv.find((argument) =>
    argument.startsWith(ICP_STORAGE_ROOT_OPTION),
  );
  const storageRootValue = storageRootArgument?.slice(
    ICP_STORAGE_ROOT_OPTION.length,
  );
  if (!storageRootValue) {
    throw new Error(
      `必须通过 ${ICP_STORAGE_ROOT_OPTION}<绝对路径> 指定旧 ICP 存储根目录`,
    );
  }
  const storageRoot = resolveIcpStorageRoot(storageRootValue);
  const confirmed = process.argv.includes(ICP_PURGE_CONFIRMATION);
  const connection = await mysql.createConnection(databaseUrl);
  try {
    let materials: IcpMaterialRecord[];
    let attachmentCount: number;
    try {
      const [materialRows] = await connection.query<mysql.RowDataPacket[]>(
        "SELECT id, storageKey FROM icp_sensitive_materials ORDER BY id",
      );
      materials = materialRows.map((row) => ({
        id: String(row.id),
        storageKey: String(row.storageKey),
      }));
      const [attachmentRows] = await connection.query<mysql.RowDataPacket[]>(
        "SELECT COUNT(*) AS value FROM delivery_ticket_attachments WHERE protectedMaterialId IS NOT NULL OR sensitivity = 'icp_sensitive'",
      );
      attachmentCount = Number(attachmentRows[0]?.value ?? 0);
    } catch (error) {
      if ((error as { code?: string }).code === "ER_NO_SUCH_TABLE") {
        console.log("ICP 敏感材料表已不存在，无需再次清理");
        return;
      }
      throw error;
    }

    const result = await purgeIcpMaterialFiles({
      storageRoot,
      materials,
      attachmentCount,
      confirmed,
      deleteDatabaseRecords: async () => {
        await connection.beginTransaction();
        try {
          await connection.query(
            "DELETE FROM delivery_ticket_attachments WHERE protectedMaterialId IS NOT NULL OR sensitivity = 'icp_sensitive'",
          );
          await connection.query("DELETE FROM icp_sensitive_materials");
          await connection.commit();
        } catch (error) {
          await connection.rollback();
          throw error;
        }
      },
    });
    console.log(
      [
        confirmed ? "ICP 材料永久清理" : "ICP 材料清理预演",
        `材料记录=${result.materialCount}`,
        `附件关联=${result.attachmentCount}`,
        `记录对应文件=${result.existingFileCount}`,
        `目录文件=${result.directoryFileCount}`,
        `未登记目录项=${result.unexpectedEntryCount}`,
        `存储根=${result.storageRoot}`,
      ].join(" "),
    );
    if (!confirmed) {
      console.log(`未删除任何内容；确认后请增加参数 ${ICP_PURGE_CONFIRMATION}`);
      return;
    }
    console.log("ICP 敏感材料记录、附件关联和已登记加密文件已永久清除");
  } finally {
    await connection.end();
  }
}

const invokedDirectly =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  main().then(
    () => process.exit(0),
    (error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
    },
  );
}
