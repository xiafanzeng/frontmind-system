import "dotenv/config";

import {
  cleanupExpiredConversations,
  DEFAULT_CONVERSATION_RETENTION_DAYS,
  runConversationRetentionCleanup,
} from "../server/conversation-retention";

async function main() {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) throw new Error("DATABASE_URL 未配置");
  if (process.argv.includes("--retention-days")) {
    throw new Error("会话闲置保留期固定为 30 天，不支持 --retention-days");
  }

  // Product policy is fixed: this operational command must not be able to
  // shorten or extend the user-visible idle-retention promise.
  const retentionDays = DEFAULT_CONVERSATION_RETENTION_DAYS;
  const execution = await runConversationRetentionCleanup({
    databaseUrl,
    cleanup: (connection) =>
      cleanupExpiredConversations(connection, retentionDays),
  });
  if (!execution.acquired || !execution.result) {
    console.log("过期会话清理跳过 原因=另一个实例正在执行");
    return;
  }
  const result = execution.result;
  console.log(
    [
      "过期会话清理完成",
      `保留期=${retentionDays}天`,
      `截止=${result.cutoff.toISOString()}`,
      `批次=${result.batches}`,
      `会话=${result.conversations}`,
      `消息=${result.messages}`,
      `附件=${result.attachments}`,
      `轮次=${result.turns}`,
      `剩余积压=${result.truncated ? "是（本次有界清理已截断）" : "否"}`,
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
