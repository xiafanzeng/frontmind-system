ALTER TABLE `website_manual_service_orders` MODIFY COLUMN `amountFen` int unsigned;--> statement-breakpoint
UPDATE `website_manual_service_orders` SET `amountFen` = NULL WHERE `amountFen` = 0;--> statement-breakpoint
ALTER TABLE `website_user_provisions` MODIFY COLUMN `contractId` varchar(128);
