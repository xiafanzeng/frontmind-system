-- Legacy website provisioning is the only authoritative source for automatic
-- backfill. Every other user intentionally remains service-plan unconfigured
-- until a system administrator assigns a contract.
UPDATE `website_user_provisions`
SET `planCode` = 'basic'
WHERE
  `schemaVersion` = 1
  AND `status` = 'completed'
  AND `userId` IS NOT NULL
  AND `planCode` IS NULL;
--> statement-breakpoint

INSERT INTO `service_contracts` (
  `id`,
  `userId`,
  `planCode`,
  `planVersion`,
  `status`,
  `startsAt`,
  `endsAt`,
  `source`,
  `sourceReference`,
  `revision`,
  `createdByUserId`,
  `createdAt`,
  `updatedAt`
)
SELECT
  UUID(),
  eligible.`userId`,
  'basic',
  1,
  CASE
    WHEN eligible.`paidAt` > CURRENT_TIMESTAMP THEN 'scheduled'
    ELSE 'active'
  END,
  eligible.`paidAt`,
  DATE_ADD(eligible.`paidAt`, INTERVAL 30 DAY),
  'website',
  eligible.`orderId`,
  COALESCE(existing_revision.`maxRevision`, 0)
    + ROW_NUMBER() OVER (
        PARTITION BY eligible.`userId`
        ORDER BY eligible.`paidAt`, eligible.`id`
      ),
  NULL,
  COALESCE(eligible.`completedAt`, eligible.`createdAt`),
  COALESCE(eligible.`completedAt`, eligible.`updatedAt`)
FROM (
  SELECT provision.*
  FROM `website_user_provisions` provision
  LEFT JOIN `service_contracts` existing_order
    ON existing_order.`userId` = provision.`userId`
    AND existing_order.`source` = 'website'
    AND existing_order.`sourceReference` = provision.`orderId`
  WHERE
    provision.`schemaVersion` = 1
    AND provision.`status` = 'completed'
    AND provision.`userId` IS NOT NULL
    AND existing_order.`id` IS NULL
) eligible
LEFT JOIN (
  SELECT `userId`, MAX(`revision`) AS `maxRevision`
  FROM `service_contracts`
  GROUP BY `userId`
) existing_revision
  ON existing_revision.`userId` = eligible.`userId`;
--> statement-breakpoint

INSERT INTO `service_quota_periods` (
  `id`,
  `contractId`,
  `userId`,
  `ordinal`,
  `startsAt`,
  `endsAt`,
  `industryLimit`,
  `competitorComparisonLimit`,
  `reputationLimit`,
  `productScenarioLimit`,
  `totalQuestionLimit`,
  `revision`,
  `createdAt`,
  `updatedAt`
)
SELECT
  UUID(),
  contract.`id`,
  contract.`userId`,
  1,
  contract.`startsAt`,
  contract.`endsAt`,
  0,
  1,
  1,
  1,
  1,
  1,
  contract.`createdAt`,
  contract.`updatedAt`
FROM `service_contracts` contract
INNER JOIN `website_user_provisions` provision
  ON provision.`userId` = contract.`userId`
  AND provision.`orderId` = contract.`sourceReference`
LEFT JOIN `service_quota_periods` existing_period
  ON existing_period.`contractId` = contract.`id`
  AND existing_period.`ordinal` = 1
WHERE
  provision.`schemaVersion` = 1
  AND provision.`status` = 'completed'
  AND provision.`userId` IS NOT NULL
  AND contract.`source` = 'website'
  AND contract.`planCode` = 'basic'
  AND existing_period.`id` IS NULL;
--> statement-breakpoint

INSERT INTO `workspace_questions` (
  `id`,
  `userId`,
  `contractId`,
  `quotaPeriodId`,
  `externalQuestionId`,
  `candidateKey`,
  `category`,
  `question`,
  `intent`,
  `rationale`,
  `evidence`,
  `risks`,
  `source`,
  `status`,
  `locked`,
  `sourceTaskId`,
  `knowledgeSnapshotId`,
  `ordinal`,
  `revision`,
  `selectedAt`,
  `archivedAt`,
  `createdByUserId`,
  `createdAt`,
  `updatedAt`
)
SELECT
  UUID(),
  provision.`userId`,
  contract.`id`,
  quota.`id`,
  provision.`questionId`,
  CONCAT(
    'legacy-website:',
    SHA2(CONCAT(provision.`orderId`, CHAR(0), provision.`questionId`), 256)
  ),
  provision.`serviceCategory`,
  provision.`question`,
  NULL,
  '官网基础版已购问题',
  JSON_ARRAY(),
  JSON_ARRAY(),
  'website',
  'selected',
  TRUE,
  CONCAT('website-order:', provision.`orderId`),
  NULL,
  0,
  1,
  COALESCE(provision.`completedAt`, provision.`paidAt`),
  NULL,
  NULL,
  COALESCE(provision.`completedAt`, provision.`createdAt`),
  COALESCE(provision.`completedAt`, provision.`updatedAt`)
FROM `website_user_provisions` provision
INNER JOIN `service_contracts` contract
  ON contract.`userId` = provision.`userId`
  AND contract.`source` = 'website'
  AND contract.`sourceReference` = provision.`orderId`
INNER JOIN `service_quota_periods` quota
  ON quota.`contractId` = contract.`id`
  AND quota.`ordinal` = 1
LEFT JOIN `workspace_questions` existing_question
  ON existing_question.`userId` = provision.`userId`
  AND existing_question.`contractId` = contract.`id`
  AND existing_question.`externalQuestionId` = provision.`questionId`
  AND existing_question.`source` = 'website'
WHERE
  provision.`schemaVersion` = 1
  AND provision.`status` = 'completed'
  AND provision.`userId` IS NOT NULL
  AND existing_question.`id` IS NULL;
