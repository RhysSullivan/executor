CREATE TABLE `approvals` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`task_run_id` text NOT NULL,
	`call_id` text NOT NULL,
	`tool_path` text NOT NULL,
	`status` text NOT NULL,
	`input_preview_json` text NOT NULL,
	`reason` text,
	`requested_at` integer NOT NULL,
	`resolved_at` integer
);
--> statement-breakpoint
CREATE INDEX `approvals_workspace_idx` ON `approvals` (`workspace_id`);--> statement-breakpoint
CREATE INDEX `approvals_task_run_idx` ON `approvals` (`task_run_id`);--> statement-breakpoint
CREATE TABLE `auth_connections` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`workspace_id` text,
	`account_id` text,
	`owner_type` text NOT NULL,
	`strategy` text NOT NULL,
	`display_name` text NOT NULL,
	`status` text NOT NULL,
	`status_reason` text,
	`last_auth_error_class` text,
	`metadata_json` text,
	`additional_headers_json` text,
	`created_by_account_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`last_used_at` integer
);
--> statement-breakpoint
CREATE INDEX `auth_connections_org_idx` ON `auth_connections` (`organization_id`);--> statement-breakpoint
CREATE INDEX `auth_connections_workspace_idx` ON `auth_connections` (`workspace_id`);--> statement-breakpoint
CREATE INDEX `auth_connections_account_idx` ON `auth_connections` (`account_id`);--> statement-breakpoint
CREATE TABLE `auth_materials` (
	`id` text PRIMARY KEY NOT NULL,
	`connection_id` text NOT NULL,
	`ciphertext` text NOT NULL,
	`key_version` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `auth_materials_connection_idx` ON `auth_materials` (`connection_id`);--> statement-breakpoint
CREATE TABLE `oauth_states` (
	`id` text PRIMARY KEY NOT NULL,
	`connection_id` text NOT NULL,
	`access_token_ciphertext` text NOT NULL,
	`refresh_token_ciphertext` text,
	`key_version` text NOT NULL,
	`expires_at` integer,
	`scope` text,
	`token_type` text,
	`issuer` text,
	`refresh_config_json` text,
	`token_version` integer NOT NULL,
	`lease_holder` text,
	`lease_expires_at` integer,
	`lease_fence` integer NOT NULL,
	`last_refresh_at` integer,
	`last_refresh_error_class` text,
	`last_refresh_error` text,
	`reauth_required_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `oauth_states_connection_idx` ON `oauth_states` (`connection_id`);--> statement-breakpoint
CREATE TABLE `organization_memberships` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`account_id` text NOT NULL,
	`role` text NOT NULL,
	`status` text NOT NULL,
	`billable` integer NOT NULL,
	`invited_by_account_id` text,
	`joined_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `organization_memberships_org_idx` ON `organization_memberships` (`organization_id`);--> statement-breakpoint
CREATE INDEX `organization_memberships_account_idx` ON `organization_memberships` (`account_id`);--> statement-breakpoint
CREATE TABLE `organizations` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`status` text NOT NULL,
	`created_by_account_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `policies` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`tool_path_pattern` text NOT NULL,
	`decision` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `policies_workspace_idx` ON `policies` (`workspace_id`);--> statement-breakpoint
CREATE TABLE `profile` (
	`id` text PRIMARY KEY NOT NULL,
	`default_workspace_id` text,
	`display_name` text NOT NULL,
	`runtime_mode` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `source_auth_bindings` (
	`id` text PRIMARY KEY NOT NULL,
	`source_id` text NOT NULL,
	`connection_id` text NOT NULL,
	`organization_id` text NOT NULL,
	`workspace_id` text,
	`account_id` text,
	`scope_type` text NOT NULL,
	`selector` text,
	`enabled` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `source_auth_bindings_source_idx` ON `source_auth_bindings` (`source_id`);--> statement-breakpoint
CREATE INDEX `source_auth_bindings_connection_idx` ON `source_auth_bindings` (`connection_id`);--> statement-breakpoint
CREATE INDEX `source_auth_bindings_org_idx` ON `source_auth_bindings` (`organization_id`);--> statement-breakpoint
CREATE INDEX `source_auth_bindings_workspace_idx` ON `source_auth_bindings` (`workspace_id`);--> statement-breakpoint
CREATE INDEX `source_auth_bindings_account_idx` ON `source_auth_bindings` (`account_id`);--> statement-breakpoint
CREATE TABLE `sources` (
	`workspace_id` text NOT NULL,
	`source_id` text NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`endpoint` text NOT NULL,
	`status` text NOT NULL,
	`enabled` integer NOT NULL,
	`config_json` text NOT NULL,
	`source_hash` text,
	`last_error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`workspace_id`, `source_id`)
);
--> statement-breakpoint
CREATE INDEX `sources_workspace_name_idx` ON `sources` (`workspace_id`,`name`);--> statement-breakpoint
CREATE TABLE `storage_instances` (
	`id` text PRIMARY KEY NOT NULL,
	`scope_type` text NOT NULL,
	`durability` text NOT NULL,
	`status` text NOT NULL,
	`provider` text NOT NULL,
	`backend_key` text NOT NULL,
	`organization_id` text NOT NULL,
	`workspace_id` text,
	`account_id` text,
	`created_by_account_id` text,
	`purpose` text,
	`size_bytes` integer,
	`file_count` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL,
	`closed_at` integer,
	`expires_at` integer
);
--> statement-breakpoint
CREATE INDEX `storage_instances_org_idx` ON `storage_instances` (`organization_id`);--> statement-breakpoint
CREATE INDEX `storage_instances_workspace_idx` ON `storage_instances` (`workspace_id`);--> statement-breakpoint
CREATE TABLE `sync_states` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`target` text NOT NULL,
	`target_url` text NOT NULL,
	`linked_subject` text,
	`cursor` text,
	`last_sync_at` integer,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `sync_states_workspace_idx` ON `sync_states` (`workspace_id`);--> statement-breakpoint
CREATE TABLE `task_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`account_id` text NOT NULL,
	`session_id` text NOT NULL,
	`runtime_id` text NOT NULL,
	`code_hash` text NOT NULL,
	`status` text NOT NULL,
	`started_at` integer,
	`completed_at` integer,
	`exit_code` integer,
	`error` text
);
--> statement-breakpoint
CREATE INDEX `task_runs_workspace_idx` ON `task_runs` (`workspace_id`);--> statement-breakpoint
CREATE TABLE `tool_artifacts` (
	`id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`source_id` text NOT NULL,
	`source_hash` text NOT NULL,
	`tool_count` integer NOT NULL,
	`manifest_json` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`workspace_id`, `source_id`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tool_artifacts_id_idx` ON `tool_artifacts` (`id`);--> statement-breakpoint
CREATE TABLE `workspaces` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`name` text NOT NULL,
	`created_by_account_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `workspaces_org_idx` ON `workspaces` (`organization_id`);