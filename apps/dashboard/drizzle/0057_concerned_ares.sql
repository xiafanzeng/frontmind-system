ALTER TABLE `monitoring_account_links` ADD PRIMARY KEY(`dashboardUserId`);--> statement-breakpoint
DROP INDEX `monitoring_account_links_dashboard_idx` ON `monitoring_account_links`;--> statement-breakpoint
ALTER TABLE `monitoring_account_links` ADD CONSTRAINT `monitoring_account_links_monitoring_user_uq` UNIQUE(`monitoringUserId`);
