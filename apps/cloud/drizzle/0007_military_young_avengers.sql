CREATE TABLE "oauth2_session" (
	"id" text NOT NULL,
	"scope_id" text NOT NULL,
	"plugin_id" text NOT NULL,
	"strategy" text NOT NULL,
	"connection_id" text NOT NULL,
	"token_scope" text NOT NULL,
	"redirect_url" text NOT NULL,
	"payload" jsonb NOT NULL,
	"expires_at" bigint NOT NULL,
	"created_at" timestamp NOT NULL,
	CONSTRAINT "oauth2_session_scope_id_id_pk" PRIMARY KEY("scope_id","id")
);
--> statement-breakpoint
DROP TABLE "mcp_oauth_session" CASCADE;--> statement-breakpoint
DROP TABLE "openapi_oauth_session" CASCADE;--> statement-breakpoint
ALTER TABLE "graphql_source" ADD COLUMN "query_params" jsonb;--> statement-breakpoint
ALTER TABLE "graphql_source" ADD COLUMN "auth" jsonb;--> statement-breakpoint
ALTER TABLE "openapi_source" ADD COLUMN "query_params" jsonb;--> statement-breakpoint
CREATE INDEX "oauth2_session_scope_id_idx" ON "oauth2_session" USING btree ("scope_id");--> statement-breakpoint
CREATE INDEX "oauth2_session_plugin_id_idx" ON "oauth2_session" USING btree ("plugin_id");--> statement-breakpoint
CREATE INDEX "oauth2_session_connection_id_idx" ON "oauth2_session" USING btree ("connection_id");