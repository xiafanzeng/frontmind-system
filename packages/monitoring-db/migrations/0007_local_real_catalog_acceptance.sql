CREATE TABLE `platform_acceptance_batches` (
	`id` varchar(36) NOT NULL,
	`owner_id` varchar(36) NOT NULL,
	`project_id` varchar(36) NOT NULL,
	`requested_by` varchar(36) NOT NULL,
	`plan_fingerprint` varchar(64) NOT NULL,
	`question_hash` varchar(64) NOT NULL,
	`question_snapshot` text NOT NULL,
	`status` enum('pending','running','passed','failed','unsupported','stale') NOT NULL DEFAULT 'pending',
	`attempt_count` int unsigned NOT NULL,
	`total_amount_ten_thousandths` bigint unsigned NOT NULL,
	`idempotency_key` varchar(128) NOT NULL,
	`started_at` datetime(3),
	`completed_at` datetime(3),
	`created_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
	CONSTRAINT `platform_acceptance_batches_id` PRIMARY KEY(`id`),
	CONSTRAINT `platform_acceptance_request_uq` UNIQUE(`requested_by`,`idempotency_key`)
);
--> statement-breakpoint
CREATE TABLE `platform_acceptance_checks` (
	`id` varchar(36) NOT NULL,
	`batch_id` varchar(36) NOT NULL,
	`platform_id` varchar(36) NOT NULL,
	`provider_code_snapshot` varchar(64) NOT NULL,
	`display_name_snapshot` varchar(100) NOT NULL,
	`client_type` enum('web','mobile') NOT NULL,
	`platform_fingerprint` varchar(64) NOT NULL,
	`dimension` enum('search_default','reasoning_search','screenshot_mention','screenshot_all','region_default','region_domestic','region_overseas','mobile_no_region') NOT NULL,
	`mode` enum('search','reasoning_search') NOT NULL,
	`screenshot` int unsigned NOT NULL,
	`region_code` varchar(64),
	`status` enum('pending','running','passed','failed','unsupported','stale') NOT NULL DEFAULT 'pending',
	`run_id` varchar(36),
	`attempt_id` varchar(36),
	`result_hash` varchar(64),
	`screenshot_hash` varchar(64),
	`error_code` varchar(64),
	`error_summary` varchar(240),
	`started_at` datetime(3),
	`completed_at` datetime(3),
	`created_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
	CONSTRAINT `platform_acceptance_checks_id` PRIMARY KEY(`id`),
	CONSTRAINT `platform_acceptance_batch_dimension_uq` UNIQUE(`batch_id`,`platform_id`,`dimension`),
	CONSTRAINT `platform_acceptance_attempt_uq` UNIQUE(`attempt_id`)
);
--> statement-breakpoint
ALTER TABLE `publisher_jobs` MODIFY COLUMN `type` enum('import_docx','sync_kol_catalog','archive_publisher_media_logo','submit_publication_item','poll_publication_item','reconcile_publication_unknown','purge_publisher_assets') NOT NULL;--> statement-breakpoint
ALTER TABLE `platform_catalog` ADD `acceptance_required` boolean DEFAULT false NOT NULL AFTER `supports_overseas_region`;--> statement-breakpoint
ALTER TABLE `platform_catalog` ADD `acceptance_fingerprint` varchar(64) AFTER `provider_metadata`;--> statement-breakpoint
ALTER TABLE `publisher_media_resources` ADD `provider_icon_url` text AFTER `logo_url`;--> statement-breakpoint
ALTER TABLE `publisher_media_resources` ADD `logo_candidate_hash` varchar(64) AFTER `provider_icon_url`;--> statement-breakpoint
ALTER TABLE `publisher_media_resources` ADD `logo_archive_status` enum('pending','archived','missing','failed') DEFAULT 'missing' NOT NULL AFTER `logo_candidate_hash`;--> statement-breakpoint
ALTER TABLE `publisher_media_resources` ADD `logo_source_kind` enum('logo','icon') AFTER `logo_archive_status`;--> statement-breakpoint
ALTER TABLE `publisher_media_resources` ADD `logo_source_url` text AFTER `logo_source_kind`;--> statement-breakpoint
ALTER TABLE `publisher_media_resources` ADD `logo_object_key` varchar(1024) AFTER `logo_source_url`;--> statement-breakpoint
ALTER TABLE `publisher_media_resources` ADD `logo_content_type` varchar(120) AFTER `logo_object_key`;--> statement-breakpoint
ALTER TABLE `publisher_media_resources` ADD `logo_size_bytes` bigint unsigned AFTER `logo_content_type`;--> statement-breakpoint
ALTER TABLE `publisher_media_resources` ADD `logo_sha256` varchar(64) AFTER `logo_size_bytes`;--> statement-breakpoint
ALTER TABLE `publisher_media_resources` ADD `logo_checked_at` datetime(3) AFTER `logo_sha256`;--> statement-breakpoint
ALTER TABLE `publisher_media_resources` ADD `logo_archive_error` varchar(120) AFTER `logo_checked_at`;--> statement-breakpoint
ALTER TABLE `publisher_media_sync_staging` ADD `provider_icon_url` text AFTER `logo_url`;--> statement-breakpoint
ALTER TABLE `publisher_media_sync_staging` ADD `logo_candidate_hash` varchar(64) AFTER `provider_icon_url`;--> statement-breakpoint
ALTER TABLE `publisher_media_sync_runs` ADD `pages_expected` int unsigned DEFAULT 0 NOT NULL AFTER `pages_fetched`;--> statement-breakpoint
ALTER TABLE `publisher_media_sync_runs` ADD `news_records` int unsigned DEFAULT 0 NOT NULL AFTER `records_seen`;--> statement-breakpoint
ALTER TABLE `publisher_media_sync_runs` ADD `self_media_records` int unsigned DEFAULT 0 NOT NULL AFTER `news_records`;--> statement-breakpoint
ALTER TABLE `publisher_media_sync_runs` ADD `invalid_records` int unsigned DEFAULT 0 NOT NULL AFTER `self_media_records`;--> statement-breakpoint
ALTER TABLE `publisher_media_sync_runs` ADD `duplicate_records` int unsigned DEFAULT 0 NOT NULL AFTER `invalid_records`;--> statement-breakpoint
ALTER TABLE `publisher_media_sync_runs` ADD `cross_kind_duplicate_records` int unsigned DEFAULT 0 NOT NULL AFTER `duplicate_records`;--> statement-breakpoint
ALTER TABLE `platform_acceptance_batches` ADD CONSTRAINT `platform_acceptance_batches_owner_id_users_id_fk` FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `platform_acceptance_batches` ADD CONSTRAINT `platform_acceptance_batches_project_id_projects_id_fk` FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `platform_acceptance_batches` ADD CONSTRAINT `platform_acceptance_batches_requested_by_users_id_fk` FOREIGN KEY (`requested_by`) REFERENCES `users`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `platform_acceptance_checks` ADD CONSTRAINT `platform_acceptance_checks_batch_fk` FOREIGN KEY (`batch_id`) REFERENCES `platform_acceptance_batches`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `platform_acceptance_checks` ADD CONSTRAINT `platform_acceptance_checks_platform_id_platform_catalog_id_fk` FOREIGN KEY (`platform_id`) REFERENCES `platform_catalog`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `platform_acceptance_checks` ADD CONSTRAINT `platform_acceptance_checks_run_id_runs_id_fk` FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `platform_acceptance_checks` ADD CONSTRAINT `platform_acceptance_checks_attempt_id_attempts_id_fk` FOREIGN KEY (`attempt_id`) REFERENCES `attempts`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `platform_acceptance_owner_created_idx` ON `platform_acceptance_batches` (`owner_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `platform_acceptance_status_created_idx` ON `platform_acceptance_batches` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `platform_acceptance_platform_evidence_idx` ON `platform_acceptance_checks` (`platform_id`,`platform_fingerprint`,`dimension`,`status`);--> statement-breakpoint
CREATE INDEX `platform_acceptance_batch_status_idx` ON `platform_acceptance_checks` (`batch_id`,`status`);--> statement-breakpoint
CREATE INDEX `pub_media_logo_archive_idx` ON `publisher_media_resources` (`logo_archive_status`,`updated_at`);
