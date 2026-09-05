ALTER TABLE `conversations` MODIFY COLUMN `status` enum('idle','running','pending','awaiting_input','completed','error','failed','archived') NOT NULL DEFAULT 'idle';--> statement-breakpoint
ALTER TABLE `delivery_tickets` ADD `knowledgeSnapshotId` varchar(36);--> statement-breakpoint
ALTER TABLE `knowledge_base_builds` ADD `awaitingResponseSince` timestamp;--> statement-breakpoint
ALTER TABLE `knowledge_base_snapshots` ADD `maintenanceTicketId` varchar(36);