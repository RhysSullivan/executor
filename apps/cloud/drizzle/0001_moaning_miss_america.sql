ALTER TABLE "definition" ADD COLUMN "scope_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "graphql_operation" ADD COLUMN "scope_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "graphql_source" ADD COLUMN "scope_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "mcp_binding" ADD COLUMN "scope_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "mcp_oauth_session" ADD COLUMN "scope_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "mcp_source" ADD COLUMN "scope_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "openapi_oauth_session" ADD COLUMN "scope_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "openapi_operation" ADD COLUMN "scope_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "openapi_source" ADD COLUMN "scope_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "secret" ADD COLUMN "scope_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "source" ADD COLUMN "scope_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "tool" ADD COLUMN "scope_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "workos_vault_metadata" ADD COLUMN "scope_id" text NOT NULL;--> statement-breakpoint
CREATE INDEX "definition_scope_id_idx" ON "definition" USING btree ("scope_id");--> statement-breakpoint
CREATE INDEX "graphql_operation_scope_id_idx" ON "graphql_operation" USING btree ("scope_id");--> statement-breakpoint
CREATE INDEX "graphql_source_scope_id_idx" ON "graphql_source" USING btree ("scope_id");--> statement-breakpoint
CREATE INDEX "mcp_binding_scope_id_idx" ON "mcp_binding" USING btree ("scope_id");--> statement-breakpoint
CREATE INDEX "mcp_oauth_session_scope_id_idx" ON "mcp_oauth_session" USING btree ("scope_id");--> statement-breakpoint
CREATE INDEX "mcp_source_scope_id_idx" ON "mcp_source" USING btree ("scope_id");--> statement-breakpoint
CREATE INDEX "openapi_oauth_session_scope_id_idx" ON "openapi_oauth_session" USING btree ("scope_id");--> statement-breakpoint
CREATE INDEX "openapi_operation_scope_id_idx" ON "openapi_operation" USING btree ("scope_id");--> statement-breakpoint
CREATE INDEX "openapi_source_scope_id_idx" ON "openapi_source" USING btree ("scope_id");--> statement-breakpoint
CREATE INDEX "secret_scope_id_idx" ON "secret" USING btree ("scope_id");--> statement-breakpoint
CREATE INDEX "source_scope_id_idx" ON "source" USING btree ("scope_id");--> statement-breakpoint
CREATE INDEX "tool_scope_id_idx" ON "tool" USING btree ("scope_id");--> statement-breakpoint
CREATE INDEX "workos_vault_metadata_scope_id_idx" ON "workos_vault_metadata" USING btree ("scope_id");