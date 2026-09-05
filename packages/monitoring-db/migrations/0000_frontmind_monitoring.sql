CREATE TABLE `users` (
  `id` varchar(36) NOT NULL,
  `username` varchar(64) NOT NULL,
  `password_hash` varchar(255) NOT NULL,
  `role` enum('user','admin') NOT NULL DEFAULT 'user',
  `status` enum('active','disabled') NOT NULL DEFAULT 'active',
  `session_version` int unsigned NOT NULL DEFAULT 1,
  `password_changed_at` datetime(3) NOT NULL,
  `last_login_at` datetime(3),
  `created_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  CONSTRAINT `users_pk` PRIMARY KEY (`id`),
  CONSTRAINT `users_username_uq` UNIQUE (`username`),
  KEY `users_status_idx` (`status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
--> statement-breakpoint

CREATE TABLE `sessions` (
  `id` varchar(36) NOT NULL,
  `user_id` varchar(36) NOT NULL,
  `token_hash` varchar(64) NOT NULL,
  `session_version` int unsigned NOT NULL,
  `expires_at` datetime(3) NOT NULL,
  `revoked_at` datetime(3),
  `last_seen_at` datetime(3) NOT NULL,
  `ip_hash` varchar(64),
  `user_agent` varchar(512),
  `created_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT `sessions_pk` PRIMARY KEY (`id`),
  CONSTRAINT `sessions_token_hash_uq` UNIQUE (`token_hash`),
  CONSTRAINT `sessions_user_fk` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE,
  KEY `sessions_user_active_idx` (`user_id`,`revoked_at`,`expires_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
--> statement-breakpoint

CREATE TABLE `projects` (
  `id` varchar(36) NOT NULL,
  `owner_id` varchar(36) NOT NULL,
  `name` varchar(120) NOT NULL,
  `timezone` varchar(64) NOT NULL DEFAULT 'Asia/Shanghai',
  `current_brand_version_id` varchar(36),
  `deleted_at` datetime(3),
  `purge_after` datetime(3),
  `created_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  CONSTRAINT `projects_pk` PRIMARY KEY (`id`),
  CONSTRAINT `projects_owner_fk` FOREIGN KEY (`owner_id`) REFERENCES `users` (`id`) ON DELETE RESTRICT,
  KEY `projects_owner_created_idx` (`owner_id`,`created_at`),
  KEY `projects_purge_idx` (`purge_after`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
--> statement-breakpoint

CREATE TABLE `project_brand_versions` (
  `id` varchar(36) NOT NULL,
  `project_id` varchar(36) NOT NULL,
  `version` int unsigned NOT NULL,
  `main_brand` varchar(120) NOT NULL,
  `aliases` json NOT NULL,
  `competitors` json NOT NULL,
  `created_by` varchar(36) NOT NULL,
  `created_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT `project_brand_versions_pk` PRIMARY KEY (`id`),
  CONSTRAINT `project_brand_versions_project_version_uq` UNIQUE (`project_id`,`version`),
  CONSTRAINT `project_brand_versions_project_fk` FOREIGN KEY (`project_id`) REFERENCES `projects` (`id`) ON DELETE CASCADE,
  CONSTRAINT `project_brand_versions_creator_fk` FOREIGN KEY (`created_by`) REFERENCES `users` (`id`) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
--> statement-breakpoint

CREATE TABLE `project_questions` (
  `id` varchar(36) NOT NULL,
  `project_id` varchar(36) NOT NULL,
  `normalized_hash` varchar(64) NOT NULL,
  `question` text NOT NULL,
  `created_by` varchar(36) NOT NULL,
  `created_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT `project_questions_pk` PRIMARY KEY (`id`),
  CONSTRAINT `project_questions_project_hash_uq` UNIQUE (`project_id`,`normalized_hash`),
  CONSTRAINT `project_questions_project_fk` FOREIGN KEY (`project_id`) REFERENCES `projects` (`id`) ON DELETE CASCADE,
  CONSTRAINT `project_questions_creator_fk` FOREIGN KEY (`created_by`) REFERENCES `users` (`id`) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
--> statement-breakpoint

CREATE TABLE `platform_catalog` (
  `id` varchar(36) NOT NULL,
  `provider_code` varchar(64) NOT NULL,
  `display_name` varchar(100) NOT NULL,
  `client_type` enum('web','mobile') NOT NULL,
  `enabled` boolean NOT NULL DEFAULT false,
  `verified` boolean NOT NULL DEFAULT false,
  `supports_reasoning` boolean NOT NULL DEFAULT false,
  `supports_screenshot` boolean NOT NULL DEFAULT false,
  `supports_domestic_region` boolean NOT NULL DEFAULT false,
  `supports_overseas_region` boolean NOT NULL DEFAULT false,
  `provider_metadata` json,
  `discovered_at` datetime(3) NOT NULL,
  `verified_at` datetime(3),
  `updated_by` varchar(36),
  `created_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  CONSTRAINT `platform_catalog_pk` PRIMARY KEY (`id`),
  CONSTRAINT `platform_catalog_provider_client_uq` UNIQUE (`provider_code`,`client_type`),
  CONSTRAINT `platform_catalog_updater_fk` FOREIGN KEY (`updated_by`) REFERENCES `users` (`id`) ON DELETE SET NULL,
  KEY `platform_catalog_enabled_idx` (`enabled`,`verified`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
--> statement-breakpoint

CREATE TABLE `monitors` (
  `id` varchar(36) NOT NULL,
  `owner_id` varchar(36) NOT NULL,
  `project_id` varchar(36) NOT NULL,
  `name` varchar(120) NOT NULL,
  `status` enum('draft','active','paused','deleted') NOT NULL DEFAULT 'draft',
  `active_version_id` varchar(36),
  `schedule_type` enum('none','daily','weekly') NOT NULL DEFAULT 'none',
  `schedule_timezone` varchar(64) NOT NULL DEFAULT 'Asia/Shanghai',
  `schedule_local_time` varchar(5) NOT NULL DEFAULT '09:00',
  `schedule_weekday` int unsigned,
  `next_run_at` datetime(3),
  `last_scheduled_for` datetime(3),
  `deleted_at` datetime(3),
  `purge_after` datetime(3),
  `created_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  CONSTRAINT `monitors_pk` PRIMARY KEY (`id`),
  CONSTRAINT `monitors_owner_fk` FOREIGN KEY (`owner_id`) REFERENCES `users` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `monitors_project_fk` FOREIGN KEY (`project_id`) REFERENCES `projects` (`id`) ON DELETE CASCADE,
  KEY `monitors_owner_project_idx` (`owner_id`,`project_id`,`created_at`),
  KEY `monitors_due_idx` (`status`,`next_run_at`),
  KEY `monitors_purge_idx` (`purge_after`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
--> statement-breakpoint

CREATE TABLE `monitor_versions` (
  `id` varchar(36) NOT NULL,
  `monitor_id` varchar(36) NOT NULL,
  `project_brand_version_id` varchar(36) NOT NULL,
  `version` int unsigned NOT NULL,
  `name` varchar(120) NOT NULL,
  `brand_aliases` json NOT NULL,
  `competitors` json NOT NULL,
  `repetitions` int unsigned NOT NULL,
  `expected_attempts` int unsigned NOT NULL,
  `configuration_hash` varchar(64) NOT NULL,
  `created_by` varchar(36) NOT NULL,
  `created_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT `monitor_versions_pk` PRIMARY KEY (`id`),
  CONSTRAINT `monitor_versions_monitor_version_uq` UNIQUE (`monitor_id`,`version`),
  CONSTRAINT `monitor_versions_monitor_fk` FOREIGN KEY (`monitor_id`) REFERENCES `monitors` (`id`) ON DELETE CASCADE,
  CONSTRAINT `monitor_versions_brand_fk` FOREIGN KEY (`project_brand_version_id`) REFERENCES `project_brand_versions` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `monitor_versions_creator_fk` FOREIGN KEY (`created_by`) REFERENCES `users` (`id`) ON DELETE RESTRICT,
  KEY `monitor_versions_hash_idx` (`configuration_hash`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
--> statement-breakpoint

CREATE TABLE `monitor_questions` (
  `monitor_version_id` varchar(36) NOT NULL,
  `ordinal` int unsigned NOT NULL,
  `question_id` varchar(36) NOT NULL,
  `question_snapshot` text NOT NULL,
  CONSTRAINT `monitor_questions_pk` PRIMARY KEY (`monitor_version_id`,`ordinal`),
  CONSTRAINT `monitor_questions_version_question_uq` UNIQUE (`monitor_version_id`,`question_id`),
  CONSTRAINT `monitor_questions_version_fk` FOREIGN KEY (`monitor_version_id`) REFERENCES `monitor_versions` (`id`) ON DELETE CASCADE,
  CONSTRAINT `monitor_questions_question_fk` FOREIGN KEY (`question_id`) REFERENCES `project_questions` (`id`) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
--> statement-breakpoint

CREATE TABLE `monitor_platforms` (
  `monitor_version_id` varchar(36) NOT NULL,
  `ordinal` int unsigned NOT NULL,
  `platform_id` varchar(36) NOT NULL,
  `provider_code_snapshot` varchar(64) NOT NULL,
  `client_type` enum('web','mobile') NOT NULL,
  `mode` enum('search','reasoning_search') NOT NULL,
  `screenshot` int unsigned NOT NULL DEFAULT 1,
  `region_code` varchar(64),
  CONSTRAINT `monitor_platforms_pk` PRIMARY KEY (`monitor_version_id`,`ordinal`),
  CONSTRAINT `monitor_platforms_version_platform_uq` UNIQUE (`monitor_version_id`,`platform_id`),
  CONSTRAINT `monitor_platforms_version_fk` FOREIGN KEY (`monitor_version_id`) REFERENCES `monitor_versions` (`id`) ON DELETE CASCADE,
  CONSTRAINT `monitor_platforms_platform_fk` FOREIGN KEY (`platform_id`) REFERENCES `platform_catalog` (`id`) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
--> statement-breakpoint

CREATE TABLE `schedule_occurrences` (
  `id` varchar(36) NOT NULL,
  `monitor_id` varchar(36) NOT NULL,
  `monitor_version_id` varchar(36) NOT NULL,
  `scheduled_for` datetime(3) NOT NULL,
  `trigger` enum('scheduled','catch_up') NOT NULL,
  `run_id` varchar(36),
  `waiting_for_quota_at` datetime(3),
  `created_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT `schedule_occurrences_pk` PRIMARY KEY (`id`),
  CONSTRAINT `schedule_occurrences_monitor_time_uq` UNIQUE (`monitor_id`,`scheduled_for`),
  CONSTRAINT `schedule_occurrences_monitor_fk` FOREIGN KEY (`monitor_id`) REFERENCES `monitors` (`id`) ON DELETE CASCADE,
  CONSTRAINT `schedule_occurrences_version_fk` FOREIGN KEY (`monitor_version_id`) REFERENCES `monitor_versions` (`id`) ON DELETE RESTRICT,
  KEY `schedule_occurrences_time_idx` (`scheduled_for`),
  KEY `schedule_occurrences_quota_idx` (`waiting_for_quota_at`,`scheduled_for`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
--> statement-breakpoint

CREATE TABLE `runs` (
  `id` varchar(36) NOT NULL,
  `owner_id` varchar(36) NOT NULL,
  `project_id` varchar(36) NOT NULL,
  `project_brand_version_id` varchar(36) NOT NULL,
  `monitor_id` varchar(36) NOT NULL,
  `monitor_version_id` varchar(36) NOT NULL,
  `schedule_occurrence_id` varchar(36),
  `trigger` enum('manual','scheduled','catch_up') NOT NULL,
  `status` enum('queued','waiting_quota','running','completed','partial_completed','failed','review_required','cancelled') NOT NULL DEFAULT 'queued',
  `idempotency_key` varchar(128) NOT NULL,
  `expected_attempts` int unsigned NOT NULL,
  `completed_attempts` int unsigned NOT NULL DEFAULT 0,
  `failed_attempts` int unsigned NOT NULL DEFAULT 0,
  `stopped_attempts` int unsigned NOT NULL DEFAULT 0,
  `submitted_attempts` int unsigned NOT NULL DEFAULT 0,
  `started_at` datetime(3),
  `completed_at` datetime(3),
  `cancel_requested_at` datetime(3),
  `deleted_at` datetime(3),
  `purge_after` datetime(3),
  `created_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  CONSTRAINT `runs_pk` PRIMARY KEY (`id`),
  CONSTRAINT `runs_owner_idempotency_uq` UNIQUE (`owner_id`,`idempotency_key`),
  CONSTRAINT `runs_occurrence_uq` UNIQUE (`schedule_occurrence_id`),
  CONSTRAINT `runs_owner_fk` FOREIGN KEY (`owner_id`) REFERENCES `users` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `runs_project_fk` FOREIGN KEY (`project_id`) REFERENCES `projects` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `runs_brand_fk` FOREIGN KEY (`project_brand_version_id`) REFERENCES `project_brand_versions` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `runs_monitor_fk` FOREIGN KEY (`monitor_id`) REFERENCES `monitors` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `runs_version_fk` FOREIGN KEY (`monitor_version_id`) REFERENCES `monitor_versions` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `runs_occurrence_fk` FOREIGN KEY (`schedule_occurrence_id`) REFERENCES `schedule_occurrences` (`id`) ON DELETE SET NULL,
  KEY `runs_owner_monitor_created_idx` (`owner_id`,`monitor_id`,`created_at`),
  KEY `runs_monitor_active_idx` (`monitor_id`,`status`,`created_at`),
  KEY `runs_purge_idx` (`purge_after`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
--> statement-breakpoint

CREATE TABLE `run_metrics` (
  `run_id` varchar(36) NOT NULL,
  `effective_answers` int unsigned NOT NULL DEFAULT 0,
  `brand_mentioned_answers` int unsigned NOT NULL DEFAULT 0,
  `mention_position_sum` bigint unsigned NOT NULL DEFAULT 0,
  `mention_position_count` int unsigned NOT NULL DEFAULT 0,
  `citation_count` int unsigned NOT NULL DEFAULT 0,
  `unique_domain_count` int unsigned NOT NULL DEFAULT 0,
  `positive_count` int unsigned NOT NULL DEFAULT 0,
  `neutral_count` int unsigned NOT NULL DEFAULT 0,
  `negative_count` int unsigned NOT NULL DEFAULT 0,
  `unknown_count` int unsigned NOT NULL DEFAULT 0,
  `model_metrics` json NOT NULL,
  `competitor_metrics` json NOT NULL,
  `updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  CONSTRAINT `run_metrics_pk` PRIMARY KEY (`run_id`),
  CONSTRAINT `run_metrics_run_fk` FOREIGN KEY (`run_id`) REFERENCES `runs` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
--> statement-breakpoint

CREATE TABLE `run_metric_domains` (
  `run_id` varchar(36) NOT NULL,
  `domain` varchar(255) NOT NULL,
  `reference_count` int unsigned NOT NULL,
  CONSTRAINT `run_metric_domains_pk` PRIMARY KEY (`run_id`,`domain`),
  CONSTRAINT `run_metric_domains_run_fk` FOREIGN KEY (`run_id`) REFERENCES `runs` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
--> statement-breakpoint

CREATE TABLE `attempts` (
  `id` varchar(36) NOT NULL,
  `run_id` varchar(36) NOT NULL,
  `owner_id` varchar(36) NOT NULL,
  `monitor_question_ordinal` int unsigned NOT NULL,
  `monitor_platform_ordinal` int unsigned NOT NULL,
  `repetition` int unsigned NOT NULL,
  `question` text NOT NULL,
  `platform_id` varchar(36) NOT NULL,
  `provider_code` varchar(64) NOT NULL,
  `client_type` enum('web','mobile') NOT NULL,
  `mode` enum('search','reasoning_search') NOT NULL,
  `screenshot` int unsigned NOT NULL,
  `region_code` varchar(64),
  `status` enum('queued','submitting','submission_unknown','accepted','processing','completed','failed','stopped','error','cancelled_before_submit','review_required') NOT NULL DEFAULT 'queued',
  `consumer_task_id` varchar(64) NOT NULL,
  `provider_task_id` varchar(128),
  `provider_sub_task_id` varchar(128),
  `quota_settlement` enum('reserved','consumed','released') NOT NULL DEFAULT 'reserved',
  `error_code` varchar(64),
  `error_message` text,
  `provider_created_at_raw` bigint,
  `provider_updated_at_raw` bigint,
  `next_poll_at` datetime(3),
  `stop_requested_at` datetime(3),
  `stop_accepted` boolean,
  `submitted_at` datetime(3),
  `terminal_at` datetime(3),
  `created_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  CONSTRAINT `attempts_pk` PRIMARY KEY (`id`),
  CONSTRAINT `attempts_run_slot_uq` UNIQUE (`run_id`,`monitor_question_ordinal`,`monitor_platform_ordinal`,`repetition`),
  CONSTRAINT `attempts_consumer_task_uq` UNIQUE (`consumer_task_id`),
  CONSTRAINT `attempts_run_fk` FOREIGN KEY (`run_id`) REFERENCES `runs` (`id`) ON DELETE CASCADE,
  CONSTRAINT `attempts_owner_fk` FOREIGN KEY (`owner_id`) REFERENCES `users` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `attempts_platform_fk` FOREIGN KEY (`platform_id`) REFERENCES `platform_catalog` (`id`) ON DELETE RESTRICT,
  KEY `attempts_provider_task_idx` (`provider_task_id`),
  KEY `attempts_run_status_idx` (`run_id`,`status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
--> statement-breakpoint

CREATE TABLE `result_revisions` (
  `id` varchar(36) NOT NULL,
  `attempt_id` varchar(36) NOT NULL,
  `revision` int unsigned NOT NULL,
  `content_hash` varchar(64) NOT NULL,
  `normalized_payload` json NOT NULL,
  `raw_object_key` varchar(1024),
  `provider_updated_at_raw` bigint,
  `created_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT `result_revisions_pk` PRIMARY KEY (`id`),
  CONSTRAINT `result_revisions_attempt_revision_uq` UNIQUE (`attempt_id`,`revision`),
  CONSTRAINT `result_revisions_attempt_hash_uq` UNIQUE (`attempt_id`,`content_hash`),
  CONSTRAINT `result_revisions_attempt_fk` FOREIGN KEY (`attempt_id`) REFERENCES `attempts` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
--> statement-breakpoint

CREATE TABLE `attempt_results` (
  `attempt_id` varchar(36) NOT NULL,
  `current_revision_id` varchar(36) NOT NULL,
  `revision` int unsigned NOT NULL,
  `content_hash` varchar(64) NOT NULL,
  `answer_markdown` longtext NOT NULL,
  `reasoning_markdown` longtext,
  `search_keywords` json NOT NULL,
  `sentiment` enum('positive','neutral','negative','unknown') NOT NULL DEFAULT 'unknown',
  `brand_mentioned` boolean NOT NULL DEFAULT false,
  `mention_position` int unsigned,
  `competitor_rankings` json NOT NULL,
  `keyword_evaluations` json NOT NULL,
  `category_ranking` json,
  `provider_amount` decimal(14,4),
  `created_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  CONSTRAINT `attempt_results_pk` PRIMARY KEY (`attempt_id`),
  CONSTRAINT `attempt_results_attempt_fk` FOREIGN KEY (`attempt_id`) REFERENCES `attempts` (`id`) ON DELETE CASCADE,
  CONSTRAINT `attempt_results_revision_fk` FOREIGN KEY (`current_revision_id`) REFERENCES `result_revisions` (`id`) ON DELETE RESTRICT,
  KEY `attempt_results_sentiment_idx` (`sentiment`),
  KEY `attempt_results_mention_idx` (`brand_mentioned`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
--> statement-breakpoint

CREATE TABLE `result_sources` (
  `id` varchar(36) NOT NULL,
  `revision_id` varchar(36) NOT NULL,
  `ordinal` int unsigned NOT NULL,
  `url` text NOT NULL,
  `canonical_url_hash` varchar(64) NOT NULL,
  `title` text NOT NULL,
  `domain` varchar(255) NOT NULL,
  `cited_text` text,
  `created_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT `result_sources_pk` PRIMARY KEY (`id`),
  CONSTRAINT `result_sources_revision_ordinal_uq` UNIQUE (`revision_id`,`ordinal`),
  CONSTRAINT `result_sources_revision_fk` FOREIGN KEY (`revision_id`) REFERENCES `result_revisions` (`id`) ON DELETE CASCADE,
  KEY `result_sources_domain_idx` (`domain`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
--> statement-breakpoint

CREATE TABLE `result_media` (
  `id` varchar(36) NOT NULL,
  `revision_id` varchar(36) NOT NULL,
  `type` enum('screenshot','image','video','goods','raw_response') NOT NULL,
  `ordinal` int unsigned NOT NULL,
  `source_url` text,
  `object_key` varchar(1024),
  `thumbnail_object_key` varchar(1024),
  `content_hash` varchar(64),
  `mime_type` varchar(128),
  `size_bytes` bigint unsigned,
  `archive_status` enum('pending','archived','failed','not_applicable') NOT NULL DEFAULT 'pending',
  `archive_error` text,
  `created_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  CONSTRAINT `result_media_pk` PRIMARY KEY (`id`),
  CONSTRAINT `result_media_revision_type_ordinal_uq` UNIQUE (`revision_id`,`type`,`ordinal`),
  CONSTRAINT `result_media_revision_fk` FOREIGN KEY (`revision_id`) REFERENCES `result_revisions` (`id`) ON DELETE CASCADE,
  KEY `result_media_archive_idx` (`archive_status`,`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
--> statement-breakpoint

CREATE TABLE `quota_wallets` (
  `user_id` varchar(36) NOT NULL,
  `granted_units` bigint unsigned NOT NULL DEFAULT 0,
  `consumed_units` bigint unsigned NOT NULL DEFAULT 0,
  `reserved_units` bigint unsigned NOT NULL DEFAULT 0,
  `updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  CONSTRAINT `quota_wallets_pk` PRIMARY KEY (`user_id`),
  CONSTRAINT `quota_wallets_user_fk` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
--> statement-breakpoint

CREATE TABLE `quota_reservations` (
  `id` varchar(36) NOT NULL,
  `user_id` varchar(36) NOT NULL,
  `run_id` varchar(36) NOT NULL,
  `total_units` int unsigned NOT NULL,
  `consumed_units` int unsigned NOT NULL DEFAULT 0,
  `released_units` int unsigned NOT NULL DEFAULT 0,
  `status` enum('active','settled') NOT NULL DEFAULT 'active',
  `created_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  CONSTRAINT `quota_reservations_pk` PRIMARY KEY (`id`),
  CONSTRAINT `quota_reservations_run_uq` UNIQUE (`run_id`),
  CONSTRAINT `quota_reservations_user_fk` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `quota_reservations_run_fk` FOREIGN KEY (`run_id`) REFERENCES `runs` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `quota_reservations_settlement_ck` CHECK (`consumed_units` + `released_units` <= `total_units`),
  KEY `quota_reservations_user_status_idx` (`user_id`,`status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
--> statement-breakpoint

CREATE TABLE `quota_ledger` (
  `id` varchar(36) NOT NULL,
  `user_id` varchar(36) NOT NULL,
  `type` enum('grant','adjust','reserve','consume','release') NOT NULL,
  `units` bigint NOT NULL,
  `idempotency_key` varchar(160) NOT NULL,
  `reservation_id` varchar(36),
  `attempt_id` varchar(36),
  `actor_id` varchar(36),
  `reason` varchar(240),
  `metadata` json,
  `created_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT `quota_ledger_pk` PRIMARY KEY (`id`),
  CONSTRAINT `quota_ledger_idempotency_uq` UNIQUE (`idempotency_key`),
  CONSTRAINT `quota_ledger_user_fk` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `quota_ledger_reservation_fk` FOREIGN KEY (`reservation_id`) REFERENCES `quota_reservations` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `quota_ledger_attempt_fk` FOREIGN KEY (`attempt_id`) REFERENCES `attempts` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `quota_ledger_actor_fk` FOREIGN KEY (`actor_id`) REFERENCES `users` (`id`) ON DELETE SET NULL,
  KEY `quota_ledger_user_created_idx` (`user_id`,`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
--> statement-breakpoint

CREATE TABLE `jobs` (
  `id` varchar(36) NOT NULL,
  `type` enum('submit_attempt','stop_attempt','poll_attempt','fetch_result','archive_media','schedule_catch_up','dispatch_occurrences','purge_soft_deleted','reconcile_billing','sync_provider_catalog') NOT NULL,
  `status` enum('ready','leased','retry_wait','succeeded','dead') NOT NULL DEFAULT 'ready',
  `dedupe_key` varchar(191) NOT NULL,
  `payload` json NOT NULL,
  `available_at` datetime(3) NOT NULL,
  `lease_owner` varchar(128),
  `lease_expires_at` datetime(3),
  `attempts` int unsigned NOT NULL DEFAULT 0,
  `max_attempts` int unsigned NOT NULL DEFAULT 20,
  `last_error_code` varchar(64),
  `last_error_message` text,
  `completed_at` datetime(3),
  `created_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  CONSTRAINT `jobs_pk` PRIMARY KEY (`id`),
  CONSTRAINT `jobs_dedupe_uq` UNIQUE (`dedupe_key`),
  KEY `jobs_claim_idx` (`status`,`available_at`,`lease_expires_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
--> statement-breakpoint

CREATE TABLE `provider_costs` (
  `id` varchar(36) NOT NULL,
  `attempt_id` varchar(36),
  `provider_task_id` varchar(128) NOT NULL,
  `amount` decimal(14,4) NOT NULL,
  `currency` varchar(3) NOT NULL DEFAULT 'CNY',
  `provider_record_id` varchar(128),
  `occurred_at` datetime(3) NOT NULL,
  `raw_metadata` json,
  `reconciled_at` datetime(3),
  `created_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT `provider_costs_pk` PRIMARY KEY (`id`),
  CONSTRAINT `provider_costs_record_uq` UNIQUE (`provider_record_id`),
  CONSTRAINT `provider_costs_attempt_fk` FOREIGN KEY (`attempt_id`) REFERENCES `attempts` (`id`) ON DELETE RESTRICT,
  KEY `provider_costs_task_idx` (`provider_task_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
--> statement-breakpoint

CREATE TABLE `audit_logs` (
  `id` varchar(36) NOT NULL,
  `actor_id` varchar(36),
  `actor_role` enum('user','admin'),
  `action` varchar(120) NOT NULL,
  `target_type` varchar(64) NOT NULL,
  `target_id_hash` varchar(64),
  `owner_id` varchar(36),
  `ip_hash` varchar(64),
  `metadata` json,
  `created_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT `audit_logs_pk` PRIMARY KEY (`id`),
  CONSTRAINT `audit_logs_actor_fk` FOREIGN KEY (`actor_id`) REFERENCES `users` (`id`) ON DELETE SET NULL,
  CONSTRAINT `audit_logs_owner_fk` FOREIGN KEY (`owner_id`) REFERENCES `users` (`id`) ON DELETE SET NULL,
  KEY `audit_logs_actor_created_idx` (`actor_id`,`created_at`),
  KEY `audit_logs_action_created_idx` (`action`,`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
--> statement-breakpoint

CREATE TABLE `provider_task_tombstones` (
  `provider_task_hash` varchar(64) NOT NULL,
  `deleted_entity_type` varchar(32) NOT NULL,
  `deleted_entity_id_hash` varchar(64) NOT NULL,
  `expires_at` datetime(3) NOT NULL,
  `created_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT `provider_task_tombstones_pk` PRIMARY KEY (`provider_task_hash`),
  KEY `provider_task_tombstones_expiry_idx` (`expires_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
--> statement-breakpoint

CREATE TABLE `worker_heartbeats` (
  `worker_id` varchar(128) NOT NULL,
  `heartbeat_at` datetime(3) NOT NULL,
  `created_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  CONSTRAINT `worker_heartbeats_pk` PRIMARY KEY (`worker_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
--> statement-breakpoint

CREATE TABLE `provider_dispatch_days` (
  `day_key` varchar(10) NOT NULL,
  `dispatched` int unsigned NOT NULL DEFAULT 0,
  `updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  CONSTRAINT `provider_dispatch_days_pk` PRIMARY KEY (`day_key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
--> statement-breakpoint

CREATE TABLE `provider_dispatch_slots` (
  `attempt_id` varchar(36) NOT NULL,
  `day_key` varchar(10) NOT NULL,
  `acquired_at` datetime(3) NOT NULL,
  CONSTRAINT `provider_dispatch_slots_pk` PRIMARY KEY (`attempt_id`),
  CONSTRAINT `provider_dispatch_slots_attempt_fk` FOREIGN KEY (`attempt_id`) REFERENCES `attempts` (`id`) ON DELETE CASCADE,
  KEY `provider_dispatch_slots_day_idx` (`day_key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
--> statement-breakpoint

CREATE TABLE `provider_submission_gate` (
  `id` varchar(32) NOT NULL,
  `next_allowed_at` datetime(3) NOT NULL,
  `updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  CONSTRAINT `provider_submission_gate_pk` PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
--> statement-breakpoint

CREATE TABLE `provider_observations` (
  `id` varchar(36) NOT NULL,
  `attempt_id` varchar(36) NOT NULL,
  `type` enum('submission','status','stop','failure') NOT NULL,
  `status` varchar(64),
  `payload` json,
  `observed_at` datetime(3) NOT NULL,
  `created_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT `provider_observations_pk` PRIMARY KEY (`id`),
  CONSTRAINT `provider_observations_attempt_fk` FOREIGN KEY (`attempt_id`) REFERENCES `attempts` (`id`) ON DELETE CASCADE,
  KEY `provider_observations_attempt_idx` (`attempt_id`,`observed_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
--> statement-breakpoint

CREATE TABLE `provider_regions` (
  `code` varchar(64) NOT NULL,
  `scope` enum('domestic','overseas') NOT NULL,
  `name` varchar(120) NOT NULL,
  `provider_metadata` json NOT NULL,
  `synced_at` datetime(3) NOT NULL,
  CONSTRAINT `provider_regions_pk` PRIMARY KEY (`code`,`scope`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
--> statement-breakpoint

CREATE TABLE `provider_reconciliation_state` (
  `id` varchar(32) NOT NULL,
  `cursor` json NOT NULL,
  `balance` json,
  `summary` json,
  `reconciled_at` datetime(3),
  `updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  CONSTRAINT `provider_reconciliation_state_pk` PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
--> statement-breakpoint

CREATE TABLE `daily_run_aggregates` (
  `owner_id` varchar(36) NOT NULL,
  `monitor_id` varchar(36) NOT NULL,
  `monitor_version_id` varchar(36) NOT NULL,
  `aggregate_date` datetime NOT NULL,
  `total_answers` int unsigned NOT NULL DEFAULT 0,
  `brand_mentions` int unsigned NOT NULL DEFAULT 0,
  `citation_count` int unsigned NOT NULL DEFAULT 0,
  `unique_domain_count` int unsigned NOT NULL DEFAULT 0,
  `positive_count` int unsigned NOT NULL DEFAULT 0,
  `neutral_count` int unsigned NOT NULL DEFAULT 0,
  `negative_count` int unsigned NOT NULL DEFAULT 0,
  `unknown_count` int unsigned NOT NULL DEFAULT 0,
  `metrics` json NOT NULL,
  `updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  CONSTRAINT `daily_run_aggregates_pk` PRIMARY KEY (`monitor_id`,`monitor_version_id`,`aggregate_date`),
  CONSTRAINT `daily_run_aggregates_owner_fk` FOREIGN KEY (`owner_id`) REFERENCES `users` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `daily_run_aggregates_monitor_fk` FOREIGN KEY (`monitor_id`) REFERENCES `monitors` (`id`) ON DELETE CASCADE,
  CONSTRAINT `daily_run_aggregates_version_fk` FOREIGN KEY (`monitor_version_id`) REFERENCES `monitor_versions` (`id`) ON DELETE RESTRICT,
  KEY `daily_run_aggregates_owner_date_idx` (`owner_id`,`aggregate_date`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
