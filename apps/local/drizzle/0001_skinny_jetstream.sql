ALTER TABLE `definition` ADD `scope_id` text NOT NULL;--> statement-breakpoint
CREATE INDEX `definition_scope_id_idx` ON `definition` (`scope_id`);--> statement-breakpoint
ALTER TABLE `google_discovery_binding` ADD `scope_id` text NOT NULL;--> statement-breakpoint
CREATE INDEX `google_discovery_binding_scope_id_idx` ON `google_discovery_binding` (`scope_id`);--> statement-breakpoint
ALTER TABLE `google_discovery_oauth_session` ADD `scope_id` text NOT NULL;--> statement-breakpoint
CREATE INDEX `google_discovery_oauth_session_scope_id_idx` ON `google_discovery_oauth_session` (`scope_id`);--> statement-breakpoint
ALTER TABLE `google_discovery_source` ADD `scope_id` text NOT NULL;--> statement-breakpoint
CREATE INDEX `google_discovery_source_scope_id_idx` ON `google_discovery_source` (`scope_id`);--> statement-breakpoint
ALTER TABLE `graphql_operation` ADD `scope_id` text NOT NULL;--> statement-breakpoint
CREATE INDEX `graphql_operation_scope_id_idx` ON `graphql_operation` (`scope_id`);--> statement-breakpoint
ALTER TABLE `graphql_source` ADD `scope_id` text NOT NULL;--> statement-breakpoint
CREATE INDEX `graphql_source_scope_id_idx` ON `graphql_source` (`scope_id`);--> statement-breakpoint
ALTER TABLE `mcp_binding` ADD `scope_id` text NOT NULL;--> statement-breakpoint
CREATE INDEX `mcp_binding_scope_id_idx` ON `mcp_binding` (`scope_id`);--> statement-breakpoint
ALTER TABLE `mcp_oauth_session` ADD `scope_id` text NOT NULL;--> statement-breakpoint
CREATE INDEX `mcp_oauth_session_scope_id_idx` ON `mcp_oauth_session` (`scope_id`);--> statement-breakpoint
ALTER TABLE `mcp_source` ADD `scope_id` text NOT NULL;--> statement-breakpoint
CREATE INDEX `mcp_source_scope_id_idx` ON `mcp_source` (`scope_id`);--> statement-breakpoint
ALTER TABLE `openapi_oauth_session` ADD `scope_id` text NOT NULL;--> statement-breakpoint
CREATE INDEX `openapi_oauth_session_scope_id_idx` ON `openapi_oauth_session` (`scope_id`);--> statement-breakpoint
ALTER TABLE `openapi_operation` ADD `scope_id` text NOT NULL;--> statement-breakpoint
CREATE INDEX `openapi_operation_scope_id_idx` ON `openapi_operation` (`scope_id`);--> statement-breakpoint
ALTER TABLE `openapi_source` ADD `scope_id` text NOT NULL;--> statement-breakpoint
CREATE INDEX `openapi_source_scope_id_idx` ON `openapi_source` (`scope_id`);--> statement-breakpoint
ALTER TABLE `secret` ADD `scope_id` text NOT NULL;--> statement-breakpoint
CREATE INDEX `secret_scope_id_idx` ON `secret` (`scope_id`);--> statement-breakpoint
ALTER TABLE `source` ADD `scope_id` text NOT NULL;--> statement-breakpoint
CREATE INDEX `source_scope_id_idx` ON `source` (`scope_id`);--> statement-breakpoint
ALTER TABLE `tool` ADD `scope_id` text NOT NULL;--> statement-breakpoint
CREATE INDEX `tool_scope_id_idx` ON `tool` (`scope_id`);