ALTER TABLE `service_quota_periods` ADD `contentAssetPublishLimit` int unsigned NOT NULL DEFAULT 0;--> statement-breakpoint
ALTER TABLE `service_quota_periods` ADD `websiteContentPublishLimit` int unsigned NOT NULL DEFAULT 0;--> statement-breakpoint
UPDATE `service_quota_periods` period
INNER JOIN `service_contracts` contract ON contract.`id` = period.`contractId`
SET
	period.`contentAssetPublishLimit` = CASE contract.`planCode`
		WHEN 'advanced' THEN 5
		WHEN 'luxury' THEN 20
		ELSE 0
	END,
	period.`websiteContentPublishLimit` = CASE contract.`planCode`
		WHEN 'advanced' THEN 20
		WHEN 'luxury' THEN 100
		ELSE 0
	END;--> statement-breakpoint
CREATE TABLE `delivery_tickets` (
	`id` varchar(36) NOT NULL,
	`userId` int NOT NULL,
	`contractId` varchar(36) NOT NULL,
	`quotaPeriodId` varchar(36) NOT NULL,
	`type` enum('content_asset','website_operation') NOT NULL,
	`quotaPool` enum('content_asset_publish','website_content_publish'),
	`ordinal` int unsigned NOT NULL,
	`clientRequestId` varchar(36) NOT NULL,
	`category` varchar(64),
	`topic` varchar(512),
	`title` varchar(512),
	`description` text,
	`targetPage` text,
	`technicalDedupeKey` varchar(64),
	`materialUrls` json NOT NULL DEFAULT ('[]'),
	`status` enum('submitted','needs_information','scheduled','in_progress','completed','rejected','cancelled') NOT NULL DEFAULT 'submitted',
	`quotaState` enum('reserved','consumed','released') NOT NULL DEFAULT 'reserved',
	`internalNote` text,
	`revision` int unsigned NOT NULL DEFAULT 1,
	`createdByUserId` int,
	`updatedByUserId` int,
	`resolvedAt` timestamp,
	`scheduledAt` timestamp,
	`quotaReleasedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `delivery_tickets_id` PRIMARY KEY(`id`),
	CONSTRAINT `delivery_tickets_period_pool_ordinal_uq` UNIQUE(`quotaPeriodId`,`quotaPool`,`ordinal`),
	CONSTRAINT `delivery_tickets_user_request_uq` UNIQUE(`userId`,`clientRequestId`),
	CONSTRAINT `delivery_tickets_user_technical_dedupe_uq` UNIQUE(`userId`,`technicalDedupeKey`)
);
--> statement-breakpoint
CREATE TABLE `delivery_ticket_events` (
	`id` varchar(36) NOT NULL,
	`ticketId` varchar(36) NOT NULL,
	`userId` int NOT NULL,
	`actorUserId` int,
	`actorRole` enum('user','admin','system') NOT NULL,
	`kind` enum('created','message','status_change','attachment','delivery_result') NOT NULL,
	`visibility` enum('customer','internal') NOT NULL DEFAULT 'customer',
	`clientRequestId` varchar(36),
	`message` text,
	`fromStatus` enum('submitted','needs_information','scheduled','in_progress','completed','rejected','cancelled'),
	`toStatus` enum('submitted','needs_information','scheduled','in_progress','completed','rejected','cancelled'),
	`operationResult` json,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `delivery_ticket_events_id` PRIMARY KEY(`id`),
	CONSTRAINT `delivery_ticket_events_actor_request_uq` UNIQUE(`actorUserId`,`clientRequestId`)
);
--> statement-breakpoint
CREATE TABLE `delivery_ticket_attachments` (
	`id` varchar(36) NOT NULL,
	`ticketId` varchar(36) NOT NULL,
	`eventId` varchar(36),
	`workspaceUserId` int NOT NULL,
	`ownerUserId` int NOT NULL,
	`kind` enum('input','deliverable') NOT NULL DEFAULT 'input',
	`upstreamFileId` varchar(255) NOT NULL,
	`filename` varchar(512) NOT NULL,
	`mimeType` varchar(255),
	`sizeBytes` int unsigned,
	`sha256` varchar(64),
	`purpose` varchar(160),
	`authorization` enum('owned','licensed','public','authorization_pending'),
	`copyrightNote` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `delivery_ticket_attachments_id` PRIMARY KEY(`id`),
	CONSTRAINT `delivery_ticket_attachments_event_file_kind_uq` UNIQUE(`eventId`,`upstreamFileId`,`kind`)
);
--> statement-breakpoint
CREATE TABLE `workspace_site_profiles` (
	`userId` int NOT NULL,
	`domain` varchar(255) NOT NULL,
	`siteMode` enum('managed','external','unknown') NOT NULL DEFAULT 'unknown',
	`icpNumber` varchar(128),
	`icpStatus` enum('not_submitted','preparing','submitted','approved','rejected','not_required') NOT NULL DEFAULT 'not_submitted',
	`revision` int unsigned NOT NULL DEFAULT 1,
	`updatedByUserId` int,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `workspace_site_profiles_userId` PRIMARY KEY(`userId`)
);
--> statement-breakpoint
CREATE TABLE `workspace_site_checks` (
	`id` varchar(36) NOT NULL,
	`userId` int NOT NULL,
	`key` varchar(64) NOT NULL,
	`label` varchar(160) NOT NULL,
	`status` enum('not_checked','pending','passed','warning','failed','not_applicable') NOT NULL DEFAULT 'not_checked',
	`summary` text,
	`evidence` text,
	`source` text,
	`checkedAt` timestamp,
	`revision` int unsigned NOT NULL DEFAULT 1,
	`updatedByUserId` int,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `workspace_site_checks_id` PRIMARY KEY(`id`),
	CONSTRAINT `workspace_site_checks_user_key_uq` UNIQUE(`userId`,`key`)
);
--> statement-breakpoint
CREATE TABLE `delivery_redirect_previews` (
	`id` varchar(36) NOT NULL,
	`userId` int NOT NULL,
	`ownerUserId` int NOT NULL,
	`upstreamFileId` varchar(255) NOT NULL,
	`filename` varchar(512) NOT NULL,
	`fileHash` varchar(64) NOT NULL,
	`rows` json NOT NULL DEFAULT ('[]'),
	`errors` json NOT NULL DEFAULT ('[]'),
	`total` int unsigned NOT NULL DEFAULT 0,
	`validCount` int unsigned NOT NULL DEFAULT 0,
	`errorCount` int unsigned NOT NULL DEFAULT 0,
	`status` enum('previewed','applied','expired') NOT NULL DEFAULT 'previewed',
	`appliedTicketId` varchar(36),
	`createdByUserId` int,
	`expiresAt` timestamp NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`appliedAt` timestamp,
	CONSTRAINT `delivery_redirect_previews_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `delivery_tickets` ADD CONSTRAINT `delivery_tickets_userId_users_id_fk` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `delivery_tickets` ADD CONSTRAINT `delivery_tickets_contractId_service_contracts_id_fk` FOREIGN KEY (`contractId`) REFERENCES `service_contracts`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `delivery_tickets` ADD CONSTRAINT `delivery_tickets_quotaPeriodId_service_quota_periods_id_fk` FOREIGN KEY (`quotaPeriodId`) REFERENCES `service_quota_periods`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `delivery_tickets` ADD CONSTRAINT `delivery_tickets_createdByUserId_users_id_fk` FOREIGN KEY (`createdByUserId`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `delivery_tickets` ADD CONSTRAINT `delivery_tickets_updatedByUserId_users_id_fk` FOREIGN KEY (`updatedByUserId`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `delivery_ticket_events` ADD CONSTRAINT `delivery_ticket_events_ticketId_delivery_tickets_id_fk` FOREIGN KEY (`ticketId`) REFERENCES `delivery_tickets`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `delivery_ticket_events` ADD CONSTRAINT `delivery_ticket_events_userId_users_id_fk` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `delivery_ticket_events` ADD CONSTRAINT `delivery_ticket_events_actorUserId_users_id_fk` FOREIGN KEY (`actorUserId`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `delivery_ticket_attachments` ADD CONSTRAINT `delivery_ticket_attachments_ticketId_delivery_tickets_id_fk` FOREIGN KEY (`ticketId`) REFERENCES `delivery_tickets`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `delivery_ticket_attachments` ADD CONSTRAINT `delivery_ticket_attachments_eventId_delivery_ticket_events_id_fk` FOREIGN KEY (`eventId`) REFERENCES `delivery_ticket_events`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `delivery_ticket_attachments` ADD CONSTRAINT `delivery_ticket_attachments_workspaceUserId_users_id_fk` FOREIGN KEY (`workspaceUserId`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `delivery_ticket_attachments` ADD CONSTRAINT `delivery_ticket_attachments_ownerUserId_users_id_fk` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `workspace_site_profiles` ADD CONSTRAINT `workspace_site_profiles_userId_users_id_fk` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `workspace_site_profiles` ADD CONSTRAINT `workspace_site_profiles_updatedByUserId_users_id_fk` FOREIGN KEY (`updatedByUserId`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `workspace_site_checks` ADD CONSTRAINT `workspace_site_checks_userId_users_id_fk` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `workspace_site_checks` ADD CONSTRAINT `workspace_site_checks_updatedByUserId_users_id_fk` FOREIGN KEY (`updatedByUserId`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `delivery_redirect_previews` ADD CONSTRAINT `delivery_redirect_previews_userId_users_id_fk` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `delivery_redirect_previews` ADD CONSTRAINT `delivery_redirect_previews_ownerUserId_users_id_fk` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `delivery_redirect_previews` ADD CONSTRAINT `redirect_previews_applied_ticket_fk` FOREIGN KEY (`appliedTicketId`) REFERENCES `delivery_tickets`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `delivery_redirect_previews` ADD CONSTRAINT `delivery_redirect_previews_createdByUserId_users_id_fk` FOREIGN KEY (`createdByUserId`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `delivery_tickets_user_created_idx` ON `delivery_tickets` (`userId`,`createdAt`);--> statement-breakpoint
CREATE INDEX `delivery_tickets_period_pool_state_idx` ON `delivery_tickets` (`quotaPeriodId`,`quotaPool`,`quotaState`);--> statement-breakpoint
CREATE INDEX `delivery_tickets_status_updated_idx` ON `delivery_tickets` (`status`,`updatedAt`);--> statement-breakpoint
CREATE INDEX `delivery_tickets_user_updated_id_idx` ON `delivery_tickets` (`userId`,`updatedAt`,`id`);--> statement-breakpoint
CREATE INDEX `delivery_tickets_user_period_updated_id_idx` ON `delivery_tickets` (`userId`,`quotaPeriodId`,`updatedAt`,`id`);--> statement-breakpoint
CREATE INDEX `delivery_tickets_type_status_updated_id_idx` ON `delivery_tickets` (`type`,`status`,`updatedAt`,`id`);--> statement-breakpoint
CREATE INDEX `delivery_ticket_events_ticket_created_idx` ON `delivery_ticket_events` (`ticketId`,`createdAt`);--> statement-breakpoint
CREATE INDEX `delivery_ticket_events_user_created_idx` ON `delivery_ticket_events` (`userId`,`createdAt`);--> statement-breakpoint
CREATE INDEX `delivery_ticket_attachments_ticket_created_idx` ON `delivery_ticket_attachments` (`ticketId`,`createdAt`);--> statement-breakpoint
CREATE INDEX `delivery_ticket_attachments_owner_file_idx` ON `delivery_ticket_attachments` (`ownerUserId`,`upstreamFileId`);--> statement-breakpoint
CREATE INDEX `workspace_site_profiles_domain_idx` ON `workspace_site_profiles` (`domain`);--> statement-breakpoint
CREATE INDEX `workspace_site_checks_user_status_idx` ON `workspace_site_checks` (`userId`,`status`);--> statement-breakpoint
CREATE UNIQUE INDEX `delivery_redirect_previews_user_hash_uq` ON `delivery_redirect_previews` (`userId`,`fileHash`);--> statement-breakpoint
CREATE INDEX `delivery_redirect_previews_user_created_idx` ON `delivery_redirect_previews` (`userId`,`createdAt`);--> statement-breakpoint
CREATE INDEX `delivery_redirect_previews_status_expires_idx` ON `delivery_redirect_previews` (`status`,`expiresAt`);
