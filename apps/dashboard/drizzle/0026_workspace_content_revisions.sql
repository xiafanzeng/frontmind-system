CREATE TABLE `workspace_content_revisions` (
	`id` varchar(36) NOT NULL,
	`userId` int NOT NULL,
	`module` varchar(64) NOT NULL DEFAULT 'dashboard',
	`revision` int unsigned NOT NULL,
	`payload` json NOT NULL,
	`sourceName` varchar(512),
	`enterpriseIdentityBoundAt` timestamp,
	`publicationKind` enum('publish','rollback','migration') NOT NULL DEFAULT 'publish',
	`rolledBackFromRevision` int unsigned,
	`publishedByUserId` int,
	`reason` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `workspace_content_revisions_id` PRIMARY KEY(`id`),
	CONSTRAINT `workspace_content_revisions_user_module_revision_uq` UNIQUE(`userId`,`module`,`revision`)
);
--> statement-breakpoint
ALTER TABLE `workspace_content_revisions` ADD CONSTRAINT `workspace_content_revisions_userId_users_id_fk` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `workspace_content_revisions` ADD CONSTRAINT `workspace_content_revisions_publishedByUserId_users_id_fk` FOREIGN KEY (`publishedByUserId`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
INSERT INTO `workspace_content_revisions` (
	`id`,
	`userId`,
	`module`,
	`revision`,
	`payload`,
	`sourceName`,
	`enterpriseIdentityBoundAt`,
	`publicationKind`,
	`rolledBackFromRevision`,
	`publishedByUserId`,
	`reason`,
	`createdAt`
)
SELECT
	UUID(),
	`userId`,
	'dashboard',
	`revision`,
	`payload`,
	`sourceName`,
	`enterpriseIdentityBoundAt`,
	'migration',
	NULL,
	`updatedByUserId`,
	NULL,
	`updatedAt`
FROM `user_dashboard_contents`;--> statement-breakpoint
CREATE INDEX `workspace_content_revisions_user_module_created_idx` ON `workspace_content_revisions` (`userId`,`module`,`createdAt`);--> statement-breakpoint
CREATE INDEX `workspace_content_revisions_publisher_idx` ON `workspace_content_revisions` (`publishedByUserId`);
