ALTER TABLE `user_dashboard_contents` ADD `enterpriseIdentityBoundAt` timestamp;
--> statement-breakpoint
UPDATE `user_dashboard_contents`
SET `enterpriseIdentityBoundAt` = COALESCE(`updatedAt`, `createdAt`, CURRENT_TIMESTAMP)
WHERE `sourceName` IS NOT NULL
  AND `sourceName` NOT LIKE '官网%';
