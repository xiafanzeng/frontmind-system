CREATE TABLE ai_charge_commands (
 id varchar(36) NOT NULL PRIMARY KEY, local_task_id varchar(36) NOT NULL, command_key varchar(191) NOT NULL,
 operation_id varchar(36) NOT NULL, account_user_id int NOT NULL, wallet_user_id varchar(36) NOT NULL,
 enterprise_project_id varchar(36), session_id varchar(255) NOT NULL, model varchar(64) NOT NULL,
 effort varchar(16) NOT NULL, pricing_version varchar(64) NOT NULL,
 reserved_ten_thousandths bigint unsigned NOT NULL DEFAULT 0,
 reserve_window_ten_thousandths bigint unsigned NOT NULL DEFAULT 0,
 consumed_ten_thousandths bigint unsigned NOT NULL DEFAULT 0,
 state varchar(24) NOT NULL DEFAULT 'authorized', observed_at timestamp NULL,
 created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
 updated_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
 UNIQUE KEY ai_commands_task_key_uq(local_task_id,command_key),
 KEY ai_commands_owner_state_idx(account_user_id,state),
 CONSTRAINT ai_commands_account_fk FOREIGN KEY(account_user_id) REFERENCES users(id) ON DELETE RESTRICT,
 CONSTRAINT ai_commands_wallet_fk FOREIGN KEY(wallet_user_id) REFERENCES unified_money_wallets(user_id) ON DELETE RESTRICT
);--> statement-breakpoint
CREATE TABLE ai_cost_events (
 id varchar(36) NOT NULL PRIMARY KEY, provider_event_id varchar(255) NOT NULL, session_id varchar(255) NOT NULL,
 local_task_id varchar(36) NOT NULL, operation_id varchar(36) NOT NULL, command_id varchar(36),
 account_user_id int, enterprise_project_id varchar(36), scope varchar(24) NOT NULL,
 model varchar(64) NOT NULL, pricing_version varchar(64), input_tokens bigint unsigned,
 output_tokens bigint unsigned, cache_read_input_tokens bigint unsigned, cache_creation_input_tokens bigint unsigned,
 cost_nanos bigint unsigned, charged_ten_thousandths bigint unsigned NOT NULL DEFAULT 0,
 cost_state varchar(24) NOT NULL, is_error boolean NOT NULL DEFAULT false,
 occurred_at timestamp NOT NULL, created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE KEY ai_cost_event_session_uq(session_id,provider_event_id),
 KEY ai_cost_owner_time_idx(account_user_id,occurred_at), KEY ai_cost_scope_time_idx(scope,occurred_at)
);--> statement-breakpoint
CREATE TABLE ai_wallet_ledger (
 id varchar(36) NOT NULL PRIMARY KEY, user_id varchar(36) NOT NULL, command_id varchar(36) NOT NULL,
 type varchar(24) NOT NULL, balance_delta_ten_thousandths bigint NOT NULL,
 reserved_delta_ten_thousandths bigint NOT NULL, balance_after_ten_thousandths bigint NOT NULL,
 reason varchar(240) NOT NULL, idempotency_key varchar(191) NOT NULL,
 reference_id varchar(255), created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE KEY ai_wallet_ledger_idempotency_uq(idempotency_key), KEY ai_wallet_ledger_owner_time_idx(user_id,created_at)
);--> statement-breakpoint
CREATE TABLE ai_billing_configuration (
 id int NOT NULL PRIMARY KEY, mode varchar(24) NOT NULL,
 enabled_at datetime(3) NOT NULL, pricing_version varchar(64) NOT NULL,
 initial_reserve_ten_thousandths bigint unsigned NOT NULL,
 refill_ratio_basis_points int unsigned NOT NULL
);--> statement-breakpoint
INSERT INTO ai_billing_configuration (id,mode,enabled_at,pricing_version,initial_reserve_ten_thousandths,refill_ratio_basis_points)
VALUES (1,'active',UTC_TIMESTAMP(3),'zhipu-glm-5.3-2026-09-07',10000,8000);
--> statement-breakpoint
ALTER TABLE ai_billing_configuration ADD sync_token varchar(36) NULL, ADD sync_until datetime(3) NULL;--> statement-breakpoint
CREATE TABLE ai_usage_sync_targets (
 local_task_id varchar(36) NOT NULL PRIMARY KEY,
 next_sync_at datetime(3) NOT NULL, last_error varchar(64) NULL,
 KEY ai_usage_sync_due_idx(next_sync_at)
);--> statement-breakpoint
INSERT INTO ai_usage_sync_targets(local_task_id,next_sync_at)
SELECT t.id,UTC_TIMESTAMP(3) FROM agent_tasks t JOIN agent_operations o ON o.id=t.operation_id
WHERE o.provider='zhipu' AND o.created_at>=UTC_TIMESTAMP()-INTERVAL 30 DAY;
