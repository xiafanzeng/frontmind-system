ALTER TABLE `presales_upstream_resources` ADD `contentSource` enum('user_upload','assistant_output');--> statement-breakpoint
ALTER TABLE `presales_upstream_resources` ADD `uploadReservedAt` timestamp;--> statement-breakpoint
ALTER TABLE `presales_upstream_resources` ADD `uploadedAt` timestamp;--> statement-breakpoint
ALTER TABLE `presales_upstream_resources` ADD `contentExpiresAt` timestamp;--> statement-breakpoint
ALTER TABLE `presales_upstream_resources` ADD `contentDeletedAt` timestamp;--> statement-breakpoint
ALTER TABLE `upstream_resources` ADD `uploadedAt` timestamp;--> statement-breakpoint
ALTER TABLE `upstream_resources` ADD `contentExpiresAt` timestamp;--> statement-breakpoint
ALTER TABLE `upstream_resources` ADD `contentDeletedAt` timestamp;--> statement-breakpoint
CREATE INDEX `conversations_updated_idx` ON `conversations` (`updatedAt`,`id`);--> statement-breakpoint
CREATE INDEX `presales_upstream_resources_content_expiry_idx` ON `presales_upstream_resources` (`kind`,`contentSource`,`uploadReservedAt`,`contentExpiresAt`,`contentDeletedAt`,`id`);--> statement-breakpoint
CREATE INDEX `upstream_resources_content_expiry_idx` ON `upstream_resources` (`kind`,`contentExpiresAt`,`contentDeletedAt`,`id`);--> statement-breakpoint
CREATE INDEX `upstream_resources_conversation_kind_idx` ON `upstream_resources` (`conversationId`,`kind`);
