CREATE TEMPORARY TABLE `_frontmind_project_team_preflight` (
	`unexpectedRows` int NOT NULL,
	CONSTRAINT `_frontmind_project_team_preflight_empty` CHECK (`unexpectedRows` = 0)
);--> statement-breakpoint
INSERT INTO `_frontmind_project_team_preflight` (`unexpectedRows`)
SELECT
	(SELECT COUNT(*) FROM `users` WHERE `role` = 'delivery_member') +
	(SELECT COUNT(*) FROM `delivery_role_members`) +
	(SELECT COUNT(*) FROM `delivery_customer_assignments`) +
	(SELECT COUNT(*) FROM `delivery_tickets` WHERE `assignedRoleId` IS NOT NULL) +
	(SELECT COUNT(*) FROM `knowledge_base_reset_requests`);
--> statement-breakpoint
DROP TEMPORARY TABLE `_frontmind_project_team_preflight`;--> statement-breakpoint

ALTER TABLE `delivery_tickets` DROP FOREIGN KEY `delivery_tickets_assigned_role_fk`;--> statement-breakpoint
ALTER TABLE `knowledge_base_reset_requests` DROP FOREIGN KEY `knowledge_base_reset_requests_role_fk`;--> statement-breakpoint

CREATE TABLE `delivery_project_assignments` (
	`id` varchar(36) NOT NULL,
	`customerUserId` int NOT NULL,
	`roleType` enum('knowledge_base_engineer','monitoring_optimization_engineer','content_distribution_engineer','website_operations_engineer') NOT NULL,
	`engineerUserId` int NOT NULL,
	`revision` int unsigned NOT NULL DEFAULT 1,
	`assignedByUserId` int,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `delivery_project_assignments_id` PRIMARY KEY(`id`),
	CONSTRAINT `delivery_project_assignments_customer_type_uq` UNIQUE(`customerUserId`,`roleType`),
	CONSTRAINT `delivery_project_assignments_customerUserId_users_id_fk` FOREIGN KEY (`customerUserId`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action,
	CONSTRAINT `delivery_project_assignments_engineerUserId_users_id_fk` FOREIGN KEY (`engineerUserId`) REFERENCES `users`(`id`) ON DELETE restrict ON UPDATE no action,
	CONSTRAINT `delivery_project_assignments_assignedByUserId_users_id_fk` FOREIGN KEY (`assignedByUserId`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action
);--> statement-breakpoint
CREATE INDEX `delivery_project_assignments_engineer_type_idx` ON `delivery_project_assignments` (`engineerUserId`,`roleType`);--> statement-breakpoint

ALTER TABLE `users` ADD `engineerRoleType` enum('knowledge_base_engineer','monitoring_optimization_engineer','content_distribution_engineer','website_operations_engineer');--> statement-breakpoint
ALTER TABLE `delivery_tickets` ADD `assignedProjectAssignmentId` varchar(36);--> statement-breakpoint
ALTER TABLE `knowledge_base_reset_requests` ADD `assignedProjectAssignmentId` varchar(36) NOT NULL;--> statement-breakpoint
ALTER TABLE `delivery_tickets` ADD CONSTRAINT `delivery_tickets_project_assignment_fk` FOREIGN KEY (`assignedProjectAssignmentId`) REFERENCES `delivery_project_assignments`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `knowledge_base_reset_requests` ADD CONSTRAINT `kb_reset_project_assignment_fk` FOREIGN KEY (`assignedProjectAssignmentId`) REFERENCES `delivery_project_assignments`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint

ALTER TABLE `delivery_tickets` DROP COLUMN `assignedRoleId`;--> statement-breakpoint
ALTER TABLE `knowledge_base_reset_requests` DROP COLUMN `assignedRoleId`;--> statement-breakpoint
DROP TABLE `delivery_customer_assignments`;--> statement-breakpoint
DROP TABLE `delivery_role_members`;--> statement-breakpoint
DROP TABLE `delivery_roles`;
