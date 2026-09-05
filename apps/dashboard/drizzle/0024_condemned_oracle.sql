ALTER TABLE `workspace_questions` ADD `selectionApprovalStatus` enum('not_requested','pending','approved') DEFAULT 'not_requested' NOT NULL;--> statement-breakpoint
ALTER TABLE `workspace_questions` ADD `selectionRequestedAt` timestamp;--> statement-breakpoint
ALTER TABLE `workspace_questions` ADD `selectionRequestedByUserId` int;--> statement-breakpoint
ALTER TABLE `workspace_questions` ADD `selectionApprovedAt` timestamp;--> statement-breakpoint
ALTER TABLE `workspace_questions` ADD `selectionApprovedByUserId` int;--> statement-breakpoint
UPDATE `workspace_questions`
SET
  `selectionApprovalStatus` = 'approved',
  `selectionRequestedAt` = COALESCE(`selectedAt`, `createdAt`),
  `selectionApprovedAt` = COALESCE(`selectedAt`, `createdAt`),
  `locked` = true
WHERE `status` = 'selected';--> statement-breakpoint
ALTER TABLE `workspace_questions` ADD CONSTRAINT `workspace_questions_selectionRequestedByUserId_users_id_fk` FOREIGN KEY (`selectionRequestedByUserId`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `workspace_questions` ADD CONSTRAINT `workspace_questions_selectionApprovedByUserId_users_id_fk` FOREIGN KEY (`selectionApprovedByUserId`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `workspace_questions_user_approval_status_idx` ON `workspace_questions` (`userId`,`selectionApprovalStatus`,`updatedAt`);
