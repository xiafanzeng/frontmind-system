CREATE TABLE `api_key_ownership` (
	`fingerprint` varchar(32) NOT NULL,
	`userId` int NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `api_key_ownership_fingerprint` PRIMARY KEY(`fingerprint`)
);
--> statement-breakpoint
INSERT INTO `api_key_ownership` (`fingerprint`, `userId`, `createdAt`)
SELECT `fingerprint`, `userId`, MIN(`createdAt`)
FROM `api_credentials`
GROUP BY `fingerprint`, `userId`;--> statement-breakpoint
ALTER TABLE `api_key_ownership` ADD CONSTRAINT `api_key_ownership_userId_users_id_fk` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `api_key_ownership_user_idx` ON `api_key_ownership` (`userId`);
