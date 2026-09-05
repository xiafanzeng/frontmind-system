CREATE TABLE `publisher_media_logo_assets` (
	`media_resource_id` varchar(36) NOT NULL,
	`sha256` varchar(64) NOT NULL,
	`source_kind` enum('logo','icon','site_favicon','web_search_verified','manual_verified','generated_fallback') NOT NULL,
	`object_key` varchar(1024) NOT NULL,
	`content_type` varchar(120) NOT NULL,
	`size_bytes` bigint unsigned NOT NULL,
	`catalog_revision` varchar(64) NOT NULL,
	`review_audit` json,
	`archived_at` datetime(3) NOT NULL,
	`created_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `publisher_media_logo_assets_media_resource_id_sha256_pk` PRIMARY KEY(`media_resource_id`,`sha256`)
);
--> statement-breakpoint
CREATE TABLE `publisher_media_logo_resolutions` (
	`id` varchar(36) NOT NULL,
	`sync_run_id` varchar(36) NOT NULL,
	`media_resource_id` varchar(36) NOT NULL,
	`candidate_hash` varchar(64) NOT NULL,
	`status` enum('pending','archived','pending_review','missing','failed') NOT NULL,
	`source_kind` enum('logo','icon','site_favicon','web_search_verified','manual_verified','generated_fallback'),
	`logo_sha256` varchar(64),
	`error_code` varchar(120),
	`review_audit` json,
	`checked_at` datetime(3),
	`created_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
	CONSTRAINT `publisher_media_logo_resolutions_id` PRIMARY KEY(`id`),
	CONSTRAINT `pub_media_logo_resolution_run_media_uq` UNIQUE(`sync_run_id`,`media_resource_id`)
);
--> statement-breakpoint
ALTER TABLE `publisher_media_resources` MODIFY COLUMN `logo_archive_status` enum('pending','archived','pending_review','missing','failed') NOT NULL DEFAULT 'missing';--> statement-breakpoint
ALTER TABLE `publisher_media_resources` MODIFY COLUMN `logo_source_kind` enum('logo','icon','site_favicon','web_search_verified','manual_verified','generated_fallback');--> statement-breakpoint
UPDATE `publisher_media_resources` SET `logo_candidate_hash` = SHA2(CONCAT('publisher-logo-fallback:v2:', `external_resource_id`, ':', `name`), 256) WHERE `logo_candidate_hash` IS NULL;--> statement-breakpoint
UPDATE `publisher_media_sync_staging` SET `logo_candidate_hash` = SHA2(CONCAT('publisher-logo-fallback:v2:', `external_resource_id`, ':', `name`), 256) WHERE `logo_candidate_hash` IS NULL;--> statement-breakpoint
ALTER TABLE `publisher_media_resources` MODIFY COLUMN `logo_candidate_hash` varchar(64) NOT NULL;--> statement-breakpoint
ALTER TABLE `publisher_media_sync_staging` MODIFY COLUMN `logo_candidate_hash` varchar(64) NOT NULL;--> statement-breakpoint
ALTER TABLE `publisher_media_resources` ADD `logo_review_audit` json AFTER `logo_archive_error`;--> statement-breakpoint
ALTER TABLE `publisher_media_logo_assets` ADD CONSTRAINT `pub_media_logo_assets_media_fk` FOREIGN KEY (`media_resource_id`) REFERENCES `publisher_media_resources`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `publisher_media_logo_resolutions` ADD CONSTRAINT `pub_media_logo_resolutions_run_fk` FOREIGN KEY (`sync_run_id`) REFERENCES `publisher_media_sync_runs`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `publisher_media_logo_resolutions` ADD CONSTRAINT `pub_media_logo_resolutions_media_fk` FOREIGN KEY (`media_resource_id`) REFERENCES `publisher_media_resources`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
INSERT INTO `publisher_media_logo_assets` (
	`media_resource_id`, `sha256`, `source_kind`, `object_key`, `content_type`,
	`size_bytes`, `catalog_revision`, `review_audit`, `archived_at`
)
SELECT
	`id`, `logo_sha256`, `logo_source_kind`, `logo_object_key`,
	`logo_content_type`, `logo_size_bytes`, `catalog_revision`,
	`logo_review_audit`, COALESCE(`logo_checked_at`, `updated_at`)
FROM `publisher_media_resources`
WHERE `logo_archive_status` = 'archived'
	AND `logo_sha256` IS NOT NULL
	AND `logo_source_kind` IS NOT NULL
	AND `logo_object_key` IS NOT NULL
	AND `logo_content_type` IN ('image/jpeg', 'image/png')
	AND `logo_size_bytes` IS NOT NULL;--> statement-breakpoint
INSERT INTO `publisher_media_logo_resolutions` (
	`id`, `sync_run_id`, `media_resource_id`, `candidate_hash`, `status`,
	`source_kind`, `logo_sha256`, `error_code`, `review_audit`, `checked_at`
)
SELECT
	UUID(), `last_seen_complete_run_id`, `id`, `logo_candidate_hash`,
	`logo_archive_status`, `logo_source_kind`, `logo_sha256`,
	`logo_archive_error`, `logo_review_audit`, `logo_checked_at`
FROM `publisher_media_resources`
WHERE `last_seen_complete_run_id` IS NOT NULL;--> statement-breakpoint
CREATE INDEX `pub_media_logo_asset_sha_idx` ON `publisher_media_logo_assets` (`sha256`);--> statement-breakpoint
CREATE INDEX `pub_media_logo_resolution_run_status_idx` ON `publisher_media_logo_resolutions` (`sync_run_id`,`status`,`source_kind`);
