CREATE TABLE "auth_connections" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"workspace_id" text,
	"account_id" text,
	"owner_type" text NOT NULL,
	"strategy" text NOT NULL,
	"display_name" text NOT NULL,
	"status" text NOT NULL,
	"status_reason" text,
	"last_auth_error_class" text,
	"metadata_json" text,
	"additional_headers_json" text,
	"created_by_account_id" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	"last_used_at" bigint,
	CONSTRAINT "auth_connections_owner_type_check" CHECK ("auth_connections"."owner_type" in ('organization', 'workspace', 'account')),
	CONSTRAINT "auth_connections_strategy_check" CHECK ("auth_connections"."strategy" in ('oauth2', 'api_key', 'bearer', 'basic', 'custom')),
	CONSTRAINT "auth_connections_status_check" CHECK ("auth_connections"."status" in ('active', 'reauth_required', 'revoked', 'disabled', 'error')),
	CONSTRAINT "auth_connections_owner_scope_check" CHECK ((
        ("auth_connections"."owner_type" = 'organization' AND "auth_connections"."workspace_id" IS NULL AND "auth_connections"."account_id" IS NULL)
        OR ("auth_connections"."owner_type" = 'workspace' AND "auth_connections"."workspace_id" IS NOT NULL AND "auth_connections"."account_id" IS NULL)
        OR ("auth_connections"."owner_type" = 'account' AND "auth_connections"."workspace_id" IS NULL AND "auth_connections"."account_id" IS NOT NULL)
      ))
);
--> statement-breakpoint
CREATE TABLE "auth_materials" (
	"id" text PRIMARY KEY NOT NULL,
	"connection_id" text NOT NULL,
	"backend" text NOT NULL,
	"material_handle" text NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "interactions" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"task_run_id" text NOT NULL,
	"origin_server" text NOT NULL,
	"origin_request_id" text NOT NULL,
	"call_id" text NOT NULL,
	"tool_path" text NOT NULL,
	"mode" text NOT NULL,
	"elicitation_id" text,
	"message" text NOT NULL,
	"requested_schema_json" text,
	"url" text,
	"status" text NOT NULL,
	"request_json" text NOT NULL,
	"response_action" text,
	"response_content_json" text,
	"reason" text,
	"requested_at" bigint NOT NULL,
	"resolved_at" bigint,
	"completion_notified_at" bigint,
	"expires_at" bigint,
	CONSTRAINT "interactions_mode_check" CHECK ("interactions"."mode" in ('form', 'url')),
	CONSTRAINT "interactions_status_check" CHECK ("interactions"."status" in ('pending', 'accepted', 'declined', 'cancelled', 'expired', 'failed')),
	CONSTRAINT "interactions_response_action_check" CHECK ("interactions"."response_action" is null or "interactions"."response_action" in ('accept', 'decline', 'cancel'))
);
--> statement-breakpoint
CREATE TABLE "oauth_states" (
	"id" text PRIMARY KEY NOT NULL,
	"connection_id" text NOT NULL,
	"backend" text NOT NULL,
	"access_token_handle" text NOT NULL,
	"refresh_token_handle" text,
	"client_secret_handle" text,
	"expires_at" bigint,
	"scope" text,
	"token_type" text,
	"issuer" text,
	"refresh_config_json" text,
	"token_version" bigint NOT NULL,
	"lease_holder" text,
	"lease_expires_at" bigint,
	"lease_fence" bigint NOT NULL,
	"last_refresh_at" bigint,
	"last_refresh_error_class" text,
	"last_refresh_error" text,
	"reauth_required_at" bigint,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "oauth_states_token_version_nonnegative" CHECK ("oauth_states"."token_version" >= 0),
	CONSTRAINT "oauth_states_lease_fence_nonnegative" CHECK ("oauth_states"."lease_fence" >= 0)
);
--> statement-breakpoint
CREATE TABLE "organization_memberships" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"account_id" text NOT NULL,
	"role" text NOT NULL,
	"status" text NOT NULL,
	"billable" boolean NOT NULL,
	"invited_by_account_id" text,
	"joined_at" bigint,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "organization_memberships_role_check" CHECK ("organization_memberships"."role" in ('viewer', 'editor', 'admin', 'owner')),
	CONSTRAINT "organization_memberships_status_check" CHECK ("organization_memberships"."status" in ('invited', 'active', 'suspended', 'removed'))
);
--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" text PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"status" text NOT NULL,
	"created_by_account_id" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "organizations_status_check" CHECK ("organizations"."status" in ('active', 'suspended', 'archived'))
);
--> statement-breakpoint
CREATE TABLE "policies" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"tool_path_pattern" text NOT NULL,
	"decision" text NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "policies_decision_check" CHECK ("policies"."decision" in ('allow', 'require_approval', 'deny'))
);
--> statement-breakpoint
CREATE TABLE "profile" (
	"id" text PRIMARY KEY NOT NULL,
	"default_workspace_id" text,
	"display_name" text NOT NULL,
	"runtime_mode" text NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "profile_runtime_mode_check" CHECK ("profile"."runtime_mode" in ('local', 'linked', 'remote'))
);
--> statement-breakpoint
CREATE TABLE "secret_materials" (
	"handle" text PRIMARY KEY NOT NULL,
	"backend" text NOT NULL,
	"organization_id" text NOT NULL,
	"workspace_id" text,
	"account_id" text,
	"connection_id" text NOT NULL,
	"purpose" text NOT NULL,
	"material" text NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "secret_materials_purpose_check" CHECK ("secret_materials"."purpose" in ('auth_material', 'oauth_access_token', 'oauth_refresh_token', 'oauth_client_secret'))
);
--> statement-breakpoint
CREATE TABLE "source_auth_bindings" (
	"id" text PRIMARY KEY NOT NULL,
	"source_id" text NOT NULL,
	"connection_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"workspace_id" text,
	"account_id" text,
	"scope_type" text NOT NULL,
	"selector" text,
	"enabled" boolean NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "source_auth_bindings_scope_type_check" CHECK ("source_auth_bindings"."scope_type" in ('workspace', 'organization', 'account')),
	CONSTRAINT "source_auth_bindings_scope_shape_check" CHECK ((
        ("source_auth_bindings"."scope_type" = 'organization' AND "source_auth_bindings"."workspace_id" IS NULL AND "source_auth_bindings"."account_id" IS NULL)
        OR ("source_auth_bindings"."scope_type" = 'workspace' AND "source_auth_bindings"."workspace_id" IS NOT NULL AND "source_auth_bindings"."account_id" IS NULL)
        OR ("source_auth_bindings"."scope_type" = 'account' AND "source_auth_bindings"."workspace_id" IS NULL AND "source_auth_bindings"."account_id" IS NOT NULL)
      ))
);
--> statement-breakpoint
CREATE TABLE "sources" (
	"workspace_id" text NOT NULL,
	"source_id" text NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"endpoint" text NOT NULL,
	"status" text NOT NULL,
	"enabled" boolean NOT NULL,
	"config_json" text NOT NULL,
	"source_hash" text,
	"last_error" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "sources_workspace_id_source_id_pk" PRIMARY KEY("workspace_id","source_id"),
	CONSTRAINT "sources_kind_check" CHECK ("sources"."kind" in ('mcp', 'openapi', 'graphql', 'internal')),
	CONSTRAINT "sources_status_check" CHECK ("sources"."status" in ('draft', 'probing', 'auth_required', 'connected', 'error'))
);
--> statement-breakpoint
CREATE TABLE "storage_instances" (
	"id" text PRIMARY KEY NOT NULL,
	"scope_type" text NOT NULL,
	"durability" text NOT NULL,
	"status" text NOT NULL,
	"provider" text NOT NULL,
	"backend_key" text NOT NULL,
	"organization_id" text NOT NULL,
	"workspace_id" text,
	"account_id" text,
	"created_by_account_id" text,
	"purpose" text,
	"size_bytes" bigint,
	"file_count" bigint,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	"last_seen_at" bigint NOT NULL,
	"closed_at" bigint,
	"expires_at" bigint,
	CONSTRAINT "storage_instances_scope_type_check" CHECK ("storage_instances"."scope_type" in ('scratch', 'account', 'workspace', 'organization')),
	CONSTRAINT "storage_instances_durability_check" CHECK ("storage_instances"."durability" in ('ephemeral', 'durable')),
	CONSTRAINT "storage_instances_status_check" CHECK ("storage_instances"."status" in ('active', 'closed', 'deleted')),
	CONSTRAINT "storage_instances_provider_check" CHECK ("storage_instances"."provider" in ('agentfs-local', 'agentfs-cloudflare')),
	CONSTRAINT "storage_instances_size_nonnegative" CHECK ("storage_instances"."size_bytes" is null or "storage_instances"."size_bytes" >= 0),
	CONSTRAINT "storage_instances_file_count_nonnegative" CHECK ("storage_instances"."file_count" is null or "storage_instances"."file_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "sync_states" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"target" text NOT NULL,
	"target_url" text NOT NULL,
	"linked_subject" text,
	"cursor" text,
	"last_sync_at" bigint,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "sync_states_target_check" CHECK ("sync_states"."target" in ('remote'))
);
--> statement-breakpoint
CREATE TABLE "task_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"account_id" text NOT NULL,
	"session_id" text NOT NULL,
	"runtime_id" text NOT NULL,
	"code_hash" text NOT NULL,
	"status" text NOT NULL,
	"started_at" bigint,
	"completed_at" bigint,
	"exit_code" bigint,
	"error" text,
	CONSTRAINT "task_runs_status_check" CHECK ("task_runs"."status" in ('queued', 'running', 'waiting_for_interaction', 'completed', 'failed', 'timed_out', 'denied'))
);
--> statement-breakpoint
CREATE TABLE "tool_artifacts" (
	"id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"source_id" text NOT NULL,
	"source_hash" text NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "tool_artifacts_workspace_id_source_id_pk" PRIMARY KEY("workspace_id","source_id")
);
--> statement-breakpoint
CREATE TABLE "tool_manifests" (
	"source_hash" text PRIMARY KEY NOT NULL,
	"tool_count" bigint NOT NULL,
	"manifest_json" text NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "tool_manifests_tool_count_nonnegative" CHECK ("tool_manifests"."tool_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "workspaces" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"created_by_account_id" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE INDEX "auth_connections_org_idx" ON "auth_connections" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "auth_connections_workspace_idx" ON "auth_connections" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "auth_connections_account_idx" ON "auth_connections" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "auth_connections_org_updated_idx" ON "auth_connections" USING btree ("organization_id","updated_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "auth_materials_connection_idx" ON "auth_materials" USING btree ("connection_id");--> statement-breakpoint
CREATE UNIQUE INDEX "auth_materials_material_handle_idx" ON "auth_materials" USING btree ("material_handle");--> statement-breakpoint
CREATE INDEX "interactions_workspace_idx" ON "interactions" USING btree ("workspace_id","requested_at","id");--> statement-breakpoint
CREATE INDEX "interactions_task_run_idx" ON "interactions" USING btree ("task_run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "interactions_origin_request_idx" ON "interactions" USING btree ("origin_server","origin_request_id");--> statement-breakpoint
CREATE UNIQUE INDEX "interactions_url_elicitation_idx" ON "interactions" USING btree ("origin_server","elicitation_id") WHERE "interactions"."elicitation_id" is not null;--> statement-breakpoint
CREATE INDEX "interactions_lookup_idx" ON "interactions" USING btree ("workspace_id","task_run_id","call_id","requested_at");--> statement-breakpoint
CREATE UNIQUE INDEX "oauth_states_connection_idx" ON "oauth_states" USING btree ("connection_id");--> statement-breakpoint
CREATE UNIQUE INDEX "oauth_states_access_token_handle_idx" ON "oauth_states" USING btree ("access_token_handle");--> statement-breakpoint
CREATE INDEX "organization_memberships_org_idx" ON "organization_memberships" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "organization_memberships_account_idx" ON "organization_memberships" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "organization_memberships_org_updated_idx" ON "organization_memberships" USING btree ("organization_id","updated_at","id");--> statement-breakpoint
CREATE INDEX "organization_memberships_account_updated_idx" ON "organization_memberships" USING btree ("account_id","updated_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "organization_memberships_org_account_idx" ON "organization_memberships" USING btree ("organization_id","account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "organizations_slug_idx" ON "organizations" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "organizations_updated_idx" ON "organizations" USING btree ("updated_at","id");--> statement-breakpoint
CREATE INDEX "policies_workspace_idx" ON "policies" USING btree ("workspace_id","updated_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "policies_workspace_tool_path_idx" ON "policies" USING btree ("workspace_id","tool_path_pattern");--> statement-breakpoint
CREATE INDEX "profile_updated_idx" ON "profile" USING btree ("updated_at","id");--> statement-breakpoint
CREATE INDEX "secret_materials_connection_idx" ON "secret_materials" USING btree ("connection_id","updated_at");--> statement-breakpoint
CREATE INDEX "secret_materials_org_idx" ON "secret_materials" USING btree ("organization_id","updated_at");--> statement-breakpoint
CREATE INDEX "source_auth_bindings_source_idx" ON "source_auth_bindings" USING btree ("source_id");--> statement-breakpoint
CREATE INDEX "source_auth_bindings_connection_idx" ON "source_auth_bindings" USING btree ("connection_id","updated_at","id");--> statement-breakpoint
CREATE INDEX "source_auth_bindings_org_idx" ON "source_auth_bindings" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "source_auth_bindings_workspace_idx" ON "source_auth_bindings" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "source_auth_bindings_account_idx" ON "source_auth_bindings" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "source_auth_bindings_workspace_scope_idx" ON "source_auth_bindings" USING btree ("workspace_id","updated_at","created_at") WHERE "source_auth_bindings"."workspace_id" is not null;--> statement-breakpoint
CREATE INDEX "source_auth_bindings_org_scope_idx" ON "source_auth_bindings" USING btree ("organization_id","updated_at","created_at") WHERE "source_auth_bindings"."workspace_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "sources_source_id_idx" ON "sources" USING btree ("source_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sources_workspace_name_idx" ON "sources" USING btree ("workspace_id","name");--> statement-breakpoint
CREATE INDEX "sources_workspace_name_source_idx" ON "sources" USING btree ("workspace_id","name","source_id");--> statement-breakpoint
CREATE INDEX "storage_instances_org_idx" ON "storage_instances" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "storage_instances_workspace_idx" ON "storage_instances" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "storage_instances_workspace_scope_idx" ON "storage_instances" USING btree ("workspace_id","updated_at","id") WHERE "storage_instances"."workspace_id" is not null;--> statement-breakpoint
CREATE INDEX "storage_instances_org_scope_idx" ON "storage_instances" USING btree ("organization_id","updated_at","id") WHERE "storage_instances"."workspace_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "storage_instances_provider_backend_idx" ON "storage_instances" USING btree ("provider","backend_key");--> statement-breakpoint
CREATE INDEX "sync_states_workspace_idx" ON "sync_states" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sync_states_workspace_target_url_idx" ON "sync_states" USING btree ("workspace_id","target","target_url");--> statement-breakpoint
CREATE INDEX "task_runs_workspace_idx" ON "task_runs" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tool_artifacts_id_idx" ON "tool_artifacts" USING btree ("id");--> statement-breakpoint
CREATE INDEX "tool_artifacts_source_hash_idx" ON "tool_artifacts" USING btree ("source_hash");--> statement-breakpoint
CREATE INDEX "workspaces_org_idx" ON "workspaces" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "workspaces_org_updated_idx" ON "workspaces" USING btree ("organization_id","updated_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "workspaces_org_name_idx" ON "workspaces" USING btree ("organization_id","name");