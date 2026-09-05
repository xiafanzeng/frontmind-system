import { describe, expect, it } from "vitest";

import {
  assertExpandSql,
  assertNoEmptyMigrationBlocks,
} from "./check-migration-append-only.mjs";

describe("migration statement breakpoint policy", () => {
  it("rejects leading, trailing and consecutive empty statement blocks", () => {
    for (const sql of [
      "--> statement-breakpoint\nALTER TABLE `users` ADD `nickname` varchar(128);",
      "ALTER TABLE `users` ADD `nickname` varchar(128);--> statement-breakpoint\n",
      "ALTER TABLE `users` ADD `nickname` varchar(128);--> statement-breakpoint\n--> statement-breakpoint\nCREATE INDEX `users_name_idx` ON `users` (`name`);",
      "-- comment only\n--> statement-breakpoint\nALTER TABLE `users` ADD `nickname` varchar(128);",
      "/* comment only */--> statement-breakpoint\nALTER TABLE `users` ADD `nickname` varchar(128);",
    ]) {
      expect(() => assertNoEmptyMigrationBlocks("0049_empty", sql)).toThrow(
        "MIGRATION_EMPTY_STATEMENT_BLOCK",
      );
    }
  });

  it("allows one executable statement in every breakpoint block", () => {
    expect(() =>
      assertNoEmptyMigrationBlocks(
        "0049_valid",
        "ALTER TABLE `users` ADD `nickname` varchar(128);--> statement-breakpoint\nCREATE INDEX `users_name_idx` ON `users` (`name`);",
      ),
    ).not.toThrow();
  });

  it("rejects multiple executable statements inside one breakpoint block", () => {
    expect(() =>
      assertNoEmptyMigrationBlocks(
        "0049_multiple",
        "ALTER TABLE `users` ADD `nickname` varchar(128); CREATE INDEX `users_name_idx` ON `users` (`name`);",
      ),
    ).toThrow("MIGRATION_MULTIPLE_STATEMENTS_BLOCK");
  });
});

describe("append-only expand SQL policy", () => {
  it("allows additive tables, nullable columns and compatible literal defaults", () => {
    for (const sql of [
      "CREATE TABLE `fresh` (`id` bigint NOT NULL, PRIMARY KEY (`id`));",
      "CREATE TABLE `notes` (`body` varchar(128) DEFAULT 'safe;value');",
      "ALTER TABLE `users` ADD `nickname` varchar(128);",
      "ALTER TABLE `users` ADD COLUMN `enabled` boolean NOT NULL DEFAULT TRUE;",
      "ALTER TABLE `users` ADD `attempts` int NOT NULL DEFAULT 0;",
      "ALTER TABLE `users` ADD `status` varchar(32) NOT NULL DEFAULT 'active';",
      "CREATE INDEX `users_status_idx` ON `users` (`status`);",
      "ALTER TABLE `users` ADD INDEX `users_name_idx` (`name`);",
    ]) {
      expect(() => assertExpandSql("0049_safe_expand", sql)).not.toThrow();
    }
  });

  it("rejects non-null additions without a compatible literal default", () => {
    for (const sql of [
      "ALTER TABLE `users` ADD `status` varchar(32) NOT NULL;",
      "ALTER TABLE `users` ADD `createdAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP;",
      "ALTER TABLE `users` ADD `token` varchar(36) NOT NULL DEFAULT (uuid());",
      "ALTER TABLE `users` ADD `optionalToken` varchar(36) DEFAULT (uuid());",
      "ALTER TABLE `users` ADD `updatedAt` timestamp DEFAULT NULL ON UPDATE CURRENT_TIMESTAMP;",
      "ALTER TABLE `users` ADD `a` int NOT NULL DEFAULT 0, ADD `b` int NOT NULL;",
    ]) {
      expect(() => assertExpandSql("0049_unsafe_expand", sql)).toThrow(
        "EXPAND_MIGRATION_HAS_CONTRACT_SQL",
      );
    }
  });

  it("rejects destructive and constraint-tightening statements", () => {
    for (const sql of [
      "DROP TABLE `users`;",
      "ALTER TABLE `users` DROP COLUMN `legacy`;",
      "ALTER TABLE `users` ADD CONSTRAINT `uq_name` UNIQUE (`name`);",
      "ALTER TABLE `users` ADD PRIMARY KEY (`id`);",
      "ALTER TABLE `users` ADD CHECK (`attempts` >= 0);",
      "ALTER TABLE `users` ADD `parentId` int REFERENCES `parents` (`id`);",
      "ALTER TABLE `users` ADD COLUMN `email2` varchar(255) UNIQUE;",
      "ALTER TABLE `users` ADD COLUMN `id2` bigint PRIMARY KEY;",
      "ALTER TABLE `users` ADD COLUMN `score` int CHECK (`score` >= 0);",
      "ALTER TABLE `users` ADD COLUMN `sequence` bigint AUTO_INCREMENT;",
      "ALTER TABLE `users` ADD FULLTEXT INDEX `users_name_search` (`name`);",
      "ALTER TABLE `users` ADD SPATIAL INDEX `users_location_search` (`location`);",
      "CREATE UNIQUE INDEX `uq_name` ON `users` (`name`);",
      "UPDATE `users` SET `status` = 'active';",
      "INSERT INTO `users` (`username`) VALUES ('unsafe');",
      "REPLACE INTO `users` (`id`) VALUES (1);",
      "LOAD DATA INFILE '/tmp/users.csv' INTO TABLE `users`;",
    ]) {
      expect(() => assertExpandSql("0049_contract_sql", sql)).toThrow(
        "EXPAND_MIGRATION_HAS_CONTRACT_SQL",
      );
    }
  });

  it("rejects a second statement hidden behind an allowed statement", () => {
    for (const sql of [
      "CREATE TABLE `fresh` (`id` bigint); ALTER TABLE `users` MODIFY `name` text;",
      "ALTER TABLE `users` ADD `nickname` varchar(128); CALL unsafe_backfill();",
    ]) {
      expect(() => assertExpandSql("0049_multi_statement", sql)).toThrow(
        "EXPAND_MIGRATION_HAS_CONTRACT_SQL",
      );
    }
  });
});
