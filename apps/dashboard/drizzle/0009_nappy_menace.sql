CREATE TABLE `knowledge_base_snapshots` (
	`id` varchar(36) NOT NULL,
	`userId` int NOT NULL,
	`version` int NOT NULL,
	`sourceFileName` varchar(512) NOT NULL,
	`sourceConversationId` varchar(191),
	`documents` json NOT NULL,
	`assets` json NOT NULL,
	`documentCount` int NOT NULL DEFAULT 0,
	`imageCount` int NOT NULL DEFAULT 0,
	`characterCount` int NOT NULL DEFAULT 0,
	`totalBytes` int unsigned NOT NULL DEFAULT 0,
	`status` enum('active','archived') NOT NULL DEFAULT 'active',
	`createdByUserId` int,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `knowledge_base_snapshots_id` PRIMARY KEY(`id`),
	CONSTRAINT `knowledge_base_snapshots_user_version_uq` UNIQUE(`userId`,`version`)
);
--> statement-breakpoint
CREATE TABLE `user_admin_assignments` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`adminId` int NOT NULL,
	`assignedByUserId` int,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `user_admin_assignments_id` PRIMARY KEY(`id`),
	CONSTRAINT `user_admin_assignments_user_admin_uq` UNIQUE(`userId`,`adminId`)
);
--> statement-breakpoint
CREATE TABLE `user_dashboard_contents` (
	`userId` int NOT NULL,
	`payload` json NOT NULL,
	`sourceName` varchar(512),
	`updatedByUserId` int,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `user_dashboard_contents_userId` PRIMARY KEY(`userId`)
);
--> statement-breakpoint
ALTER TABLE `knowledge_base_snapshots` ADD CONSTRAINT `knowledge_base_snapshots_userId_users_id_fk` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `knowledge_base_snapshots` ADD CONSTRAINT `knowledge_base_snapshots_createdByUserId_users_id_fk` FOREIGN KEY (`createdByUserId`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `user_admin_assignments` ADD CONSTRAINT `user_admin_assignments_userId_users_id_fk` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `user_admin_assignments` ADD CONSTRAINT `user_admin_assignments_adminId_users_id_fk` FOREIGN KEY (`adminId`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `user_admin_assignments` ADD CONSTRAINT `user_admin_assignments_assignedByUserId_users_id_fk` FOREIGN KEY (`assignedByUserId`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `user_dashboard_contents` ADD CONSTRAINT `user_dashboard_contents_userId_users_id_fk` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `user_dashboard_contents` ADD CONSTRAINT `user_dashboard_contents_updatedByUserId_users_id_fk` FOREIGN KEY (`updatedByUserId`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `knowledge_base_snapshots_user_status_idx` ON `knowledge_base_snapshots` (`userId`,`status`);--> statement-breakpoint
CREATE INDEX `user_admin_assignments_admin_idx` ON `user_admin_assignments` (`adminId`);--> statement-breakpoint
CREATE INDEX `user_dashboard_contents_updated_idx` ON `user_dashboard_contents` (`updatedAt`);