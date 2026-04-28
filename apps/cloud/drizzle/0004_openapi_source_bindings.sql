CREATE TABLE "openapi_source_binding" (
	"id" text NOT NULL,
	"source_id" text NOT NULL,
	"source_scope_id" text NOT NULL,
	"target_scope_id" text NOT NULL,
	"slot" text NOT NULL,
	"value" jsonb NOT NULL,
	"created_at" timestamp NOT NULL,
	"updated_at" timestamp NOT NULL,
	CONSTRAINT "openapi_source_binding_id_pk" PRIMARY KEY("id")
);
--> statement-breakpoint
CREATE INDEX "openapi_source_binding_source_id_idx" ON "openapi_source_binding" USING btree ("source_id");
--> statement-breakpoint
CREATE INDEX "openapi_source_binding_source_scope_id_idx" ON "openapi_source_binding" USING btree ("source_scope_id");
--> statement-breakpoint
CREATE INDEX "openapi_source_binding_target_scope_id_idx" ON "openapi_source_binding" USING btree ("target_scope_id");
--> statement-breakpoint
CREATE INDEX "openapi_source_binding_slot_idx" ON "openapi_source_binding" USING btree ("slot");
