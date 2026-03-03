ALTER TABLE "approvals" DROP CONSTRAINT "approvals_workspace_id_workspaces_id_fk";
--> statement-breakpoint
ALTER TABLE "approvals" DROP CONSTRAINT "approvals_task_run_id_task_runs_id_fk";
--> statement-breakpoint
ALTER TABLE "auth_connections" DROP CONSTRAINT "auth_connections_organization_id_organizations_id_fk";
--> statement-breakpoint
ALTER TABLE "auth_connections" DROP CONSTRAINT "auth_connections_workspace_id_workspaces_id_fk";
--> statement-breakpoint
ALTER TABLE "auth_materials" DROP CONSTRAINT "auth_materials_connection_id_auth_connections_id_fk";
--> statement-breakpoint
ALTER TABLE "oauth_states" DROP CONSTRAINT "oauth_states_connection_id_auth_connections_id_fk";
--> statement-breakpoint
ALTER TABLE "organization_memberships" DROP CONSTRAINT "organization_memberships_organization_id_organizations_id_fk";
--> statement-breakpoint
ALTER TABLE "policies" DROP CONSTRAINT "policies_workspace_id_workspaces_id_fk";
--> statement-breakpoint
ALTER TABLE "profile" DROP CONSTRAINT "profile_default_workspace_id_workspaces_id_fk";
--> statement-breakpoint
ALTER TABLE "source_auth_bindings" DROP CONSTRAINT "source_auth_bindings_source_id_sources_source_id_fk";
--> statement-breakpoint
ALTER TABLE "source_auth_bindings" DROP CONSTRAINT "source_auth_bindings_connection_id_auth_connections_id_fk";
--> statement-breakpoint
ALTER TABLE "source_auth_bindings" DROP CONSTRAINT "source_auth_bindings_organization_id_organizations_id_fk";
--> statement-breakpoint
ALTER TABLE "source_auth_bindings" DROP CONSTRAINT "source_auth_bindings_workspace_id_workspaces_id_fk";
--> statement-breakpoint
ALTER TABLE "sources" DROP CONSTRAINT "sources_workspace_id_workspaces_id_fk";
--> statement-breakpoint
ALTER TABLE "storage_instances" DROP CONSTRAINT "storage_instances_organization_id_organizations_id_fk";
--> statement-breakpoint
ALTER TABLE "storage_instances" DROP CONSTRAINT "storage_instances_workspace_id_workspaces_id_fk";
--> statement-breakpoint
ALTER TABLE "sync_states" DROP CONSTRAINT "sync_states_workspace_id_workspaces_id_fk";
--> statement-breakpoint
ALTER TABLE "task_runs" DROP CONSTRAINT "task_runs_workspace_id_workspaces_id_fk";
--> statement-breakpoint
ALTER TABLE "tool_artifacts" DROP CONSTRAINT "tool_artifacts_source_fk";
--> statement-breakpoint
ALTER TABLE "tool_artifacts" DROP CONSTRAINT "tool_artifacts_manifest_fk";
--> statement-breakpoint
ALTER TABLE "workspaces" DROP CONSTRAINT "workspaces_organization_id_organizations_id_fk";
