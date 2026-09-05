ALTER TABLE `website_manual_service_orders` ADD `contractAuthorizationMode` enum('external_wechat');--> statement-breakpoint
ALTER TABLE `website_manual_service_orders` ADD `contractAuthorizationEventReference` varchar(128);--> statement-breakpoint
ALTER TABLE `website_manual_service_orders` ADD `contractAuthorizedAt` timestamp;--> statement-breakpoint
ALTER TABLE `website_manual_service_orders` ADD CONSTRAINT `manual_orders_contract_auth_event_uq` UNIQUE(`contractAuthorizationEventReference`);
