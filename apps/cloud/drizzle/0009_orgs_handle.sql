-- ---------------------------------------------------------------------------
-- organizations.handle: add nullable, backfill from name with collision
-- suffixes, then enforce NOT NULL + UNIQUE. Cloud has few users so a single
-- migration backfill is acceptable; matches `slugifyHandle` in
-- apps/cloud/src/services/ids.ts (kept simple — diacritic folding is best
-- effort for ASCII names).
-- ---------------------------------------------------------------------------
ALTER TABLE "organizations" ADD COLUMN "handle" text;--> statement-breakpoint
WITH normalized AS (
	SELECT
		"id",
		"created_at",
		COALESCE(
			NULLIF(
				regexp_replace(
					regexp_replace(
						regexp_replace(lower("name"), '[^a-z0-9]+', '-', 'g'),
						'-+', '-', 'g'
					),
					'^-|-$', '', 'g'
				),
				''
			),
			'org'
		) AS base
	FROM "organizations"
), ranked AS (
	SELECT
		"id",
		"base",
		row_number() OVER (PARTITION BY "base" ORDER BY "created_at", "id") AS rn
	FROM normalized
)
UPDATE "organizations" o
SET "handle" = CASE WHEN r.rn = 1 THEN r.base ELSE r.base || '-' || (r.rn - 1) END
FROM ranked r
WHERE r."id" = o."id";
--> statement-breakpoint
ALTER TABLE "organizations" ALTER COLUMN "handle" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_handle_unique" UNIQUE("handle");
