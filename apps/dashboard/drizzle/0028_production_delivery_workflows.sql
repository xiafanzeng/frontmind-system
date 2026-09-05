ALTER TABLE `delivery_tickets` ADD `preferredMedia` varchar(32);--> statement-breakpoint
ALTER TABLE `delivery_tickets` ADD `icpProvince` varchar(64);--> statement-breakpoint
ALTER TABLE `delivery_tickets` ADD `icpDeclarations` json;--> statement-breakpoint
ALTER TABLE `delivery_tickets` ADD `publicSummary` text;--> statement-breakpoint
ALTER TABLE `delivery_tickets` ADD `deliveryLinks` json NOT NULL DEFAULT ('[]');--> statement-breakpoint
CREATE TABLE `icp_sensitive_materials` (
	`id` varchar(36) NOT NULL,
	`workspaceUserId` int NOT NULL,
	`ownerUserId` int NOT NULL,
	`storageKey` varchar(255) NOT NULL,
	`encryptionVersion` int unsigned NOT NULL DEFAULT 1,
	`encryptionIv` varchar(32) NOT NULL,
	`encryptionAuthTag` varchar(32) NOT NULL,
	`filename` varchar(512) NOT NULL,
	`mimeType` varchar(255),
	`sizeBytes` int unsigned NOT NULL,
	`sha256` varchar(64) NOT NULL,
	`category` enum('business_license','subject_responsible_person_id','website_responsible_person_id','authorization_letter','pre_approval_or_industry_qualification','enterprise_name_change_proof','other_provincial_material') NOT NULL,
	`status` enum('active','replaced','withdrawn','expired') NOT NULL DEFAULT 'active',
	`replacedByMaterialId` varchar(36),
	`retentionUntil` timestamp NOT NULL,
	`withdrawnAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `icp_sensitive_materials_id` PRIMARY KEY(`id`),
	CONSTRAINT `icp_sensitive_materials_storageKey_unique` UNIQUE(`storageKey`)
);
--> statement-breakpoint
ALTER TABLE `delivery_ticket_attachments` MODIFY COLUMN `upstreamFileId` varchar(255);--> statement-breakpoint
ALTER TABLE `delivery_ticket_attachments` ADD `protectedMaterialId` varchar(36);--> statement-breakpoint
ALTER TABLE `delivery_ticket_attachments` ADD `sensitivity` enum('standard','icp_sensitive') NOT NULL DEFAULT 'standard';--> statement-breakpoint
ALTER TABLE `workspace_site_profiles` MODIFY COLUMN `domain` varchar(255);--> statement-breakpoint
ALTER TABLE `workspace_site_profiles` ADD `domainStatus` enum('not_started','pending','completed') NOT NULL DEFAULT 'not_started';--> statement-breakpoint
ALTER TABLE `workspace_site_profiles` ADD `domainVerifiedAt` timestamp;--> statement-breakpoint
ALTER TABLE `workspace_site_profiles` ADD `icpProvince` varchar(64);--> statement-breakpoint
ALTER TABLE `workspace_site_profiles` ADD `icpVerifiedAt` timestamp;--> statement-breakpoint
CREATE TABLE `api_usage_policies` (
	`id` varchar(36) NOT NULL,
	`policyKey` varchar(96) NOT NULL,
	`scope` enum('website_frontend','managed_user') NOT NULL,
	`workspaceUserId` int,
	`limit` int unsigned NOT NULL DEFAULT 230000,
	`warningRatioBasisPoints` int unsigned NOT NULL DEFAULT 8000,
	`windowDays` int unsigned NOT NULL DEFAULT 30,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `api_usage_policies_id` PRIMARY KEY(`id`),
	CONSTRAINT `api_usage_policies_policyKey_unique` UNIQUE(`policyKey`)
);
--> statement-breakpoint
CREATE TABLE `api_usage_snapshots` (
	`id` varchar(36) NOT NULL,
	`policyId` varchar(36) NOT NULL,
	`credentialFingerprint` varchar(32),
	`used` int unsigned NOT NULL DEFAULT 0,
	`windowStartedAt` timestamp NOT NULL,
	`fetchedAt` timestamp,
	`syncStatus` enum('pending','ok','error','unconfigured') NOT NULL DEFAULT 'pending',
	`errorCode` varchar(64),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `api_usage_snapshots_id` PRIMARY KEY(`id`),
	CONSTRAINT `api_usage_snapshots_policy_uq` UNIQUE(`policyId`)
);
--> statement-breakpoint
ALTER TABLE `icp_sensitive_materials` ADD CONSTRAINT `icp_sensitive_materials_workspaceUserId_users_id_fk` FOREIGN KEY (`workspaceUserId`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `icp_sensitive_materials` ADD CONSTRAINT `icp_sensitive_materials_ownerUserId_users_id_fk` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `delivery_ticket_attachments` ADD CONSTRAINT `ticket_attachments_protected_material_fk` FOREIGN KEY (`protectedMaterialId`) REFERENCES `icp_sensitive_materials`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `api_usage_policies` ADD CONSTRAINT `api_usage_policies_workspaceUserId_users_id_fk` FOREIGN KEY (`workspaceUserId`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `api_usage_snapshots` ADD CONSTRAINT `api_usage_snapshots_policyId_api_usage_policies_id_fk` FOREIGN KEY (`policyId`) REFERENCES `api_usage_policies`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `icp_sensitive_materials_workspace_status_idx` ON `icp_sensitive_materials` (`workspaceUserId`,`status`);--> statement-breakpoint
CREATE INDEX `icp_sensitive_materials_retention_idx` ON `icp_sensitive_materials` (`status`,`retentionUntil`);--> statement-breakpoint
CREATE UNIQUE INDEX `delivery_ticket_attachments_event_protected_kind_uq` ON `delivery_ticket_attachments` (`eventId`,`protectedMaterialId`,`kind`);--> statement-breakpoint
CREATE INDEX `workspace_site_profiles_workflow_idx` ON `workspace_site_profiles` (`domainStatus`,`icpStatus`);--> statement-breakpoint
CREATE INDEX `api_usage_policies_scope_user_idx` ON `api_usage_policies` (`scope`,`workspaceUserId`);--> statement-breakpoint
CREATE INDEX `api_usage_snapshots_status_fetched_idx` ON `api_usage_snapshots` (`syncStatus`,`fetchedAt`);
