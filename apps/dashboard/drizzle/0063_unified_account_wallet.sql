-- Financial compatibility baseline: retain legacy wallet and business-ledger tables.
CREATE TABLE `unified_finance_state` (
  `id` int NOT NULL PRIMARY KEY,
  `mode` varchar(24) NOT NULL,
  `minimum_runtime_version` int NOT NULL DEFAULT 2,
  `activated_at` datetime(3) NULL
);--> statement-breakpoint
INSERT INTO `unified_finance_state` (`id`, `mode`) VALUES (1, 'prepared');--> statement-breakpoint
CREATE TABLE `unified_money_wallets` (
  `user_id` varchar(36) NOT NULL PRIMARY KEY,
  `currency` varchar(3) NOT NULL DEFAULT 'CNY',
  `balance_ten_thousandths` bigint NOT NULL DEFAULT 0,
  `reserved_ten_thousandths` bigint unsigned NOT NULL DEFAULT 0,
  `frozen_ten_thousandths` bigint unsigned NOT NULL DEFAULT 0,
  `spent_ten_thousandths` bigint unsigned NOT NULL DEFAULT 0,
  `ai_cost_remainder_nanos` bigint unsigned NOT NULL DEFAULT 0,
  `updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  CONSTRAINT `unified_wallet_owner_fk` FOREIGN KEY (`user_id`) REFERENCES `monitoring_users` (`id`) ON DELETE CASCADE,
  CONSTRAINT `unified_wallet_remainder_ck` CHECK (`ai_cost_remainder_nanos` < 100000)
);--> statement-breakpoint
CREATE TABLE `unified_wallet_openings` (
  `user_id` varchar(36) NOT NULL PRIMARY KEY,
  `monitoring_balance` bigint NOT NULL,
  `monitoring_reserved` bigint unsigned NOT NULL,
  `monitoring_spent` bigint unsigned NOT NULL,
  `media_balance` bigint NOT NULL,
  `media_reserved` bigint unsigned NOT NULL,
  `media_frozen` bigint unsigned NOT NULL,
  `media_spent` bigint unsigned NOT NULL,
  `created_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
);--> statement-breakpoint
-- Run while Dashboard and both financial workers are stopped. Old provider callbacks retry.
START TRANSACTION;--> statement-breakpoint
INSERT INTO `unified_wallet_openings`
(`user_id`, `monitoring_balance`, `monitoring_reserved`, `monitoring_spent`, `media_balance`, `media_reserved`, `media_frozen`, `media_spent`)
SELECT u.id, COALESCE(m.balance_ten_thousandths,0), COALESCE(m.reserved_ten_thousandths,0), COALESCE(m.spent_ten_thousandths,0),
COALESCE(p.balance_ten_thousandths,0), COALESCE(p.reserved_ten_thousandths,0), COALESCE(p.frozen_ten_thousandths,0), COALESCE(p.spent_ten_thousandths,0)
FROM monitoring_users u LEFT JOIN money_wallets m ON m.user_id=u.id LEFT JOIN media_publishing_wallets p ON p.user_id=u.id
WHERE NOT EXISTS (SELECT 1 FROM unified_wallet_openings o WHERE o.user_id=u.id);--> statement-breakpoint
INSERT INTO `unified_money_wallets` (`user_id`, `balance_ten_thousandths`, `reserved_ten_thousandths`, `frozen_ten_thousandths`, `spent_ten_thousandths`)
SELECT user_id, monitoring_balance+media_balance, monitoring_reserved+media_reserved, media_frozen, monitoring_spent+media_spent
FROM unified_wallet_openings o WHERE NOT EXISTS (SELECT 1 FROM unified_money_wallets w WHERE w.user_id=o.user_id);--> statement-breakpoint
-- A trade number already claimed by a DIFFERENT order fails the unique constraint.
-- Historical paid/review receipts must never become a second credit after cutover.
INSERT INTO payment_receipt_claims (id,provider,provider_trade_no,provider_order_id,wallet_scope,payload_digest,status,claimed_at,completed_at)
SELECT r.id,r.provider,r.provider_trade_no,o.provider_order_id,'monitoring',r.payload_digest,
IF(o.state='credited','credited','review_required'),r.received_at,IF(o.state='credited',o.credited_at,NULL)
FROM topup_receipts r JOIN topup_orders o ON o.id=r.order_id
WHERE NOT EXISTS (SELECT 1 FROM payment_receipt_claims c WHERE c.provider=r.provider AND c.provider_trade_no=r.provider_trade_no AND c.provider_order_id=o.provider_order_id);--> statement-breakpoint
UPDATE unified_finance_state SET mode='active', activated_at=UTC_TIMESTAMP(3) WHERE id=1 AND mode='prepared';--> statement-breakpoint
COMMIT;
