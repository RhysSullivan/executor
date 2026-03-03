CREATE TABLE "tool_manifests" (
	"source_hash" text PRIMARY KEY NOT NULL,
	"tool_count" bigint NOT NULL,
	"manifest_json" text NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "tool_manifests_tool_count_nonnegative" CHECK ("tool_manifests"."tool_count" >= 0)
);
--> statement-breakpoint
INSERT INTO "tool_manifests" ("source_hash", "tool_count", "manifest_json", "created_at", "updated_at")
SELECT DISTINCT ON ("source_hash")
	"source_hash",
	"tool_count",
	"manifest_json",
	"created_at",
	"updated_at"
FROM "tool_artifacts"
ORDER BY "source_hash", "updated_at" DESC, "created_at" DESC
ON CONFLICT ("source_hash") DO NOTHING;
--> statement-breakpoint
ALTER TABLE "tool_artifacts" DROP CONSTRAINT "tool_artifacts_tool_count_nonnegative";--> statement-breakpoint
ALTER TABLE "tool_artifacts" ADD CONSTRAINT "tool_artifacts_manifest_fk" FOREIGN KEY ("source_hash") REFERENCES "public"."tool_manifests"("source_hash") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_artifacts" DROP COLUMN "tool_count";--> statement-breakpoint
ALTER TABLE "tool_artifacts" DROP COLUMN "manifest_json";
