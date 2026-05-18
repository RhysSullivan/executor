CREATE TABLE IF NOT EXISTS "plugin_storage" (
  "row_id" varchar(255) PRIMARY KEY NOT NULL,
  "id" varchar(255) NOT NULL,
  "scope_id" varchar(255) NOT NULL,
  "plugin_id" text NOT NULL,
  "collection" text NOT NULL,
  "key" text NOT NULL,
  "data" json NOT NULL,
  "created_at" timestamp NOT NULL,
  "updated_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "plugin_storage_scope_id_id_uidx" ON "plugin_storage" USING btree ("scope_id","id");
--> statement-breakpoint
INSERT INTO "plugin_storage" ("row_id", "id", "scope_id", "plugin_id", "collection", "key", "data", "created_at", "updated_at")
SELECT
  'plugin_storage_' || md5('openapi:source:' || s."scope_id" || ':' || s."id"),
  '["openapi","source",' || to_json(s."id")::text || ']',
  s."scope_id",
  'openapi',
  'source',
  s."id",
  json_build_object(
    'namespace', s."id",
    'scope', s."scope_id",
    'name', s."name",
    'config', json_strip_nulls(json_build_object(
      'spec', s."spec",
      'sourceUrl', s."source_url",
      'baseUrl', s."base_url",
      'headers', h."headers",
      'queryParams', q."queryParams",
      'specFetchCredentials', CASE WHEN sfh."headers" IS NULL AND sfq."queryParams" IS NULL THEN NULL ELSE json_strip_nulls(json_build_object('headers', sfh."headers", 'queryParams', sfq."queryParams")) END,
      'oauth2', s."oauth2"
    ))
  ),
  now(),
  now()
FROM "openapi_source" s
LEFT JOIN (
  SELECT "scope_id", "source_id", json_object_agg("name", CASE WHEN "kind" = 'text' THEN to_json("text_value") ELSE json_build_object('kind', 'binding', 'slot', "slot_key", 'prefix', "prefix") END) AS "headers"
  FROM "openapi_source_header"
  GROUP BY "scope_id", "source_id"
) h ON h."scope_id" = s."scope_id" AND h."source_id" = s."id"
LEFT JOIN (
  SELECT "scope_id", "source_id", json_object_agg("name", CASE WHEN "kind" = 'text' THEN to_json("text_value") ELSE json_build_object('kind', 'binding', 'slot', "slot_key", 'prefix', "prefix") END) AS "queryParams"
  FROM "openapi_source_query_param"
  GROUP BY "scope_id", "source_id"
) q ON q."scope_id" = s."scope_id" AND q."source_id" = s."id"
LEFT JOIN (
  SELECT "scope_id", "source_id", json_object_agg("name", CASE WHEN "kind" = 'text' THEN to_json("text_value") ELSE json_build_object('kind', 'binding', 'slot', "slot_key", 'prefix', "prefix") END) AS "headers"
  FROM "openapi_source_spec_fetch_header"
  GROUP BY "scope_id", "source_id"
) sfh ON sfh."scope_id" = s."scope_id" AND sfh."source_id" = s."id"
LEFT JOIN (
  SELECT "scope_id", "source_id", json_object_agg("name", CASE WHEN "kind" = 'text' THEN to_json("text_value") ELSE json_build_object('kind', 'binding', 'slot', "slot_key", 'prefix', "prefix") END) AS "queryParams"
  FROM "openapi_source_spec_fetch_query_param"
  GROUP BY "scope_id", "source_id"
) sfq ON sfq."scope_id" = s."scope_id" AND sfq."source_id" = s."id"
ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO "plugin_storage" ("row_id", "id", "scope_id", "plugin_id", "collection", "key", "data", "created_at", "updated_at")
SELECT 'plugin_storage_' || md5('openapi:operation:' || o."scope_id" || ':' || o."id"), '["openapi","operation",' || to_json(o."id")::text || ']', o."scope_id", 'openapi', 'operation', o."id", json_build_object('toolId', o."id", 'sourceId', o."source_id", 'binding', o."binding"), now(), now()
FROM "openapi_operation" o
ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO "plugin_storage" ("row_id", "id", "scope_id", "plugin_id", "collection", "key", "data", "created_at", "updated_at")
SELECT
  'plugin_storage_' || md5('graphql:source:' || s."scope_id" || ':' || s."id"),
  '["graphql","source",' || to_json(s."id")::text || ']',
  s."scope_id",
  'graphql',
  'source',
  s."id",
  json_build_object(
    'namespace', s."id",
    'scope', s."scope_id",
    'name', s."name",
    'endpoint', s."endpoint",
    'headers', COALESCE(h."headers", '{}'::json),
    'queryParams', COALESCE(q."queryParams", '{}'::json),
    'auth', CASE WHEN s."auth_kind" = 'oauth2' AND s."auth_connection_slot" IS NOT NULL THEN json_build_object('kind', 'oauth2', 'connectionSlot', s."auth_connection_slot") ELSE json_build_object('kind', 'none') END
  ),
  now(),
  now()
FROM "graphql_source" s
LEFT JOIN (
  SELECT "scope_id", "source_id", json_object_agg("name", CASE WHEN "kind" = 'text' THEN to_json("text_value") ELSE json_build_object('kind', 'binding', 'slot', "slot_key", 'prefix', "prefix") END) AS "headers"
  FROM "graphql_source_header"
  GROUP BY "scope_id", "source_id"
) h ON h."scope_id" = s."scope_id" AND h."source_id" = s."id"
LEFT JOIN (
  SELECT "scope_id", "source_id", json_object_agg("name", CASE WHEN "kind" = 'text' THEN to_json("text_value") ELSE json_build_object('kind', 'binding', 'slot', "slot_key", 'prefix', "prefix") END) AS "queryParams"
  FROM "graphql_source_query_param"
  GROUP BY "scope_id", "source_id"
) q ON q."scope_id" = s."scope_id" AND q."source_id" = s."id"
ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO "plugin_storage" ("row_id", "id", "scope_id", "plugin_id", "collection", "key", "data", "created_at", "updated_at")
SELECT 'plugin_storage_' || md5('graphql:operation:' || o."scope_id" || ':' || o."id"), '["graphql","operation",' || to_json(o."id")::text || ']', o."scope_id", 'graphql', 'operation', o."id", json_build_object('toolId', o."id", 'sourceId', o."source_id", 'binding', o."binding"), now(), now()
FROM "graphql_operation" o
ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO "plugin_storage" ("row_id", "id", "scope_id", "plugin_id", "collection", "key", "data", "created_at", "updated_at")
SELECT
  'plugin_storage_' || md5('mcp:source:' || s."scope_id" || ':' || s."id"),
  '["mcp","source",' || to_json(s."id")::text || ']',
  s."scope_id",
  'mcp',
  'source',
  s."id",
  json_build_object(
    'namespace', s."id",
    'scope', s."scope_id",
    'name', s."name",
    'config', CASE WHEN s."config"->>'transport' = 'remote' THEN jsonb_strip_nulls(s."config"::jsonb || jsonb_build_object(
      'headers', h."headers",
      'queryParams', q."queryParams",
      'auth', CASE
        WHEN s."auth_kind" = 'header' THEN json_build_object('kind', 'header', 'headerName', COALESCE(s."auth_header_name", ''), 'secretSlot', s."auth_header_slot", 'prefix', s."auth_header_prefix")
        WHEN s."auth_kind" = 'oauth2' THEN json_build_object('kind', 'oauth2', 'connectionSlot', s."auth_connection_slot", 'clientIdSlot', s."auth_client_id_slot", 'clientSecretSlot', s."auth_client_secret_slot")
        ELSE json_build_object('kind', 'none')
      END
    )) ELSE s."config"::jsonb END
  ),
  now(),
  now()
FROM "mcp_source" s
LEFT JOIN (
  SELECT "scope_id", "source_id", json_object_agg("name", CASE WHEN "kind" = 'text' THEN to_json("text_value") ELSE json_build_object('kind', 'binding', 'slot', "slot_key", 'prefix', "prefix") END) AS "headers"
  FROM "mcp_source_header"
  GROUP BY "scope_id", "source_id"
) h ON h."scope_id" = s."scope_id" AND h."source_id" = s."id"
LEFT JOIN (
  SELECT "scope_id", "source_id", json_object_agg("name", CASE WHEN "kind" = 'text' THEN to_json("text_value") ELSE json_build_object('kind', 'binding', 'slot', "slot_key", 'prefix', "prefix") END) AS "queryParams"
  FROM "mcp_source_query_param"
  GROUP BY "scope_id", "source_id"
) q ON q."scope_id" = s."scope_id" AND q."source_id" = s."id"
ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO "plugin_storage" ("row_id", "id", "scope_id", "plugin_id", "collection", "key", "data", "created_at", "updated_at")
SELECT 'plugin_storage_' || md5('mcp:binding:' || b."scope_id" || ':' || b."id"), '["mcp","binding",' || to_json(b."id")::text || ']', b."scope_id", 'mcp', 'binding', b."id", json_build_object('namespace', b."source_id", 'toolId', b."id", 'binding', b."binding"), b."created_at", now()
FROM "mcp_binding" b
ON CONFLICT DO NOTHING;
--> statement-breakpoint
DROP TABLE IF EXISTS "openapi_source";
--> statement-breakpoint
DROP TABLE IF EXISTS "openapi_operation";
--> statement-breakpoint
DROP TABLE IF EXISTS "openapi_source_header";
--> statement-breakpoint
DROP TABLE IF EXISTS "openapi_source_query_param";
--> statement-breakpoint
DROP TABLE IF EXISTS "openapi_source_spec_fetch_header";
--> statement-breakpoint
DROP TABLE IF EXISTS "openapi_source_spec_fetch_query_param";
--> statement-breakpoint
DROP TABLE IF EXISTS "graphql_source";
--> statement-breakpoint
DROP TABLE IF EXISTS "graphql_source_header";
--> statement-breakpoint
DROP TABLE IF EXISTS "graphql_source_query_param";
--> statement-breakpoint
DROP TABLE IF EXISTS "graphql_operation";
--> statement-breakpoint
DROP TABLE IF EXISTS "mcp_source";
--> statement-breakpoint
DROP TABLE IF EXISTS "mcp_source_header";
--> statement-breakpoint
DROP TABLE IF EXISTS "mcp_source_query_param";
--> statement-breakpoint
DROP TABLE IF EXISTS "mcp_binding";
