CREATE TABLE "connection" (
	"id" text NOT NULL,
	"scope_id" text NOT NULL,
	"provider" text NOT NULL,
	"kind" text NOT NULL,
	"identity_label" text,
	"access_token_secret_id" text NOT NULL,
	"refresh_token_secret_id" text,
	"expires_at" bigint,
	"scope" text,
	"provider_state" jsonb,
	"created_at" timestamp NOT NULL,
	"updated_at" timestamp NOT NULL,
	CONSTRAINT "connection_scope_id_id_pk" PRIMARY KEY("scope_id","id")
);
--> statement-breakpoint
ALTER TABLE "secret" ADD COLUMN "owned_by_connection_id" text;--> statement-breakpoint
CREATE INDEX "connection_scope_id_idx" ON "connection" USING btree ("scope_id");--> statement-breakpoint
CREATE INDEX "connection_provider_idx" ON "connection" USING btree ("provider");--> statement-breakpoint
CREATE INDEX "secret_owned_by_connection_id_idx" ON "secret" USING btree ("owned_by_connection_id");