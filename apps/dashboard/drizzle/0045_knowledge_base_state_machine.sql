ALTER TABLE `conversation_turns` ADD `buildId` varchar(36);--> statement-breakpoint
ALTER TABLE `conversation_turns` ADD `buildGeneration` int unsigned;--> statement-breakpoint
ALTER TABLE `conversation_turns` ADD `operationKey` varchar(128);--> statement-breakpoint
ALTER TABLE `conversation_turns` ADD `operationType` varchar(32);--> statement-breakpoint
ALTER TABLE `conversation_turns` ADD `expectedRevision` int;--> statement-breakpoint
ALTER TABLE `conversation_turns` ADD `expectedLeafId` varchar(191);--> statement-breakpoint
ALTER TABLE `conversation_turns` ADD `requestHash` varchar(64);--> statement-breakpoint
ALTER TABLE `conversation_turns` ADD `upstreamIdempotencyKeyHash` varchar(64);--> statement-breakpoint
ALTER TABLE `conversation_turns` ADD `attachmentFileIds` json DEFAULT ('[]') NOT NULL;--> statement-breakpoint
ALTER TABLE `conversation_turns` ADD `metadata` json DEFAULT ('{}') NOT NULL;--> statement-breakpoint
ALTER TABLE `conversation_turns` ADD `leaseExpiresAt` timestamp;--> statement-breakpoint
ALTER TABLE `knowledge_base_build_nodes` ADD `sourceTurnId` varchar(36);--> statement-breakpoint
ALTER TABLE `knowledge_base_build_nodes` ADD `presentationKey` varchar(191);--> statement-breakpoint
ALTER TABLE `knowledge_base_build_nodes` ADD `contentSha256` varchar(64);--> statement-breakpoint
ALTER TABLE `knowledge_base_builds` ADD `generation` int unsigned DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `knowledge_base_builds` ADD `stateEpoch` int unsigned DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `knowledge_base_builds` ADD `activeTurnId` varchar(36);--> statement-breakpoint
ALTER TABLE `knowledge_base_builds` ADD `recoveryLeaseOwnerHash` varchar(64);--> statement-breakpoint
ALTER TABLE `knowledge_base_builds` ADD `recoveryLeaseExpiresAt` timestamp;--> statement-breakpoint
ALTER TABLE `knowledge_base_builds` ADD `lastAppliedOperationKey` varchar(128);--> statement-breakpoint
ALTER TABLE `knowledge_base_builds` ADD `currentPresentationKey` varchar(191);--> statement-breakpoint
ALTER TABLE `knowledge_base_builds` ADD `logoStorageKey` varchar(1024);--> statement-breakpoint
ALTER TABLE `knowledge_base_builds` ADD `logoSha256` varchar(64);--> statement-breakpoint
ALTER TABLE `knowledge_base_builds` ADD `logoBytes` int unsigned;--> statement-breakpoint
ALTER TABLE `knowledge_base_builds` ADD `logoFilename` varchar(512);--> statement-breakpoint
ALTER TABLE `knowledge_base_builds` ADD `logoMimeType` varchar(255);--> statement-breakpoint
ALTER TABLE `knowledge_base_builds` ADD `packageStorageKey` varchar(1024);--> statement-breakpoint
ALTER TABLE `knowledge_base_builds` ADD `packageArchiveSha256` varchar(64);--> statement-breakpoint
ALTER TABLE `knowledge_base_builds` ADD `packageSizeBytes` int unsigned;--> statement-breakpoint
ALTER TABLE `knowledge_base_builds` ADD `protocolErrorCode` varchar(128);--> statement-breakpoint
ALTER TABLE `conversation_turns` ADD CONSTRAINT `conversation_turns_operation_key_uq` UNIQUE(`operationKey`);--> statement-breakpoint
ALTER TABLE `conversation_turns` ADD CONSTRAINT `conversation_turns_buildId_knowledge_base_builds_id_fk` FOREIGN KEY (`buildId`) REFERENCES `knowledge_base_builds`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `conversation_turns_build_generation_idx` ON `conversation_turns` (`buildId`,`buildGeneration`);--> statement-breakpoint
CREATE INDEX `conversation_turns_lease_idx` ON `conversation_turns` (`status`,`leaseExpiresAt`);--> statement-breakpoint
CREATE INDEX `knowledge_base_build_nodes_source_turn_idx` ON `knowledge_base_build_nodes` (`sourceTurnId`);--> statement-breakpoint
CREATE INDEX `knowledge_base_builds_active_turn_idx` ON `knowledge_base_builds` (`activeTurnId`);
--> statement-breakpoint
CREATE INDEX `knowledge_base_builds_recovery_lease_idx` ON `knowledge_base_builds` (`status`,`recoveryLeaseExpiresAt`);
