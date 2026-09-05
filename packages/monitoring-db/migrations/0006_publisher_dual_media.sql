ALTER TABLE `publisher_batches` ADD `title_mode` enum('single','per_media') DEFAULT 'per_media' NOT NULL AFTER `live_confirmation_accepted`;--> statement-breakpoint
ALTER TABLE `publisher_draft_items` ADD `media_kind_snapshot` enum('news','self_media','unknown') DEFAULT 'unknown' NOT NULL AFTER `selected_catalog_revision`;--> statement-breakpoint
ALTER TABLE `publisher_drafts` ADD `title_mode` enum('single','per_media') DEFAULT 'per_media' NOT NULL AFTER `revision`;--> statement-breakpoint
ALTER TABLE `publisher_drafts` ADD `shared_title` varchar(200) AFTER `title_mode`;--> statement-breakpoint
ALTER TABLE `publisher_items` ADD `media_kind_snapshot` enum('news','self_media','unknown') DEFAULT 'unknown' NOT NULL AFTER `media_name_snapshot`;--> statement-breakpoint
ALTER TABLE `publisher_media_resources` ADD `media_kind` enum('news','self_media') AFTER `name`;--> statement-breakpoint
ALTER TABLE `publisher_media_resources` ADD `include_rate_basis_points` int unsigned AFTER `success_rate_basis_points`;--> statement-breakpoint
ALTER TABLE `publisher_media_resources` ADD `pc_weight` int unsigned AFTER `include_rate_basis_points`;--> statement-breakpoint
ALTER TABLE `publisher_media_resources` ADD `mobile_weight` int unsigned AFTER `pc_weight`;--> statement-breakpoint
ALTER TABLE `publisher_media_resources` ADD `include_type` varchar(120) AFTER `mobile_weight`;--> statement-breakpoint
ALTER TABLE `publisher_media_resources` ADD `publish_speed` varchar(120) AFTER `include_type`;--> statement-breakpoint
ALTER TABLE `publisher_media_resources` ADD `entry_url` text AFTER `publish_speed`;--> statement-breakpoint
ALTER TABLE `publisher_media_resources` ADD `entry_level` varchar(120) AFTER `entry_url`;--> statement-breakpoint
ALTER TABLE `publisher_media_resources` ADD `link_type` varchar(120) AFTER `entry_level`;--> statement-breakpoint
ALTER TABLE `publisher_media_resources` ADD `logo_url` text AFTER `link_type`;--> statement-breakpoint
ALTER TABLE `publisher_media_resources` ADD `remark` text AFTER `logo_url`;--> statement-breakpoint
ALTER TABLE `publisher_media_resources` ADD `description` text AFTER `remark`;--> statement-breakpoint
ALTER TABLE `publisher_media_resources` ADD `recommended` boolean AFTER `description`;--> statement-breakpoint
ALTER TABLE `publisher_media_resources` ADD `authenticated` boolean AFTER `recommended`;--> statement-breakpoint
ALTER TABLE `publisher_media_resources` ADD `festival_publishable` boolean AFTER `authenticated`;--> statement-breakpoint
ALTER TABLE `publisher_media_resources` ADD `fan_count` bigint unsigned AFTER `festival_publishable`;--> statement-breakpoint
ALTER TABLE `publisher_media_resources` ADD `like_count` bigint unsigned AFTER `fan_count`;--> statement-breakpoint
ALTER TABLE `publisher_media_resources` ADD `publish_count` bigint unsigned AFTER `like_count`;--> statement-breakpoint
ALTER TABLE `publisher_media_sync_staging` ADD `media_kind` enum('news','self_media') AFTER `name`;--> statement-breakpoint
ALTER TABLE `publisher_media_sync_staging` ADD `include_rate_basis_points` int unsigned AFTER `success_rate_basis_points`;--> statement-breakpoint
ALTER TABLE `publisher_media_sync_staging` ADD `pc_weight` int unsigned AFTER `include_rate_basis_points`;--> statement-breakpoint
ALTER TABLE `publisher_media_sync_staging` ADD `mobile_weight` int unsigned AFTER `pc_weight`;--> statement-breakpoint
ALTER TABLE `publisher_media_sync_staging` ADD `include_type` varchar(120) AFTER `mobile_weight`;--> statement-breakpoint
ALTER TABLE `publisher_media_sync_staging` ADD `publish_speed` varchar(120) AFTER `include_type`;--> statement-breakpoint
ALTER TABLE `publisher_media_sync_staging` ADD `entry_url` text AFTER `publish_speed`;--> statement-breakpoint
ALTER TABLE `publisher_media_sync_staging` ADD `entry_level` varchar(120) AFTER `entry_url`;--> statement-breakpoint
ALTER TABLE `publisher_media_sync_staging` ADD `link_type` varchar(120) AFTER `entry_level`;--> statement-breakpoint
ALTER TABLE `publisher_media_sync_staging` ADD `logo_url` text AFTER `link_type`;--> statement-breakpoint
ALTER TABLE `publisher_media_sync_staging` ADD `remark` text AFTER `logo_url`;--> statement-breakpoint
ALTER TABLE `publisher_media_sync_staging` ADD `description` text AFTER `remark`;--> statement-breakpoint
ALTER TABLE `publisher_media_sync_staging` ADD `recommended` boolean AFTER `description`;--> statement-breakpoint
ALTER TABLE `publisher_media_sync_staging` ADD `authenticated` boolean AFTER `recommended`;--> statement-breakpoint
ALTER TABLE `publisher_media_sync_staging` ADD `festival_publishable` boolean AFTER `authenticated`;--> statement-breakpoint
ALTER TABLE `publisher_media_sync_staging` ADD `fan_count` bigint unsigned AFTER `festival_publishable`;--> statement-breakpoint
ALTER TABLE `publisher_media_sync_staging` ADD `like_count` bigint unsigned AFTER `fan_count`;--> statement-breakpoint
ALTER TABLE `publisher_media_sync_staging` ADD `publish_count` bigint unsigned AFTER `like_count`;--> statement-breakpoint
ALTER TABLE `publisher_runtime_state` ADD `catalog_kind_complete` boolean DEFAULT false NOT NULL AFTER `catalog_synced_at`;--> statement-breakpoint
UPDATE `publisher_media_resources`
SET `media_kind` = CASE
  WHEN JSON_UNQUOTE(JSON_EXTRACT(`raw_payload`, '$.mediaKind')) = 'news' THEN 'news'
  WHEN JSON_UNQUOTE(JSON_EXTRACT(`raw_payload`, '$.mediaKind')) = 'self_media' THEN 'self_media'
  WHEN JSON_UNQUOTE(JSON_EXTRACT(`raw_payload`, '$.isSelfMedia')) IN ('true', '1') THEN 'self_media'
  WHEN JSON_UNQUOTE(JSON_EXTRACT(`raw_payload`, '$.isSelfMedia')) IN ('false', '0') THEN 'news'
  ELSE NULL
END;--> statement-breakpoint
UPDATE `publisher_media_sync_staging`
SET `media_kind` = CASE
  WHEN JSON_UNQUOTE(JSON_EXTRACT(`raw_payload`, '$.mediaKind')) = 'news' THEN 'news'
  WHEN JSON_UNQUOTE(JSON_EXTRACT(`raw_payload`, '$.mediaKind')) = 'self_media' THEN 'self_media'
  WHEN JSON_UNQUOTE(JSON_EXTRACT(`raw_payload`, '$.isSelfMedia')) IN ('true', '1') THEN 'self_media'
  WHEN JSON_UNQUOTE(JSON_EXTRACT(`raw_payload`, '$.isSelfMedia')) IN ('false', '0') THEN 'news'
  ELSE NULL
END;--> statement-breakpoint
CREATE INDEX `pub_media_active_kind_price_id_idx` ON `publisher_media_resources` (`is_active`,`media_kind`,`price_ten_thousandths`,`id`);--> statement-breakpoint
CREATE INDEX `pub_media_active_kind_platform_tax_idx` ON `publisher_media_resources` (`is_active`,`media_kind`,`platform`,`taxonomy`,`id`);--> statement-breakpoint
CREATE INDEX `pub_media_active_kind_area_id_idx` ON `publisher_media_resources` (`is_active`,`media_kind`,`area`,`id`);
