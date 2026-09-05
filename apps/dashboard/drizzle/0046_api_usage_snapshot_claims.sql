ALTER TABLE `api_usage_snapshots` ADD `syncGeneration` int unsigned DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `api_usage_snapshots` ADD `syncToken` varchar(36);--> statement-breakpoint
ALTER TABLE `api_usage_snapshots` ADD `syncStartedAt` timestamp;--> statement-breakpoint
CREATE INDEX `api_usage_snapshots_sync_claim_idx` ON `api_usage_snapshots` (`syncToken`,`syncStartedAt`);