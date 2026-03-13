ALTER TABLE "execution_interactions"
ADD COLUMN "response_private_json" text;--> statement-breakpoint

CREATE TABLE "execution_steps" (
  "id" text PRIMARY KEY NOT NULL,
  "execution_id" text NOT NULL,
  "sequence" bigint NOT NULL,
  "kind" text NOT NULL,
  "status" text NOT NULL,
  "path" text NOT NULL,
  "args_json" text NOT NULL,
  "result_json" text,
  "error_text" text,
  "interaction_id" text,
  "created_at" bigint NOT NULL,
  "updated_at" bigint NOT NULL,
  CONSTRAINT "execution_steps_kind_check" CHECK ("execution_steps"."kind" in ('tool_call')),
  CONSTRAINT "execution_steps_status_check" CHECK ("execution_steps"."status" in ('pending', 'waiting', 'completed', 'failed'))
);--> statement-breakpoint

CREATE UNIQUE INDEX "execution_steps_execution_sequence_idx"
ON "execution_steps" ("execution_id", "sequence");--> statement-breakpoint

CREATE INDEX "execution_steps_execution_updated_idx"
ON "execution_steps" ("execution_id", "updated_at", "id");
