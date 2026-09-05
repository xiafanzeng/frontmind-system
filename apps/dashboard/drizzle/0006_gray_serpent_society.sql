CREATE TABLE `presales_monitor_runs` (
	`id` varchar(36) NOT NULL,
	`idempotencyKeyHash` varchar(64) NOT NULL,
	`requestHash` varchar(64) NOT NULL,
	`apiCredentialId` varchar(36) NOT NULL,
	`credentialVersion` int NOT NULL,
	`question` text NOT NULL,
	`platforms` json NOT NULL,
	`expectedItems` int NOT NULL,
	`status` enum('submission_in_progress','submission_unknown','submitted','polling','completed','partial_review_required','remote_failed','shape_mismatch') NOT NULL DEFAULT 'submission_in_progress',
	`upstreamTaskId` varchar(128),
	`submitTotalItems` int,
	`initialSubtaskIds` json,
	`subtaskScopes` json,
	`remoteStatus` varchar(64),
	`completedItems` int NOT NULL DEFAULT 0,
	`failedItems` int NOT NULL DEFAULT 0,
	`totalItems` int,
	`checkpoint` json,
	`finalResult` json,
	`shapeMismatch` boolean NOT NULL DEFAULT false,
	`terminalSnapshotHash` varchar(64),
	`terminalStableCount` int NOT NULL DEFAULT 0,
	`lastError` text,
	`nextPollAt` timestamp,
	`lastPollStartedAt` timestamp,
	`pollLeaseId` varchar(36),
	`pollLeaseExpiresAt` timestamp,
	`submittedAt` timestamp,
	`completedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `presales_monitor_runs_id` PRIMARY KEY(`id`),
	CONSTRAINT `presales_monitor_runs_idempotencyKeyHash_unique` UNIQUE(`idempotencyKeyHash`)
);
--> statement-breakpoint
ALTER TABLE `presales_monitor_runs` ADD CONSTRAINT `presales_monitor_credential_fk` FOREIGN KEY (`apiCredentialId`) REFERENCES `presales_api_credentials`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `presales_monitor_credential_status_idx` ON `presales_monitor_runs` (`apiCredentialId`,`status`);--> statement-breakpoint
CREATE INDEX `presales_monitor_poll_idx` ON `presales_monitor_runs` (`status`,`nextPollAt`);