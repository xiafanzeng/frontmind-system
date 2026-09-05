CREATE TABLE `response_logic_entries` (
	`id` varchar(36) NOT NULL,
	`userId` int NOT NULL,
	`questionId` varchar(191) NOT NULL,
	`groupId` varchar(128) NOT NULL,
	`groupTitle` varchar(255) NOT NULL,
	`question` text NOT NULL,
	`intent` text NOT NULL,
	`summary` text NOT NULL,
	`conversationId` varchar(191),
	`lastTaskId` varchar(255),
	`skillName` varchar(128) NOT NULL DEFAULT 'response-logic-builder',
	`skillVersion` varchar(64) NOT NULL DEFAULT '1',
	`skillContentHash` varchar(64),
	`draft` json NOT NULL,
	`confirmed` json,
	`version` int NOT NULL DEFAULT 0,
	`status` enum('draft','confirmed') NOT NULL DEFAULT 'draft',
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `response_logic_entries_id` PRIMARY KEY(`id`),
	CONSTRAINT `response_logic_entries_user_question_uq` UNIQUE(`userId`,`questionId`)
);
--> statement-breakpoint
ALTER TABLE `knowledge_base_build_nodes` ADD `contentMarkdown` longtext;--> statement-breakpoint
ALTER TABLE `knowledge_base_build_nodes` ADD `lastUserInput` longtext;--> statement-breakpoint
ALTER TABLE `knowledge_base_build_nodes` ADD `sourceUrls` json DEFAULT ('[]') NOT NULL;--> statement-breakpoint
ALTER TABLE `knowledge_base_build_nodes` ADD `imageUrls` json DEFAULT ('[]') NOT NULL;--> statement-breakpoint
ALTER TABLE `knowledge_base_build_nodes` ADD `lastTaskId` varchar(255);--> statement-breakpoint
ALTER TABLE `knowledge_base_build_nodes` ADD `lastResponseAt` timestamp;--> statement-breakpoint
ALTER TABLE `knowledge_base_builds` ADD `skillName` varchar(128) DEFAULT 'socratic-kb-builder' NOT NULL;--> statement-breakpoint
ALTER TABLE `knowledge_base_builds` ADD `skillVersion` varchar(64) DEFAULT '1' NOT NULL;--> statement-breakpoint
ALTER TABLE `knowledge_base_builds` ADD `skillContentHash` varchar(64);--> statement-breakpoint
ALTER TABLE `knowledge_base_builds` ADD `lastOutputLength` int DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `knowledge_base_builds` ADD `lastOutputItemIds` json DEFAULT ('[]') NOT NULL;--> statement-breakpoint
ALTER TABLE `response_logic_entries` ADD CONSTRAINT `response_logic_entries_userId_users_id_fk` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `response_logic_entries_user_status_idx` ON `response_logic_entries` (`userId`,`status`);--> statement-breakpoint
CREATE INDEX `response_logic_entries_conversation_idx` ON `response_logic_entries` (`userId`,`conversationId`);