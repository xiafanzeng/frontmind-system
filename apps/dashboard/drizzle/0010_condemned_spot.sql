CREATE TABLE `knowledge_base_build_nodes` (
	`id` varchar(36) NOT NULL,
	`buildId` varchar(36) NOT NULL,
	`leafId` varchar(191) NOT NULL,
	`branchId` varchar(128) NOT NULL,
	`branchTitle` varchar(255) NOT NULL,
	`title` varchar(512) NOT NULL,
	`ordinal` int NOT NULL,
	`status` enum('pending','current','confirmed','direct_prefilled','needs_verification') NOT NULL DEFAULT 'pending',
	`transitionReason` text,
	`confirmedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `knowledge_base_build_nodes_id` PRIMARY KEY(`id`),
	CONSTRAINT `knowledge_base_build_nodes_leaf_uq` UNIQUE(`buildId`,`leafId`),
	CONSTRAINT `knowledge_base_build_nodes_ordinal_uq` UNIQUE(`buildId`,`ordinal`)
);
--> statement-breakpoint
CREATE TABLE `knowledge_base_builds` (
	`id` varchar(36) NOT NULL,
	`userId` int NOT NULL,
	`conversationId` varchar(191) NOT NULL,
	`companyName` varchar(255) NOT NULL,
	`companyWebsite` text,
	`upstreamTaskId` varchar(255),
	`status` enum('researching','confirming','ready_to_publish','published','protocol_error','failed') NOT NULL DEFAULT 'researching',
	`revision` int NOT NULL DEFAULT 0,
	`currentLeafId` varchar(191),
	`totalNodeCount` int NOT NULL DEFAULT 0,
	`confirmedCount` int NOT NULL DEFAULT 0,
	`directPrefilledCount` int NOT NULL DEFAULT 0,
	`needsVerificationCount` int NOT NULL DEFAULT 0,
	`lastReconciledHash` varchar(64),
	`protocolError` text,
	`publishedSnapshotId` varchar(36),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	`completedAt` timestamp,
	`publishedAt` timestamp,
	CONSTRAINT `knowledge_base_builds_id` PRIMARY KEY(`id`),
	CONSTRAINT `knowledge_base_builds_user_conversation_uq` UNIQUE(`userId`,`conversationId`)
);
--> statement-breakpoint
ALTER TABLE `knowledge_base_build_nodes` ADD CONSTRAINT `knowledge_base_build_nodes_buildId_knowledge_base_builds_id_fk` FOREIGN KEY (`buildId`) REFERENCES `knowledge_base_builds`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `knowledge_base_builds` ADD CONSTRAINT `knowledge_base_builds_userId_users_id_fk` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `knowledge_base_builds` ADD CONSTRAINT `kb_builds_published_snapshot_fk` FOREIGN KEY (`publishedSnapshotId`) REFERENCES `knowledge_base_snapshots`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `knowledge_base_build_nodes_status_idx` ON `knowledge_base_build_nodes` (`buildId`,`status`);--> statement-breakpoint
CREATE INDEX `knowledge_base_builds_user_status_idx` ON `knowledge_base_builds` (`userId`,`status`);--> statement-breakpoint
CREATE INDEX `knowledge_base_builds_task_idx` ON `knowledge_base_builds` (`upstreamTaskId`);
