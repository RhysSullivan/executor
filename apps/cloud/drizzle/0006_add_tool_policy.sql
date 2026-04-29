CREATE TABLE "tool_policy" (
	"id" text NOT NULL,
	"scope_id" text NOT NULL,
	"pattern" text NOT NULL,
	"action" text NOT NULL,
	"position" bigint NOT NULL,
	"created_at" timestamp NOT NULL,
	"updated_at" timestamp NOT NULL,
	CONSTRAINT "tool_policy_scope_id_id_pk" PRIMARY KEY("scope_id","id")
);
--> statement-breakpoint
CREATE INDEX "tool_policy_scope_id_idx" ON "tool_policy" USING btree ("scope_id");--> statement-breakpoint
CREATE INDEX "tool_policy_position_idx" ON "tool_policy" USING btree ("position");
