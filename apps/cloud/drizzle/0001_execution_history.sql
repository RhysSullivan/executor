CREATE TABLE "executions" (
	"id" text NOT NULL,
	"organization_id" text NOT NULL,
	"scope_id" text NOT NULL,
	"status" text NOT NULL,
	"code" text NOT NULL,
	"result_json" text,
	"error_text" text,
	"logs_json" text,
	"started_at" bigint,
	"completed_at" bigint,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "executions_id_organization_id_pk" PRIMARY KEY("id","organization_id")
);
--> statement-breakpoint
CREATE TABLE "execution_interactions" (
	"id" text NOT NULL,
	"organization_id" text NOT NULL,
	"execution_id" text NOT NULL,
	"status" text NOT NULL,
	"kind" text NOT NULL,
	"purpose" text NOT NULL,
	"payload_json" text NOT NULL,
	"response_json" text,
	"response_private_json" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "execution_interactions_id_organization_id_pk" PRIMARY KEY("id","organization_id")
);
--> statement-breakpoint
CREATE INDEX "executions_scope_created_at_idx" ON "executions" USING btree ("scope_id","created_at","id");
--> statement-breakpoint
CREATE INDEX "execution_interactions_execution_status_idx" ON "execution_interactions" USING btree ("execution_id","status");
