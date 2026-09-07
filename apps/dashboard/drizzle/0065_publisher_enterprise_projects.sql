-- Enterprise project boundary for publisher content and asynchronous work.
-- Balances, top-ups, receipts and settlement ledgers remain account-owned.
ALTER TABLE `publisher_articles` ADD COLUMN `enterprise_project_id` varchar(36) NULL, ADD KEY `pub_articles_enterprise_idx` (`owner_id`,`enterprise_project_id`);
--> statement-breakpoint
UPDATE `publisher_articles` t JOIN monitoring_account_links a ON a.monitoringUserId=t.owner_id JOIN enterprise_projects p ON p.ownerUserId=a.dashboardUserId AND p.isLegacyDefault=true SET t.enterprise_project_id=p.id WHERE t.enterprise_project_id IS NULL;
--> statement-breakpoint
ALTER TABLE `publisher_docx_imports` ADD COLUMN `enterprise_project_id` varchar(36) NULL, ADD KEY `pub_docx_imports_enterprise_idx` (`owner_id`,`enterprise_project_id`);
--> statement-breakpoint
UPDATE `publisher_docx_imports` t JOIN monitoring_account_links a ON a.monitoringUserId=t.owner_id JOIN enterprise_projects p ON p.ownerUserId=a.dashboardUserId AND p.isLegacyDefault=true SET t.enterprise_project_id=p.id WHERE t.enterprise_project_id IS NULL;
--> statement-breakpoint
ALTER TABLE `publisher_article_versions` ADD COLUMN `enterprise_project_id` varchar(36) NULL, ADD KEY `pub_article_versions_enterprise_idx` (`owner_id`,`enterprise_project_id`);
--> statement-breakpoint
UPDATE `publisher_article_versions` t JOIN monitoring_account_links a ON a.monitoringUserId=t.owner_id JOIN enterprise_projects p ON p.ownerUserId=a.dashboardUserId AND p.isLegacyDefault=true SET t.enterprise_project_id=p.id WHERE t.enterprise_project_id IS NULL;
--> statement-breakpoint
ALTER TABLE `publisher_article_assets` ADD COLUMN `enterprise_project_id` varchar(36) NULL, ADD KEY `pub_article_assets_enterprise_idx` (`owner_id`,`enterprise_project_id`);
--> statement-breakpoint
UPDATE `publisher_article_assets` t JOIN monitoring_account_links a ON a.monitoringUserId=t.owner_id JOIN enterprise_projects p ON p.ownerUserId=a.dashboardUserId AND p.isLegacyDefault=true SET t.enterprise_project_id=p.id WHERE t.enterprise_project_id IS NULL;
--> statement-breakpoint
ALTER TABLE `publisher_article_version_assets` ADD COLUMN `enterprise_project_id` varchar(36) NULL, ADD KEY `pub_article_version_assets_enterprise_idx` (`owner_id`,`enterprise_project_id`);
--> statement-breakpoint
UPDATE `publisher_article_version_assets` t JOIN monitoring_account_links a ON a.monitoringUserId=t.owner_id JOIN enterprise_projects p ON p.ownerUserId=a.dashboardUserId AND p.isLegacyDefault=true SET t.enterprise_project_id=p.id WHERE t.enterprise_project_id IS NULL;
--> statement-breakpoint
ALTER TABLE `publisher_object_leases` ADD COLUMN `enterprise_project_id` varchar(36) NULL, ADD KEY `pub_object_leases_enterprise_idx` (`owner_id`,`enterprise_project_id`);
--> statement-breakpoint
UPDATE `publisher_object_leases` t JOIN monitoring_account_links a ON a.monitoringUserId=t.owner_id JOIN enterprise_projects p ON p.ownerUserId=a.dashboardUserId AND p.isLegacyDefault=true SET t.enterprise_project_id=p.id WHERE t.enterprise_project_id IS NULL;
--> statement-breakpoint
ALTER TABLE `publisher_drafts` ADD COLUMN `enterprise_project_id` varchar(36) NULL, ADD KEY `pub_drafts_enterprise_idx` (`owner_id`,`enterprise_project_id`);
--> statement-breakpoint
UPDATE `publisher_drafts` t JOIN monitoring_account_links a ON a.monitoringUserId=t.owner_id JOIN enterprise_projects p ON p.ownerUserId=a.dashboardUserId AND p.isLegacyDefault=true SET t.enterprise_project_id=p.id WHERE t.enterprise_project_id IS NULL;
--> statement-breakpoint
ALTER TABLE `publisher_preflights` ADD COLUMN `enterprise_project_id` varchar(36) NULL, ADD KEY `pub_preflights_enterprise_idx` (`owner_id`,`enterprise_project_id`);
--> statement-breakpoint
UPDATE `publisher_preflights` t JOIN monitoring_account_links a ON a.monitoringUserId=t.owner_id JOIN enterprise_projects p ON p.ownerUserId=a.dashboardUserId AND p.isLegacyDefault=true SET t.enterprise_project_id=p.id WHERE t.enterprise_project_id IS NULL;
--> statement-breakpoint
ALTER TABLE `publisher_draft_items` ADD COLUMN `enterprise_project_id` varchar(36) NULL, ADD KEY `pub_draft_items_enterprise_idx` (`owner_id`,`enterprise_project_id`);
--> statement-breakpoint
UPDATE `publisher_draft_items` t JOIN monitoring_account_links a ON a.monitoringUserId=t.owner_id JOIN enterprise_projects p ON p.ownerUserId=a.dashboardUserId AND p.isLegacyDefault=true SET t.enterprise_project_id=p.id WHERE t.enterprise_project_id IS NULL;
--> statement-breakpoint
ALTER TABLE `publisher_batches` ADD COLUMN `enterprise_project_id` varchar(36) NULL, ADD KEY `pub_batches_enterprise_idx` (`owner_id`,`enterprise_project_id`);
--> statement-breakpoint
UPDATE `publisher_batches` t JOIN monitoring_account_links a ON a.monitoringUserId=t.owner_id JOIN enterprise_projects p ON p.ownerUserId=a.dashboardUserId AND p.isLegacyDefault=true SET t.enterprise_project_id=p.id WHERE t.enterprise_project_id IS NULL;
--> statement-breakpoint
ALTER TABLE `publisher_items` ADD COLUMN `enterprise_project_id` varchar(36) NULL, ADD KEY `pub_items_enterprise_idx` (`owner_id`,`enterprise_project_id`);
--> statement-breakpoint
UPDATE `publisher_items` t JOIN monitoring_account_links a ON a.monitoringUserId=t.owner_id JOIN enterprise_projects p ON p.ownerUserId=a.dashboardUserId AND p.isLegacyDefault=true SET t.enterprise_project_id=p.id WHERE t.enterprise_project_id IS NULL;
--> statement-breakpoint
ALTER TABLE `publisher_jobs` ADD COLUMN `enterprise_project_id` varchar(36) NULL;
--> statement-breakpoint
UPDATE publisher_jobs j JOIN publisher_docx_imports i ON i.id=j.aggregate_id SET j.enterprise_project_id=i.enterprise_project_id WHERE j.type='import_docx' AND j.enterprise_project_id IS NULL;
--> statement-breakpoint
UPDATE publisher_jobs j JOIN publisher_items i ON i.id=j.aggregate_id SET j.enterprise_project_id=i.enterprise_project_id WHERE j.type IN ('submit_publication_item','poll_publication_item','reconcile_publication_unknown') AND j.enterprise_project_id IS NULL;
