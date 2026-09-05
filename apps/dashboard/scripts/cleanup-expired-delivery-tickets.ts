import "dotenv/config";

import {
  DEFAULT_DELIVERY_TICKET_RETENTION_DAYS,
  runDeliveryTicketRetentionCleanup,
} from "../server/delivery-ticket-retention";

runDeliveryTicketRetentionCleanup().then(
  (execution) => {
    if (!execution.acquired || !execution.result) {
      console.log("工单清理未执行：另一个实例正在清理或数据库未配置");
      process.exit(0);
    }
    console.log(
      [
        "过期工单清理完成",
        `保留期=${DEFAULT_DELIVERY_TICKET_RETENTION_DAYS}天`,
        `截止=${execution.result.cutoff.toISOString()}`,
        `工单=${execution.result.tickets}`,
        `批次=${execution.result.batches}`,
      ].join(" "),
    );
    process.exit(0);
  },
  (error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  },
);
