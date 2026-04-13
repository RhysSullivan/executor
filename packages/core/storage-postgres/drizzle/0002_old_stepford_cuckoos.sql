ALTER TABLE "executions" ADD COLUMN "trigger_kind" text;--> statement-breakpoint
ALTER TABLE "executions" ADD COLUMN "trigger_meta_json" text;--> statement-breakpoint
ALTER TABLE "executions" ADD COLUMN "tool_call_count" integer NOT NULL DEFAULT 0;--> statement-breakpoint
CREATE TABLE "execution_tool_calls" (
	"id" text NOT NULL,
	"organization_id" text NOT NULL,
	"execution_id" text NOT NULL,
	"status" text NOT NULL,
	"tool_path" text NOT NULL,
	"namespace" text NOT NULL,
	"args_json" text,
	"result_json" text,
	"error_text" text,
	"started_at" bigint NOT NULL,
	"completed_at" bigint,
	"duration_ms" bigint,
	CONSTRAINT "execution_tool_calls_id_organization_id_pk" PRIMARY KEY("id","organization_id")
);--> statement-breakpoint
CREATE INDEX "execution_tool_calls_execution_idx" ON "execution_tool_calls" USING btree ("organization_id","execution_id","started_at");--> statement-breakpoint
CREATE INDEX "execution_tool_calls_path_idx" ON "execution_tool_calls" USING btree ("organization_id","tool_path");--> statement-breakpoint
CREATE INDEX "executions_trigger_kind_idx" ON "executions" USING btree ("organization_id","trigger_kind");
