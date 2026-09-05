CREATE TABLE `service_progress_reports` (
	`id` varchar(36) NOT NULL,
	`userId` int NOT NULL,
	`contractId` varchar(36) NOT NULL,
	`quotaPeriodId` varchar(36) NOT NULL,
	`payload` json NOT NULL,
	`sourceName` varchar(512),
	`revision` int unsigned NOT NULL DEFAULT 1,
	`publishedByUserId` int,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `service_progress_reports_id` PRIMARY KEY(`id`),
	CONSTRAINT `service_progress_reports_period_revision_uq` UNIQUE(`quotaPeriodId`,`revision`)
);
--> statement-breakpoint
CREATE TABLE `user_password_setup_tokens` (
	`id` varchar(36) NOT NULL,
	`userId` int NOT NULL,
	`tokenHash` varchar(64) NOT NULL,
	`expiresAt` timestamp NOT NULL,
	`consumedAt` timestamp,
	`createdByUserId` int,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `user_password_setup_tokens_id` PRIMARY KEY(`id`),
	CONSTRAINT `user_password_setup_tokens_tokenHash_unique` UNIQUE(`tokenHash`)
);
--> statement-breakpoint
ALTER TABLE `monitoring_batches` DROP INDEX `monitoring_batches_user_key_uq`;--> statement-breakpoint
ALTER TABLE `monitoring_batches` ADD `contractId` varchar(36);--> statement-breakpoint
ALTER TABLE `monitoring_batches` ADD `quotaPeriodId` varchar(36);--> statement-breakpoint
ALTER TABLE `workspace_questions` ADD `intentRevision` int unsigned DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `workspace_questions` ADD `intentConfirmedRevision` int unsigned;--> statement-breakpoint
ALTER TABLE `workspace_questions` ADD `intentConfirmedAt` timestamp;--> statement-breakpoint
ALTER TABLE `workspace_questions` ADD `intentConfirmedByUserId` int;--> statement-breakpoint
ALTER TABLE `monitoring_batches` ADD CONSTRAINT `monitoring_batches_user_period_key_uq` UNIQUE(`userId`,`quotaPeriodId`,`batchKey`);--> statement-breakpoint
ALTER TABLE `service_progress_reports` ADD CONSTRAINT `service_progress_reports_userId_users_id_fk` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `service_progress_reports` ADD CONSTRAINT `service_progress_reports_contractId_service_contracts_id_fk` FOREIGN KEY (`contractId`) REFERENCES `service_contracts`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `service_progress_reports` ADD CONSTRAINT `service_progress_reports_quota_period_fk` FOREIGN KEY (`quotaPeriodId`) REFERENCES `service_quota_periods`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `service_progress_reports` ADD CONSTRAINT `service_progress_reports_publishedByUserId_users_id_fk` FOREIGN KEY (`publishedByUserId`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `user_password_setup_tokens` ADD CONSTRAINT `user_password_setup_tokens_userId_users_id_fk` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `user_password_setup_tokens` ADD CONSTRAINT `user_password_setup_tokens_createdByUserId_users_id_fk` FOREIGN KEY (`createdByUserId`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `service_progress_reports_user_period_created_idx` ON `service_progress_reports` (`userId`,`quotaPeriodId`,`createdAt`);--> statement-breakpoint
CREATE INDEX `service_progress_reports_contract_idx` ON `service_progress_reports` (`contractId`);--> statement-breakpoint
CREATE INDEX `user_password_setup_tokens_user_expires_idx` ON `user_password_setup_tokens` (`userId`,`expiresAt`);--> statement-breakpoint
CREATE INDEX `user_password_setup_tokens_hash_consumed_idx` ON `user_password_setup_tokens` (`tokenHash`,`consumedAt`);--> statement-breakpoint
ALTER TABLE `monitoring_batches` ADD CONSTRAINT `monitoring_batches_contractId_service_contracts_id_fk` FOREIGN KEY (`contractId`) REFERENCES `service_contracts`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `monitoring_batches` ADD CONSTRAINT `monitoring_batches_quotaPeriodId_service_quota_periods_id_fk` FOREIGN KEY (`quotaPeriodId`) REFERENCES `service_quota_periods`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `workspace_questions` ADD CONSTRAINT `workspace_questions_intentConfirmedByUserId_users_id_fk` FOREIGN KEY (`intentConfirmedByUserId`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `monitoring_batches_contract_period_idx` ON `monitoring_batches` (`contractId`,`quotaPeriodId`);
