ALTER TABLE `agent_operations` ADD `provider` varchar(16) DEFAULT 'manus' NOT NULL;--> statement-breakpoint
ALTER TABLE `agent_tasks` ADD `provider_runtime` json;--> statement-breakpoint
ALTER TABLE `presales_api_credentials` ADD `provider` varchar(16) DEFAULT 'manus' NOT NULL;