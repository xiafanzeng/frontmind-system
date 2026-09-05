import "dotenv/config";
import { randomUUID } from "node:crypto";
import mysql from "mysql2/promise";

type CustomerRow = mysql.RowDataPacket & {
  userId: number;
  hasWebsiteContent: number;
};

type AssignmentRow = mysql.RowDataPacket & {
  id: string;
  engineerUserId: number;
};

type QuotaRow = mysql.RowDataPacket & {
  id: string;
  contractId: string;
};

async function main() {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) throw new Error("DATABASE_URL 未配置");

  const connection = await mysql.createConnection(databaseUrl);
  let legacyConfirmed = 0;
  let waitingSamples = 0;
  let skipped = 0;
  try {
    const [customers] = await connection.query<CustomerRow[]>(`
      SELECT
        profile.userId,
        EXISTS (
          SELECT 1
          FROM delivery_tickets ticket
          WHERE ticket.userId = profile.userId
            AND ticket.operation IN (
              'company_facts',
              'product_case_docs',
              'industry_news',
              'company_news',
              'faq_content'
            )
            AND ticket.status NOT IN ('rejected', 'cancelled')
        ) AS hasWebsiteContent
      FROM workspace_site_profiles profile
      LEFT JOIN website_style_workflows workflow
        ON workflow.userId = profile.userId
      WHERE profile.icpStatus IN ('approved', 'not_required')
        AND workflow.userId IS NULL
      ORDER BY profile.userId
    `);

    for (const customer of customers) {
      await connection.beginTransaction();
      try {
        const [existing] = await connection.execute<mysql.RowDataPacket[]>(
          "SELECT userId FROM website_style_workflows WHERE userId = ? FOR UPDATE",
          [customer.userId],
        );
        if (existing.length > 0) {
          await connection.commit();
          continue;
        }

        if (Boolean(customer.hasWebsiteContent)) {
          await connection.execute(
            `INSERT INTO website_style_workflows
              (userId, status, revision, createdAt, updatedAt)
             VALUES (?, 'legacy_confirmed', 1, NOW(), NOW())`,
            [customer.userId],
          );
          legacyConfirmed += 1;
          await connection.commit();
          continue;
        }

        const [assignments] =
          await connection.execute<AssignmentRow[]>(
            `SELECT id, engineerUserId
             FROM delivery_project_assignments
             WHERE customerUserId = ?
               AND roleType = 'ai_operations_engineer'
               AND engineerUserId IS NOT NULL
             LIMIT 1`,
            [customer.userId],
          );
        const [periods] = await connection.execute<QuotaRow[]>(
          `SELECT id, contractId
           FROM service_quota_periods
           WHERE userId = ?
           ORDER BY endsAt DESC, startsAt DESC, id DESC
           LIMIT 1`,
          [customer.userId],
        );
        const assignment = assignments[0];
        const period = periods[0];
        if (!assignment || !period) {
          skipped += 1;
          await connection.rollback();
          console.warn(
            `跳过客户 #${customer.userId}：缺少 AI 运维工程师分配或服务周期`,
          );
          continue;
        }

        const ticketId = randomUUID();
        await connection.execute(
          `INSERT INTO website_style_workflows
            (userId, status, revision, createdAt, updatedAt)
           VALUES (?, 'waiting_samples', 1, NOW(), NOW())`,
          [customer.userId],
        );
        await connection.execute(
          `INSERT INTO delivery_tickets (
            id, userId, contractId, quotaPeriodId, type, quotaPool, ordinal,
            clientRequestId, category, title, description, workflowDomain,
            operation, assignedProjectAssignmentId, assignedMemberId,
            technicalDedupeKey, quotaState, status, revision, createdAt,
            updatedAt
          ) VALUES (
            ?, ?, ?, ?, 'website_operation', NULL, 0,
            ?, 'website_style_samples', '提供 AI 专用官网图片风格样例',
            'ICP备案已确认，请提供三张图片风格样例供客户选择；客户确认后再开始官网构建与内容运营。',
            'ai_operations_engineer', 'website_style_samples', ?, ?,
            ?, 'consumed', 'submitted', 1, NOW(), NOW()
          )`,
          [
            ticketId,
            customer.userId,
            period.contractId,
            period.id,
            randomUUID(),
            assignment.id,
            assignment.engineerUserId,
            `website-style:${customer.userId}`,
          ],
        );
        await connection.execute(
          `INSERT INTO delivery_ticket_events (
            id, ticketId, userId, actorUserId, actorRole, kind, visibility,
            message, toStatus, createdAt
          ) VALUES (
            ?, ?, ?, NULL, 'system', 'created', 'customer',
            '备案结果已确认，正在等待工程师提供三张官网图片风格样例。',
            'submitted', NOW()
          )`,
          [randomUUID(), ticketId, customer.userId],
        );
        waitingSamples += 1;
        await connection.commit();
      } catch (error) {
        await connection.rollback();
        throw error;
      }
    }

    console.log(
      [
        "官网风格工作流回填完成",
        `历史确认=${legacyConfirmed}`,
        `等待样例=${waitingSamples}`,
        `缺少分配或周期=${skipped}`,
      ].join(" "),
    );
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
