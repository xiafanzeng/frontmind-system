ALTER TABLE `users` MODIFY COLUMN `role` enum('user','admin','delivery_member') NOT NULL DEFAULT 'user';--> statement-breakpoint

CREATE TABLE `delivery_roles` (
  `id` varchar(36) NOT NULL,
  `name` varchar(128) NOT NULL,
  `roleType` enum('knowledge_base_engineer','monitoring_optimization_engineer','content_distribution_engineer','website_operations_engineer') NOT NULL,
  `isActive` boolean NOT NULL DEFAULT true,
  `createdByUserId` int,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  `updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT `delivery_roles_id` PRIMARY KEY(`id`),
  CONSTRAINT `delivery_roles_created_by_fk` FOREIGN KEY (`createdByUserId`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action,
  CONSTRAINT `delivery_roles_type_name_uq` UNIQUE(`roleType`,`name`)
);--> statement-breakpoint
CREATE INDEX `delivery_roles_type_active_idx` ON `delivery_roles` (`roleType`,`isActive`);--> statement-breakpoint

CREATE TABLE `delivery_role_members` (
  `id` varchar(36) NOT NULL,
  `roleId` varchar(36) NOT NULL,
  `memberUserId` int NOT NULL,
  `isActive` boolean NOT NULL DEFAULT true,
  `assignedByUserId` int,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  `updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT `delivery_role_members_id` PRIMARY KEY(`id`),
  CONSTRAINT `delivery_role_members_role_fk` FOREIGN KEY (`roleId`) REFERENCES `delivery_roles`(`id`) ON DELETE cascade ON UPDATE no action,
  CONSTRAINT `delivery_role_members_member_fk` FOREIGN KEY (`memberUserId`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action,
  CONSTRAINT `delivery_role_members_assigned_by_fk` FOREIGN KEY (`assignedByUserId`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action,
  CONSTRAINT `delivery_role_members_role_member_uq` UNIQUE(`roleId`,`memberUserId`)
);--> statement-breakpoint
CREATE INDEX `delivery_role_members_member_active_idx` ON `delivery_role_members` (`memberUserId`,`isActive`);--> statement-breakpoint

CREATE TABLE `delivery_customer_assignments` (
  `id` varchar(36) NOT NULL,
  `customerUserId` int NOT NULL,
  `roleType` enum('knowledge_base_engineer','monitoring_optimization_engineer','content_distribution_engineer','website_operations_engineer') NOT NULL,
  `roleId` varchar(36) NOT NULL,
  `primaryMemberId` int NOT NULL,
  `revision` int unsigned NOT NULL DEFAULT 1,
  `assignedByUserId` int,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  `updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT `delivery_customer_assignments_id` PRIMARY KEY(`id`),
  CONSTRAINT `delivery_customer_assignments_customer_fk` FOREIGN KEY (`customerUserId`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action,
  CONSTRAINT `delivery_customer_assignments_role_fk` FOREIGN KEY (`roleId`) REFERENCES `delivery_roles`(`id`) ON DELETE restrict ON UPDATE no action,
  CONSTRAINT `delivery_customer_assignments_member_fk` FOREIGN KEY (`primaryMemberId`) REFERENCES `users`(`id`) ON DELETE restrict ON UPDATE no action,
  CONSTRAINT `delivery_customer_assignments_assigned_by_fk` FOREIGN KEY (`assignedByUserId`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action,
  CONSTRAINT `delivery_customer_assignments_customer_type_uq` UNIQUE(`customerUserId`,`roleType`)
);--> statement-breakpoint
CREATE INDEX `delivery_customer_assignments_member_type_idx` ON `delivery_customer_assignments` (`primaryMemberId`,`roleType`);--> statement-breakpoint

ALTER TABLE `delivery_tickets` MODIFY COLUMN `type` enum('content_asset','website_operation','knowledge_base') NOT NULL;--> statement-breakpoint
ALTER TABLE `delivery_tickets` ADD `workflowDomain` enum('knowledge_base_engineer','monitoring_optimization_engineer','content_distribution_engineer','website_operations_engineer');--> statement-breakpoint
ALTER TABLE `delivery_tickets` ADD `operation` varchar(64);--> statement-breakpoint
ALTER TABLE `delivery_tickets` ADD `assignedRoleId` varchar(36);--> statement-breakpoint
ALTER TABLE `delivery_tickets` ADD `assignedMemberId` int;--> statement-breakpoint
ALTER TABLE `delivery_tickets` ADD `sourceQuestionId` varchar(191);--> statement-breakpoint
ALTER TABLE `delivery_tickets` ADD `monitoringBatchKey` varchar(191);--> statement-breakpoint
ALTER TABLE `delivery_tickets` ADD `responseLogicRevision` int;--> statement-breakpoint
ALTER TABLE `delivery_tickets` ADD `contentAssetIds` json NOT NULL DEFAULT ('[]');--> statement-breakpoint
ALTER TABLE `delivery_tickets` ADD `priority` enum('low','normal','high','urgent') NOT NULL DEFAULT 'normal';--> statement-breakpoint
ALTER TABLE `delivery_tickets` ADD CONSTRAINT `delivery_tickets_assigned_role_fk` FOREIGN KEY (`assignedRoleId`) REFERENCES `delivery_roles`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `delivery_tickets` ADD CONSTRAINT `delivery_tickets_assigned_member_fk` FOREIGN KEY (`assignedMemberId`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `delivery_tickets_role_member_status_idx` ON `delivery_tickets` (`workflowDomain`,`assignedMemberId`,`status`);--> statement-breakpoint
ALTER TABLE `delivery_ticket_events` MODIFY COLUMN `actorRole` enum('user','admin','delivery_member','system') NOT NULL;--> statement-breakpoint
ALTER TABLE `delivery_ticket_events` ADD `actorContext` json;--> statement-breakpoint

UPDATE `delivery_tickets`
SET `workflowDomain` = 'content_distribution_engineer',
    `operation` = 'content_asset_publish'
WHERE `type` = 'content_asset';--> statement-breakpoint
UPDATE `delivery_tickets`
SET `workflowDomain` = 'knowledge_base_engineer',
    `operation` = 'knowledge_maintenance'
WHERE `type` = 'website_operation' AND `category` = 'knowledge_base_maintenance';--> statement-breakpoint
UPDATE `delivery_tickets`
SET `workflowDomain` = 'website_operations_engineer',
    `operation` = `category`
WHERE `type` = 'website_operation'
  AND `category` IN (
    'domain_application',
    'icp_filing',
    'company_facts',
    'product_case_docs',
    'industry_news',
    'company_news',
    'faq_content'
  );--> statement-breakpoint

CREATE TABLE `knowledge_base_reset_requests` (
  `id` varchar(36) NOT NULL,
  `ticketId` varchar(36) NOT NULL,
  `userId` int NOT NULL,
  `assignedRoleId` varchar(36) NOT NULL,
  `assignedMemberId` int NOT NULL,
  `activeKey` varchar(191),
  `reasonCode` enum('stuck','upload_error','build_error','enterprise_materials','other') NOT NULL,
  `reasonNote` text,
  `status` enum('pending','approved','rejected') NOT NULL DEFAULT 'pending',
  `decisionNote` text,
  `decidedByUserId` int,
  `cleanupSummary` json,
  `decidedAt` timestamp,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  `updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT `knowledge_base_reset_requests_id` PRIMARY KEY(`id`),
  CONSTRAINT `knowledge_base_reset_requests_ticket_fk` FOREIGN KEY (`ticketId`) REFERENCES `delivery_tickets`(`id`) ON DELETE restrict ON UPDATE no action,
  CONSTRAINT `knowledge_base_reset_requests_user_fk` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action,
  CONSTRAINT `knowledge_base_reset_requests_role_fk` FOREIGN KEY (`assignedRoleId`) REFERENCES `delivery_roles`(`id`) ON DELETE restrict ON UPDATE no action,
  CONSTRAINT `knowledge_base_reset_requests_member_fk` FOREIGN KEY (`assignedMemberId`) REFERENCES `users`(`id`) ON DELETE restrict ON UPDATE no action,
  CONSTRAINT `knowledge_base_reset_requests_decided_by_fk` FOREIGN KEY (`decidedByUserId`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action,
  CONSTRAINT `knowledge_base_reset_requests_ticket_uq` UNIQUE(`ticketId`),
  CONSTRAINT `knowledge_base_reset_requests_active_key_uq` UNIQUE(`activeKey`)
);--> statement-breakpoint
CREATE INDEX `knowledge_base_reset_requests_user_status_idx` ON `knowledge_base_reset_requests` (`userId`,`status`);--> statement-breakpoint
CREATE INDEX `knowledge_base_reset_requests_member_status_idx` ON `knowledge_base_reset_requests` (`assignedMemberId`,`status`);--> statement-breakpoint

CREATE TABLE `knowledge_base_reset_states` (
  `userId` int NOT NULL,
  `revision` int unsigned NOT NULL DEFAULT 0,
  `updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT `knowledge_base_reset_states_user_id` PRIMARY KEY(`userId`),
  CONSTRAINT `knowledge_base_reset_states_user_fk` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action
);--> statement-breakpoint

CREATE TABLE `knowledge_base_conversation_tombstones` (
  `id` varchar(36) NOT NULL,
  `userId` int NOT NULL,
  `publicConversationId` varchar(191) NOT NULL,
  `resetRequestId` varchar(36) NOT NULL,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `knowledge_base_conversation_tombstones_id` PRIMARY KEY(`id`),
  CONSTRAINT `kb_conversation_tombstones_user_fk` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action,
  CONSTRAINT `kb_conversation_tombstones_reset_fk` FOREIGN KEY (`resetRequestId`) REFERENCES `knowledge_base_reset_requests`(`id`) ON DELETE cascade ON UPDATE no action,
  CONSTRAINT `kb_conversation_tombstones_user_conversation_uq` UNIQUE(`userId`,`publicConversationId`)
);--> statement-breakpoint

CREATE TABLE `knowledge_base_reset_cleanup_jobs` (
  `id` varchar(36) NOT NULL,
  `resetRequestId` varchar(36) NOT NULL,
  `userId` int NOT NULL,
  `apiCredentialId` varchar(36),
  `kind` enum('task','file','local_asset') NOT NULL,
  `upstreamId` varchar(255) NOT NULL,
  `status` enum('pending','completed','failed') NOT NULL DEFAULT 'pending',
  `attemptCount` int unsigned NOT NULL DEFAULT 0,
  `lastError` text,
  `completedAt` timestamp,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  `updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT `knowledge_base_reset_cleanup_jobs_id` PRIMARY KEY(`id`),
  CONSTRAINT `kb_reset_cleanup_request_fk` FOREIGN KEY (`resetRequestId`) REFERENCES `knowledge_base_reset_requests`(`id`) ON DELETE cascade ON UPDATE no action,
  CONSTRAINT `kb_reset_cleanup_user_fk` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action,
  CONSTRAINT `kb_reset_cleanup_credential_fk` FOREIGN KEY (`apiCredentialId`) REFERENCES `api_credentials`(`id`) ON DELETE set null ON UPDATE no action,
  CONSTRAINT `kb_reset_cleanup_request_resource_uq` UNIQUE(`resetRequestId`,`kind`,`upstreamId`)
);--> statement-breakpoint
CREATE INDEX `kb_reset_cleanup_status_attempt_idx` ON `knowledge_base_reset_cleanup_jobs` (`status`,`attemptCount`);
