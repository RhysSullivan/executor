CREATE TABLE IF NOT EXISTS "private_executor_cloud_settings" (
	"id" varchar(255) PRIMARY KEY NOT NULL,
	"version" varchar(255) DEFAULT '1.0.0' NOT NULL
);
--> statement-breakpoint
INSERT INTO "private_executor_cloud_settings" ("id", "version")
VALUES ('default', '1.0.0')
ON CONFLICT ("id") DO UPDATE SET "version" = excluded."version";
--> statement-breakpoint
ALTER TABLE "credential_binding" ADD COLUMN IF NOT EXISTS "secret_scope_id" text;
--> statement-breakpoint
ALTER TABLE "blob" ADD COLUMN IF NOT EXISTS "row_id" varchar(255);
--> statement-breakpoint
ALTER TABLE "blob" ADD COLUMN IF NOT EXISTS "id" varchar(255);
--> statement-breakpoint
UPDATE "blob"
SET
	"id" = COALESCE("id", '[' || to_json("namespace")::text || ',' || to_json("key")::text || ']'),
	"row_id" = COALESCE("row_id", 'legacy_' || md5("namespace" || chr(31) || "key"))
WHERE "id" IS NULL OR "row_id" IS NULL;
--> statement-breakpoint
ALTER TABLE "blob" ALTER COLUMN "id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "blob" ALTER COLUMN "row_id" SET NOT NULL;
--> statement-breakpoint
DO $$
BEGIN
	IF EXISTS (
		SELECT 1 FROM pg_constraint
		WHERE conrelid = 'public.blob'::regclass
			AND conname = 'blob_namespace_key_pk'
	) THEN
		ALTER TABLE "blob" DROP CONSTRAINT "blob_namespace_key_pk";
	END IF;

	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint
		WHERE conrelid = 'public.blob'::regclass
			AND conname = 'blob_pkey'
	) THEN
		ALTER TABLE "blob" ADD CONSTRAINT "blob_pkey" PRIMARY KEY ("row_id");
	END IF;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "blob_id_uidx" ON "blob" USING btree ("id");
--> statement-breakpoint
DO $$
DECLARE
	table_name text;
	legacy_pk_name text;
	new_pk_name text;
	new_unique_name text;
BEGIN
	FOREACH table_name IN ARRAY ARRAY[
		'connection',
		'credential_binding',
		'definition',
		'graphql_operation',
		'graphql_source',
		'graphql_source_header',
		'graphql_source_query_param',
		'mcp_binding',
		'mcp_source',
		'mcp_source_header',
		'mcp_source_query_param',
		'oauth2_session',
		'openapi_operation',
		'openapi_source',
		'openapi_source_header',
		'openapi_source_query_param',
		'openapi_source_spec_fetch_header',
		'openapi_source_spec_fetch_query_param',
		'secret',
		'source',
		'tool',
		'tool_policy',
		'workos_vault_metadata'
	]
	LOOP
		legacy_pk_name := table_name || '_scope_id_id_pk';
		new_pk_name := table_name || '_pkey';
		new_unique_name := table_name || '_scope_id_id_uidx';

		EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS "row_id" varchar(255)', table_name);
		EXECUTE format(
			'UPDATE %I SET "row_id" = COALESCE("row_id", %L || md5("scope_id" || chr(31) || "id")) WHERE "row_id" IS NULL',
			table_name,
			'legacy_'
		);
		EXECUTE format('ALTER TABLE %I ALTER COLUMN "row_id" SET NOT NULL', table_name);

		IF EXISTS (
			SELECT 1 FROM pg_constraint
			WHERE conrelid = format('public.%I', table_name)::regclass
				AND conname = legacy_pk_name
		) THEN
			EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', table_name, legacy_pk_name);
		END IF;

		IF NOT EXISTS (
			SELECT 1 FROM pg_constraint
			WHERE conrelid = format('public.%I', table_name)::regclass
				AND conname = new_pk_name
		) THEN
			EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I PRIMARY KEY ("row_id")', table_name, new_pk_name);
		END IF;

		EXECUTE format(
			'CREATE UNIQUE INDEX IF NOT EXISTS %I ON %I USING btree ("scope_id", "id")',
			new_unique_name,
			table_name
		);
	END LOOP;
END $$;
