CREATE TABLE `presales_api_credentials` (
	`id` varchar(36) NOT NULL,
	`slot` varchar(32) NOT NULL DEFAULT 'website',
	`version` int NOT NULL,
	`encryptionVersion` int NOT NULL DEFAULT 1,
	`encryptedKey` text NOT NULL,
	`encryptionIv` varchar(32) NOT NULL,
	`encryptionAuthTag` varchar(32) NOT NULL,
	`fingerprint` varchar(32) NOT NULL,
	`status` enum('active','retired','deleted') NOT NULL DEFAULT 'active',
	`validationStatus` enum('unverified','verified','invalid') NOT NULL DEFAULT 'unverified',
	`createdByUserId` int,
	`verifiedAt` timestamp,
	`retiredAt` timestamp,
	`deletedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `presales_api_credentials_id` PRIMARY KEY(`id`),
	CONSTRAINT `presales_api_credentials_slot_version_uq` UNIQUE(`slot`,`version`)
);
--> statement-breakpoint
CREATE TABLE `presales_upstream_resources` (
	`id` varchar(36) NOT NULL,
	`apiCredentialId` varchar(36) NOT NULL,
	`kind` enum('task','file') NOT NULL,
	`upstreamId` varchar(255) NOT NULL,
	`parentTaskId` varchar(255),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `presales_upstream_resources_id` PRIMARY KEY(`id`),
	CONSTRAINT `presales_upstream_resources_kind_id_uq` UNIQUE(`kind`,`upstreamId`)
);
--> statement-breakpoint
ALTER TABLE `presales_api_credentials` ADD CONSTRAINT `presales_api_credentials_createdByUserId_users_id_fk` FOREIGN KEY (`createdByUserId`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `presales_upstream_resources` ADD CONSTRAINT `presales_resources_credential_fk` FOREIGN KEY (`apiCredentialId`) REFERENCES `presales_api_credentials`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `presales_api_credentials_slot_status_idx` ON `presales_api_credentials` (`slot`,`status`);--> statement-breakpoint
CREATE INDEX `presales_upstream_resources_parent_task_idx` ON `presales_upstream_resources` (`parentTaskId`);
