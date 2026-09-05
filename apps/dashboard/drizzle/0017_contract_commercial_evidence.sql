ALTER TABLE `service_contracts` ADD `amountFen` int unsigned;--> statement-breakpoint
ALTER TABLE `service_contracts` ADD `currency` varchar(3) DEFAULT 'CNY' NOT NULL;--> statement-breakpoint
ALTER TABLE `service_contracts` ADD `prepaidMonths` int unsigned;--> statement-breakpoint
ALTER TABLE `service_contracts` ADD `orderReference` varchar(128);--> statement-breakpoint
ALTER TABLE `service_contracts` ADD `externalContractReference` varchar(128);--> statement-breakpoint
ALTER TABLE `service_contracts` ADD `signedAt` timestamp;--> statement-breakpoint
ALTER TABLE `service_contracts` ADD `signatoryId` varchar(128);--> statement-breakpoint
ALTER TABLE `service_contracts` ADD `signingEvidence` json;--> statement-breakpoint
ALTER TABLE `workspace_questions` ADD `sourceQuestionId` varchar(36);--> statement-breakpoint
CREATE INDEX `service_contracts_order_reference_idx` ON `service_contracts` (`source`,`orderReference`);--> statement-breakpoint
CREATE INDEX `workspace_questions_source_question_idx` ON `workspace_questions` (`userId`,`sourceQuestionId`);