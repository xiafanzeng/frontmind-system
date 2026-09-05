ALTER TABLE `result_discovered_sources` ADD `provider_position` int unsigned AFTER `ordinal`;--> statement-breakpoint
ALTER TABLE `result_sources` ADD `provider_position` int unsigned AFTER `ordinal`;
