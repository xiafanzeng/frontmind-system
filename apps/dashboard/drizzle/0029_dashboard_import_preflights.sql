CREATE TABLE `dashboard_import_preflights` (
	`id` varchar(36) NOT NULL,
	`actorUserId` int NOT NULL,
	`workspaceUserId` int NOT NULL,
	`module` varchar(64) NOT NULL,
	`dashboardRevision` int unsigned NOT NULL,
	`fileHash` varchar(64) NOT NULL,
	`sectionId` varchar(80),
	`targetBatchKey` varchar(191),
	`expiresAt` timestamp NOT NULL,
	`consumedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `dashboard_import_preflights_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `dashboard_import_preflights` ADD CONSTRAINT `dashboard_import_preflights_actorUserId_users_id_fk` FOREIGN KEY (`actorUserId`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `dashboard_import_preflights` ADD CONSTRAINT `dashboard_import_preflights_workspaceUserId_users_id_fk` FOREIGN KEY (`workspaceUserId`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX `dashboard_import_preflights_actor_expires_idx` ON `dashboard_import_preflights` (`actorUserId`,`expiresAt`);
--> statement-breakpoint
CREATE INDEX `dashboard_import_preflights_workspace_expires_idx` ON `dashboard_import_preflights` (`workspaceUserId`,`expiresAt`);
--> statement-breakpoint
CREATE INDEX `dashboard_import_preflights_consumed_expires_idx` ON `dashboard_import_preflights` (`consumedAt`,`expiresAt`);
