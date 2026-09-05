CREATE TEMPORARY TABLE `_frontmind_three_roles_preflight` (
  `unexpectedRows` int NOT NULL,
  CONSTRAINT `_frontmind_three_roles_preflight_empty` CHECK (`unexpectedRows` = 0)
);--> statement-breakpoint
INSERT INTO `_frontmind_three_roles_preflight` (`unexpectedRows`)
SELECT
  (SELECT COUNT(*) FROM `users` WHERE `role` = 'delivery_member') +
  (SELECT COUNT(*) FROM `delivery_project_assignments`) +
  (
    SELECT COUNT(*)
    FROM `knowledge_base_reset_requests`
    WHERE `status` = 'pending'
  );
--> statement-breakpoint
DROP TEMPORARY TABLE `_frontmind_three_roles_preflight`;--> statement-breakpoint

CREATE TEMPORARY TABLE `_frontmind_icp_purge_preflight` (
  `unexpectedRows` int NOT NULL,
  CONSTRAINT `_frontmind_icp_purge_preflight_empty` CHECK (`unexpectedRows` = 0)
);--> statement-breakpoint
INSERT INTO `_frontmind_icp_purge_preflight` (`unexpectedRows`)
SELECT
  (SELECT COUNT(*) FROM `icp_sensitive_materials`) +
  (
    SELECT COUNT(*)
    FROM `delivery_ticket_attachments`
    WHERE `protectedMaterialId` IS NOT NULL
       OR `sensitivity` = 'icp_sensitive'
  );
--> statement-breakpoint
DROP TEMPORARY TABLE `_frontmind_icp_purge_preflight`;--> statement-breakpoint

ALTER TABLE `delivery_project_assignments` MODIFY COLUMN `roleType` enum('knowledge_base_engineer','website_operations_engineer','ai_operations_engineer','monitoring_optimization_engineer','content_distribution_engineer') NOT NULL;--> statement-breakpoint
ALTER TABLE `delivery_tickets` MODIFY COLUMN `workflowDomain` enum('knowledge_base_engineer','website_operations_engineer','ai_operations_engineer','monitoring_optimization_engineer','content_distribution_engineer');--> statement-breakpoint
ALTER TABLE `users` MODIFY COLUMN `engineerRoleType` enum('knowledge_base_engineer','website_operations_engineer','ai_operations_engineer','monitoring_optimization_engineer','content_distribution_engineer');--> statement-breakpoint

UPDATE `delivery_tickets`
SET `workflowDomain` = 'ai_operations_engineer'
WHERE `workflowDomain` IN ('knowledge_base_engineer', 'website_operations_engineer');--> statement-breakpoint
UPDATE `delivery_project_assignments`
SET `roleType` = 'ai_operations_engineer'
WHERE `roleType` IN ('knowledge_base_engineer', 'website_operations_engineer');--> statement-breakpoint
UPDATE `users`
SET `engineerRoleType` = 'ai_operations_engineer'
WHERE `engineerRoleType` IN ('knowledge_base_engineer', 'website_operations_engineer');--> statement-breakpoint

ALTER TABLE `delivery_project_assignments` MODIFY COLUMN `roleType` enum('ai_operations_engineer','monitoring_optimization_engineer','content_distribution_engineer') NOT NULL;--> statement-breakpoint
ALTER TABLE `delivery_tickets` MODIFY COLUMN `workflowDomain` enum('ai_operations_engineer','monitoring_optimization_engineer','content_distribution_engineer');--> statement-breakpoint
ALTER TABLE `users` MODIFY COLUMN `engineerRoleType` enum('ai_operations_engineer','monitoring_optimization_engineer','content_distribution_engineer');--> statement-breakpoint

ALTER TABLE `delivery_ticket_attachments` DROP FOREIGN KEY `ticket_attachments_protected_material_fk`;--> statement-breakpoint
ALTER TABLE `delivery_ticket_attachments` DROP INDEX `delivery_ticket_attachments_event_protected_kind_uq`;--> statement-breakpoint
ALTER TABLE `delivery_ticket_attachments` DROP COLUMN `protectedMaterialId`;--> statement-breakpoint
ALTER TABLE `delivery_ticket_attachments` DROP COLUMN `sensitivity`;--> statement-breakpoint
DROP TABLE `icp_sensitive_materials`;
