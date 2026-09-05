CREATE TABLE `website_payment_receipts` (
	`orderId` varchar(128) NOT NULL,
	`schemaVersion` int unsigned NOT NULL DEFAULT 1,
	`tradeNo` varchar(128) NOT NULL,
	`amountFen` int unsigned NOT NULL,
	`paidAt` timestamp(3) NOT NULL,
	`purchaseType` enum('monitoring','service') NOT NULL,
	`scopeHash` varchar(64) NOT NULL,
	`authorizationDigest` varchar(64) NOT NULL,
	`reviewRequired` boolean NOT NULL,
	`createdAt` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `website_payment_receipts_orderId` PRIMARY KEY(`orderId`),
	CONSTRAINT `website_payment_receipts_tradeNo_unique` UNIQUE(`tradeNo`),
	CONSTRAINT `website_payment_receipts_schema_version_ck` CHECK(`website_payment_receipts`.`schemaVersion` = 1),
	CONSTRAINT `website_payment_receipts_amount_ck` CHECK(`website_payment_receipts`.`amountFen` > 0 AND `website_payment_receipts`.`amountFen` <= 10000000),
	CONSTRAINT `website_payment_receipts_scope_hash_ck` CHECK(`website_payment_receipts`.`scopeHash` REGEXP '^[a-f0-9]{64}$'),
	CONSTRAINT `website_payment_receipts_authorization_digest_ck` CHECK(`website_payment_receipts`.`authorizationDigest` REGEXP '^[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE INDEX `website_payment_receipts_scope_idx` ON `website_payment_receipts` (`scopeHash`,`authorizationDigest`);
--> statement-breakpoint
CREATE TRIGGER `website_payment_receipts_no_update`
BEFORE UPDATE ON `website_payment_receipts`
FOR EACH ROW
SIGNAL SQLSTATE '45000'
SET MESSAGE_TEXT = 'website_payment_receipts is append-only';
--> statement-breakpoint
CREATE TRIGGER `website_payment_receipts_no_delete`
BEFORE DELETE ON `website_payment_receipts`
FOR EACH ROW
SIGNAL SQLSTATE '45000'
SET MESSAGE_TEXT = 'website_payment_receipts is append-only';
