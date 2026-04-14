-- Add slug column to organizations (URL-safe identifier for routing).
-- For existing rows, derive a deterministic slug from (name, id) that matches
-- the application-level `makeOrganizationSlug` helper: slugified name +
-- `-` + first 6 alphanumeric chars of the id after the `org_` prefix.
ALTER TABLE "organizations" ADD COLUMN "slug" text;--> statement-breakpoint
UPDATE "organizations"
SET "slug" =
  COALESCE(
    NULLIF(regexp_replace(lower("name"), '[^a-z0-9]+', '-', 'g'), ''),
    'org'
  )
  || '-'
  || substring(
    regexp_replace(lower(regexp_replace("id", '^org_', '')), '[^a-z0-9]', '', 'g')
    from 1 for 6
  )
WHERE "slug" IS NULL;--> statement-breakpoint
ALTER TABLE "organizations" ALTER COLUMN "slug" SET NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "organizations_slug_idx" ON "organizations" USING btree ("slug");
