DROP INDEX `response_logic_entries_conversation_idx` ON `response_logic_entries`;--> statement-breakpoint
ALTER TABLE `knowledge_base_builds` ADD `lastTurnUserText` longtext;--> statement-breakpoint
ALTER TABLE `knowledge_base_builds` ADD `lastTurnAttachmentCount` int DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `knowledge_base_builds` ADD `packageRevision` int;--> statement-breakpoint
ALTER TABLE `knowledge_base_builds` ADD `packageTaskId` varchar(255);--> statement-breakpoint
ALTER TABLE `knowledge_base_builds` ADD `packageOutputItemId` varchar(255);--> statement-breakpoint
ALTER TABLE `knowledge_base_builds` ADD `packageFileId` varchar(255);--> statement-breakpoint
ALTER TABLE `knowledge_base_builds` ADD `packageFilename` varchar(512);--> statement-breakpoint
ALTER TABLE `knowledge_base_builds` ADD `packageDescriptorHash` varchar(64);--> statement-breakpoint
ALTER TABLE `knowledge_base_snapshots` ADD `sourceBuildId` varchar(36);--> statement-breakpoint
ALTER TABLE `knowledge_base_snapshots` ADD `sourceBuildRevision` int;--> statement-breakpoint
ALTER TABLE `knowledge_base_snapshots` ADD `sourceTaskId` varchar(255);--> statement-breakpoint
ALTER TABLE `knowledge_base_snapshots` ADD `sourceArtifactHash` varchar(64);--> statement-breakpoint
ALTER TABLE `knowledge_base_snapshots` ADD `archiveHash` varchar(64);--> statement-breakpoint
ALTER TABLE `knowledge_base_snapshots` ADD CONSTRAINT `knowledge_base_snapshots_source_artifact_uq` UNIQUE(`userId`,`sourceBuildId`,`sourceBuildRevision`,`sourceArtifactHash`);--> statement-breakpoint
ALTER TABLE `response_logic_entries` ADD CONSTRAINT `response_logic_entries_user_conversation_uq` UNIQUE(`userId`,`conversationId`);