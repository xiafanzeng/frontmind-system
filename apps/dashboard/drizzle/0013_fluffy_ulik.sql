CREATE TABLE `monitoring_batches` (
	`id` varchar(36) NOT NULL,
	`userId` int NOT NULL,
	`batchKey` varchar(191) NOT NULL,
	`sourceName` varchar(512) NOT NULL,
	`collectedAt` timestamp NOT NULL,
	`sampleCount` int unsigned NOT NULL DEFAULT 0,
	`citationCount` int unsigned NOT NULL DEFAULT 0,
	`revision` int unsigned NOT NULL DEFAULT 1,
	`importedByUserId` int,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `monitoring_batches_id` PRIMARY KEY(`id`),
	CONSTRAINT `monitoring_batches_user_key_uq` UNIQUE(`userId`,`batchKey`)
);
--> statement-breakpoint
CREATE TABLE `monitoring_citation_records` (
	`id` varchar(36) NOT NULL,
	`userId` int NOT NULL,
	`batchId` varchar(36) NOT NULL,
	`sampleId` varchar(36),
	`sourceRecordId` varchar(191) NOT NULL,
	`questionId` varchar(191) NOT NULL,
	`question` text NOT NULL,
	`model` varchar(128) NOT NULL,
	`title` text NOT NULL,
	`url` text NOT NULL,
	`media` varchar(255) NOT NULL,
	`domain` varchar(255) NOT NULL,
	`publishedAt` timestamp,
	`collectedAt` timestamp NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `monitoring_citation_records_id` PRIMARY KEY(`id`),
	CONSTRAINT `monitoring_citations_user_batch_source_uq` UNIQUE(`userId`,`batchId`,`sourceRecordId`)
);
--> statement-breakpoint
CREATE TABLE `monitoring_samples` (
	`id` varchar(36) NOT NULL,
	`userId` int NOT NULL,
	`batchId` varchar(36) NOT NULL,
	`sourceRecordId` varchar(191) NOT NULL,
	`questionId` varchar(191) NOT NULL,
	`question` text NOT NULL,
	`platform` varchar(128) NOT NULL,
	`answerNo` int unsigned NOT NULL DEFAULT 1,
	`content` longtext NOT NULL,
	`citationCount` int unsigned NOT NULL DEFAULT 0,
	`monitorRank` int unsigned,
	`screenshotUrl` text,
	`collectedAt` timestamp NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `monitoring_samples_id` PRIMARY KEY(`id`),
	CONSTRAINT `monitoring_samples_user_batch_source_uq` UNIQUE(`userId`,`batchId`,`sourceRecordId`)
);
--> statement-breakpoint
CREATE TABLE `website_user_provisions` (
	`id` varchar(36) NOT NULL,
	`idempotencyKeyHash` varchar(64) NOT NULL,
	`requestHash` varchar(64) NOT NULL,
	`projectId` varchar(80) NOT NULL,
	`companyName` varchar(200) NOT NULL,
	`orderId` varchar(64) NOT NULL,
	`tradeNo` varchar(128) NOT NULL,
	`amountFen` int unsigned NOT NULL,
	`paidAt` timestamp NOT NULL,
	`serviceCategory` enum('product_scenario','reputation','competitor_comparison') NOT NULL,
	`questionId` varchar(80) NOT NULL,
	`question` text NOT NULL,
	`contractId` varchar(128) NOT NULL,
	`contractTemplateVersion` varchar(64) NOT NULL,
	`contractDocumentSha256` varchar(64) NOT NULL,
	`contractSignedAt` timestamp NOT NULL,
	`signatoryId` varchar(128) NOT NULL,
	`requestedUsername` varchar(64) NOT NULL,
	`requestedDisplayName` varchar(128) NOT NULL,
	`userId` int,
	`status` enum('pending','completed') NOT NULL DEFAULT 'pending',
	`completedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `website_user_provisions_id` PRIMARY KEY(`id`),
	CONSTRAINT `website_user_provisions_idempotencyKeyHash_unique` UNIQUE(`idempotencyKeyHash`),
	CONSTRAINT `website_user_provisions_orderId_unique` UNIQUE(`orderId`),
	CONSTRAINT `website_user_provisions_tradeNo_unique` UNIQUE(`tradeNo`),
	CONSTRAINT `website_user_provisions_contractId_unique` UNIQUE(`contractId`)
);
--> statement-breakpoint
ALTER TABLE `monitoring_batches` ADD CONSTRAINT `monitoring_batches_userId_users_id_fk` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `monitoring_batches` ADD CONSTRAINT `monitoring_batches_importedByUserId_users_id_fk` FOREIGN KEY (`importedByUserId`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `monitoring_citation_records` ADD CONSTRAINT `monitoring_citation_records_userId_users_id_fk` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `monitoring_citation_records` ADD CONSTRAINT `monitoring_citation_records_batchId_monitoring_batches_id_fk` FOREIGN KEY (`batchId`) REFERENCES `monitoring_batches`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `monitoring_citation_records` ADD CONSTRAINT `monitoring_citation_records_sampleId_monitoring_samples_id_fk` FOREIGN KEY (`sampleId`) REFERENCES `monitoring_samples`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `monitoring_samples` ADD CONSTRAINT `monitoring_samples_userId_users_id_fk` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `monitoring_samples` ADD CONSTRAINT `monitoring_samples_batchId_monitoring_batches_id_fk` FOREIGN KEY (`batchId`) REFERENCES `monitoring_batches`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `website_user_provisions` ADD CONSTRAINT `website_user_provisions_userId_users_id_fk` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `monitoring_batches_user_collected_idx` ON `monitoring_batches` (`userId`,`collectedAt`);--> statement-breakpoint
CREATE INDEX `monitoring_citations_user_question_collected_idx` ON `monitoring_citation_records` (`userId`,`questionId`,`collectedAt`);--> statement-breakpoint
CREATE INDEX `monitoring_citations_user_batch_idx` ON `monitoring_citation_records` (`userId`,`batchId`);--> statement-breakpoint
CREATE INDEX `monitoring_citations_user_model_idx` ON `monitoring_citation_records` (`userId`,`model`);--> statement-breakpoint
CREATE INDEX `monitoring_citations_user_media_idx` ON `monitoring_citation_records` (`userId`,`media`);--> statement-breakpoint
CREATE INDEX `monitoring_citations_user_domain_idx` ON `monitoring_citation_records` (`userId`,`domain`);--> statement-breakpoint
CREATE INDEX `monitoring_citations_sample_idx` ON `monitoring_citation_records` (`sampleId`);--> statement-breakpoint
CREATE INDEX `monitoring_samples_user_question_collected_idx` ON `monitoring_samples` (`userId`,`questionId`,`collectedAt`);--> statement-breakpoint
CREATE INDEX `monitoring_samples_user_batch_idx` ON `monitoring_samples` (`userId`,`batchId`);--> statement-breakpoint
CREATE INDEX `monitoring_samples_user_platform_idx` ON `monitoring_samples` (`userId`,`platform`);--> statement-breakpoint
CREATE INDEX `website_user_provisions_project_idx` ON `website_user_provisions` (`projectId`);--> statement-breakpoint
CREATE INDEX `website_user_provisions_user_idx` ON `website_user_provisions` (`userId`);--> statement-breakpoint
CREATE INDEX `website_user_provisions_status_idx` ON `website_user_provisions` (`status`);