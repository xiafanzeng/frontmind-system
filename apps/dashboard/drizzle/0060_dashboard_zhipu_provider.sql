ALTER TABLE `api_credentials` ADD `provider` varchar(16) DEFAULT 'manus' NOT NULL;--> statement-breakpoint
ALTER TABLE `api_credentials` ADD `upstream_model` varchar(64);--> statement-breakpoint
ALTER TABLE `api_credentials` ADD `upstream_effort` varchar(16);