CREATE TABLE `workspace_audit_events` (
	`id` varchar(36) NOT NULL,
	`actorUserId` int,
	`actorUsername` varchar(64),
	`actorAccessLevel` enum('system_admin','delivery_admin'),
	`action` varchar(128) NOT NULL,
	`targetType` varchar(64) NOT NULL,
	`targetId` varchar(191) NOT NULL,
	`workspaceUserId` int,
	`reason` text,
	`metadata` json NOT NULL DEFAULT ('{}'),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `workspace_audit_events_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `users` ADD `adminAccessLevel` enum('system_admin','delivery_admin');--> statement-breakpoint
UPDATE `users`
SET `adminAccessLevel` = CASE
	WHEN LOWER(TRIM(COALESCE(`username`, ''))) = 'admin' THEN 'system_admin'
	ELSE 'delivery_admin'
END
WHERE `role` = 'admin' AND `adminAccessLevel` IS NULL;--> statement-breakpoint
ALTER TABLE `workspace_audit_events` ADD CONSTRAINT `workspace_audit_events_actorUserId_users_id_fk` FOREIGN KEY (`actorUserId`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `workspace_audit_events_actor_created_idx` ON `workspace_audit_events` (`actorUserId`,`createdAt`);--> statement-breakpoint
CREATE INDEX `workspace_audit_events_workspace_created_idx` ON `workspace_audit_events` (`workspaceUserId`,`createdAt`);--> statement-breakpoint
CREATE INDEX `workspace_audit_events_action_created_idx` ON `workspace_audit_events` (`action`,`createdAt`);--> statement-breakpoint
CREATE INDEX `workspace_audit_events_target_idx` ON `workspace_audit_events` (`targetType`,`targetId`);
