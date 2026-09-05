CREATE TABLE `knowledge_import_receipts` (
	`id` varchar(36) NOT NULL,
	`userId` int NOT NULL,
	`source` enum('website','offline','admin') NOT NULL DEFAULT 'website',
	`projectId` varchar(80),
	`companyName` varchar(200),
	`taskId` varchar(255),
	`fileId` varchar(255),
	`outputItemId` varchar(255),
	`descriptorHash` varchar(64),
	`sourceReference` varchar(191),
	`idempotencyKeyHash` varchar(64) NOT NULL,
	`artifactHash` varchar(64) NOT NULL,
	`sourceFileName` varchar(512) NOT NULL,
	`status` enum('pending','processing','completed','failed') NOT NULL DEFAULT 'pending',
	`snapshotId` varchar(36),
	`attemptCount` int unsigned NOT NULL DEFAULT 0,
	`errorCode` varchar(128),
	`errorMessage` text,
	`revision` int unsigned NOT NULL DEFAULT 1,
	`completedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `knowledge_import_receipts_id` PRIMARY KEY(`id`),
	CONSTRAINT `knowledge_import_receipts_idempotencyKeyHash_unique` UNIQUE(`idempotencyKeyHash`),
	CONSTRAINT `knowledge_import_receipts_user_artifact_uq` UNIQUE(`userId`,`artifactHash`),
	CONSTRAINT `knowledge_import_receipts_project_descriptor_uq` UNIQUE(`projectId`,`taskId`,`outputItemId`,`descriptorHash`)
);
--> statement-breakpoint
CREATE TABLE `purchase_intents` (
	`id` varchar(36) NOT NULL,
	`userId` int NOT NULL,
	`sourceContractId` varchar(36),
	`resultingContractId` varchar(36),
	`targetPlanCode` enum('basic','advanced','luxury') NOT NULL,
	`kind` enum('new_purchase','repeat_basic','upgrade','renewal') NOT NULL,
	`status` enum('pending','consumed','cancelled') NOT NULL DEFAULT 'pending',
	`tokenHash` varchar(64) NOT NULL,
	`externalOrderId` varchar(128),
	`revision` int unsigned NOT NULL DEFAULT 1,
	`expiresAt` timestamp NOT NULL,
	`consumedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `purchase_intents_id` PRIMARY KEY(`id`),
	CONSTRAINT `purchase_intents_tokenHash_unique` UNIQUE(`tokenHash`)
);
--> statement-breakpoint
CREATE TABLE `service_contracts` (
	`id` varchar(36) NOT NULL,
	`userId` int NOT NULL,
	`planCode` enum('basic','advanced','luxury') NOT NULL,
	`planVersion` int unsigned NOT NULL DEFAULT 1,
	`status` enum('pending_confirmation','scheduled','active','suspended','cancelled','superseded') NOT NULL DEFAULT 'active',
	`startsAt` timestamp NOT NULL,
	`endsAt` timestamp NOT NULL,
	`source` enum('website','offline','admin') NOT NULL DEFAULT 'admin',
	`sourceReference` varchar(191),
	`revision` int unsigned NOT NULL DEFAULT 1,
	`createdByUserId` int,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `service_contracts_id` PRIMARY KEY(`id`),
	CONSTRAINT `service_contracts_user_revision_uq` UNIQUE(`userId`,`revision`)
);
--> statement-breakpoint
CREATE TABLE `service_quota_periods` (
	`id` varchar(36) NOT NULL,
	`contractId` varchar(36) NOT NULL,
	`userId` int NOT NULL,
	`ordinal` int unsigned NOT NULL,
	`startsAt` timestamp NOT NULL,
	`endsAt` timestamp NOT NULL,
	`industryLimit` int unsigned NOT NULL DEFAULT 0,
	`competitorComparisonLimit` int unsigned NOT NULL DEFAULT 0,
	`reputationLimit` int unsigned NOT NULL DEFAULT 0,
	`productScenarioLimit` int unsigned NOT NULL DEFAULT 0,
	`totalQuestionLimit` int unsigned NOT NULL DEFAULT 0,
	`revision` int unsigned NOT NULL DEFAULT 1,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `service_quota_periods_id` PRIMARY KEY(`id`),
	CONSTRAINT `service_quota_periods_contract_ordinal_uq` UNIQUE(`contractId`,`ordinal`)
);
--> statement-breakpoint
CREATE TABLE `workspace_questions` (
	`id` varchar(36) NOT NULL,
	`userId` int NOT NULL,
	`contractId` varchar(36) NOT NULL,
	`quotaPeriodId` varchar(36) NOT NULL,
	`externalQuestionId` varchar(191),
	`candidateKey` varchar(191),
	`category` enum('industry','competitor_comparison','reputation','product_scenario') NOT NULL,
	`question` text NOT NULL,
	`intent` text,
	`rationale` text,
	`evidence` json NOT NULL DEFAULT ('[]'),
	`risks` json NOT NULL DEFAULT ('[]'),
	`source` enum('model','website','offline','admin','user') NOT NULL DEFAULT 'model',
	`status` enum('candidate','selected','archived') NOT NULL DEFAULT 'candidate',
	`locked` boolean NOT NULL DEFAULT false,
	`sourceTaskId` varchar(255),
	`knowledgeSnapshotId` varchar(36),
	`ordinal` int unsigned NOT NULL DEFAULT 0,
	`revision` int unsigned NOT NULL DEFAULT 1,
	`selectedAt` timestamp,
	`archivedAt` timestamp,
	`createdByUserId` int,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `workspace_questions_id` PRIMARY KEY(`id`),
	CONSTRAINT `workspace_questions_generation_key_uq` UNIQUE(`quotaPeriodId`,`sourceTaskId`,`candidateKey`)
);
--> statement-breakpoint
ALTER TABLE `website_user_provisions` MODIFY COLUMN `contractSignedAt` timestamp;--> statement-breakpoint
ALTER TABLE `website_user_provisions` MODIFY COLUMN `signatoryId` varchar(128);--> statement-breakpoint
ALTER TABLE `website_user_provisions` MODIFY COLUMN `status` enum('pending_confirmation','pending','completed','failed') NOT NULL DEFAULT 'pending';--> statement-breakpoint
ALTER TABLE `presales_task_requests` ADD `projectId` varchar(80);--> statement-breakpoint
ALTER TABLE `website_user_provisions` ADD `schemaVersion` int unsigned DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `website_user_provisions` ADD `planCode` enum('basic','advanced','luxury');--> statement-breakpoint
ALTER TABLE `website_user_provisions` ADD `contractEvidence` json;--> statement-breakpoint
ALTER TABLE `website_user_provisions` ADD `contractConfirmationStatus` enum('confirmed','pending_confirmation','rejected') DEFAULT 'confirmed' NOT NULL;--> statement-breakpoint
ALTER TABLE `website_user_provisions` ADD `accountMode` enum('create','bind_existing') DEFAULT 'create' NOT NULL;--> statement-breakpoint
ALTER TABLE `website_user_provisions` ADD `purchaseIntentId` varchar(36);--> statement-breakpoint
ALTER TABLE `website_user_provisions` ADD `accountSetupTokenHash` varchar(64);--> statement-breakpoint
ALTER TABLE `website_user_provisions` ADD `accountSetupTokenExpiresAt` timestamp;--> statement-breakpoint
ALTER TABLE `website_user_provisions` ADD `accountSetupTokenConsumedAt` timestamp;--> statement-breakpoint
ALTER TABLE `website_user_provisions` ADD `lastError` text;--> statement-breakpoint
ALTER TABLE `website_user_provisions` ADD CONSTRAINT `website_user_provisions_accountSetupTokenHash_unique` UNIQUE(`accountSetupTokenHash`);--> statement-breakpoint
ALTER TABLE `knowledge_import_receipts` ADD CONSTRAINT `knowledge_import_receipts_userId_users_id_fk` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `knowledge_import_receipts` ADD CONSTRAINT `knowledge_import_receipts_snapshot_fk` FOREIGN KEY (`snapshotId`) REFERENCES `knowledge_base_snapshots`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `purchase_intents` ADD CONSTRAINT `purchase_intents_userId_users_id_fk` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `purchase_intents` ADD CONSTRAINT `purchase_intents_sourceContractId_service_contracts_id_fk` FOREIGN KEY (`sourceContractId`) REFERENCES `service_contracts`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `purchase_intents` ADD CONSTRAINT `purchase_intents_resultingContractId_service_contracts_id_fk` FOREIGN KEY (`resultingContractId`) REFERENCES `service_contracts`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `service_contracts` ADD CONSTRAINT `service_contracts_userId_users_id_fk` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `service_contracts` ADD CONSTRAINT `service_contracts_createdByUserId_users_id_fk` FOREIGN KEY (`createdByUserId`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `service_quota_periods` ADD CONSTRAINT `service_quota_periods_contractId_service_contracts_id_fk` FOREIGN KEY (`contractId`) REFERENCES `service_contracts`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `service_quota_periods` ADD CONSTRAINT `service_quota_periods_userId_users_id_fk` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `workspace_questions` ADD CONSTRAINT `workspace_questions_userId_users_id_fk` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `workspace_questions` ADD CONSTRAINT `workspace_questions_contractId_service_contracts_id_fk` FOREIGN KEY (`contractId`) REFERENCES `service_contracts`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `workspace_questions` ADD CONSTRAINT `workspace_questions_quotaPeriodId_service_quota_periods_id_fk` FOREIGN KEY (`quotaPeriodId`) REFERENCES `service_quota_periods`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `workspace_questions` ADD CONSTRAINT `workspace_questions_knowledge_snapshot_fk` FOREIGN KEY (`knowledgeSnapshotId`) REFERENCES `knowledge_base_snapshots`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `workspace_questions` ADD CONSTRAINT `workspace_questions_createdByUserId_users_id_fk` FOREIGN KEY (`createdByUserId`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `knowledge_import_receipts_user_status_idx` ON `knowledge_import_receipts` (`userId`,`status`);--> statement-breakpoint
CREATE INDEX `knowledge_import_receipts_project_task_idx` ON `knowledge_import_receipts` (`projectId`,`taskId`);--> statement-breakpoint
CREATE INDEX `purchase_intents_user_status_expires_idx` ON `purchase_intents` (`userId`,`status`,`expiresAt`);--> statement-breakpoint
CREATE INDEX `purchase_intents_external_order_idx` ON `purchase_intents` (`externalOrderId`);--> statement-breakpoint
CREATE INDEX `service_contracts_user_status_ends_idx` ON `service_contracts` (`userId`,`status`,`endsAt`);--> statement-breakpoint
CREATE INDEX `service_contracts_source_reference_idx` ON `service_contracts` (`source`,`sourceReference`);--> statement-breakpoint
CREATE INDEX `service_quota_periods_user_window_idx` ON `service_quota_periods` (`userId`,`startsAt`,`endsAt`);--> statement-breakpoint
CREATE INDEX `workspace_questions_user_period_status_idx` ON `workspace_questions` (`userId`,`quotaPeriodId`,`status`);--> statement-breakpoint
CREATE INDEX `workspace_questions_user_category_status_idx` ON `workspace_questions` (`userId`,`category`,`status`);--> statement-breakpoint
CREATE INDEX `workspace_questions_external_idx` ON `workspace_questions` (`userId`,`externalQuestionId`);--> statement-breakpoint
ALTER TABLE `website_user_provisions` ADD CONSTRAINT `website_user_provisions_purchaseIntentId_purchase_intents_id_fk` FOREIGN KEY (`purchaseIntentId`) REFERENCES `purchase_intents`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `presales_task_requests_project_idx` ON `presales_task_requests` (`projectId`);--> statement-breakpoint
CREATE INDEX `website_user_provisions_purchase_intent_idx` ON `website_user_provisions` (`purchaseIntentId`);
