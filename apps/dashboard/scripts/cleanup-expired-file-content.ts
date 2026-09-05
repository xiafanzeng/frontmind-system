import "dotenv/config";

import {
  cleanupExpiredFileContent,
  runFileContentRetentionCleanup,
} from "../server/file-content-retention";
import { preparedFileService } from "../server/prepared-file-service";

async function main() {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) throw new Error("DATABASE_URL 未配置");

  const execution = await runFileContentRetentionCleanup({
    databaseUrl,
    cleanup: () =>
      cleanupExpiredFileContent({
        removePreparedAssets: (resource) =>
          preparedFileService.deleteByOwnedFileSource({
            ownerUserId: resource.userId,
            fileId: resource.upstreamId,
            projectAssignmentId: resource.projectAssignmentId,
          }),
        removePreparedAssetsByFileId: (fileId) =>
          preparedFileService.deleteByFileSource(fileId),
      }),
  });
  if (!execution.acquired || !execution.result) {
    console.log("过期文件清理跳过 原因=另一个实例正在执行");
    return;
  }
  const result = execution.result;
  console.log(
    [
      "过期文件清理完成",
      `截止=${result.cutoff.toISOString()}`,
      `回填=${result.backfilled}`,
      `批次=${result.batches}`,
      `内容批次=${result.contentBatches}`,
      `元数据批次=${result.metadataBatches}`,
      `过期内容=${result.expired}`,
      `元数据=${result.metadataDeleted}`,
      `数据库关联字节=${result.bytesReclaimed}`,
      `文件系统条目=${result.filesystemDeleted}`,
      `文件系统字节=${result.filesystemBytesReclaimed}`,
      `临时文件=${result.filesystemStaleTempsDeleted}`,
      `失败=${result.failures + result.filesystemFailures}`,
      `剩余积压=${result.filesystemHasMore ? "是" : "否"}`,
    ].join(" "),
  );
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  },
);
