import "dotenv/config";
import mysql from "mysql2/promise";

type PreflightRow = {
  engineerAccounts: number;
  legacyTeamMembers: number;
  legacyCustomerAssignments: number;
  assignedTickets: number;
  resetRequests: number;
};

async function main() {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) throw new Error("DATABASE_URL 未配置");

  const connection = await mysql.createConnection(databaseUrl);
  try {
    const [rows] = await connection.query<mysql.RowDataPacket[]>(`
      SELECT
        (SELECT COUNT(*) FROM users WHERE role = 'delivery_member') AS engineerAccounts,
        (SELECT COUNT(*) FROM delivery_role_members) AS legacyTeamMembers,
        (SELECT COUNT(*) FROM delivery_customer_assignments) AS legacyCustomerAssignments,
        (SELECT COUNT(*) FROM delivery_tickets WHERE assignedRoleId IS NOT NULL) AS assignedTickets,
        (SELECT COUNT(*) FROM knowledge_base_reset_requests) AS resetRequests
    `);
    const result = rows[0] as PreflightRow | undefined;
    if (!result) throw new Error("迁移预检未返回结果");

    const unexpectedRows = Object.values(result).reduce(
      (sum, value) => sum + Number(value),
      0,
    );
    console.log(
      [
        "客户项目团队迁移只读预检",
        `工程师账号=${result.engineerAccounts}`,
        `旧团队成员=${result.legacyTeamMembers}`,
        `旧客户岗位分配=${result.legacyCustomerAssignments}`,
        `已关联旧岗位工单=${result.assignedTickets}`,
        `知识库重置请求=${result.resetRequests}`,
      ].join(" "),
    );
    if (unexpectedRows > 0) {
      throw new Error(
        "检测到旧交付数据，已中止迁移；请先制定显式映射或归档方案，禁止静默清理",
      );
    }
  } finally {
    await connection.end();
  }
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  },
);
