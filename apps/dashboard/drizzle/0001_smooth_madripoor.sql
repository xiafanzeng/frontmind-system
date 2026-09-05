CREATE TABLE `api_credentials` (
	`id` varchar(36) NOT NULL,
	`userId` int NOT NULL,
	`version` int NOT NULL,
	`encryptionVersion` int NOT NULL DEFAULT 1,
	`encryptedKey` text NOT NULL,
	`encryptionIv` varchar(32) NOT NULL,
	`encryptionAuthTag` varchar(32) NOT NULL,
	`fingerprint` varchar(32) NOT NULL,
	`status` enum('active','retired','deleted') NOT NULL DEFAULT 'active',
	`validationStatus` enum('unverified','verified','invalid') NOT NULL DEFAULT 'unverified',
	`verifiedAt` timestamp,
	`retiredAt` timestamp,
	`deletedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `api_credentials_id` PRIMARY KEY(`id`),
	CONSTRAINT `api_credentials_user_version_uq` UNIQUE(`userId`,`version`)
);
--> statement-breakpoint
CREATE TABLE `attachments` (
	`id` varchar(191) NOT NULL,
	`userId` int NOT NULL,
	`conversationId` varchar(191) NOT NULL,
	`messageId` varchar(191) NOT NULL,
	`apiCredentialId` varchar(36),
	`kind` enum('file','image') NOT NULL DEFAULT 'file',
	`fileName` varchar(512) NOT NULL,
	`mimeType` varchar(255),
	`sizeBytes` int unsigned,
	`upstreamFileId` varchar(255),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`deletedAt` timestamp,
	CONSTRAINT `attachments_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `conversation_turns` (
	`id` varchar(36) NOT NULL,
	`conversationId` varchar(191) NOT NULL,
	`userId` int NOT NULL,
	`apiCredentialId` varchar(36),
	`clientRequestId` varchar(128) NOT NULL,
	`model` varchar(128),
	`status` enum('queued','running','completed','failed','cancelled') NOT NULL DEFAULT 'queued',
	`upstreamTaskId` varchar(255),
	`errorCode` varchar(128),
	`errorMessage` text,
	`startedAt` timestamp,
	`completedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `conversation_turns_id` PRIMARY KEY(`id`),
	CONSTRAINT `conversation_turns_client_request_uq` UNIQUE(`conversationId`,`clientRequestId`)
);
--> statement-breakpoint
CREATE TABLE `conversations` (
	`id` varchar(191) NOT NULL,
	`userId` int NOT NULL,
	`apiCredentialId` varchar(36),
	`title` varchar(255) NOT NULL,
	`status` enum('idle','running','pending','completed','error','failed','archived') NOT NULL DEFAULT 'idle',
	`upstreamTaskId` varchar(255),
	`previousResponseId` varchar(255),
	`taskUrl` text,
	`lastKnownOutputLength` int NOT NULL DEFAULT 0,
	`deletedMessageIds` json NOT NULL DEFAULT ('[]'),
	`version` int NOT NULL DEFAULT 1,
	`startedAt` timestamp,
	`completedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	`deletedAt` timestamp,
	CONSTRAINT `conversations_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `messages` (
	`id` varchar(191) NOT NULL,
	`conversationId` varchar(191) NOT NULL,
	`turnId` varchar(36),
	`userId` int NOT NULL,
	`role` enum('user','assistant','system','tool') NOT NULL,
	`content` longtext NOT NULL,
	`sequence` int NOT NULL,
	`metadata` json,
	`sentAt` timestamp NOT NULL DEFAULT (now()),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	`deletedAt` timestamp,
	CONSTRAINT `messages_id` PRIMARY KEY(`id`),
	CONSTRAINT `messages_conversation_sequence_uq` UNIQUE(`conversationId`,`sequence`)
);
--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` varchar(36) NOT NULL,
	`userId` int NOT NULL,
	`tokenHash` varchar(64) NOT NULL,
	`expiresAt` timestamp NOT NULL,
	`lastSeenAt` timestamp NOT NULL DEFAULT (now()),
	`revokedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `sessions_id` PRIMARY KEY(`id`),
	CONSTRAINT `sessions_tokenHash_unique` UNIQUE(`tokenHash`)
);
--> statement-breakpoint
CREATE TABLE `upstream_resources` (
	`id` varchar(36) NOT NULL,
	`userId` int NOT NULL,
	`apiCredentialId` varchar(36) NOT NULL,
	`kind` enum('task','file') NOT NULL,
	`upstreamId` varchar(255) NOT NULL,
	`conversationId` varchar(191),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `upstream_resources_id` PRIMARY KEY(`id`),
	CONSTRAINT `upstream_resources_kind_id_uq` UNIQUE(`kind`,`upstreamId`)
);
--> statement-breakpoint
ALTER TABLE `users` MODIFY COLUMN `openId` varchar(64);--> statement-breakpoint
ALTER TABLE `users` MODIFY COLUMN `lastSignedIn` timestamp;--> statement-breakpoint
ALTER TABLE `users` ADD `username` varchar(64);--> statement-breakpoint
ALTER TABLE `users` ADD `passwordHash` varchar(255);--> statement-breakpoint
ALTER TABLE `users` ADD `displayName` varchar(128);--> statement-breakpoint
ALTER TABLE `users` ADD `isActive` boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `passwordChangedAt` timestamp;--> statement-breakpoint
ALTER TABLE `users` ADD CONSTRAINT `users_username_unique` UNIQUE(`username`);--> statement-breakpoint
ALTER TABLE `api_credentials` ADD CONSTRAINT `api_credentials_userId_users_id_fk` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `attachments` ADD CONSTRAINT `attachments_userId_users_id_fk` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `attachments` ADD CONSTRAINT `attachments_conversationId_conversations_id_fk` FOREIGN KEY (`conversationId`) REFERENCES `conversations`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `attachments` ADD CONSTRAINT `attachments_messageId_messages_id_fk` FOREIGN KEY (`messageId`) REFERENCES `messages`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `attachments` ADD CONSTRAINT `attachments_apiCredentialId_api_credentials_id_fk` FOREIGN KEY (`apiCredentialId`) REFERENCES `api_credentials`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `conversation_turns` ADD CONSTRAINT `conversation_turns_conversationId_conversations_id_fk` FOREIGN KEY (`conversationId`) REFERENCES `conversations`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `conversation_turns` ADD CONSTRAINT `conversation_turns_userId_users_id_fk` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `conversation_turns` ADD CONSTRAINT `conversation_turns_apiCredentialId_api_credentials_id_fk` FOREIGN KEY (`apiCredentialId`) REFERENCES `api_credentials`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `conversations` ADD CONSTRAINT `conversations_userId_users_id_fk` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `conversations` ADD CONSTRAINT `conversations_apiCredentialId_api_credentials_id_fk` FOREIGN KEY (`apiCredentialId`) REFERENCES `api_credentials`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `messages` ADD CONSTRAINT `messages_conversationId_conversations_id_fk` FOREIGN KEY (`conversationId`) REFERENCES `conversations`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `messages` ADD CONSTRAINT `messages_turnId_conversation_turns_id_fk` FOREIGN KEY (`turnId`) REFERENCES `conversation_turns`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `messages` ADD CONSTRAINT `messages_userId_users_id_fk` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `sessions` ADD CONSTRAINT `sessions_userId_users_id_fk` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `upstream_resources` ADD CONSTRAINT `upstream_resources_userId_users_id_fk` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `upstream_resources` ADD CONSTRAINT `upstream_resources_apiCredentialId_api_credentials_id_fk` FOREIGN KEY (`apiCredentialId`) REFERENCES `api_credentials`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `upstream_resources` ADD CONSTRAINT `upstream_resources_conversationId_conversations_id_fk` FOREIGN KEY (`conversationId`) REFERENCES `conversations`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `api_credentials_user_status_idx` ON `api_credentials` (`userId`,`status`);--> statement-breakpoint
CREATE INDEX `attachments_user_file_idx` ON `attachments` (`userId`,`upstreamFileId`);--> statement-breakpoint
CREATE INDEX `attachments_message_idx` ON `attachments` (`messageId`);--> statement-breakpoint
CREATE INDEX `conversation_turns_user_status_idx` ON `conversation_turns` (`userId`,`status`);--> statement-breakpoint
CREATE INDEX `conversation_turns_upstream_task_idx` ON `conversation_turns` (`upstreamTaskId`);--> statement-breakpoint
CREATE INDEX `conversations_user_updated_idx` ON `conversations` (`userId`,`updatedAt`);--> statement-breakpoint
CREATE INDEX `conversations_user_status_idx` ON `conversations` (`userId`,`status`);--> statement-breakpoint
CREATE INDEX `conversations_upstream_task_idx` ON `conversations` (`upstreamTaskId`);--> statement-breakpoint
CREATE INDEX `messages_user_conversation_idx` ON `messages` (`userId`,`conversationId`);--> statement-breakpoint
CREATE INDEX `messages_turn_idx` ON `messages` (`turnId`);--> statement-breakpoint
CREATE INDEX `sessions_user_expires_idx` ON `sessions` (`userId`,`expiresAt`);--> statement-breakpoint
CREATE INDEX `sessions_token_active_idx` ON `sessions` (`tokenHash`,`revokedAt`);--> statement-breakpoint
CREATE INDEX `upstream_resources_user_kind_id_idx` ON `upstream_resources` (`userId`,`kind`,`upstreamId`);--> statement-breakpoint
CREATE INDEX `users_active_role_idx` ON `users` (`isActive`,`role`);