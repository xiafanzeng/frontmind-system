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
ALTER TABLE `platform_catalog` ADD `pricing_class` enum('domestic','overseas') AFTER `client_type`;--> statement-breakpoint
ALTER TABLE `attempt_money_settlements` ADD CONSTRAINT `attempt_money_settlements_attempt_id_attempts_id_fk` FOREIGN KEY (`attempt_id`) REFERENCES `attempts`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `attempt_money_settlements` ADD CONSTRAINT `attempt_money_settlements_reservation_fk` FOREIGN KEY (`reservation_id`) REFERENCES `money_reservations`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `attempt_price_snapshots` ADD CONSTRAINT `attempt_price_snapshots_attempt_id_attempts_id_fk` FOREIGN KEY (`attempt_id`) REFERENCES `attempts`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `attempt_price_snapshots` ADD CONSTRAINT `attempt_price_snapshots_pricing_version_fk` FOREIGN KEY (`pricing_version_id`) REFERENCES `pricing_versions`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `attempt_price_snapshots` ADD CONSTRAINT `attempt_price_snapshots_pricing_item_id_pricing_items_id_fk` FOREIGN KEY (`pricing_item_id`) REFERENCES `pricing_items`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `bank_transfer_reviews` ADD CONSTRAINT `bank_transfer_reviews_order_id_topup_orders_id_fk` FOREIGN KEY (`order_id`) REFERENCES `topup_orders`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `bank_transfer_reviews` ADD CONSTRAINT `bank_transfer_reviews_reviewed_by_users_id_fk` FOREIGN KEY (`reviewed_by`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `money_ledger` ADD CONSTRAINT `money_ledger_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `money_ledger` ADD CONSTRAINT `money_ledger_reservation_id_money_reservations_id_fk` FOREIGN KEY (`reservation_id`) REFERENCES `money_reservations`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `money_ledger` ADD CONSTRAINT `money_ledger_attempt_id_attempts_id_fk` FOREIGN KEY (`attempt_id`) REFERENCES `attempts`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `money_ledger` ADD CONSTRAINT `money_ledger_actor_id_users_id_fk` FOREIGN KEY (`actor_id`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `money_reservations` ADD CONSTRAINT `money_reservations_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `money_reservations` ADD CONSTRAINT `money_reservations_run_id_runs_id_fk` FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `money_wallets` ADD CONSTRAINT `money_wallets_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `pricing_items` ADD CONSTRAINT `pricing_items_pricing_version_id_pricing_versions_id_fk` FOREIGN KEY (`pricing_version_id`) REFERENCES `pricing_versions`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `pricing_versions` ADD CONSTRAINT `pricing_versions_created_by_users_id_fk` FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `topup_orders` ADD CONSTRAINT `topup_orders_replaces_order_id_topup_orders_id_fk` FOREIGN KEY (`replaces_order_id`) REFERENCES `topup_orders`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `topup_orders` ADD CONSTRAINT `topup_orders_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `topup_receipts` ADD CONSTRAINT `topup_receipts_order_id_topup_orders_id_fk` FOREIGN KEY (`order_id`) REFERENCES `topup_orders`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `attempt_money_settlements_reservation_idx` ON `attempt_money_settlements` (`reservation_id`);--> statement-breakpoint
CREATE INDEX `attempt_price_snapshots_version_idx` ON `attempt_price_snapshots` (`pricing_version_id`);--> statement-breakpoint
CREATE INDEX `bank_transfer_reviews_status_submitted_idx` ON `bank_transfer_reviews` (`status`,`submitted_at`);--> statement-breakpoint
CREATE INDEX `money_ledger_user_created_idx` ON `money_ledger` (`user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `money_ledger_reference_idx` ON `money_ledger` (`reference_type`,`reference_id`);--> statement-breakpoint
CREATE INDEX `money_reservations_user_status_idx` ON `money_reservations` (`user_id`,`status`);--> statement-breakpoint
CREATE INDEX `pricing_versions_status_effective_idx` ON `pricing_versions` (`status`,`effective_from`);--> statement-breakpoint
CREATE INDEX `topup_orders_user_created_idx` ON `topup_orders` (`user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `topup_orders_state_expiry_idx` ON `topup_orders` (`state`,`checkout_expires_at`);
--> statement-breakpoint
INSERT INTO `money_wallets` (`user_id`, `currency`, `balance_ten_thousandths`, `reserved_ten_thousandths`, `spent_ten_thousandths`)
SELECT `id`, 'CNY', 0, 0, 0 FROM `users`
ON DUPLICATE KEY UPDATE `user_id` = VALUES(`user_id`);
--> statement-breakpoint
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
UPDATE `platform_catalog`
SET `pricing_class` = 'overseas'
WHERE `pricing_class` IS NULL
  AND LOWER(`provider_code`) IN ('chatgpt', 'chatgpt_mobile');
--> statement-breakpoint
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
