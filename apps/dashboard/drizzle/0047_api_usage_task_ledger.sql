CREATE TABLE `api_usage_credential_coverage` (
	`id` varchar(36) NOT NULL,
	`scope` enum('managed_user','website_frontend') NOT NULL,
	`credentialFingerprint` varchar(32) NOT NULL,
	`coveredFromMs` bigint unsigned NOT NULL,
	`fullScanAtMs` bigint unsigned NOT NULL,
	`credentialRetiredAtMs` bigint unsigned,
	`allTasksSettled` boolean NOT NULL DEFAULT false,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `api_usage_credential_coverage_id` PRIMARY KEY(`id`),
	CONSTRAINT `api_usage_credential_coverage_scope_fp_uq` UNIQUE(`scope`,`credentialFingerprint`)
);
--> statement-breakpoint
CREATE TABLE `api_usage_task_ledger` (
	`id` varchar(36) NOT NULL,
	`scope` enum('managed_user','website_frontend') NOT NULL,
	`upstreamTaskId` varchar(255) NOT NULL,
	`credentialFingerprint` varchar(32) NOT NULL,
	`apiCredentialId` varchar(36),
	`accountUserId` int,
	`isFirstParty` boolean NOT NULL DEFAULT false,
	`taskCreatedAtMs` bigint unsigned NOT NULL,
	`creditUsage` bigint unsigned NOT NULL DEFAULT 0,
	`isTerminal` boolean NOT NULL DEFAULT false,
	`observedAt` timestamp NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `api_usage_task_ledger_id` PRIMARY KEY(`id`),
	CONSTRAINT `api_usage_task_ledger_scope_task_uq` UNIQUE(`scope`,`upstreamTaskId`)
);
--> statement-breakpoint
ALTER TABLE `api_usage_task_ledger` ADD CONSTRAINT `api_usage_task_ledger_accountUserId_users_id_fk` FOREIGN KEY (`accountUserId`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `api_usage_credential_coverage_scan_idx` ON `api_usage_credential_coverage` (`scope`,`fullScanAtMs`);--> statement-breakpoint
CREATE INDEX `api_usage_task_ledger_account_time_idx` ON `api_usage_task_ledger` (`accountUserId`,`taskCreatedAtMs`);--> statement-breakpoint
CREATE INDEX `api_usage_task_ledger_pool_time_idx` ON `api_usage_task_ledger` (`scope`,`credentialFingerprint`,`taskCreatedAtMs`);