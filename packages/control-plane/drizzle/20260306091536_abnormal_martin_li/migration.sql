CREATE TABLE "accounts" (
	"id" text PRIMARY KEY,
	"provider" text NOT NULL,
	"subject" text NOT NULL,
	"email" text,
	"display_name" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "accounts_provider_check" CHECK ("provider" in ('local', 'workos', 'service'))
);
--> statement-breakpoint
CREATE TABLE "execution_interactions" (
	"id" text PRIMARY KEY,
	"execution_id" text NOT NULL,
	"status" text NOT NULL,
	"kind" text NOT NULL,
	"payload_json" text NOT NULL,
	"response_json" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "execution_interactions_status_check" CHECK ("status" in ('pending', 'resolved', 'cancelled'))
);
--> statement-breakpoint
CREATE TABLE "executions" (
	"id" text PRIMARY KEY,
	"workspace_id" text NOT NULL,
	"created_by_account_id" text NOT NULL,
	"status" text NOT NULL,
	"code" text NOT NULL,
	"result_json" text,
	"error_text" text,
	"logs_json" text,
	"started_at" bigint,
	"completed_at" bigint,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "executions_status_check" CHECK ("status" in ('pending', 'running', 'waiting_for_interaction', 'completed', 'failed', 'cancelled'))
);
--> statement-breakpoint
CREATE TABLE "local_installations" (
	"id" text PRIMARY KEY,
	"account_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organization_memberships" (
	"id" text PRIMARY KEY,
	"organization_id" text NOT NULL,
	"account_id" text NOT NULL,
	"role" text NOT NULL,
	"status" text NOT NULL,
	"billable" boolean NOT NULL,
	"invited_by_account_id" text,
	"joined_at" bigint,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "organization_memberships_role_check" CHECK ("role" in ('viewer', 'editor', 'admin', 'owner')),
	CONSTRAINT "organization_memberships_status_check" CHECK ("status" in ('invited', 'active', 'suspended', 'removed'))
);
--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" text PRIMARY KEY,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"status" text NOT NULL,
	"created_by_account_id" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "organizations_status_check" CHECK ("status" in ('active', 'suspended', 'archived'))
);
--> statement-breakpoint
CREATE TABLE "policies" (
	"id" text PRIMARY KEY,
	"workspace_id" text NOT NULL,
	"target_account_id" text,
	"client_id" text,
	"resource_type" text NOT NULL,
	"resource_pattern" text NOT NULL,
	"match_type" text NOT NULL,
	"effect" text NOT NULL,
	"approval_mode" text NOT NULL,
	"argument_conditions_json" text,
	"priority" bigint NOT NULL,
	"enabled" boolean NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "policies_resource_type_check" CHECK ("resource_type" in ('all_tools', 'source', 'namespace', 'tool_path')),
	CONSTRAINT "policies_match_type_check" CHECK ("match_type" in ('glob', 'exact')),
	CONSTRAINT "policies_effect_check" CHECK ("effect" in ('allow', 'deny')),
	CONSTRAINT "policies_approval_mode_check" CHECK ("approval_mode" in ('auto', 'required'))
);
--> statement-breakpoint
CREATE TABLE "source_credential_bindings" (
	"workspace_id" text,
	"source_id" text,
	"token_provider_id" text,
	"token_handle" text,
	"refresh_token_provider_id" text,
	"refresh_token_handle" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "source_credential_bindings_pkey" PRIMARY KEY("workspace_id","source_id")
);
--> statement-breakpoint
CREATE TABLE "sources" (
	"workspace_id" text,
	"source_id" text,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"endpoint" text NOT NULL,
	"status" text NOT NULL,
	"enabled" boolean NOT NULL,
	"namespace" text,
	"transport" text,
	"query_params_json" text,
	"headers_json" text,
	"spec_url" text,
	"default_headers_json" text,
	"auth_kind" text NOT NULL,
	"auth_header_name" text,
	"auth_prefix" text,
	"source_hash" text,
	"last_error" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "sources_pkey" PRIMARY KEY("workspace_id","source_id"),
	CONSTRAINT "sources_kind_check" CHECK ("kind" in ('mcp', 'openapi', 'graphql', 'internal')),
	CONSTRAINT "sources_status_check" CHECK ("status" in ('draft', 'probing', 'auth_required', 'connected', 'error')),
	CONSTRAINT "sources_transport_check" CHECK ("transport" is null or "transport" in ('auto', 'streamable-http', 'sse')),
	CONSTRAINT "sources_auth_kind_check" CHECK ("auth_kind" in ('none', 'bearer', 'oauth2'))
);
--> statement-breakpoint
CREATE TABLE "workspaces" (
	"id" text PRIMARY KEY,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"created_by_account_id" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "accounts_provider_subject_idx" ON "accounts" ("provider","subject");--> statement-breakpoint
CREATE INDEX "accounts_updated_idx" ON "accounts" ("updated_at","id");--> statement-breakpoint
CREATE INDEX "execution_interactions_execution_idx" ON "execution_interactions" ("execution_id","updated_at","id");--> statement-breakpoint
CREATE INDEX "executions_workspace_idx" ON "executions" ("workspace_id","updated_at","id");--> statement-breakpoint
CREATE INDEX "organization_memberships_org_idx" ON "organization_memberships" ("organization_id");--> statement-breakpoint
CREATE INDEX "organization_memberships_account_idx" ON "organization_memberships" ("account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "organization_memberships_org_account_idx" ON "organization_memberships" ("organization_id","account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "organizations_slug_idx" ON "organizations" ("slug");--> statement-breakpoint
CREATE INDEX "organizations_updated_idx" ON "organizations" ("updated_at","id");--> statement-breakpoint
CREATE INDEX "policies_workspace_idx" ON "policies" ("workspace_id","updated_at","id");--> statement-breakpoint
CREATE INDEX "source_credential_bindings_workspace_idx" ON "source_credential_bindings" ("workspace_id","updated_at","source_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sources_workspace_name_idx" ON "sources" ("workspace_id","name");--> statement-breakpoint
CREATE INDEX "workspaces_org_idx" ON "workspaces" ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "workspaces_org_name_idx" ON "workspaces" ("organization_id","name");