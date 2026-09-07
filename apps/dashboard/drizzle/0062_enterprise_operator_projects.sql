-- Operator project migration. Historical tables remain intact.
CREATE TABLE `enterprise_projects` (`id` varchar(36) PRIMARY KEY, `ownerUserId` int NOT NULL, `name` varchar(120) NOT NULL, `isLegacyDefault` boolean NOT NULL DEFAULT false, `clientRequestId` varchar(128), `revision` int unsigned NOT NULL DEFAULT 1, `archivedAt` timestamp NULL, `createdAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP, `updatedAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP, UNIQUE KEY `enterprise_projects_owner_request_uq` (`ownerUserId`,`clientRequestId`), KEY `enterprise_projects_owner_active_idx` (`ownerUserId`,`archivedAt`), CONSTRAINT `enterprise_projects_owner_fk` FOREIGN KEY (`ownerUserId`) REFERENCES `users` (`id`) ON DELETE RESTRICT);
--> statement-breakpoint
INSERT INTO `enterprise_projects` (`id`,`ownerUserId`,`name`,`isLegacyDefault`,`clientRequestId`) SELECT CONCAT(SUBSTRING(h,1,8),'-',SUBSTRING(h,9,4),'-8',SUBSTRING(h,14,3),'-a',SUBSTRING(h,18,3),'-',SUBSTRING(h,21,12)), id, LEFT(COALESCE(NULLIF(displayName,''),username,'默认企业项目'),120), true, 'legacy-default' FROM (SELECT id, displayName, username, SHA2(CONCAT('enterprise-project:v1:',id,':legacy-default'),256) h FROM users) existing_accounts;
--> statement-breakpoint
CREATE TABLE `enterprise_project_dashboard_contents` LIKE `user_dashboard_contents`;
--> statement-breakpoint
ALTER TABLE `enterprise_project_dashboard_contents` DROP PRIMARY KEY, ADD COLUMN `enterpriseProjectId` varchar(36) NOT NULL PRIMARY KEY, MODIFY `revision` int unsigned NOT NULL DEFAULT 0;
--> statement-breakpoint
INSERT INTO `enterprise_project_dashboard_contents` (`enterpriseProjectId`,`userId`,`payload`,`sourceName`,`enterpriseIdentityBoundAt`,`revision`,`updatedByUserId`,`createdAt`,`updatedAt`) SELECT p.id,s.`userId`,s.`payload`,s.`sourceName`,s.`enterpriseIdentityBoundAt`,s.`revision`,s.`updatedByUserId`,s.`createdAt`,s.`updatedAt` FROM `user_dashboard_contents` s JOIN enterprise_projects p ON p.ownerUserId=s.userId AND p.isLegacyDefault=true;
--> statement-breakpoint
CREATE TABLE `enterprise_project_questions` LIKE `workspace_questions`;
--> statement-breakpoint
ALTER TABLE `enterprise_project_questions` ADD COLUMN `enterpriseProjectId` varchar(36) NOT NULL, ADD COLUMN `clientRequestId` varchar(128) NULL, ADD COLUMN `requestHash` varchar(64) NULL, MODIFY `contractId` varchar(36) NULL, MODIFY `quotaPeriodId` varchar(36) NULL, ADD UNIQUE KEY `enterprise_questions_request_uq` (`enterpriseProjectId`,`clientRequestId`), ADD KEY `enterprise_questions_project_status_idx` (`enterpriseProjectId`,`status`);
--> statement-breakpoint
INSERT INTO `enterprise_project_questions` (`enterpriseProjectId`,`id`,`userId`,`contractId`,`quotaPeriodId`,`externalQuestionId`,`sourceQuestionId`,`candidateKey`,`category`,`question`,`intent`,`intentRevision`,`intentConfirmedRevision`,`intentConfirmedAt`,`intentConfirmedByUserId`,`rationale`,`evidence`,`risks`,`source`,`status`,`selectionApprovalStatus`,`selectionRequestedAt`,`selectionRequestedByUserId`,`selectionApprovedAt`,`selectionApprovedByUserId`,`locked`,`sourceTaskId`,`knowledgeSnapshotId`,`ordinal`,`revision`,`selectedAt`,`archivedAt`,`createdByUserId`,`createdAt`,`updatedAt`) SELECT p.id,s.`id`,s.`userId`,s.`contractId`,s.`quotaPeriodId`,s.`externalQuestionId`,s.`sourceQuestionId`,s.`candidateKey`,s.`category`,s.`question`,s.`intent`,s.`intentRevision`,s.`intentConfirmedRevision`,s.`intentConfirmedAt`,s.`intentConfirmedByUserId`,s.`rationale`,s.`evidence`,s.`risks`,s.`source`,s.`status`,s.`selectionApprovalStatus`,s.`selectionRequestedAt`,s.`selectionRequestedByUserId`,s.`selectionApprovedAt`,s.`selectionApprovedByUserId`,s.`locked`,s.`sourceTaskId`,s.`knowledgeSnapshotId`,s.`ordinal`,s.`revision`,s.`selectedAt`,s.`archivedAt`,s.`createdByUserId`,s.`createdAt`,s.`updatedAt` FROM `workspace_questions` s JOIN enterprise_projects p ON p.ownerUserId=s.userId AND p.isLegacyDefault=true;
--> statement-breakpoint
CREATE TABLE `enterprise_project_reset_states` LIKE `knowledge_base_reset_states`;
--> statement-breakpoint
ALTER TABLE `enterprise_project_reset_states` DROP PRIMARY KEY, ADD COLUMN `enterpriseProjectId` varchar(36) NOT NULL PRIMARY KEY;
--> statement-breakpoint
INSERT INTO `enterprise_project_reset_states` (`enterpriseProjectId`,`userId`,`revision`,`updatedAt`) SELECT p.id,s.`userId`,s.`revision`,s.`updatedAt` FROM `knowledge_base_reset_states` s JOIN enterprise_projects p ON p.ownerUserId=s.userId AND p.isLegacyDefault=true;
--> statement-breakpoint
CREATE TABLE `enterprise_project_site_profiles` LIKE `workspace_site_profiles`;
--> statement-breakpoint
ALTER TABLE `enterprise_project_site_profiles` DROP PRIMARY KEY, ADD COLUMN `enterpriseProjectId` varchar(36) NOT NULL PRIMARY KEY;
--> statement-breakpoint
INSERT INTO `enterprise_project_site_profiles` (`enterpriseProjectId`,`userId`,`domain`,`normalizedAsciiDomain`,`unicodeDisplayDomain`,`domainRevision`,`providerAccountUid`,`domainOwnershipStatus`,`dnsStatus`,`icpDomainRevision`,`siteMode`,`domainStatus`,`domainVerifiedAt`,`icpProvince`,`icpNumber`,`icpStatus`,`icpVerifiedAt`,`revision`,`updatedByUserId`,`createdAt`,`updatedAt`) SELECT p.id,s.`userId`,s.`domain`,s.`normalizedAsciiDomain`,s.`unicodeDisplayDomain`,s.`domainRevision`,s.`providerAccountUid`,s.`domainOwnershipStatus`,s.`dnsStatus`,s.`icpDomainRevision`,s.`siteMode`,s.`domainStatus`,s.`domainVerifiedAt`,s.`icpProvince`,s.`icpNumber`,s.`icpStatus`,s.`icpVerifiedAt`,s.`revision`,s.`updatedByUserId`,s.`createdAt`,s.`updatedAt` FROM `workspace_site_profiles` s JOIN enterprise_projects p ON p.ownerUserId=s.userId AND p.isLegacyDefault=true;
--> statement-breakpoint
CREATE TABLE `enterprise_project_monitoring_links` (`monitoringProjectId` varchar(36) PRIMARY KEY, `enterpriseProjectId` varchar(36) NOT NULL, `ownerUserId` int NOT NULL, `sourceQuestions` json NOT NULL, `clientRequestId` varchar(128) NOT NULL, `requestHash` varchar(64) NOT NULL, `createdAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE KEY `enterprise_monitoring_request_uq` (`enterpriseProjectId`,`clientRequestId`), KEY `enterprise_monitoring_project_idx` (`enterpriseProjectId`), CONSTRAINT `enterprise_monitoring_project_fk` FOREIGN KEY (`enterpriseProjectId`) REFERENCES `enterprise_projects` (`id`) ON DELETE RESTRICT);
--> statement-breakpoint
ALTER TABLE `agent_operations` ADD COLUMN `enterpriseProjectId` varchar(36) NULL;
--> statement-breakpoint
ALTER TABLE `local_assets` ADD COLUMN `enterpriseProjectId` varchar(36) NULL;
--> statement-breakpoint
ALTER TABLE `workspace_content_revisions` ADD COLUMN `enterpriseProjectId` varchar(36) NULL;
--> statement-breakpoint
ALTER TABLE `monitoring_batches` ADD COLUMN `enterpriseProjectId` varchar(36) NULL;
--> statement-breakpoint
ALTER TABLE `monitoring_samples` ADD COLUMN `enterpriseProjectId` varchar(36) NULL;
--> statement-breakpoint
ALTER TABLE `monitoring_citation_records` ADD COLUMN `enterpriseProjectId` varchar(36) NULL;
--> statement-breakpoint
ALTER TABLE `knowledge_base_snapshots` ADD COLUMN `enterpriseProjectId` varchar(36) NULL;
--> statement-breakpoint
ALTER TABLE `knowledge_base_builds` ADD COLUMN `enterpriseProjectId` varchar(36) NULL;
--> statement-breakpoint
ALTER TABLE `knowledge_base_reset_requests` ADD COLUMN `enterpriseProjectId` varchar(36) NULL;
--> statement-breakpoint
ALTER TABLE `knowledge_base_conversation_tombstones` ADD COLUMN `enterpriseProjectId` varchar(36) NULL;
--> statement-breakpoint
ALTER TABLE `knowledge_base_conversation_retention_tombstones` ADD COLUMN `enterpriseProjectId` varchar(36) NULL;
--> statement-breakpoint
ALTER TABLE `response_logic_entries` ADD COLUMN `enterpriseProjectId` varchar(36) NULL;
--> statement-breakpoint
ALTER TABLE `conversations` ADD COLUMN `enterpriseProjectId` varchar(36) NULL;
--> statement-breakpoint
ALTER TABLE `conversation_turns` ADD COLUMN `enterpriseProjectId` varchar(36) NULL;
--> statement-breakpoint
ALTER TABLE `upstream_resources` ADD COLUMN `enterpriseProjectId` varchar(36) NULL;
--> statement-breakpoint
ALTER TABLE `site_projects` ADD COLUMN `enterpriseProjectId` varchar(36) NULL;
--> statement-breakpoint
UPDATE `workspace_content_revisions` t JOIN enterprise_projects p ON p.ownerUserId=t.`userId` AND p.isLegacyDefault=true SET t.enterpriseProjectId=p.id WHERE t.enterpriseProjectId IS NULL;
--> statement-breakpoint
UPDATE `monitoring_batches` t JOIN enterprise_projects p ON p.ownerUserId=t.`userId` AND p.isLegacyDefault=true SET t.enterpriseProjectId=p.id WHERE t.enterpriseProjectId IS NULL;
--> statement-breakpoint
UPDATE `monitoring_samples` t JOIN enterprise_projects p ON p.ownerUserId=t.`userId` AND p.isLegacyDefault=true SET t.enterpriseProjectId=p.id WHERE t.enterpriseProjectId IS NULL;
--> statement-breakpoint
UPDATE `monitoring_citation_records` t JOIN enterprise_projects p ON p.ownerUserId=t.`userId` AND p.isLegacyDefault=true SET t.enterpriseProjectId=p.id WHERE t.enterpriseProjectId IS NULL;
--> statement-breakpoint
UPDATE `knowledge_base_snapshots` t JOIN enterprise_projects p ON p.ownerUserId=t.`userId` AND p.isLegacyDefault=true SET t.enterpriseProjectId=p.id WHERE t.enterpriseProjectId IS NULL;
--> statement-breakpoint
UPDATE `knowledge_base_builds` t JOIN enterprise_projects p ON p.ownerUserId=t.`userId` AND p.isLegacyDefault=true SET t.enterpriseProjectId=p.id WHERE t.enterpriseProjectId IS NULL;
--> statement-breakpoint
UPDATE `knowledge_base_reset_requests` t JOIN enterprise_projects p ON p.ownerUserId=t.`userId` AND p.isLegacyDefault=true SET t.enterpriseProjectId=p.id WHERE t.enterpriseProjectId IS NULL;
--> statement-breakpoint
UPDATE `knowledge_base_conversation_tombstones` t JOIN enterprise_projects p ON p.ownerUserId=t.`userId` AND p.isLegacyDefault=true SET t.enterpriseProjectId=p.id WHERE t.enterpriseProjectId IS NULL;
--> statement-breakpoint
UPDATE `knowledge_base_conversation_retention_tombstones` t JOIN enterprise_projects p ON p.ownerUserId=t.`userId` AND p.isLegacyDefault=true SET t.enterpriseProjectId=p.id WHERE t.enterpriseProjectId IS NULL;
--> statement-breakpoint
UPDATE `response_logic_entries` t JOIN enterprise_projects p ON p.ownerUserId=t.`userId` AND p.isLegacyDefault=true SET t.enterpriseProjectId=p.id WHERE t.enterpriseProjectId IS NULL;
--> statement-breakpoint
UPDATE `site_projects` t JOIN enterprise_projects p ON p.ownerUserId=t.`user_id` AND p.isLegacyDefault=true SET t.enterpriseProjectId=p.id WHERE t.enterpriseProjectId IS NULL;
--> statement-breakpoint
UPDATE agent_operations o JOIN enterprise_projects p ON p.ownerUserId=o.account_user_id AND p.isLegacyDefault=true SET o.enterpriseProjectId=p.id WHERE o.scope='managed_user' AND o.contract_name <> 'dashboard.general-chat';
--> statement-breakpoint
UPDATE agent_operations o JOIN agent_tasks t ON t.operation_id=o.id JOIN enterprise_projects p ON p.ownerUserId=o.account_user_id AND p.isLegacyDefault=true SET o.enterpriseProjectId=p.id WHERE JSON_UNQUOTE(JSON_EXTRACT(t.provider_runtime,'$.generalPurpose.purpose')) IN ('enterprise_qa','content_production');
--> statement-breakpoint
UPDATE conversation_turns t JOIN knowledge_base_builds b ON b.id=t.buildId SET t.enterpriseProjectId=b.enterpriseProjectId WHERE t.buildId IS NOT NULL;
--> statement-breakpoint
UPDATE conversation_turns t JOIN agent_tasks a ON a.id=t.upstreamTaskId JOIN agent_operations o ON o.id=a.operation_id SET t.enterpriseProjectId=o.enterpriseProjectId WHERE o.enterpriseProjectId IS NOT NULL;
--> statement-breakpoint
UPDATE conversations c JOIN conversation_turns t ON t.conversationId=c.id SET c.enterpriseProjectId=t.enterpriseProjectId WHERE t.enterpriseProjectId IS NOT NULL;
--> statement-breakpoint
UPDATE conversations c JOIN agent_tasks a ON a.id=c.upstreamTaskId JOIN agent_operations o ON o.id=a.operation_id SET c.enterpriseProjectId=o.enterpriseProjectId WHERE o.enterpriseProjectId IS NOT NULL;
--> statement-breakpoint
UPDATE upstream_resources r JOIN conversations c ON c.id=r.conversationId AND c.userId=r.userId SET r.enterpriseProjectId=c.enterpriseProjectId WHERE c.enterpriseProjectId IS NOT NULL;
--> statement-breakpoint
UPDATE upstream_resources r JOIN agent_tasks a ON a.id=r.upstreamId JOIN agent_operations o ON o.id=a.operation_id SET r.enterpriseProjectId=o.enterpriseProjectId WHERE o.enterpriseProjectId IS NOT NULL;
--> statement-breakpoint
ALTER TABLE `knowledge_base_snapshots` DROP INDEX `knowledge_base_snapshots_user_version_uq`, ADD UNIQUE KEY `knowledge_base_snapshots_user_version_uq` (`enterpriseProjectId`,`userId`,`version`);
--> statement-breakpoint
ALTER TABLE `knowledge_base_snapshots` DROP INDEX `knowledge_base_snapshots_source_artifact_uq`, ADD UNIQUE KEY `knowledge_base_snapshots_source_artifact_uq` (`enterpriseProjectId`,`userId`,`sourceBuildId`,`sourceBuildRevision`,`sourceArtifactHash`);
--> statement-breakpoint
ALTER TABLE `workspace_content_revisions` DROP INDEX `workspace_content_revisions_user_module_revision_uq`, ADD UNIQUE KEY `workspace_content_revisions_user_module_revision_uq` (`enterpriseProjectId`,`userId`,`module`,`revision`);
--> statement-breakpoint
ALTER TABLE `site_projects` ADD KEY `site_projects_legacy_owner_idx` (`user_id`);
--> statement-breakpoint
ALTER TABLE `site_projects` DROP INDEX `site_projects_user_uq`, ADD UNIQUE KEY `site_projects_user_uq` (`enterpriseProjectId`,`user_id`);
--> statement-breakpoint
ALTER TABLE `projects` ADD COLUMN `enterprise_project_id` varchar(36) NULL, ADD KEY `projects_enterprise_scope_idx` (`owner_id`,`enterprise_project_id`);
--> statement-breakpoint
UPDATE `projects` m JOIN monitoring_account_links a ON a.monitoringUserId=m.owner_id JOIN enterprise_projects p ON p.ownerUserId=a.dashboardUserId AND p.isLegacyDefault=true SET m.enterprise_project_id=p.id WHERE m.enterprise_project_id IS NULL;

--> statement-breakpoint
ALTER TABLE `knowledge_import_receipts` ADD COLUMN `enterpriseProjectId` varchar(36) NULL;
--> statement-breakpoint
UPDATE `knowledge_import_receipts` t JOIN enterprise_projects p ON p.ownerUserId=t.userId AND p.isLegacyDefault=true SET t.enterpriseProjectId=p.id WHERE t.enterpriseProjectId IS NULL;
--> statement-breakpoint
ALTER TABLE `knowledge_base_reset_cleanup_jobs` ADD COLUMN `enterpriseProjectId` varchar(36) NULL;
--> statement-breakpoint
UPDATE `knowledge_base_reset_cleanup_jobs` t JOIN enterprise_projects p ON p.ownerUserId=t.userId AND p.isLegacyDefault=true SET t.enterpriseProjectId=p.id WHERE t.enterpriseProjectId IS NULL;
--> statement-breakpoint
ALTER TABLE `knowledge_import_receipts` DROP INDEX `knowledge_import_receipts_user_artifact_uq`, ADD UNIQUE KEY `knowledge_import_receipts_user_artifact_uq` (`enterpriseProjectId`,`userId`,`artifactHash`);

--> statement-breakpoint
ALTER TABLE `enterprise_project_questions` RENAME INDEX `workspace_questions_generation_key_uq` TO `enterprise_questions_generation_key_uq`;
--> statement-breakpoint
ALTER TABLE `enterprise_project_questions` RENAME INDEX `workspace_questions_user_period_status_idx` TO `enterprise_questions_user_period_status_idx`;
--> statement-breakpoint
ALTER TABLE `enterprise_project_questions` RENAME INDEX `workspace_questions_user_category_status_idx` TO `enterprise_questions_user_category_status_idx`;
--> statement-breakpoint
ALTER TABLE `enterprise_project_questions` RENAME INDEX `workspace_questions_user_approval_status_idx` TO `enterprise_questions_user_approval_status_idx`;
--> statement-breakpoint
ALTER TABLE `enterprise_project_questions` RENAME INDEX `workspace_questions_external_idx` TO `enterprise_questions_external_idx`;
--> statement-breakpoint
ALTER TABLE `enterprise_project_questions` RENAME INDEX `workspace_questions_source_question_idx` TO `enterprise_questions_source_question_idx`;

--> statement-breakpoint
ALTER TABLE `enterprise_project_questions` ADD CONSTRAINT `epq_legacy_ref_0_fk` FOREIGN KEY (`userId`) REFERENCES `users` (`id`) ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `enterprise_project_questions` ADD CONSTRAINT `epq_legacy_ref_1_fk` FOREIGN KEY (`contractId`) REFERENCES `service_contracts` (`id`) ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `enterprise_project_questions` ADD CONSTRAINT `epq_legacy_ref_2_fk` FOREIGN KEY (`quotaPeriodId`) REFERENCES `service_quota_periods` (`id`) ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `enterprise_project_questions` ADD CONSTRAINT `epq_legacy_ref_3_fk` FOREIGN KEY (`intentConfirmedByUserId`) REFERENCES `users` (`id`) ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `enterprise_project_questions` ADD CONSTRAINT `epq_legacy_ref_4_fk` FOREIGN KEY (`selectionRequestedByUserId`) REFERENCES `users` (`id`) ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `enterprise_project_questions` ADD CONSTRAINT `epq_legacy_ref_5_fk` FOREIGN KEY (`selectionApprovedByUserId`) REFERENCES `users` (`id`) ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `enterprise_project_questions` ADD CONSTRAINT `epq_legacy_ref_6_fk` FOREIGN KEY (`knowledgeSnapshotId`) REFERENCES `knowledge_base_snapshots` (`id`) ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `enterprise_project_questions` ADD CONSTRAINT `epq_legacy_ref_7_fk` FOREIGN KEY (`createdByUserId`) REFERENCES `users` (`id`) ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `enterprise_project_reset_states` ADD CONSTRAINT `eprs_legacy_ref_0_fk` FOREIGN KEY (`userId`) REFERENCES `users` (`id`) ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `enterprise_project_site_profiles` ADD CONSTRAINT `epsp_legacy_ref_0_fk` FOREIGN KEY (`userId`) REFERENCES `users` (`id`) ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `enterprise_project_site_profiles` ADD CONSTRAINT `epsp_legacy_ref_1_fk` FOREIGN KEY (`updatedByUserId`) REFERENCES `users` (`id`) ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `enterprise_project_dashboard_contents` ADD CONSTRAINT `enterprise_contents_project_fk` FOREIGN KEY (`enterpriseProjectId`) REFERENCES `enterprise_projects` (`id`) ON DELETE RESTRICT, ADD CONSTRAINT `enterprise_contents_owner_fk` FOREIGN KEY (`userId`) REFERENCES `users` (`id`) ON DELETE RESTRICT;

--> statement-breakpoint
UPDATE conversations c JOIN site_projects s ON s.conversation_id=c.id SET c.enterpriseProjectId=s.enterpriseProjectId WHERE s.enterpriseProjectId IS NOT NULL;
--> statement-breakpoint
UPDATE local_assets a JOIN attachments f ON f.upstreamFileId=a.id JOIN conversations c ON c.id=f.conversationId SET a.enterpriseProjectId=c.enterpriseProjectId WHERE a.scope='managed_user' AND a.account_user_id=c.userId AND c.enterpriseProjectId IS NOT NULL;
--> statement-breakpoint
UPDATE local_assets a JOIN conversation_turns t ON t.userId=a.account_user_id AND JSON_CONTAINS(t.attachmentFileIds, JSON_QUOTE(a.id)) SET a.enterpriseProjectId=t.enterpriseProjectId WHERE a.scope='managed_user' AND t.enterpriseProjectId IS NOT NULL;
--> statement-breakpoint
UPDATE local_assets a JOIN artifacts f ON f.storage_key=a.storage_key JOIN agent_operations o ON o.id=f.operation_id SET a.enterpriseProjectId=o.enterpriseProjectId WHERE a.scope='managed_user' AND a.account_user_id=o.account_user_id AND o.enterpriseProjectId IS NOT NULL;
--> statement-breakpoint
UPDATE local_assets a JOIN provider_file_leases f ON f.local_asset_id=a.id JOIN upstream_resources r ON r.upstreamId=f.provider_file_id AND r.kind='file' SET a.enterpriseProjectId=r.enterpriseProjectId WHERE a.scope='managed_user' AND a.account_user_id=r.userId AND r.enterpriseProjectId IS NOT NULL;
--> statement-breakpoint
UPDATE local_assets a JOIN enterprise_projects p ON p.ownerUserId=a.account_user_id AND p.isLegacyDefault=true SET a.enterpriseProjectId=p.id WHERE a.scope='managed_user' AND a.site_ops_knowledge_input_epoch_id IS NOT NULL;
--> statement-breakpoint
UPDATE upstream_resources r JOIN conversations c ON c.id=r.conversationId AND c.userId=r.userId SET r.enterpriseProjectId=c.enterpriseProjectId WHERE c.enterpriseProjectId IS NOT NULL;

--> statement-breakpoint
CREATE INDEX `enterprise_project_contents_owner_idx` ON `enterprise_project_dashboard_contents` (`userId`);
