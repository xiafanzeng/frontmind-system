-- Unified Dashboard migration for monitoring domain tables.
-- Monitoring authentication is disabled at the HTTP boundary; these renamed
-- projection tables remain only for repository compatibility and are never
-- exposed as a second login/session system.
-- Source: 0000_frontmind_monitoring.sql
CREATE TABLE `monitoring_users` (
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
-- Source: 0000_frontmind_monitoring.sql
CREATE TABLE `monitoring_sessions` (
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
  CONSTRAINT `sessions_user_fk` FOREIGN KEY (`user_id`) REFERENCES `monitoring_users` (`id`) ON DELETE CASCADE,
  KEY `sessions_user_active_idx` (`user_id`,`revoked_at`,`expires_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
--> statement-breakpoint
-- Source: 0000_frontmind_monitoring.sql
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
  CONSTRAINT `projects_owner_fk` FOREIGN KEY (`owner_id`) REFERENCES `monitoring_users` (`id`) ON DELETE RESTRICT,
  KEY `projects_owner_created_idx` (`owner_id`,`created_at`),
  KEY `projects_purge_idx` (`purge_after`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
--> statement-breakpoint
-- Source: 0000_frontmind_monitoring.sql
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
  CONSTRAINT `project_brand_versions_creator_fk` FOREIGN KEY (`created_by`) REFERENCES `monitoring_users` (`id`) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
--> statement-breakpoint
-- Source: 0000_frontmind_monitoring.sql
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
  CONSTRAINT `project_questions_creator_fk` FOREIGN KEY (`created_by`) REFERENCES `monitoring_users` (`id`) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
--> statement-breakpoint
-- Source: 0000_frontmind_monitoring.sql
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
  CONSTRAINT `platform_catalog_updater_fk` FOREIGN KEY (`updated_by`) REFERENCES `monitoring_users` (`id`) ON DELETE SET NULL,
  KEY `platform_catalog_enabled_idx` (`enabled`,`verified`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
--> statement-breakpoint
-- Source: 0000_frontmind_monitoring.sql
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
  CONSTRAINT `monitors_owner_fk` FOREIGN KEY (`owner_id`) REFERENCES `monitoring_users` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `monitors_project_fk` FOREIGN KEY (`project_id`) REFERENCES `projects` (`id`) ON DELETE CASCADE,
  KEY `monitors_owner_project_idx` (`owner_id`,`project_id`,`created_at`),
  KEY `monitors_due_idx` (`status`,`next_run_at`),
  KEY `monitors_purge_idx` (`purge_after`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
--> statement-breakpoint
-- Source: 0000_frontmind_monitoring.sql
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
  CONSTRAINT `monitor_versions_creator_fk` FOREIGN KEY (`created_by`) REFERENCES `monitoring_users` (`id`) ON DELETE RESTRICT,
  KEY `monitor_versions_hash_idx` (`configuration_hash`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
--> statement-breakpoint
-- Source: 0000_frontmind_monitoring.sql
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
-- Source: 0000_frontmind_monitoring.sql
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
-- Source: 0000_frontmind_monitoring.sql
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
-- Source: 0000_frontmind_monitoring.sql
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
  CONSTRAINT `runs_owner_fk` FOREIGN KEY (`owner_id`) REFERENCES `monitoring_users` (`id`) ON DELETE RESTRICT,
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
-- Source: 0000_frontmind_monitoring.sql
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
-- Source: 0000_frontmind_monitoring.sql
CREATE TABLE `run_metric_domains` (
  `run_id` varchar(36) NOT NULL,
  `domain` varchar(255) NOT NULL,
  `reference_count` int unsigned NOT NULL,
  CONSTRAINT `run_metric_domains_pk` PRIMARY KEY (`run_id`,`domain`),
  CONSTRAINT `run_metric_domains_run_fk` FOREIGN KEY (`run_id`) REFERENCES `runs` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
--> statement-breakpoint
-- Source: 0000_frontmind_monitoring.sql
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
  CONSTRAINT `attempts_owner_fk` FOREIGN KEY (`owner_id`) REFERENCES `monitoring_users` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `attempts_platform_fk` FOREIGN KEY (`platform_id`) REFERENCES `platform_catalog` (`id`) ON DELETE RESTRICT,
  KEY `attempts_provider_task_idx` (`provider_task_id`),
  KEY `attempts_run_status_idx` (`run_id`,`status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
--> statement-breakpoint
-- Source: 0000_frontmind_monitoring.sql
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
-- Source: 0000_frontmind_monitoring.sql
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
-- Source: 0000_frontmind_monitoring.sql
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
-- Source: 0000_frontmind_monitoring.sql
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
-- Source: 0000_frontmind_monitoring.sql
CREATE TABLE `quota_wallets` (
  `user_id` varchar(36) NOT NULL,
  `granted_units` bigint unsigned NOT NULL DEFAULT 0,
  `consumed_units` bigint unsigned NOT NULL DEFAULT 0,
  `reserved_units` bigint unsigned NOT NULL DEFAULT 0,
  `updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  CONSTRAINT `quota_wallets_pk` PRIMARY KEY (`user_id`),
  CONSTRAINT `quota_wallets_user_fk` FOREIGN KEY (`user_id`) REFERENCES `monitoring_users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
--> statement-breakpoint
-- Source: 0000_frontmind_monitoring.sql
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
  CONSTRAINT `quota_reservations_user_fk` FOREIGN KEY (`user_id`) REFERENCES `monitoring_users` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `quota_reservations_run_fk` FOREIGN KEY (`run_id`) REFERENCES `runs` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `quota_reservations_settlement_ck` CHECK (`consumed_units` + `released_units` <= `total_units`),
  KEY `quota_reservations_user_status_idx` (`user_id`,`status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
--> statement-breakpoint
-- Source: 0000_frontmind_monitoring.sql
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
  CONSTRAINT `quota_ledger_user_fk` FOREIGN KEY (`user_id`) REFERENCES `monitoring_users` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `quota_ledger_reservation_fk` FOREIGN KEY (`reservation_id`) REFERENCES `quota_reservations` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `quota_ledger_attempt_fk` FOREIGN KEY (`attempt_id`) REFERENCES `attempts` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `quota_ledger_actor_fk` FOREIGN KEY (`actor_id`) REFERENCES `monitoring_users` (`id`) ON DELETE SET NULL,
  KEY `quota_ledger_user_created_idx` (`user_id`,`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
--> statement-breakpoint
-- Source: 0000_frontmind_monitoring.sql
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
-- Source: 0000_frontmind_monitoring.sql
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
-- Source: 0000_frontmind_monitoring.sql
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
  CONSTRAINT `audit_logs_actor_fk` FOREIGN KEY (`actor_id`) REFERENCES `monitoring_users` (`id`) ON DELETE SET NULL,
  CONSTRAINT `audit_logs_owner_fk` FOREIGN KEY (`owner_id`) REFERENCES `monitoring_users` (`id`) ON DELETE SET NULL,
  KEY `audit_logs_actor_created_idx` (`actor_id`,`created_at`),
  KEY `audit_logs_action_created_idx` (`action`,`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
--> statement-breakpoint
-- Source: 0000_frontmind_monitoring.sql
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
-- Source: 0000_frontmind_monitoring.sql
CREATE TABLE `worker_heartbeats` (
  `worker_id` varchar(128) NOT NULL,
  `heartbeat_at` datetime(3) NOT NULL,
  `created_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  CONSTRAINT `worker_heartbeats_pk` PRIMARY KEY (`worker_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
--> statement-breakpoint
-- Source: 0000_frontmind_monitoring.sql
CREATE TABLE `provider_dispatch_days` (
  `day_key` varchar(10) NOT NULL,
  `dispatched` int unsigned NOT NULL DEFAULT 0,
  `updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  CONSTRAINT `provider_dispatch_days_pk` PRIMARY KEY (`day_key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
--> statement-breakpoint
-- Source: 0000_frontmind_monitoring.sql
CREATE TABLE `provider_dispatch_slots` (
  `attempt_id` varchar(36) NOT NULL,
  `day_key` varchar(10) NOT NULL,
  `acquired_at` datetime(3) NOT NULL,
  CONSTRAINT `provider_dispatch_slots_pk` PRIMARY KEY (`attempt_id`),
  CONSTRAINT `provider_dispatch_slots_attempt_fk` FOREIGN KEY (`attempt_id`) REFERENCES `attempts` (`id`) ON DELETE CASCADE,
  KEY `provider_dispatch_slots_day_idx` (`day_key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
--> statement-breakpoint
-- Source: 0000_frontmind_monitoring.sql
CREATE TABLE `provider_submission_gate` (
  `id` varchar(32) NOT NULL,
  `next_allowed_at` datetime(3) NOT NULL,
  `updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  CONSTRAINT `provider_submission_gate_pk` PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
--> statement-breakpoint
-- Source: 0000_frontmind_monitoring.sql
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
-- Source: 0000_frontmind_monitoring.sql
CREATE TABLE `provider_regions` (
  `code` varchar(64) NOT NULL,
  `scope` enum('domestic','overseas') NOT NULL,
  `name` varchar(120) NOT NULL,
  `provider_metadata` json NOT NULL,
  `synced_at` datetime(3) NOT NULL,
  CONSTRAINT `provider_regions_pk` PRIMARY KEY (`code`,`scope`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
--> statement-breakpoint
-- Source: 0000_frontmind_monitoring.sql
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
-- Source: 0000_frontmind_monitoring.sql
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
  CONSTRAINT `daily_run_aggregates_owner_fk` FOREIGN KEY (`owner_id`) REFERENCES `monitoring_users` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `daily_run_aggregates_monitor_fk` FOREIGN KEY (`monitor_id`) REFERENCES `monitors` (`id`) ON DELETE CASCADE,
  CONSTRAINT `daily_run_aggregates_version_fk` FOREIGN KEY (`monitor_version_id`) REFERENCES `monitor_versions` (`id`) ON DELETE RESTRICT,
  KEY `daily_run_aggregates_owner_date_idx` (`owner_id`,`aggregate_date`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
--> statement-breakpoint
-- Source: 0001_result_discovered_sources.sql
CREATE TABLE `result_discovered_sources` (
	`id` varchar(36) NOT NULL,
	`revision_id` varchar(36) NOT NULL,
	`ordinal` int unsigned NOT NULL,
	`url` text NOT NULL,
	`canonical_url_hash` varchar(64) NOT NULL,
	`title` text NOT NULL,
	`domain` varchar(255) NOT NULL,
	`site_name` varchar(255),
	`summary` text,
	`published_at` varchar(10),
	`provider_icon_url` text,
	`is_cited` boolean NOT NULL DEFAULT false,
	`created_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `result_discovered_sources_id` PRIMARY KEY(`id`),
	CONSTRAINT `result_discovered_sources_revision_ordinal_uq` UNIQUE(`revision_id`,`ordinal`),
	CONSTRAINT `result_discovered_sources_revision_url_uq` UNIQUE(`revision_id`,`canonical_url_hash`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
--> statement-breakpoint
-- Source: 0001_result_discovered_sources.sql
ALTER TABLE `result_discovered_sources` ADD CONSTRAINT `result_discovered_sources_revision_id_result_revisions_id_fk` FOREIGN KEY (`revision_id`) REFERENCES `result_revisions`(`id`) ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
-- Source: 0001_result_discovered_sources.sql
CREATE INDEX `result_discovered_sources_revision_cited_idx` ON `result_discovered_sources` (`revision_id`,`is_cited`);
--> statement-breakpoint
-- Source: 0001_result_discovered_sources.sql
CREATE INDEX `result_discovered_sources_domain_idx` ON `result_discovered_sources` (`domain`);
--> statement-breakpoint
-- Source: 0002_provider_source_positions.sql
ALTER TABLE `result_discovered_sources` ADD `provider_position` int unsigned AFTER `ordinal`;
--> statement-breakpoint
-- Source: 0002_provider_source_positions.sql
ALTER TABLE `result_sources` ADD `provider_position` int unsigned AFTER `ordinal`;
--> statement-breakpoint
-- Source: 0003_money_billing.sql
CREATE TABLE `attempt_money_settlements` (
	`attempt_id` varchar(36) NOT NULL,
	`reservation_id` varchar(36) NOT NULL,
	`status` enum('reserved','consumed','released') NOT NULL DEFAULT 'reserved',
	`settled_ten_thousandths` bigint unsigned NOT NULL DEFAULT 0,
	`settled_at` datetime(3),
	`updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
	CONSTRAINT `attempt_money_settlements_attempt_id` PRIMARY KEY(`attempt_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
--> statement-breakpoint
-- Source: 0003_money_billing.sql
CREATE TABLE `attempt_price_snapshots` (
	`attempt_id` varchar(36) NOT NULL,
	`pricing_version_id` varchar(36) NOT NULL,
	`pricing_item_id` varchar(36) NOT NULL,
	`pricing_class` enum('domestic','overseas') NOT NULL,
	`mode` enum('search','reasoning_search') NOT NULL,
	`screenshot_enabled` boolean NOT NULL,
	`amount_ten_thousandths` bigint unsigned NOT NULL,
	`currency` varchar(3) NOT NULL DEFAULT 'CNY',
	`created_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `attempt_price_snapshots_attempt_id` PRIMARY KEY(`attempt_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
--> statement-breakpoint
-- Source: 0003_money_billing.sql
CREATE TABLE `bank_transfer_reviews` (
	`id` varchar(36) NOT NULL,
	`order_id` varchar(36) NOT NULL,
	`status` enum('pending','approved','rejected') NOT NULL DEFAULT 'pending',
	`remittance_reference` varchar(191) NOT NULL,
	`payer_name` varchar(120) NOT NULL,
	`transferred_at` datetime(3) NOT NULL,
	`evidence_object_key` varchar(1024),
	`submitted_at` datetime(3) NOT NULL,
	`reviewed_by` varchar(36),
	`review_reason` varchar(240),
	`reviewed_at` datetime(3),
	`created_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
	CONSTRAINT `bank_transfer_reviews_id` PRIMARY KEY(`id`),
	CONSTRAINT `bank_transfer_reviews_order_uq` UNIQUE(`order_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
--> statement-breakpoint
-- Source: 0003_money_billing.sql
CREATE TABLE `money_ledger` (
	`id` varchar(36) NOT NULL,
	`user_id` varchar(36) NOT NULL,
	`type` enum('topup','admin_adjustment','reserve','consume','release') NOT NULL,
	`balance_delta_ten_thousandths` bigint NOT NULL,
	`reserved_delta_ten_thousandths` bigint NOT NULL,
	`balance_after_ten_thousandths` bigint NOT NULL,
	`reserved_after_ten_thousandths` bigint unsigned NOT NULL,
	`idempotency_key` varchar(191) NOT NULL,
	`reservation_id` varchar(36),
	`attempt_id` varchar(36),
	`actor_id` varchar(36),
	`reference_type` varchar(40),
	`reference_id` varchar(128),
	`reason` varchar(240) NOT NULL,
	`metadata` json,
	`created_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `money_ledger_id` PRIMARY KEY(`id`),
	CONSTRAINT `money_ledger_idempotency_uq` UNIQUE(`idempotency_key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
--> statement-breakpoint
-- Source: 0003_money_billing.sql
CREATE TABLE `money_reservations` (
	`id` varchar(36) NOT NULL,
	`user_id` varchar(36) NOT NULL,
	`run_id` varchar(36),
	`total_ten_thousandths` bigint unsigned NOT NULL,
	`consumed_ten_thousandths` bigint unsigned NOT NULL DEFAULT 0,
	`released_ten_thousandths` bigint unsigned NOT NULL DEFAULT 0,
	`status` enum('active','settled') NOT NULL DEFAULT 'active',
	`created_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
	CONSTRAINT `money_reservations_id` PRIMARY KEY(`id`),
	CONSTRAINT `money_reservations_run_uq` UNIQUE(`run_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
--> statement-breakpoint
-- Source: 0003_money_billing.sql
CREATE TABLE `money_wallets` (
	`user_id` varchar(36) NOT NULL,
	`currency` varchar(3) NOT NULL DEFAULT 'CNY',
	`balance_ten_thousandths` bigint NOT NULL DEFAULT 0,
	`reserved_ten_thousandths` bigint unsigned NOT NULL DEFAULT 0,
	`spent_ten_thousandths` bigint unsigned NOT NULL DEFAULT 0,
	`updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
	CONSTRAINT `money_wallets_user_id` PRIMARY KEY(`user_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
--> statement-breakpoint
-- Source: 0003_money_billing.sql
CREATE TABLE `pricing_items` (
	`id` varchar(36) NOT NULL,
	`pricing_version_id` varchar(36) NOT NULL,
	`pricing_class` enum('domestic','overseas') NOT NULL,
	`mode` enum('search','reasoning_search') NOT NULL,
	`screenshot_enabled` boolean NOT NULL,
	`amount_ten_thousandths` bigint unsigned NOT NULL,
	`created_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `pricing_items_id` PRIMARY KEY(`id`),
	CONSTRAINT `pricing_items_version_dimensions_uq` UNIQUE(`pricing_version_id`,`pricing_class`,`mode`,`screenshot_enabled`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
--> statement-breakpoint
-- Source: 0003_money_billing.sql
CREATE TABLE `pricing_versions` (
	`id` varchar(36) NOT NULL,
	`code` varchar(100) NOT NULL,
	`status` enum('active','retired') NOT NULL DEFAULT 'active',
	`currency` varchar(3) NOT NULL DEFAULT 'CNY',
	`source_url` text NOT NULL,
	`effective_from` datetime(3) NOT NULL,
	`retired_at` datetime(3),
	`created_by` varchar(36),
	`created_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `pricing_versions_id` PRIMARY KEY(`id`),
	CONSTRAINT `pricing_versions_code_uq` UNIQUE(`code`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
--> statement-breakpoint
-- Source: 0003_money_billing.sql
CREATE TABLE `topup_orders` (
	`id` varchar(36) NOT NULL,
	`provider_order_id` varchar(128) NOT NULL,
	`replaces_order_id` varchar(36),
	`user_id` varchar(36) NOT NULL,
	`idempotency_key` varchar(128) NOT NULL,
	`payment_method` enum('alipay','wxpay','bank_transfer') NOT NULL,
	`amount_ten_thousandths` bigint unsigned NOT NULL,
	`currency` varchar(3) NOT NULL DEFAULT 'CNY',
	`state` enum('pending','review_required','paid','credited','expired','cancelled','rejected') NOT NULL DEFAULT 'pending',
	`callback_token_digest` varchar(64) NOT NULL,
	`checkout_expires_at` datetime(3) NOT NULL,
	`paid_at` datetime(3),
	`credited_at` datetime(3),
	`created_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
	CONSTRAINT `topup_orders_id` PRIMARY KEY(`id`),
	CONSTRAINT `topup_orders_provider_order_uq` UNIQUE(`provider_order_id`),
	CONSTRAINT `topup_orders_replaces_order_uq` UNIQUE(`replaces_order_id`),
	CONSTRAINT `topup_orders_user_idempotency_uq` UNIQUE(`user_id`,`idempotency_key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
--> statement-breakpoint
-- Source: 0003_money_billing.sql
CREATE TABLE `topup_receipts` (
	`id` varchar(36) NOT NULL,
	`order_id` varchar(36) NOT NULL,
	`provider` enum('zpay','bank') NOT NULL,
	`provider_trade_no` varchar(191) NOT NULL,
	`amount_ten_thousandths` bigint unsigned NOT NULL,
	`paid_at` datetime(3) NOT NULL,
	`payload_digest` varchar(64) NOT NULL,
	`received_at` datetime(3) NOT NULL,
	`created_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `topup_receipts_id` PRIMARY KEY(`id`),
	CONSTRAINT `topup_receipts_order_uq` UNIQUE(`order_id`),
	CONSTRAINT `topup_receipts_provider_trade_uq` UNIQUE(`provider`,`provider_trade_no`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
--> statement-breakpoint
-- Source: 0003_money_billing.sql
ALTER TABLE `platform_catalog` ADD `pricing_class` enum('domestic','overseas') AFTER `client_type`;
--> statement-breakpoint
-- Source: 0003_money_billing.sql
ALTER TABLE `attempt_money_settlements` ADD CONSTRAINT `attempt_money_settlements_attempt_id_attempts_id_fk` FOREIGN KEY (`attempt_id`) REFERENCES `attempts`(`id`) ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
-- Source: 0003_money_billing.sql
ALTER TABLE `attempt_money_settlements` ADD CONSTRAINT `attempt_money_settlements_reservation_fk` FOREIGN KEY (`reservation_id`) REFERENCES `money_reservations`(`id`) ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
-- Source: 0003_money_billing.sql
ALTER TABLE `attempt_price_snapshots` ADD CONSTRAINT `attempt_price_snapshots_attempt_id_attempts_id_fk` FOREIGN KEY (`attempt_id`) REFERENCES `attempts`(`id`) ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
-- Source: 0003_money_billing.sql
ALTER TABLE `attempt_price_snapshots` ADD CONSTRAINT `attempt_price_snapshots_pricing_version_fk` FOREIGN KEY (`pricing_version_id`) REFERENCES `pricing_versions`(`id`) ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
-- Source: 0003_money_billing.sql
ALTER TABLE `attempt_price_snapshots` ADD CONSTRAINT `attempt_price_snapshots_pricing_item_id_pricing_items_id_fk` FOREIGN KEY (`pricing_item_id`) REFERENCES `pricing_items`(`id`) ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
-- Source: 0003_money_billing.sql
ALTER TABLE `bank_transfer_reviews` ADD CONSTRAINT `bank_transfer_reviews_order_id_topup_orders_id_fk` FOREIGN KEY (`order_id`) REFERENCES `topup_orders`(`id`) ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
-- Source: 0003_money_billing.sql
ALTER TABLE `bank_transfer_reviews` ADD CONSTRAINT `bank_transfer_reviews_reviewed_by_users_id_fk` FOREIGN KEY (`reviewed_by`) REFERENCES `monitoring_users`(`id`) ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
-- Source: 0003_money_billing.sql
ALTER TABLE `money_ledger` ADD CONSTRAINT `money_ledger_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `monitoring_users`(`id`) ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
-- Source: 0003_money_billing.sql
ALTER TABLE `money_ledger` ADD CONSTRAINT `money_ledger_reservation_id_money_reservations_id_fk` FOREIGN KEY (`reservation_id`) REFERENCES `money_reservations`(`id`) ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
-- Source: 0003_money_billing.sql
ALTER TABLE `money_ledger` ADD CONSTRAINT `money_ledger_attempt_id_attempts_id_fk` FOREIGN KEY (`attempt_id`) REFERENCES `attempts`(`id`) ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
-- Source: 0003_money_billing.sql
ALTER TABLE `money_ledger` ADD CONSTRAINT `money_ledger_actor_id_users_id_fk` FOREIGN KEY (`actor_id`) REFERENCES `monitoring_users`(`id`) ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
-- Source: 0003_money_billing.sql
ALTER TABLE `money_reservations` ADD CONSTRAINT `money_reservations_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `monitoring_users`(`id`) ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
-- Source: 0003_money_billing.sql
ALTER TABLE `money_reservations` ADD CONSTRAINT `money_reservations_run_id_runs_id_fk` FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
-- Source: 0003_money_billing.sql
ALTER TABLE `money_wallets` ADD CONSTRAINT `money_wallets_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `monitoring_users`(`id`) ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
-- Source: 0003_money_billing.sql
ALTER TABLE `pricing_items` ADD CONSTRAINT `pricing_items_pricing_version_id_pricing_versions_id_fk` FOREIGN KEY (`pricing_version_id`) REFERENCES `pricing_versions`(`id`) ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
-- Source: 0003_money_billing.sql
ALTER TABLE `pricing_versions` ADD CONSTRAINT `pricing_versions_created_by_users_id_fk` FOREIGN KEY (`created_by`) REFERENCES `monitoring_users`(`id`) ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
-- Source: 0003_money_billing.sql
ALTER TABLE `topup_orders` ADD CONSTRAINT `topup_orders_replaces_order_id_topup_orders_id_fk` FOREIGN KEY (`replaces_order_id`) REFERENCES `topup_orders`(`id`) ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
-- Source: 0003_money_billing.sql
ALTER TABLE `topup_orders` ADD CONSTRAINT `topup_orders_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `monitoring_users`(`id`) ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
-- Source: 0003_money_billing.sql
ALTER TABLE `topup_receipts` ADD CONSTRAINT `topup_receipts_order_id_topup_orders_id_fk` FOREIGN KEY (`order_id`) REFERENCES `topup_orders`(`id`) ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
-- Source: 0003_money_billing.sql
CREATE INDEX `attempt_money_settlements_reservation_idx` ON `attempt_money_settlements` (`reservation_id`);
--> statement-breakpoint
-- Source: 0003_money_billing.sql
CREATE INDEX `attempt_price_snapshots_version_idx` ON `attempt_price_snapshots` (`pricing_version_id`);
--> statement-breakpoint
-- Source: 0003_money_billing.sql
CREATE INDEX `bank_transfer_reviews_status_submitted_idx` ON `bank_transfer_reviews` (`status`,`submitted_at`);
--> statement-breakpoint
-- Source: 0003_money_billing.sql
CREATE INDEX `money_ledger_user_created_idx` ON `money_ledger` (`user_id`,`created_at`);
--> statement-breakpoint
-- Source: 0003_money_billing.sql
CREATE INDEX `money_ledger_reference_idx` ON `money_ledger` (`reference_type`,`reference_id`);
--> statement-breakpoint
-- Source: 0003_money_billing.sql
CREATE INDEX `money_reservations_user_status_idx` ON `money_reservations` (`user_id`,`status`);
--> statement-breakpoint
-- Source: 0003_money_billing.sql
CREATE INDEX `pricing_versions_status_effective_idx` ON `pricing_versions` (`status`,`effective_from`);
--> statement-breakpoint
-- Source: 0003_money_billing.sql
CREATE INDEX `topup_orders_user_created_idx` ON `topup_orders` (`user_id`,`created_at`);
--> statement-breakpoint
-- Source: 0003_money_billing.sql
CREATE INDEX `topup_orders_state_expiry_idx` ON `topup_orders` (`state`,`checkout_expires_at`);
--> statement-breakpoint
-- Source: 0003_money_billing.sql
INSERT INTO `money_wallets` (`user_id`, `currency`, `balance_ten_thousandths`, `reserved_ten_thousandths`, `spent_ten_thousandths`)
SELECT `id`, 'CNY', 0, 0, 0 FROM `monitoring_users`
ON DUPLICATE KEY UPDATE `user_id` = VALUES(`user_id`);
--> statement-breakpoint
-- Source: 0003_money_billing.sql
UPDATE `platform_catalog`
SET `pricing_class` = 'domestic'
WHERE `pricing_class` IS NULL
  AND LOWER(`provider_code`) IN (
    'doubao', 'doubao_mobile',
    'yuanbao', 'yuanbao_mobile',
    'deepseek', 'deepseek_mobile',
    'qianwen', 'qianwen_mobile',
    'baiduai', 'baiduai_mobile', 'baidu_mobile',
    'kimi', 'kimi_mobile'
  );
--> statement-breakpoint
-- Source: 0003_money_billing.sql
UPDATE `platform_catalog`
SET `pricing_class` = 'overseas'
WHERE `pricing_class` IS NULL
  AND LOWER(`provider_code`) IN ('chatgpt', 'chatgpt_mobile');
--> statement-breakpoint
-- Source: 0003_money_billing.sql
INSERT INTO `pricing_versions` (`id`, `code`, `status`, `currency`, `source_url`, `effective_from`)
VALUES (
  'moli-official-2026-08-28',
  'moli-official-2026-08-28',
  'active',
  'CNY',
  'https://doc.molizhishu.com/docs/intro',
  '2026-08-28 00:00:00.000'
)
ON DUPLICATE KEY UPDATE `id` = VALUES(`id`);
--> statement-breakpoint
-- Source: 0003_money_billing.sql
INSERT INTO `pricing_items` (`id`, `pricing_version_id`, `pricing_class`, `mode`, `screenshot_enabled`, `amount_ten_thousandths`)
VALUES
  ('f0000000-0000-4000-8000-000000000001', 'moli-official-2026-08-28', 'domestic', 'search', false, 900),
  ('f0000000-0000-4000-8000-000000000002', 'moli-official-2026-08-28', 'domestic', 'search', true, 1800),
  ('f0000000-0000-4000-8000-000000000003', 'moli-official-2026-08-28', 'domestic', 'reasoning_search', false, 1800),
  ('f0000000-0000-4000-8000-000000000004', 'moli-official-2026-08-28', 'domestic', 'reasoning_search', true, 2700),
  ('f0000000-0000-4000-8000-000000000005', 'moli-official-2026-08-28', 'overseas', 'search', false, 2400),
  ('f0000000-0000-4000-8000-000000000006', 'moli-official-2026-08-28', 'overseas', 'search', true, 3200),
  ('f0000000-0000-4000-8000-000000000007', 'moli-official-2026-08-28', 'overseas', 'reasoning_search', false, 2400),
  ('f0000000-0000-4000-8000-000000000008', 'moli-official-2026-08-28', 'overseas', 'reasoning_search', true, 3200)
ON DUPLICATE KEY UPDATE `id` = VALUES(`id`);
--> statement-breakpoint
-- Source: 0004_media_publishing.sql
CREATE TABLE `media_publishing_bank_transfer_reviews` (
	`id` varchar(36) NOT NULL,
	`order_id` varchar(36) NOT NULL,
	`status` enum('pending','approved','rejected') NOT NULL DEFAULT 'pending',
	`remittance_reference` varchar(191) NOT NULL,
	`payer_name` varchar(120) NOT NULL,
	`transferred_at` datetime(3) NOT NULL,
	`evidence_object_key` varchar(1024),
	`submitted_at` datetime(3) NOT NULL,
	`reviewed_by` varchar(36),
	`review_reason` varchar(240),
	`reviewed_at` datetime(3),
	`created_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
	CONSTRAINT `media_publishing_bank_transfer_reviews_id` PRIMARY KEY(`id`),
	CONSTRAINT `media_pub_bank_reviews_order_uq` UNIQUE(`order_id`)
);
--> statement-breakpoint
-- Source: 0004_media_publishing.sql
CREATE TABLE `media_publishing_item_price_snapshots` (
	`item_id` varchar(36) NOT NULL,
	`owner_id` varchar(36) NOT NULL,
	`media_resource_id` varchar(36) NOT NULL,
	`catalog_revision` varchar(64) NOT NULL,
	`external_resource_id` varchar(128) NOT NULL,
	`amount_ten_thousandths` bigint unsigned NOT NULL,
	`currency` varchar(3) NOT NULL DEFAULT 'CNY',
	`provider_payload_hash` varchar(64) NOT NULL,
	`created_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `media_publishing_item_price_snapshots_item_id` PRIMARY KEY(`item_id`)
);
--> statement-breakpoint
-- Source: 0004_media_publishing.sql
CREATE TABLE `media_publishing_item_settlements` (
	`item_id` varchar(36) NOT NULL,
	`owner_id` varchar(36) NOT NULL,
	`reservation_id` varchar(36) NOT NULL,
	`status` enum('reserved','frozen','consumed','released') NOT NULL DEFAULT 'reserved',
	`amount_ten_thousandths` bigint unsigned NOT NULL,
	`settled_at` datetime(3),
	`updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
	CONSTRAINT `media_publishing_item_settlements_item_id` PRIMARY KEY(`item_id`)
);
--> statement-breakpoint
-- Source: 0004_media_publishing.sql
CREATE TABLE `media_publishing_ledger` (
	`id` varchar(36) NOT NULL,
	`owner_id` varchar(36) NOT NULL,
	`type` enum('topup','admin_adjustment','reserve','freeze','consume','release') NOT NULL,
	`balance_delta_ten_thousandths` bigint NOT NULL,
	`reserved_delta_ten_thousandths` bigint NOT NULL,
	`frozen_delta_ten_thousandths` bigint NOT NULL,
	`balance_after_ten_thousandths` bigint NOT NULL,
	`reserved_after_ten_thousandths` bigint unsigned NOT NULL,
	`frozen_after_ten_thousandths` bigint unsigned NOT NULL,
	`idempotency_key` varchar(191) NOT NULL,
	`reservation_id` varchar(36),
	`item_id` varchar(36),
	`actor_id` varchar(36),
	`reference_type` varchar(40),
	`reference_id` varchar(128),
	`reason` varchar(240) NOT NULL,
	`metadata` json,
	`created_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `media_publishing_ledger_id` PRIMARY KEY(`id`),
	CONSTRAINT `media_pub_ledger_idempotency_uq` UNIQUE(`idempotency_key`)
);
--> statement-breakpoint
-- Source: 0004_media_publishing.sql
CREATE TABLE `media_publishing_reservations` (
	`id` varchar(36) NOT NULL,
	`owner_id` varchar(36) NOT NULL,
	`batch_id` varchar(36) NOT NULL,
	`total_ten_thousandths` bigint unsigned NOT NULL,
	`consumed_ten_thousandths` bigint unsigned NOT NULL DEFAULT 0,
	`released_ten_thousandths` bigint unsigned NOT NULL DEFAULT 0,
	`frozen_ten_thousandths` bigint unsigned NOT NULL DEFAULT 0,
	`status` enum('active','settled') NOT NULL DEFAULT 'active',
	`created_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
	CONSTRAINT `media_publishing_reservations_id` PRIMARY KEY(`id`),
	CONSTRAINT `media_pub_reservations_id_owner_uq` UNIQUE(`id`,`owner_id`),
	CONSTRAINT `media_pub_reservations_batch_uq` UNIQUE(`batch_id`)
);
--> statement-breakpoint
-- Source: 0004_media_publishing.sql
CREATE TABLE `media_publishing_topup_orders` (
	`id` varchar(36) NOT NULL,
	`provider_order_id` varchar(128) NOT NULL,
	`replaces_order_id` varchar(36),
	`owner_id` varchar(36) NOT NULL,
	`idempotency_key` varchar(128) NOT NULL,
	`payment_method` enum('alipay','wxpay','bank_transfer') NOT NULL,
	`amount_ten_thousandths` bigint unsigned NOT NULL,
	`currency` varchar(3) NOT NULL DEFAULT 'CNY',
	`state` enum('pending','review_required','paid','credited','expired','cancelled','rejected') NOT NULL DEFAULT 'pending',
	`callback_token_digest` varchar(64) NOT NULL,
	`checkout_expires_at` datetime(3) NOT NULL,
	`paid_at` datetime(3),
	`credited_at` datetime(3),
	`created_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
	CONSTRAINT `media_publishing_topup_orders_id` PRIMARY KEY(`id`),
	CONSTRAINT `media_pub_topup_provider_order_uq` UNIQUE(`provider_order_id`),
	CONSTRAINT `media_pub_topup_replaces_order_uq` UNIQUE(`replaces_order_id`),
	CONSTRAINT `media_pub_topup_owner_idempotency_uq` UNIQUE(`owner_id`,`idempotency_key`)
);
--> statement-breakpoint
-- Source: 0004_media_publishing.sql
CREATE TABLE `media_publishing_topup_receipts` (
	`id` varchar(36) NOT NULL,
	`order_id` varchar(36) NOT NULL,
	`provider` enum('zpay','bank') NOT NULL,
	`provider_trade_no` varchar(191) NOT NULL,
	`amount_ten_thousandths` bigint unsigned NOT NULL,
	`paid_at` datetime(3) NOT NULL,
	`payload_digest` varchar(64) NOT NULL,
	`received_at` datetime(3) NOT NULL,
	`created_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `media_publishing_topup_receipts_id` PRIMARY KEY(`id`),
	CONSTRAINT `media_pub_receipts_order_uq` UNIQUE(`order_id`),
	CONSTRAINT `media_pub_receipts_provider_trade_uq` UNIQUE(`provider`,`provider_trade_no`)
);
--> statement-breakpoint
-- Source: 0004_media_publishing.sql
CREATE TABLE `media_publishing_wallets` (
	`user_id` varchar(36) NOT NULL,
	`currency` varchar(3) NOT NULL DEFAULT 'CNY',
	`balance_ten_thousandths` bigint NOT NULL DEFAULT 0,
	`reserved_ten_thousandths` bigint unsigned NOT NULL DEFAULT 0,
	`frozen_ten_thousandths` bigint unsigned NOT NULL DEFAULT 0,
	`spent_ten_thousandths` bigint unsigned NOT NULL DEFAULT 0,
	`updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
	CONSTRAINT `media_publishing_wallets_user_id` PRIMARY KEY(`user_id`)
);
--> statement-breakpoint
-- Source: 0004_media_publishing.sql
CREATE TABLE `payment_order_routes` (
	`id` varchar(36) NOT NULL,
	`provider_order_id` varchar(128) NOT NULL,
	`wallet_scope` enum('monitoring','media_publishing') NOT NULL,
	`monitoring_order_id` varchar(36),
	`media_publishing_order_id` varchar(36),
	`created_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `payment_order_routes_id` PRIMARY KEY(`id`),
	CONSTRAINT `payment_order_routes_provider_order_uq` UNIQUE(`provider_order_id`),
	CONSTRAINT `payment_order_routes_monitoring_order_uq` UNIQUE(`monitoring_order_id`),
	CONSTRAINT `payment_order_routes_media_order_uq` UNIQUE(`media_publishing_order_id`)
);
--> statement-breakpoint
-- Source: 0004_media_publishing.sql
CREATE TABLE `payment_receipt_claims` (
	`id` varchar(36) NOT NULL,
	`provider` enum('zpay','bank') NOT NULL,
	`provider_trade_no` varchar(191) NOT NULL,
	`provider_order_id` varchar(128) NOT NULL,
	`wallet_scope` enum('monitoring','media_publishing') NOT NULL,
	`payload_digest` varchar(64) NOT NULL,
	`status` enum('received','credited','review_required','rejected') NOT NULL DEFAULT 'received',
	`claimed_at` datetime(3) NOT NULL,
	`completed_at` datetime(3),
	`created_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
	CONSTRAINT `payment_receipt_claims_id` PRIMARY KEY(`id`),
	CONSTRAINT `payment_receipt_claims_provider_trade_uq` UNIQUE(`provider`,`provider_trade_no`)
);
--> statement-breakpoint
-- Source: 0004_media_publishing.sql
CREATE TABLE `publisher_article_assets` (
	`id` varchar(36) NOT NULL,
	`owner_id` varchar(36) NOT NULL,
	`article_id` varchar(36) NOT NULL,
	`sha256` varchar(64) NOT NULL,
	`mime_type` varchar(120) NOT NULL,
	`width` int unsigned NOT NULL,
	`height` int unsigned NOT NULL,
	`size_bytes` int unsigned NOT NULL,
	`storage_key` varchar(1024) NOT NULL,
	`storage_key_hash` varchar(64) NOT NULL,
	`alt_text` varchar(500),
	`source_import_id` varchar(36),
	`is_frozen` boolean NOT NULL DEFAULT false,
	`public_capability_digest` varchar(64),
	`public_capability_created_at` datetime(3),
	`created_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
	CONSTRAINT `publisher_article_assets_id` PRIMARY KEY(`id`),
	CONSTRAINT `pub_assets_id_owner_uq` UNIQUE(`id`,`owner_id`),
	CONSTRAINT `pub_assets_article_sha_uq` UNIQUE(`article_id`,`sha256`),
	CONSTRAINT `pub_assets_capability_uq` UNIQUE(`public_capability_digest`)
);
--> statement-breakpoint
-- Source: 0004_media_publishing.sql
CREATE TABLE `publisher_article_version_assets` (
	`owner_id` varchar(36) NOT NULL,
	`article_version_id` varchar(36) NOT NULL,
	`asset_id` varchar(36) NOT NULL,
	`sort_order` int unsigned NOT NULL DEFAULT 0,
	`created_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `publisher_article_version_assets_article_version_id_asset_id_pk` PRIMARY KEY(`article_version_id`,`asset_id`)
);
--> statement-breakpoint
-- Source: 0004_media_publishing.sql
CREATE TABLE `publisher_article_versions` (
	`id` varchar(36) NOT NULL,
	`owner_id` varchar(36) NOT NULL,
	`article_id` varchar(36) NOT NULL,
	`version` int unsigned NOT NULL,
	`editor_json` json NOT NULL,
	`canonical_html` longtext NOT NULL,
	`plain_text` longtext NOT NULL,
	`content_hash` varchar(64) NOT NULL,
	`contains_images` boolean NOT NULL DEFAULT false,
	`source_import_id` varchar(36),
	`freeze_idempotency_key` varchar(191) NOT NULL,
	`created_by` varchar(36),
	`created_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `publisher_article_versions_id` PRIMARY KEY(`id`),
	CONSTRAINT `pub_versions_id_owner_uq` UNIQUE(`id`,`owner_id`),
	CONSTRAINT `pub_versions_article_number_uq` UNIQUE(`article_id`,`version`),
	CONSTRAINT `pub_versions_owner_freeze_key_uq` UNIQUE(`owner_id`,`freeze_idempotency_key`)
);
--> statement-breakpoint
-- Source: 0004_media_publishing.sql
CREATE TABLE `publisher_articles` (
	`id` varchar(36) NOT NULL,
	`owner_id` varchar(36) NOT NULL,
	`working_name` varchar(180) NOT NULL,
	`suggested_title` varchar(200),
	`status` enum('draft','ready','archived') NOT NULL DEFAULT 'draft',
	`current_version_id` varchar(36),
	`revision` int unsigned NOT NULL DEFAULT 0,
	`editor_json` json,
	`canonical_html` longtext,
	`plain_text` longtext,
	`content_hash` varchar(64),
	`contains_images` boolean NOT NULL DEFAULT false,
	`archived_at` datetime(3),
	`created_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
	CONSTRAINT `publisher_articles_id` PRIMARY KEY(`id`),
	CONSTRAINT `pub_articles_id_owner_uq` UNIQUE(`id`,`owner_id`),
	CONSTRAINT `pub_articles_current_version_uq` UNIQUE(`current_version_id`)
);
--> statement-breakpoint
-- Source: 0004_media_publishing.sql
CREATE TABLE `publisher_batches` (
	`id` varchar(36) NOT NULL,
	`owner_id` varchar(36) NOT NULL,
	`draft_id` varchar(36) NOT NULL,
	`article_version_id` varchar(36) NOT NULL,
	`status` enum('queued','processing','success','failed','partial_success','action_required') NOT NULL DEFAULT 'queued',
	`funds_status` enum('reserved','frozen','consumed','released') NOT NULL DEFAULT 'reserved',
	`mode` enum('mock','test','live') NOT NULL,
	`quoted_total_ten_thousandths` bigint unsigned NOT NULL,
	`quote_fingerprint` varchar(64) NOT NULL,
	`preflight_revision` varchar(128) NOT NULL,
	`preflight_snapshot` json NOT NULL,
	`idempotency_key` varchar(191) NOT NULL,
	`live_confirmation_accepted` boolean NOT NULL DEFAULT false,
	`confirmed_at` datetime(3),
	`completed_at` datetime(3),
	`created_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
	CONSTRAINT `publisher_batches_id` PRIMARY KEY(`id`),
	CONSTRAINT `pub_batches_id_owner_uq` UNIQUE(`id`,`owner_id`),
	CONSTRAINT `pub_batches_owner_idempotency_uq` UNIQUE(`owner_id`,`idempotency_key`),
	CONSTRAINT `pub_batches_owner_draft_uq` UNIQUE(`owner_id`,`draft_id`)
);
--> statement-breakpoint
-- Source: 0004_media_publishing.sql
CREATE TABLE `publisher_docx_imports` (
	`id` varchar(36) NOT NULL,
	`owner_id` varchar(36) NOT NULL,
	`article_id` varchar(36),
	`source_filename` varchar(255) NOT NULL,
	`source_object_key` varchar(1024) NOT NULL,
	`size_bytes` int unsigned NOT NULL,
	`sha256` varchar(64) NOT NULL,
	`mime_type` varchar(120) NOT NULL,
	`parser_version` varchar(64) NOT NULL,
	`status` enum('uploaded','validating','parsing','ready','rejected','failed') NOT NULL DEFAULT 'uploaded',
	`detected_title` varchar(200),
	`import_report` json,
	`warnings` json NOT NULL,
	`blocking_issues` json NOT NULL,
	`expires_at` datetime(3) NOT NULL,
	`created_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
	CONSTRAINT `publisher_docx_imports_id` PRIMARY KEY(`id`),
	CONSTRAINT `pub_imports_id_owner_uq` UNIQUE(`id`,`owner_id`)
);
--> statement-breakpoint
-- Source: 0004_media_publishing.sql
CREATE TABLE `publisher_draft_items` (
	`id` varchar(36) NOT NULL,
	`owner_id` varchar(36) NOT NULL,
	`draft_id` varchar(36) NOT NULL,
	`media_resource_id` varchar(36) NOT NULL,
	`external_resource_id` varchar(128) NOT NULL,
	`submission_title` varchar(200) NOT NULL,
	`selected_price_ten_thousandths` bigint unsigned NOT NULL,
	`selected_catalog_revision` varchar(64) NOT NULL,
	`media_snapshot` json NOT NULL,
	`selected_at` datetime(3) NOT NULL,
	`created_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
	CONSTRAINT `publisher_draft_items_id` PRIMARY KEY(`id`),
	CONSTRAINT `pub_draft_items_id_owner_uq` UNIQUE(`id`,`owner_id`),
	CONSTRAINT `pub_draft_items_draft_media_uq` UNIQUE(`draft_id`,`media_resource_id`)
);
--> statement-breakpoint
-- Source: 0004_media_publishing.sql
CREATE TABLE `publisher_drafts` (
	`id` varchar(36) NOT NULL,
	`owner_id` varchar(36) NOT NULL,
	`article_version_id` varchar(36) NOT NULL,
	`status` enum('draft','ready','submitted','archived') NOT NULL DEFAULT 'draft',
	`revision` int unsigned NOT NULL DEFAULT 0,
	`created_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
	CONSTRAINT `publisher_drafts_id` PRIMARY KEY(`id`),
	CONSTRAINT `pub_drafts_id_owner_uq` UNIQUE(`id`,`owner_id`)
);
--> statement-breakpoint
-- Source: 0004_media_publishing.sql
CREATE TABLE `publisher_preflights` (
	`id` varchar(36) NOT NULL,
	`owner_id` varchar(36) NOT NULL,
	`draft_id` varchar(36) NOT NULL,
	`draft_revision` int unsigned NOT NULL,
	`quote_fingerprint` varchar(64) NOT NULL,
	`snapshot_hash` varchar(64) NOT NULL,
	`mode` enum('mock','test','live') NOT NULL,
	`expires_at` datetime(3) NOT NULL,
	`consumed_at` datetime(3),
	`created_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `publisher_preflights_id` PRIMARY KEY(`id`),
	CONSTRAINT `pub_preflights_id_owner_uq` UNIQUE(`id`,`owner_id`)
);
--> statement-breakpoint
-- Source: 0004_media_publishing.sql
CREATE TABLE `publisher_items` (
	`id` varchar(36) NOT NULL,
	`owner_id` varchar(36) NOT NULL,
	`batch_id` varchar(36) NOT NULL,
	`media_resource_id` varchar(36) NOT NULL,
	`external_resource_id` varchar(128) NOT NULL,
	`media_name_snapshot` varchar(255) NOT NULL,
	`media_metadata_snapshot` json NOT NULL,
	`submission_title` varchar(200) NOT NULL,
	`article_content_hash` varchar(64) NOT NULL,
	`catalog_revision` varchar(64) NOT NULL,
	`preflight_blockers` json NOT NULL,
	`preflight_warnings` json NOT NULL,
	`submission_key` varchar(191) NOT NULL,
	`request_hash` varchar(64),
	`status` enum('queued','submitting','processing','success','failed','auth_blocked','submission_unknown','action_required') NOT NULL DEFAULT 'queued',
	`funds_status` enum('reserved','frozen','consumed','released') NOT NULL DEFAULT 'reserved',
	`external_order_id` varchar(191),
	`external_manuscript_id` varchar(191),
	`reported_order_price_ten_thousandths` bigint unsigned,
	`published_url` text,
	`failure_reason` text,
	`action_required_reason` text,
	`attempt_count` int unsigned NOT NULL DEFAULT 0,
	`submitted_at` datetime(3),
	`completed_at` datetime(3),
	`last_polled_at` datetime(3),
	`next_poll_at` datetime(3),
	`created_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
	CONSTRAINT `publisher_items_id` PRIMARY KEY(`id`),
	CONSTRAINT `pub_items_id_owner_uq` UNIQUE(`id`,`owner_id`),
	CONSTRAINT `pub_items_submission_key_uq` UNIQUE(`submission_key`),
	CONSTRAINT `pub_items_batch_media_uq` UNIQUE(`batch_id`,`media_resource_id`),
	CONSTRAINT `pub_items_external_order_uq` UNIQUE(`external_order_id`)
);
--> statement-breakpoint
-- Source: 0004_media_publishing.sql
CREATE TABLE `publisher_jobs` (
	`id` varchar(36) NOT NULL,
	`type` enum('import_docx','sync_kol_catalog','submit_publication_item','poll_publication_item','reconcile_publication_unknown','purge_publisher_assets') NOT NULL,
	`status` enum('ready','leased','retry_wait','paused','succeeded','dead') NOT NULL DEFAULT 'ready',
	`deterministic_key` varchar(191) NOT NULL,
	`aggregate_id` varchar(191) NOT NULL,
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
	CONSTRAINT `publisher_jobs_id` PRIMARY KEY(`id`),
	CONSTRAINT `pub_jobs_deterministic_key_uq` UNIQUE(`deterministic_key`)
);
--> statement-breakpoint
-- Source: 0004_media_publishing.sql
CREATE TABLE `publisher_live_whitelist` (
	`media_resource_id` varchar(36) NOT NULL,
	`image_allowed` boolean NOT NULL DEFAULT false,
	`reason` varchar(240) NOT NULL,
	`enabled_by` varchar(36),
	`enabled_at` datetime(3) NOT NULL,
	`updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
	CONSTRAINT `publisher_live_whitelist_media_resource_id` PRIMARY KEY(`media_resource_id`)
);
--> statement-breakpoint
-- Source: 0004_media_publishing.sql
CREATE TABLE `publisher_media_capabilities` (
	`id` varchar(36) NOT NULL,
	`media_resource_id` varchar(36) NOT NULL,
	`image_support` enum('unknown','verified','unsupported') NOT NULL DEFAULT 'unknown',
	`content_profile` varchar(64) NOT NULL DEFAULT 'unknown',
	`verified_media_type` varchar(120),
	`evidence_url` text,
	`verified_at` datetime(3),
	`verified_by` varchar(36),
	`notes` text,
	`created_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
	CONSTRAINT `publisher_media_capabilities_id` PRIMARY KEY(`id`),
	CONSTRAINT `pub_media_capability_resource_uq` UNIQUE(`media_resource_id`)
);
--> statement-breakpoint
-- Source: 0004_media_publishing.sql
CREATE TABLE `publisher_media_resources` (
	`id` varchar(36) NOT NULL,
	`external_resource_id` varchar(128) NOT NULL,
	`catalog_revision` varchar(64) NOT NULL,
	`name` varchar(255) NOT NULL,
	`platform` varchar(120),
	`taxonomy` varchar(120),
	`media_type` varchar(120),
	`area` varchar(120),
	`case_url` text,
	`title_limit` int unsigned,
	`price_ten_thousandths` bigint unsigned NOT NULL,
	`success_rate_basis_points` int unsigned,
	`raw_payload` json NOT NULL,
	`payload_hash` varchar(64) NOT NULL,
	`is_active` boolean NOT NULL DEFAULT true,
	`consecutive_misses` int unsigned NOT NULL DEFAULT 0,
	`last_seen_complete_run_id` varchar(36),
	`last_seen_at` datetime(3) NOT NULL,
	`inactive_at` datetime(3),
	`created_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
	CONSTRAINT `publisher_media_resources_id` PRIMARY KEY(`id`),
	CONSTRAINT `pub_media_external_id_uq` UNIQUE(`external_resource_id`)
);
--> statement-breakpoint
-- Source: 0004_media_publishing.sql
CREATE TABLE `publisher_media_sync_runs` (
	`id` varchar(36) NOT NULL,
	`catalog_revision` varchar(64) NOT NULL,
	`status` enum('running','success','partial','failed') NOT NULL DEFAULT 'running',
	`started_by` varchar(36),
	`started_at` datetime(3) NOT NULL,
	`completed_at` datetime(3),
	`pages_fetched` int unsigned NOT NULL DEFAULT 0,
	`records_seen` int unsigned NOT NULL DEFAULT 0,
	`records_changed` int unsigned NOT NULL DEFAULT 0,
	`stop_reason` varchar(240),
	`error` json,
	`is_complete` boolean NOT NULL DEFAULT false,
	`created_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
	CONSTRAINT `publisher_media_sync_runs_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
-- Source: 0004_media_publishing.sql
CREATE TABLE `publisher_media_sync_staging` (
	`run_id` varchar(36) NOT NULL,
	`external_resource_id` varchar(128) NOT NULL,
	`page` int unsigned NOT NULL,
	`name` varchar(255) NOT NULL,
	`platform` varchar(120),
	`taxonomy` varchar(120),
	`media_type` varchar(120),
	`area` varchar(120),
	`case_url` text,
	`title_limit` int unsigned,
	`price_ten_thousandths` bigint unsigned NOT NULL,
	`success_rate_basis_points` int unsigned,
	`raw_payload` json NOT NULL,
	`payload_hash` varchar(64) NOT NULL,
	`staged_at` datetime(3) NOT NULL,
	CONSTRAINT `publisher_media_sync_staging_run_id_external_resource_id_pk` PRIMARY KEY(`run_id`,`external_resource_id`)
);
--> statement-breakpoint
-- Source: 0004_media_publishing.sql
CREATE TABLE `publisher_object_leases` (
	`id` varchar(36) NOT NULL,
	`owner_id` varchar(36) NOT NULL,
	`operation_id` varchar(191) NOT NULL,
	`storage_key` varchar(1024) NOT NULL,
	`storage_key_hash` varchar(64) NOT NULL,
	`kind` varchar(64) NOT NULL,
	`expires_at` datetime(3) NOT NULL,
	`created_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
	CONSTRAINT `publisher_object_leases_id` PRIMARY KEY(`id`),
	CONSTRAINT `pub_object_leases_operation_key_uq` UNIQUE(`owner_id`,`operation_id`,`storage_key_hash`)
);
--> statement-breakpoint
-- Source: 0004_media_publishing.sql
CREATE TABLE `publisher_reconciliation_candidates` (
	`id` varchar(36) NOT NULL,
	`item_id` varchar(36) NOT NULL,
	`external_order_id` varchar(191) NOT NULL,
	`confidence_basis_points` int unsigned NOT NULL,
	`evidence` json NOT NULL,
	`bound_at` datetime(3),
	`bound_by` varchar(36),
	`rejected_at` datetime(3),
	`rejected_by` varchar(36),
	`created_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `publisher_reconciliation_candidates_id` PRIMARY KEY(`id`),
	CONSTRAINT `pub_reconcile_item_order_uq` UNIQUE(`item_id`,`external_order_id`)
);
--> statement-breakpoint
-- Source: 0004_media_publishing.sql
CREATE TABLE `publisher_runtime_state` (
	`id` varchar(32) NOT NULL,
	`mode` enum('mock','test','live') NOT NULL DEFAULT 'mock',
	`feature_enabled` boolean NOT NULL DEFAULT false,
	`publish_enabled` boolean NOT NULL DEFAULT false,
	`image_publish_enabled` boolean NOT NULL DEFAULT false,
	`webhook_enabled` boolean NOT NULL DEFAULT false,
	`emergency_stop` boolean NOT NULL DEFAULT false,
	`credential_status` enum('unconfigured','healthy','auth_blocked','unknown') NOT NULL DEFAULT 'unconfigured',
	`credential_verified_at` datetime(3),
	`credential_failed_at` datetime(3),
	`active_catalog_revision` varchar(64),
	`catalog_synced_at` datetime(3),
	`changed_by` varchar(36),
	`updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
	CONSTRAINT `publisher_runtime_state_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
-- Source: 0004_media_publishing.sql
CREATE TABLE `publisher_submission_attempts` (
	`id` varchar(36) NOT NULL,
	`owner_id` varchar(36) NOT NULL,
	`item_id` varchar(36) NOT NULL,
	`attempt_number` int unsigned NOT NULL,
	`started_at` datetime(3) NOT NULL,
	`completed_at` datetime(3),
	`result` enum('succeeded','business_rejected','auth_blocked','submission_unknown'),
	`request_hash` varchar(64) NOT NULL,
	`http_status` int unsigned,
	`response_redacted` json,
	`error_code` varchar(64),
	`created_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `publisher_submission_attempts_id` PRIMARY KEY(`id`),
	CONSTRAINT `pub_attempts_item_number_uq` UNIQUE(`item_id`,`attempt_number`)
);
--> statement-breakpoint
-- Source: 0004_media_publishing.sql
CREATE TABLE `publisher_submission_gate` (
	`id` varchar(32) NOT NULL,
	`lease_owner` varchar(128),
	`lease_expires_at` datetime(3),
	`next_allowed_at` datetime(3) NOT NULL,
	`updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
	CONSTRAINT `publisher_submission_gate_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
-- Source: 0004_media_publishing.sql
CREATE TABLE `publisher_webhook_events` (
	`id` varchar(36) NOT NULL,
	`provider` varchar(64) NOT NULL DEFAULT 'kol',
	`payload_hash` varchar(64) NOT NULL,
	`raw_payload` json NOT NULL,
	`signature_status` enum('not_configured','verified','invalid') NOT NULL DEFAULT 'not_configured',
	`status` enum('received','queued','processed','unmatched','rejected') NOT NULL DEFAULT 'received',
	`received_at` datetime(3) NOT NULL,
	`processed_at` datetime(3),
	`error` text,
	`created_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `publisher_webhook_events_id` PRIMARY KEY(`id`),
	CONSTRAINT `pub_webhooks_provider_hash_uq` UNIQUE(`provider`,`payload_hash`)
);
--> statement-breakpoint
-- Source: 0004_media_publishing.sql
CREATE TABLE `publisher_webhook_items` (
	`id` varchar(36) NOT NULL,
	`event_id` varchar(36) NOT NULL,
	`external_order_id` varchar(191),
	`item_id` varchar(36),
	`raw_item` json NOT NULL,
	`status` enum('matched','unmatched','queued') NOT NULL DEFAULT 'unmatched',
	`created_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `publisher_webhook_items_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
-- Source: 0004_media_publishing.sql
ALTER TABLE `media_publishing_bank_transfer_reviews` ADD CONSTRAINT `media_pub_bank_review_order_fk` FOREIGN KEY (`order_id`) REFERENCES `media_publishing_topup_orders`(`id`) ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
-- Source: 0004_media_publishing.sql
ALTER TABLE `media_publishing_bank_transfer_reviews` ADD CONSTRAINT `media_publishing_bank_transfer_reviews_reviewed_by_users_id_fk` FOREIGN KEY (`reviewed_by`) REFERENCES `monitoring_users`(`id`) ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
-- Source: 0004_media_publishing.sql
ALTER TABLE `media_publishing_item_price_snapshots` ADD CONSTRAINT `media_publishing_item_price_snapshots_owner_id_users_id_fk` FOREIGN KEY (`owner_id`) REFERENCES `monitoring_users`(`id`) ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
-- Source: 0004_media_publishing.sql
ALTER TABLE `media_publishing_item_price_snapshots` ADD CONSTRAINT `media_pub_price_resource_fk` FOREIGN KEY (`media_resource_id`) REFERENCES `publisher_media_resources`(`id`) ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
-- Source: 0004_media_publishing.sql
ALTER TABLE `media_publishing_item_price_snapshots` ADD CONSTRAINT `media_pub_price_item_owner_fk` FOREIGN KEY (`item_id`,`owner_id`) REFERENCES `publisher_items`(`id`,`owner_id`) ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
-- Source: 0004_media_publishing.sql
ALTER TABLE `media_publishing_item_settlements` ADD CONSTRAINT `media_publishing_item_settlements_owner_id_users_id_fk` FOREIGN KEY (`owner_id`) REFERENCES `monitoring_users`(`id`) ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
-- Source: 0004_media_publishing.sql
ALTER TABLE `media_publishing_item_settlements` ADD CONSTRAINT `media_pub_settlements_item_owner_fk` FOREIGN KEY (`item_id`,`owner_id`) REFERENCES `publisher_items`(`id`,`owner_id`) ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
-- Source: 0004_media_publishing.sql
ALTER TABLE `media_publishing_item_settlements` ADD CONSTRAINT `media_pub_settlements_reservation_owner_fk` FOREIGN KEY (`reservation_id`,`owner_id`) REFERENCES `media_publishing_reservations`(`id`,`owner_id`) ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
-- Source: 0004_media_publishing.sql
ALTER TABLE `media_publishing_ledger` ADD CONSTRAINT `media_publishing_ledger_owner_id_users_id_fk` FOREIGN KEY (`owner_id`) REFERENCES `monitoring_users`(`id`) ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
-- Source: 0004_media_publishing.sql
ALTER TABLE `media_publishing_ledger` ADD CONSTRAINT `media_pub_ledger_reservation_fk` FOREIGN KEY (`reservation_id`) REFERENCES `media_publishing_reservations`(`id`) ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
-- Source: 0004_media_publishing.sql
ALTER TABLE `media_publishing_ledger` ADD CONSTRAINT `media_publishing_ledger_item_id_publisher_items_id_fk` FOREIGN KEY (`item_id`) REFERENCES `publisher_items`(`id`) ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
-- Source: 0004_media_publishing.sql
ALTER TABLE `media_publishing_ledger` ADD CONSTRAINT `media_publishing_ledger_actor_id_users_id_fk` FOREIGN KEY (`actor_id`) REFERENCES `monitoring_users`(`id`) ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
-- Source: 0004_media_publishing.sql
ALTER TABLE `media_publishing_reservations` ADD CONSTRAINT `media_publishing_reservations_owner_id_users_id_fk` FOREIGN KEY (`owner_id`) REFERENCES `monitoring_users`(`id`) ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
-- Source: 0004_media_publishing.sql
ALTER TABLE `media_publishing_reservations` ADD CONSTRAINT `media_pub_reservations_batch_owner_fk` FOREIGN KEY (`batch_id`,`owner_id`) REFERENCES `publisher_batches`(`id`,`owner_id`) ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
-- Source: 0004_media_publishing.sql
ALTER TABLE `media_publishing_topup_orders` ADD CONSTRAINT `media_pub_topup_replaces_fk` FOREIGN KEY (`replaces_order_id`) REFERENCES `media_publishing_topup_orders`(`id`) ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
-- Source: 0004_media_publishing.sql
ALTER TABLE `media_publishing_topup_orders` ADD CONSTRAINT `media_publishing_topup_orders_owner_id_users_id_fk` FOREIGN KEY (`owner_id`) REFERENCES `monitoring_users`(`id`) ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
-- Source: 0004_media_publishing.sql
ALTER TABLE `media_publishing_topup_receipts` ADD CONSTRAINT `media_pub_receipt_order_fk` FOREIGN KEY (`order_id`) REFERENCES `media_publishing_topup_orders`(`id`) ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
-- Source: 0004_media_publishing.sql
ALTER TABLE `media_publishing_wallets` ADD CONSTRAINT `media_publishing_wallets_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `monitoring_users`(`id`) ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
-- Source: 0004_media_publishing.sql
ALTER TABLE `payment_order_routes` ADD CONSTRAINT `payment_order_routes_monitoring_order_id_topup_orders_id_fk` FOREIGN KEY (`monitoring_order_id`) REFERENCES `topup_orders`(`id`) ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
-- Source: 0004_media_publishing.sql
ALTER TABLE `payment_order_routes` ADD CONSTRAINT `payment_routes_media_order_fk` FOREIGN KEY (`media_publishing_order_id`) REFERENCES `media_publishing_topup_orders`(`id`) ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
-- Source: 0004_media_publishing.sql
ALTER TABLE `publisher_article_assets` ADD CONSTRAINT `publisher_article_assets_owner_id_users_id_fk` FOREIGN KEY (`owner_id`) REFERENCES `monitoring_users`(`id`) ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
-- Source: 0004_media_publishing.sql
ALTER TABLE `publisher_article_assets` ADD CONSTRAINT `pub_assets_article_owner_fk` FOREIGN KEY (`article_id`,`owner_id`) REFERENCES `publisher_articles`(`id`,`owner_id`) ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
-- Source: 0004_media_publishing.sql
ALTER TABLE `publisher_article_assets` ADD CONSTRAINT `pub_assets_import_owner_fk` FOREIGN KEY (`source_import_id`,`owner_id`) REFERENCES `publisher_docx_imports`(`id`,`owner_id`) ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
-- Source: 0004_media_publishing.sql
ALTER TABLE `publisher_article_version_assets` ADD CONSTRAINT `publisher_article_version_assets_owner_id_users_id_fk` FOREIGN KEY (`owner_id`) REFERENCES `monitoring_users`(`id`) ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
-- Source: 0004_media_publishing.sql
ALTER TABLE `publisher_article_version_assets` ADD CONSTRAINT `pub_version_assets_version_owner_fk` FOREIGN KEY (`article_version_id`,`owner_id`) REFERENCES `publisher_article_versions`(`id`,`owner_id`) ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
-- Source: 0004_media_publishing.sql
ALTER TABLE `publisher_article_version_assets` ADD CONSTRAINT `pub_version_assets_asset_owner_fk` FOREIGN KEY (`asset_id`,`owner_id`) REFERENCES `publisher_article_assets`(`id`,`owner_id`) ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
-- Source: 0004_media_publishing.sql
ALTER TABLE `publisher_article_versions` ADD CONSTRAINT `publisher_article_versions_owner_id_users_id_fk` FOREIGN KEY (`owner_id`) REFERENCES `monitoring_users`(`id`) ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
-- Source: 0004_media_publishing.sql
ALTER TABLE `publisher_article_versions` ADD CONSTRAINT `publisher_article_versions_created_by_users_id_fk` FOREIGN KEY (`created_by`) REFERENCES `monitoring_users`(`id`) ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
-- Source: 0004_media_publishing.sql
ALTER TABLE `publisher_article_versions` ADD CONSTRAINT `pub_versions_article_owner_fk` FOREIGN KEY (`article_id`,`owner_id`) REFERENCES `publisher_articles`(`id`,`owner_id`) ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
-- Source: 0004_media_publishing.sql
ALTER TABLE `publisher_article_versions` ADD CONSTRAINT `pub_versions_import_owner_fk` FOREIGN KEY (`source_import_id`,`owner_id`) REFERENCES `publisher_docx_imports`(`id`,`owner_id`) ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
-- Source: 0004_media_publishing.sql
ALTER TABLE `publisher_articles` ADD CONSTRAINT `publisher_articles_owner_id_users_id_fk` FOREIGN KEY (`owner_id`) REFERENCES `monitoring_users`(`id`) ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
-- Source: 0004_media_publishing.sql
ALTER TABLE `publisher_batches` ADD CONSTRAINT `publisher_batches_owner_id_users_id_fk` FOREIGN KEY (`owner_id`) REFERENCES `monitoring_users`(`id`) ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
-- Source: 0004_media_publishing.sql
ALTER TABLE `publisher_batches` ADD CONSTRAINT `pub_batches_draft_owner_fk` FOREIGN KEY (`draft_id`,`owner_id`) REFERENCES `publisher_drafts`(`id`,`owner_id`) ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
-- Source: 0004_media_publishing.sql
ALTER TABLE `publisher_batches` ADD CONSTRAINT `pub_batches_version_owner_fk` FOREIGN KEY (`article_version_id`,`owner_id`) REFERENCES `publisher_article_versions`(`id`,`owner_id`) ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
-- Source: 0004_media_publishing.sql
ALTER TABLE `publisher_docx_imports` ADD CONSTRAINT `publisher_docx_imports_owner_id_users_id_fk` FOREIGN KEY (`owner_id`) REFERENCES `monitoring_users`(`id`) ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
-- Source: 0004_media_publishing.sql
ALTER TABLE `publisher_docx_imports` ADD CONSTRAINT `pub_imports_article_owner_fk` FOREIGN KEY (`article_id`,`owner_id`) REFERENCES `publisher_articles`(`id`,`owner_id`) ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
-- Source: 0004_media_publishing.sql
ALTER TABLE `publisher_draft_items` ADD CONSTRAINT `publisher_draft_items_owner_id_users_id_fk` FOREIGN KEY (`owner_id`) REFERENCES `monitoring_users`(`id`) ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
-- Source: 0004_media_publishing.sql
ALTER TABLE `publisher_draft_items` ADD CONSTRAINT `pub_draft_items_media_fk` FOREIGN KEY (`media_resource_id`) REFERENCES `publisher_media_resources`(`id`) ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
-- Source: 0004_media_publishing.sql
ALTER TABLE `publisher_draft_items` ADD CONSTRAINT `pub_draft_items_draft_owner_fk` FOREIGN KEY (`draft_id`,`owner_id`) REFERENCES `publisher_drafts`(`id`,`owner_id`) ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
-- Source: 0004_media_publishing.sql
ALTER TABLE `publisher_drafts` ADD CONSTRAINT `publisher_drafts_owner_id_users_id_fk` FOREIGN KEY (`owner_id`) REFERENCES `monitoring_users`(`id`) ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
-- Source: 0004_media_publishing.sql
ALTER TABLE `publisher_drafts` ADD CONSTRAINT `pub_drafts_version_owner_fk` FOREIGN KEY (`article_version_id`,`owner_id`) REFERENCES `publisher_article_versions`(`id`,`owner_id`) ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
-- Source: 0004_media_publishing.sql
ALTER TABLE `publisher_preflights` ADD CONSTRAINT `publisher_preflights_owner_id_users_id_fk` FOREIGN KEY (`owner_id`) REFERENCES `monitoring_users`(`id`) ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
-- Source: 0004_media_publishing.sql
ALTER TABLE `publisher_preflights` ADD CONSTRAINT `pub_preflights_draft_owner_fk` FOREIGN KEY (`draft_id`,`owner_id`) REFERENCES `publisher_drafts`(`id`,`owner_id`) ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
-- Source: 0004_media_publishing.sql
ALTER TABLE `publisher_items` ADD CONSTRAINT `publisher_items_owner_id_users_id_fk` FOREIGN KEY (`owner_id`) REFERENCES `monitoring_users`(`id`) ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
-- Source: 0004_media_publishing.sql
ALTER TABLE `publisher_items` ADD CONSTRAINT `pub_items_media_fk` FOREIGN KEY (`media_resource_id`) REFERENCES `publisher_media_resources`(`id`) ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
-- Source: 0004_media_publishing.sql
ALTER TABLE `publisher_items` ADD CONSTRAINT `pub_items_batch_owner_fk` FOREIGN KEY (`batch_id`,`owner_id`) REFERENCES `publisher_batches`(`id`,`owner_id`) ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
-- Source: 0004_media_publishing.sql
ALTER TABLE `publisher_live_whitelist` ADD CONSTRAINT `pub_live_whitelist_media_fk` FOREIGN KEY (`media_resource_id`) REFERENCES `publisher_media_resources`(`id`) ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
-- Source: 0004_media_publishing.sql
ALTER TABLE `publisher_live_whitelist` ADD CONSTRAINT `publisher_live_whitelist_enabled_by_users_id_fk` FOREIGN KEY (`enabled_by`) REFERENCES `monitoring_users`(`id`) ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
-- Source: 0004_media_publishing.sql
ALTER TABLE `publisher_media_capabilities` ADD CONSTRAINT `pub_media_capabilities_resource_fk` FOREIGN KEY (`media_resource_id`) REFERENCES `publisher_media_resources`(`id`) ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
-- Source: 0004_media_publishing.sql
ALTER TABLE `publisher_media_capabilities` ADD CONSTRAINT `publisher_media_capabilities_verified_by_users_id_fk` FOREIGN KEY (`verified_by`) REFERENCES `monitoring_users`(`id`) ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
-- Source: 0004_media_publishing.sql
ALTER TABLE `publisher_media_resources` ADD CONSTRAINT `pub_media_last_sync_run_fk` FOREIGN KEY (`last_seen_complete_run_id`) REFERENCES `publisher_media_sync_runs`(`id`) ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
-- Source: 0004_media_publishing.sql
ALTER TABLE `publisher_media_sync_runs` ADD CONSTRAINT `publisher_media_sync_runs_started_by_users_id_fk` FOREIGN KEY (`started_by`) REFERENCES `monitoring_users`(`id`) ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
-- Source: 0004_media_publishing.sql
ALTER TABLE `publisher_media_sync_staging` ADD CONSTRAINT `pub_media_staging_run_fk` FOREIGN KEY (`run_id`) REFERENCES `publisher_media_sync_runs`(`id`) ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
-- Source: 0004_media_publishing.sql
ALTER TABLE `publisher_object_leases` ADD CONSTRAINT `publisher_object_leases_owner_id_users_id_fk` FOREIGN KEY (`owner_id`) REFERENCES `monitoring_users`(`id`) ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
-- Source: 0004_media_publishing.sql
ALTER TABLE `publisher_reconciliation_candidates` ADD CONSTRAINT `pub_reconciliation_item_fk` FOREIGN KEY (`item_id`) REFERENCES `publisher_items`(`id`) ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
-- Source: 0004_media_publishing.sql
ALTER TABLE `publisher_reconciliation_candidates` ADD CONSTRAINT `publisher_reconciliation_candidates_bound_by_users_id_fk` FOREIGN KEY (`bound_by`) REFERENCES `monitoring_users`(`id`) ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
-- Source: 0004_media_publishing.sql
ALTER TABLE `publisher_reconciliation_candidates` ADD CONSTRAINT `publisher_reconciliation_candidates_rejected_by_users_id_fk` FOREIGN KEY (`rejected_by`) REFERENCES `monitoring_users`(`id`) ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
-- Source: 0004_media_publishing.sql
ALTER TABLE `publisher_runtime_state` ADD CONSTRAINT `publisher_runtime_state_changed_by_users_id_fk` FOREIGN KEY (`changed_by`) REFERENCES `monitoring_users`(`id`) ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
-- Source: 0004_media_publishing.sql
ALTER TABLE `publisher_submission_attempts` ADD CONSTRAINT `publisher_submission_attempts_owner_id_users_id_fk` FOREIGN KEY (`owner_id`) REFERENCES `monitoring_users`(`id`) ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
-- Source: 0004_media_publishing.sql
ALTER TABLE `publisher_submission_attempts` ADD CONSTRAINT `pub_attempts_item_owner_fk` FOREIGN KEY (`item_id`,`owner_id`) REFERENCES `publisher_items`(`id`,`owner_id`) ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
-- Source: 0004_media_publishing.sql
ALTER TABLE `publisher_webhook_items` ADD CONSTRAINT `publisher_webhook_items_event_id_publisher_webhook_events_id_fk` FOREIGN KEY (`event_id`) REFERENCES `publisher_webhook_events`(`id`) ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
-- Source: 0004_media_publishing.sql
ALTER TABLE `publisher_webhook_items` ADD CONSTRAINT `publisher_webhook_items_item_id_publisher_items_id_fk` FOREIGN KEY (`item_id`) REFERENCES `publisher_items`(`id`) ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
-- Source: 0004_media_publishing.sql
CREATE INDEX `media_pub_bank_reviews_status_idx` ON `media_publishing_bank_transfer_reviews` (`status`,`submitted_at`);
--> statement-breakpoint
-- Source: 0004_media_publishing.sql
CREATE INDEX `media_pub_price_owner_idx` ON `media_publishing_item_price_snapshots` (`owner_id`);
--> statement-breakpoint
-- Source: 0004_media_publishing.sql
CREATE INDEX `media_pub_settlements_reservation_idx` ON `media_publishing_item_settlements` (`reservation_id`);
--> statement-breakpoint
-- Source: 0004_media_publishing.sql
CREATE INDEX `media_pub_settlements_owner_status_idx` ON `media_publishing_item_settlements` (`owner_id`,`status`);
--> statement-breakpoint
-- Source: 0004_media_publishing.sql
CREATE INDEX `media_pub_ledger_owner_created_idx` ON `media_publishing_ledger` (`owner_id`,`created_at`);
--> statement-breakpoint
-- Source: 0004_media_publishing.sql
CREATE INDEX `media_pub_ledger_reference_idx` ON `media_publishing_ledger` (`reference_type`,`reference_id`);
--> statement-breakpoint
-- Source: 0004_media_publishing.sql
CREATE INDEX `media_pub_reservations_owner_status_idx` ON `media_publishing_reservations` (`owner_id`,`status`);
--> statement-breakpoint
-- Source: 0004_media_publishing.sql
CREATE INDEX `media_pub_topup_owner_created_idx` ON `media_publishing_topup_orders` (`owner_id`,`created_at`);
--> statement-breakpoint
-- Source: 0004_media_publishing.sql
CREATE INDEX `media_pub_topup_state_expiry_idx` ON `media_publishing_topup_orders` (`state`,`checkout_expires_at`);
--> statement-breakpoint
-- Source: 0004_media_publishing.sql
CREATE INDEX `payment_receipt_claims_order_idx` ON `payment_receipt_claims` (`provider_order_id`);
--> statement-breakpoint
-- Source: 0004_media_publishing.sql
CREATE INDEX `pub_assets_storage_key_idx` ON `publisher_article_assets` (`storage_key_hash`);
--> statement-breakpoint
-- Source: 0004_media_publishing.sql
CREATE INDEX `pub_version_assets_owner_idx` ON `publisher_article_version_assets` (`owner_id`);
--> statement-breakpoint
-- Source: 0004_media_publishing.sql
CREATE INDEX `pub_versions_hash_idx` ON `publisher_article_versions` (`content_hash`);
--> statement-breakpoint
-- Source: 0004_media_publishing.sql
CREATE INDEX `pub_articles_owner_updated_idx` ON `publisher_articles` (`owner_id`,`updated_at`);
--> statement-breakpoint
-- Source: 0004_media_publishing.sql
CREATE INDEX `pub_articles_owner_status_idx` ON `publisher_articles` (`owner_id`,`status`);
--> statement-breakpoint
-- Source: 0004_media_publishing.sql
CREATE INDEX `pub_batches_owner_created_idx` ON `publisher_batches` (`owner_id`,`created_at`);
--> statement-breakpoint
-- Source: 0004_media_publishing.sql
CREATE INDEX `pub_batches_status_updated_idx` ON `publisher_batches` (`status`,`updated_at`);
--> statement-breakpoint
-- Source: 0004_media_publishing.sql
CREATE INDEX `pub_imports_owner_status_idx` ON `publisher_docx_imports` (`owner_id`,`status`);
--> statement-breakpoint
-- Source: 0004_media_publishing.sql
CREATE INDEX `pub_imports_expiry_idx` ON `publisher_docx_imports` (`expires_at`);
--> statement-breakpoint
-- Source: 0004_media_publishing.sql
CREATE INDEX `pub_imports_owner_sha_idx` ON `publisher_docx_imports` (`owner_id`,`sha256`);
--> statement-breakpoint
-- Source: 0004_media_publishing.sql
CREATE INDEX `pub_draft_items_media_idx` ON `publisher_draft_items` (`media_resource_id`);
--> statement-breakpoint
-- Source: 0004_media_publishing.sql
CREATE INDEX `pub_drafts_owner_updated_idx` ON `publisher_drafts` (`owner_id`,`updated_at`);
--> statement-breakpoint
-- Source: 0004_media_publishing.sql
CREATE INDEX `pub_preflights_owner_expiry_idx` ON `publisher_preflights` (`owner_id`,`expires_at`);
--> statement-breakpoint
-- Source: 0004_media_publishing.sql
CREATE INDEX `pub_items_status_next_poll_idx` ON `publisher_items` (`status`,`next_poll_at`);
--> statement-breakpoint
-- Source: 0004_media_publishing.sql
CREATE INDEX `pub_items_batch_status_idx` ON `publisher_items` (`batch_id`,`status`);
--> statement-breakpoint
-- Source: 0004_media_publishing.sql
CREATE INDEX `pub_jobs_claim_idx` ON `publisher_jobs` (`status`,`available_at`,`lease_expires_at`);
--> statement-breakpoint
-- Source: 0004_media_publishing.sql
CREATE INDEX `pub_jobs_type_aggregate_idx` ON `publisher_jobs` (`type`,`aggregate_id`);
--> statement-breakpoint
-- Source: 0004_media_publishing.sql
CREATE INDEX `pub_media_capability_image_idx` ON `publisher_media_capabilities` (`image_support`);
--> statement-breakpoint
-- Source: 0004_media_publishing.sql
CREATE INDEX `pub_media_active_name_idx` ON `publisher_media_resources` (`is_active`,`name`);
--> statement-breakpoint
-- Source: 0004_media_publishing.sql
CREATE INDEX `pub_media_platform_taxonomy_idx` ON `publisher_media_resources` (`platform`,`taxonomy`);
--> statement-breakpoint
-- Source: 0004_media_publishing.sql
CREATE INDEX `pub_media_area_idx` ON `publisher_media_resources` (`area`);
--> statement-breakpoint
-- Source: 0004_media_publishing.sql
CREATE INDEX `pub_media_active_price_idx` ON `publisher_media_resources` (`is_active`,`price_ten_thousandths`);
--> statement-breakpoint
-- Source: 0004_media_publishing.sql
CREATE INDEX `pub_media_sync_revision_idx` ON `publisher_media_sync_runs` (`catalog_revision`);
--> statement-breakpoint
-- Source: 0004_media_publishing.sql
CREATE INDEX `pub_media_sync_status_started_idx` ON `publisher_media_sync_runs` (`status`,`started_at`);
--> statement-breakpoint
-- Source: 0004_media_publishing.sql
CREATE INDEX `pub_media_staging_run_page_idx` ON `publisher_media_sync_staging` (`run_id`,`page`);
--> statement-breakpoint
-- Source: 0004_media_publishing.sql
CREATE INDEX `pub_object_leases_expiry_idx` ON `publisher_object_leases` (`expires_at`);
--> statement-breakpoint
-- Source: 0004_media_publishing.sql
CREATE INDEX `pub_object_leases_storage_expiry_idx` ON `publisher_object_leases` (`storage_key_hash`,`expires_at`);
--> statement-breakpoint
-- Source: 0004_media_publishing.sql
CREATE INDEX `pub_reconcile_unresolved_idx` ON `publisher_reconciliation_candidates` (`bound_at`,`rejected_at`);
--> statement-breakpoint
-- Source: 0004_media_publishing.sql
CREATE INDEX `pub_attempts_started_idx` ON `publisher_submission_attempts` (`started_at`);
--> statement-breakpoint
-- Source: 0004_media_publishing.sql
CREATE INDEX `pub_submission_gate_lease_idx` ON `publisher_submission_gate` (`lease_expires_at`);
--> statement-breakpoint
-- Source: 0004_media_publishing.sql
CREATE INDEX `pub_webhooks_status_received_idx` ON `publisher_webhook_events` (`status`,`received_at`);
--> statement-breakpoint
-- Source: 0004_media_publishing.sql
CREATE INDEX `pub_webhook_items_event_idx` ON `publisher_webhook_items` (`event_id`);
--> statement-breakpoint
-- Source: 0004_media_publishing.sql
CREATE INDEX `pub_webhook_items_order_idx` ON `publisher_webhook_items` (`external_order_id`);
--> statement-breakpoint
-- Source: 0004_media_publishing.sql
INSERT IGNORE INTO `media_publishing_wallets` (`user_id`, `currency`, `balance_ten_thousandths`, `reserved_ten_thousandths`, `frozen_ten_thousandths`, `spent_ten_thousandths`)
SELECT `id`, 'CNY', 0, 0, 0, 0 FROM `monitoring_users`;
--> statement-breakpoint
-- Source: 0004_media_publishing.sql
INSERT IGNORE INTO `publisher_runtime_state` (`id`, `mode`, `feature_enabled`, `publish_enabled`, `image_publish_enabled`, `webhook_enabled`, `emergency_stop`, `credential_status`)
VALUES ('kol', 'mock', false, false, false, false, false, 'unconfigured');
--> statement-breakpoint
-- Source: 0004_media_publishing.sql
INSERT IGNORE INTO `payment_order_routes` (`id`, `provider_order_id`, `wallet_scope`, `monitoring_order_id`)
SELECT `id`, `provider_order_id`, 'monitoring', `id` FROM `topup_orders`;
--> statement-breakpoint
-- Source: 0005_monitoring_scope_index.sql
CREATE INDEX `runs_owner_monitor_created_id_idx` ON `runs` (`owner_id`,`monitor_id`,`created_at`,`id`);
--> statement-breakpoint
-- Source: 0006_publisher_dual_media.sql
ALTER TABLE `publisher_batches` ADD `title_mode` enum('single','per_media') DEFAULT 'per_media' NOT NULL AFTER `live_confirmation_accepted`;
--> statement-breakpoint
-- Source: 0006_publisher_dual_media.sql
ALTER TABLE `publisher_draft_items` ADD `media_kind_snapshot` enum('news','self_media','unknown') DEFAULT 'unknown' NOT NULL AFTER `selected_catalog_revision`;
--> statement-breakpoint
-- Source: 0006_publisher_dual_media.sql
ALTER TABLE `publisher_drafts` ADD `title_mode` enum('single','per_media') DEFAULT 'per_media' NOT NULL AFTER `revision`;
--> statement-breakpoint
-- Source: 0006_publisher_dual_media.sql
ALTER TABLE `publisher_drafts` ADD `shared_title` varchar(200) AFTER `title_mode`;
--> statement-breakpoint
-- Source: 0006_publisher_dual_media.sql
ALTER TABLE `publisher_items` ADD `media_kind_snapshot` enum('news','self_media','unknown') DEFAULT 'unknown' NOT NULL AFTER `media_name_snapshot`;
--> statement-breakpoint
-- Source: 0006_publisher_dual_media.sql
ALTER TABLE `publisher_media_resources` ADD `media_kind` enum('news','self_media') AFTER `name`;
--> statement-breakpoint
-- Source: 0006_publisher_dual_media.sql
ALTER TABLE `publisher_media_resources` ADD `include_rate_basis_points` int unsigned AFTER `success_rate_basis_points`;
--> statement-breakpoint
-- Source: 0006_publisher_dual_media.sql
ALTER TABLE `publisher_media_resources` ADD `pc_weight` int unsigned AFTER `include_rate_basis_points`;
--> statement-breakpoint
-- Source: 0006_publisher_dual_media.sql
ALTER TABLE `publisher_media_resources` ADD `mobile_weight` int unsigned AFTER `pc_weight`;
--> statement-breakpoint
-- Source: 0006_publisher_dual_media.sql
ALTER TABLE `publisher_media_resources` ADD `include_type` varchar(120) AFTER `mobile_weight`;
--> statement-breakpoint
-- Source: 0006_publisher_dual_media.sql
ALTER TABLE `publisher_media_resources` ADD `publish_speed` varchar(120) AFTER `include_type`;
--> statement-breakpoint
-- Source: 0006_publisher_dual_media.sql
ALTER TABLE `publisher_media_resources` ADD `entry_url` text AFTER `publish_speed`;
--> statement-breakpoint
-- Source: 0006_publisher_dual_media.sql
ALTER TABLE `publisher_media_resources` ADD `entry_level` varchar(120) AFTER `entry_url`;
--> statement-breakpoint
-- Source: 0006_publisher_dual_media.sql
ALTER TABLE `publisher_media_resources` ADD `link_type` varchar(120) AFTER `entry_level`;
--> statement-breakpoint
-- Source: 0006_publisher_dual_media.sql
ALTER TABLE `publisher_media_resources` ADD `logo_url` text AFTER `link_type`;
--> statement-breakpoint
-- Source: 0006_publisher_dual_media.sql
ALTER TABLE `publisher_media_resources` ADD `remark` text AFTER `logo_url`;
--> statement-breakpoint
-- Source: 0006_publisher_dual_media.sql
ALTER TABLE `publisher_media_resources` ADD `description` text AFTER `remark`;
--> statement-breakpoint
-- Source: 0006_publisher_dual_media.sql
ALTER TABLE `publisher_media_resources` ADD `recommended` boolean AFTER `description`;
--> statement-breakpoint
-- Source: 0006_publisher_dual_media.sql
ALTER TABLE `publisher_media_resources` ADD `authenticated` boolean AFTER `recommended`;
--> statement-breakpoint
-- Source: 0006_publisher_dual_media.sql
ALTER TABLE `publisher_media_resources` ADD `festival_publishable` boolean AFTER `authenticated`;
--> statement-breakpoint
-- Source: 0006_publisher_dual_media.sql
ALTER TABLE `publisher_media_resources` ADD `fan_count` bigint unsigned AFTER `festival_publishable`;
--> statement-breakpoint
-- Source: 0006_publisher_dual_media.sql
ALTER TABLE `publisher_media_resources` ADD `like_count` bigint unsigned AFTER `fan_count`;
--> statement-breakpoint
-- Source: 0006_publisher_dual_media.sql
ALTER TABLE `publisher_media_resources` ADD `publish_count` bigint unsigned AFTER `like_count`;
--> statement-breakpoint
-- Source: 0006_publisher_dual_media.sql
ALTER TABLE `publisher_media_sync_staging` ADD `media_kind` enum('news','self_media') AFTER `name`;
--> statement-breakpoint
-- Source: 0006_publisher_dual_media.sql
ALTER TABLE `publisher_media_sync_staging` ADD `include_rate_basis_points` int unsigned AFTER `success_rate_basis_points`;
--> statement-breakpoint
-- Source: 0006_publisher_dual_media.sql
ALTER TABLE `publisher_media_sync_staging` ADD `pc_weight` int unsigned AFTER `include_rate_basis_points`;
--> statement-breakpoint
-- Source: 0006_publisher_dual_media.sql
ALTER TABLE `publisher_media_sync_staging` ADD `mobile_weight` int unsigned AFTER `pc_weight`;
--> statement-breakpoint
-- Source: 0006_publisher_dual_media.sql
ALTER TABLE `publisher_media_sync_staging` ADD `include_type` varchar(120) AFTER `mobile_weight`;
--> statement-breakpoint
-- Source: 0006_publisher_dual_media.sql
ALTER TABLE `publisher_media_sync_staging` ADD `publish_speed` varchar(120) AFTER `include_type`;
--> statement-breakpoint
-- Source: 0006_publisher_dual_media.sql
ALTER TABLE `publisher_media_sync_staging` ADD `entry_url` text AFTER `publish_speed`;
--> statement-breakpoint
-- Source: 0006_publisher_dual_media.sql
ALTER TABLE `publisher_media_sync_staging` ADD `entry_level` varchar(120) AFTER `entry_url`;
--> statement-breakpoint
-- Source: 0006_publisher_dual_media.sql
ALTER TABLE `publisher_media_sync_staging` ADD `link_type` varchar(120) AFTER `entry_level`;
--> statement-breakpoint
-- Source: 0006_publisher_dual_media.sql
ALTER TABLE `publisher_media_sync_staging` ADD `logo_url` text AFTER `link_type`;
--> statement-breakpoint
-- Source: 0006_publisher_dual_media.sql
ALTER TABLE `publisher_media_sync_staging` ADD `remark` text AFTER `logo_url`;
--> statement-breakpoint
-- Source: 0006_publisher_dual_media.sql
ALTER TABLE `publisher_media_sync_staging` ADD `description` text AFTER `remark`;
--> statement-breakpoint
-- Source: 0006_publisher_dual_media.sql
ALTER TABLE `publisher_media_sync_staging` ADD `recommended` boolean AFTER `description`;
--> statement-breakpoint
-- Source: 0006_publisher_dual_media.sql
ALTER TABLE `publisher_media_sync_staging` ADD `authenticated` boolean AFTER `recommended`;
--> statement-breakpoint
-- Source: 0006_publisher_dual_media.sql
ALTER TABLE `publisher_media_sync_staging` ADD `festival_publishable` boolean AFTER `authenticated`;
--> statement-breakpoint
-- Source: 0006_publisher_dual_media.sql
ALTER TABLE `publisher_media_sync_staging` ADD `fan_count` bigint unsigned AFTER `festival_publishable`;
--> statement-breakpoint
-- Source: 0006_publisher_dual_media.sql
ALTER TABLE `publisher_media_sync_staging` ADD `like_count` bigint unsigned AFTER `fan_count`;
--> statement-breakpoint
-- Source: 0006_publisher_dual_media.sql
ALTER TABLE `publisher_media_sync_staging` ADD `publish_count` bigint unsigned AFTER `like_count`;
--> statement-breakpoint
-- Source: 0006_publisher_dual_media.sql
ALTER TABLE `publisher_runtime_state` ADD `catalog_kind_complete` boolean DEFAULT false NOT NULL AFTER `catalog_synced_at`;
--> statement-breakpoint
-- Source: 0006_publisher_dual_media.sql
UPDATE `publisher_media_resources`
SET `media_kind` = CASE
  WHEN JSON_UNQUOTE(JSON_EXTRACT(`raw_payload`, '$.mediaKind')) = 'news' THEN 'news'
  WHEN JSON_UNQUOTE(JSON_EXTRACT(`raw_payload`, '$.mediaKind')) = 'self_media' THEN 'self_media'
  WHEN JSON_UNQUOTE(JSON_EXTRACT(`raw_payload`, '$.isSelfMedia')) IN ('true', '1') THEN 'self_media'
  WHEN JSON_UNQUOTE(JSON_EXTRACT(`raw_payload`, '$.isSelfMedia')) IN ('false', '0') THEN 'news'
  ELSE NULL
END;
--> statement-breakpoint
-- Source: 0006_publisher_dual_media.sql
UPDATE `publisher_media_sync_staging`
SET `media_kind` = CASE
  WHEN JSON_UNQUOTE(JSON_EXTRACT(`raw_payload`, '$.mediaKind')) = 'news' THEN 'news'
  WHEN JSON_UNQUOTE(JSON_EXTRACT(`raw_payload`, '$.mediaKind')) = 'self_media' THEN 'self_media'
  WHEN JSON_UNQUOTE(JSON_EXTRACT(`raw_payload`, '$.isSelfMedia')) IN ('true', '1') THEN 'self_media'
  WHEN JSON_UNQUOTE(JSON_EXTRACT(`raw_payload`, '$.isSelfMedia')) IN ('false', '0') THEN 'news'
  ELSE NULL
END;
--> statement-breakpoint
-- Source: 0006_publisher_dual_media.sql
CREATE INDEX `pub_media_active_kind_price_id_idx` ON `publisher_media_resources` (`is_active`,`media_kind`,`price_ten_thousandths`,`id`);
--> statement-breakpoint
-- Source: 0006_publisher_dual_media.sql
CREATE INDEX `pub_media_active_kind_platform_tax_idx` ON `publisher_media_resources` (`is_active`,`media_kind`,`platform`,`taxonomy`,`id`);
--> statement-breakpoint
-- Source: 0006_publisher_dual_media.sql
CREATE INDEX `pub_media_active_kind_area_id_idx` ON `publisher_media_resources` (`is_active`,`media_kind`,`area`,`id`);
--> statement-breakpoint
-- Source: 0007_local_real_catalog_acceptance.sql
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
-- Source: 0007_local_real_catalog_acceptance.sql
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
-- Source: 0007_local_real_catalog_acceptance.sql
ALTER TABLE `publisher_jobs` MODIFY COLUMN `type` enum('import_docx','sync_kol_catalog','archive_publisher_media_logo','submit_publication_item','poll_publication_item','reconcile_publication_unknown','purge_publisher_assets') NOT NULL;
--> statement-breakpoint
-- Source: 0007_local_real_catalog_acceptance.sql
ALTER TABLE `platform_catalog` ADD `acceptance_required` boolean DEFAULT false NOT NULL AFTER `supports_overseas_region`;
--> statement-breakpoint
-- Source: 0007_local_real_catalog_acceptance.sql
ALTER TABLE `platform_catalog` ADD `acceptance_fingerprint` varchar(64) AFTER `provider_metadata`;
--> statement-breakpoint
-- Source: 0007_local_real_catalog_acceptance.sql
ALTER TABLE `publisher_media_resources` ADD `provider_icon_url` text AFTER `logo_url`;
--> statement-breakpoint
-- Source: 0007_local_real_catalog_acceptance.sql
ALTER TABLE `publisher_media_resources` ADD `logo_candidate_hash` varchar(64) AFTER `provider_icon_url`;
--> statement-breakpoint
-- Source: 0007_local_real_catalog_acceptance.sql
ALTER TABLE `publisher_media_resources` ADD `logo_archive_status` enum('pending','archived','missing','failed') DEFAULT 'missing' NOT NULL AFTER `logo_candidate_hash`;
--> statement-breakpoint
-- Source: 0007_local_real_catalog_acceptance.sql
ALTER TABLE `publisher_media_resources` ADD `logo_source_kind` enum('logo','icon') AFTER `logo_archive_status`;
--> statement-breakpoint
-- Source: 0007_local_real_catalog_acceptance.sql
ALTER TABLE `publisher_media_resources` ADD `logo_source_url` text AFTER `logo_source_kind`;
--> statement-breakpoint
-- Source: 0007_local_real_catalog_acceptance.sql
ALTER TABLE `publisher_media_resources` ADD `logo_object_key` varchar(1024) AFTER `logo_source_url`;
--> statement-breakpoint
-- Source: 0007_local_real_catalog_acceptance.sql
ALTER TABLE `publisher_media_resources` ADD `logo_content_type` varchar(120) AFTER `logo_object_key`;
--> statement-breakpoint
-- Source: 0007_local_real_catalog_acceptance.sql
ALTER TABLE `publisher_media_resources` ADD `logo_size_bytes` bigint unsigned AFTER `logo_content_type`;
--> statement-breakpoint
-- Source: 0007_local_real_catalog_acceptance.sql
ALTER TABLE `publisher_media_resources` ADD `logo_sha256` varchar(64) AFTER `logo_size_bytes`;
--> statement-breakpoint
-- Source: 0007_local_real_catalog_acceptance.sql
ALTER TABLE `publisher_media_resources` ADD `logo_checked_at` datetime(3) AFTER `logo_sha256`;
--> statement-breakpoint
-- Source: 0007_local_real_catalog_acceptance.sql
ALTER TABLE `publisher_media_resources` ADD `logo_archive_error` varchar(120) AFTER `logo_checked_at`;
--> statement-breakpoint
-- Source: 0007_local_real_catalog_acceptance.sql
ALTER TABLE `publisher_media_sync_staging` ADD `provider_icon_url` text AFTER `logo_url`;
--> statement-breakpoint
-- Source: 0007_local_real_catalog_acceptance.sql
ALTER TABLE `publisher_media_sync_staging` ADD `logo_candidate_hash` varchar(64) AFTER `provider_icon_url`;
--> statement-breakpoint
-- Source: 0007_local_real_catalog_acceptance.sql
ALTER TABLE `publisher_media_sync_runs` ADD `pages_expected` int unsigned DEFAULT 0 NOT NULL AFTER `pages_fetched`;
--> statement-breakpoint
-- Source: 0007_local_real_catalog_acceptance.sql
ALTER TABLE `publisher_media_sync_runs` ADD `news_records` int unsigned DEFAULT 0 NOT NULL AFTER `records_seen`;
--> statement-breakpoint
-- Source: 0007_local_real_catalog_acceptance.sql
ALTER TABLE `publisher_media_sync_runs` ADD `self_media_records` int unsigned DEFAULT 0 NOT NULL AFTER `news_records`;
--> statement-breakpoint
-- Source: 0007_local_real_catalog_acceptance.sql
ALTER TABLE `publisher_media_sync_runs` ADD `invalid_records` int unsigned DEFAULT 0 NOT NULL AFTER `self_media_records`;
--> statement-breakpoint
-- Source: 0007_local_real_catalog_acceptance.sql
ALTER TABLE `publisher_media_sync_runs` ADD `duplicate_records` int unsigned DEFAULT 0 NOT NULL AFTER `invalid_records`;
--> statement-breakpoint
-- Source: 0007_local_real_catalog_acceptance.sql
ALTER TABLE `publisher_media_sync_runs` ADD `cross_kind_duplicate_records` int unsigned DEFAULT 0 NOT NULL AFTER `duplicate_records`;
--> statement-breakpoint
-- Source: 0007_local_real_catalog_acceptance.sql
ALTER TABLE `platform_acceptance_batches` ADD CONSTRAINT `platform_acceptance_batches_owner_id_users_id_fk` FOREIGN KEY (`owner_id`) REFERENCES `monitoring_users`(`id`) ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
-- Source: 0007_local_real_catalog_acceptance.sql
ALTER TABLE `platform_acceptance_batches` ADD CONSTRAINT `platform_acceptance_batches_project_id_projects_id_fk` FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
-- Source: 0007_local_real_catalog_acceptance.sql
ALTER TABLE `platform_acceptance_batches` ADD CONSTRAINT `platform_acceptance_batches_requested_by_users_id_fk` FOREIGN KEY (`requested_by`) REFERENCES `monitoring_users`(`id`) ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
-- Source: 0007_local_real_catalog_acceptance.sql
ALTER TABLE `platform_acceptance_checks` ADD CONSTRAINT `platform_acceptance_checks_batch_fk` FOREIGN KEY (`batch_id`) REFERENCES `platform_acceptance_batches`(`id`) ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
-- Source: 0007_local_real_catalog_acceptance.sql
ALTER TABLE `platform_acceptance_checks` ADD CONSTRAINT `platform_acceptance_checks_platform_id_platform_catalog_id_fk` FOREIGN KEY (`platform_id`) REFERENCES `platform_catalog`(`id`) ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
-- Source: 0007_local_real_catalog_acceptance.sql
ALTER TABLE `platform_acceptance_checks` ADD CONSTRAINT `platform_acceptance_checks_run_id_runs_id_fk` FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
-- Source: 0007_local_real_catalog_acceptance.sql
ALTER TABLE `platform_acceptance_checks` ADD CONSTRAINT `platform_acceptance_checks_attempt_id_attempts_id_fk` FOREIGN KEY (`attempt_id`) REFERENCES `attempts`(`id`) ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
-- Source: 0007_local_real_catalog_acceptance.sql
CREATE INDEX `platform_acceptance_owner_created_idx` ON `platform_acceptance_batches` (`owner_id`,`created_at`);
--> statement-breakpoint
-- Source: 0007_local_real_catalog_acceptance.sql
CREATE INDEX `platform_acceptance_status_created_idx` ON `platform_acceptance_batches` (`status`,`created_at`);
--> statement-breakpoint
-- Source: 0007_local_real_catalog_acceptance.sql
CREATE INDEX `platform_acceptance_platform_evidence_idx` ON `platform_acceptance_checks` (`platform_id`,`platform_fingerprint`,`dimension`,`status`);
--> statement-breakpoint
-- Source: 0007_local_real_catalog_acceptance.sql
CREATE INDEX `platform_acceptance_batch_status_idx` ON `platform_acceptance_checks` (`batch_id`,`status`);
--> statement-breakpoint
-- Source: 0007_local_real_catalog_acceptance.sql
CREATE INDEX `pub_media_logo_archive_idx` ON `publisher_media_resources` (`logo_archive_status`,`updated_at`);
--> statement-breakpoint
-- Source: 0008_publisher_logo_provenance.sql
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
-- Source: 0008_publisher_logo_provenance.sql
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
-- Source: 0008_publisher_logo_provenance.sql
ALTER TABLE `publisher_media_resources` MODIFY COLUMN `logo_archive_status` enum('pending','archived','pending_review','missing','failed') NOT NULL DEFAULT 'missing';
--> statement-breakpoint
-- Source: 0008_publisher_logo_provenance.sql
ALTER TABLE `publisher_media_resources` MODIFY COLUMN `logo_source_kind` enum('logo','icon','site_favicon','web_search_verified','manual_verified','generated_fallback');
--> statement-breakpoint
-- Source: 0008_publisher_logo_provenance.sql
UPDATE `publisher_media_resources` SET `logo_candidate_hash` = SHA2(CONCAT('publisher-logo-fallback:v2:', `external_resource_id`, ':', `name`), 256) WHERE `logo_candidate_hash` IS NULL;
--> statement-breakpoint
-- Source: 0008_publisher_logo_provenance.sql
UPDATE `publisher_media_sync_staging` SET `logo_candidate_hash` = SHA2(CONCAT('publisher-logo-fallback:v2:', `external_resource_id`, ':', `name`), 256) WHERE `logo_candidate_hash` IS NULL;
--> statement-breakpoint
-- Source: 0008_publisher_logo_provenance.sql
ALTER TABLE `publisher_media_resources` MODIFY COLUMN `logo_candidate_hash` varchar(64) NOT NULL;
--> statement-breakpoint
-- Source: 0008_publisher_logo_provenance.sql
ALTER TABLE `publisher_media_sync_staging` MODIFY COLUMN `logo_candidate_hash` varchar(64) NOT NULL;
--> statement-breakpoint
-- Source: 0008_publisher_logo_provenance.sql
ALTER TABLE `publisher_media_resources` ADD `logo_review_audit` json AFTER `logo_archive_error`;
--> statement-breakpoint
-- Source: 0008_publisher_logo_provenance.sql
ALTER TABLE `publisher_media_logo_assets` ADD CONSTRAINT `pub_media_logo_assets_media_fk` FOREIGN KEY (`media_resource_id`) REFERENCES `publisher_media_resources`(`id`) ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
-- Source: 0008_publisher_logo_provenance.sql
ALTER TABLE `publisher_media_logo_resolutions` ADD CONSTRAINT `pub_media_logo_resolutions_run_fk` FOREIGN KEY (`sync_run_id`) REFERENCES `publisher_media_sync_runs`(`id`) ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
-- Source: 0008_publisher_logo_provenance.sql
ALTER TABLE `publisher_media_logo_resolutions` ADD CONSTRAINT `pub_media_logo_resolutions_media_fk` FOREIGN KEY (`media_resource_id`) REFERENCES `publisher_media_resources`(`id`) ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
-- Source: 0008_publisher_logo_provenance.sql
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
	AND `logo_size_bytes` IS NOT NULL;
--> statement-breakpoint
-- Source: 0008_publisher_logo_provenance.sql
INSERT INTO `publisher_media_logo_resolutions` (
	`id`, `sync_run_id`, `media_resource_id`, `candidate_hash`, `status`,
	`source_kind`, `logo_sha256`, `error_code`, `review_audit`, `checked_at`
)
SELECT
	UUID(), `last_seen_complete_run_id`, `id`, `logo_candidate_hash`,
	`logo_archive_status`, `logo_source_kind`, `logo_sha256`,
	`logo_archive_error`, `logo_review_audit`, `logo_checked_at`
FROM `publisher_media_resources`
WHERE `last_seen_complete_run_id` IS NOT NULL;
--> statement-breakpoint
-- Source: 0008_publisher_logo_provenance.sql
CREATE INDEX `pub_media_logo_asset_sha_idx` ON `publisher_media_logo_assets` (`sha256`);
--> statement-breakpoint
-- Source: 0008_publisher_logo_provenance.sql
CREATE INDEX `pub_media_logo_resolution_run_status_idx` ON `publisher_media_logo_resolutions` (`sync_run_id`,`status`,`source_kind`);
--> statement-breakpoint
-- Link the UUID projection back to its private monitoring account row.
ALTER TABLE `monitoring_account_links` ADD CONSTRAINT `monitoring_account_links_monitoringUserId_fk` FOREIGN KEY (`monitoringUserId`) REFERENCES `monitoring_users` (`id`) ON DELETE CASCADE;
