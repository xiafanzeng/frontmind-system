CREATE TABLE `delivery_member_origins` (
	`engineerUserId` int NOT NULL,
	`createdByAdminId` int,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `delivery_member_origins_engineerUserId` PRIMARY KEY(`engineerUserId`)
);
--> statement-breakpoint
CREATE TABLE `website_style_sample_batches` (
	`id` varchar(36) NOT NULL,
	`userId` int NOT NULL,
	`ticketId` varchar(36) NOT NULL,
	`ordinal` int unsigned NOT NULL,
	`status` enum('published','revision_requested','selected','superseded') NOT NULL DEFAULT 'published',
	`engineerNote` text,
	`publishedByUserId` int,
	`publishedAt` timestamp NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `website_style_sample_batches_id` PRIMARY KEY(`id`),
	CONSTRAINT `website_style_batches_user_ordinal_uq` UNIQUE(`userId`,`ordinal`)
);
--> statement-breakpoint
CREATE TABLE `website_style_samples` (
	`id` varchar(36) NOT NULL,
	`batchId` varchar(36) NOT NULL,
	`attachmentId` varchar(36) NOT NULL,
	`label` varchar(160) NOT NULL,
	`note` text,
	`sortOrder` int unsigned NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `website_style_samples_id` PRIMARY KEY(`id`),
	CONSTRAINT `website_style_samples_batch_order_uq` UNIQUE(`batchId`,`sortOrder`),
	CONSTRAINT `website_style_samples_batch_attachment_uq` UNIQUE(`batchId`,`attachmentId`)
);
--> statement-breakpoint
CREATE TABLE `website_style_workflows` (
	`userId` int NOT NULL,
	`status` enum('waiting_samples','awaiting_selection','revision_requested','confirmed','legacy_confirmed') NOT NULL DEFAULT 'waiting_samples',
	`currentBatchId` varchar(36),
	`selectedSampleId` varchar(36),
	`selectedByUserId` int,
	`selectedAt` timestamp,
	`revision` int unsigned NOT NULL DEFAULT 1,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `website_style_workflows_userId` PRIMARY KEY(`userId`)
);
--> statement-breakpoint
ALTER TABLE `delivery_member_origins` ADD CONSTRAINT `delivery_member_origins_engineerUserId_users_id_fk` FOREIGN KEY (`engineerUserId`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `delivery_member_origins` ADD CONSTRAINT `delivery_member_origins_createdByAdminId_users_id_fk` FOREIGN KEY (`createdByAdminId`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `website_style_sample_batches` ADD CONSTRAINT `website_style_sample_batches_userId_users_id_fk` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `website_style_sample_batches` ADD CONSTRAINT `website_style_sample_batches_ticketId_delivery_tickets_id_fk` FOREIGN KEY (`ticketId`) REFERENCES `delivery_tickets`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `website_style_sample_batches` ADD CONSTRAINT `website_style_sample_batches_publishedByUserId_users_id_fk` FOREIGN KEY (`publishedByUserId`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `website_style_samples` ADD CONSTRAINT `website_style_samples_batchId_website_style_sample_batches_id_fk` FOREIGN KEY (`batchId`) REFERENCES `website_style_sample_batches`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `website_style_samples` ADD CONSTRAINT `website_style_samples_attachment_fk` FOREIGN KEY (`attachmentId`) REFERENCES `delivery_ticket_attachments`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `website_style_workflows` ADD CONSTRAINT `website_style_workflows_userId_users_id_fk` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `website_style_workflows` ADD CONSTRAINT `website_style_workflows_selectedByUserId_users_id_fk` FOREIGN KEY (`selectedByUserId`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `delivery_member_origins_admin_idx` ON `delivery_member_origins` (`createdByAdminId`);--> statement-breakpoint
CREATE INDEX `website_style_batches_ticket_status_idx` ON `website_style_sample_batches` (`ticketId`,`status`);--> statement-breakpoint
CREATE INDEX `website_style_workflows_status_idx` ON `website_style_workflows` (`status`);--> statement-breakpoint
CREATE INDEX `delivery_tickets_member_status_resolved_id_idx` ON `delivery_tickets` (`assignedMemberId`,`status`,`resolvedAt`,`id`);