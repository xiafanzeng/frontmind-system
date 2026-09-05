ALTER TABLE `api_usage_credential_coverage` ADD `scanGeneration` int unsigned DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `api_usage_credential_coverage` ADD `scanToken` varchar(36);--> statement-breakpoint
ALTER TABLE `api_usage_credential_coverage` ADD `scanStartedAtMs` bigint unsigned;--> statement-breakpoint
CREATE INDEX `api_usage_credential_coverage_claim_idx` ON `api_usage_credential_coverage` (`scanToken`,`scanStartedAtMs`);