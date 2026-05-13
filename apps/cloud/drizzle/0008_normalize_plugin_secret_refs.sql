-- Normalize all plugin secret/connection refs out of JSON columns
-- into proper relational shape: graphql, openapi, mcp.
-- pg port of apps/local/drizzle/0007_normalize_plugin_secret_refs.sql.
-- (google-discovery is local-only — not in cloud's plugin list.)

-- ============================================================
-- graphql
-- ============================================================

-- Normalize graphql plugin: move secret/connection refs out of JSON
-- columns into proper relational shape so usagesForSecret /
-- usagesForConnection are one indexed SELECT instead of a JSON scan.
-- pg port of apps/local/drizzle/0007_normalize_graphql.sql.

CREATE TABLE "graphql_source_header" (
	"id" text NOT NULL,
	"scope_id" text NOT NULL,
	"source_id" text NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"text_value" text,
	"secret_id" text,
	"secret_prefix" text,
	CONSTRAINT "graphql_source_header_scope_id_id_pk" PRIMARY KEY("scope_id","id")
);
--> statement-breakpoint
CREATE INDEX "graphql_source_header_scope_id_idx" ON "graphql_source_header" USING btree ("scope_id");--> statement-breakpoint
CREATE INDEX "graphql_source_header_source_id_idx" ON "graphql_source_header" USING btree ("source_id");--> statement-breakpoint
CREATE INDEX "graphql_source_header_secret_id_idx" ON "graphql_source_header" USING btree ("secret_id");--> statement-breakpoint

CREATE TABLE "graphql_source_query_param" (
	"id" text NOT NULL,
	"scope_id" text NOT NULL,
	"source_id" text NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"text_value" text,
	"secret_id" text,
	"secret_prefix" text,
	CONSTRAINT "graphql_source_query_param_scope_id_id_pk" PRIMARY KEY("scope_id","id")
);
--> statement-breakpoint
CREATE INDEX "graphql_source_query_param_scope_id_idx" ON "graphql_source_query_param" USING btree ("scope_id");--> statement-breakpoint
CREATE INDEX "graphql_source_query_param_source_id_idx" ON "graphql_source_query_param" USING btree ("source_id");--> statement-breakpoint
CREATE INDEX "graphql_source_query_param_secret_id_idx" ON "graphql_source_query_param" USING btree ("secret_id");--> statement-breakpoint

-- New auth columns. `auth_kind` defaults to "none" so existing rows that
-- predate this migration are valid even if the json was null.
ALTER TABLE "graphql_source" ADD COLUMN "auth_kind" text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "graphql_source" ADD COLUMN "auth_connection_id" text;--> statement-breakpoint
CREATE INDEX "graphql_source_auth_connection_id_idx" ON "graphql_source" USING btree ("auth_connection_id");--> statement-breakpoint

-- Backfill auth from the JSON column. Missing keys yield NULL, so a row
-- with auth=NULL or kind="none" leaves auth_connection_id NULL and
-- auth_kind defaulted to "none".
UPDATE "graphql_source"
SET
	"auth_kind" = COALESCE("auth"->>'kind', 'none'),
	"auth_connection_id" = "auth"->>'connectionId'
WHERE "auth" IS NOT NULL;--> statement-breakpoint

-- Backfill headers. For each (source, header_name) pair: if the value
-- is a json object with .secretId, write a kind=secret row; otherwise
-- write a kind=text row with the literal string. jsonb_each iterates
-- the keys of the headers object.
INSERT INTO "graphql_source_header"
	("scope_id", "id", "source_id", "name", "kind", "text_value", "secret_id", "secret_prefix")
SELECT
	s."scope_id",
	'[' || to_jsonb(s."id")::text || ',' || to_jsonb(h.key)::text || ']',
	s."id",
	h.key,
	CASE
		WHEN jsonb_typeof(h.value) = 'object' AND h.value ? 'secretId' THEN 'secret'
		ELSE 'text'
	END,
	CASE WHEN jsonb_typeof(h.value) = 'string' THEN h.value #>> '{}' ELSE NULL END,
	CASE WHEN jsonb_typeof(h.value) = 'object' THEN h.value->>'secretId' ELSE NULL END,
	CASE WHEN jsonb_typeof(h.value) = 'object' THEN h.value->>'prefix' ELSE NULL END
FROM "graphql_source" s, jsonb_each(s."headers") h
WHERE s."headers" IS NOT NULL
ON CONFLICT DO NOTHING;--> statement-breakpoint

-- Same for query_params.
INSERT INTO "graphql_source_query_param"
	("scope_id", "id", "source_id", "name", "kind", "text_value", "secret_id", "secret_prefix")
SELECT
	s."scope_id",
	'[' || to_jsonb(s."id")::text || ',' || to_jsonb(q.key)::text || ']',
	s."id",
	q.key,
	CASE
		WHEN jsonb_typeof(q.value) = 'object' AND q.value ? 'secretId' THEN 'secret'
		ELSE 'text'
	END,
	CASE WHEN jsonb_typeof(q.value) = 'string' THEN q.value #>> '{}' ELSE NULL END,
	CASE WHEN jsonb_typeof(q.value) = 'object' THEN q.value->>'secretId' ELSE NULL END,
	CASE WHEN jsonb_typeof(q.value) = 'object' THEN q.value->>'prefix' ELSE NULL END
FROM "graphql_source" s, jsonb_each(s."query_params") q
WHERE s."query_params" IS NOT NULL
ON CONFLICT DO NOTHING;--> statement-breakpoint

ALTER TABLE "graphql_source" DROP COLUMN "headers";--> statement-breakpoint
ALTER TABLE "graphql_source" DROP COLUMN "query_params";--> statement-breakpoint
ALTER TABLE "graphql_source" DROP COLUMN "auth";

--> statement-breakpoint

-- ============================================================
-- openapi
-- ============================================================

-- Normalize openapi plugin: move every direct secret/connection ref out
-- of JSON columns into proper relational shape. pg port of
-- apps/local/drizzle/0008_normalize_openapi.sql.

CREATE TABLE "openapi_source_query_param" (
	"id" text NOT NULL,
	"scope_id" text NOT NULL,
	"source_id" text NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"text_value" text,
	"secret_id" text,
	"secret_prefix" text,
	CONSTRAINT "openapi_source_query_param_scope_id_id_pk" PRIMARY KEY("scope_id","id")
);
--> statement-breakpoint
CREATE INDEX "openapi_source_query_param_scope_id_idx" ON "openapi_source_query_param" USING btree ("scope_id");--> statement-breakpoint
CREATE INDEX "openapi_source_query_param_source_id_idx" ON "openapi_source_query_param" USING btree ("source_id");--> statement-breakpoint
CREATE INDEX "openapi_source_query_param_secret_id_idx" ON "openapi_source_query_param" USING btree ("secret_id");--> statement-breakpoint

CREATE TABLE "openapi_source_spec_fetch_header" (
	"id" text NOT NULL,
	"scope_id" text NOT NULL,
	"source_id" text NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"text_value" text,
	"secret_id" text,
	"secret_prefix" text,
	CONSTRAINT "openapi_source_spec_fetch_header_scope_id_id_pk" PRIMARY KEY("scope_id","id")
);
--> statement-breakpoint
CREATE INDEX "openapi_source_spec_fetch_header_scope_id_idx" ON "openapi_source_spec_fetch_header" USING btree ("scope_id");--> statement-breakpoint
CREATE INDEX "openapi_source_spec_fetch_header_source_id_idx" ON "openapi_source_spec_fetch_header" USING btree ("source_id");--> statement-breakpoint
CREATE INDEX "openapi_source_spec_fetch_header_secret_id_idx" ON "openapi_source_spec_fetch_header" USING btree ("secret_id");--> statement-breakpoint

CREATE TABLE "openapi_source_spec_fetch_query_param" (
	"id" text NOT NULL,
	"scope_id" text NOT NULL,
	"source_id" text NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"text_value" text,
	"secret_id" text,
	"secret_prefix" text,
	CONSTRAINT "openapi_source_spec_fetch_query_param_scope_id_id_pk" PRIMARY KEY("scope_id","id")
);
--> statement-breakpoint
CREATE INDEX "openapi_source_spec_fetch_query_param_scope_id_idx" ON "openapi_source_spec_fetch_query_param" USING btree ("scope_id");--> statement-breakpoint
CREATE INDEX "openapi_source_spec_fetch_query_param_source_id_idx" ON "openapi_source_spec_fetch_query_param" USING btree ("source_id");--> statement-breakpoint
CREATE INDEX "openapi_source_spec_fetch_query_param_secret_id_idx" ON "openapi_source_spec_fetch_query_param" USING btree ("secret_id");--> statement-breakpoint

-- New columns on openapi_source_binding to flatten the value json.
-- `kind` defaults to 'text' so the ALTER works on existing rows; the
-- backfill below stamps the real value.
ALTER TABLE "openapi_source_binding" ADD COLUMN "kind" text DEFAULT 'text' NOT NULL;--> statement-breakpoint
ALTER TABLE "openapi_source_binding" ADD COLUMN "secret_id" text;--> statement-breakpoint
ALTER TABLE "openapi_source_binding" ADD COLUMN "connection_id" text;--> statement-breakpoint
ALTER TABLE "openapi_source_binding" ADD COLUMN "text_value" text;--> statement-breakpoint
CREATE INDEX "openapi_source_binding_secret_id_idx" ON "openapi_source_binding" USING btree ("secret_id");--> statement-breakpoint
CREATE INDEX "openapi_source_binding_connection_id_idx" ON "openapi_source_binding" USING btree ("connection_id");--> statement-breakpoint

UPDATE "openapi_source_binding"
SET
	"kind" = COALESCE("value"->>'kind', 'text'),
	"secret_id" = CASE WHEN "value"->>'kind' = 'secret' THEN "value"->>'secretId' ELSE NULL END,
	"connection_id" = CASE WHEN "value"->>'kind' = 'connection' THEN "value"->>'connectionId' ELSE NULL END,
	"text_value" = CASE WHEN "value"->>'kind' = 'text' THEN "value"->>'text' ELSE NULL END
WHERE "value" IS NOT NULL;--> statement-breakpoint

INSERT INTO "openapi_source_query_param"
	("scope_id", "id", "source_id", "name", "kind", "text_value", "secret_id", "secret_prefix")
SELECT
	s."scope_id",
	'[' || to_jsonb(s."id")::text || ',' || to_jsonb(q.key)::text || ']',
	s."id",
	q.key,
	CASE
		WHEN jsonb_typeof(q.value) = 'object' AND q.value ? 'secretId' THEN 'secret'
		ELSE 'text'
	END,
	CASE WHEN jsonb_typeof(q.value) = 'string' THEN q.value #>> '{}' ELSE NULL END,
	CASE WHEN jsonb_typeof(q.value) = 'object' THEN q.value->>'secretId' ELSE NULL END,
	CASE WHEN jsonb_typeof(q.value) = 'object' THEN q.value->>'prefix' ELSE NULL END
FROM "openapi_source" s, jsonb_each(s."query_params") q
WHERE s."query_params" IS NOT NULL
ON CONFLICT DO NOTHING;--> statement-breakpoint

INSERT INTO "openapi_source_spec_fetch_header"
	("scope_id", "id", "source_id", "name", "kind", "text_value", "secret_id", "secret_prefix")
SELECT
	s."scope_id",
	'[' || to_jsonb(s."id")::text || ',' || to_jsonb(h.key)::text || ']',
	s."id",
	h.key,
	CASE
		WHEN jsonb_typeof(h.value) = 'object' AND h.value ? 'secretId' THEN 'secret'
		ELSE 'text'
	END,
	CASE WHEN jsonb_typeof(h.value) = 'string' THEN h.value #>> '{}' ELSE NULL END,
	CASE WHEN jsonb_typeof(h.value) = 'object' THEN h.value->>'secretId' ELSE NULL END,
	CASE WHEN jsonb_typeof(h.value) = 'object' THEN h.value->>'prefix' ELSE NULL END
FROM "openapi_source" s, jsonb_each(s."invocation_config"->'specFetchCredentials'->'headers') h
WHERE s."invocation_config"->'specFetchCredentials'->'headers' IS NOT NULL
ON CONFLICT DO NOTHING;--> statement-breakpoint

INSERT INTO "openapi_source_spec_fetch_query_param"
	("scope_id", "id", "source_id", "name", "kind", "text_value", "secret_id", "secret_prefix")
SELECT
	s."scope_id",
	'[' || to_jsonb(s."id")::text || ',' || to_jsonb(q.key)::text || ']',
	s."id",
	q.key,
	CASE
		WHEN jsonb_typeof(q.value) = 'object' AND q.value ? 'secretId' THEN 'secret'
		ELSE 'text'
	END,
	CASE WHEN jsonb_typeof(q.value) = 'string' THEN q.value #>> '{}' ELSE NULL END,
	CASE WHEN jsonb_typeof(q.value) = 'object' THEN q.value->>'secretId' ELSE NULL END,
	CASE WHEN jsonb_typeof(q.value) = 'object' THEN q.value->>'prefix' ELSE NULL END
FROM "openapi_source" s, jsonb_each(s."invocation_config"->'specFetchCredentials'->'queryParams') q
WHERE s."invocation_config"->'specFetchCredentials'->'queryParams' IS NOT NULL
ON CONFLICT DO NOTHING;--> statement-breakpoint

-- Preserve any legacy OAuth payload from invocation_config.oauth2 into
-- the still-existing oauth2 column before we drop invocation_config.
-- migrateLegacyConnections runs after drizzle migrations and reads
-- oauth2 to detect the legacy shape; without this, rows that only had
-- their OAuth payload under invocation_config.oauth2 would lose it.
UPDATE "openapi_source"
SET "oauth2" = "invocation_config"->'oauth2'
WHERE "oauth2" IS NULL
  AND "invocation_config"->'oauth2' IS NOT NULL;--> statement-breakpoint

ALTER TABLE "openapi_source_binding" DROP COLUMN "value";--> statement-breakpoint
ALTER TABLE "openapi_source" DROP COLUMN "query_params";--> statement-breakpoint
ALTER TABLE "openapi_source" DROP COLUMN "invocation_config";

--> statement-breakpoint

-- ============================================================
-- mcp
-- ============================================================

-- Normalize mcp plugin: lift the McpConnectionAuth secret/connection
-- refs and the SecretBackedMap headers/query_params out of
-- mcp_source.config JSON into proper columns / child tables. pg port
-- of apps/local/drizzle/0009_normalize_mcp.sql.

CREATE TABLE "mcp_source_header" (
	"id" text NOT NULL,
	"scope_id" text NOT NULL,
	"source_id" text NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"text_value" text,
	"secret_id" text,
	"secret_prefix" text,
	CONSTRAINT "mcp_source_header_scope_id_id_pk" PRIMARY KEY("scope_id","id")
);
--> statement-breakpoint
CREATE INDEX "mcp_source_header_scope_id_idx" ON "mcp_source_header" USING btree ("scope_id");--> statement-breakpoint
CREATE INDEX "mcp_source_header_source_id_idx" ON "mcp_source_header" USING btree ("source_id");--> statement-breakpoint
CREATE INDEX "mcp_source_header_secret_id_idx" ON "mcp_source_header" USING btree ("secret_id");--> statement-breakpoint

CREATE TABLE "mcp_source_query_param" (
	"id" text NOT NULL,
	"scope_id" text NOT NULL,
	"source_id" text NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"text_value" text,
	"secret_id" text,
	"secret_prefix" text,
	CONSTRAINT "mcp_source_query_param_scope_id_id_pk" PRIMARY KEY("scope_id","id")
);
--> statement-breakpoint
CREATE INDEX "mcp_source_query_param_scope_id_idx" ON "mcp_source_query_param" USING btree ("scope_id");--> statement-breakpoint
CREATE INDEX "mcp_source_query_param_source_id_idx" ON "mcp_source_query_param" USING btree ("source_id");--> statement-breakpoint
CREATE INDEX "mcp_source_query_param_secret_id_idx" ON "mcp_source_query_param" USING btree ("secret_id");--> statement-breakpoint

ALTER TABLE "mcp_source" ADD COLUMN "auth_kind" text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "mcp_source" ADD COLUMN "auth_header_name" text;--> statement-breakpoint
ALTER TABLE "mcp_source" ADD COLUMN "auth_secret_id" text;--> statement-breakpoint
ALTER TABLE "mcp_source" ADD COLUMN "auth_secret_prefix" text;--> statement-breakpoint
ALTER TABLE "mcp_source" ADD COLUMN "auth_connection_id" text;--> statement-breakpoint
ALTER TABLE "mcp_source" ADD COLUMN "auth_client_id_secret_id" text;--> statement-breakpoint
ALTER TABLE "mcp_source" ADD COLUMN "auth_client_secret_secret_id" text;--> statement-breakpoint
CREATE INDEX "mcp_source_auth_secret_id_idx" ON "mcp_source" USING btree ("auth_secret_id");--> statement-breakpoint
CREATE INDEX "mcp_source_auth_connection_id_idx" ON "mcp_source" USING btree ("auth_connection_id");--> statement-breakpoint
CREATE INDEX "mcp_source_auth_client_id_secret_id_idx" ON "mcp_source" USING btree ("auth_client_id_secret_id");--> statement-breakpoint
CREATE INDEX "mcp_source_auth_client_secret_secret_id_idx" ON "mcp_source" USING btree ("auth_client_secret_secret_id");--> statement-breakpoint

-- Only update rows with explicitly current-shape auth (kind=header w/
-- secretId, or kind=oauth2 w/ connectionId). Legacy inline-OAuth rows
-- are left untouched so the post-migrate migrateLegacyConnections
-- script can convert them to a Connection.
UPDATE "mcp_source"
SET
	"auth_kind" = "config"#>>'{auth,kind}',
	"auth_header_name" = "config"#>>'{auth,headerName}',
	"auth_secret_id" = "config"#>>'{auth,secretId}',
	"auth_secret_prefix" = "config"#>>'{auth,prefix}',
	"auth_connection_id" = "config"#>>'{auth,connectionId}',
	"auth_client_id_secret_id" = "config"#>>'{auth,clientIdSecretId}',
	"auth_client_secret_secret_id" = "config"#>>'{auth,clientSecretSecretId}'
WHERE "config" IS NOT NULL
  AND (
    (
      "config"#>>'{auth,kind}' = 'header'
      AND "config"#>>'{auth,secretId}' IS NOT NULL
    )
    OR (
      "config"#>>'{auth,kind}' = 'oauth2'
      AND "config"#>>'{auth,connectionId}' IS NOT NULL
    )
  );--> statement-breakpoint

INSERT INTO "mcp_source_header"
	("scope_id", "id", "source_id", "name", "kind", "text_value", "secret_id", "secret_prefix")
SELECT
	s."scope_id",
	'[' || to_jsonb(s."id")::text || ',' || to_jsonb(h.key)::text || ']',
	s."id",
	h.key,
	CASE
		WHEN jsonb_typeof(h.value) = 'object' AND h.value ? 'secretId' THEN 'secret'
		ELSE 'text'
	END,
	CASE WHEN jsonb_typeof(h.value) = 'string' THEN h.value #>> '{}' ELSE NULL END,
	CASE WHEN jsonb_typeof(h.value) = 'object' THEN h.value->>'secretId' ELSE NULL END,
	CASE WHEN jsonb_typeof(h.value) = 'object' THEN h.value->>'prefix' ELSE NULL END
FROM "mcp_source" s, jsonb_each(s."config"->'headers') h
WHERE s."config"->'headers' IS NOT NULL
ON CONFLICT DO NOTHING;--> statement-breakpoint

INSERT INTO "mcp_source_query_param"
	("scope_id", "id", "source_id", "name", "kind", "text_value", "secret_id", "secret_prefix")
SELECT
	s."scope_id",
	'[' || to_jsonb(s."id")::text || ',' || to_jsonb(q.key)::text || ']',
	s."id",
	q.key,
	CASE
		WHEN jsonb_typeof(q.value) = 'object' AND q.value ? 'secretId' THEN 'secret'
		ELSE 'text'
	END,
	CASE WHEN jsonb_typeof(q.value) = 'string' THEN q.value #>> '{}' ELSE NULL END,
	CASE WHEN jsonb_typeof(q.value) = 'object' THEN q.value->>'secretId' ELSE NULL END,
	CASE WHEN jsonb_typeof(q.value) = 'object' THEN q.value->>'prefix' ELSE NULL END
FROM "mcp_source" s, jsonb_each(s."config"->'queryParams') q
WHERE s."config"->'queryParams' IS NOT NULL
ON CONFLICT DO NOTHING;--> statement-breakpoint

-- Strip already-copied fields from config JSON. headers/queryParams
-- are always safe; auth is only stripped on rows whose auth was the
-- current shape (legacy inline-OAuth rows keep config.auth so
-- migrateLegacyConnections can mint a Connection from it).
UPDATE "mcp_source"
SET "config" = "config" - 'headers' - 'queryParams'
WHERE "config" IS NOT NULL;--> statement-breakpoint

UPDATE "mcp_source"
SET "config" = "config" - 'auth'
WHERE "config" IS NOT NULL
  AND (
    "config"#>>'{auth,kind}' = 'none'
    OR (
      "config"#>>'{auth,kind}' = 'header'
      AND "config"#>>'{auth,secretId}' IS NOT NULL
    )
    OR (
      "config"#>>'{auth,kind}' = 'oauth2'
      AND "config"#>>'{auth,connectionId}' IS NOT NULL
    )
  );
