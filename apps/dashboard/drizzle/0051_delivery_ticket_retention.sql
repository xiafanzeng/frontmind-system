CREATE TABLE `delivery_workflow_milestones` (
	`id` varchar(36) NOT NULL,
	`userId` int NOT NULL,
	`operation` varchar(64) NOT NULL,
	`contentAssetIds` json NOT NULL DEFAULT ('[]'),
	`completedAt` timestamp NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `delivery_workflow_milestones_id` PRIMARY KEY(`id`),
	CONSTRAINT `delivery_workflow_milestones_user_operation_uq` UNIQUE(`userId`,`operation`),
	CONSTRAINT `delivery_workflow_milestones_userId_users_id_fk` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint
ALTER TABLE `service_quota_periods` ADD `archivedContentAssetPublishUsed` int unsigned NOT NULL DEFAULT 0;--> statement-breakpoint
ALTER TABLE `service_quota_periods` ADD `archivedWebsiteContentPublishUsed` int unsigned NOT NULL DEFAULT 0;--> statement-breakpoint
CREATE INDEX `delivery_workflow_milestones_operation_idx` ON `delivery_workflow_milestones` (`operation`);--> statement-breakpoint
CREATE INDEX `delivery_tickets_status_resolved_id_idx` ON `delivery_tickets` (`status`,`resolvedAt`,`id`);
