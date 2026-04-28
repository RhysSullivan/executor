CREATE TABLE "identity_sync_cursors" (
	"provider" text PRIMARY KEY NOT NULL,
	"cursor" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
