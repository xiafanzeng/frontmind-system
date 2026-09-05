CREATE TABLE `result_discovered_sources` (
	`id` varchar(36) NOT NULL,
	`revision_id` varchar(36) NOT NULL,
	`ordinal` int unsigned NOT NULL,
	`url` text NOT NULL,
	`canonical_url_hash` varchar(64) NOT NULL,
	`title` text NOT NULL,
	`domain` varchar(255) NOT NULL,
	`site_name` varchar(255),
	`summary` text,
	`published_at` varchar(10),
	`provider_icon_url` text,
	`is_cited` boolean NOT NULL DEFAULT false,
	`created_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `result_discovered_sources_id` PRIMARY KEY(`id`),
	CONSTRAINT `result_discovered_sources_revision_ordinal_uq` UNIQUE(`revision_id`,`ordinal`),
	CONSTRAINT `result_discovered_sources_revision_url_uq` UNIQUE(`revision_id`,`canonical_url_hash`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
--> statement-breakpoint
ALTER TABLE `result_discovered_sources` ADD CONSTRAINT `result_discovered_sources_revision_id_result_revisions_id_fk` FOREIGN KEY (`revision_id`) REFERENCES `result_revisions`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `result_discovered_sources_revision_cited_idx` ON `result_discovered_sources` (`revision_id`,`is_cited`);--> statement-breakpoint
CREATE INDEX `result_discovered_sources_domain_idx` ON `result_discovered_sources` (`domain`);
