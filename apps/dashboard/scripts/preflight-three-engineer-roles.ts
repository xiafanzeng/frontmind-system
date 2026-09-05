import "dotenv/config";
import mysql from "mysql2/promise";

type PreflightRow = {
  engineerAccounts: number;
  projectAssignments: number;
  pendingKnowledgeResets: number;
};

async function main() {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) throw new Error("DATABASE_URL 未配置");

  const connection = await mysql.createConnection(databaseUrl);
  try {
    const [rows] = await connection.query<mysql.RowDataPacket[]>(`
      SELECT
        (SELECT COUNT(*) FROM users WHERE role = 'delivery_member') AS engineerAccounts,
        (SELECT COUNT(*) FROM delivery_project_assignments) AS projectAssignments,
        (
          SELECT COUNT(*)
          FROM knowledge_base_reset_requests
          WHERE status = 'pending'
        ) AS pendingKnowledgeResets
    `);
    const result = rows[0] as PreflightRow | undefined;
    if (!result) throw new Error("三角色迁移预检未返回结果");

    console.log(
      [
        "三类工程师迁移只读预检",
        `工程师账号=${Number(result.engineerAccounts)}`,
        `项目岗位分配=${Number(result.projectAssignments)}`,
        `待审批知识库重置=${Number(result.pendingKnowledgeResets)}`,
      ].join(" "),
    );
    if (
      Number(result.engineerAccounts) > 0 ||
      Number(result.projectAssignments) > 0 ||
      Number(result.pendingKnowledgeResets) > 0
    ) {
      throw new Error(
        "检测到工程师、项目岗位或待审批重置数据，已中止三角色迁移；禁止静默选择合并后的负责人",
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
