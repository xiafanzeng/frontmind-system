CREATE TABLE `website_project_orders` (
	`orderId` varchar(128) NOT NULL,
	`schemaVersion` int unsigned NOT NULL DEFAULT 1,
	`projectId` varchar(80) NOT NULL,
	`purchaseType` enum('monitoring','service') NOT NULL,
	`amountFen` int unsigned NOT NULL,
	`authorizationDigest` varchar(64) NOT NULL,
	`state` enum('pending','paid','fulfilling','fulfilled','review_required','terminal_failed','closed') NOT NULL,
	`checkoutExpiresAt` timestamp(3) NOT NULL,
	`paidAt` timestamp(3),
	`fulfilledAt` timestamp(3),
	`lastEventAt` timestamp(3) NOT NULL,
	`revision` int unsigned NOT NULL DEFAULT 1,
	`createdAt` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updatedAt` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
	CONSTRAINT `website_project_orders_orderId` PRIMARY KEY(`orderId`),
	CONSTRAINT `website_project_orders_authorizationDigest_unique` UNIQUE(`authorizationDigest`),
	CONSTRAINT `website_project_orders_schema_version_ck` CHECK(`website_project_orders`.`schemaVersion` = 1),
	CONSTRAINT `website_project_orders_amount_ck` CHECK(`website_project_orders`.`amountFen` > 0 AND `website_project_orders`.`amountFen` <= 10000000),
	CONSTRAINT `website_project_orders_authorization_digest_ck` CHECK(`website_project_orders`.`authorizationDigest` REGEXP '^[a-f0-9]{64}$'),
	CONSTRAINT `website_project_orders_revision_ck` CHECK(`website_project_orders`.`revision` > 0),
	CONSTRAINT `website_project_orders_paid_state_ck` CHECK(`website_project_orders`.`state` IN ('pending', 'closed') OR `website_project_orders`.`paidAt` IS NOT NULL),
	CONSTRAINT `website_project_orders_fulfilled_state_ck` CHECK((`website_project_orders`.`state` = 'fulfilled' AND `website_project_orders`.`fulfilledAt` IS NOT NULL) OR (`website_project_orders`.`state` <> 'fulfilled' AND `website_project_orders`.`fulfilledAt` IS NULL)),
	CONSTRAINT `website_project_orders_fulfilled_time_ck` CHECK(`website_project_orders`.`fulfilledAt` IS NULL OR (`website_project_orders`.`paidAt` IS NOT NULL AND `website_project_orders`.`fulfilledAt` >= `website_project_orders`.`paidAt`))
);
--> statement-breakpoint
CREATE INDEX `website_project_orders_project_state_idx` ON `website_project_orders` (`projectId`,`state`);
