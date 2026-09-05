CREATE TABLE `monitoring_account_links` (
	`dashboardUserId` int NOT NULL,
	`monitoringUserId` varchar(36) NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `monitoring_account_links_dashboardUserId_unique` UNIQUE(`dashboardUserId`),
	CONSTRAINT `monitoring_account_links_monitoringUserId_unique` UNIQUE(`monitoringUserId`)
);
--> statement-breakpoint
ALTER TABLE `monitoring_account_links` ADD CONSTRAINT `monitoring_account_links_dashboardUserId_users_id_fk` FOREIGN KEY (`dashboardUserId`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `monitoring_account_links_dashboard_idx` ON `monitoring_account_links` (`dashboardUserId`);