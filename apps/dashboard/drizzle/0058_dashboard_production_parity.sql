CREATE TABLE `agent_events` (
	`id` varchar(36) NOT NULL,
	`task_id` varchar(36) NOT NULL,
	`provider_event_id` varchar(512) NOT NULL,
	`event_type` varchar(64) NOT NULL,
	`provider_timestamp_ms` bigint unsigned NOT NULL,
	`normalized_payload` json NOT NULL,
	`received_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `agent_events_id` PRIMARY KEY(`id`),
	CONSTRAINT `agent_events_task_provider_event_uq` UNIQUE(`task_id`,`provider_event_id`)
);
--> statement-breakpoint
CREATE TABLE `agent_operations` (
	`id` varchar(36) NOT NULL,
	`scope` enum('managed_user','website_frontend') NOT NULL,
	`account_user_id` int,
	`presales_project_id` varchar(80),
	`operation_type` varchar(96) NOT NULL,
	`idempotency_key_hash` varchar(64) NOT NULL,
	`request_hash` varchar(64) NOT NULL,
	`contract_name` varchar(128) NOT NULL,
	`contract_revision` int unsigned NOT NULL,
	`schema_hash` varchar(64) NOT NULL,
	`api_credential_id` varchar(36) NOT NULL,
	`credential_version` int unsigned NOT NULL,
	`public_profile` varchar(32) NOT NULL,
	`upstream_model` varchar(64) NOT NULL,
	`status` enum('queued','running','result_pending','succeeded','failed','cancelled','attention_required') NOT NULL DEFAULT 'queued',
	`error_code` varchar(128),
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `agent_operations_id` PRIMARY KEY(`id`),
	CONSTRAINT `agent_operations_scope_idempotency_uq` UNIQUE(`scope`,`idempotency_key_hash`),
	CONSTRAINT `agent_operations_owner_ck` CHECK((
        (`agent_operations`.`scope` = 'managed_user' AND `agent_operations`.`account_user_id` IS NOT NULL AND `agent_operations`.`presales_project_id` IS NULL)
        OR
        (`agent_operations`.`scope` = 'website_frontend' AND `agent_operations`.`account_user_id` IS NULL AND `agent_operations`.`presales_project_id` IS NOT NULL)
      ))
);
--> statement-breakpoint
CREATE TABLE `agent_tasks` (
	`id` varchar(36) NOT NULL,
	`operation_id` varchar(36) NOT NULL,
	`provider_task_id` varchar(255),
	`provider_request_id` varchar(512),
	`create_marker` varchar(128) NOT NULL,
	`title` varchar(255) NOT NULL,
	`provider_state` varchar(32) NOT NULL,
	`last_message_sync_at` timestamp,
	`result_deadline_at` timestamp,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `agent_tasks_id` PRIMARY KEY(`id`),
	CONSTRAINT `agent_tasks_provider_task_uq` UNIQUE(`provider_task_id`),
	CONSTRAINT `agent_tasks_operation_marker_uq` UNIQUE(`operation_id`,`create_marker`)
);
--> statement-breakpoint
CREATE TABLE `artifacts` (
	`id` varchar(96) NOT NULL,
	`operation_id` varchar(36),
	`task_id` varchar(36),
	`source_event_id` varchar(512) NOT NULL,
	`attachment_index` int unsigned NOT NULL,
	`filename` varchar(512) NOT NULL,
	`mime_type` varchar(255) NOT NULL,
	`size_bytes` int unsigned NOT NULL,
	`content_sha256` varchar(64) NOT NULL,
	`storage_key` varchar(1024) NOT NULL,
	`validation_state` enum('staged','valid','invalid') NOT NULL DEFAULT 'staged',
	`ref_count` int unsigned NOT NULL DEFAULT 1,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `artifacts_id` PRIMARY KEY(`id`),
	CONSTRAINT `artifacts_task_event_attachment_uq` UNIQUE(`task_id`,`source_event_id`,`attachment_index`)
);
--> statement-breakpoint
CREATE TABLE `jenova_brand_tracking_assignments` (
	`userId` int NOT NULL,
	`credentialId` varchar(36) NOT NULL,
	`assignedByUserId` int,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `jenova_brand_tracking_assignments_userId` PRIMARY KEY(`userId`)
);
--> statement-breakpoint
CREATE TABLE `jenova_brand_tracking_credentials` (
	`id` varchar(36) NOT NULL,
	`encryptionVersion` int NOT NULL DEFAULT 1,
	`encryptedKey` text NOT NULL,
	`encryptionIv` varchar(32) NOT NULL,
	`encryptionAuthTag` varchar(32) NOT NULL,
	`fingerprint` varchar(32) NOT NULL,
	`status` enum('active','revoked') NOT NULL DEFAULT 'active',
	`validationStatus` enum('unverified','verified','invalid') NOT NULL DEFAULT 'unverified',
	`lastBalance` decimal(20,8),
	`validatedAt` timestamp,
	`balanceSyncedAt` timestamp,
	`revokedAt` timestamp,
	`createdByUserId` int,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `jenova_brand_tracking_credentials_id` PRIMARY KEY(`id`),
	CONSTRAINT `jenova_bt_credentials_fingerprint_uq` UNIQUE(`fingerprint`)
);
--> statement-breakpoint
CREATE TABLE `jenova_brand_tracking_policies` (
	`userId` int NOT NULL,
	`rolling30DayLimit` decimal(20,8) NOT NULL DEFAULT '10.00000000',
	`updatedByUserId` int,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `jenova_brand_tracking_policies_userId` PRIMARY KEY(`userId`)
);
--> statement-breakpoint
CREATE TABLE `jenova_brand_tracking_sessions` (
	`id` varchar(36) NOT NULL,
	`userId` int NOT NULL,
	`credentialId` varchar(36) NOT NULL,
	`clientRequestId` varchar(36) NOT NULL,
	`upstreamSessionId` varchar(255),
	`title` varchar(255) NOT NULL DEFAULT '品牌追踪会话',
	`status` enum('active','archived') NOT NULL DEFAULT 'active',
	`archivedReason` varchar(64),
	`archivedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `jenova_brand_tracking_sessions_id` PRIMARY KEY(`id`),
	CONSTRAINT `jenova_bt_sessions_user_request_uq` UNIQUE(`userId`,`clientRequestId`)
);
--> statement-breakpoint
CREATE TABLE `jenova_brand_tracking_turns` (
	`id` varchar(36) NOT NULL,
	`sessionId` varchar(36) NOT NULL,
	`userId` int NOT NULL,
	`credentialId` varchar(36) NOT NULL,
	`clientRequestId` varchar(36) NOT NULL,
	`idempotencyKey` varchar(191) NOT NULL,
	`upstreamRunId` varchar(255),
	`hiddenKickoff` boolean NOT NULL DEFAULT false,
	`userContent` longtext NOT NULL,
	`assistantContent` longtext NOT NULL,
	`status` enum('pending','streaming','completed','failed','recovering') NOT NULL DEFAULT 'pending',
	`costState` enum('pending','confirmed','unknown') NOT NULL DEFAULT 'pending',
	`usageCost` decimal(20,8),
	`sessionFee` decimal(20,8) NOT NULL DEFAULT '0.00000000',
	`progress` json,
	`warnings` json,
	`stopReason` varchar(255),
	`errorCode` varchar(128),
	`errorMessage` text,
	`startedAt` timestamp,
	`completedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `jenova_brand_tracking_turns_id` PRIMARY KEY(`id`),
	CONSTRAINT `jenova_bt_turns_user_request_uq` UNIQUE(`userId`,`clientRequestId`),
	CONSTRAINT `jenova_bt_turns_idempotency_uq` UNIQUE(`idempotencyKey`)
);
--> statement-breakpoint
CREATE TABLE `knowledge_base_executions` (
	`id` varchar(36) NOT NULL,
	`build_id` varchar(36) NOT NULL,
	`generation` int unsigned NOT NULL,
	`operation_type` enum('initial','revision') NOT NULL,
	`target_leaf_id` varchar(191),
	`base_working_set_id` varchar(36),
	`operation_id` varchar(128) NOT NULL,
	`provider_task_id` varchar(255),
	`api_credential_id` varchar(36) NOT NULL,
	`credential_version` int unsigned NOT NULL,
	`public_profile` varchar(32) NOT NULL,
	`upstream_model` varchar(64) NOT NULL,
	`request_hash` varchar(64) NOT NULL,
	`status` enum('reserved','submitted','result_pending','succeeded','failed','attention_required') NOT NULL DEFAULT 'reserved',
	`error_code` varchar(128),
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	`completed_at` timestamp,
	CONSTRAINT `knowledge_base_executions_id` PRIMARY KEY(`id`),
	CONSTRAINT `knowledge_base_executions_operation_uq` UNIQUE(`build_id`,`generation`,`operation_id`)
);
--> statement-breakpoint
CREATE TABLE `knowledge_base_working_sets` (
	`id` varchar(36) NOT NULL,
	`build_id` varchar(36) NOT NULL,
	`generation` int unsigned NOT NULL,
	`content_version` int unsigned NOT NULL,
	`source_execution_id` varchar(36),
	`storage_key` varchar(1024) NOT NULL,
	`size_bytes` int unsigned NOT NULL,
	`package_sha256` varchar(64) NOT NULL,
	`manifest_sha256` varchar(64) NOT NULL,
	`manifest` json NOT NULL,
	`status` enum('staged','active','superseded','invalid') NOT NULL DEFAULT 'staged',
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`activated_at` timestamp,
	CONSTRAINT `knowledge_base_working_sets_id` PRIMARY KEY(`id`),
	CONSTRAINT `knowledge_base_working_sets_version_uq` UNIQUE(`build_id`,`generation`,`content_version`),
	CONSTRAINT `knowledge_base_working_sets_package_uq` UNIQUE(`build_id`,`generation`,`package_sha256`)
);
--> statement-breakpoint
CREATE TABLE `local_assets` (
	`id` varchar(36) NOT NULL,
	`scope` enum('managed_user','website_frontend') NOT NULL,
	`account_user_id` int,
	`presales_project_id` varchar(80),
	`filename` varchar(512) NOT NULL,
	`mime_type` varchar(255) NOT NULL,
	`size_bytes` int unsigned NOT NULL,
	`content_sha256` varchar(64) NOT NULL,
	`storage_key` varchar(1024) NOT NULL,
	`storage_key_hash` varchar(64) NOT NULL,
	`site_ops_knowledge_input_epoch_id` varchar(36),
	`ref_count` int unsigned NOT NULL DEFAULT 1,
	`retain_until` timestamp,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `local_assets_id` PRIMARY KEY(`id`),
	CONSTRAINT `local_assets_scope_storage_uq` UNIQUE(`scope`,`storage_key_hash`)
);
--> statement-breakpoint
CREATE TABLE `provider_file_leases` (
	`id` varchar(36) NOT NULL,
	`local_asset_id` varchar(36) NOT NULL,
	`api_credential_id` varchar(36) NOT NULL,
	`credential_version` int unsigned NOT NULL,
	`provider_file_id` varchar(512),
	`provider_request_id` varchar(512),
	`upload_state` enum('reserved','uploading','uploaded','expired','failed','outcome_unknown') NOT NULL DEFAULT 'reserved',
	`uploaded_bytes` int unsigned NOT NULL DEFAULT 0,
	`expires_at` timestamp,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `provider_file_leases_id` PRIMARY KEY(`id`),
	CONSTRAINT `provider_file_leases_provider_file_uq` UNIQUE(`provider_file_id`)
);
--> statement-breakpoint
CREATE TABLE `site_build_input_assets` (
	`id` varchar(36) NOT NULL,
	`build_id` varchar(36) NOT NULL,
	`project_id` varchar(36) NOT NULL,
	`user_id` int NOT NULL,
	`source_asset_id` varchar(191) NOT NULL,
	`local_asset_id` varchar(36) NOT NULL,
	`ordinal` int unsigned NOT NULL,
	`filename` varchar(512) NOT NULL,
	`mime_type` varchar(255) NOT NULL,
	`size_bytes` int unsigned NOT NULL,
	`content_sha256` varchar(64) NOT NULL,
	`width` int unsigned NOT NULL,
	`height` int unsigned NOT NULL,
	`public_path` varchar(512) NOT NULL,
	`site_ops_knowledge_input_epoch_id` varchar(36),
	`task_started_at` timestamp NOT NULL,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `site_build_input_assets_id` PRIMARY KEY(`id`),
	CONSTRAINT `site_build_input_assets_build_ordinal_uq` UNIQUE(`build_id`,`ordinal`),
	CONSTRAINT `site_build_input_assets_build_source_uq` UNIQUE(`build_id`,`source_asset_id`),
	CONSTRAINT `site_build_input_assets_build_public_path_uq` UNIQUE(`build_id`,`public_path`)
);
--> statement-breakpoint
CREATE TABLE `site_builds` (
	`id` varchar(36) NOT NULL,
	`project_id` varchar(36) NOT NULL,
	`user_id` int NOT NULL,
	`knowledge_snapshot_id` varchar(36) NOT NULL,
	`knowledge_archive_hash` varchar(64) NOT NULL,
	`parent_build_id` varchar(36),
	`quota_period_id` varchar(36),
	`quota_state` enum('reserved','consumed','released'),
	`ordinal` int unsigned NOT NULL,
	`workflow_upstream_version` varchar(32) NOT NULL,
	`workflow_upstream_hash` varchar(64) NOT NULL,
	`workflow_version` varchar(32) NOT NULL,
	`workflow_package_hash` varchar(64),
	`starter_version` varchar(32) NOT NULL,
	`twenty_first_credential_id` varchar(36),
	`twenty_first_credential_version` int unsigned,
	`style_sample_id` varchar(36),
	`style_revision` int unsigned,
	`brief` json NOT NULL,
	`selection_hash` varchar(64),
	`content_plan_local_asset_id` varchar(36),
	`content_plan_sha256` varchar(64),
	`contract_local_asset_id` varchar(36),
	`contract_hash` varchar(64),
	`source_local_asset_id` varchar(36),
	`source_hash` varchar(64),
	`dist_local_asset_id` varchar(36),
	`dist_hash` varchar(64),
	`qa_local_asset_id` varchar(36),
	`provenance_local_asset_id` varchar(36),
	`upstream_manus_task_id` varchar(255),
	`repair_attempts` int unsigned NOT NULL DEFAULT 0,
	`status` enum('preparing','visual_searching','awaiting_visual_selection','design_compiling','contract_ready','building','qa_running','preview_ready','approved','failed','attention_required','cancelled','superseded') NOT NULL DEFAULT 'preparing',
	`approved_at` timestamp,
	`error_code` varchar(128),
	`error_message` text,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `site_builds_id` PRIMARY KEY(`id`),
	CONSTRAINT `site_builds_project_ordinal_uq` UNIQUE(`project_id`,`ordinal`),
	CONSTRAINT `site_builds_credential_version_ck` CHECK((
        (`site_builds`.`twenty_first_credential_id` IS NULL AND `site_builds`.`twenty_first_credential_version` IS NULL)
        OR
        (`site_builds`.`twenty_first_credential_id` IS NOT NULL AND `site_builds`.`twenty_first_credential_version` IS NOT NULL)
      )),
	CONSTRAINT `site_builds_quota_pair_ck` CHECK((
        (`site_builds`.`quota_period_id` IS NULL AND `site_builds`.`quota_state` IS NULL)
        OR
        (`site_builds`.`quota_period_id` IS NOT NULL AND `site_builds`.`quota_state` IS NOT NULL)
      ))
);
--> statement-breakpoint
CREATE TABLE `site_deployments` (
	`id` varchar(36) NOT NULL,
	`project_id` varchar(36) NOT NULL,
	`user_id` int NOT NULL,
	`build_id` varchar(36) NOT NULL,
	`operation_id` varchar(36),
	`target` enum('global_excluding_cn','mainland_cn') NOT NULL,
	`intent` enum('deploy','rollback') NOT NULL,
	`rollback_of_deployment_id` varchar(36),
	`expected_head_deployment_id` varchar(36),
	`dist_local_asset_id` varchar(36) NOT NULL,
	`dist_hash` varchar(64) NOT NULL,
	`domain_revision` int unsigned NOT NULL,
	`provider_deployment_id` varchar(512),
	`public_url` text,
	`verification` json,
	`status` enum('reserved','deploying','verifying','active','superseded','failed','attention_required') NOT NULL DEFAULT 'reserved',
	`activated_at` timestamp,
	`error_code` varchar(128),
	`error_message` text,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `site_deployments_id` PRIMARY KEY(`id`),
	CONSTRAINT `site_deployments_operation_uq` UNIQUE(`operation_id`)
);
--> statement-breakpoint
CREATE TABLE `site_dns_records` (
	`id` varchar(36) NOT NULL,
	`project_id` varchar(36) NOT NULL,
	`user_id` int NOT NULL,
	`domain_ascii` varchar(255) NOT NULL,
	`domain_revision` int unsigned NOT NULL,
	`record_type` varchar(16) NOT NULL,
	`rr` varchar(255) NOT NULL,
	`expected_value` text NOT NULL,
	`expected_ttl` int unsigned NOT NULL,
	`before_value` text,
	`before_ttl` int unsigned,
	`observed_value` text,
	`observed_ttl` int unsigned,
	`provider_record_id` varchar(191),
	`remark_marker` varchar(255) NOT NULL,
	`status` enum('planned','applying','propagating','active','conflict','failed','outcome_unknown','rolled_back') NOT NULL DEFAULT 'planned',
	`verified_at` timestamp,
	`error_code` varchar(128),
	`error_message` text,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `site_dns_records_id` PRIMARY KEY(`id`),
	CONSTRAINT `site_dns_records_project_revision_tuple_uq` UNIQUE(`project_id`,`domain_revision`,`rr`,`record_type`)
);
--> statement-breakpoint
CREATE TABLE `site_operations` (
	`id` varchar(36) NOT NULL,
	`project_id` varchar(36) NOT NULL,
	`user_id` int NOT NULL,
	`conversation_turn_id` varchar(36),
	`build_id` varchar(36),
	`kind` enum('brief_message','visual_search','site_build','build_revision','deploy','rollback','social_package','domain_sync','dns_apply','dns_rollback') NOT NULL,
	`status` enum('queued','running','succeeded','failed','outcome_unknown','attention_required','cancelled') NOT NULL DEFAULT 'queued',
	`client_request_id` varchar(128) NOT NULL,
	`input_hash` varchar(64) NOT NULL,
	`input` json NOT NULL,
	`provider` varchar(64),
	`provider_operation_id` varchar(512),
	`provider_task_id` varchar(512),
	`lease_owner` varchar(128),
	`lease_expires_at` timestamp,
	`attempt` int unsigned NOT NULL DEFAULT 0,
	`result` json,
	`error_code` varchar(128),
	`error_message` text,
	`started_at` timestamp,
	`completed_at` timestamp,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `site_operations_id` PRIMARY KEY(`id`),
	CONSTRAINT `site_operations_project_request_uq` UNIQUE(`project_id`,`client_request_id`)
);
--> statement-breakpoint
CREATE TABLE `site_projects` (
	`id` varchar(36) NOT NULL,
	`user_id` int NOT NULL,
	`conversation_id` varchar(191) NOT NULL,
	`current_knowledge_snapshot_id` varchar(36),
	`current_build_id` varchar(36),
	`global_live_deployment_id` varchar(36),
	`mainland_live_deployment_id` varchar(36),
	`primary_language` varchar(32) NOT NULL DEFAULT 'zh-CN',
	`canonical_hostname` varchar(255),
	`knowledge_input_epoch_id` varchar(36),
	`current_task_started_at` timestamp NOT NULL DEFAULT (now()),
	`minimum_knowledge_snapshot_version` int unsigned,
	`status` enum('draft','collecting_brief','visual_searching','awaiting_visual_selection','building','preview_ready','approved','live','attention_required','failed','cancelled') NOT NULL DEFAULT 'draft',
	`brief` json,
	`revision` int unsigned NOT NULL DEFAULT 1,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `site_projects_id` PRIMARY KEY(`id`),
	CONSTRAINT `site_projects_user_uq` UNIQUE(`user_id`),
	CONSTRAINT `site_projects_conversation_uq` UNIQUE(`conversation_id`)
);
--> statement-breakpoint
CREATE TABLE `site_provider_connections` (
	`id` varchar(36) NOT NULL,
	`project_id` varchar(36) NOT NULL,
	`user_id` int NOT NULL,
	`provider` enum('aliyun_cn') NOT NULL,
	`account_uid` varchar(128) NOT NULL,
	`oauth_credential_id` varchar(36) NOT NULL,
	`encryption_version` int NOT NULL DEFAULT 1,
	`encrypted_refresh_token` text NOT NULL,
	`encryption_iv` varchar(32) NOT NULL,
	`encryption_auth_tag` varchar(32) NOT NULL,
	`capabilities` json NOT NULL DEFAULT ('[]'),
	`status` enum('active','invalid','revoked') NOT NULL DEFAULT 'active',
	`verified_at` timestamp,
	`last_error_code` varchar(128),
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `site_provider_connections_id` PRIMARY KEY(`id`),
	CONSTRAINT `site_provider_connections_project_provider_uq` UNIQUE(`project_id`,`provider`)
);
--> statement-breakpoint
CREATE TABLE `social_packages` (
	`id` varchar(36) NOT NULL,
	`project_id` varchar(36) NOT NULL,
	`user_id` int NOT NULL,
	`knowledge_snapshot_id` varchar(36) NOT NULL,
	`operation_id` varchar(36),
	`ticket_id` varchar(36),
	`quota_period_id` varchar(36),
	`quota_state` enum('reserved','consumed','released'),
	`channel` enum('wechat','xiaohongshu') NOT NULL,
	`manifest` json,
	`manifest_hash` varchar(64),
	`archive_local_asset_id` varchar(36),
	`archive_hash` varchar(64),
	`preview_local_asset_ids` json NOT NULL DEFAULT ('[]'),
	`qa` json,
	`download_count` int unsigned NOT NULL DEFAULT 0,
	`status` enum('queued','building','ready','failed','attention_required','cancelled') NOT NULL DEFAULT 'queued',
	`error_code` varchar(128),
	`error_message` text,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `social_packages_id` PRIMARY KEY(`id`),
	CONSTRAINT `social_packages_operation_uq` UNIQUE(`operation_id`),
	CONSTRAINT `social_packages_quota_pair_ck` CHECK((
        (`social_packages`.`quota_period_id` IS NULL AND `social_packages`.`quota_state` IS NULL)
        OR
        (`social_packages`.`quota_period_id` IS NOT NULL AND `social_packages`.`quota_state` IS NOT NULL)
      ))
);
--> statement-breakpoint
CREATE TABLE `visual_candidate_pool_items` (
	`id` varchar(36) NOT NULL,
	`pool_page_id` varchar(36) NOT NULL,
	`sample_id` varchar(36) NOT NULL,
	`position` int unsigned NOT NULL,
	`preview_local_asset_id` varchar(36) NOT NULL,
	`preview_sha256` varchar(64) NOT NULL,
	`source_tree_sha256` varchar(64) NOT NULL,
	`provider_template_id` varchar(191) NOT NULL,
	`provider_slug` varchar(191) NOT NULL,
	`provider_version` varchar(191),
	`provider_item_key` varchar(512) NOT NULL,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `visual_candidate_pool_items_id` PRIMARY KEY(`id`),
	CONSTRAINT `visual_candidate_pool_items_page_sample_uq` UNIQUE(`pool_page_id`,`sample_id`),
	CONSTRAINT `visual_candidate_pool_items_page_position_uq` UNIQUE(`pool_page_id`,`position`),
	CONSTRAINT `visual_candidate_pool_items_preview_uq` UNIQUE(`preview_local_asset_id`),
	CONSTRAINT `visual_candidate_pool_items_page_provider_uq` UNIQUE(`pool_page_id`,`provider_item_key`),
	CONSTRAINT `visual_candidate_pool_items_position_ck` CHECK(`visual_candidate_pool_items`.`position` BETWEEN 0 AND 8)
);
--> statement-breakpoint
CREATE TABLE `visual_candidate_pool_pages` (
	`id` varchar(36) NOT NULL,
	`pool_id` varchar(36) NOT NULL,
	`page_number` int unsigned NOT NULL,
	`status` varchar(32) NOT NULL DEFAULT 'reserved',
	`selection_bundle_local_asset_id` varchar(36) NOT NULL,
	`selection_bundle_hash` varchar(64) NOT NULL,
	`candidate_count` int unsigned NOT NULL,
	`bundle_size_bytes` int unsigned NOT NULL,
	`batch_id` varchar(36),
	`published_operation_id` varchar(36),
	`published_at` timestamp,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `visual_candidate_pool_pages_id` PRIMARY KEY(`id`),
	CONSTRAINT `visual_candidate_pool_pages_pool_page_uq` UNIQUE(`pool_id`,`page_number`),
	CONSTRAINT `visual_candidate_pool_pages_batch_uq` UNIQUE(`batch_id`),
	CONSTRAINT `visual_candidate_pool_pages_status_ck` CHECK(`visual_candidate_pool_pages`.`status` IN ('reserved', 'published', 'selected', 'superseded')),
	CONSTRAINT `visual_candidate_pool_pages_capacity_ck` CHECK((`visual_candidate_pool_pages`.`page_number` BETWEEN 1 AND 3 AND `visual_candidate_pool_pages`.`candidate_count` = 9 AND `visual_candidate_pool_pages`.`bundle_size_bytes` > 0 AND `visual_candidate_pool_pages`.`bundle_size_bytes` <= 104857600)),
	CONSTRAINT `visual_candidate_pool_pages_publish_ck` CHECK((
        (`visual_candidate_pool_pages`.`status` = 'reserved' AND `visual_candidate_pool_pages`.`batch_id` IS NULL AND `visual_candidate_pool_pages`.`published_operation_id` IS NULL AND `visual_candidate_pool_pages`.`published_at` IS NULL)
        OR
        (`visual_candidate_pool_pages`.`status` IN ('published', 'selected') AND `visual_candidate_pool_pages`.`batch_id` IS NOT NULL AND `visual_candidate_pool_pages`.`published_operation_id` IS NOT NULL AND `visual_candidate_pool_pages`.`published_at` IS NOT NULL)
        OR
        `visual_candidate_pool_pages`.`status` = 'superseded'
      ))
);
--> statement-breakpoint
CREATE TABLE `visual_candidate_pools` (
	`id` varchar(36) NOT NULL,
	`project_id` varchar(36) NOT NULL,
	`user_id` int NOT NULL,
	`knowledge_snapshot_id` varchar(36) NOT NULL,
	`credential_id` varchar(36) NOT NULL,
	`credential_version` int unsigned NOT NULL,
	`initial_operation_id` varchar(36) NOT NULL,
	`generation_key` varchar(64) NOT NULL,
	`task_started_at` timestamp NOT NULL,
	`project_revision` int unsigned NOT NULL,
	`seed` varchar(64) NOT NULL,
	`catalog_fingerprint` varchar(64) NOT NULL,
	`query_plan_hash` varchar(64) NOT NULL,
	`manifest_local_asset_id` varchar(36) NOT NULL,
	`manifest_hash` varchar(64) NOT NULL,
	`page_count` int unsigned NOT NULL,
	`candidate_count` int unsigned NOT NULL,
	`status` varchar(32) NOT NULL DEFAULT 'active',
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `visual_candidate_pools_id` PRIMARY KEY(`id`),
	CONSTRAINT `visual_candidate_pools_generation_uq` UNIQUE(`generation_key`),
	CONSTRAINT `visual_candidate_pools_status_ck` CHECK(`visual_candidate_pools`.`status` IN ('active', 'selected', 'superseded')),
	CONSTRAINT `visual_candidate_pools_capacity_ck` CHECK((`visual_candidate_pools`.`page_count` BETWEEN 1 AND 3 AND `visual_candidate_pools`.`candidate_count` = `visual_candidate_pools`.`page_count` * 9))
);
--> statement-breakpoint
CREATE TABLE `website_project_attributions` (
	`project_id` varchar(80) NOT NULL,
	`business_owner_name` varchar(40) NOT NULL,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `website_project_attributions_project_id` PRIMARY KEY(`project_id`)
);
--> statement-breakpoint
CREATE TABLE `website_project_deletion_tombstones` (
	`projectId` varchar(80) NOT NULL,
	`schemaVersion` int unsigned NOT NULL DEFAULT 1,
	`status` enum('active','deleting','deleted') NOT NULL DEFAULT 'active',
	`createdAt` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`deletionRequestedAt` timestamp(3),
	`completedAt` timestamp(3),
	CONSTRAINT `website_project_deletion_tombstones_projectId` PRIMARY KEY(`projectId`),
	CONSTRAINT `website_project_deletion_tombstones_schema_version_ck` CHECK(`website_project_deletion_tombstones`.`schemaVersion` = 1)
);
--> statement-breakpoint
ALTER TABLE `website_style_sample_batches` MODIFY COLUMN `ticketId` varchar(36);--> statement-breakpoint
ALTER TABLE `website_style_samples` MODIFY COLUMN `attachmentId` varchar(36);--> statement-breakpoint
ALTER TABLE `api_credentials` ADD `agent_profile` varchar(32);--> statement-breakpoint
ALTER TABLE `delivery_tickets` ADD `parentTicketId` varchar(36);--> statement-breakpoint
ALTER TABLE `delivery_tickets` ADD `rootTicketId` varchar(36);--> statement-breakpoint
ALTER TABLE `delivery_tickets` ADD `workflowStageKey` varchar(255);--> statement-breakpoint
ALTER TABLE `delivery_tickets` ADD `isWorkflowContainer` boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `delivery_tickets` ADD `credentialTargetUserId` int;--> statement-breakpoint
ALTER TABLE `delivery_tickets` ADD `credentialRequestKind` enum('managed_api','jenova_brand_tracking');--> statement-breakpoint
ALTER TABLE `knowledge_base_build_nodes` ADD `content_version` int unsigned;--> statement-breakpoint
ALTER TABLE `knowledge_base_build_nodes` ADD `asset_refs` json;--> statement-breakpoint
ALTER TABLE `knowledge_base_builds` ADD `site_ops_knowledge_input_epoch_id` varchar(36);--> statement-breakpoint
ALTER TABLE `knowledge_base_builds` ADD `execution_mode` varchar(32);--> statement-breakpoint
ALTER TABLE `knowledge_base_builds` ADD `active_working_set_id` varchar(36);--> statement-breakpoint
ALTER TABLE `knowledge_base_builds` ADD `content_version` int unsigned;--> statement-breakpoint
ALTER TABLE `knowledge_base_builds` ADD `providerProtocol` varchar(32) DEFAULT 'legacy_v1' NOT NULL;--> statement-breakpoint
ALTER TABLE `knowledge_base_builds` ADD `canonicalTaskId` varchar(255);--> statement-breakpoint
ALTER TABLE `knowledge_base_builds` ADD `canonicalTaskGeneration` int unsigned;--> statement-breakpoint
ALTER TABLE `knowledge_base_builds` ADD `canonicalCredentialId` varchar(36);--> statement-breakpoint
ALTER TABLE `knowledge_base_builds` ADD `canonicalTaskState` varchar(32) DEFAULT 'unbound' NOT NULL;--> statement-breakpoint
ALTER TABLE `knowledge_base_builds` ADD `canonicalTaskUrl` varchar(1024);--> statement-breakpoint
ALTER TABLE `knowledge_base_builds` ADD `canonicalTaskCreatedAt` timestamp;--> statement-breakpoint
ALTER TABLE `knowledge_base_builds` ADD `handoffProvenance` json;--> statement-breakpoint
ALTER TABLE `knowledge_base_builds` ADD `treePolicyVersion` int unsigned DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `knowledge_base_builds` ADD `initialResearchCoverage` json;--> statement-breakpoint
ALTER TABLE `knowledge_base_builds` ADD `skillArchiveSha256` varchar(64);--> statement-breakpoint
ALTER TABLE `knowledge_base_builds` ADD `skillArchiveBytes` int unsigned;--> statement-breakpoint
ALTER TABLE `knowledge_base_builds` ADD `skillArchiveStorageKey` varchar(1024);--> statement-breakpoint
ALTER TABLE `knowledge_base_builds` ADD `contentCompletedAt` timestamp;--> statement-breakpoint
ALTER TABLE `knowledge_base_builds` ADD `packageStatus` varchar(32) DEFAULT 'not_started' NOT NULL;--> statement-breakpoint
ALTER TABLE `knowledge_base_builds` ADD `packageAttemptCount` int unsigned DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `knowledge_base_builds` ADD `packageNextRetryAt` timestamp;--> statement-breakpoint
ALTER TABLE `knowledge_base_builds` ADD `packageLastErrorCode` varchar(128);--> statement-breakpoint
ALTER TABLE `knowledge_base_snapshots` ADD `siteOpsKnowledgeInputEpochId` varchar(36);--> statement-breakpoint
ALTER TABLE `knowledge_import_receipts` ADD `siteOpsKnowledgeInputEpochId` varchar(36);--> statement-breakpoint
ALTER TABLE `presales_monitor_runs` ADD `projectId` varchar(80);--> statement-breakpoint
ALTER TABLE `presales_upstream_resources` ADD `projectId` varchar(80);--> statement-breakpoint
ALTER TABLE `users` ADD `brandTrackingMonthlyLimit` int unsigned;--> statement-breakpoint
ALTER TABLE `website_manual_service_orders` ADD `marketEdition` enum('domestic','overseas') DEFAULT 'domestic' NOT NULL;--> statement-breakpoint
ALTER TABLE `website_style_sample_batches` ADD `sourceKind` enum('legacy_manual_three','siteops_21st') DEFAULT 'legacy_manual_three' NOT NULL;--> statement-breakpoint
ALTER TABLE `website_style_sample_batches` ADD `siteProjectId` varchar(36);--> statement-breakpoint
ALTER TABLE `website_style_sample_batches` ADD `selectionBundleLocalAssetId` varchar(36);--> statement-breakpoint
ALTER TABLE `website_style_sample_batches` ADD `selectionBundleHash` varchar(64);--> statement-breakpoint
ALTER TABLE `website_style_samples` ADD `previewLocalAssetId` varchar(36);--> statement-breakpoint
ALTER TABLE `website_style_samples` ADD `sourceMetadata` json;--> statement-breakpoint
ALTER TABLE `website_user_provisions` ADD `marketEdition` enum('domestic','overseas') DEFAULT 'domestic' NOT NULL;--> statement-breakpoint
ALTER TABLE `workspace_site_profiles` ADD `normalizedAsciiDomain` varchar(255);--> statement-breakpoint
ALTER TABLE `workspace_site_profiles` ADD `unicodeDisplayDomain` varchar(255);--> statement-breakpoint
ALTER TABLE `workspace_site_profiles` ADD `domainRevision` int unsigned DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `workspace_site_profiles` ADD `providerAccountUid` varchar(128);--> statement-breakpoint
ALTER TABLE `workspace_site_profiles` ADD `domainOwnershipStatus` varchar(64);--> statement-breakpoint
ALTER TABLE `workspace_site_profiles` ADD `dnsStatus` varchar(64);--> statement-breakpoint
ALTER TABLE `workspace_site_profiles` ADD `icpDomainRevision` int unsigned;--> statement-breakpoint
ALTER TABLE `delivery_tickets` ADD CONSTRAINT `delivery_tickets_parent_stage_uq` UNIQUE(`parentTicketId`,`workflowStageKey`);--> statement-breakpoint
ALTER TABLE `knowledge_base_builds` ADD CONSTRAINT `knowledge_base_builds_canonical_task_idx` UNIQUE(`canonicalTaskId`);--> statement-breakpoint
ALTER TABLE `jenova_brand_tracking_assignments` ADD CONSTRAINT `jenova_brand_tracking_assignments_userId_users_id_fk` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `jenova_brand_tracking_assignments` ADD CONSTRAINT `jenova_brand_tracking_assignments_assignedByUserId_users_id_fk` FOREIGN KEY (`assignedByUserId`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `jenova_brand_tracking_assignments` ADD CONSTRAINT `jenova_bt_assignments_credential_fk` FOREIGN KEY (`credentialId`) REFERENCES `jenova_brand_tracking_credentials`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `jenova_brand_tracking_credentials` ADD CONSTRAINT `jenova_brand_tracking_credentials_createdByUserId_users_id_fk` FOREIGN KEY (`createdByUserId`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `jenova_brand_tracking_policies` ADD CONSTRAINT `jenova_brand_tracking_policies_userId_users_id_fk` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `jenova_brand_tracking_policies` ADD CONSTRAINT `jenova_brand_tracking_policies_updatedByUserId_users_id_fk` FOREIGN KEY (`updatedByUserId`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `jenova_brand_tracking_sessions` ADD CONSTRAINT `jenova_brand_tracking_sessions_userId_users_id_fk` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `jenova_brand_tracking_sessions` ADD CONSTRAINT `jenova_bt_sessions_credential_fk` FOREIGN KEY (`credentialId`) REFERENCES `jenova_brand_tracking_credentials`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `jenova_brand_tracking_turns` ADD CONSTRAINT `jenova_brand_tracking_turns_userId_users_id_fk` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `jenova_brand_tracking_turns` ADD CONSTRAINT `jenova_bt_turns_session_fk` FOREIGN KEY (`sessionId`) REFERENCES `jenova_brand_tracking_sessions`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `jenova_brand_tracking_turns` ADD CONSTRAINT `jenova_bt_turns_credential_fk` FOREIGN KEY (`credentialId`) REFERENCES `jenova_brand_tracking_credentials`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `site_build_input_assets` ADD CONSTRAINT `site_build_input_assets_build_id_site_builds_id_fk` FOREIGN KEY (`build_id`) REFERENCES `site_builds`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `site_build_input_assets` ADD CONSTRAINT `site_build_input_assets_project_id_site_projects_id_fk` FOREIGN KEY (`project_id`) REFERENCES `site_projects`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `site_build_input_assets` ADD CONSTRAINT `site_build_input_assets_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `site_build_input_assets` ADD CONSTRAINT `site_build_input_assets_local_asset_id_local_assets_id_fk` FOREIGN KEY (`local_asset_id`) REFERENCES `local_assets`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `site_builds` ADD CONSTRAINT `site_builds_project_id_site_projects_id_fk` FOREIGN KEY (`project_id`) REFERENCES `site_projects`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `site_builds` ADD CONSTRAINT `site_builds_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `site_builds` ADD CONSTRAINT `site_builds_knowledge_snapshot_id_knowledge_base_snapshots_id_fk` FOREIGN KEY (`knowledge_snapshot_id`) REFERENCES `knowledge_base_snapshots`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `site_builds` ADD CONSTRAINT `site_builds_style_sample_id_website_style_samples_id_fk` FOREIGN KEY (`style_sample_id`) REFERENCES `website_style_samples`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `site_builds` ADD CONSTRAINT `site_builds_contract_local_asset_id_local_assets_id_fk` FOREIGN KEY (`contract_local_asset_id`) REFERENCES `local_assets`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `site_builds` ADD CONSTRAINT `site_builds_source_local_asset_id_local_assets_id_fk` FOREIGN KEY (`source_local_asset_id`) REFERENCES `local_assets`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `site_builds` ADD CONSTRAINT `site_builds_dist_local_asset_id_local_assets_id_fk` FOREIGN KEY (`dist_local_asset_id`) REFERENCES `local_assets`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `site_builds` ADD CONSTRAINT `site_builds_qa_local_asset_id_local_assets_id_fk` FOREIGN KEY (`qa_local_asset_id`) REFERENCES `local_assets`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `site_builds` ADD CONSTRAINT `site_builds_provenance_local_asset_id_local_assets_id_fk` FOREIGN KEY (`provenance_local_asset_id`) REFERENCES `local_assets`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `site_builds` ADD CONSTRAINT `site_builds_21st_credential_fk` FOREIGN KEY (`twenty_first_credential_id`) REFERENCES `presales_api_credentials`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `site_builds` ADD CONSTRAINT `site_builds_quota_period_fk` FOREIGN KEY (`quota_period_id`) REFERENCES `service_quota_periods`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `site_deployments` ADD CONSTRAINT `site_deployments_project_id_site_projects_id_fk` FOREIGN KEY (`project_id`) REFERENCES `site_projects`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `site_deployments` ADD CONSTRAINT `site_deployments_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `site_deployments` ADD CONSTRAINT `site_deployments_build_id_site_builds_id_fk` FOREIGN KEY (`build_id`) REFERENCES `site_builds`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `site_deployments` ADD CONSTRAINT `site_deployments_operation_id_site_operations_id_fk` FOREIGN KEY (`operation_id`) REFERENCES `site_operations`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `site_deployments` ADD CONSTRAINT `site_deployments_dist_local_asset_id_local_assets_id_fk` FOREIGN KEY (`dist_local_asset_id`) REFERENCES `local_assets`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `site_dns_records` ADD CONSTRAINT `site_dns_records_project_id_site_projects_id_fk` FOREIGN KEY (`project_id`) REFERENCES `site_projects`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `site_dns_records` ADD CONSTRAINT `site_dns_records_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `site_operations` ADD CONSTRAINT `site_operations_project_id_site_projects_id_fk` FOREIGN KEY (`project_id`) REFERENCES `site_projects`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `site_operations` ADD CONSTRAINT `site_operations_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `site_operations` ADD CONSTRAINT `site_operations_conversation_turn_id_conversation_turns_id_fk` FOREIGN KEY (`conversation_turn_id`) REFERENCES `conversation_turns`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `site_operations` ADD CONSTRAINT `site_operations_build_id_site_builds_id_fk` FOREIGN KEY (`build_id`) REFERENCES `site_builds`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `site_projects` ADD CONSTRAINT `site_projects_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `site_projects` ADD CONSTRAINT `site_projects_conversation_id_conversations_id_fk` FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `site_projects` ADD CONSTRAINT `site_projects_snapshot_fk` FOREIGN KEY (`current_knowledge_snapshot_id`) REFERENCES `knowledge_base_snapshots`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `site_provider_connections` ADD CONSTRAINT `site_provider_connections_project_id_site_projects_id_fk` FOREIGN KEY (`project_id`) REFERENCES `site_projects`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `site_provider_connections` ADD CONSTRAINT `site_provider_connections_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `site_provider_connections` ADD CONSTRAINT `site_provider_connections_oauth_credential_fk` FOREIGN KEY (`oauth_credential_id`) REFERENCES `presales_api_credentials`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `social_packages` ADD CONSTRAINT `social_packages_project_id_site_projects_id_fk` FOREIGN KEY (`project_id`) REFERENCES `site_projects`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `social_packages` ADD CONSTRAINT `social_packages_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `social_packages` ADD CONSTRAINT `social_packages_operation_id_site_operations_id_fk` FOREIGN KEY (`operation_id`) REFERENCES `site_operations`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `social_packages` ADD CONSTRAINT `social_packages_ticket_id_delivery_tickets_id_fk` FOREIGN KEY (`ticket_id`) REFERENCES `delivery_tickets`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `social_packages` ADD CONSTRAINT `social_packages_archive_local_asset_id_local_assets_id_fk` FOREIGN KEY (`archive_local_asset_id`) REFERENCES `local_assets`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `social_packages` ADD CONSTRAINT `social_packages_snapshot_fk` FOREIGN KEY (`knowledge_snapshot_id`) REFERENCES `knowledge_base_snapshots`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `social_packages` ADD CONSTRAINT `social_packages_quota_period_fk` FOREIGN KEY (`quota_period_id`) REFERENCES `service_quota_periods`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `visual_candidate_pool_items` ADD CONSTRAINT `visual_candidate_pool_items_page_fk` FOREIGN KEY (`pool_page_id`) REFERENCES `visual_candidate_pool_pages`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `visual_candidate_pool_items` ADD CONSTRAINT `visual_candidate_pool_items_preview_fk` FOREIGN KEY (`preview_local_asset_id`) REFERENCES `local_assets`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `visual_candidate_pool_pages` ADD CONSTRAINT `visual_candidate_pool_pages_pool_fk` FOREIGN KEY (`pool_id`) REFERENCES `visual_candidate_pools`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `visual_candidate_pool_pages` ADD CONSTRAINT `visual_candidate_pool_pages_bundle_fk` FOREIGN KEY (`selection_bundle_local_asset_id`) REFERENCES `local_assets`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `visual_candidate_pool_pages` ADD CONSTRAINT `visual_candidate_pool_pages_batch_fk` FOREIGN KEY (`batch_id`) REFERENCES `website_style_sample_batches`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `visual_candidate_pool_pages` ADD CONSTRAINT `visual_candidate_pool_pages_operation_fk` FOREIGN KEY (`published_operation_id`) REFERENCES `site_operations`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `visual_candidate_pools` ADD CONSTRAINT `visual_candidate_pools_project_fk` FOREIGN KEY (`project_id`) REFERENCES `site_projects`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `visual_candidate_pools` ADD CONSTRAINT `visual_candidate_pools_user_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `visual_candidate_pools` ADD CONSTRAINT `visual_candidate_pools_snapshot_fk` FOREIGN KEY (`knowledge_snapshot_id`) REFERENCES `knowledge_base_snapshots`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `visual_candidate_pools` ADD CONSTRAINT `visual_candidate_pools_credential_fk` FOREIGN KEY (`credential_id`) REFERENCES `presales_api_credentials`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `visual_candidate_pools` ADD CONSTRAINT `visual_candidate_pools_operation_fk` FOREIGN KEY (`initial_operation_id`) REFERENCES `site_operations`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `visual_candidate_pools` ADD CONSTRAINT `visual_candidate_pools_manifest_fk` FOREIGN KEY (`manifest_local_asset_id`) REFERENCES `local_assets`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `agent_events_task_time_idx` ON `agent_events` (`task_id`,`provider_timestamp_ms`);--> statement-breakpoint
CREATE INDEX `agent_operations_account_status_idx` ON `agent_operations` (`account_user_id`,`status`);--> statement-breakpoint
CREATE INDEX `agent_operations_project_status_idx` ON `agent_operations` (`presales_project_id`,`status`);--> statement-breakpoint
CREATE INDEX `agent_tasks_operation_state_idx` ON `agent_tasks` (`operation_id`,`provider_state`);--> statement-breakpoint
CREATE INDEX `artifacts_operation_validation_idx` ON `artifacts` (`operation_id`,`validation_state`);--> statement-breakpoint
CREATE INDEX `jenova_bt_assignments_credential_idx` ON `jenova_brand_tracking_assignments` (`credentialId`);--> statement-breakpoint
CREATE INDEX `jenova_bt_credentials_status_idx` ON `jenova_brand_tracking_credentials` (`status`);--> statement-breakpoint
CREATE INDEX `jenova_bt_sessions_user_status_updated_idx` ON `jenova_brand_tracking_sessions` (`userId`,`status`,`updatedAt`);--> statement-breakpoint
CREATE INDEX `jenova_bt_sessions_upstream_idx` ON `jenova_brand_tracking_sessions` (`upstreamSessionId`);--> statement-breakpoint
CREATE INDEX `jenova_bt_turns_session_created_idx` ON `jenova_brand_tracking_turns` (`sessionId`,`createdAt`);--> statement-breakpoint
CREATE INDEX `jenova_bt_turns_user_cost_created_idx` ON `jenova_brand_tracking_turns` (`userId`,`costState`,`createdAt`);--> statement-breakpoint
CREATE INDEX `jenova_bt_turns_credential_cost_idx` ON `jenova_brand_tracking_turns` (`credentialId`,`costState`);--> statement-breakpoint
CREATE INDEX `jenova_bt_turns_status_updated_idx` ON `jenova_brand_tracking_turns` (`status`,`updatedAt`);--> statement-breakpoint
CREATE INDEX `knowledge_base_executions_status_idx` ON `knowledge_base_executions` (`build_id`,`status`);--> statement-breakpoint
CREATE INDEX `knowledge_base_working_sets_status_idx` ON `knowledge_base_working_sets` (`build_id`,`status`);--> statement-breakpoint
CREATE INDEX `local_assets_account_hash_idx` ON `local_assets` (`account_user_id`,`content_sha256`);--> statement-breakpoint
CREATE INDEX `local_assets_project_hash_idx` ON `local_assets` (`presales_project_id`,`content_sha256`);--> statement-breakpoint
CREATE INDEX `local_assets_siteops_epoch_idx` ON `local_assets` (`account_user_id`,`site_ops_knowledge_input_epoch_id`);--> statement-breakpoint
CREATE INDEX `provider_file_leases_asset_credential_idx` ON `provider_file_leases` (`local_asset_id`,`api_credential_id`,`upload_state`);--> statement-breakpoint
CREATE INDEX `site_build_input_assets_local_asset_idx` ON `site_build_input_assets` (`local_asset_id`);--> statement-breakpoint
CREATE INDEX `site_build_input_assets_project_task_idx` ON `site_build_input_assets` (`project_id`,`task_started_at`);--> statement-breakpoint
CREATE INDEX `site_build_input_assets_project_epoch_idx` ON `site_build_input_assets` (`project_id`,`site_ops_knowledge_input_epoch_id`);--> statement-breakpoint
CREATE INDEX `site_builds_project_status_idx` ON `site_builds` (`project_id`,`status`);--> statement-breakpoint
CREATE INDEX `site_builds_parent_idx` ON `site_builds` (`parent_build_id`);--> statement-breakpoint
CREATE INDEX `site_builds_quota_period_state_idx` ON `site_builds` (`quota_period_id`,`quota_state`);--> statement-breakpoint
CREATE INDEX `site_deployments_project_target_status_idx` ON `site_deployments` (`project_id`,`target`,`status`);--> statement-breakpoint
CREATE INDEX `site_dns_records_status_idx` ON `site_dns_records` (`status`,`updated_at`);--> statement-breakpoint
CREATE INDEX `site_operations_lease_idx` ON `site_operations` (`status`,`lease_expires_at`,`created_at`);--> statement-breakpoint
CREATE INDEX `site_operations_build_idx` ON `site_operations` (`build_id`,`status`);--> statement-breakpoint
CREATE INDEX `site_projects_status_updated_idx` ON `site_projects` (`status`,`updated_at`);--> statement-breakpoint
CREATE INDEX `site_provider_connections_account_idx` ON `site_provider_connections` (`account_uid`);--> statement-breakpoint
CREATE INDEX `social_packages_project_channel_idx` ON `social_packages` (`project_id`,`channel`,`created_at`);--> statement-breakpoint
CREATE INDEX `social_packages_quota_period_state_idx` ON `social_packages` (`quota_period_id`,`quota_state`);--> statement-breakpoint
CREATE INDEX `visual_candidate_pool_items_source_tree_idx` ON `visual_candidate_pool_items` (`source_tree_sha256`);--> statement-breakpoint
CREATE INDEX `visual_candidate_pool_pages_status_idx` ON `visual_candidate_pool_pages` (`pool_id`,`status`,`page_number`);--> statement-breakpoint
CREATE INDEX `visual_candidate_pools_project_task_idx` ON `visual_candidate_pools` (`project_id`,`task_started_at`,`status`);--> statement-breakpoint
CREATE INDEX `visual_candidate_pools_snapshot_credential_idx` ON `visual_candidate_pools` (`knowledge_snapshot_id`,`credential_id`,`credential_version`);--> statement-breakpoint
ALTER TABLE `website_style_sample_batches` ADD CONSTRAINT `website_style_batches_source_ck` CHECK ((
        (`website_style_sample_batches`.`sourceKind` = 'legacy_manual_three' AND `website_style_sample_batches`.`ticketId` IS NOT NULL AND `website_style_sample_batches`.`siteProjectId` IS NULL)
        OR
        (`website_style_sample_batches`.`sourceKind` = 'siteops_21st' AND `website_style_sample_batches`.`ticketId` IS NULL AND `website_style_sample_batches`.`siteProjectId` IS NOT NULL)
      ));--> statement-breakpoint
ALTER TABLE `website_style_samples` ADD CONSTRAINT `website_style_samples_source_ck` CHECK ((
        (`website_style_samples`.`attachmentId` IS NOT NULL AND `website_style_samples`.`previewLocalAssetId` IS NULL)
        OR
        (`website_style_samples`.`attachmentId` IS NULL AND `website_style_samples`.`previewLocalAssetId` IS NOT NULL)
      ));--> statement-breakpoint
ALTER TABLE `delivery_tickets` ADD CONSTRAINT `delivery_tickets_credentialTargetUserId_users_id_fk` FOREIGN KEY (`credentialTargetUserId`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `delivery_tickets` ADD CONSTRAINT `delivery_tickets_parent_ticket_fk` FOREIGN KEY (`parentTicketId`) REFERENCES `delivery_tickets`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `delivery_tickets` ADD CONSTRAINT `delivery_tickets_root_ticket_fk` FOREIGN KEY (`rootTicketId`) REFERENCES `delivery_tickets`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `website_style_sample_batches` ADD CONSTRAINT `website_style_batches_bundle_asset_fk` FOREIGN KEY (`selectionBundleLocalAssetId`) REFERENCES `local_assets`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `website_style_samples` ADD CONSTRAINT `website_style_samples_previewLocalAssetId_local_assets_id_fk` FOREIGN KEY (`previewLocalAssetId`) REFERENCES `local_assets`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `delivery_tickets_parent_operation_idx` ON `delivery_tickets` (`parentTicketId`,`operation`);--> statement-breakpoint
CREATE INDEX `delivery_tickets_root_status_idx` ON `delivery_tickets` (`rootTicketId`,`status`);--> statement-breakpoint
CREATE INDEX `delivery_tickets_user_container_updated_idx` ON `delivery_tickets` (`userId`,`isWorkflowContainer`,`updatedAt`,`id`);--> statement-breakpoint
CREATE INDEX `delivery_tickets_credential_target_status_idx` ON `delivery_tickets` (`credentialRequestKind`,`credentialTargetUserId`,`status`);--> statement-breakpoint
CREATE INDEX `knowledge_base_builds_canonical_credential_idx` ON `knowledge_base_builds` (`canonicalCredentialId`);--> statement-breakpoint
CREATE INDEX `presales_monitor_project_idx` ON `presales_monitor_runs` (`projectId`);--> statement-breakpoint
CREATE INDEX `presales_upstream_resources_project_idx` ON `presales_upstream_resources` (`projectId`);--> statement-breakpoint
CREATE INDEX `website_style_batches_site_project_status_idx` ON `website_style_sample_batches` (`siteProjectId`,`status`);--> statement-breakpoint
CREATE INDEX `workspace_site_profiles_ascii_domain_idx` ON `workspace_site_profiles` (`normalizedAsciiDomain`);