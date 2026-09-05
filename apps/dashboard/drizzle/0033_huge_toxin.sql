ALTER TABLE `api_usage_snapshots` ADD `accountUsed` int unsigned DEFAULT 0 NOT NULL;
--> statement-breakpoint
UPDATE `service_quota_periods` AS `period`
INNER JOIN `service_contracts` AS `contract`
  ON `contract`.`id` = `period`.`contractId`
SET
  `period`.`contentAssetPublishLimit` = 1,
  `period`.`revision` = `period`.`revision` + 1
WHERE
  `contract`.`planCode` = 'basic'
  AND `contract`.`status` IN (
    'pending_confirmation',
    'scheduled',
    'active',
    'suspended'
  )
  AND `period`.`endsAt` > CURRENT_TIMESTAMP
  AND `period`.`contentAssetPublishLimit` = 0;
