CREATE TABLE "execution" (
	"id" text NOT NULL,
	"scope_id" text NOT NULL,
	"status" text NOT NULL,
	"code" text NOT NULL,
	"result_json" text,
	"error_text" text,
	"logs_json" text,
	"started_at" bigint,
	"completed_at" bigint,
	"trigger_kind" text,
	"trigger_meta_json" text,
	"tool_call_count" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp NOT NULL,
	"updated_at" timestamp NOT NULL,
	CONSTRAINT "execution_scope_id_id_pk" PRIMARY KEY("scope_id","id")
);
--> statement-breakpoint
CREATE TABLE "execution_interaction" (
	"id" text PRIMARY KEY NOT NULL,
	"execution_id" text NOT NULL,
	"status" text NOT NULL,
	"kind" text NOT NULL,
	"purpose" text,
	"payload_json" text,
	"response_json" text,
	"response_private_json" text,
	"created_at" timestamp NOT NULL,
	"updated_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "execution_tool_call" (
	"id" text PRIMARY KEY NOT NULL,
	"execution_id" text NOT NULL,
	"status" text NOT NULL,
	"tool_path" text NOT NULL,
	"namespace" text,
	"args_json" text,
	"result_json" text,
	"error_text" text,
	"started_at" bigint NOT NULL,
	"completed_at" bigint,
	"duration_ms" bigint
);
--> statement-breakpoint
CREATE INDEX "execution_scope_id_idx" ON "execution" USING btree ("scope_id");--> statement-breakpoint
CREATE INDEX "execution_status_idx" ON "execution" USING btree ("status");--> statement-breakpoint
CREATE INDEX "execution_trigger_kind_idx" ON "execution" USING btree ("trigger_kind");--> statement-breakpoint
CREATE INDEX "execution_created_at_idx" ON "execution" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "execution_interaction_execution_id_idx" ON "execution_interaction" USING btree ("execution_id");--> statement-breakpoint
CREATE INDEX "execution_interaction_status_idx" ON "execution_interaction" USING btree ("status");--> statement-breakpoint
CREATE INDEX "execution_tool_call_execution_id_idx" ON "execution_tool_call" USING btree ("execution_id");--> statement-breakpoint
CREATE INDEX "execution_tool_call_tool_path_idx" ON "execution_tool_call" USING btree ("tool_path");--> statement-breakpoint
CREATE INDEX "execution_tool_call_namespace_idx" ON "execution_tool_call" USING btree ("namespace");
