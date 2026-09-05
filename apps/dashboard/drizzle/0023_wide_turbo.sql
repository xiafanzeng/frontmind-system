ALTER TABLE `website_manual_service_orders` MODIFY COLUMN `status` enum('pending_admin','signature_required','payment_required','account_setup_required','activation_required','active','rejected','failed') NOT NULL DEFAULT 'pending_admin';--> statement-breakpoint
ALTER TABLE `website_manual_service_orders` ADD `accountSetupIdempotencyKeyHash` varchar(64);--> statement-breakpoint
ALTER TABLE `website_manual_service_orders` ADD `accountSetupRequestHash` varchar(64);--> statement-breakpoint
ALTER TABLE `website_manual_service_orders` ADD `requestedPasswordHash` varchar(255);--> statement-breakpoint
ALTER TABLE `website_manual_service_orders` ADD `accountSetupAt` timestamp;--> statement-breakpoint
ALTER TABLE `website_manual_service_orders` ADD CONSTRAINT `website_orders_account_setup_idem_uq` UNIQUE(`accountSetupIdempotencyKeyHash`);
