CREATE TABLE "accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memberships" (
	"account_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memberships_account_id_organization_id_pk" PRIMARY KEY("account_id","organization_id")
);
--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "blob" (
	"namespace" text NOT NULL,
	"key" text NOT NULL,
	"value" text NOT NULL,
	CONSTRAINT "blob_namespace_key_pk" PRIMARY KEY("namespace","key")
);
--> statement-breakpoint
CREATE TABLE "definition" (
	"id" text NOT NULL,
	"scope_id" text NOT NULL,
	"source_id" text NOT NULL,
	"plugin_id" text NOT NULL,
	"name" text NOT NULL,
	"schema" jsonb NOT NULL,
	"created_at" timestamp NOT NULL,
	CONSTRAINT "definition_scope_id_id_pk" PRIMARY KEY("scope_id","id")
);
--> statement-breakpoint
CREATE TABLE "graphql_operation" (
	"id" text NOT NULL,
	"scope_id" text NOT NULL,
	"source_id" text NOT NULL,
	"binding" jsonb NOT NULL,
	CONSTRAINT "graphql_operation_scope_id_id_pk" PRIMARY KEY("scope_id","id")
);
--> statement-breakpoint
CREATE TABLE "graphql_source" (
	"id" text NOT NULL,
	"scope_id" text NOT NULL,
	"name" text NOT NULL,
	"endpoint" text NOT NULL,
	"headers" jsonb,
	CONSTRAINT "graphql_source_scope_id_id_pk" PRIMARY KEY("scope_id","id")
);
--> statement-breakpoint
CREATE TABLE "mcp_binding" (
	"id" text NOT NULL,
	"scope_id" text NOT NULL,
	"source_id" text NOT NULL,
	"binding" jsonb NOT NULL,
	"created_at" timestamp NOT NULL,
	CONSTRAINT "mcp_binding_scope_id_id_pk" PRIMARY KEY("scope_id","id")
);
--> statement-breakpoint
CREATE TABLE "mcp_oauth_session" (
	"id" text NOT NULL,
	"scope_id" text NOT NULL,
	"session" jsonb NOT NULL,
	"expires_at" integer NOT NULL,
	"created_at" timestamp NOT NULL,
	CONSTRAINT "mcp_oauth_session_scope_id_id_pk" PRIMARY KEY("scope_id","id")
);
--> statement-breakpoint
CREATE TABLE "mcp_source" (
	"id" text NOT NULL,
	"scope_id" text NOT NULL,
	"name" text NOT NULL,
	"config" jsonb NOT NULL,
	"created_at" timestamp NOT NULL,
	CONSTRAINT "mcp_source_scope_id_id_pk" PRIMARY KEY("scope_id","id")
);
--> statement-breakpoint
CREATE TABLE "openapi_oauth_session" (
	"id" text NOT NULL,
	"scope_id" text NOT NULL,
	"session" jsonb NOT NULL,
	"created_at" timestamp NOT NULL,
	CONSTRAINT "openapi_oauth_session_scope_id_id_pk" PRIMARY KEY("scope_id","id")
);
--> statement-breakpoint
CREATE TABLE "openapi_operation" (
	"id" text NOT NULL,
	"scope_id" text NOT NULL,
	"source_id" text NOT NULL,
	"binding" jsonb NOT NULL,
	CONSTRAINT "openapi_operation_scope_id_id_pk" PRIMARY KEY("scope_id","id")
);
--> statement-breakpoint
CREATE TABLE "openapi_source" (
	"id" text NOT NULL,
	"scope_id" text NOT NULL,
	"name" text NOT NULL,
	"spec" text NOT NULL,
	"base_url" text,
	"headers" jsonb,
	"oauth2" jsonb,
	"invocation_config" jsonb NOT NULL,
	CONSTRAINT "openapi_source_scope_id_id_pk" PRIMARY KEY("scope_id","id")
);
--> statement-breakpoint
CREATE TABLE "secret" (
	"id" text NOT NULL,
	"scope_id" text NOT NULL,
	"name" text NOT NULL,
	"provider" text NOT NULL,
	"created_at" timestamp NOT NULL,
	CONSTRAINT "secret_scope_id_id_pk" PRIMARY KEY("scope_id","id")
);
--> statement-breakpoint
CREATE TABLE "source" (
	"id" text NOT NULL,
	"scope_id" text NOT NULL,
	"plugin_id" text NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"url" text,
	"can_remove" boolean DEFAULT true NOT NULL,
	"can_refresh" boolean DEFAULT false NOT NULL,
	"can_edit" boolean DEFAULT false NOT NULL,
	"created_at" timestamp NOT NULL,
	"updated_at" timestamp NOT NULL,
	CONSTRAINT "source_scope_id_id_pk" PRIMARY KEY("scope_id","id")
);
--> statement-breakpoint
CREATE TABLE "tool" (
	"id" text NOT NULL,
	"scope_id" text NOT NULL,
	"source_id" text NOT NULL,
	"plugin_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"input_schema" jsonb,
	"output_schema" jsonb,
	"created_at" timestamp NOT NULL,
	"updated_at" timestamp NOT NULL,
	CONSTRAINT "tool_scope_id_id_pk" PRIMARY KEY("scope_id","id")
);
--> statement-breakpoint
CREATE TABLE "workos_vault_metadata" (
	"id" text NOT NULL,
	"scope_id" text NOT NULL,
	"name" text NOT NULL,
	"purpose" text,
	"created_at" timestamp NOT NULL,
	CONSTRAINT "workos_vault_metadata_scope_id_id_pk" PRIMARY KEY("scope_id","id")
);
--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "definition_scope_id_idx" ON "definition" USING btree ("scope_id");--> statement-breakpoint
CREATE INDEX "definition_source_id_idx" ON "definition" USING btree ("source_id");--> statement-breakpoint
CREATE INDEX "definition_plugin_id_idx" ON "definition" USING btree ("plugin_id");--> statement-breakpoint
CREATE INDEX "graphql_operation_scope_id_idx" ON "graphql_operation" USING btree ("scope_id");--> statement-breakpoint
CREATE INDEX "graphql_operation_source_id_idx" ON "graphql_operation" USING btree ("source_id");--> statement-breakpoint
CREATE INDEX "graphql_source_scope_id_idx" ON "graphql_source" USING btree ("scope_id");--> statement-breakpoint
CREATE INDEX "mcp_binding_scope_id_idx" ON "mcp_binding" USING btree ("scope_id");--> statement-breakpoint
CREATE INDEX "mcp_binding_source_id_idx" ON "mcp_binding" USING btree ("source_id");--> statement-breakpoint
CREATE INDEX "mcp_oauth_session_scope_id_idx" ON "mcp_oauth_session" USING btree ("scope_id");--> statement-breakpoint
CREATE INDEX "mcp_source_scope_id_idx" ON "mcp_source" USING btree ("scope_id");--> statement-breakpoint
CREATE INDEX "openapi_oauth_session_scope_id_idx" ON "openapi_oauth_session" USING btree ("scope_id");--> statement-breakpoint
CREATE INDEX "openapi_operation_scope_id_idx" ON "openapi_operation" USING btree ("scope_id");--> statement-breakpoint
CREATE INDEX "openapi_operation_source_id_idx" ON "openapi_operation" USING btree ("source_id");--> statement-breakpoint
CREATE INDEX "openapi_source_scope_id_idx" ON "openapi_source" USING btree ("scope_id");--> statement-breakpoint
CREATE INDEX "secret_scope_id_idx" ON "secret" USING btree ("scope_id");--> statement-breakpoint
CREATE INDEX "secret_provider_idx" ON "secret" USING btree ("provider");--> statement-breakpoint
CREATE INDEX "source_scope_id_idx" ON "source" USING btree ("scope_id");--> statement-breakpoint
CREATE INDEX "source_plugin_id_idx" ON "source" USING btree ("plugin_id");--> statement-breakpoint
CREATE INDEX "tool_scope_id_idx" ON "tool" USING btree ("scope_id");--> statement-breakpoint
CREATE INDEX "tool_source_id_idx" ON "tool" USING btree ("source_id");--> statement-breakpoint
CREATE INDEX "tool_plugin_id_idx" ON "tool" USING btree ("plugin_id");--> statement-breakpoint
CREATE INDEX "workos_vault_metadata_scope_id_idx" ON "workos_vault_metadata" USING btree ("scope_id");