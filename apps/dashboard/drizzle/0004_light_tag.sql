CREATE TABLE `presales_output_urls` (
	`id` varchar(36) NOT NULL,
	`apiCredentialId` varchar(36) NOT NULL,
	`parentTaskId` varchar(255) NOT NULL,
	`urlHash` varchar(64) NOT NULL,
	`hostname` varchar(255) NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `presales_output_urls_id` PRIMARY KEY(`id`),
	CONSTRAINT `presales_output_urls_task_hash_uq` UNIQUE(`parentTaskId`,`urlHash`)
);
--> statement-breakpoint
ALTER TABLE `presales_output_urls` ADD CONSTRAINT `presales_output_credential_fk` FOREIGN KEY (`apiCredentialId`) REFERENCES `presales_api_credentials`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `presales_output_urls_credential_task_idx` ON `presales_output_urls` (`apiCredentialId`,`parentTaskId`);
