DROP INDEX "approvals_workspace_idx";--> statement-breakpoint
DROP INDEX "auth_materials_connection_idx";--> statement-breakpoint
DROP INDEX "oauth_states_connection_idx";--> statement-breakpoint
DROP INDEX "policies_workspace_idx";--> statement-breakpoint
DROP INDEX "source_auth_bindings_connection_idx";--> statement-breakpoint
DROP INDEX "sources_workspace_name_idx";--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_task_run_id_task_runs_id_fk" FOREIGN KEY ("task_run_id") REFERENCES "public"."task_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_connections" ADD CONSTRAINT "auth_connections_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_connections" ADD CONSTRAINT "auth_connections_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_materials" ADD CONSTRAINT "auth_materials_connection_id_auth_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."auth_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_states" ADD CONSTRAINT "oauth_states_connection_id_auth_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."auth_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_memberships" ADD CONSTRAINT "organization_memberships_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policies" ADD CONSTRAINT "policies_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile" ADD CONSTRAINT "profile_default_workspace_id_workspaces_id_fk" FOREIGN KEY ("default_workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_auth_bindings" ADD CONSTRAINT "source_auth_bindings_source_id_sources_source_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("source_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_auth_bindings" ADD CONSTRAINT "source_auth_bindings_connection_id_auth_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."auth_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_auth_bindings" ADD CONSTRAINT "source_auth_bindings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_auth_bindings" ADD CONSTRAINT "source_auth_bindings_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sources" ADD CONSTRAINT "sources_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storage_instances" ADD CONSTRAINT "storage_instances_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storage_instances" ADD CONSTRAINT "storage_instances_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_states" ADD CONSTRAINT "sync_states_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_runs" ADD CONSTRAINT "task_runs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_artifacts" ADD CONSTRAINT "tool_artifacts_source_fk" FOREIGN KEY ("workspace_id","source_id") REFERENCES "public"."sources"("workspace_id","source_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "approvals_lookup_idx" ON "approvals" USING btree ("workspace_id","task_run_id","call_id","requested_at");--> statement-breakpoint
CREATE INDEX "auth_connections_org_updated_idx" ON "auth_connections" USING btree ("organization_id","updated_at","id");--> statement-breakpoint
CREATE INDEX "organization_memberships_org_updated_idx" ON "organization_memberships" USING btree ("organization_id","updated_at","id");--> statement-breakpoint
CREATE INDEX "organization_memberships_account_updated_idx" ON "organization_memberships" USING btree ("account_id","updated_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "organization_memberships_org_account_idx" ON "organization_memberships" USING btree ("organization_id","account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "organizations_slug_idx" ON "organizations" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "organizations_updated_idx" ON "organizations" USING btree ("updated_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "policies_workspace_tool_path_idx" ON "policies" USING btree ("workspace_id","tool_path_pattern");--> statement-breakpoint
CREATE INDEX "profile_updated_idx" ON "profile" USING btree ("updated_at","id");--> statement-breakpoint
CREATE INDEX "source_auth_bindings_workspace_scope_idx" ON "source_auth_bindings" USING btree ("workspace_id","updated_at","created_at") WHERE "source_auth_bindings"."workspace_id" is not null;--> statement-breakpoint
CREATE INDEX "source_auth_bindings_org_scope_idx" ON "source_auth_bindings" USING btree ("organization_id","updated_at","created_at") WHERE "source_auth_bindings"."workspace_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "sources_source_id_idx" ON "sources" USING btree ("source_id");--> statement-breakpoint
CREATE INDEX "sources_workspace_name_source_idx" ON "sources" USING btree ("workspace_id","name","source_id");--> statement-breakpoint
CREATE INDEX "storage_instances_workspace_scope_idx" ON "storage_instances" USING btree ("workspace_id","updated_at","id") WHERE "storage_instances"."workspace_id" is not null;--> statement-breakpoint
CREATE INDEX "storage_instances_org_scope_idx" ON "storage_instances" USING btree ("organization_id","updated_at","id") WHERE "storage_instances"."workspace_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "storage_instances_provider_backend_idx" ON "storage_instances" USING btree ("provider","backend_key");--> statement-breakpoint
CREATE UNIQUE INDEX "sync_states_workspace_target_url_idx" ON "sync_states" USING btree ("workspace_id","target","target_url");--> statement-breakpoint
CREATE INDEX "tool_artifacts_source_hash_idx" ON "tool_artifacts" USING btree ("source_hash");--> statement-breakpoint
CREATE INDEX "workspaces_org_updated_idx" ON "workspaces" USING btree ("organization_id","updated_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "workspaces_org_name_idx" ON "workspaces" USING btree ("organization_id","name");--> statement-breakpoint
CREATE INDEX "approvals_workspace_idx" ON "approvals" USING btree ("workspace_id","requested_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "auth_materials_connection_idx" ON "auth_materials" USING btree ("connection_id");--> statement-breakpoint
CREATE UNIQUE INDEX "oauth_states_connection_idx" ON "oauth_states" USING btree ("connection_id");--> statement-breakpoint
CREATE INDEX "policies_workspace_idx" ON "policies" USING btree ("workspace_id","updated_at","id");--> statement-breakpoint
CREATE INDEX "source_auth_bindings_connection_idx" ON "source_auth_bindings" USING btree ("connection_id","updated_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "sources_workspace_name_idx" ON "sources" USING btree ("workspace_id","name");--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_status_check" CHECK ("approvals"."status" in ('pending', 'approved', 'denied', 'expired'));--> statement-breakpoint
ALTER TABLE "auth_connections" ADD CONSTRAINT "auth_connections_owner_type_check" CHECK ("auth_connections"."owner_type" in ('organization', 'workspace', 'account'));--> statement-breakpoint
ALTER TABLE "auth_connections" ADD CONSTRAINT "auth_connections_strategy_check" CHECK ("auth_connections"."strategy" in ('oauth2', 'api_key', 'bearer', 'basic', 'custom'));--> statement-breakpoint
ALTER TABLE "auth_connections" ADD CONSTRAINT "auth_connections_status_check" CHECK ("auth_connections"."status" in ('active', 'reauth_required', 'revoked', 'disabled', 'error'));--> statement-breakpoint
ALTER TABLE "auth_connections" ADD CONSTRAINT "auth_connections_owner_scope_check" CHECK ((
        ("auth_connections"."owner_type" = 'organization' AND "auth_connections"."workspace_id" IS NULL AND "auth_connections"."account_id" IS NULL)
        OR ("auth_connections"."owner_type" = 'workspace' AND "auth_connections"."workspace_id" IS NOT NULL AND "auth_connections"."account_id" IS NULL)
        OR ("auth_connections"."owner_type" = 'account' AND "auth_connections"."workspace_id" IS NULL AND "auth_connections"."account_id" IS NOT NULL)
      ));--> statement-breakpoint
ALTER TABLE "oauth_states" ADD CONSTRAINT "oauth_states_token_version_nonnegative" CHECK ("oauth_states"."token_version" >= 0);--> statement-breakpoint
ALTER TABLE "oauth_states" ADD CONSTRAINT "oauth_states_lease_fence_nonnegative" CHECK ("oauth_states"."lease_fence" >= 0);--> statement-breakpoint
ALTER TABLE "organization_memberships" ADD CONSTRAINT "organization_memberships_role_check" CHECK ("organization_memberships"."role" in ('viewer', 'editor', 'admin', 'owner'));--> statement-breakpoint
ALTER TABLE "organization_memberships" ADD CONSTRAINT "organization_memberships_status_check" CHECK ("organization_memberships"."status" in ('invited', 'active', 'suspended', 'removed'));--> statement-breakpoint
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_status_check" CHECK ("organizations"."status" in ('active', 'suspended', 'archived'));--> statement-breakpoint
ALTER TABLE "policies" ADD CONSTRAINT "policies_decision_check" CHECK ("policies"."decision" in ('allow', 'require_approval', 'deny'));--> statement-breakpoint
ALTER TABLE "profile" ADD CONSTRAINT "profile_runtime_mode_check" CHECK ("profile"."runtime_mode" in ('local', 'linked', 'remote'));--> statement-breakpoint
ALTER TABLE "source_auth_bindings" ADD CONSTRAINT "source_auth_bindings_scope_type_check" CHECK ("source_auth_bindings"."scope_type" in ('workspace', 'organization', 'account'));--> statement-breakpoint
ALTER TABLE "source_auth_bindings" ADD CONSTRAINT "source_auth_bindings_scope_shape_check" CHECK ((
        ("source_auth_bindings"."scope_type" = 'organization' AND "source_auth_bindings"."workspace_id" IS NULL AND "source_auth_bindings"."account_id" IS NULL)
        OR ("source_auth_bindings"."scope_type" = 'workspace' AND "source_auth_bindings"."workspace_id" IS NOT NULL AND "source_auth_bindings"."account_id" IS NULL)
        OR ("source_auth_bindings"."scope_type" = 'account' AND "source_auth_bindings"."workspace_id" IS NULL AND "source_auth_bindings"."account_id" IS NOT NULL)
      ));--> statement-breakpoint
ALTER TABLE "sources" ADD CONSTRAINT "sources_kind_check" CHECK ("sources"."kind" in ('mcp', 'openapi', 'graphql', 'internal'));--> statement-breakpoint
ALTER TABLE "sources" ADD CONSTRAINT "sources_status_check" CHECK ("sources"."status" in ('draft', 'probing', 'auth_required', 'connected', 'error'));--> statement-breakpoint
ALTER TABLE "storage_instances" ADD CONSTRAINT "storage_instances_scope_type_check" CHECK ("storage_instances"."scope_type" in ('scratch', 'account', 'workspace', 'organization'));--> statement-breakpoint
ALTER TABLE "storage_instances" ADD CONSTRAINT "storage_instances_durability_check" CHECK ("storage_instances"."durability" in ('ephemeral', 'durable'));--> statement-breakpoint
ALTER TABLE "storage_instances" ADD CONSTRAINT "storage_instances_status_check" CHECK ("storage_instances"."status" in ('active', 'closed', 'deleted'));--> statement-breakpoint
ALTER TABLE "storage_instances" ADD CONSTRAINT "storage_instances_provider_check" CHECK ("storage_instances"."provider" in ('agentfs-local', 'agentfs-cloudflare'));--> statement-breakpoint
ALTER TABLE "storage_instances" ADD CONSTRAINT "storage_instances_size_nonnegative" CHECK ("storage_instances"."size_bytes" is null or "storage_instances"."size_bytes" >= 0);--> statement-breakpoint
ALTER TABLE "storage_instances" ADD CONSTRAINT "storage_instances_file_count_nonnegative" CHECK ("storage_instances"."file_count" is null or "storage_instances"."file_count" >= 0);--> statement-breakpoint
ALTER TABLE "sync_states" ADD CONSTRAINT "sync_states_target_check" CHECK ("sync_states"."target" in ('remote'));--> statement-breakpoint
ALTER TABLE "task_runs" ADD CONSTRAINT "task_runs_status_check" CHECK ("task_runs"."status" in ('queued', 'running', 'completed', 'failed', 'timed_out', 'denied'));--> statement-breakpoint
ALTER TABLE "tool_artifacts" ADD CONSTRAINT "tool_artifacts_tool_count_nonnegative" CHECK ("tool_artifacts"."tool_count" >= 0);