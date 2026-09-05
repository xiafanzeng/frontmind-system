CREATE TABLE `presales_task_requests` (
	`id` varchar(36) NOT NULL,
	`keyHash` varchar(64) NOT NULL,
	`requestHash` varchar(64) NOT NULL,
	`apiCredentialId` varchar(36) NOT NULL,
	`credentialVersion` int NOT NULL,
	`status` enum('pending','completed') NOT NULL DEFAULT 'pending',
	`attemptId` varchar(36) NOT NULL,
	`leaseExpiresAt` timestamp NOT NULL,
	`upstreamTaskId` varchar(255),
	`completedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `presales_task_requests_id` PRIMARY KEY(`id`),
	CONSTRAINT `presales_task_requests_key_uq` UNIQUE(`keyHash`)
);
--> statement-breakpoint
ALTER TABLE `presales_task_requests` ADD CONSTRAINT `presales_task_request_credential_fk` FOREIGN KEY (`apiCredentialId`) REFERENCES `presales_api_credentials`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `presales_task_requests_credential_status_idx` ON `presales_task_requests` (`apiCredentialId`,`status`);
