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
CREATE TABLE `publisher_article_version_assets` (
	`owner_id` varchar(36) NOT NULL,
	`article_version_id` varchar(36) NOT NULL,
	`asset_id` varchar(36) NOT NULL,
	`sort_order` int unsigned NOT NULL DEFAULT 0,
	`created_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `publisher_article_version_assets_article_version_id_asset_id_pk` PRIMARY KEY(`article_version_id`,`asset_id`)
);
--> statement-breakpoint
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
CREATE TABLE `publisher_submission_gate` (
	`id` varchar(32) NOT NULL,
	`lease_owner` varchar(128),
	`lease_expires_at` datetime(3),
	`next_allowed_at` datetime(3) NOT NULL,
	`updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
	CONSTRAINT `publisher_submission_gate_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
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
ALTER TABLE `media_publishing_bank_transfer_reviews` ADD CONSTRAINT `media_pub_bank_review_order_fk` FOREIGN KEY (`order_id`) REFERENCES `media_publishing_topup_orders`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `media_publishing_bank_transfer_reviews` ADD CONSTRAINT `media_publishing_bank_transfer_reviews_reviewed_by_users_id_fk` FOREIGN KEY (`reviewed_by`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `media_publishing_item_price_snapshots` ADD CONSTRAINT `media_publishing_item_price_snapshots_owner_id_users_id_fk` FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `media_publishing_item_price_snapshots` ADD CONSTRAINT `media_pub_price_resource_fk` FOREIGN KEY (`media_resource_id`) REFERENCES `publisher_media_resources`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `media_publishing_item_price_snapshots` ADD CONSTRAINT `media_pub_price_item_owner_fk` FOREIGN KEY (`item_id`,`owner_id`) REFERENCES `publisher_items`(`id`,`owner_id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `media_publishing_item_settlements` ADD CONSTRAINT `media_publishing_item_settlements_owner_id_users_id_fk` FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `media_publishing_item_settlements` ADD CONSTRAINT `media_pub_settlements_item_owner_fk` FOREIGN KEY (`item_id`,`owner_id`) REFERENCES `publisher_items`(`id`,`owner_id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `media_publishing_item_settlements` ADD CONSTRAINT `media_pub_settlements_reservation_owner_fk` FOREIGN KEY (`reservation_id`,`owner_id`) REFERENCES `media_publishing_reservations`(`id`,`owner_id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `media_publishing_ledger` ADD CONSTRAINT `media_publishing_ledger_owner_id_users_id_fk` FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `media_publishing_ledger` ADD CONSTRAINT `media_pub_ledger_reservation_fk` FOREIGN KEY (`reservation_id`) REFERENCES `media_publishing_reservations`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `media_publishing_ledger` ADD CONSTRAINT `media_publishing_ledger_item_id_publisher_items_id_fk` FOREIGN KEY (`item_id`) REFERENCES `publisher_items`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `media_publishing_ledger` ADD CONSTRAINT `media_publishing_ledger_actor_id_users_id_fk` FOREIGN KEY (`actor_id`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `media_publishing_reservations` ADD CONSTRAINT `media_publishing_reservations_owner_id_users_id_fk` FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `media_publishing_reservations` ADD CONSTRAINT `media_pub_reservations_batch_owner_fk` FOREIGN KEY (`batch_id`,`owner_id`) REFERENCES `publisher_batches`(`id`,`owner_id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `media_publishing_topup_orders` ADD CONSTRAINT `media_pub_topup_replaces_fk` FOREIGN KEY (`replaces_order_id`) REFERENCES `media_publishing_topup_orders`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `media_publishing_topup_orders` ADD CONSTRAINT `media_publishing_topup_orders_owner_id_users_id_fk` FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `media_publishing_topup_receipts` ADD CONSTRAINT `media_pub_receipt_order_fk` FOREIGN KEY (`order_id`) REFERENCES `media_publishing_topup_orders`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `media_publishing_wallets` ADD CONSTRAINT `media_publishing_wallets_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `payment_order_routes` ADD CONSTRAINT `payment_order_routes_monitoring_order_id_topup_orders_id_fk` FOREIGN KEY (`monitoring_order_id`) REFERENCES `topup_orders`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `payment_order_routes` ADD CONSTRAINT `payment_routes_media_order_fk` FOREIGN KEY (`media_publishing_order_id`) REFERENCES `media_publishing_topup_orders`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `publisher_article_assets` ADD CONSTRAINT `publisher_article_assets_owner_id_users_id_fk` FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `publisher_article_assets` ADD CONSTRAINT `pub_assets_article_owner_fk` FOREIGN KEY (`article_id`,`owner_id`) REFERENCES `publisher_articles`(`id`,`owner_id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `publisher_article_assets` ADD CONSTRAINT `pub_assets_import_owner_fk` FOREIGN KEY (`source_import_id`,`owner_id`) REFERENCES `publisher_docx_imports`(`id`,`owner_id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `publisher_article_version_assets` ADD CONSTRAINT `publisher_article_version_assets_owner_id_users_id_fk` FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `publisher_article_version_assets` ADD CONSTRAINT `pub_version_assets_version_owner_fk` FOREIGN KEY (`article_version_id`,`owner_id`) REFERENCES `publisher_article_versions`(`id`,`owner_id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `publisher_article_version_assets` ADD CONSTRAINT `pub_version_assets_asset_owner_fk` FOREIGN KEY (`asset_id`,`owner_id`) REFERENCES `publisher_article_assets`(`id`,`owner_id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `publisher_article_versions` ADD CONSTRAINT `publisher_article_versions_owner_id_users_id_fk` FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `publisher_article_versions` ADD CONSTRAINT `publisher_article_versions_created_by_users_id_fk` FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `publisher_article_versions` ADD CONSTRAINT `pub_versions_article_owner_fk` FOREIGN KEY (`article_id`,`owner_id`) REFERENCES `publisher_articles`(`id`,`owner_id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `publisher_article_versions` ADD CONSTRAINT `pub_versions_import_owner_fk` FOREIGN KEY (`source_import_id`,`owner_id`) REFERENCES `publisher_docx_imports`(`id`,`owner_id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `publisher_articles` ADD CONSTRAINT `publisher_articles_owner_id_users_id_fk` FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `publisher_batches` ADD CONSTRAINT `publisher_batches_owner_id_users_id_fk` FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `publisher_batches` ADD CONSTRAINT `pub_batches_draft_owner_fk` FOREIGN KEY (`draft_id`,`owner_id`) REFERENCES `publisher_drafts`(`id`,`owner_id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `publisher_batches` ADD CONSTRAINT `pub_batches_version_owner_fk` FOREIGN KEY (`article_version_id`,`owner_id`) REFERENCES `publisher_article_versions`(`id`,`owner_id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `publisher_docx_imports` ADD CONSTRAINT `publisher_docx_imports_owner_id_users_id_fk` FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `publisher_docx_imports` ADD CONSTRAINT `pub_imports_article_owner_fk` FOREIGN KEY (`article_id`,`owner_id`) REFERENCES `publisher_articles`(`id`,`owner_id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `publisher_draft_items` ADD CONSTRAINT `publisher_draft_items_owner_id_users_id_fk` FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `publisher_draft_items` ADD CONSTRAINT `pub_draft_items_media_fk` FOREIGN KEY (`media_resource_id`) REFERENCES `publisher_media_resources`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `publisher_draft_items` ADD CONSTRAINT `pub_draft_items_draft_owner_fk` FOREIGN KEY (`draft_id`,`owner_id`) REFERENCES `publisher_drafts`(`id`,`owner_id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `publisher_drafts` ADD CONSTRAINT `publisher_drafts_owner_id_users_id_fk` FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `publisher_drafts` ADD CONSTRAINT `pub_drafts_version_owner_fk` FOREIGN KEY (`article_version_id`,`owner_id`) REFERENCES `publisher_article_versions`(`id`,`owner_id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `publisher_preflights` ADD CONSTRAINT `publisher_preflights_owner_id_users_id_fk` FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `publisher_preflights` ADD CONSTRAINT `pub_preflights_draft_owner_fk` FOREIGN KEY (`draft_id`,`owner_id`) REFERENCES `publisher_drafts`(`id`,`owner_id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `publisher_items` ADD CONSTRAINT `publisher_items_owner_id_users_id_fk` FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `publisher_items` ADD CONSTRAINT `pub_items_media_fk` FOREIGN KEY (`media_resource_id`) REFERENCES `publisher_media_resources`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `publisher_items` ADD CONSTRAINT `pub_items_batch_owner_fk` FOREIGN KEY (`batch_id`,`owner_id`) REFERENCES `publisher_batches`(`id`,`owner_id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `publisher_live_whitelist` ADD CONSTRAINT `pub_live_whitelist_media_fk` FOREIGN KEY (`media_resource_id`) REFERENCES `publisher_media_resources`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `publisher_live_whitelist` ADD CONSTRAINT `publisher_live_whitelist_enabled_by_users_id_fk` FOREIGN KEY (`enabled_by`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `publisher_media_capabilities` ADD CONSTRAINT `pub_media_capabilities_resource_fk` FOREIGN KEY (`media_resource_id`) REFERENCES `publisher_media_resources`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `publisher_media_capabilities` ADD CONSTRAINT `publisher_media_capabilities_verified_by_users_id_fk` FOREIGN KEY (`verified_by`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `publisher_media_resources` ADD CONSTRAINT `pub_media_last_sync_run_fk` FOREIGN KEY (`last_seen_complete_run_id`) REFERENCES `publisher_media_sync_runs`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `publisher_media_sync_runs` ADD CONSTRAINT `publisher_media_sync_runs_started_by_users_id_fk` FOREIGN KEY (`started_by`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `publisher_media_sync_staging` ADD CONSTRAINT `pub_media_staging_run_fk` FOREIGN KEY (`run_id`) REFERENCES `publisher_media_sync_runs`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `publisher_object_leases` ADD CONSTRAINT `publisher_object_leases_owner_id_users_id_fk` FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `publisher_reconciliation_candidates` ADD CONSTRAINT `pub_reconciliation_item_fk` FOREIGN KEY (`item_id`) REFERENCES `publisher_items`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `publisher_reconciliation_candidates` ADD CONSTRAINT `publisher_reconciliation_candidates_bound_by_users_id_fk` FOREIGN KEY (`bound_by`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `publisher_reconciliation_candidates` ADD CONSTRAINT `publisher_reconciliation_candidates_rejected_by_users_id_fk` FOREIGN KEY (`rejected_by`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `publisher_runtime_state` ADD CONSTRAINT `publisher_runtime_state_changed_by_users_id_fk` FOREIGN KEY (`changed_by`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `publisher_submission_attempts` ADD CONSTRAINT `publisher_submission_attempts_owner_id_users_id_fk` FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `publisher_submission_attempts` ADD CONSTRAINT `pub_attempts_item_owner_fk` FOREIGN KEY (`item_id`,`owner_id`) REFERENCES `publisher_items`(`id`,`owner_id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `publisher_webhook_items` ADD CONSTRAINT `publisher_webhook_items_event_id_publisher_webhook_events_id_fk` FOREIGN KEY (`event_id`) REFERENCES `publisher_webhook_events`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `publisher_webhook_items` ADD CONSTRAINT `publisher_webhook_items_item_id_publisher_items_id_fk` FOREIGN KEY (`item_id`) REFERENCES `publisher_items`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `media_pub_bank_reviews_status_idx` ON `media_publishing_bank_transfer_reviews` (`status`,`submitted_at`);--> statement-breakpoint
CREATE INDEX `media_pub_price_owner_idx` ON `media_publishing_item_price_snapshots` (`owner_id`);--> statement-breakpoint
CREATE INDEX `media_pub_settlements_reservation_idx` ON `media_publishing_item_settlements` (`reservation_id`);--> statement-breakpoint
CREATE INDEX `media_pub_settlements_owner_status_idx` ON `media_publishing_item_settlements` (`owner_id`,`status`);--> statement-breakpoint
CREATE INDEX `media_pub_ledger_owner_created_idx` ON `media_publishing_ledger` (`owner_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `media_pub_ledger_reference_idx` ON `media_publishing_ledger` (`reference_type`,`reference_id`);--> statement-breakpoint
CREATE INDEX `media_pub_reservations_owner_status_idx` ON `media_publishing_reservations` (`owner_id`,`status`);--> statement-breakpoint
CREATE INDEX `media_pub_topup_owner_created_idx` ON `media_publishing_topup_orders` (`owner_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `media_pub_topup_state_expiry_idx` ON `media_publishing_topup_orders` (`state`,`checkout_expires_at`);--> statement-breakpoint
CREATE INDEX `payment_receipt_claims_order_idx` ON `payment_receipt_claims` (`provider_order_id`);--> statement-breakpoint
CREATE INDEX `pub_assets_storage_key_idx` ON `publisher_article_assets` (`storage_key_hash`);--> statement-breakpoint
CREATE INDEX `pub_version_assets_owner_idx` ON `publisher_article_version_assets` (`owner_id`);--> statement-breakpoint
CREATE INDEX `pub_versions_hash_idx` ON `publisher_article_versions` (`content_hash`);--> statement-breakpoint
CREATE INDEX `pub_articles_owner_updated_idx` ON `publisher_articles` (`owner_id`,`updated_at`);--> statement-breakpoint
CREATE INDEX `pub_articles_owner_status_idx` ON `publisher_articles` (`owner_id`,`status`);--> statement-breakpoint
CREATE INDEX `pub_batches_owner_created_idx` ON `publisher_batches` (`owner_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `pub_batches_status_updated_idx` ON `publisher_batches` (`status`,`updated_at`);--> statement-breakpoint
CREATE INDEX `pub_imports_owner_status_idx` ON `publisher_docx_imports` (`owner_id`,`status`);--> statement-breakpoint
CREATE INDEX `pub_imports_expiry_idx` ON `publisher_docx_imports` (`expires_at`);--> statement-breakpoint
CREATE INDEX `pub_imports_owner_sha_idx` ON `publisher_docx_imports` (`owner_id`,`sha256`);--> statement-breakpoint
CREATE INDEX `pub_draft_items_media_idx` ON `publisher_draft_items` (`media_resource_id`);--> statement-breakpoint
CREATE INDEX `pub_drafts_owner_updated_idx` ON `publisher_drafts` (`owner_id`,`updated_at`);--> statement-breakpoint
CREATE INDEX `pub_preflights_owner_expiry_idx` ON `publisher_preflights` (`owner_id`,`expires_at`);--> statement-breakpoint
CREATE INDEX `pub_items_status_next_poll_idx` ON `publisher_items` (`status`,`next_poll_at`);--> statement-breakpoint
CREATE INDEX `pub_items_batch_status_idx` ON `publisher_items` (`batch_id`,`status`);--> statement-breakpoint
CREATE INDEX `pub_jobs_claim_idx` ON `publisher_jobs` (`status`,`available_at`,`lease_expires_at`);--> statement-breakpoint
CREATE INDEX `pub_jobs_type_aggregate_idx` ON `publisher_jobs` (`type`,`aggregate_id`);--> statement-breakpoint
CREATE INDEX `pub_media_capability_image_idx` ON `publisher_media_capabilities` (`image_support`);--> statement-breakpoint
CREATE INDEX `pub_media_active_name_idx` ON `publisher_media_resources` (`is_active`,`name`);--> statement-breakpoint
CREATE INDEX `pub_media_platform_taxonomy_idx` ON `publisher_media_resources` (`platform`,`taxonomy`);--> statement-breakpoint
CREATE INDEX `pub_media_area_idx` ON `publisher_media_resources` (`area`);--> statement-breakpoint
CREATE INDEX `pub_media_active_price_idx` ON `publisher_media_resources` (`is_active`,`price_ten_thousandths`);--> statement-breakpoint
CREATE INDEX `pub_media_sync_revision_idx` ON `publisher_media_sync_runs` (`catalog_revision`);--> statement-breakpoint
CREATE INDEX `pub_media_sync_status_started_idx` ON `publisher_media_sync_runs` (`status`,`started_at`);--> statement-breakpoint
CREATE INDEX `pub_media_staging_run_page_idx` ON `publisher_media_sync_staging` (`run_id`,`page`);--> statement-breakpoint
CREATE INDEX `pub_object_leases_expiry_idx` ON `publisher_object_leases` (`expires_at`);--> statement-breakpoint
CREATE INDEX `pub_object_leases_storage_expiry_idx` ON `publisher_object_leases` (`storage_key_hash`,`expires_at`);--> statement-breakpoint
CREATE INDEX `pub_reconcile_unresolved_idx` ON `publisher_reconciliation_candidates` (`bound_at`,`rejected_at`);--> statement-breakpoint
CREATE INDEX `pub_attempts_started_idx` ON `publisher_submission_attempts` (`started_at`);--> statement-breakpoint
CREATE INDEX `pub_submission_gate_lease_idx` ON `publisher_submission_gate` (`lease_expires_at`);--> statement-breakpoint
CREATE INDEX `pub_webhooks_status_received_idx` ON `publisher_webhook_events` (`status`,`received_at`);--> statement-breakpoint
CREATE INDEX `pub_webhook_items_event_idx` ON `publisher_webhook_items` (`event_id`);--> statement-breakpoint
CREATE INDEX `pub_webhook_items_order_idx` ON `publisher_webhook_items` (`external_order_id`);
--> statement-breakpoint
INSERT IGNORE INTO `media_publishing_wallets` (`user_id`, `currency`, `balance_ten_thousandths`, `reserved_ten_thousandths`, `frozen_ten_thousandths`, `spent_ten_thousandths`)
SELECT `id`, 'CNY', 0, 0, 0, 0 FROM `users`;
--> statement-breakpoint
INSERT IGNORE INTO `publisher_runtime_state` (`id`, `mode`, `feature_enabled`, `publish_enabled`, `image_publish_enabled`, `webhook_enabled`, `emergency_stop`, `credential_status`)
VALUES ('kol', 'mock', false, false, false, false, false, 'unconfigured');
--> statement-breakpoint
INSERT IGNORE INTO `payment_order_routes` (`id`, `provider_order_id`, `wallet_scope`, `monitoring_order_id`)
SELECT `id`, `provider_order_id`, 'monitoring', `id` FROM `topup_orders`;
