ALTER TABLE "policies" ADD COLUMN "tool_pattern" text DEFAULT '*' NOT NULL;
--> statement-breakpoint
ALTER TABLE "policies" ADD COLUMN "effect" text DEFAULT 'allow' NOT NULL;
--> statement-breakpoint
ALTER TABLE "policies" ADD COLUMN "approval_mode" text DEFAULT 'auto' NOT NULL;
--> statement-breakpoint
ALTER TABLE "policies" ADD COLUMN "enabled" boolean DEFAULT true NOT NULL;
--> statement-breakpoint
ALTER TABLE "policies" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;
--> statement-breakpoint
ALTER TABLE "policies" DROP COLUMN "name";
--> statement-breakpoint
ALTER TABLE "policies" DROP COLUMN "action";
--> statement-breakpoint
ALTER TABLE "policies" DROP COLUMN "match_tool_pattern";
--> statement-breakpoint
ALTER TABLE "policies" DROP COLUMN "match_source_id";
