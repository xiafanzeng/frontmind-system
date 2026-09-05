ALTER TABLE `delivery_project_assignments` DROP FOREIGN KEY `delivery_project_assignments_engineerUserId_users_id_fk`;
--> statement-breakpoint
ALTER TABLE `knowledge_base_reset_requests` DROP FOREIGN KEY `knowledge_base_reset_requests_member_fk`;
--> statement-breakpoint
ALTER TABLE `knowledge_base_reset_requests` DROP FOREIGN KEY `kb_reset_project_assignment_fk`;
--> statement-breakpoint
ALTER TABLE `delivery_project_assignments` MODIFY COLUMN `engineerUserId` int;--> statement-breakpoint
ALTER TABLE `knowledge_base_reset_requests` MODIFY COLUMN `assignedProjectAssignmentId` varchar(36);--> statement-breakpoint
ALTER TABLE `knowledge_base_reset_requests` MODIFY COLUMN `assignedMemberId` int;--> statement-breakpoint
ALTER TABLE `conversations` ADD `projectAssignmentId` varchar(36);--> statement-breakpoint
ALTER TABLE `upstream_resources` ADD `projectAssignmentId` varchar(36);--> statement-breakpoint
ALTER TABLE `conversations` ADD CONSTRAINT `conversations_project_assignment_fk` FOREIGN KEY (`projectAssignmentId`) REFERENCES `delivery_project_assignments`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `delivery_project_assignments` ADD CONSTRAINT `delivery_project_assignments_engineerUserId_users_id_fk` FOREIGN KEY (`engineerUserId`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `knowledge_base_reset_requests` ADD CONSTRAINT `knowledge_base_reset_requests_assignedMemberId_users_id_fk` FOREIGN KEY (`assignedMemberId`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `knowledge_base_reset_requests` ADD CONSTRAINT `kb_reset_project_assignment_fk` FOREIGN KEY (`assignedProjectAssignmentId`) REFERENCES `delivery_project_assignments`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `upstream_resources` ADD CONSTRAINT `upstream_resources_project_assignment_fk` FOREIGN KEY (`projectAssignmentId`) REFERENCES `delivery_project_assignments`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `conversations_user_project_updated_idx` ON `conversations` (`userId`,`projectAssignmentId`,`updatedAt`);--> statement-breakpoint
CREATE INDEX `upstream_resources_user_project_idx` ON `upstream_resources` (`userId`,`projectAssignmentId`);
