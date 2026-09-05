CREATE TABLE `knowledge_base_conversation_retention_tombstones` (
	`id` varchar(36) NOT NULL,
	`userId` int NOT NULL,
	`publicConversationId` varchar(191) NOT NULL,
	`resetAt` timestamp NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `knowledge_base_conversation_retention_tombstones_id` PRIMARY KEY(`id`),
	CONSTRAINT `kb_retention_tombstones_user_fk` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action,
	CONSTRAINT `kb_retention_tombstones_user_conversation_uq` UNIQUE(`userId`,`publicConversationId`)
);
--> statement-breakpoint
ALTER TABLE `knowledge_base_reset_cleanup_jobs` DROP FOREIGN KEY `kb_reset_cleanup_request_fk`;
--> statement-breakpoint
ALTER TABLE `knowledge_base_reset_cleanup_jobs` MODIFY COLUMN `resetRequestId` varchar(36);--> statement-breakpoint
ALTER TABLE `knowledge_base_reset_cleanup_jobs` ADD CONSTRAINT `kb_reset_cleanup_request_fk` FOREIGN KEY (`resetRequestId`) REFERENCES `knowledge_base_reset_requests`(`id`) ON DELETE set null ON UPDATE no action;
