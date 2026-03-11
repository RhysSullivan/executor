ALTER TABLE "source_recipes"
RENAME COLUMN "importer_kind" TO "adapter_key";--> statement-breakpoint

ALTER TABLE "control_plane_data_migrations"
RENAME TO "control_plane_code_migrations";--> statement-breakpoint

UPDATE "source_recipes"
SET "adapter_key" = CASE
  WHEN "adapter_key" = 'graphql_introspection' THEN 'graphql'
  WHEN "adapter_key" = 'mcp_manifest' THEN 'mcp'
  ELSE "adapter_key"
END
WHERE "adapter_key" IN ('graphql_introspection', 'mcp_manifest');--> statement-breakpoint

UPDATE "sources"
SET "binding_config_json" = jsonb_build_object(
  'adapterKey', "kind",
  'version', 1,
  'payload',
    CASE
      WHEN "kind" = 'openapi' THEN jsonb_build_object(
        'specUrl', COALESCE(("binding_config_json"::jsonb ->> 'specUrl'), "endpoint"),
        'defaultHeaders', COALESCE(("binding_config_json"::jsonb -> 'defaultHeaders'), 'null'::jsonb)
      )
      WHEN "kind" = 'graphql' THEN jsonb_build_object(
        'defaultHeaders', COALESCE(("binding_config_json"::jsonb -> 'defaultHeaders'), 'null'::jsonb)
      )
      WHEN "kind" = 'mcp' THEN jsonb_build_object(
        'transport', COALESCE(("binding_config_json"::jsonb -> 'transport'), 'null'::jsonb),
        'queryParams', COALESCE(("binding_config_json"::jsonb -> 'queryParams'), 'null'::jsonb),
        'headers', COALESCE(("binding_config_json"::jsonb -> 'headers'), 'null'::jsonb)
      )
      ELSE '{}'::jsonb
    END
)::text
WHERE "binding_config_json" IS NOT NULL
  AND (
    ("binding_config_json"::jsonb -> 'version') IS NULL
    OR ("binding_config_json"::jsonb -> 'payload') IS NULL
  );--> statement-breakpoint

UPDATE "sources"
SET "binding_config_json" = jsonb_set(
  "binding_config_json"::jsonb,
  '{adapterKey}',
  to_jsonb(
    CASE
      WHEN "binding_config_json"::jsonb ->> 'adapterKey' = 'graphql_introspection' THEN 'graphql'
      WHEN "binding_config_json"::jsonb ->> 'adapterKey' = 'mcp_manifest' THEN 'mcp'
      ELSE "binding_config_json"::jsonb ->> 'adapterKey'
    END
  )
)::text
WHERE "binding_config_json" IS NOT NULL
  AND ("binding_config_json"::jsonb ->> 'adapterKey') IN ('graphql_introspection', 'mcp_manifest');
