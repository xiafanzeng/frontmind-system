CREATE TABLE `user_usage_owners` (
	`userId` int NOT NULL,
	`deliveryAdminId` int NOT NULL,
	`revision` int unsigned NOT NULL DEFAULT 1,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `user_usage_owners_userId` PRIMARY KEY(`userId`)
);
--> statement-breakpoint
ALTER TABLE `user_usage_owners` ADD CONSTRAINT `user_usage_owners_userId_users_id_fk` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `user_usage_owners` ADD CONSTRAINT `user_usage_owners_deliveryAdminId_users_id_fk` FOREIGN KEY (`deliveryAdminId`) REFERENCES `users`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `user_usage_owners_delivery_admin_idx` ON `user_usage_owners` (`deliveryAdminId`);--> statement-breakpoint
INSERT INTO `user_usage_owners` (
  `userId`,
  `deliveryAdminId`,
  `revision`,
  `createdAt`,
  `updatedAt`
)
SELECT
  `assignment`.`userId`,
  MIN(`assignment`.`adminId`),
  1,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM `user_admin_assignments` AS `assignment`
INNER JOIN `users` AS `customer`
  ON `customer`.`id` = `assignment`.`userId`
INNER JOIN `users` AS `admin`
  ON `admin`.`id` = `assignment`.`adminId`
WHERE
  `customer`.`role` = 'user'
  AND `admin`.`role` = 'admin'
  AND `admin`.`adminAccessLevel` = 'delivery_admin'
  AND `admin`.`isActive` = 1
GROUP BY `assignment`.`userId`
HAVING COUNT(DISTINCT `assignment`.`adminId`) = 1;--> statement-breakpoint
UPDATE `api_credentials` AS `credential`
INNER JOIN `user_usage_owners` AS `owner`
  ON `owner`.`userId` = `credential`.`userId`
SET
  `credential`.`status` = 'retired',
  `credential`.`retiredAt` = CURRENT_TIMESTAMP,
  `credential`.`updatedAt` = CURRENT_TIMESTAMP
WHERE `credential`.`status` = 'active';
