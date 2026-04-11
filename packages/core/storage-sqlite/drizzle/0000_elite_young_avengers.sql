CREATE TABLE `plugin_kv` (
	`scope_id` text NOT NULL,
	`namespace` text NOT NULL,
	`key` text NOT NULL,
	`value` text NOT NULL,
	PRIMARY KEY(`scope_id`, `namespace`, `key`)
);
--> statement-breakpoint
CREATE INDEX `idx_plugin_kv_namespace` ON `plugin_kv` (`scope_id`,`namespace`);--> statement-breakpoint
CREATE TABLE `policies` (
	`id` text NOT NULL,
	`scope_id` text NOT NULL,
	`name` text NOT NULL,
	`action` text NOT NULL,
	`match_tool_pattern` text,
	`match_source_id` text,
	`priority` integer NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`id`, `scope_id`)
);
--> statement-breakpoint
CREATE TABLE `secrets` (
	`id` text NOT NULL,
	`scope_id` text NOT NULL,
	`name` text NOT NULL,
	`purpose` text,
	`provider` text,
	`encrypted_value` blob,
	`iv` blob,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`id`, `scope_id`)
);
--> statement-breakpoint
CREATE TABLE `sources` (
	`id` text NOT NULL,
	`scope_id` text NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`config` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`id`, `scope_id`)
);
--> statement-breakpoint
CREATE TABLE `tool_definitions` (
	`name` text NOT NULL,
	`scope_id` text NOT NULL,
	`schema` text NOT NULL,
	PRIMARY KEY(`name`, `scope_id`)
);
--> statement-breakpoint
CREATE TABLE `tools` (
	`id` text NOT NULL,
	`scope_id` text NOT NULL,
	`source_id` text NOT NULL,
	`plugin_key` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`may_elicit` integer,
	`input_schema` text,
	`output_schema` text,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`id`, `scope_id`)
);
--> statement-breakpoint
CREATE INDEX `idx_tools_source` ON `tools` (`scope_id`,`source_id`);